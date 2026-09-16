/**
 * Applying a daemon's trigger events to the cron store.
 *
 * Lives inside the cron module because every write here needs the same
 * discipline the timer uses: take the two-layer lock, RELOAD the store (another
 * process may have rewritten it while a fire was being delivered), mutate, then
 * persist. The 2026-08-04 re-fire storm is what a blind write costs.
 *
 * What is deliberately NOT here: what a fire MEANS. The routines layer passes a
 * `deliver` callback (it owns the envelope and the executor), so this file only
 * decides bookkeeping — dedup, history, error counting, next check time.
 */

import { MAX_CONSECUTIVE_CHECK_ERRORS } from '../../providers/trigger-check-core.js';
import type { TriggerCheckedEvent, TriggerFiredEvent } from '../../providers/trigger-check-core.js';
import type { CronJob, CronServiceState } from './types.js';
import { ensureLoaded, persist } from './store.js';
import { applyJobResult, emit, locked } from './timer.js';

/** A fire's delivery must not hang the socket handler that started it. */
const DELIVER_TIMEOUT_MS = 2 * 60_000;
/**
 * How many times a transiently failing delivery is retried (the daemon replays
 * an unacked fire about once a minute) before the fire is recorded as failed and
 * acked anyway. Three is enough to ride out a tunnel flap; more would keep
 * re-spawning a session that cannot start.
 */
export const FIRE_DELIVERY_MAX_ATTEMPTS = 3;

export interface TriggerCheckedApplied {
  found: boolean;
  /** True when this check crossed MAX_CONSECUTIVE_CHECK_ERRORS and was disabled. */
  disabled: boolean;
  jobName?: string;
  host?: string;
  consecutiveErrors?: number;
  error?: string;
}

export interface TriggerFiredApplied {
  found: boolean;
  /** The daemon replayed a seq already delivered — ack, deliver nothing. */
  duplicate: boolean;
  delivered: boolean;
  /**
   * The delivery failed for a transient reason and the fire was NOT recorded:
   * the caller must not ack it, so the daemon replays it and the next attempt
   * goes through the same path again.
   */
  retry: boolean;
  /** Set with `retry: false` when the retries were exhausted this time. */
  gaveUp?: boolean;
  jobName?: string;
  status?: 'ok' | 'error';
  error?: string;
  summary?: string;
}

/**
 * (epoch, seq) dedup. A different epoch means the daemon's counter started over
 * (its state file was recreated), so the server's mark starts over too. Absent
 * epochs (a pre-epoch daemon) compare as equal, which is the old seq-only rule.
 */
export function isDuplicateFire(
  state: { lastFireSeq?: number; lastFireEpoch?: string },
  event: { epoch?: string; seq: number },
): boolean {
  if (typeof state.lastFireSeq !== 'number') return false;
  if ((state.lastFireEpoch ?? '') !== (event.epoch ?? '')) return false;
  return event.seq <= state.lastFireSeq;
}

/**
 * A run that did not deliver anything: quiet or a check error.
 *
 * A quiet check is NOT recorded as a routine "run" (lastStatus / lastRunAtMs
 * keep meaning "the last time this trigger did something"), but it DOES clear
 * consecutiveErrors — a source that answers again has recovered. An error, by
 * contrast, goes through applyJobResult so the history line, the backoff and the
 * error count behave exactly like every other routine's failure.
 */
export async function applyTriggerChecked(
  state: CronServiceState,
  event: TriggerCheckedEvent,
): Promise<TriggerCheckedApplied> {
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = state.store?.jobs.find((j) => j.id === event.id);
    if (!job || !job.check) return { found: false, disabled: false };
    if (!job.state) job.state = {};

    const atMs = Number.isFinite(event.atMs) ? event.atMs : state.deps.nowMs();
    const durationMs = Number.isFinite(event.durationMs) ? event.durationMs : 0;

    if (event.outcome === 'error') {
      applyJobResult(state, job, {
        status: 'error',
        error: event.error ?? 'check failed',
        startedAt: atMs,
        endedAt: atMs + durationMs,
      });
    } else {
      job.state.consecutiveErrors = 0;
      job.state.lastError = undefined;
      job.updatedAtMs = atMs;
    }

    job.state.lastCheck = {
      atMs,
      outcome: event.outcome,
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.error ? { error: event.error } : {}),
      durationMs,
    };
    // AFTER applyJobResult: its error backoff computes a server-side next run,
    // which for a trigger is always a guess. The daemon's report wins.
    job.state.nextRunAtMs = Number.isFinite(event.nextRunAtMs) ? event.nextRunAtMs : undefined;

    let disabled = false;
    if (event.outcome === 'error' && (job.state.consecutiveErrors ?? 0) >= MAX_CONSECUTIVE_CHECK_ERRORS) {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      job.state.runningAtMs = undefined;
      disabled = true;
    }

    await persist(state);
    // 'updated' is what the Routines card listens to (cron:job-updated): without
    // it a quiet check only shows up after a manual reload.
    emit(state, {
      jobId: job.id,
      action: 'updated',
      ...(event.outcome === 'error' ? { status: 'error' as const, error: event.error } : {}),
      nextRunAtMs: job.state.nextRunAtMs,
    });

    return {
      found: true,
      disabled,
      jobName: job.name,
      host: job.check.host,
      consecutiveErrors: job.state.consecutiveErrors ?? 0,
      ...(event.error ? { error: event.error } : {}),
    };
  });
}

type DeliverResult = { status: 'ok' | 'error'; summary?: string; error?: string; retryable?: boolean };

/**
 * A fire: dedup on (id, epoch, seq), deliver OUTSIDE the lock, then record.
 *
 * The three phases are the same shape as timer.ts executeJob, for the same
 * reason: delivery can start a session, and holding the cron file lock across
 * that would block every other cron write on the box.
 *
 * What gets recorded depends on WHY a delivery failed. A refusal (the target
 * task is complete, the routine has no executor) is final: the fire is recorded
 * and acked, and lastError carries it. A transient failure (a throw, the 2-minute
 * timeout, an unreachable host) is not: the mark is left alone and the caller
 * withholds the ack, so the daemon replays the fire and the items are not lost.
 * The daemon marked them seen at fire time, so a consumed fire can never fire
 * again; this is the one place at-least-once has to be honored on the server.
 */
export async function applyTriggerFired(
  state: CronServiceState,
  event: TriggerFiredEvent,
  deliver: (job: CronJob) => Promise<DeliverResult>,
): Promise<TriggerFiredApplied> {
  const startedAt = Number.isFinite(event.atMs) ? event.atMs : state.deps.nowMs();

  const phase1 = await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = state.store?.jobs.find((j) => j.id === event.id);
    if (!job || !job.check) return { found: false as const };
    if (!job.state) job.state = {};
    if (isDuplicateFire(job.state, event)) return { duplicate: true as const, job };
    job.state.runningAtMs = state.deps.nowMs();
    job.state.lastError = undefined;
    await persist(state);
    emit(state, { jobId: job.id, action: 'started', runAtMs: startedAt });
    return { job };
  });

  if ('found' in phase1) return { found: false, duplicate: false, delivered: false, retry: false };
  if ('duplicate' in phase1) {
    return { found: true, duplicate: true, delivered: false, retry: false, jobName: phase1.job.name };
  }

  const job = phase1.job;
  let result: DeliverResult;
  try {
    let timeoutId: ReturnType<typeof setTimeout>;
    result = await Promise.race([
      deliver(job),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('trigger delivery timed out')), DELIVER_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeoutId!));
  } catch (err) {
    result = { status: 'error', error: err instanceof Error ? err.message : String(err), retryable: true };
  }

  const endedAt = state.deps.nowMs();
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const target = state.store?.jobs.find((j) => j.id === event.id) ?? job;
    if (!target.state) target.state = {};

    // Attempt accounting for THIS fire; a different fire resets it.
    const sameFire = target.state.fireRetry
      && target.state.fireRetry.seq === event.seq
      && (target.state.fireRetry.epoch ?? '') === (event.epoch ?? '');
    const attempts = (sameFire ? target.state.fireRetry!.attempts : 0) + 1;
    const transient = result.status === 'error' && result.retryable === true;
    const retry = transient && attempts < FIRE_DELIVERY_MAX_ATTEMPTS;
    const gaveUp = transient && !retry;
    const error = gaveUp
      ? `delivery failed ${attempts} times, giving up: ${result.error ?? 'unknown error'}`
      : result.error;

    applyJobResult(state, target, {
      status: result.status,
      error,
      startedAt,
      endedAt,
    });
    target.state.lastCheck = {
      atMs: startedAt,
      outcome: 'fired',
      items: event.items?.length ?? 0,
      ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
      ...(error ? { error } : {}),
      ...(retry ? { retryPending: true } : {}),
    };
    if (retry) {
      // Not recorded as processed: the replay must pass the dedup again.
      target.state.fireRetry = { ...(event.epoch ? { epoch: event.epoch } : {}), seq: event.seq, attempts };
    } else {
      // Recorded on success, on a refusal, and when the retries ran out: the
      // daemon is about to be acked in all three cases.
      target.state.lastFireSeq = event.seq;
      target.state.lastFireEpoch = event.epoch;
      target.state.fireRetry = undefined;
    }
    target.state.nextRunAtMs = Number.isFinite(event.nextRunAtMs) ? event.nextRunAtMs : undefined;
    await persist(state);
    emit(state, {
      jobId: target.id,
      action: 'finished',
      status: result.status,
      error,
      summary: result.summary,
      runAtMs: startedAt,
      durationMs: target.state.lastDurationMs,
      nextRunAtMs: target.state.nextRunAtMs,
    });
    return {
      found: true,
      duplicate: false,
      delivered: result.status === 'ok',
      retry,
      ...(gaveUp ? { gaveUp: true } : {}),
      jobName: target.name,
      status: result.status,
      ...(error ? { error } : {}),
      ...(result.summary ? { summary: result.summary } : {}),
    };
  });
}
