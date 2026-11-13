/**
 * Timer / execution engine — adapted from moltbot/src/cron/service/timer.ts
 *
 * Simplified for Walnut's single-process model:
 * - Uses broadcastCronNotification + runMainAgentWithPrompt instead of
 *   enqueueSystemEvent + requestHeartbeatNow.
 * - No agentId routing, no channel/provider delivery fields.
 * - Simple promise-chain locking (no store-level lock map).
 */

import type { CronJob, CronServiceState, CronEvent } from './types.js';
import { cloudModeSkipsJob, computeJobNextRunAtMs, isClockOwned, nextWakeAtMs, recomputeNextRuns, scheduleNextRunAtMs } from './jobs.js';
import { ensureLoaded, persist } from './store.js';
import { withFileLock } from '../../utils/file-lock.js';
import {
  appendAudit, auditDelivery, injectedPreview, wakeAuditEntry, TRIGGER_FIRE_LOG_MAX,
} from './trigger-audit.js';
import {
  appendRun, catchUpNote, HELD_RECHECK_MS, judgesSlots, runEntry, runFailed, runSlots, SLOT_RETRIES,
} from './run-log.js';

const MAX_TIMER_DELAY_MS = 60_000;

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of the per-provider / per-agent timeouts to prevent one stuck job
 * from wedging the entire cron lane.
 */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/**
 * The whole run's cap. An init processor's `timeoutSeconds` bounds that ACTION only
 * (executeJobCore): it used to cap the whole run too, so the Inbox Triage routine
 * (a 30 s batch action) cut its own executor's start, which may wait up to a minute
 * for room on its host (routines/run-start-deps.ts ROUTINE_WAIT_MS). The run was
 * failed with "timed out" while the start went on unowned, and Run now still read
 * `ran: true` (2026-11-10 CI). Exported for the guard test.
 */
export function jobTimeoutMs(job: Pick<CronJob, 'payload' | 'initProcessor'>): number {
  if (job.payload.kind === 'agentTurn' && typeof job.payload.timeoutSeconds === 'number') {
    return job.payload.timeoutSeconds * 1_000;
  }
  const init = initTimeoutMs(job);
  return Math.max(DEFAULT_JOB_TIMEOUT_MS, init ?? 0);
}

function initTimeoutMs(job: Pick<CronJob, 'initProcessor'>): number | undefined {
  const s = job.initProcessor?.timeoutSeconds;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s * 1_000 : undefined;
}

/** Race `work` against `ms`; the timer never outlives the race. */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Exponential backoff delays (in ms) indexed by consecutive error count.
 * After the last entry the delay stays constant.
 */
const ERROR_BACKOFF_SCHEDULE_MS = [
  30_000,         // 1st error  ->  30 s
  60_000,         // 2nd error  ->   1 min
  5 * 60_000,     // 3rd error  ->   5 min
  15 * 60_000,    // 4th error  ->  15 min
  60 * 60_000,    // 5th+ error ->  60 min
];

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}

// ── Locking ──

/**
 * Two-layer lock. The promise chain serializes async operations within this
 * process; the file lock (`${storePath}.lock`) serializes read-modify-write
 * cycles ACROSS processes. 2026-08-04 incident: an orphaned second server
 * shared cron-jobs.json with prod — each side blind-wrote its stale snapshot,
 * flapping jobs back to a due state and re-firing a daily job ~19× in a day.
 * All locked sections here are short (load + mutate + persist), so holding
 * the file lock for their duration is safe.
 */
export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const prev = state.op;
  let resolve!: () => void;
  state.op = new Promise<void>((r) => { resolve = r; });
  await prev.catch(() => {});
  try {
    return await withFileLock(state.deps.storePath, fn);
  } finally {
    resolve();
  }
}

/** Lazy accessor — tolerates states constructed without the field (tests). */
export function replayGuardOf(state: CronServiceState): Map<string, number | null> {
  if (!state.replayGuard) state.replayGuard = new Map();
  return state.replayGuard;
}

/**
 * True when this process already executed the job for the current schedule
 * slot, regardless of what the (shared, externally writable) store file says.
 * `null` guard = no future runs (finished one-shot).
 */
function replayGuardBlocks(state: CronServiceState, job: CronJob, nowMs: number): boolean {
  const guard = replayGuardOf(state).get(job.id);
  if (guard === undefined) return false;
  if (guard === null || nowMs < guard) {
    state.deps.log.warn('replay guard: job already ran this slot — skipping despite due store state', {
      jobId: job.id,
      jobName: job.name,
      guardUntilMs: guard,
      storeNextRunAtMs: job.state.nextRunAtMs,
    });
    return true;
  }
  return false;
}

// ── Event emission ──

export function emit(state: CronServiceState, evt: CronEvent): void {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore subscriber errors */
  }
}

// ── Timer management ──

export function armTimer(state: CronServiceState): void {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;

  if (!state.deps.cronEnabled) {
    state.deps.log.debug('armTimer skipped - scheduler disabled');
    return;
  }

  const nextAt = nextWakeAtMs(state);
  if (!nextAt) {
    const jobCount = state.store?.jobs.length ?? 0;
    const enabledCount = state.store?.jobs.filter((j) => j.enabled).length ?? 0;
    state.deps.log.debug('armTimer skipped - no jobs with nextRunAtMs', { jobCount, enabledCount });
    return;
  }

  const now = state.deps.nowMs();
  const delay = Math.max(nextAt - now, 0);
  // Wake at least once a minute to avoid schedule drift and recover quickly
  // when the process was paused or wall-clock time jumps.
  const clampedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

  state.timer = setTimeout(async () => {
    try {
      await onTimer(state);
    } catch (err) {
      state.deps.log.error('timer tick failed', { err: String(err) });
    }
  }, clampedDelay);

  state.deps.log.debug('timer armed', {
    nextAt,
    delayMs: clampedDelay,
    clamped: delay > MAX_TIMER_DELAY_MS,
  });
}

export function stopTimer(state: CronServiceState): void {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
}

// ── Core execution ──

/** What a dispatch observed and produced, for the wake counter + its audit line. */
export type JobRunOutcome = {
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  startedAt: number;
  endedAt: number;
  /**
   * Wake jobs: the counter value the dispatch OBSERVED. Subtracted (never
   * zeroed) so an event that arrived mid-run survives into the next batch.
   */
  wakeObserved?: number;
  /** The executor's own sentence, for the wake fire's audit row. */
  summary?: string;
  /** The text this run actually handed the executor, for the injected preview. */
  dispatched?: string;
  /** The session the run landed in, when the executor named one. */
  sessionId?: string;
  /** Run now: a person asked for this run, the schedule did not. */
  manual?: boolean;
  /** The newest slot this run stood for (run-log.ts runSlots); absent for Run now. */
  slotMs?: number;
  /** The oldest, when it stood for every slot from it to `slotMs`. */
  firstSlotMs?: number;
  /** A catch-up run made for this missed slot. */
  catchUpMs?: number;
  /** The run failed because something broke before it did its work: worth another try in its slot. */
  retryable?: boolean;
  /** The run was held behind an earlier one that has not started (that run's task): its slots stay owed. */
  heldBy?: string;
};

/**
 * Apply the result of a job execution to the job's state.
 * Handles consecutive error tracking, exponential backoff, one-shot disable,
 * the wake counter, and nextRunAtMs computation. Returns `true` if the job
 * should be deleted.
 */
export function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: JobRunOutcome,
): boolean {
  job.state.runningAtMs = undefined;
  job.state.lastRunAtMs = result.startedAt;
  job.state.lastStatus = result.status;
  job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
  job.state.lastError = result.error;
  job.updatedAtMs = result.endedAt;

  // Track consecutive errors for backoff / auto-disable.
  if (result.status === 'error') {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
  } else {
    job.state.consecutiveErrors = 0;
  }

  // Wake counter: SUBTRACT what the dispatch observed instead of zeroing it.
  // This runs AFTER the executor, so events that arrived during the run are
  // already in the counter — zeroing would silently swallow that whole batch
  // (the one subtlety this feature has). Applied for 'skipped' too, for the same
  // reason the replay guard below is: the slot was consumed either way.
  //
  // NOT applied to a run that ERRORED. The count is the record that those items
  // arrived and have not been looked at, and an error means nobody looked: the run
  // never reached a session, or the session died before reading its batch. Taking
  // the count anyway spent the batch on nothing AND left the routine below its
  // threshold, so the backoff retry arrived as "no new items" (skipWhenIdle) and
  // the clock leg stalled until the threshold filled again from scratch.
  //
  // NOT applied to a run held behind an earlier one that has not started either: nobody looked
  // at those items, and its look again must still see them (or skipWhenIdle would read the owed
  // slots as "no new items" and settle them with nothing done).
  if (job.wake) {
    const observed = result.status === 'error' || result.heldBy ? 0 : Math.max(0, Math.floor(result.wakeObserved ?? 0));
    job.state.wakeCount = Math.max(0, (job.state.wakeCount ?? 0) - observed);
    if (observed > 0 && result.status !== 'skipped') {
      // One audit row per wake fire, with the text the run injected. A 'skipped'
      // run never reached an executor, so calling that a fire would be a lie —
      // its lastStatus/lastError carry the reason instead.
      job.state.fireLog = appendAudit(
        job.state.fireLog,
        wakeAuditEntry({
          atMs: result.startedAt,
          items: observed,
          durationMs: job.state.lastDurationMs,
          ...(result.error ? { error: result.error } : {}),
          delivery: auditDelivery({
            status: result.status === 'error' ? 'error' : 'ok',
            retry: false,
            ...(result.summary ? { summary: result.summary } : {}),
            ...(result.error ? { error: result.error } : {}),
            ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          }),
          ...(result.dispatched ? { injected: injectedPreview(result.dispatched) } : {}),
        }),
        TRIGGER_FIRE_LOG_MAX,
      );
    }
  }

  recordSessionRun(job, result);
  const retryAt = slotRetryAtMs(job, result) ?? heldRecheckAtMs(job, result);
  settleOwed(job, result, retryAt);

  const shouldDelete =
    job.schedule.kind === 'at' && result.status === 'ok' && job.deleteAfterRun === true;

  // Arm the replay guard for every terminal result (including 'skipped' —
  // the slot was consumed either way). Set below once nextRunAtMs is known.
  const armGuard = (nextMs: number | undefined) => {
    replayGuardOf(state).set(job.id, typeof nextMs === 'number' ? nextMs : null);
  };

  if (!shouldDelete) {
    if (job.schedule.kind === 'at') {
      // One-shot jobs are always disabled after ANY terminal status
      // (ok, error, or skipped). This prevents tight-loop rescheduling.
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      armGuard(undefined);
      if (result.status === 'error') {
        state.deps.log.warn('disabling one-shot job after error', {
          jobId: job.id,
          jobName: job.name,
          consecutiveErrors: job.state.consecutiveErrors,
          error: result.error,
        });
      }
    } else if (retryAt !== undefined) {
      // A start that broke (no room on the host) is tried again inside its own slot: a daily
      // routine's next slot is a day away, and the 2026-11-08 reflection lost its day that way.
      // A run held behind one that has not started looks again the same way (2026-11-12).
      job.state.nextRunAtMs = retryAt;
      armGuard(retryAt);
      state.deps.log.info(result.heldBy
        ? 'routine run held behind an earlier run that has not started: looking again'
        : 'routine start failed: trying again in its slot', {
        jobId: job.id, slotMs: job.state.retrySlotMs, owedFromMs: job.state.owedFromMs,
        ...(result.heldBy ? { heldBy: result.heldBy } : { attempt: job.state.consecutiveErrors }), nextRunAtMs: retryAt,
      });
    } else if (result.status === 'error' && job.enabled) {
      // Apply exponential backoff for errored jobs to prevent retry storms.
      const backoff = errorBackoffMs(job.state.consecutiveErrors ?? 1);
      const normalNext = computeJobNextRunAtMs(job, result.endedAt);
      const backoffNext = result.endedAt + backoff;
      // Use whichever is later: the natural next run or the backoff delay.
      job.state.nextRunAtMs =
        normalNext !== undefined ? Math.max(normalNext, backoffNext) : backoffNext;
      armGuard(job.state.nextRunAtMs);
      state.deps.log.info('applying error backoff', {
        jobId: job.id,
        consecutiveErrors: job.state.consecutiveErrors,
        backoffMs: backoff,
        nextRunAtMs: job.state.nextRunAtMs,
      });
    } else if (job.enabled) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, result.endedAt);
      armGuard(job.state.nextRunAtMs);
    } else {
      job.state.nextRunAtMs = undefined;
      armGuard(undefined);
    }
  } else {
    replayGuardOf(state).delete(job.id);
  }
  recordRoutineRun(state, job, result, retryAt);

  return shouldDelete;
}

/**
 * When a failed run is tried again inside its slot (run-log.ts SLOT_RETRIES): a recurring routine
 * whose start broke before it did its work, while its tries last and the try lands before the
 * next slot. Sets or clears `retrySlotMs`; undefined = no retry.
 */
function slotRetryAtMs(job: CronJob, result: JobRunOutcome): number | undefined {
  const slot = result.slotMs;
  // Tries of this slot so far, this one included: counted per slot, so yesterday's failures
  // never use up today's tries.
  const tries = triesOfSlot(job, slot) + 1;
  // Only a routine judged slot by slot (hourly or slower): a frequent one's next slot is soon anyway.
  if (result.status !== 'error' || !result.retryable || slot === undefined || tries > SLOT_RETRIES
    || !judgesSlots(job, result.endedAt)) {
    delete job.state.retrySlotMs;
    return undefined;
  }
  const at = result.endedAt + errorBackoffMs(tries);
  const next = computeJobNextRunAtMs(job, Math.max(slot, result.endedAt) + 1);
  if (next !== undefined && at >= next) {
    delete job.state.retrySlotMs;
    return undefined;
  }
  job.state.retrySlotMs = slot;
  return at;
}

/**
 * When a run held behind an earlier one that has not started looks again (2026-11-12: Inbox
 * Triage's 16:20 run waited for a slot on a full Mac, and every run after it skipped): soon, inside
 * its slot, while the routine is judged slot by slot; at its next slot otherwise, which stands for
 * the owed ones too (run-log.ts runSlots). Sets `retrySlotMs`; undefined = no look again.
 */
function heldRecheckAtMs(job: CronJob, result: JobRunOutcome): number | undefined {
  const slot = result.slotMs;
  if (!result.heldBy || slot === undefined || !job.enabled || !judgesSlots(job, result.endedAt)) return undefined;
  const at = result.endedAt + HELD_RECHECK_MS;
  const next = computeJobNextRunAtMs(job, Math.max(slot, result.endedAt) + 1);
  if (next !== undefined && at >= next) return undefined;
  job.state.retrySlotMs = slot;
  return at;
}

/**
 * The slots still owed after this run (`owedFromMs`, run-log.ts runSlots). A held run, or a failed
 * start tried again, keeps every slot it stood for owed: the next run stands for them. Any other
 * scheduled run settled them, good or failed (a failure is then each slot's missed run, with its
 * error). A run that stood for no slot (Run now, a trigger) leaves them as they are.
 */
function settleOwed(job: CronJob, result: JobRunOutcome, retryAt: number | undefined): void {
  if (result.slotMs === undefined) return;
  const owes = (result.heldBy && judgesSlots(job, result.endedAt)) || retryAt !== undefined;
  if (!owes || !job.enabled) {
    delete job.state.owedFromMs;
    return;
  }
  // Only the slots this run stood for. The run it waits for owes its own slot only if it is
  // recorded failed while this backlog lasts (ops.ts recordRunStartFailure); one that starts
  // did its work, and the next run must not claim it did not.
  const first = result.firstSlotMs ?? result.slotMs;
  const prior = job.state.owedFromMs;
  job.state.owedFromMs = typeof prior === 'number' ? Math.min(prior, first) : first;
}

/** Runs already recorded for `slot` that tried to do its work (a held run did not try). */
function triesOfSlot(job: CronJob, slot: number | undefined): number {
  if (slot === undefined) return 0;
  return (job.state.runLog ?? []).filter((e) => e.slotMs === slot && !e.heldBy).length;
}

/** The run's row in the routine's history, and its error in the log (run-log.ts). */
function recordRoutineRun(state: CronServiceState, job: CronJob, result: JobRunOutcome, retryAt: number | undefined): void {
  if (job.check) return;
  // A try again of a slot whose start had failed is the slot's second (third...) row.
  const attempt = result.heldBy ? 1 : triesOfSlot(job, result.slotMs) + 1;
  const entry = runEntry({
    atMs: result.startedAt,
    durationMs: result.endedAt - result.startedAt,
    status: result.status,
    ...(result.slotMs !== undefined ? { slotMs: result.slotMs } : {}),
    ...(result.firstSlotMs !== undefined ? { firstSlotMs: result.firstSlotMs } : {}),
    ...(result.heldBy ? { heldBy: result.heldBy } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(result.manual ? { manual: true } : {}),
    ...(result.catchUpMs !== undefined ? { catchUpMs: result.catchUpMs } : {}),
    ...(attempt > 1 ? { attempt } : {}),
    // A held run's look again is not a retry of a failure: owedFromMs keeps its slots.
    ...(retryAt !== undefined && !result.heldBy ? { willRetryAtMs: retryAt } : {}),
  });
  job.state.runLog = appendRun(job.state.runLog, entry, (s) => scheduleNextRunAtMs(job, s + 1));
  // The history begins with this run's slots, so they are judged too.
  job.state.runLogSinceMs ??= Math.min(result.firstSlotMs ?? result.slotMs ?? result.startedAt, result.startedAt);
  if (runFailed(entry)) {
    state.deps.log.warn('routine run failed', {
      jobId: job.id, jobName: job.name, status: result.status, error: result.error,
      slotMs: result.slotMs, durationMs: entry.durationMs, ...(retryAt !== undefined ? { retryAtMs: retryAt } : {}),
    });
  }
}

/**
 * A routine that runs in a task's session keeps one History row per run, the
 * row a host's daemon leaves when the clock is there (clock-routine-v1): the
 * task's badge reads the same list wherever the clock is, Run now included.
 */
function recordSessionRun(job: CronJob, result: JobRunOutcome): void {
  if (job.executor?.type !== 'session' || job.wake || job.check || result.status === 'skipped') return;
  job.state.fireLog = appendAudit(
    job.state.fireLog,
    {
      ...wakeAuditEntry({
        atMs: result.startedAt,
        items: 0,
        durationMs: job.state.lastDurationMs,
        ...(result.error ? { error: result.error } : {}),
        delivery: auditDelivery({
          status: result.status === 'error' ? 'error' : 'ok',
          retry: false,
          ...(result.summary ? { summary: result.summary } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        }),
        ...(result.dispatched ? { injected: injectedPreview(result.dispatched) } : {}),
      }),
      ...(result.manual ? { manual: true as const } : {}),
    },
    TRIGGER_FIRE_LOG_MAX,
  );
  job.state.fireCount = (job.state.fireCount ?? job.state.lastFireSeq ?? 0) + 1;
}

/**
 * Dispatch a single job to the appropriate execution target.
 *
 * - **main** session target: broadcast a cron notification, then optionally
 *   wake the main agent immediately (wakeMode === 'now').
 * - **isolated** session target: run an isolated agent job, then optionally
 *   announce the result back to the main session.
 */
/** How one execution ended, as executeJobCore reports it. */
export interface JobExecution {
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  summary?: string;
  /** The text handed to the executor, for the wake fire's audit preview. */
  dispatched?: string;
  sessionId?: string;
  /** The executor broke rather than declined (registry.ts runExecutor). */
  retryable?: boolean;
  /** The init processor declined only because an earlier run has not started (its task). */
  heldBy?: string;
}

/** A catch-up run: the slot it stands for, or every slot from `fromMs` to `toMs` (run-log.ts). */
type CatchUp = { fromMs: number; toMs?: number };

async function executeJobCore(
  state: CronServiceState,
  job: CronJob,
  /** A human pressed Run now. The idle gate is a cadence rule, and they outrank it. */
  forced = false,
  /** A catch-up run: the executor is told which runs it stands for (run-log.ts). */
  catchUp?: CatchUp,
): Promise<JobExecution> {
  // ── Wake: nothing new, nothing to do ──
  // Here rather than in findDueJobs: a job filtered out THERE keeps a past-due
  // nextRunAtMs and is re-evaluated on every tick forever. Reaching this point
  // means the slot is spent — applyJobResult computes the next run for a
  // 'skipped' result and arms the replay guard. Before the init processor too:
  // an idle slot must cost neither an action nor a model call.
  //
  // `forced` is exempt. Run now is a person asking to see this routine work, and
  // answering it with a silent 'skipped' (no reason anywhere on the card, because a
  // skip writes no lastError and no fire row) reads as the button being broken.
  if (!forced && job.wake?.skipWhenIdle && (job.state.wakeCount ?? 0) === 0) {
    return { status: 'skipped', summary: 'no new items' };
  }

  // ── Init processor (optional pre-step action) ──
  let initOutput: string | undefined;
  if (job.initProcessor) {
    if (!state.deps.runAction) {
      return { status: 'skipped', error: 'no action runner configured' };
    }
    const actionTimeout = initTimeoutMs(job);
    const actionRun = state.deps.runAction(
      job.initProcessor.actionId,
      job.initProcessor.params ?? {},
    );
    let actionResult: Awaited<typeof actionRun>;
    try {
      actionResult = actionTimeout === undefined
        ? await actionRun
        : await withTimeout(actionRun, actionTimeout,
          `cron: init processor '${job.initProcessor.actionId}' timed out after ${actionTimeout / 1_000}s`);
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    if (actionResult.status === 'error') {
      return { status: 'error', error: actionResult.error };
    }
    // The action DECLINED this fire (see CronServiceDeps.runAction). Returning
    // before the executor is the whole point: an init processor is the only place
    // that can refuse a run before a session, a task or a model call exists.
    // `heldBy`: declined only because an earlier run has not started; its slots stay owed.
    if (actionResult.status === 'skipped') {
      const heldBy = typeof actionResult.heldBy === 'string' && actionResult.heldBy.trim() ? actionResult.heldBy.trim() : undefined;
      return { status: 'skipped', summary: actionResult.summary, ...(heldBy ? { heldBy } : {}) };
    }

    // targetAgent used to pipe the action result into a config-defined action
    // agent that ran inside the server. Recorded as a failed run rather than
    // silently ignored: the field is still in stored jobs, and a job that looks
    // like it ran while doing nothing is worse than one that says why it didn't.
    if (job.initProcessor.targetAgent) {
      return { status: 'error', error: 'action agents were removed; use the claude-code executor' };
    }

    // invokeAgent=false → return action result directly, done
    if (job.initProcessor.invokeAgent === false) {
      return {
        status: actionResult.status,
        summary: actionResult.summary,
        error: actionResult.error,
      };
    }

    // invokeAgent=true (default) → inject output into payload, continue normal flow
    initOutput = actionResult.summary
      || (actionResult.data ? JSON.stringify(actionResult.data) : undefined)
      || `[action '${job.initProcessor.actionId}' completed with no output]`;
  }
  // A catch-up run says which run it is, ahead of everything the session reads.
  const lead = catchUp ? `${catchUpNote(catchUp.fromMs, state.deps.nowMs(), catchUp.toMs)}\n\n` : '';

  // ── Routines layer: non-legacy executors (e.g. claude-code) dispatch via
  // runExecutor. main-agent/walnut-agent executors fall through to the legacy
  // paths below, which carry the notification/announce plumbing.
  const executor = job.executor;
  const isLegacyExecutor =
    !executor || executor.type === 'main-agent' || executor.type === 'walnut-agent';
  if (!isLegacyExecutor) {
    if (!state.deps.runExecutor) {
      return { status: 'skipped', error: `executor '${executor.type}' requires runExecutor dependency` };
    }
    const instructions = typeof executor.config?.instructions === 'string'
      ? executor.config.instructions
      : '';
    if (!instructions.trim() && !initOutput) {
      return { status: 'skipped', error: `executor '${executor.type}' requires non-empty instructions` };
    }
    const message = lead + (initOutput ? `${initOutput}\n\n${instructions}` : instructions);
    const ctx = {
      ...(catchUp ? { runForMs: catchUp.fromMs } : {}),
      ...(initOutput ? { parts: { lead, initOutput, instructions } } : {}),
    };
    const res = await state.deps.runExecutor(job, executor, message, Object.keys(ctx).length > 0 ? ctx : undefined);
    // `delivered.text` is the exact text a session received when the executor
    // knows it (the session executor does); otherwise the message we dispatched
    // is the honest answer to "what did this run inject".
    return {
      ...res,
      dispatched: res.delivered?.text ?? message,
      ...(res.delivered?.sessionId ? { sessionId: res.delivered.sessionId } : {}),
    };
  }

  if (job.sessionTarget === 'main') {
    if (job.payload.kind !== 'systemEvent' || !job.payload.text.trim()) {
      return {
        status: 'skipped',
        error: 'main job requires non-empty systemEvent text',
      };
    }

    const text = lead + (initOutput ? `${initOutput}\n\n${job.payload.text}` : job.payload.text);
    // The answer comes in the Main task's session, never in the home chat.
    await state.deps.broadcastCronNotification(text, job.name, { agentWillRespond: false });

    if (job.wakeMode === 'now') {
      try {
        await state.deps.runMainAgentWithPrompt(text, job.name, job);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        state.deps.log.warn('runMainAgentWithPrompt failed', {
          jobId: job.id,
          err: errMsg,
        });
        // Return error status so backoff engages. The notification was already
        // broadcast, but the agent failed — callers should back off and retry.
        return { status: 'error', error: errMsg, summary: text, dispatched: text };
      }
    } else {
      // Queue for agent's next interaction (next-cycle)
      state.deps.queueCronNotificationForAgent?.(text, job.name);
    }

    return { status: 'ok', summary: text, dispatched: text };
  }

  // Isolated session target
  if (job.payload.kind !== 'agentTurn') {
    return { status: 'skipped', error: 'isolated job requires payload.kind=agentTurn' };
  }

  const message = lead + (initOutput ? `${initOutput}\n\n${job.payload.message}` : job.payload.message);
  const res = await state.deps.runIsolatedAgentJob({
    job,
    message,
  });

  // Post a short summary back to the main session if delivery mode is 'announce'.
  const summaryText = res.summary?.trim();
  const deliveryMode = job.delivery?.mode ?? 'none';

  if (summaryText && deliveryMode === 'announce') {
    const prefix = 'Cron';
    const label =
      res.status === 'error' ? `${prefix} (error): ${summaryText}` : `${prefix}: ${summaryText}`;
    await state.deps.broadcastCronNotification(label, job.name, { agentWillRespond: false });

    if (job.wakeMode === 'now') {
      try {
        await state.deps.runMainAgentWithPrompt(label, job.name, job);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        state.deps.log.warn('runMainAgentWithPrompt failed (announce)', {
          jobId: job.id,
          err: errMsg,
        });
        // Propagate error so backoff engages (notification already broadcast)
        return { status: 'error', error: errMsg, summary: res.summary, dispatched: message };
      }
    }
  }

  return {
    status: res.status,
    error: res.error,
    summary: res.summary,
    dispatched: message,
  };
}

/**
 * THE entry every server-clock run takes: the timer's tick, the boot catch-up (`start`) and a
 * Run (`run`, due or forced). Decides the slots a scheduled run stands for (run-log.ts runSlots),
 * updates state, emits events, handles the timeout and applies the result to a fresh load. No
 * other path calls executeJobCore or records a scheduled run (scheduled-run-entry-guard.test.ts).
 */
export async function executeJob(
  state: CronServiceState,
  job: CronJob,
  /** `catchUpMs`: a forced run made for this missed slot (run-log.ts). */
  options: { forced?: boolean; catchUpMs?: number } = {},
): Promise<JobExecution> {
  if (!job.state) {
    job.state = {};
  }
  const startedAt = state.deps.nowMs();
  // A run the schedule asked for (a tick, a boot catch-up, a due run) stands for its slots, every
  // one that came due since and every one still owed (run-log.ts runSlots); Run now for none.
  const slots = options.forced ? undefined : runSlots(job, startedAt);
  if (slots === null) return await settleSetAside(state, job, startedAt);
  const catchUp: CatchUp | undefined = options.catchUpMs !== undefined
    ? { fromMs: options.catchUpMs }
    : slots?.late ? { fromMs: slots.firstSlotMs ?? slots.slotMs, toMs: slots.slotMs } : undefined;
  job.state.runningAtMs = startedAt;
  job.state.lastError = undefined;
  // Read at DISPATCH, before the executor runs: this is the batch this run owns.
  // Anything counted after this point belongs to the next run (see applyJobResult).
  const wakeObserved = job.wake ? job.state.wakeCount ?? 0 : 0;
  emit(state, { jobId: job.id, action: 'started', runAtMs: startedAt });

  // Outer timeout wraps the entire job (init processor + payload execution);
  // the init processor's own timeout bounds only the action (jobTimeoutMs).
  let coreResult: JobExecution;

  try {
    coreResult = await withTimeout(
      executeJobCore(state, job, options.forced === true, catchUp),
      jobTimeoutMs(job),
      'cron: job execution timed out',
    );
  } catch (err) {
    coreResult = { status: 'error', error: String(err) };
  }

  const endedAt = state.deps.nowMs();

  // Apply the result under the lock to a FRESH load: execution can take
  // minutes, during which another process may have rewritten the store.
  // Applying to the pre-execution snapshot and blind-persisting it would
  // revert those external writes (2026-08-04 re-fire storm).
  await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const target = state.store?.jobs.find((j) => j.id === job.id) ?? job;
    const shouldDelete = applyJobResult(state, target, {
      status: coreResult.status,
      error: coreResult.error,
      startedAt,
      endedAt,
      wakeObserved,
      summary: coreResult.summary,
      dispatched: coreResult.dispatched,
      sessionId: coreResult.sessionId,
      ...(options.forced ? { manual: true } : {}),
      ...(slots ? { slotMs: slots.slotMs } : {}),
      ...(slots?.firstSlotMs !== undefined ? { firstSlotMs: slots.firstSlotMs } : {}),
      ...(options.catchUpMs !== undefined ? { catchUpMs: options.catchUpMs } : {}),
      ...(coreResult.retryable ? { retryable: true } : {}),
      ...(coreResult.heldBy ? { heldBy: coreResult.heldBy } : {}),
    });

    emit(state, {
      jobId: target.id,
      action: 'finished',
      status: coreResult.status,
      error: coreResult.error,
      summary: coreResult.summary,
      runAtMs: startedAt,
      durationMs: target.state.lastDurationMs,
      nextRunAtMs: target.state.nextRunAtMs,
    });

    if (shouldDelete && state.store) {
      state.store.jobs = state.store.jobs.filter((j) => j.id !== target.id);
      emit(state, { jobId: target.id, action: 'removed' });
    }
    await persist(state);
  });
  return coreResult;
}

/**
 * Every slot a due run would stand for was set aside (Dismiss): nothing runs and no row is
 * written; the routine moves on to its next slot, under the lock, to a fresh load.
 */
async function settleSetAside(state: CronServiceState, job: CronJob, nowMs: number): Promise<JobExecution> {
  const summary = 'every slot this run stood for was set aside';
  await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const target = state.store?.jobs.find((j) => j.id === job.id) ?? job;
    target.state.runningAtMs = undefined;
    delete target.state.retrySlotMs;
    delete target.state.owedFromMs;
    target.state.nextRunAtMs = computeJobNextRunAtMs(target, nowMs + 1);
    replayGuardOf(state).set(target.id, target.state.nextRunAtMs ?? null);
    state.deps.log.info('routine run not made: its slots were set aside', { jobId: target.id, nextRunAtMs: target.state.nextRunAtMs });
    // 'finished', not 'updated': the definition did not change.
    emit(state, { jobId: target.id, action: 'finished', status: 'skipped', summary, runAtMs: nowMs, nextRunAtMs: target.state.nextRunAtMs });
    await persist(state);
  });
  return { status: 'skipped', summary };
}

// ── Timer tick ──

/**
 * The jobs whose due slot this server's timer runs now: at a tick, and at boot for the slots that
 * came due while the server was down (one run each, standing for all of them: run-log.ts
 * runSlots). Returns the list without executing: callers run it outside the lock, so an agent
 * that calls cron tools during a run cannot deadlock.
 */
export function findDueJobs(state: CronServiceState): CronJob[] {
  if (!state.store) return [];
  const now = state.deps.nowMs();
  return state.store.jobs.filter((j) => {
    if (!j.state) j.state = {};
    if (!j.enabled) return false;
    // A trigger is the daemon's job to run: nextRunAtMs here is only its last
    // report, and running the executor from the server would deliver a fire
    // nothing decided (no check output, no dedup, no seen set). It missed nothing
    // while the server was down either (its daemon kept polling).
    if (j.check) return false;
    // A clock a host's daemon holds: that daemon runs its slots (clock-routine-v1),
    // and catches up there, by the same one-run rule.
    if (isClockOwned(j)) return false;
    if (typeof j.state.runningAtMs === 'number') return false;
    if (j.schedule.kind === 'at' && j.state.lastStatus === 'ok') return false;
    const next = j.state.nextRunAtMs;
    if (!(typeof next === 'number' && now >= next)) return false;
    if (replayGuardBlocks(state, j, now)) return false;
    if (cloudModeSkipsJob(j)) {
      state.deps.log.info('replica: skipping non-allowlisted cron job', { jobId: j.id, jobName: j.name });
      return false;
    }
    return true;
  });
}

/**
 * Main timer tick. Reload store, find due jobs, execute them sequentially,
 * apply results, persist, and re-arm the timer.
 */
export async function onTimer(state: CronServiceState): Promise<void> {
  if (state.running) return;
  state.running = true;

  try {
    // Phase 1: find due jobs under lock, mark them running
    const dueJobs = await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      const due = findDueJobs(state);

      if (due.length === 0) {
        const changed = recomputeNextRuns(state);
        if (changed) await persist(state);
        return [];
      }

      const now = state.deps.nowMs();
      for (const job of due) {
        job.state.runningAtMs = now;
        job.state.lastError = undefined;
      }
      await persist(state);

      return due;
    });

    // Phase 2: run each due job, one by one, outside the lock, through the one entry every
    // scheduled run takes (executeJob): the slots it stands for (run-log.ts runSlots), its
    // timeout, its result applied to a fresh load. A new scheduler path calls executeJob too
    // (tests/core/cron/scheduled-run-entry-guard.test.ts).
    for (const job of dueJobs) {
      try {
        await executeJob(state, job);
      } catch (err) {
        state.deps.log.warn(`job failed: ${String(err)}`, { jobId: job.id, jobName: job.name });
      }
    }

    // Phase 3: the next runs of every job, under the lock, to a fresh load.
    if (dueJobs.length > 0) {
      await locked(state, async () => {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
        recomputeNextRuns(state);
        await persist(state);
      });
    }
  } finally {
    state.running = false;
    armTimer(state);
  }
}
