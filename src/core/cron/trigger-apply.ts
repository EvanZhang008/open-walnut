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
import {
  appendAudit, auditDelivery, checkedAuditEntry, firedAuditEntry, injectedPreview, mergeFireAttempt,
  TRIGGER_CHECK_LOG_MAX, TRIGGER_FIRE_LOG_MAX,
} from './trigger-audit.js';

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
 * How many recorded-but-out-of-order fire seqs the dedup window remembers above
 * its contiguous watermark. The daemon holds at most PENDING_FIRES_MAX (50)
 * unacked fires, so a window this size can never forget one that is still owed;
 * if it ever overflowed, the OLDEST seq is forgotten, which risks delivering a
 * fire twice rather than dropping one.
 */
export const FIRE_SEQ_WINDOW_MAX = 64;

/**
 * (epoch, seq) dedup over a WINDOW, not a high-water mark.
 *
 * A high-water mark is wrong here because fires are not processed in order: the
 * daemon replays every unacked fire (daemon-standalone.ts sends all of
 * pendingFires), the server's in-flight guard is keyed per seq, and a delivery
 * runs with the store lock RELEASED. So seq 6 can be recorded while seq 5 is
 * still being retried; a mark of 6 then judged 5's replay a duplicate, acked it,
 * and threw its items away - silently breaking the at-least-once promise this
 * module is built on. `lastFireSeq` is therefore the highest CONTIGUOUS seq
 * recorded, and `fireSeqsDone` holds the recorded ones above it.
 *
 * A different epoch means the daemon's counter started over (its state file was
 * recreated), so nothing is known about that epoch's seqs and none are dropped.
 * Absent epochs (a pre-epoch daemon) compare as equal, the old seq-only rule.
 */
export function isDuplicateFire(
  state: { lastFireSeq?: number; lastFireEpoch?: string; fireSeqsDone?: number[] },
  event: { epoch?: string; seq: number },
): boolean {
  if ((state.lastFireEpoch ?? '') !== (event.epoch ?? '')) return false;
  if (typeof state.lastFireSeq === 'number' && event.seq <= state.lastFireSeq) return true;
  return (state.fireSeqsDone ?? []).includes(event.seq);
}

/**
 * Mark ONE fire as recorded and slide the window: the watermark absorbs every
 * seq that is now contiguous with it, and only the gaps stay listed.
 */
export function recordFireSeq(
  state: { lastFireSeq?: number; lastFireEpoch?: string; fireSeqsDone?: number[] },
  event: { epoch?: string; seq: number },
): void {
  const sameEpoch = (state.lastFireEpoch ?? '') === (event.epoch ?? '');
  const done = new Set<number>(sameEpoch ? state.fireSeqsDone ?? [] : []);
  done.add(event.seq);
  // A new epoch starts from nothing: seeing seq 3 first says nothing about 1 and
  // 2, which may still be owed. Claiming them would drop them.
  let mark = sameEpoch && typeof state.lastFireSeq === 'number' ? state.lastFireSeq : 0;
  while (done.has(mark + 1)) {
    done.delete(mark + 1);
    mark += 1;
  }
  state.lastFireSeq = mark;
  state.lastFireEpoch = event.epoch;
  const gaps = [...done].sort((a, b) => a - b).slice(-FIRE_SEQ_WINDOW_MAX);
  state.fireSeqsDone = gaps.length ? gaps : undefined;
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
    // The audit line rides the write lastCheck already does, so recent activity
    // costs no extra persist. Fires are appended in applyTriggerFired instead:
    // the daemon reports a fire through that path, never through checked.
    job.state.checkLog = appendAudit(
      job.state.checkLog,
      checkedAuditEntry({ atMs, outcome: event.outcome, reason: event.reason, durationMs, error: event.error }),
      TRIGGER_CHECK_LOG_MAX,
    );
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

type DeliverResult = {
  status: 'ok' | 'error';
  summary?: string;
  error?: string;
  retryable?: boolean;
  /** For the audit trail: where it landed and the text that landed there. */
  delivered?: { sessionId?: string; text?: string };
};

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
    // The audit line for this fire: what went where, and the text the session got.
    // A replayed attempt of the SAME fire updates its row rather than adding one,
    // so three attempts read as one fire that took three tries.
    const auditEntry = firedAuditEntry({
      atMs: startedAt,
      seq: event.seq,
      items: event.items?.length ?? 0,
      // The authoritative count, not one re-derived from whatever row survived:
      // checkLog is short enough that a slow retry can outlive its own row.
      attempts,
      ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
      ...(error ? { error } : {}),
      delivery: auditDelivery({
        status: result.status,
        retry,
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.delivered?.sessionId ? { sessionId: result.delivered.sessionId } : {}),
      }),
      ...(result.delivered?.text ? { injected: injectedPreview(result.delivered.text) } : {}),
    });
    const stamped = { ...auditEntry, ...(event.epoch ? { epoch: event.epoch } : {}) };
    target.state.fireLog = mergeFireAttempt(target.state.fireLog, stamped, TRIGGER_FIRE_LOG_MAX);
    // Both lists carry the fire: checkLog is "what has this trigger been doing",
    // and a fire absent from it would read as a gap in the clock. Merged there
    // too, so a replayed attempt updates its row instead of adding one.
    target.state.checkLog = mergeFireAttempt(target.state.checkLog, stamped, TRIGGER_CHECK_LOG_MAX);
    // Counted only when the fire is being recorded (an unacked retry is still the
    // same fire), so the total never double-counts a replay. A trigger that was
    // already firing before this trail existed seeds its total from the daemon's
    // seq (fires in the current epoch) rather than claiming this is its first.
    if (!retry) {
      const seeded = target.state.fireCount ?? (typeof target.state.lastFireSeq === 'number' ? target.state.lastFireSeq : 0);
      target.state.fireCount = seeded + 1;
    }
    if (retry) {
      // Not recorded as processed: the replay must pass the dedup again.
      target.state.fireRetry = { ...(event.epoch ? { epoch: event.epoch } : {}), seq: event.seq, attempts };
    } else {
      // Recorded on success, on a refusal, and when the retries ran out: the
      // daemon is about to be acked in all three cases.
      recordFireSeq(target.state, event);
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
