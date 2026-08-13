/**
 * Keep-Awake monitor — decision logic, pmset assertion, hotspot fallback, and
 * fail-safe behavior. Every collaborator (pmset/networksetup exec, battery,
 * connectivity, session count, config, clock) is injected, so no test touches
 * the real machine's power management.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  decideKeepAwake,
  pollKeepAwakeOnce,
  getKeepAwakeState,
  getSudoSetupCommand,
  resetKeepAwakeForTest,
  _setExecForTest,
  _setOnlineCheckForTest,
  _setSessionCounterForTest,
  _setConfigReaderForTest,
  _setNowForTest,
  DEFAULT_BATTERY_FLOOR_PCT,
  type KeepAwakeConfig,
} from '../../src/core/keep-awake.js';

// ── Harness ──────────────────────────────────────────────────────────────────

interface FakeWorld {
  config: KeepAwakeConfig;
  sessions: number;
  batteryPct: number | null;
  onAc: boolean;
  online: boolean;
  nowMs: number;
  sudoFails: boolean;
  execCalls: Array<{ cmd: string; args: string[] }>;
}

let world: FakeWorld;

function installWorld(): void {
  _setConfigReaderForTest(async () => world.config);
  _setSessionCounterForTest(async () => world.sessions);
  _setOnlineCheckForTest(async () => world.online);
  _setNowForTest(() => world.nowMs);
  _setExecForTest(async (cmd, args) => {
    world.execCalls.push({ cmd, args });
    if (cmd === '/usr/bin/pmset' && args[0] === '-g') {
      if (world.batteryPct === null) return { ok: true, stdout: 'no batteries here\n', stderr: '' };
      const src = world.onAc ? "'AC Power'" : "'Battery Power'";
      return { ok: true, stdout: `Now drawing from ${src}\n -InternalBattery-0\t${world.batteryPct}%; ok\n`, stderr: '' };
    }
    if (cmd === '/usr/bin/sudo') {
      return world.sudoFails
        ? { ok: false, stdout: '', stderr: 'sudo: a password is required' }
        : { ok: true, stdout: '', stderr: '' };
    }
    if (cmd === '/usr/sbin/networksetup' && args[0] === '-listallhardwareports') {
      return { ok: true, stdout: 'Hardware Port: Wi-Fi\nDevice: en0\n', stderr: '' };
    }
    if (cmd === '/usr/sbin/networksetup' && args[0] === '-setairportnetwork') {
      return { ok: true, stdout: '', stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  });
}

/** pmset disablesleep calls observed so far, as '1'/'0' strings in order. */
function disableSleepCalls(): string[] {
  return world.execCalls
    .filter((c) => c.cmd === '/usr/bin/sudo' && c.args.includes('disablesleep'))
    .map((c) => c.args[c.args.length - 1]);
}

function hotspotJoinCalls(): Array<{ cmd: string; args: string[] }> {
  return world.execCalls.filter((c) => c.cmd === '/usr/sbin/networksetup' && c.args[0] === '-setairportnetwork');
}

const MINUTE = 60_000;

beforeEach(() => {
  resetKeepAwakeForTest();
  world = {
    config: { enabled: true },
    sessions: 1,
    batteryPct: 80,
    onAc: false,
    online: true,
    nowMs: 1_000_000_000,
    sudoFails: false,
    execCalls: [],
  };
  installWorld();
});

afterEach(() => {
  _setExecForTest(null);
  _setOnlineCheckForTest(null);
  _setSessionCounterForTest(null);
  _setConfigReaderForTest(null);
  _setNowForTest(null);
  resetKeepAwakeForTest();
});

// ── decideKeepAwake (pure) ───────────────────────────────────────────────────

describe('decideKeepAwake', () => {
  const base = {
    enabled: true,
    runningLocalSessions: 1,
    msSinceLastRunning: 0,
    battery: { pct: 80, onAc: false },
    batteryFloorPct: 30,
    offlineMinutes: 0,
    offlineGraceMinutes: 30,
    lingerMinutes: 5,
  };

  it('holds while a session runs with healthy battery and network', () => {
    expect(decideKeepAwake(base)).toEqual({ awake: true, reason: 'active' });
  });

  it('never holds when disabled, regardless of everything else', () => {
    expect(decideKeepAwake({ ...base, enabled: false }).awake).toBe(false);
  });

  it('releases when no sessions and linger has expired', () => {
    expect(decideKeepAwake({ ...base, runningLocalSessions: 0, msSinceLastRunning: 6 * MINUTE }))
      .toEqual({ awake: false, reason: 'no-sessions' });
  });

  it('keeps holding through the linger window after the last session ends', () => {
    expect(decideKeepAwake({ ...base, runningLocalSessions: 0, msSinceLastRunning: 4 * MINUTE }).awake).toBe(true);
  });

  it('never holds when no session was ever seen', () => {
    expect(decideKeepAwake({ ...base, runningLocalSessions: 0, msSinceLastRunning: null }).awake).toBe(false);
  });

  it('releases at the battery floor on battery power', () => {
    expect(decideKeepAwake({ ...base, battery: { pct: 30, onAc: false } }))
      .toEqual({ awake: false, reason: 'battery-low' });
    expect(decideKeepAwake({ ...base, battery: { pct: 31, onAc: false } }).awake).toBe(true);
  });

  it('ignores the battery floor on AC power', () => {
    expect(decideKeepAwake({ ...base, battery: { pct: 10, onAc: true } }).awake).toBe(true);
  });

  it('treats no-battery (desktop Mac) as unconstrained', () => {
    expect(decideKeepAwake({ ...base, battery: null }).awake).toBe(true);
  });

  it('releases once offline past the grace window', () => {
    expect(decideKeepAwake({ ...base, offlineMinutes: 30 }))
      .toEqual({ awake: false, reason: 'offline-too-long' });
    expect(decideKeepAwake({ ...base, offlineMinutes: 29 }).awake).toBe(true);
  });
});

// ── pollKeepAwakeOnce (integration through fakes) ────────────────────────────

const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;

darwinOnly('pollKeepAwakeOnce', () => {
  it('asserts disablesleep 1 when active, and only once (no sudo churn)', async () => {
    await pollKeepAwakeOnce();
    await pollKeepAwakeOnce();
    expect(disableSleepCalls()).toEqual(['1']);
    expect(getKeepAwakeState().holding).toBe(true);
    expect(getKeepAwakeState().reason).toBe('active');
  });

  it('releases when battery drops to the floor, then re-holds on AC', async () => {
    await pollKeepAwakeOnce();
    world.batteryPct = 25;
    await pollKeepAwakeOnce();
    expect(disableSleepCalls()).toEqual(['1', '0']);
    expect(getKeepAwakeState().reason).toBe('battery-low');

    world.onAc = true;
    await pollKeepAwakeOnce();
    expect(disableSleepCalls()).toEqual(['1', '0', '1']);
    expect(getKeepAwakeState().holding).toBe(true);
  });

  it('respects a custom battery floor from config', async () => {
    world.config = { enabled: true, battery_floor_pct: 50 };
    world.batteryPct = 45;
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().reason).toBe('battery-low');
    expect(DEFAULT_BATTERY_FLOOR_PCT).toBe(30);
  });

  it('releases after the offline grace window elapses', async () => {
    await pollKeepAwakeOnce();
    world.online = false;
    await pollKeepAwakeOnce(); // offline clock starts
    expect(getKeepAwakeState().holding).toBe(true);

    world.nowMs += 29 * MINUTE;
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().holding).toBe(true);

    world.nowMs += 2 * MINUTE; // 31 min offline total
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().reason).toBe('offline-too-long');
    expect(disableSleepCalls().at(-1)).toBe('0');
  });

  it('a moment of connectivity resets the offline clock', async () => {
    world.online = false;
    await pollKeepAwakeOnce();
    world.nowMs += 20 * MINUTE;
    world.online = true;
    await pollKeepAwakeOnce();
    world.online = false;
    world.nowMs += 20 * MINUTE;
    await pollKeepAwakeOnce(); // only 20 min into the NEW offline stretch
    expect(getKeepAwakeState().holding).toBe(true);
  });

  it('tries the configured hotspot after two offline polls, not immediately', async () => {
    world.config = { enabled: true, hotspot_ssid: 'MyPhone', hotspot_password: 'pw123456' };
    world.online = false;
    await pollKeepAwakeOnce();
    expect(hotspotJoinCalls()).toHaveLength(0); // poll 1: let macOS auto-join first

    world.nowMs += MINUTE;
    await pollKeepAwakeOnce();
    expect(hotspotJoinCalls()).toHaveLength(1); // poll 2: force the hotspot
    expect(hotspotJoinCalls()[0].args).toEqual(['-setairportnetwork', 'en0', 'MyPhone', 'pw123456']);
  });

  it('rate-limits hotspot retries to one per 5 minutes', async () => {
    world.config = { enabled: true, hotspot_ssid: 'MyPhone' };
    world.online = false;
    for (let i = 0; i < 4; i++) {
      await pollKeepAwakeOnce();
      world.nowMs += MINUTE;
    }
    expect(hotspotJoinCalls()).toHaveLength(1);
    world.nowMs += 5 * MINUTE;
    await pollKeepAwakeOnce();
    expect(hotspotJoinCalls()).toHaveLength(2);
  });

  it('never touches the hotspot without an SSID configured', async () => {
    world.online = false;
    for (let i = 0; i < 5; i++) {
      await pollKeepAwakeOnce();
      world.nowMs += MINUTE;
    }
    expect(hotspotJoinCalls()).toHaveLength(0);
  });

  it('reports needs-sudo (and does not claim holding) when pmset is refused', async () => {
    world.sudoFails = true;
    const notifications: string[] = [];
    await pollKeepAwakeOnce((title) => notifications.push(title));
    const s = getKeepAwakeState();
    expect(s.holding).toBe(false);
    expect(s.reason).toBe('needs-sudo');
    expect(s.needsSudo).toBe(true);
    expect(notifications).toContain('Keep-Awake Needs a One-Time Setup');
  });

  it('releases a stale hold when the feature is disabled mid-flight', async () => {
    await pollKeepAwakeOnce();
    expect(disableSleepCalls()).toEqual(['1']);
    world.config = { enabled: false };
    await pollKeepAwakeOnce();
    expect(disableSleepCalls()).toEqual(['1', '0']);
    expect(getKeepAwakeState().reason).toBe('disabled');
  });

  it('never calls pmset at all while disabled (user-owned flag stays untouched)', async () => {
    world.config = { enabled: false };
    await pollKeepAwakeOnce();
    await pollKeepAwakeOnce();
    expect(disableSleepCalls()).toEqual([]);
  });

  it('treats an unreadable config as disabled (fail safe, never sleepless)', async () => {
    await pollKeepAwakeOnce();
    _setConfigReaderForTest(async () => { throw new Error('yaml exploded'); });
    await pollKeepAwakeOnce();
    expect(disableSleepCalls()).toEqual(['1', '0']);
  });

  it('keeps holding through the linger window, then releases', async () => {
    world.config = { enabled: true, linger_minutes: 5 };
    await pollKeepAwakeOnce();
    world.sessions = 0;
    world.nowMs += 3 * MINUTE;
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().holding).toBe(true);
    world.nowMs += 3 * MINUTE; // 6 min since last running session
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().reason).toBe('no-sessions');
    expect(disableSleepCalls().at(-1)).toBe('0');
  });
});

describe('getSudoSetupCommand', () => {
  it('scopes the rule to exactly the two pmset disablesleep commands', () => {
    const cmd = getSudoSetupCommand();
    expect(cmd).toContain('NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0');
    expect(cmd).toContain('/etc/sudoers.d/walnut-keep-awake');
    expect(cmd).toContain('chmod 440');
  });
});
