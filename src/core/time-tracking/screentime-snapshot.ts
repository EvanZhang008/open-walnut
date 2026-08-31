/**
 * Snapshot scheduler: copy Apple's Screen Time numbers into Walnut's own store
 * before Apple throws them away.
 *
 * Apple keeps roughly two to four weeks of Screen Time history and then purges
 * it. Everything Walnut has ever seen it keeps forever, so the value of this
 * feature grows from the day it is switched on and nothing before that day is
 * ever recoverable. That asymmetry drives every choice here: snapshot eagerly,
 * snapshot the recent past rather than only today, and never let a failure be
 * silent (a user who thinks it is running while it is not loses history).
 *
 * Why re-snapshot several days instead of just today:
 *
 *   - iCloud sync is not instant. A phone that was off Wi-Fi lands its numbers on
 *     the Mac hours later, so today's answer keeps growing after midnight.
 *   - Apple revises recent days as more usage arrives, so a day read once is not
 *     final. The store replaces per (date, device) precisely so re-reading a day
 *     corrects it instead of adding to it.
 *
 * Everything expensive happens in child processes (see screentime-reader.ts):
 * the file copy runs in walnut-reader and the queries run in /usr/bin/sqlite3, so
 * the web server's single event loop is never holding a multi-megabyte parse.
 */

import { getConfig } from '../config-manager.js';
import { log } from '../../logging/index.js';
import { localDateKey, recentDateKeys } from './rollup.js';
import {
  probeScreenTimeAccess, readScreenTime,
  type ScreenTimeFailure, type ScreenTimeSnapshot,
} from './screentime-reader.js';
import { recordScreenTimeSnapshot, type ScreenTimeWriteResult } from './screentime-store.js';

/**
 * How far back each snapshot re-reads. Comfortably inside Apple's retention so a
 * Mac that was asleep for a week still catches up, and bounded so the query stays
 * an aggregate over a few hundred rows.
 */
export const SNAPSHOT_LOOKBACK_DAYS = 14;

/** Between scheduled snapshots. Screen Time itself only updates in blocks, so
 *  polling faster buys nothing and spends a helper spawn each time. */
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

/** After a failed attempt, wait this long before the next one rather than the
 *  full hour: a denied grant is usually fixed within minutes of being explained. */
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

export interface SnapshotOutcome {
  ok: boolean;
  /** Days written to the permanent store. */
  days: number;
  devices: number;
  failure?: ScreenTimeFailure;
  at: number;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<SnapshotOutcome> | null = null;
let last: SnapshotOutcome | null = null;

/** The most recent attempt's outcome, for the settings UI and the API. */
export function lastSnapshotOutcome(): SnapshotOutcome | null {
  return last;
}

/**
 * Take one snapshot now. Concurrent callers share the in-flight attempt, so a
 * page that opens while the hourly timer is running does not double the work.
 * Never throws: a telemetry read must not surface as a request failure.
 */
export function snapshotScreenTime(now = new Date()): Promise<SnapshotOutcome> {
  if (inFlight) return inFlight;
  inFlight = runSnapshot(now).finally(() => { inFlight = null; });
  return inFlight;
}

async function runSnapshot(now: Date): Promise<SnapshotOutcome> {
  const at = now.getTime();
  const enabled = await screenTimeEnabled();
  if (!enabled) {
    // Not a failure: the feature is off. Recording it as one would light up the
    // settings panel with a problem the user deliberately chose.
    const outcome: SnapshotOutcome = { ok: true, days: 0, devices: 0, at };
    last = outcome;
    return outcome;
  }
  const since = recentDateKeys(localDateKey(now), SNAPSHOT_LOOKBACK_DAYS)[0]!;
  const result = await readScreenTime(since);
  if ('kind' in result) {
    const outcome: SnapshotOutcome = { ok: false, days: 0, devices: 0, failure: result, at };
    last = outcome;
    // Denied is the one failure with a user-facing fix, so it is logged at a
    // level the ops toolkit surfaces rather than buried as debug noise.
    log.web.warn('screen time snapshot could not read the store', {
      kind: result.kind,
      ...(result.kind === 'denied' ? { denied: result.denied } : {}),
      ...(result.kind === 'error' ? { error: result.message } : {}),
    });
    return outcome;
  }
  const write = await writeSnapshot(result);
  const outcome: SnapshotOutcome = {
    ok: true,
    // Dates actually rewritten. `unchanged` is deliberately NOT counted: a settled
    // day that already holds these exact numbers was not stored again, and calling
    // it stored would make a no-op look like progress.
    days: write.dates.length,
    devices: result.devices.length,
    at,
  };
  last = outcome;
  log.web.info('screen time snapshot stored', {
    days: write.dates.length,
    unchanged: write.unchanged.length,
    skipped: write.skipped.length,
    devices: result.devices.length,
    since,
  });
  return outcome;
}

async function writeSnapshot(snapshot: ScreenTimeSnapshot): Promise<ScreenTimeWriteResult> {
  try {
    return await recordScreenTimeSnapshot(snapshot);
  } catch (err) {
    log.web.warn('screen time snapshot could not be stored', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { dates: [], unchanged: [], skipped: [], written: 0, kept: 0, replaced: 0 };
  }
}

async function screenTimeEnabled(): Promise<boolean> {
  try {
    const config = await getConfig();
    return config.time?.screentime?.enabled === true;
  } catch {
    return false; // an unreadable config is not consent
  }
}

/**
 * Start the hourly snapshot. Idempotent, and safe to call on every boot: it
 * returns immediately unless the feature is enabled, and the first snapshot is
 * deferred off the boot path so a cold helper compile never delays startup.
 */
export function startScreenTimeSnapshots(): void {
  if (timer || process.platform !== 'darwin') return;
  const tick = async (): Promise<void> => {
    let delay = SNAPSHOT_INTERVAL_MS;
    try {
      const outcome = await snapshotScreenTime();
      if (!outcome.ok) delay = RETRY_AFTER_FAILURE_MS;
    } catch {
      delay = RETRY_AFTER_FAILURE_MS;
    }
    if (timer) {
      timer = setTimeout(() => { void tick(); }, delay);
      timer.unref?.();
    }
  };
  // A short first delay, not zero: boot already has a helper compile, a rollup
  // hydrate and the web server coming up competing for the same machine.
  timer = setTimeout(() => { void tick(); }, 30_000);
  timer.unref?.();
}

/** Counterpart for stopServer(). Unconditional and cheap. */
export function stopScreenTimeSnapshots(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Test hook: forget the recorded outcome without touching the store. */
export function resetScreenTimeSnapshotState(): void {
  stopScreenTimeSnapshots();
  inFlight = null;
  last = null;
}

/** Re-export so routes can ask "why can't we read it" without a second import. */
export { probeScreenTimeAccess };
