/**
 * A scheduled run whose work went out is a run that happened, whatever came after.
 *
 * The record of a run (applyJobResult) used to be written only when its executor returned. A run
 * whose durable work was already done (its message stored in a session's queue, its session
 * started) and that never returned, or returned late, was then either run again or called failed:
 *   - 2026-11-21, "Operations VP daily reflection": the message was stored during a short macOS
 *     DarkWake, the Mac slept, the server was stopped before the record was written, and the
 *     restart ran the slot again, sending a second copy.
 *   - the same night, "Personal VP daily reflection": the process slept across the run, its
 *     timeout fired on wake, and the run was recorded "timed out" (and later a missed run)
 *     although its message had gone out.
 *
 * So an executor calls `markSent` the moment its work is durable (ExecutorRunContext.markSent),
 * and timer.ts executeJob writes `state.sentRun` at once, under the store's lock. Then:
 *   - a run that throws or times out after the mark is recorded ok, its error kept as a note
 *     (asSentResult);
 *   - a mark that lands after the run was already recorded failed corrects that record
 *     (amendAsSent);
 *   - a mark with no run in flight (the process that made it is gone) is recorded as the run at the
 *     next boot or tick (unrecordedSentRun, sentRunOutcome), and the slot is never run again.
 * A run with no mark did nothing durable, and runs again as before.
 *
 * The mark is a write of its own, so a process can stop between the work and its mark. That
 * window is closed only for a session executor's send into an existing session: its row has one id
 * per routine and slot (routine-run-ids.ts), so a rerun collapses onto the row still queued, and a
 * resend of a row already delivered keeps its line id, which the CLI skips. It stays open for a
 * launch: a claude-code or walnut-agent start (RoutineRunStarter keys a run by its dispatch time,
 * which a rerun does not share) and the session executor's start of a new session on its task. A
 * stop in that window starts the run again; a stop after the mark never does.
 */
import type { CronJob, SentRun } from './types.js';
import type { JobExecution, JobRunOutcome } from './timer.js';
import { computeJobNextRunAtMs } from './jobs.js';

/** The job's sent mark when its run was never recorded; a stale one (an older server recorded the run) is dropped. */
export function unrecordedSentRun(job: CronJob): SentRun | undefined {
  const sent = job.state?.sentRun;
  if (!sent) return undefined;
  const last = job.state.lastRunAtMs;
  if (typeof last === 'number' && last >= sent.startedAtMs) {
    delete job.state.sentRun;
    return undefined;
  }
  return sent;
}

/**
 * The record of a run that sent and was then cut off. It ends when its work went out, so the next
 * slot is the one after that (and runs as a catch-up when it is already due).
 */
export function sentRunOutcome(sent: SentRun): JobRunOutcome {
  return {
    status: 'ok',
    startedAt: sent.startedAtMs,
    endedAt: Math.max(sent.atMs, sent.startedAtMs),
    summary: `${sentence(sent.summary ?? 'Sent')} Recorded after a restart: the run had sent before the server stopped.`,
    ...(sent.sessionId ? { sessionId: sent.sessionId } : {}),
    ...(sent.wakeObserved !== undefined ? { wakeObserved: sent.wakeObserved } : {}),
    ...(sent.slotMs !== undefined ? { slotMs: sent.slotMs } : {}),
    ...(sent.firstSlotMs !== undefined ? { firstSlotMs: sent.firstSlotMs } : {}),
    ...(sent.catchUpMs !== undefined ? { catchUpMs: sent.catchUpMs } : {}),
    ...(sent.manual ? { manual: true } : {}),
  };
}

/** A run that failed after its work went out did its work: ok, with what went wrong as a note. */
export function asSentResult(core: JobExecution, sent: SentRun | undefined): JobExecution {
  if (!sent) return core;
  const sessionId = core.sessionId ?? sent.sessionId;
  if (core.status !== 'error') return { ...core, ...(sessionId ? { sessionId } : {}) };
  const { retryable: _r, heldBy: _h, error, ...rest } = core;
  return {
    ...rest,
    status: 'ok',
    summary: `${sentence(sent.summary ?? core.summary ?? 'Sent')} The run then ended with: ${error ?? 'an error'}`,
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * The run started at `sent.startedAtMs` was recorded failed (its timeout fired first, after a
 * sleep) and its work went out after all: the record says ok, the slot is covered, no backoff and
 * no retry. True when the job changed.
 */
export function amendAsSent(job: CronJob, sent: SentRun): boolean {
  const s = job.state;
  if (s.lastRunAtMs !== sent.startedAtMs || s.lastStatus !== 'error') return false;
  const note = s.lastError;
  s.lastStatus = 'ok';
  s.lastError = undefined;
  s.consecutiveErrors = 0;
  const summary = `${sentence(sent.summary ?? 'Sent')} The run was first recorded failed (${note ?? 'an error'}), then its work went out.`;
  const row = s.runLog?.find((e) => e.atMs === sent.startedAtMs);
  if (row) {
    row.status = 'ok';
    delete row.error;
    delete row.willRetryAtMs;
    row.summary = summary;
    if (sent.sessionId) row.sessionId = sent.sessionId;
  }
  const fire = s.fireLog?.find((e) => e.atMs === sent.startedAtMs);
  if (fire) {
    delete fire.error;
    if (fire.delivery) {
      fire.delivery = { ...fire.delivery, status: 'ok', summary };
      delete fire.delivery.error;
      if (sent.sessionId) fire.delivery.sessionId = sent.sessionId;
    }
  }
  // The failure kept its batch (applyJobResult): the run that did its work takes it now.
  if (job.wake && sent.wakeObserved) s.wakeCount = Math.max(0, (s.wakeCount ?? 0) - sent.wakeObserved);
  // A retry inside the slot, or the backoff, was for the failure: the next run is the next slot.
  if (s.retrySlotMs !== undefined && s.retrySlotMs === sent.slotMs) delete s.retrySlotMs;
  delete s.owedFromMs;
  if (job.schedule.kind !== 'at' && job.enabled) s.nextRunAtMs = computeJobNextRunAtMs(job, Math.max(sent.atMs, sent.startedAtMs));
  return true;
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
