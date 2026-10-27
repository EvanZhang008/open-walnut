/**
 * Public API operations — adapted from moltbot/src/cron/service/ops.ts
 *
 * Each function acquires the lock, loads the store, performs its operation,
 * persists, re-arms the timer, and emits events as needed.
 */

import type { CronJob, CronJobCreate, CronJobPatch, CronServiceState, CronStatusSummary, TriggerAuditEntry } from './types.js';
import { auditDelivery, mergeRunOutcome, TRIGGER_FIRE_LOG_MAX } from './trigger-audit.js';
import {
  applyJobPatch,
  clockOnDaemon,
  computeJobNextRunAtMs,
  createJob,
  findJobOrThrow,
  isClockOwned,
  isJobDue,
  nextWakeAtMs,
  recomputeNextRuns,
  scheduleNextRunAtMs,
} from './jobs.js';
import { ensureLoaded, persist, warnIfDisabled } from './store.js';
import { armTimer, emit, executeJob, findMissedJobs, locked, replayGuardOf, stopTimer } from './timer.js';

export async function start(state: CronServiceState): Promise<void> {
  // Phase 1: Load store, clear stale markers, find missed jobs (under lock)
  const missed = await locked(state, async () => {
    if (!state.deps.cronEnabled) {
      state.deps.log.info('cron disabled', { enabled: false });
      return [];
    }

    await ensureLoaded(state, { skipRecompute: true });
    const jobs = state.store?.jobs ?? [];

    // Clear stale running markers from previous process
    for (const job of jobs) {
      if (typeof job.state.runningAtMs === 'number') {
        state.deps.log.warn('clearing stale running marker on startup', {
          jobId: job.id,
          runningAtMs: job.state.runningAtMs,
        });
        job.state.runningAtMs = undefined;
      }
    }

    const missedJobs = findMissedJobs(state);

    // Mark missed jobs as running so they aren't picked up by a concurrent tick
    if (missedJobs.length > 0) {
      const now = state.deps.nowMs();
      for (const job of missedJobs) {
        job.state.runningAtMs = now;
      }
      state.deps.log.info('found missed jobs after restart', {
        count: missedJobs.length,
        jobIds: missedJobs.map((j) => j.id),
      });
    }

    recomputeNextRuns(state);
    await persist(state);
    armTimer(state);

    state.deps.log.info('cron started', {
      enabled: true,
      jobs: state.store?.jobs.length ?? 0,
      nextWakeAtMs: nextWakeAtMs(state) ?? null,
    });

    return missedJobs;
  });

  // Phase 2: Execute missed jobs OUTSIDE the lock (prevents deadlock when
  // agent calls cron tools during job execution)
  if (missed.length > 0) {
    try {
      for (const job of missed) {
        await executeJob(state, job);
      }
    } finally {
      // Phase 3: Always finalize under lock, even if execution threw.
      // This clears runningAtMs markers and re-arms the timer.
      await locked(state, async () => {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
        recomputeNextRuns(state);
        await persist(state);
        armTimer(state);
      });
    }
  }
}

export function stop(state: CronServiceState): void {
  stopTimer(state);
}

export async function status(state: CronServiceState): Promise<CronStatusSummary> {
  return await locked(state, async () => {
    // forceReload: recomputeNextRuns below may persist — never from a stale snapshot.
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    if (state.store) {
      const changed = recomputeNextRuns(state);
      if (changed) await persist(state);
    }
    return {
      enabled: state.deps.cronEnabled,
      storePath: state.deps.storePath,
      jobs: state.store?.jobs.length ?? 0,
      nextWakeAtMs: state.deps.cronEnabled ? (nextWakeAtMs(state) ?? null) : null,
    };
  });
}

export async function list(state: CronServiceState, opts?: { includeDisabled?: boolean; recompute?: boolean }) {
  return await locked(state, async () => {
    // forceReload: recomputeNextRuns below may persist — never from a stale snapshot.
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    // recompute:false reads as stored: a reader that compiles a push must not move
    // a slot that is due right now past the timer that is about to run it.
    if (state.store && opts?.recompute !== false) {
      const changed = recomputeNextRuns(state);
      if (changed) await persist(state);
    }
    const includeDisabled = opts?.includeDisabled === true;
    const jobs = (state.store?.jobs ?? []).filter((j) => includeDisabled || j.enabled);
    return [...jobs].sort((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
  });
}

export async function add(state: CronServiceState, input: CronJobCreate) {
  return await locked(state, async () => {
    warnIfDisabled(state, 'add');
    // forceReload on every mutating op: the store file is shared with other
    // processes (and git-sync), so mutating a stale in-memory snapshot and
    // blind-writing it would revert their changes (2026-08-04 re-fire storm).
    await ensureLoaded(state, { forceReload: true });
    const job = createJob(state, input);
    state.store?.jobs.push(job);

    // Defensive: recompute all next-run times to ensure consistency
    recomputeNextRuns(state);
    await persist(state);
    armTimer(state);

    state.deps.log.info('job added', {
      jobId: job.id,
      jobName: job.name,
      nextRunAtMs: job.state.nextRunAtMs,
      schedulerNextWakeAtMs: nextWakeAtMs(state) ?? null,
      timerArmed: state.timer !== null,
      cronEnabled: state.deps.cronEnabled,
    });

    emit(state, {
      jobId: job.id,
      action: 'added',
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return job;
  });
}

export async function update(state: CronServiceState, id: string, patch: CronJobPatch) {
  return await locked(state, async () => {
    warnIfDisabled(state, 'update');
    await ensureLoaded(state, { forceReload: true });
    const job = findJobOrThrow(state, id);
    const now = state.deps.nowMs();
    const wasEnabled = job.enabled;

    applyJobPatch(job, patch);
    if (job.enabled !== wasEnabled) markSwitched(job, now);

    // Fix up anchorMs for 'every' schedules if it's missing or invalid
    if (job.schedule.kind === 'every') {
      const anchor = job.schedule.anchorMs;
      if (typeof anchor !== 'number' || !Number.isFinite(anchor)) {
        const fallbackAnchorMs =
          patch.schedule?.kind === 'every'
            ? now
            : typeof job.createdAtMs === 'number' && Number.isFinite(job.createdAtMs)
              ? job.createdAtMs
              : now;
        job.schedule = {
          ...job.schedule,
          anchorMs: Math.max(0, Math.floor(fallbackAnchorMs)),
        };
      }
    }

    const scheduleChanged = patch.schedule !== undefined;
    // A trigger's next run is the daemon's report; an `enabled` it already had
    // (a stale Resume, a repeated Pause) must not replace it with a server guess.
    const enabledChanged = patch.enabled !== undefined && (job.enabled !== wasEnabled || !clockOnDaemon(job));

    job.updatedAtMs = now;
    if (scheduleChanged || enabledChanged) {
      // Deliberate user edit — the old slot's replay guard no longer applies.
      replayGuardOf(state).delete(id);
      if (job.enabled) {
        if (scheduleChanged || !wasEnabled) startScheduleOver(job);
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
        restartHostClock(job, now);
      } else {
        job.state.nextRunAtMs = undefined;
        job.state.runningAtMs = undefined;
      }
    }

    await persist(state);
    armTimer(state);
    emit(state, {
      jobId: id,
      action: 'updated',
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return job;
  });
}

export async function remove(state: CronServiceState, id: string) {
  return await locked(state, async () => {
    warnIfDisabled(state, 'remove');
    await ensureLoaded(state, { forceReload: true });
    const before = state.store?.jobs.length ?? 0;
    if (!state.store) {
      return { ok: false, removed: false } as const;
    }
    replayGuardOf(state).delete(id);
    state.store.jobs = state.store.jobs.filter((j) => j.id !== id);
    const removed = state.store.jobs.length !== before;
    await persist(state);
    armTimer(state);
    if (removed) {
      emit(state, { jobId: id, action: 'removed' });
    }
    return { ok: true, removed } as const;
  });
}

/**
 * "Run now" for a TRIGGER: relay `triggers.run` to the host's daemon and answer
 * with its reply. The server deliberately cannot do this itself — the run needs
 * the per-trigger `state` cursor, the `seen` set and the daily counter, all of
 * which live next to the script on that host. The fire (if any) comes back
 * through the normal `trigger.fired` event, so this reply only says the daemon
 * accepted the request.
 */
async function relayCheckRun(job: CronJob) {
  const host = job.check?.host || '__local__';
  const { triggerDaemonOrReason } = await import('../routines/trigger-daemon.js');
  const resolved = await triggerDaemonOrReason(host);
  if ('reason' in resolved) return { status: 'skipped' as const, error: resolved.reason };
  try {
    // 60s: a check may take up to its 300s cap, but the daemon answers
    // triggers.run as soon as it has STARTED the run ({ran, started}); the
    // outcome arrives later as a trigger.checked / trigger.fired event.
    // `triggerId`, never `id`: send() builds the frame as {id, cmd, ...params},
    // so a param named `id` overwrites the numeric RPC correlation id and the
    // reply is dropped as unmatched (a silent 30s timeout with no log line).
    const reply = await resolved.conn.send('triggers.run', { triggerId: job.id }, 60_000);
    if (reply.ok !== true) {
      return { status: 'error' as const, error: typeof reply.error === 'string' ? reply.error : `daemon on ${host} refused triggers.run` };
    }
    return { status: 'ok' as const, host, ran: true as const, ...(typeof reply.outcome === 'string' ? { outcome: reply.outcome } : {}) };
  } catch (err) {
    return { status: 'error' as const, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function run(state: CronServiceState, id: string, mode?: 'due' | 'force') {
  // Phase 1: validate and mark running under lock
  const phase1 = await locked(state, async () => {
    warnIfDisabled(state, 'run');
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = findJobOrThrow(state, id);
    if (job.check) return { relay: job };
    if (typeof job.state.runningAtMs === 'number') {
      return { ok: true, ran: false, reason: 'already-running' as const };
    }
    const now = state.deps.nowMs();
    const due = isJobDue(job, now, { forced: mode === 'force' });
    if (!due) {
      return { ok: true, ran: false, reason: 'not-due' as const };
    }
    // Replay guard applies to 'due' runs only — an explicit force is the user
    // deliberately re-running the job.
    if (mode !== 'force') {
      const guard = replayGuardOf(state).get(id);
      if (guard === null || (typeof guard === 'number' && now < guard)) {
        return { ok: true, ran: false, reason: 'already-ran-this-slot' as const };
      }
    }
    // Mark running and persist so the lock can be released
    job.state.runningAtMs = now;
    job.state.lastError = undefined;
    await persist(state);
    return { job };
  });

  const relayTarget = (phase1 as { relay?: CronJob }).relay;
  if (relayTarget) {
    return await relayCheckRun(relayTarget);
  }

  if (!('job' in phase1)) {
    return phase1;
  }

  const { job: jobToRun } = phase1;

  // Phase 2: execute OUTSIDE the lock (prevents deadlock when agent calls cron tools)
  try {
    await executeJob(state, jobToRun!, { forced: mode === 'force' });
  } finally {
    // Phase 3: Always finalize under lock, even if execution threw.
    await locked(state, async () => {
      recomputeNextRuns(state);
      await persist(state);
      armTimer(state);
    });
  }

  return { ok: true, ran: true } as const;
}

/** What a bump did, so the caller can decide whether to run the routine. */
export type WakeBumpResult = {
  jobId: string;
  /** The counter AFTER this bump. */
  count: number;
  threshold: number;
  /** The counter reached the threshold: the caller should run the routine now. */
  due: boolean;
};

/**
 * Add `n` counted events to a wake routine's counter.
 *
 * Inside locked() + persist() like every other write here, so the counter lands
 * in the machine-local cron-state.json sidecar (persist strips `state` from the
 * git-synced definitions file) and a concurrent run's subtract cannot interleave
 * with it. Returns null when the job is gone, disabled, or has no `wake` —
 * a stale in-memory watcher list must not resurrect a deleted counter.
 *
 * Deliberately emits NO cron event: a counter bump is not a lifecycle change,
 * and broadcasting one per flush would spam every browser and re-arm the
 * subscriber that caused it.
 */
export async function bumpWake(
  state: CronServiceState,
  id: string,
  n: number,
): Promise<WakeBumpResult | null> {
  const add = Number.isFinite(n) ? Math.floor(n) : 0;
  if (add <= 0) return null;
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = state.store?.jobs.find((j) => j.id === id);
    if (!job || !job.wake || !job.enabled) return null;
    if (!job.state) job.state = {};
    const count = (job.state.wakeCount ?? 0) + add;
    job.state.wakeCount = count;
    job.state.wakeLastAtMs = state.deps.nowMs();
    await persist(state);
    const threshold = job.wake.threshold;
    return { jobId: id, count, threshold, due: threshold > 0 && count >= threshold };
  });
}

/**
 * Record how a run ENDED, long after its dispatch returned.
 *
 * A routine whose executor starts a session is "ok" the moment the session
 * exists — everything the run actually did happens afterwards, and only the layer
 * watching that session learns it (src/core/triage/runs.ts on session:result).
 * This is how that verdict reaches the card: it merges into the fire row that
 * names this run (`ref`, e.g. its task id, which the dispatch summary carries), or
 * appends one when the run left none — a clock-driven run leaves no fire row at
 * all, because applyJobResult only logs a fire when a wake counter was consumed.
 *
 * Inside locked() + persist() like every other write here, and it emits NO cron
 * event: an audit row is not a lifecycle change, and broadcasting one would
 * re-arm the wake subscriber for nothing.
 */
export async function recordRunOutcome(
  state: CronServiceState,
  id: string,
  entry: TriggerAuditEntry,
  ref: string,
): Promise<boolean> {
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = state.store?.jobs.find((j) => j.id === id);
    if (!job) return false;
    if (!job.state) job.state = {};
    job.state.fireLog = mergeRunOutcome(job.state.fireLog, entry, ref, TRIGGER_FIRE_LOG_MAX);
    await persist(state);
    return true;
  });
}

/**
 * A run whose session never started, learned after the dispatch returned 'ok'
 * (routines/run-start.ts). The card's status becomes that run's real result,
 * unless a later run has replaced it since; the History row is merged either way.
 */
export async function recordRunStartFailure(
  state: CronServiceState,
  id: string,
  input: { runAtMs: number; error: string; ref: string; sessionId?: string },
): Promise<boolean> {
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = state.store?.jobs.find((j) => j.id === id);
    if (!job) return false;
    if (!job.state) job.state = {};
    const last = job.state.lastRunAtMs;
    // A clock tick of slack: the timer stamps lastRunAtMs from the same dispatch time.
    if (typeof last !== 'number' || last <= input.runAtMs + 5_000) {
      job.state.lastStatus = 'error';
      job.state.lastError = input.error;
      job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
    }
    job.state.fireLog = mergeRunOutcome(job.state.fireLog, {
      atMs: input.runAtMs,
      outcome: 'fired',
      error: input.error.slice(0, 300),
      delivery: auditDelivery({
        status: 'error',
        retry: false,
        // The full task id stays in the summary, so the row is found by `ref` again.
        summary: `task ${input.ref}: the session never started`,
        error: input.error,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }),
    }, input.ref, TRIGGER_FIRE_LOG_MAX);
    await persist(state);
    // 'finished', not 'updated': the definition did not change (no wake or clock recompile).
    emit(state, { jobId: job.id, action: 'finished', status: job.state.lastStatus, error: input.error, runAtMs: input.runAtMs, nextRunAtMs: job.state.nextRunAtMs });
    return true;
  });
}

/**
 * A deliberate switch off is a pause and is stamped, so the task card can say
 * "Paused 2h ago" and tell it apart from a trigger the server stopped after its
 * check kept failing (which never passes through here). Switching on clears it
 * and starts the error count over: after a pause, so a check that was still
 * running and failed while it was off cannot stop it at once; after a stop, so
 * the fixed check gets its full count and its first failure is reported again
 * (trigger-health.ts, whose once-in-6h limit starts over too), instead of one
 * more failure stopping it unannounced.
 */
function markSwitched(job: CronJob, now: number): void {
  if (job.enabled) {
    job.state.consecutiveErrors = 0;
    job.state.checkErrorNoticeAtMs = undefined;
    job.state.pausedAtMs = undefined;
    return;
  }
  job.state.pausedAtMs = now;
}

export async function toggle(state: CronServiceState, id: string) {
  return await locked(state, async () => {
    warnIfDisabled(state, 'toggle');
    await ensureLoaded(state, { forceReload: true });
    const job = findJobOrThrow(state, id);
    const now = state.deps.nowMs();

    job.enabled = !job.enabled;
    job.updatedAtMs = now;
    markSwitched(job, now);
    // Deliberate user edit — drop the replay guard so re-enabling schedules fresh.
    replayGuardOf(state).delete(id);

    if (job.enabled) {
      startScheduleOver(job);
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
      restartHostClock(job, now);
    } else {
      job.state.nextRunAtMs = undefined;
      job.state.runningAtMs = undefined;
    }

    await persist(state);
    armTimer(state);
    emit(state, {
      jobId: id,
      action: 'updated',
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return job;
  });
}

/**
 * A schedule edit or a resume starts the schedule over: runs a host made under a
 * clock that came back before it are history, no longer slots of this schedule
 * (clock-fire.ts records them and runs none).
 */
function startScheduleOver(job: CronJob): void {
  delete job.state.clockReturned;
}

/**
 * A schedule edit or a resume starts a host's clock over (clock-routine-v1): a new
 * first slot, which the next push hands that daemon. The daemon drops a run it
 * still owed under the old one, as the server's own timer forgets a missed slot
 * when the schedule changes.
 */
function restartHostClock(job: CronJob, now: number): void {
  if (!isClockOwned(job)) return;
  const next = scheduleNextRunAtMs(job, now);
  job.state.nextRunAtMs = next;
  if (next !== undefined) job.state.clockFromMs = next;
}

/**
 * Boot repair of `session` routine targets (routines/target-repair.ts decides).
 * Applied under the lock only where the target is still the one decided on.
 * `retarget` rewrites it to a task; `disable` turns the routine off with the
 * reason on its card, for a target nothing can deliver to.
 */
export async function applyTargetRepairs(
  state: CronServiceState,
  repairs: Array<{ id: string; from: string; retarget?: string; disable?: string }>,
): Promise<string[]> {
  if (repairs.length === 0) return [];
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const done: string[] = [];
    for (const r of repairs) {
      const job = state.store?.jobs.find((j) => j.id === r.id);
      const config = job?.executor?.type === 'session' ? job.executor.config as Record<string, unknown> : undefined;
      if (!job || !config || config.target !== r.from) continue;
      if (r.retarget) {
        config.target = r.retarget;
      } else if (r.disable) {
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
        job.state.lastStatus = 'error';
        job.state.lastError = r.disable;
      } else {
        continue;
      }
      job.updatedAtMs = state.deps.nowMs();
      done.push(job.id);
    }
    if (done.length > 0) {
      await persist(state);
      for (const id of done) emit(state, { jobId: id, action: 'updated' });
      armTimer(state);
    }
    return done;
  });
}
