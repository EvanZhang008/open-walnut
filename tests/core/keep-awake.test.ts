/**
 * Keep-Awake monitor — decision logic, pmset assertion, and fail-safe behavior.
 * Every collaborator (pmset exec, battery, connectivity, session count, config,
 * clock) is injected, so no test touches the real machine's power management.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  decideKeepAwake,
  pollKeepAwakeOnce,
  getKeepAwakeState,
  getSudoSetupCommand,
  checkSudoSetup,
  runSudoSetup,
  resetKeepAwakeForTest,
  _setExecForTest,
  _setOnlineCheckForTest,
  _setSessionCounterForTest,
  _setConfigReaderForTest,
  _setNowForTest,
  DEFAULT_BATTERY_FLOOR_PCT,
  DEFAULT_OFFLINE_GRACE_MINUTES,
  pollClosedLidDisplayOnce,
  type KeepAwakeConfig,
} from '../../src/core/keep-awake.js';

// ── Harness ──────────────────────────────────────────────────────────────────

interface FakeWorld {
  config: KeepAwakeConfig;
  sessions: number;
  batteryPct: number | null;
  onAc: boolean;
  online: boolean;
  lidClosed: boolean | null;
  nowMs: number;
  sudoFails: boolean;
  osascriptResult: { ok: boolean; stdout: string; stderr: string };
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
    if (cmd === '/usr/sbin/ioreg') {
      if (world.lidClosed === null) return { ok: false, stdout: '', stderr: 'unavailable' };
      return { ok: true, stdout: `\"AppleClamshellState\" = ${world.lidClosed ? 'Yes' : 'No'}\n`, stderr: '' };
    }
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
    if (cmd === '/usr/bin/osascript') {
      return world.osascriptResult;
    }
    return { ok: true, stdout: '', stderr: '' };
  });
}

/** pmset disablesleep MUTATIONS observed so far ('1'/'0' in order). Excludes
 *  the read-only `sudo -n -l` setup probe, which also mentions disablesleep. */
function disableSleepCalls(): string[] {
  return world.execCalls
    .filter((c) => c.cmd === '/usr/bin/sudo' && c.args.includes('disablesleep') && !c.args.includes('-l'))
    .map((c) => c.args[c.args.length - 1]);
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
    lidClosed: false,
    nowMs: 1_000_000_000,
    sudoFails: false,
    osascriptResult: { ok: true, stdout: '', stderr: '' },
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
    offlineGraceMinutes: 5,
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
    expect(decideKeepAwake({ ...base, offlineMinutes: 5 }))
      .toEqual({ awake: false, reason: 'offline-too-long' });
    expect(decideKeepAwake({ ...base, offlineMinutes: 4 }).awake).toBe(true);
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

  it('releases after the default five-minute offline grace window', async () => {
    await pollKeepAwakeOnce();
    world.online = false;
    await pollKeepAwakeOnce(); // offline clock starts
    expect(getKeepAwakeState().holding).toBe(true);

    world.nowMs += 4 * MINUTE;
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().holding).toBe(true);

    world.nowMs += 1 * MINUTE; // 5 min offline total
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().reason).toBe('offline-too-long');
    expect(disableSleepCalls().at(-1)).toBe('0');
    expect(DEFAULT_OFFLINE_GRACE_MINUTES).toBe(5);
  });

  it('respects an explicit longer offline grace from config', async () => {
    world.config = { enabled: true, offline_grace_minutes: 15 };
    await pollKeepAwakeOnce();
    world.online = false;
    await pollKeepAwakeOnce();
    world.nowMs += 5 * MINUTE;
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().holding).toBe(true);

    world.nowMs += 10 * MINUTE;
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().reason).toBe('offline-too-long');
  });

  it('a moment of connectivity resets the offline clock', async () => {
    world.online = false;
    await pollKeepAwakeOnce();
    world.nowMs += 4 * MINUTE;
    world.online = true;
    await pollKeepAwakeOnce();

    world.online = false;
    await pollKeepAwakeOnce(); // new offline clock starts
    world.nowMs += 4 * MINUTE;
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().holding).toBe(true);
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

darwinOnly('closed-lid display sleep', () => {
  const displaySleepCalls = () => world.execCalls.filter(
    (c) => c.cmd === '/usr/bin/osascript' && c.args.at(-1)?.includes('IORequestIdle'),
  );
  const lidStateCalls = () => world.execCalls.filter((c) => c.cmd === '/usr/sbin/ioreg');

  it('sleeps displays once when the lid closes while holding', async () => {
    await pollKeepAwakeOnce();
    await pollClosedLidDisplayOnce();
    expect(displaySleepCalls()).toHaveLength(0);

    world.lidClosed = true;
    await pollClosedLidDisplayOnce();
    await pollClosedLidDisplayOnce();
    expect(displaySleepCalls()).toHaveLength(1);
  });

  it('does not retry a failed display sleep until the lid closes again', async () => {
    await pollKeepAwakeOnce();
    world.lidClosed = true;
    world.osascriptResult = { ok: false, stdout: '', stderr: 'display sleep unavailable' };
    await pollClosedLidDisplayOnce();
    await pollClosedLidDisplayOnce();
    expect(displaySleepCalls()).toHaveLength(1);

    world.lidClosed = false;
    await pollClosedLidDisplayOnce();
    world.lidClosed = true;
    await pollClosedLidDisplayOnce();
    expect(displaySleepCalls()).toHaveLength(2);
  });

  it('does not poll the lid when the feature is not holding', async () => {
    world.config = { enabled: false };
    await pollKeepAwakeOnce();
    world.lidClosed = true;
    await pollClosedLidDisplayOnce();
    expect(lidStateCalls()).toHaveLength(0);
    expect(displaySleepCalls()).toHaveLength(0);
  });

  it('re-arms after the lid opens and closes again', async () => {
    await pollKeepAwakeOnce();
    await pollClosedLidDisplayOnce();

    world.lidClosed = true;
    await pollClosedLidDisplayOnce();
    world.lidClosed = false;
    await pollClosedLidDisplayOnce();
    world.lidClosed = true;
    await pollClosedLidDisplayOnce();

    expect(displaySleepCalls()).toHaveLength(2);
  });
});

describe('setup detection and one-click install', () => {
  it('checkSudoSetup probes with sudo -n -l and never mutates pmset', async () => {
    expect(await checkSudoSetup()).toBe(true);
    world.sudoFails = true;
    expect(await checkSudoSetup()).toBe(false);
    expect(disableSleepCalls()).toEqual([]); // probe is read-only
  });

  it('runSudoSetup succeeds via osascript', async () => {
    expect(await runSudoSetup()).toEqual({ ok: true, detail: 'installed' });
    const call = world.execCalls.find((c) => c.cmd === '/usr/bin/osascript');
    expect(call?.args[1]).toContain('administrator privileges');
    expect(call?.args[1]).toContain('walnut-keep-awake');
  });

  it('runSudoSetup reports a user-canceled dialog distinctly', async () => {
    world.osascriptResult = { ok: false, stdout: '', stderr: 'execution error: User canceled. (-128)' };
    expect(await runSudoSetup()).toEqual({ ok: false, detail: 'canceled' });
  });
});

// setupDone is published by the POLL, and pollKeepAwakeOnce returns early on any
// non-darwin host (keep-awake is pmset). It therefore belongs with the other
// darwinOnly poll suites, not with the exec-level setup tests above, which run
// anywhere because they call the helpers directly against the fake exec world.
// Grouped here rather than left in the suite above, where it passed on a Mac and
// failed on Linux CI for a reason unrelated to the behaviour it checks.
darwinOnly('setup detection through the poll', () => {
  it('poll exposes setupDone so the UI can show installed-vs-needed', async () => {
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().setupDone).toBe(true);
    world.sudoFails = true;
    await pollKeepAwakeOnce();
    expect(getKeepAwakeState().setupDone).toBe(false);
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
