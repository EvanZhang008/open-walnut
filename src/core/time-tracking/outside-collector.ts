/**
 * Outside-activity collector: owns the walnut-activity helper child process and
 * turns its 5-second NDJSON samples into banked time.
 *
 * Compiling, signing and caching the helper binary belong to
 * src/core/helper-build.ts (its header explains why the signature is what decides
 * whether the user's Automation grant survives a rebuild). No swiftc on the box
 * means the collector reports not-running instead of crashing.
 *
 * OFF by default: sampling which app someone is in is exactly the kind of thing
 * that must be an explicit choice, so nothing spawns until config.time.outside
 * .enabled is true. Toggling is hot, with no server restart.
 *
 * Never one log line per tick: a sampler that logged per sample would write
 * 17k lines a day. Conditions are logged once each (warnOnce).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { CLOUD_MODE, IS_EPHEMERAL } from '../../constants.js';
import {
  clearFailedHelper, ensureHelper, helperFailure, resetHelperBuilds,
  type HelperSpec, type HelperUnavailable,
} from '../helper-build.js';
import { log } from '../../logging/index.js';
import { localDateKey } from './rollup.js';
import { recordOutside, type OutsideRecord } from './outside-store.js';

/** Bumped when src/data/walnut-activity.swift changes, so an upgraded machine
 *  can never keep running the old cached binary.
 *  v2: signal forwarding + orphan self-reap in the helper (see the swift file).
 *  v3: the helper services its run loop, so a long-lived process sees app
 *  switches instead of reporting the app that was frontmost when it started.
 *  v4: no source change. The bump exists to REPLACE the cached ad-hoc binary with
 *  a certificate-signed one, which is what makes the Automation grant survive
 *  future upgrades (see src/core/helper-build.ts). ensureHelper() returns an
 *  existing cache untouched, so signing could not have reached it any other way,
 *  and re-signing in place would have been worse: it changes the content hash and
 *  would silently break the grant the user already has. Cost: macOS asks for
 *  Automation once more, which is a prompt and one click.
 *  v5: no source change either. v4 turned out to be UNGRANTABLE, and the reason is
 *  worth keeping: signing with a certificate also puts the binary under the
 *  hardened runtime, and under that runtime tccd refuses to show the Automation
 *  prompt for a binary that does not declare
 *  com.apple.security.automation.apple-events. It reports nothing to the caller
 *  either, so the request just comes back denied and the UI can only say "not
 *  granted" forever. v5 carries the entitlement (see HELPER_SPEC), and it needs a
 *  NEW file name rather than a re-sign because tccd had already recorded an entry
 *  for v4's path whose code requirement no longer matches, and it will not
 *  re-prompt for that path.
 *  MUST equal HELPER_VERSION in src/data/walnut-activity.swift (ratchet test). */
export const HELPER_VERSION = 'v5';
/** The helper's own cadence (src/data/walnut-activity.swift SAMPLE_INTERVAL). */
export const TICK_MS = 5_000;
/** Above this, the user is away from the keyboard: the sample is not attention. */
export const MAX_IDLE_SECS = 120;
/** Ceiling on one banked window, so a stalled helper or a slept machine cannot
 *  turn one late sample into hours. */
export const MAX_BANK_MS = 15_000;
/**
 * Bundle ids that are the ABSENCE of the user, not an app they are using: the
 * lock/login screen and the screen saver. They are discarded here as well as in
 * the helper because they are how "away" time got attributed to an app — a stale
 * frontmost read banked 20 minutes of `com.apple.loginwindow` as if it were work.
 * `locked` should already cover it; this is the belt to that braces (fast user
 * switching shows the login window without the screen being locked).
 */
export const AWAY_BUNDLE_IDS: readonly string[] = [
  'com.apple.loginwindow',
  'com.apple.ScreenSaver.Engine',
  'com.apple.ScreenSaverEngine',
];
/** Restart backoff for a helper that dies. */
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** A child that survives this long is healthy: reset its backoff. */
const HEALTHY_AFTER_MS = 60_000;
/** A line longer than this is not one of our samples. */
const MAX_LINE_BYTES = 64 * 1024;

/** Embedded into the binary so tccd can caption the Automation prompt with
 *  NSAppleEventsUsageDescription. It only reaches tccd because the helper re-execs
 *  to disclaim parent responsibility and become its own TCC subject; without the
 *  key there, the Apple Events request is refused outright. */
const HELPER_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>dev.openwalnut.activity-helper</string>
    <key>CFBundleName</key>
    <string>Walnut Activity Helper</string>
    <key>NSAppleEventsUsageDescription</key>
    <string>Walnut breaks your browser time down by site.</string>
</dict>
</plist>
`;

/** One NDJSON sample as the helper emits it. */
export interface ActivitySample {
  ts: string;
  app: string;
  bundleId?: string;
  idleSecs?: number;
  locked?: boolean;
  /** Host only (no scheme/path), and only for a scriptable browser. */
  host?: string;
  /** 'permission' when the browser's Automation grant is missing. */
  browserErr?: string;
}

const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string, data: Record<string, unknown> = {}): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  log.web.warn(message, data);
}

// ── pure: what a sample is worth ────────────────────────────────────────────

/**
 * Validate ONE helper line. PURE. Returns null for anything that is not a
 * sample (a torn line, a helper error payload, junk on stdout).
 */
export function parseSampleLine(line: string): ActivitySample | null {
  const text = line.trim();
  if (!text || text.length > MAX_LINE_BYTES || text[0] !== '{') return null;
  try {
    const obj = JSON.parse(text) as Partial<ActivitySample>;
    if (typeof obj.app !== 'string' || !obj.app.trim()) return null;
    const out: ActivitySample = { ts: typeof obj.ts === 'string' ? obj.ts : '', app: obj.app.trim() };
    if (typeof obj.bundleId === 'string' && obj.bundleId.trim()) out.bundleId = obj.bundleId.trim();
    if (typeof obj.idleSecs === 'number' && Number.isFinite(obj.idleSecs)) out.idleSecs = obj.idleSecs;
    if (typeof obj.locked === 'boolean') out.locked = obj.locked;
    if (typeof obj.host === 'string' && obj.host.trim()) out.host = obj.host.trim().toLowerCase();
    if (typeof obj.browserErr === 'string' && obj.browserErr.trim()) out.browserErr = obj.browserErr.trim();
    return out;
  } catch {
    return null;
  }
}

/**
 * How much time ONE sample banks, and what the next sample should measure from.
 * PURE — this is the whole acceptance rule, testable without spawning anything.
 *
 * A locked screen or an idle stretch is not attention, so it banks nothing AND
 * clears the anchor: the next accepted sample must not bill the whole away
 * period. With no anchor, a sample banks one nominal tick rather than guessing,
 * and a continuous run banks the real elapsed time capped at MAX_BANK_MS (the
 * cap is what a suspended machine or a starved helper runs into).
 */
export function decideSample(
  sample: ActivitySample,
  prevAtMs: number | null,
  nowMs: number,
): { durationMs: number; nextPrev: number | null } {
  if (sample.locked === true) return { durationMs: 0, nextPrev: null };
  // The lock/login screen and the screen saver are away time, whatever the
  // `locked` flag says (see AWAY_BUNDLE_IDS).
  if (sample.bundleId && AWAY_BUNDLE_IDS.includes(sample.bundleId)) {
    return { durationMs: 0, nextPrev: null };
  }
  if (typeof sample.idleSecs === 'number' && sample.idleSecs > MAX_IDLE_SECS) {
    return { durationMs: 0, nextPrev: null };
  }
  if (prevAtMs === null) return { durationMs: TICK_MS, nextPrev: nowMs };
  const elapsed = nowMs - prevAtMs;
  if (elapsed <= 0) return { durationMs: 0, nextPrev: prevAtMs };
  return { durationMs: Math.min(elapsed, MAX_BANK_MS), nextPrev: nowMs };
}

/**
 * A banked sample as a store record. `ts` is the START of the counted window
 * (types.ts's convention for every lane) and `date` is that start's local day, so
 * a window straddling midnight is filed under the day it began.
 *
 * ATTRIBUTION: a window is credited entirely to the app seen at its END, so an
 * app switch inside a 5-second window rounds to the app switched TO. Over a day
 * of switching, the error is symmetric and self-cancelling; the alternative
 * (sampling faster) costs Apple Events and battery for no better daily number.
 */
export function sampleToRecord(sample: ActivitySample, durationMs: number, receivedAt: Date): OutsideRecord {
  // The helper stamps local wall time with no zone, which Date reads as local.
  const stamped = sample.ts ? new Date(sample.ts) : new Date(NaN);
  const at = Number.isFinite(stamped.getTime()) ? stamped : receivedAt;
  const startedAt = new Date(at.getTime() - durationMs);
  return {
    date: localDateKey(startedAt),
    ts: startedAt.toISOString(),
    durationMs,
    app: sample.app,
    ...(sample.bundleId ? { bundleId: sample.bundleId } : {}),
    ...(sample.host ? { host: sample.host } : {}),
  };
}

// ── helper binary ───────────────────────────────────────────────────────────

const HELPER_NAME = 'walnut-activity';

const HELPER_SPEC: HelperSpec = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  /** Version-free on purpose: a certificate-signed Automation grant is remembered
   *  against this string, so it must not move when HELPER_VERSION does. */
  identifier: 'dev.openwalnut.activity',
  infoPlist: HELPER_INFO_PLIST,
  // Without this, a certificate-signed helper can never be granted Automation at
  // all: tccd applies its hardened-runtime prompting policy and refuses to show
  // the dialog for a binary that does not declare the entitlement. See the
  // `entitlements` field's comment in src/core/helper-build.ts.
  entitlements: ['com.apple.security.automation.apple-events'],
};

/** Why this box has no helper. Null = fine, or not attempted yet. It lives in
 *  helper-build.ts now; re-exported so the barrel and the routes keep importing it
 *  from here. */
export type { HelperUnavailable };

/** The last compile/availability failure, for the API's `reason` field. */
export function outsideHelperReason(): HelperUnavailable | null {
  return helperFailure(HELPER_NAME);
}

/**
 * Let a FAILED availability check be retried (the user installed Xcode CLT and
 * flipped the toggle again). Only clears a settled failure: a compile still in
 * flight has no reason recorded, so it is never thrown away mid-run.
 */
export function clearFailedHelperCache(): void {
  clearFailedHelper(HELPER_NAME);
}

/** Compile once per machine; null when this box can't have the helper at all. */
export function ensureActivityHelper(): Promise<string | null> {
  return ensureHelper(HELPER_SPEC, 'walnut-activity.swift');
}

// ── child lifecycle ─────────────────────────────────────────────────────────

let child: ChildProcess | null = null;
let stopRequested = true;
let starting: Promise<void> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = BACKOFF_START_MS;
let prevAcceptedAtMs: number | null = null;
let stdoutBuffer = '';

/** True while a helper process is attached and streaming. */
export function isOutsideCollectorRunning(): boolean {
  return child !== null;
}

async function outsideEnabled(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js');
    const config = await getConfig();
    return config.time?.outside?.enabled === true;
  } catch (err) {
    warnOnce('noconfig', 'outside-activity config unreadable, staying off', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Start sampling if this box can and the user asked for it. Idempotent, and safe
 * to call from the config toggle: a second call while a child is alive (or while
 * a first start is still resolving) is a no-op.
 */
export async function startOutsideCollector(): Promise<void> {
  if (process.platform !== 'darwin' || CLOUD_MODE) return;
  // An ephemeral server (tests, `dev:ephemeral`, demos) seeds the real config into
  // a throwaway data dir, so it would inherit `enabled: true` and spawn its own
  // sampler — N dev servers meant N helper pairs on the machine, each firing Apple
  // Events at the user's browsers to fill a store that is deleted on exit.
  if (IS_EPHEMERAL) return;
  if (!(await outsideEnabled())) return;
  // An enable is the user asking again, so a previously failed availability check
  // (no Xcode CLT at boot) gets one more chance instead of being cached for the
  // life of the process.
  clearFailedHelperCache();
  stopRequested = false;
  if (child || starting) return starting ?? undefined;
  starting = (async () => {
    const bin = await ensureActivityHelper();
    // stop() may have been called while the compile ran.
    if (!bin || stopRequested || child) return;
    spawnHelper(bin);
  })().finally(() => { starting = null; });
  return starting;
}

/**
 * Stop sampling and detach. Idempotent; cancels any pending restart.
 *
 * Kills the process GROUP, not the pid. The helper re-execs itself to disclaim
 * TCC responsibility, so the pid we hold is a wrapper blocked in waitpid while a
 * second process does the sampling: SIGTERM to the wrapper alone left the sampler
 * running (and firing Apple Events) forever, one orphan per off→on toggle.
 * Destroying stdout first also arms the helper's EPIPE self-reap, and the helper
 * itself quits when orphaned — three independent layers, because a leaked sampler
 * is invisible to the user and never stops on its own.
 */
export function stopOutsideCollector(): void {
  stopRequested = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const proc = child;
  child = null;
  prevAcceptedAtMs = null;
  stdoutBuffer = '';
  backoffMs = BACKOFF_START_MS;
  if (!proc) return;
  proc.removeAllListeners();
  proc.stderr?.removeAllListeners();
  proc.stdout?.removeAllListeners();
  // destroy(), not just removeAllListeners(): an undrained pipe leaves the writer
  // happily writing, so EPIPE never happens.
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  killTree(proc);
}

/** SIGTERM the child's whole process group (it is a group leader — see spawnHelper). */
function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (typeof pid === 'number' && pid > 0) {
    try {
      process.kill(-pid, 'SIGTERM');
      return;
    } catch (err) {
      // ESRCH = the group is already gone, which is the outcome we wanted.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  try {
    proc.kill('SIGTERM'); // last resort: at least the wrapper
  } catch {
    // Already gone; nothing to do.
  }
}

function spawnHelper(bin: string): void {
  const startedAt = Date.now();
  let proc: ChildProcess;
  try {
    // detached: its own process group, so ONE signal reaches the wrapper and the
    // disclaimed inner process together (see killTree).
    proc = spawn(bin, ['stream'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  } catch (err) {
    warnOnce('nospawn', 'outside-activity helper could not be spawned', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  child = proc;
  prevAcceptedAtMs = null;
  stdoutBuffer = '';
  proc.stdout?.setEncoding('utf-8');
  proc.stdout?.on('data', (chunk: string) => { onStdout(chunk); });
  proc.stderr?.setEncoding('utf-8');
  proc.stderr?.on('data', (chunk: string) => {
    const text = String(chunk).trim();
    if (text) warnOnce('stderr', 'outside-activity helper stderr', { error: text.slice(0, 300) });
  });
  proc.on('error', (err) => {
    // A spawn failure (ENOENT, EACCES) emits 'error' and then 'close' — never
    // 'exit'. Listening for 'exit' alone left `child` set to a process that never
    // existed, so the API reported running:true forever and no retry was ever
    // scheduled.
    warnOnce('procerror', 'outside-activity helper error', { error: err.message });
  });
  let gone = false;
  const onGone = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (gone) return; // 'exit' and 'close' both fire in the normal case
    gone = true;
    if (child !== proc) return; // superseded by stop()/another spawn
    child = null;
    prevAcceptedAtMs = null;
    if (stopRequested) return;
    // The wrapper can die while its inner sampler lives (a crash forwards
    // nothing). Sweep the group before restarting, or two samplers would write
    // the same seconds twice.
    killTree(proc);
    if (Date.now() - startedAt >= HEALTHY_AFTER_MS) backoffMs = BACKOFF_START_MS;
    warnOnce('exit', 'outside-activity helper exited, will retry', { code, signal, backoffMs });
    scheduleRestart(bin);
  };
  proc.on('exit', onGone);
  proc.on('close', onGone);
}

function scheduleRestart(bin: string): void {
  if (restartTimer || stopRequested) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (stopRequested || child) return;
    spawnHelper(bin);
  }, delay);
  // A pending retry must never hold the process open at shutdown.
  restartTimer.unref?.();
}

function onStdout(chunk: string): void {
  stdoutBuffer += chunk;
  if (stdoutBuffer.length > MAX_LINE_BYTES * 4) {
    // No newline in a very long stretch: not our protocol, start clean.
    stdoutBuffer = '';
    warnOnce('flood', 'outside-activity helper produced an oversized line, buffer dropped');
    return;
  }
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop() ?? '';
  for (const line of lines) handleLine(line);
}

function handleLine(line: string): void {
  const sample = parseSampleLine(line);
  if (!sample) return;
  if (sample.browserErr === 'permission') {
    // The user has to grant Automation themselves; the helper already throttles
    // its retries, so this is logged once and never per tick.
    warnOnce(`browserperm:${sample.bundleId ?? sample.app}`,
      'outside-activity: browser site attribution needs Automation permission',
      { app: sample.app, bundleId: sample.bundleId });
  }
  const now = Date.now();
  const { durationMs, nextPrev } = decideSample(sample, prevAcceptedAtMs, now);
  prevAcceptedAtMs = nextPrev;
  if (durationMs <= 0) return;
  void recordOutside([sampleToRecord(sample, durationMs, new Date(now))]);
}

/** Tests only: drop the compile cache and the once-per-condition log guards. */
export function resetOutsideCollectorForTest(): void {
  stopOutsideCollector();
  // Unconditional, unlike clearFailedHelperCache(): a test that swaps WALNUT_HOME
  // must not keep a memoized SUCCESS pointing at the previous cache dir.
  resetHelperBuilds();
  warnedOnce.clear();
}
