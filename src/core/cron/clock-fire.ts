/**
 * A clock routine's run that a host's daemon reports (clock-routine-v1,
 * docs/plan/walnut-trigger.md "Clock routines"): whose slot it was, and so what
 * the server does with it.
 *
 * A daemon reports every run it made, also after the clock came back to the
 * server (it keeps the fires of a released clock until each is acked). A run the
 * host delivered into the session is always recorded: it happened. A run nobody
 * took is the server's to run, unless the server already ran that slot or now
 * owns it:
 *
 *  - `current`: made under the handover the server knows now. Run it.
 *  - `returned`: made under the clock that came back (`state.clockReturned`).
 *    Slots before `beforeMs` were the host's: run it. Later ones are the
 *    server timer's: it runs them itself.
 *  - `unknown`: an older handover, or the schedule started over since (an edit,
 *    a resume). The server's own clock stands for it.
 *
 * And never a second run for one slot: a routine that ran at or after the slot
 * (Run now, the server's own timer) has it covered, and a paused routine runs
 * nothing.
 */

import type { TriggerFiredEvent } from '../../providers/trigger-check-core.js';
import type { CronJob, CronServiceState } from './types.js';
import { clockOnDaemon, computeJobNextRunAtMs } from './jobs.js';
import { replayGuardOf } from './timer.js';

export type ClockTenure = 'current' | 'returned' | 'unknown';

/** Under which clock a host's run was made. `fromHost` absent: any host matches. */
export function clockTenureOf(job: CronJob, fire: Pick<TriggerFiredEvent, 'clock'>, fromHost?: string): ClockTenure {
  const mark = fire.clock?.fromMs;
  const s = job.state ?? {};
  const sameHost = (h: string | undefined) => fromHost === undefined || h === fromHost;
  if (s.clockHost !== undefined && sameHost(s.clockHost) && mark === s.clockFromMs) return 'current';
  const back = s.clockReturned;
  if (back && sameHost(back.host) && mark === back.fromMs) return 'returned';
  return 'unknown';
}

export type OwedClockVerdict =
  | { kind: 'run' }
  /** Not the server's to run: acked and recorded as seen, nothing runs. */
  | { kind: 'superseded'; reason: string }
  /** Not decidable now (the routine is running here): left unacked, the replay asks again. */
  | { kind: 'held'; reason: string };

/** What to do with a run the host made that nobody took. */
export function owedClockVerdict(job: CronJob, fire: Pick<TriggerFiredEvent, 'clock' | 'atMs'>, fromHost?: string): OwedClockVerdict {
  if (!job.enabled) return { kind: 'superseded', reason: 'the routine is paused' };
  if (typeof job.state?.runningAtMs === 'number') return { kind: 'held', reason: 'the routine is running on the server' };
  const slot = fire.clock?.slotMs ?? fire.atMs;
  const last = job.state?.lastRunAtMs;
  if (typeof last === 'number' && Number.isFinite(slot) && last >= slot) {
    return { kind: 'superseded', reason: 'the routine ran since this slot' };
  }
  const tenure = clockTenureOf(job, fire, fromHost);
  if (tenure === 'current') return { kind: 'run' };
  if (tenure === 'returned') {
    const before = job.state.clockReturned!.beforeMs;
    return before === undefined || slot < before
      ? { kind: 'run' }
      : { kind: 'superseded', reason: 'the server runs this slot itself' };
  }
  return { kind: 'superseded', reason: 'the clock started over since this run' };
}

/**
 * A clock routine's run, recorded the way the timer records one (applyJobResult)
 * minus the next slot, which is decided apart (settleClockNext). A one-shot is
 * spent by a run made under a clock the server knows. A delivery the daemon
 * replays (`retry`) has not run yet: only its error is kept, or the replay would
 * read as a slot already run. A record older than the last run only adds its
 * History row. Returns true when the routine should be deleted.
 */
export function applyClockRun(
  job: CronJob,
  r: { status: 'ok' | 'error'; error?: string; startedAt: number; endedAt: number; retry: boolean; tenure: ClockTenure },
): boolean {
  job.state.runningAtMs = undefined;
  if (r.retry) {
    job.state.lastError = r.error;
    return false;
  }
  const last = job.state.lastRunAtMs;
  if (!(typeof last === 'number' && last > r.startedAt)) {
    job.state.lastRunAtMs = r.startedAt;
    job.state.lastStatus = r.status;
    job.state.lastDurationMs = Math.max(0, r.endedAt - r.startedAt);
    job.state.lastError = r.error;
    job.state.consecutiveErrors = r.status === 'error' ? (job.state.consecutiveErrors ?? 0) + 1 : 0;
  }
  job.updatedAtMs = r.endedAt;
  if (job.schedule.kind !== 'at' || r.tenure === 'unknown') return false;
  if (r.status === 'ok' && job.deleteAfterRun === true) return true;
  job.enabled = false;
  job.state.nextRunAtMs = undefined;
  // Its one run is over: no clock holds it anywhere now.
  delete job.state.clockHost;
  delete job.state.clockFromMs;
  delete job.state.clockReturned;
  return false;
}

/**
 * The next slot after a host's run. While the host holds the clock, its report
 * (the event's nextRunAtMs) under the current handover. Once the server's timer
 * owns it, the server's own slot, moved past `ranAtMs` when that slot was already
 * due: one run stands for every slot it covered, wherever it ran.
 */
export function settleClockNext(
  state: CronServiceState,
  job: CronJob,
  opts: { tenure: ClockTenure; reportedNext: number | undefined; ranAtMs: number },
): void {
  if (!job.enabled) return;
  if (clockOnDaemon(job)) {
    if (opts.tenure === 'current') job.state.nextRunAtMs = opts.reportedNext;
    return;
  }
  const next = job.state.nextRunAtMs;
  if (typeof next !== 'number' || next > opts.ranAtMs) return;
  const after = computeJobNextRunAtMs(job, opts.ranAtMs + 1);
  job.state.nextRunAtMs = after;
  replayGuardOf(state).set(job.id, after ?? null);
}
