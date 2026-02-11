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
import { computeJobNextRunAtMs, nextWakeAtMs, recomputeNextRuns } from './jobs.js';
import { ensureLoaded, persist } from './store.js';

const MAX_TIMER_DELAY_MS = 60_000;

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of the per-provider / per-agent timeouts to prevent one stuck job
 * from wedging the entire cron lane.
 */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

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
 * Simple promise-chain lock. Serializes all mutating operations on the
 * cron state so that concurrent timer ticks and API calls don't race.
 */
export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const prev = state.op;
  let resolve!: () => void;
  state.op = new Promise<void>((r) => { resolve = r; });
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    resolve();
  }
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

/**
 * Apply the result of a job execution to the job's state.
 * Handles consecutive error tracking, exponential backoff, one-shot disable,
 * and nextRunAtMs computation. Returns `true` if the job should be deleted.
 */
export function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: 'ok' | 'error' | 'skipped';
    error?: string;
    startedAt: number;
    endedAt: number;
  },
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

  const shouldDelete =
    job.schedule.kind === 'at' && result.status === 'ok' && job.deleteAfterRun === true;

  if (!shouldDelete) {
    if (job.schedule.kind === 'at') {
      // One-shot jobs are always disabled after ANY terminal status
      // (ok, error, or skipped). This prevents tight-loop rescheduling.
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      if (result.status === 'error') {
        state.deps.log.warn('disabling one-shot job after error', {
          jobId: job.id,
          jobName: job.name,
          consecutiveErrors: job.state.consecutiveErrors,
          error: result.error,
        });
      }
    } else if (result.status === 'error' && job.enabled) {
      // Apply exponential backoff for errored jobs to prevent retry storms.
      const backoff = errorBackoffMs(job.state.consecutiveErrors ?? 1);
      const normalNext = computeJobNextRunAtMs(job, result.endedAt);
      const backoffNext = result.endedAt + backoff;
      // Use whichever is later: the natural next run or the backoff delay.
      job.state.nextRunAtMs =
        normalNext !== undefined ? Math.max(normalNext, backoffNext) : backoffNext;
      state.deps.log.info('applying error backoff', {
        jobId: job.id,
        consecutiveErrors: job.state.consecutiveErrors,
        backoffMs: backoff,
        nextRunAtMs: job.state.nextRunAtMs,
      });
    } else if (job.enabled) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, result.endedAt);
    } else {
      job.state.nextRunAtMs = undefined;
    }
  }

  return shouldDelete;
}

/**
 * Dispatch a single job to the appropriate execution target.
 *
 * - **main** session target: broadcast a cron notification, then optionally
 *   wake the main agent immediately (wakeMode === 'now').
 * - **isolated** session target: run an isolated agent job, then optionally
 *   announce the result back to the main session.
 */
async function executeJobCore(
  state: CronServiceState,
  job: CronJob,
): Promise<{
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  summary?: string;
}> {
  // ── Init processor (optional pre-step action) ──
  let initOutput: string | undefined;
  if (job.initProcessor) {
    if (!state.deps.runAction) {
      return { status: 'skipped', error: 'no action runner configured' };
    }
    const actionResult = await state.deps.runAction(
      job.initProcessor.actionId,
      job.initProcessor.params ?? {},
    );
    if (actionResult.status === 'error') {
      return { status: 'error', error: actionResult.error };
    }

    // targetAgent set → pipe directly to subagent (takes precedence over invokeAgent)
    if (job.initProcessor.targetAgent) {
      if (!state.deps.runActionWithAgent) {
        return { status: 'error', error: `targetAgent '${job.initProcessor.targetAgent}' requires runActionWithAgent dependency` };
      }
      return await state.deps.runActionWithAgent(
        actionResult,
        job.initProcessor.targetAgent,
        job.initProcessor.targetAgentModel,
      );
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

  if (job.sessionTarget === 'main') {
    if (job.payload.kind !== 'systemEvent' || !job.payload.text.trim()) {
      return {
        status: 'skipped',
        error: 'main job requires non-empty systemEvent text',
      };
    }

    const text = initOutput ? `${initOutput}\n\n${job.payload.text}` : job.payload.text;
    await state.deps.broadcastCronNotification(text, job.name, { agentWillRespond: job.wakeMode === 'now' });

    if (job.wakeMode === 'now') {
      try {
        await state.deps.runMainAgentWithPrompt(text, job.name);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        state.deps.log.warn('runMainAgentWithPrompt failed', {
          jobId: job.id,
          err: errMsg,
        });
        // Return error status so backoff engages. The notification was already
        // broadcast, but the agent failed — callers should back off and retry.
        return { status: 'error', error: errMsg, summary: text };
      }
    } else {
      // Queue for agent's next interaction (next-cycle)
      state.deps.queueCronNotificationForAgent?.(text, job.name);
    }

    return { status: 'ok', summary: text };
  }

  // Isolated session target
  if (job.payload.kind !== 'agentTurn') {
    return { status: 'skipped', error: 'isolated job requires payload.kind=agentTurn' };
  }

  const message = initOutput ? `${initOutput}\n\n${job.payload.message}` : job.payload.message;
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
    await state.deps.broadcastCronNotification(label, job.name, { agentWillRespond: job.wakeMode === 'now' });

    if (job.wakeMode === 'now') {
      try {
        await state.deps.runMainAgentWithPrompt(label, job.name);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        state.deps.log.warn('runMainAgentWithPrompt failed (announce)', {
          jobId: job.id,
          err: errMsg,
        });
        // Propagate error so backoff engages (notification already broadcast)
        return { status: 'error', error: errMsg, summary: res.summary };
      }
    }
  }

  return {
    status: res.status,
    error: res.error,
    summary: res.summary,
  };
}

/**
 * Full execution wrapper for a single job. Updates state, emits events,
 * handles timeout, and applies result. Used by `run` command and `start` (missed jobs).
 */
export async function executeJob(
  state: CronServiceState,
  job: CronJob,
): Promise<void> {
  if (!job.state) {
    job.state = {};
  }
  const startedAt = state.deps.nowMs();
  job.state.runningAtMs = startedAt;
  job.state.lastError = undefined;
  emit(state, { jobId: job.id, action: 'started', runAtMs: startedAt });

  // Outer timeout wraps the entire job (init processor + payload execution).
  // Priority: payload.timeoutSeconds > initProcessor.timeoutSeconds > DEFAULT.
  const payloadTimeout = job.payload.kind === 'agentTurn' && typeof job.payload.timeoutSeconds === 'number'
    ? job.payload.timeoutSeconds * 1_000
    : undefined;
  const initTimeout = typeof job.initProcessor?.timeoutSeconds === 'number'
    ? job.initProcessor.timeoutSeconds * 1_000
    : undefined;
  const jobTimeoutMs = payloadTimeout ?? initTimeout ?? DEFAULT_JOB_TIMEOUT_MS;

  let coreResult: {
    status: 'ok' | 'error' | 'skipped';
    error?: string;
    summary?: string;
  };

  try {
    let timeoutId: ReturnType<typeof setTimeout>;
    coreResult = await Promise.race([
      executeJobCore(state, job),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('cron: job execution timed out')),
          jobTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timeoutId!));
  } catch (err) {
    coreResult = { status: 'error', error: String(err) };
  }

  const endedAt = state.deps.nowMs();
  const shouldDelete = applyJobResult(state, job, {
    status: coreResult.status,
    error: coreResult.error,
    startedAt,
    endedAt,
  });

  emit(state, {
    jobId: job.id,
    action: 'finished',
    status: coreResult.status,
    error: coreResult.error,
    summary: coreResult.summary,
    runAtMs: startedAt,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
  });

  if (shouldDelete && state.store) {
    state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
    emit(state, { jobId: job.id, action: 'removed' });
  }
}

// ── Timer tick ──

function findDueJobs(state: CronServiceState): CronJob[] {
  if (!state.store) return [];
  const now = state.deps.nowMs();
  return state.store.jobs.filter((j) => {
    if (!j.state) j.state = {};
    if (!j.enabled) return false;
    if (typeof j.state.runningAtMs === 'number') return false;
    const next = j.state.nextRunAtMs;
    return typeof next === 'number' && now >= next;
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

      return due.map((j) => ({ id: j.id, job: j }));
    });

    // Phase 2: execute each due job sequentially (outside the lock)
    const results: Array<{
      jobId: string;
      status: 'ok' | 'error' | 'skipped';
      error?: string;
      summary?: string;
      startedAt: number;
      endedAt: number;
    }> = [];

    for (const { id, job } of dueJobs) {
      const startedAt = state.deps.nowMs();
      job.state.runningAtMs = startedAt;
      emit(state, { jobId: job.id, action: 'started', runAtMs: startedAt });

      const payloadTimeout2 = job.payload.kind === 'agentTurn' && typeof job.payload.timeoutSeconds === 'number'
        ? job.payload.timeoutSeconds * 1_000
        : undefined;
      const initTimeout2 = typeof job.initProcessor?.timeoutSeconds === 'number'
        ? job.initProcessor.timeoutSeconds * 1_000
        : undefined;
      const jobTimeoutMs = payloadTimeout2 ?? initTimeout2 ?? DEFAULT_JOB_TIMEOUT_MS;

      try {
        let timeoutId: ReturnType<typeof setTimeout>;
        const result = await Promise.race([
          executeJobCore(state, job),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('cron: job execution timed out')),
              jobTimeoutMs,
            );
          }),
        ]).finally(() => clearTimeout(timeoutId!));
        results.push({ jobId: id, ...result, startedAt, endedAt: state.deps.nowMs() });
      } catch (err) {
        state.deps.log.warn(`job failed: ${String(err)}`, {
          jobId: id,
          jobName: job.name,
          timeoutMs: jobTimeoutMs,
        });
        results.push({
          jobId: id,
          status: 'error',
          error: String(err),
          startedAt,
          endedAt: state.deps.nowMs(),
        });
      }
    }

    // Phase 3: apply results under lock, persist, emit events
    if (results.length > 0) {
      await locked(state, async () => {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });

        for (const result of results) {
          const job = state.store?.jobs.find((j) => j.id === result.jobId);
          if (!job) continue;

          const shouldDelete = applyJobResult(state, job, {
            status: result.status,
            error: result.error,
            startedAt: result.startedAt,
            endedAt: result.endedAt,
          });

          emit(state, {
            jobId: job.id,
            action: 'finished',
            status: result.status,
            error: result.error,
            summary: result.summary,
            runAtMs: result.startedAt,
            durationMs: job.state.lastDurationMs,
            nextRunAtMs: job.state.nextRunAtMs,
          });

          if (shouldDelete && state.store) {
            state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
            emit(state, { jobId: job.id, action: 'removed' });
          }
        }

        recomputeNextRuns(state);
        await persist(state);
      });
    }
  } finally {
    state.running = false;
    armTimer(state);
  }
}

// ── Missed jobs (on startup) ──

/**
 * Find jobs whose nextRunAtMs is in the past. Returns the list without
 * executing them — callers must run execution outside the lock to avoid
 * deadlocks when the agent calls cron tools during job execution.
 */
export function findMissedJobs(state: CronServiceState): CronJob[] {
  if (!state.store) return [];

  const now = state.deps.nowMs();
  return state.store.jobs.filter((j) => {
    if (!j.state) j.state = {};
    if (!j.enabled) return false;
    if (typeof j.state.runningAtMs === 'number') return false;
    if (j.schedule.kind === 'at' && j.state.lastStatus === 'ok') return false;
    const next = j.state.nextRunAtMs;
    return typeof next === 'number' && now >= next;
  });
}
