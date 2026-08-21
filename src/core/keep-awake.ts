/**
 * Keep-Awake monitor — holds the Mac awake (lid closed included) while local
 * Claude Code sessions are actively running.
 *
 * The only supported way to keep a MacBook running with the lid shut (no
 * external display) is the root-only `pmset disablesleep 1`. Walnut runs as
 * the user, so the feature needs a one-time sudoers rule scoped to exactly
 * that command (see getSudoSetupCommand()). Until the rule exists the monitor
 * reports needsSudo and never holds.
 *
 * Release conditions (any one releases the hold):
 *   - feature disabled (default — this is an opt-in advanced feature)
 *   - no local session has been 'running' for linger_minutes
 *   - on battery and charge ≤ battery_floor_pct (default 30%)
 *   - offline for ≥ offline_grace_minutes (default 15)
 *
 * This feature only prevents SYSTEM sleep. It does not assert display activity,
 * so normal macOS display-sleep settings still turn the screen off. Network
 * recovery is deliberately left to macOS/the user: on macOS 15, third-party code
 * cannot wake a Bluetooth-discovered Instant Hotspot. If the Mac stays offline
 * for the grace window, Walnut restores normal sleep.
 *
 * Safety: `disablesleep` is a global machine flag, so a crash while holding
 * would leave the Mac unable to sleep. Mitigations: the desired state is
 * re-asserted on every poll (a stale flag self-corrects within a minute once
 * the feature is enabled), and server shutdown releases explicitly. When the
 * feature is disabled Walnut NEVER touches pmset — a user-set flag stays theirs.
 */

import { execFile as execFileCb } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { log } from '../logging/index.js';

const execFileAsync = promisify(execFileCb);

export interface KeepAwakeConfig {
  /** Master toggle. Default: false (advanced, opt-in). */
  enabled?: boolean;
  /** On battery power, release the hold at or below this charge. Default: 30. */
  battery_floor_pct?: number;
  /** Release the hold after this many minutes without internet. Default: 15. */
  offline_grace_minutes?: number;
  /** Keep holding this many minutes after the last running session ended, so
   *  back-to-back turns don't flap the hold. Default: 5. */
  linger_minutes?: number;
}

export const DEFAULT_BATTERY_FLOOR_PCT = 30;
export const DEFAULT_OFFLINE_GRACE_MINUTES = 15;
export const DEFAULT_LINGER_MINUTES = 5;
const DEFAULT_POLL_INTERVAL_MS = 60_000;

export type KeepAwakeReason = 'unsupported' | 'disabled' | 'needs-sudo' | 'no-sessions' | 'battery-low' | 'offline-too-long' | 'active';

export interface BatteryStatus { pct: number; onAc: boolean }

export interface KeepAwakeState {
  supported: boolean;
  enabled: boolean;
  /** True while `pmset disablesleep 1` is (believed) asserted by Walnut. */
  holding: boolean;
  reason: KeepAwakeReason;
  runningLocalSessions: number;
  battery: BatteryStatus | null;
  online: boolean | null;
  offlineSince: string | null;
  needsSudo: boolean;
  /** True once the sudoers rule is verified installed (sudo -n -l probe). */
  setupDone: boolean | null;
  checkedAt: string | null;
}

// ── Injectable collaborators (tests swap these; production never does) ──────

type ExecResult = { ok: boolean; stdout: string; stderr: string };
type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

const defaultExec: ExecFn = async (cmd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 15_000 });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? String(err) };
  }
};

/**
 * A tethered connection can be slow. Measured on a live phone hotspot, this
 * request took 0.3-4.0s across samples, so the original 4s deadline produced
 * false offline readings on a working connection. A generous deadline costs one
 * slow poll; a tight one can release the sleep hold incorrectly.
 */
const ONLINE_CHECK_TIMEOUT_MS = 12_000;

async function defaultCheckOnline(): Promise<boolean> {
  // Any HTTP response at all counts — captive portals still mean a live NIC,
  // and the grace window is about "can sessions reach their APIs eventually".
  try {
    await fetch('http://captive.apple.com/hotspot-detect.html', {
      signal: AbortSignal.timeout(ONLINE_CHECK_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

async function defaultCountRunningLocalSessions(): Promise<number> {
  // Lazy import: session-tracker pulls in the whole store layer; the monitor
  // itself must stay importable in isolation (routes, tests).
  const { getActiveSessionsByHost } = await import('./session-tracker.js');
  const byHost = await getActiveSessionsByHost();
  return (byHost['local'] ?? []).length;
}

async function defaultConfigReader(): Promise<KeepAwakeConfig> {
  // Lazy for the same reason as the session counter: config-manager drags in
  // the provider catalog, and this module must stay cheap to import.
  const { getConfig } = await import('./config-manager.js');
  return (await getConfig()).keep_awake ?? {};
}

let execImpl: ExecFn = defaultExec;
let checkOnlineImpl: () => Promise<boolean> = defaultCheckOnline;
let sessionCounterImpl: () => Promise<number> = defaultCountRunningLocalSessions;
let configReaderImpl: () => Promise<KeepAwakeConfig> = defaultConfigReader;
let nowImpl: () => number = () => Date.now();

export function _setExecForTest(fn: ExecFn | null): void { execImpl = fn ?? defaultExec; }
export function _setOnlineCheckForTest(fn: (() => Promise<boolean>) | null): void { checkOnlineImpl = fn ?? defaultCheckOnline; }
export function _setSessionCounterForTest(fn: (() => Promise<number>) | null): void { sessionCounterImpl = fn ?? defaultCountRunningLocalSessions; }
export function _setConfigReaderForTest(fn: (() => Promise<KeepAwakeConfig>) | null): void {
  configReaderImpl = fn ?? defaultConfigReader;
}
export function _setNowForTest(fn: (() => number) | null): void { nowImpl = fn ?? (() => Date.now()); }

// ── State ────────────────────────────────────────────────────────────────────

let state: KeepAwakeState = {
  supported: process.platform === 'darwin',
  enabled: false,
  holding: false,
  reason: 'disabled',
  runningLocalSessions: 0,
  battery: null,
  online: null,
  offlineSince: null,
  needsSudo: false,
  setupDone: null,
  checkedAt: null,
};

/** null = unknown (fresh start / possible crash while holding) → first
 *  enabled poll asserts whichever state is desired, recovering a stale flag. */
let lastApplied: boolean | null = null;
let lastRunningAtMs: number | null = null;
let offlineSinceMs: number | null = null;
let notifiedNeedsSudo = false;

export function getKeepAwakeState(): Readonly<KeepAwakeState> {
  return { ...state };
}

export function resetKeepAwakeForTest(): void {
  state = {
    supported: process.platform === 'darwin',
    enabled: false,
    holding: false,
    reason: 'disabled',
    runningLocalSessions: 0,
    battery: null,
    online: null,
    offlineSince: null,
    needsSudo: false,
    setupDone: null,
    checkedAt: null,
  };
  lastApplied = null;
  lastRunningAtMs = null;
  offlineSinceMs = null;
  notifiedNeedsSudo = false;
}

/** The one-time root rule this feature needs, scoped to exactly two commands. */
export function getSudoSetupCommand(): string {
  const user = os.userInfo().username;
  return `echo '${user} ALL=(ALL) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0' | sudo tee /etc/sudoers.d/walnut-keep-awake >/dev/null && sudo chmod 440 /etc/sudoers.d/walnut-keep-awake`;
}

/**
 * Is the sudoers rule installed? `sudo -n -l <cmd>` exits 0 iff the exact
 * command is runnable without a password — a pure probe: no password prompt,
 * no pmset touched, no state changed. This is what drives the UI's
 * green-vs-setup-needed indicator even while the feature is off or idle.
 */
export async function checkSudoSetup(): Promise<boolean> {
  const res = await execImpl('/usr/bin/sudo', ['-n', '-l', '/usr/bin/pmset', 'disablesleep', '1']);
  return res.ok;
}

/**
 * One-click setup: write the sudoers rule via osascript's
 * `with administrator privileges`, which pops the NATIVE macOS password
 * dialog — no Terminal, no copy-paste. Works because Walnut runs in the
 * user's GUI session on the console Mac.
 *
 * The written content is fixed server-side (never user input). On success the
 * caller should re-poll so a pending hold engages immediately.
 */
export async function runSudoSetup(): Promise<{ ok: boolean; detail: string }> {
  const user = os.userInfo().username;
  const line = `${user} ALL=(ALL) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0`;
  // printf (not echo) so the shell inside osascript needs no quoting gymnastics.
  const shellCmd = `printf '%s\\n' '${line}' > /etc/sudoers.d/walnut-keep-awake && chmod 440 /etc/sudoers.d/walnut-keep-awake`;
  const script = `do shell script "${shellCmd.replace(/"/g, '\\"')}" with administrator privileges with prompt "Walnut one-time setup: allow toggling sleep so sessions keep running with the lid closed."`;
  const res = await execImpl('/usr/bin/osascript', ['-e', script]);
  if (res.ok) {
    log.web.info('keep-awake sudoers rule installed via native auth dialog');
    return { ok: true, detail: 'installed' };
  }
  const canceled = /canceled|cancelled|-128/i.test(res.stderr);
  if (!canceled) log.web.warn('keep-awake one-click setup failed', { stderr: res.stderr.slice(0, 200) });
  return { ok: false, detail: canceled ? 'canceled' : res.stderr.trim().slice(0, 200) || 'failed' };
}

// ── Pure decision logic (unit-tested directly) ──────────────────────────────

export interface KeepAwakeInputs {
  enabled: boolean;
  runningLocalSessions: number;
  /** ms since a running local session was last seen; null = never seen. */
  msSinceLastRunning: number | null;
  /** null = no battery readable (desktop Mac) → no battery constraint. */
  battery: BatteryStatus | null;
  batteryFloorPct: number;
  offlineMinutes: number;
  offlineGraceMinutes: number;
  lingerMinutes: number;
}

export function decideKeepAwake(i: KeepAwakeInputs): { awake: boolean; reason: KeepAwakeReason } {
  if (!i.enabled) return { awake: false, reason: 'disabled' };
  const withinLinger = i.msSinceLastRunning !== null && i.msSinceLastRunning <= i.lingerMinutes * 60_000;
  if (i.runningLocalSessions <= 0 && !withinLinger) return { awake: false, reason: 'no-sessions' };
  if (i.battery && !i.battery.onAc && i.battery.pct <= i.batteryFloorPct) {
    return { awake: false, reason: 'battery-low' };
  }
  if (i.offlineMinutes >= i.offlineGraceMinutes) return { awake: false, reason: 'offline-too-long' };
  return { awake: true, reason: 'active' };
}

// ── Poll internals ───────────────────────────────────────────────────────────

async function readBattery(): Promise<BatteryStatus | null> {
  const res = await execImpl('/usr/bin/pmset', ['-g', 'batt']);
  if (!res.ok) return null;
  const m = res.stdout.match(/(\d{1,3})%/);
  if (!m) return null; // no battery lines — desktop Mac
  return { pct: Number(m[1]), onAc: res.stdout.includes("'AC Power'") };
}

async function applyDisableSleep(desired: boolean, notify?: KeepAwakeNotify): Promise<boolean> {
  // Skip the sudo round-trip when we already applied this state.
  if (lastApplied === desired) return true;
  const res = await execImpl('/usr/bin/sudo', ['-n', '/usr/bin/pmset', 'disablesleep', desired ? '1' : '0']);
  if (res.ok) {
    lastApplied = desired;
    state.needsSudo = false;
    notifiedNeedsSudo = false;
    log.web.info(desired ? 'keep-awake HOLDING — sleep disabled (lid-closed safe)' : 'keep-awake released — normal sleep restored');
    return true;
  }
  if (!state.needsSudo) {
    log.web.warn('keep-awake cannot run pmset without a password — sudoers rule missing', { stderr: res.stderr.slice(0, 200) });
  }
  state.needsSudo = true;
  // Notify ONLY when a hold is actually needed (sessions running, lid might
  // close any second). The just-enabled-it case surfaces inline in Settings —
  // the user is sitting right there; a notification would be noise.
  if (desired && !notifiedNeedsSudo) {
    notifiedNeedsSudo = true;
    notify?.(
      'Keep-Awake Needs a One-Time Setup',
      'Sessions are running but Walnut cannot keep the Mac awake yet. Open Settings → Advanced → Keep Mac Awake for the one-time setup command.',
      'keep-awake:needs-sudo',
    );
  }
  return false;
}

export type KeepAwakeNotify = (title: string, body: string, dedupScope: string) => void;

let monitorNotify: KeepAwakeNotify | undefined;

/**
 * One poll: read config + sessions + battery + connectivity → decide → assert.
 * Exported so tests, the status route, and config-change handlers can force an
 * immediate evaluation instead of waiting out the interval.
 */
export async function pollKeepAwakeOnce(notify: KeepAwakeNotify | undefined = monitorNotify): Promise<KeepAwakeState> {
  const now = nowImpl();
  if (process.platform !== 'darwin') {
    state = { ...state, supported: false, enabled: false, holding: false, reason: 'unsupported', checkedAt: new Date(now).toISOString() };
    return { ...state };
  }

  let cfg: KeepAwakeConfig;
  try {
    cfg = await configReaderImpl();
  } catch (err) {
    // Fail safe: unreadable config must never leave the Mac sleepless.
    log.web.warn('keep-awake config read failed — treating as disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
    cfg = { enabled: false };
  }
  const enabled = cfg.enabled === true;

  // Probe (not prompt): is the sudoers rule installed? Cheap and local; keeps
  // the settings indicator truthful even while disabled or idle.
  const setupDone = await checkSudoSetup().catch(() => false);
  state.setupDone = setupDone;
  state.needsSudo = !setupDone;

  if (!enabled) {
    // Never touch pmset while disabled — but if WE were holding (this process
    // set it), release before going quiet.
    if (lastApplied === true) await applyDisableSleep(false, notify);
    state = { ...state, enabled: false, holding: false, reason: 'disabled', checkedAt: new Date(now).toISOString() };
    return { ...state };
  }

  const [runningLocalSessions, battery, online] = await Promise.all([
    sessionCounterImpl().catch(() => 0),
    readBattery().catch(() => null),
    checkOnlineImpl().catch(() => false),
  ]);

  if (runningLocalSessions > 0) lastRunningAtMs = now;
  if (online) {
    offlineSinceMs = null;
  } else {
    offlineSinceMs ??= now;
  }
  const offlineMinutes = offlineSinceMs === null ? 0 : (now - offlineSinceMs) / 60_000;

  const decision = decideKeepAwake({
    enabled,
    runningLocalSessions,
    msSinceLastRunning: lastRunningAtMs === null ? null : now - lastRunningAtMs,
    battery,
    batteryFloorPct: cfg.battery_floor_pct ?? DEFAULT_BATTERY_FLOOR_PCT,
    offlineMinutes,
    offlineGraceMinutes: cfg.offline_grace_minutes ?? DEFAULT_OFFLINE_GRACE_MINUTES,
    lingerMinutes: cfg.linger_minutes ?? DEFAULT_LINGER_MINUTES,
  });

  const prevReason = state.reason;
  const applied = await applyDisableSleep(decision.awake, notify);
  const holding = decision.awake && applied;

  if (decision.reason !== prevReason && (decision.reason === 'battery-low' || decision.reason === 'offline-too-long')) {
    const why = decision.reason === 'battery-low'
      ? `battery at ${battery?.pct ?? '?'}% (floor ${cfg.battery_floor_pct ?? DEFAULT_BATTERY_FLOOR_PCT}%)`
      : `offline for ${Math.round(offlineMinutes)} minutes`;
    log.web.warn(`keep-awake released: ${why}`);
    notify?.('Keep-Awake Released', `The Mac is being allowed to sleep: ${why}. Running sessions may pause until it wakes.`, `keep-awake:${decision.reason}`);
  }

  state = {
    supported: true,
    enabled,
    holding,
    reason: !applied && decision.awake ? 'needs-sudo' : decision.reason,
    runningLocalSessions,
    battery,
    online,
    offlineSince: offlineSinceMs === null ? null : new Date(offlineSinceMs).toISOString(),
    needsSudo: state.needsSudo,
    setupDone: state.setupDone,
    checkedAt: new Date(now).toISOString(),
  };
  return { ...state };
}

export interface KeepAwakeHandle {
  stop: () => void;
  poll: () => Promise<KeepAwakeState>;
  /** Release the hold if this process asserted it (server shutdown path). */
  release: () => Promise<void>;
}

/**
 * Start the periodic monitor (macOS console box only — the caller gates on
 * platform/cloud/ephemeral). The caller supplies the notification sink so this
 * module never imports the web layer.
 */
export function startKeepAwakeMonitor(opts: { notify?: KeepAwakeNotify; intervalMs?: number } = {}): KeepAwakeHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  monitorNotify = opts.notify;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async (): Promise<void> => {
    try {
      await pollKeepAwakeOnce(opts.notify);
    } catch (err) {
      log.web.warn('keep-awake poll failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => { void tick(); }, intervalMs);
        timer.unref?.();
      }
    }
  };
  // First check shortly after boot (not instantly — let startup I/O settle).
  timer = setTimeout(() => { void tick(); }, Math.min(5_000, intervalMs));
  timer.unref?.();

  log.web.info('keep-awake monitor started', { intervalMs });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    poll: () => pollKeepAwakeOnce(opts.notify),
    async release() {
      if (lastApplied === true) await applyDisableSleep(false, opts.notify);
    },
  };
}
