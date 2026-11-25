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

import { MAX_CONSECUTIVE_CHECK_ERRORS, isHostDelivery, isMachineFaultKind } from '../../providers/trigger-check-core.js';
import type { MachineFaultKind, TriggerCheckedEvent, TriggerFiredEvent } from '../../providers/trigger-check-core.js';
import type { CronJob, CronServiceState, OwedFire } from './types.js';
import { diskStampOf, ensureLoaded, persist } from './store.js';
import { isHostReplicaProgram } from '../server-role.js';
import { applyJobResult, emit, locked } from './timer.js';
import { applyClockRun, clockTenureOf, owedClockVerdict, settleClockNext } from './clock-fire.js';
import {
  appendAudit, auditDelivery, auditWarnings, checkedAuditEntry, firedAuditEntry, injectedPreview, insertAuditByTime, mergeFireAttempt,
  TRIGGER_CHECK_LOG_MAX, TRIGGER_FIRE_LOG_MAX,
} from './trigger-audit.js';
import { checkErrorText, isTimeLimitError, timeLimitSeconds } from './trigger-time-limit.js';

/** A fire's delivery must not hang the socket handler that started it. */
const DELIVER_TIMEOUT_MS = 2 * 60_000;
/**
 * A transiently failing delivery is never given up (2026-11-23, the user: "我们任何时候不应该造成这个
 * message loss，而且有 error 的话一直会 retry"): the fire stays unacked, so the daemon keeps replaying
 * it (about once a minute), until a try lands. The first FIRE_DELIVERY_FAST_ATTEMPTS tries go on each
 * replay, enough to ride out a tunnel flap. After that a try waits fireRetryWaitMs from the last one,
 * growing to an hour, so a session that cannot start is not re-spawned every minute: a replay that
 * comes before the next try is due delivers nothing and is answered as a retry again.
 */
export const FIRE_DELIVERY_FAST_ATTEMPTS = 3;
/** The waits after the FIRE_DELIVERY_FAST_ATTEMPTS-th failure and the ones after it; then FIRE_RETRY_EVERY_MS for good. */
export const FIRE_RETRY_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000] as const;
export const FIRE_RETRY_EVERY_MS = 60 * 60_000;

/**
 * How long after its last try a fire that failed `failures` times waits for the next one. The same
 * schedule as sessions/delivery-retry.ts (copied, so the cron module needs nothing from sessions).
 */
export function fireRetryWaitMs(failures: number): number {
  if (failures < FIRE_DELIVERY_FAST_ATTEMPTS) return 0;
  return FIRE_RETRY_BACKOFF_MS[failures - FIRE_DELIVERY_FAST_ATTEMPTS] ?? FIRE_RETRY_EVERY_MS;
}

export interface TriggerCheckedApplied {
  found: boolean;
  /** True when this check crossed MAX_CONSECUTIVE_CHECK_ERRORS and was disabled. */
  disabled: boolean;
  /** Duplicate or older report; it must not add errors, audit rows or notices. */
  ignored?: true;
  jobName?: string;
  host?: string;
  consecutiveErrors?: number;
  /** The check's error as stored and told: a deadline kill names the limit (trigger-time-limit.ts). */
  error?: string;
  /** The check's time limit in seconds. */
  timeLimitSeconds?: number;
  /** The daemon killed this check at its time limit. */
  killedAtLimit?: boolean;
  /**
   * The fire budget held this check back and its owning task has not been told today.
   * `maxFiresPerDay` is the stored cap (absent = the default), for the notice.
   */
  budgetHeld?: { maxFiresPerDay?: number; everyMs?: number };
  /** Where a notice about this check goes, and what it can say (trigger-health.ts). */
  targetTaskId?: string;
  checkRun?: string;
  everyMs?: number;
  /** The daemon repaired what this quiet check printed, and the session has not been told today. */
  warningsToTell?: string[];
  /** This error starts a run of failures and the session has not been told of one lately. */
  tellSessionError?: boolean;
  /** The failures went on past the team's threshold; the owning task (or its lead) has not been told about this run. */
  tellFailing?: boolean;
  /** When the current run of failed checks began. */
  errorSinceMs?: number;
  /** A check passed after a run the team was told about (an older Walnut's bell for it is out of date). */
  recovered?: boolean;
  /** This error was the machine's (trigger-check-core.ts machineFaultOf): recorded, never counted. */
  fault?: MachineFaultKind;
  /**
   * The machine has failed this trigger's checks for MACHINE_FAULT_QUIET_MAX_MS, and the owning task
   * (or its lead) has not been told about this run of them: since when.
   */
  tellMachineFault?: { sinceMs: number };
}

/** A trigger the fire budget keeps holding is worth one notice a day, not one per check. */
export const FIRE_BUDGET_NOTICE_EVERY_MS = 24 * 60 * 60 * 1000;
/** The same script repeats the same contract slip every check: the session hears it once a day. */
export const WARNING_NOTICE_EVERY_MS = 24 * 60 * 60 * 1000;
/** A source that fails now and then must not wake its session every time it does. */
export const CHECK_ERROR_SESSION_NOTICE_EVERY_MS = 6 * 60 * 60 * 1000;
/**
 * The owning task (or its lead) hears again about failures that go on this many checks, or this
 * long, whichever comes first. (The names are older than that: the user once heard it as a bell.)
 */
export const CHECK_ERROR_USER_AFTER_ERRORS = 3;
export const CHECK_ERROR_USER_AFTER_MS = 30 * 60 * 1000;
/**
 * How long checks the machine failed go untold. The machine's own alarm has a full disk or an away
 * server; but a 507 or a 503 can also be one route's lasting answer (a remote host's full disk, a
 * companion that never takes a write), which no alarm owns. Past this the owning task (or its lead)
 * hears it once for the run, so a trigger never stays broken in silence. It never counts toward the
 * stop: a trigger the machine failed overnight still runs when the machine is back.
 */
export const MACHINE_FAULT_QUIET_MAX_MS = 6 * 60 * 60 * 1000;

/** The task a session-executor routine delivers into, if it has one. */
export function routineTargetTask(job: CronJob): string | undefined {
  if (job.executor?.type !== 'session') return undefined;
  const target = (job.executor.config as { target?: unknown } | undefined)?.target;
  return typeof target === 'string' && target ? target : undefined;
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
  /**
   * With `retry`, when the next try is due. A replay before then delivered nothing
   * (`delivered: false`, `error` is the last try's): the fire waits for its turn.
   */
  nextTryAtMs?: number;
  /** With `retry`: a replay inside the wait, so no try ran (the caller logs it quietly). */
  waiting?: true;
  /** With `retry` after a try: how many tries this fire has failed so far. */
  attempts?: number;
  jobName?: string;
  status?: 'ok' | 'error';
  error?: string;
  summary?: string;
  /**
   * Seqs of the batch that were already recorded before this call. Always safe to
   * ack, even when the rest of the batch is withheld for a retry: their replay is
   * what would otherwise keep going.
   */
  duplicateSeqs?: number[];
  /** The delivered batch's identity: its lowest new seq (what the audit row and retries key on). */
  seq?: number;
  /** The check worked after a run of failures the team was told about. */
  recovered?: boolean;
  /**
   * Clock runs nobody took that are not the server's to run (clock-fire.ts):
   * recorded as seen and safe to ack, nothing ran for them.
   */
  supersededSeqs?: number[];
  /** Clock runs not decidable now: never acked, the daemon's replay brings them back. */
  heldSeqs?: number[];
  /**
   * Fires the server now keeps itself (job.state.owedFires) and tries on its own clock: safe to
   * ack, so the daemon's capped list of unacked fires never has to drop one.
   */
  owedSeqs?: number[];
}

export interface ApplyFiredOptions {
  /** The host whose daemon sent the fires: a clock run counts only under that host's clock. */
  fromHost?: string;
  /** The server's own try of its owed fires (routines/trigger-events.ts sweepOwedFires), not a daemon's fire. */
  owed?: true;
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
    const lastAt = job.state.lastCheck?.atMs;
    if (typeof lastAt === 'number' && atMs <= lastAt) {
      // A check its host ran while no server took it, reported after a later one: its row goes in the
      // history in its place; the latest check stays (providers/trigger-unsent-checks.ts).
      if (event.replay && atMs < lastAt) {
        const limitS = timeLimitSeconds(job.check);
        const error = checkErrorText(event.error, limitS);
        const before = job.state.checkLog;
        job.state.checkLog = insertAuditByTime(before, checkedAuditEntry({
          atMs, outcome: event.outcome, reason: event.reason, durationMs, error, warnings: event.warnings, limitSeconds: limitS,
          ...(isMachineFaultKind(event.fault) ? { fault: event.fault } : {}),
        }), TRIGGER_CHECK_LOG_MAX);
        if (job.state.checkLog !== before) await persist(state);
        return { found: true, disabled: false, ignored: true };
      }
      // A restart re-arms the clock even when its latest check was already recorded.
      if (event.replay && atMs === lastAt && job.enabled && Number.isFinite(event.nextRunAtMs)
        && event.nextRunAtMs > state.deps.nowMs() && event.nextRunAtMs !== job.state.nextRunAtMs) {
        job.state.nextRunAtMs = event.nextRunAtMs;
        await persist(state);
        emit(state, { jobId: job.id, action: 'updated', nextRunAtMs: job.state.nextRunAtMs });
      }
      return { found: true, disabled: false, ignored: true };
    }
    // What a routine check must not change for its write to wait (persistRoutineCheck).
    const before = { errors: job.state.consecutiveErrors ?? 0, lastError: job.state.lastError, faultSince: job.state.machineFaultSinceMs };
    // A deadline kill is said as one, with the limit, whichever daemon version worded it.
    const limitS = timeLimitSeconds(job.check);
    const killedAtLimit = event.outcome === 'error' && isTimeLimitError(event.error);
    const error = checkErrorText(event.error, limitS);
    // The machine failed this check, not its script (a full disk, no server, a host's link down):
    // the machine's own alarm has it, so it neither counts toward the stop nor tells anyone. The
    // daemon kept the trigger's cursor and unseen items, so the next good check reports them.
    const fault = event.outcome === 'error' && isMachineFaultKind(event.fault) ? event.fault : undefined;
    // A run of them starts at its first; any other new outcome ends it (a replay changes nothing).
    if (!event.replay) {
      if (!fault) job.state.machineFaultSinceMs = undefined;
      else if (typeof job.state.machineFaultSinceMs !== 'number') job.state.machineFaultSinceMs = atMs;
    }
    // Past the quiet window, told once per run of them (trigger-health.ts), and still not counted.
    const faultSince = job.state.machineFaultSinceMs;
    let tellMachineFault: TriggerCheckedApplied['tellMachineFault'];
    if (fault && !event.replay && job.enabled && typeof faultSince === 'number' && atMs - faultSince >= MACHINE_FAULT_QUIET_MAX_MS
      && job.state.machineFaultToldSinceMs !== faultSince) {
      job.state.machineFaultToldSinceMs = faultSince;
      tellMachineFault = { sinceMs: faultSince };
    }
    // An error that is no strike against the script: one replayed from before (it may be the outage
    // itself), or the machine's.
    const notCounted = event.outcome === 'error' && (event.replay === true || fault !== undefined);

    if (event.outcome === 'error') {
      if (notCounted) {
        // Shown on the card; the error count and the run history are left as they were.
        job.state.lastError = error;
      } else {
        applyJobResult(state, job, {
          status: 'error',
          error: error ?? 'check failed',
          startedAt: atMs,
          endedAt: atMs + durationMs,
        });
      }
    } else {
      job.state.consecutiveErrors = 0;
      job.state.lastError = undefined;
      // No updatedAtMs: a good check changes no definition. It once moved the definitions file
      // (cron-jobs.json, 0.9 MB, git-synced) on every check of every trigger, about once a second
      // on the Mac (2026-11-22), and nothing reads it (the routines copy and the revision leave it out).
    }
    const health = notCounted ? {} : checkHealth(job, event.outcome, atMs);

    job.state.lastCheck = {
      atMs,
      outcome: event.outcome,
      ...(event.reason ? { reason: event.reason } : {}),
      ...(error ? { error } : {}),
      durationMs,
      ...(killedAtLimit ? { killedAtLimit: true } : {}),
      limitSeconds: limitS,
      ...(fault ? { fault } : {}),
      // Nothing it watches is in flight (trigger-check-core.ts checkIdleOf); only a quiet run says so.
      ...(event.outcome === 'quiet' && event.idle === true ? { idle: true as const } : {}),
    };
    // The audit line rides the write lastCheck already does, so recent activity
    // costs no extra persist. Fires are appended in applyTriggerFired instead:
    // the daemon reports a fire through that path, never through checked.
    job.state.checkLog = appendAudit(
      job.state.checkLog,
      checkedAuditEntry({ atMs, outcome: event.outcome, reason: event.reason, durationMs, error, warnings: event.warnings, limitSeconds: limitS, ...(killedAtLimit ? { killedAtLimit } : {}), ...(fault ? { fault } : {}) }),
      TRIGGER_CHECK_LOG_MAX,
    );
    const warnings = event.outcome === 'quiet' ? auditWarnings(event.warnings) : undefined;
    let warningsToTell: string[] | undefined;
    if (job.enabled && warnings && atMs - (job.state.warningNoticeAtMs ?? 0) >= WARNING_NOTICE_EVERY_MS) {
      job.state.warningNoticeAtMs = atMs;
      warningsToTell = warnings;
    }
    // AFTER applyJobResult: its error backoff computes a server-side next run,
    // which for a trigger is always a guess. The daemon's report wins.
    // A check that was already running when the trigger was paused still
    // reports; the daemon has disarmed it, so there is no next run to show.
    job.state.nextRunAtMs = job.enabled && Number.isFinite(event.nextRunAtMs) ? event.nextRunAtMs : undefined;

    // The first held check in a day tells the owning task; the rest only show on the card.
    let budgetHeld: TriggerCheckedApplied['budgetHeld'];
    if (job.enabled && event.outcome === 'quiet' && event.reason === 'rate-limited'
      && atMs - (job.state.fireBudgetNoticeAtMs ?? 0) >= FIRE_BUDGET_NOTICE_EVERY_MS) {
      job.state.fireBudgetNoticeAtMs = atMs;
      budgetHeld = {
        ...(typeof job.check.maxFiresPerDay === 'number' ? { maxFiresPerDay: job.check.maxFiresPerDay } : {}),
        ...(job.schedule.kind === 'every' ? { everyMs: job.schedule.everyMs } : {}),
      };
    }

    let disabled = false;
    // Only a polling trigger can be stopped: a late error from a check that was
    // running when someone paused it leaves the pause as it is, with no notice.
    if (job.enabled && !notCounted && event.outcome === 'error' && (job.state.consecutiveErrors ?? 0) >= MAX_CONSECUTIVE_CHECK_ERRORS) {
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      job.state.runningAtMs = undefined;
      disabled = true;
    }

    const routine = event.outcome === 'quiet' && !event.replay && !disabled && !warningsToTell && !budgetHeld
      && Object.keys(health).length === 0 && before.errors === 0 && before.lastError === undefined && before.faultSince === undefined;
    // On a host replica persist refuses (the Mac writes the routines): it still refuses at once.
    if (routine && !state.stopped && !isHostReplicaProgram()) persistRoutineCheck(state);
    else await persist(state);
    // 'updated' is what the Routines card listens to (cron:job-updated): without
    // it a quiet check only shows up after a manual reload. A quiet check carries the
    // job as stored, so a page puts it in place without reading it back: every page
    // read GET /api/routines/:id for each push, about 50 a minute on the Mac, each a
    // reload of the whole store under this lock (2026-11-16, task 9bceb9f2). An error
    // goes through applyJobResult (its run history, its missed slots): pages read it.
    emit(state, {
      jobId: job.id,
      action: 'updated',
      ...(event.outcome === 'error' ? { status: 'error' as const, error } : { job }),
      nextRunAtMs: job.state.nextRunAtMs,
    });

    return {
      found: true,
      disabled,
      jobName: job.name,
      host: job.check.host,
      consecutiveErrors: job.state.consecutiveErrors ?? 0,
      ...(error ? { error } : {}),
      timeLimitSeconds: limitS,
      ...(killedAtLimit ? { killedAtLimit } : {}),
      ...(budgetHeld ? { budgetHeld } : {}),
      ...(routineTargetTask(job) ? { targetTaskId: routineTargetTask(job) } : {}),
      checkRun: job.check.run,
      ...(job.schedule.kind === 'every' ? { everyMs: job.schedule.everyMs } : {}),
      ...(warningsToTell ? { warningsToTell } : {}),
      ...(fault ? { fault } : {}),
      ...(tellMachineFault ? { tellMachineFault } : {}),
      ...health,
    };
  });
}

/**
 * How long a routine check's write waits, gathering the checks after it into one write.
 *
 * A quiet check of a healthy trigger changes only what it records (lastCheck, the check log, the
 * next run the daemon reported), and every one rewrote cron-state.json (1 MB, both files' texts
 * built to compare) at about one a second: 238 writes in the 100 s after a restart (2026-11-23),
 * one of the largest sources of the server's garbage. Losing the last few seconds of such lines to
 * a crash loses no fire, no notice and no error count: those always write at once. At 10 s it
 * was still 8 writes of the 1.1 MB file a minute (2026-11-25, 222 triggers checking about once a
 * second between them), so the checks wait up to 30 s: about 2 a minute.
 */
export const ROUTINE_WRITE_DELAY_MS = 30_000;

/** Record a routine check: `store` holds it now, one write within ROUTINE_WRITE_DELAY_MS carries it. */
export function persistRoutineCheck(state: CronServiceState): void {
  state.routineWriteDue = true;
  if (state.routineWriteTimer) return;
  state.routineWriteTimer = setTimeout(() => { void flushRoutineChecks(state); }, ROUTINE_WRITE_DELAY_MS);
  state.routineWriteTimer.unref?.();
}

/** Write what routine checks left waiting, under the store lock (also on stop). */
export async function flushRoutineChecks(state: CronServiceState): Promise<void> {
  if (state.routineWriteTimer) clearTimeout(state.routineWriteTimer);
  state.routineWriteTimer = undefined;
  if (!state.routineWriteDue) return;
  await locked(state, async () => {
    if (!state.routineWriteDue) return;
    // Another writer changed a file since this store last matched it (git-sync, another process):
    // writing would put this store's older rows over theirs. Theirs wins; the waiting check lines
    // are dropped, as a reload would have dropped them.
    if (!state.store || !state.disk || await diskStampOf(state) !== state.disk.stamp) { state.routineWriteDue = false; return; }
    await persist(state);
  })
    .catch((err) => state.deps.log.warn('cron routine check write failed', { error: err instanceof Error ? err.message : String(err) }));
}

/**
 * Who should hear about this check's outcome (trigger-health.ts sends it). Runs
 * after the error count is updated and before the disable, under the store lock,
 * so two reports never both decide to tell. Only a polling trigger counts: a late
 * report from a paused one tells no one.
 */
function checkHealth(
  job: CronJob,
  outcome: TriggerCheckedEvent['outcome'],
  atMs: number,
): Pick<TriggerCheckedApplied, 'tellSessionError' | 'tellFailing' | 'errorSinceMs' | 'recovered'> {
  const s = job.state;
  if (outcome !== 'error') {
    if (typeof s.checkErrorUserNoticeSinceMs !== 'number') return {};
    s.checkErrorUserNoticeSinceMs = undefined;
    return { recovered: true };
  }
  const errors = s.consecutiveErrors ?? 0;
  if (errors <= 1 || typeof s.checkErrorSinceMs !== 'number') s.checkErrorSinceMs = atMs;
  const since = s.checkErrorSinceMs;
  if (!job.enabled) return { errorSinceMs: since };
  const tellSessionError = errors === 1 && atMs - (s.checkErrorNoticeAtMs ?? 0) >= CHECK_ERROR_SESSION_NOTICE_EVERY_MS;
  if (tellSessionError) s.checkErrorNoticeAtMs = atMs;
  const tellFailing = errors >= 2 && s.checkErrorUserNoticeSinceMs !== since
    && (errors >= CHECK_ERROR_USER_AFTER_ERRORS || atMs - since >= CHECK_ERROR_USER_AFTER_MS);
  if (tellFailing) s.checkErrorUserNoticeSinceMs = since;
  return {
    errorSinceMs: since,
    ...(tellSessionError ? { tellSessionError } : {}),
    ...(tellFailing ? { tellFailing } : {}),
  };
}

export type DeliverResult = {
  status: 'ok' | 'error';
  summary?: string;
  error?: string;
  retryable?: boolean;
  /** For the audit trail: where it landed and the text that landed there. */
  delivered?: { sessionId?: string; text?: string };
  /** When it actually landed, when that was not now (a host delivered it while this server was away). */
  deliveredAtMs?: number;
};

/**
 * A fire, or a BATCH of one trigger's fires: dedup each on (id, epoch, seq),
 * deliver what is new ONCE and OUTSIDE the lock, then record every seq.
 *
 * A batch is what a host back from an outage produces: the daemon replays every
 * fire it held, in one burst. One delivery with every item is the right answer
 * to that (seven separate deliveries are seven turns doing one job), and the
 * caller still acks each seq, because the daemon's ack removes exactly one. All
 * events of a batch share one trigger and one epoch; the caller groups them.
 *
 * The three phases are the same shape as timer.ts executeJob, for the same
 * reason: delivery can start a session, and holding the cron file lock across
 * that would block every other cron write on the box.
 *
 * What gets recorded depends on WHY a delivery failed. A refusal (the target
 * task is complete, the routine has no executor) is final: the fires are
 * recorded and acked, and lastError carries it. A transient failure (a throw,
 * the 2-minute timeout, an unreachable host) is not: the marks are left alone
 * and the caller withholds the acks, so the daemon replays the fires and the
 * items are not lost. The daemon marked them seen at fire time, so a consumed
 * fire can never fire again; this is the one place at-least-once has to be
 * honored on the server. A batch retries as a unit, identified by its lowest seq,
 * for as long as it fails; past the fast tries a replay that comes before the
 * next try is due delivers nothing (fireRetryWaitMs) and is withheld again.
 */
export async function applyTriggerFired(
  state: CronServiceState,
  events: TriggerFiredEvent | readonly TriggerFiredEvent[],
  deliver: (job: CronJob, fires: TriggerFiredEvent[], at: { startedAtMs: number }) => Promise<DeliverResult>,
  opts: ApplyFiredOptions = {},
): Promise<TriggerFiredApplied> {
  const batch = (Array.isArray(events) ? [...events] : [events as TriggerFiredEvent]).sort((a, b) => a.seq - b.seq);
  const head = batch[0];
  if (!head) return { found: false, duplicate: false, delivered: false, retry: false };

  const phase1 = await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const job = state.store?.jobs.find((j) => j.id === head.id);
    // A clock routine's run (clock-routine-v1) is a fire of a routine with no
    // check; it is recorded even after the server took the clock back, since the
    // daemon ran that slot and nobody else will.
    if (!job || (!job.check && !head.clock)) return { found: false as const };
    if (!job.state) job.state = {};
    const jobState = job.state;
    // Fires the server keeps itself: the daemon's replay of one (its ack was lost) is a duplicate,
    // and only the server's own sweep tries them.
    const owedNow = job.check ? jobState.owedFires ?? [] : [];
    const owed = (e: TriggerFiredEvent) => owedNow.some((o) => sameFire(o, e));
    // The server's own try: an owed fire recorded meanwhile (a copy delivered another way) leaves the list.
    if (opts.owed && owedNow.some((o) => isDuplicateFire(jobState, o))) {
      const left = owedNow.filter((o) => !isDuplicateFire(jobState, o));
      jobState.owedFires = left.length > 0 ? left : undefined;
      await persist(state);
    }
    let fresh = batch.filter((e) => !isDuplicateFire(jobState, e) && (opts.owed ? owed(e) : !owed(e)));
    const duplicateSeqs = batch.filter((e) => !fresh.includes(e)).map((e) => e.seq);
    // A clock run nobody took is run here only when it is this server's to run.
    const supersededSeqs: number[] = [];
    const heldSeqs: number[] = [];
    if (!job.check && head.clock) {
      fresh = fresh.filter((e) => {
        if (isHostDelivery(e.host)) return true;
        const verdict = owedClockVerdict(job, e, opts.fromHost);
        if (verdict.kind === 'run') return true;
        if (verdict.kind === 'held') heldSeqs.push(e.seq);
        else { supersededSeqs.push(e.seq); recordFireSeq(jobState, e); }
        state.deps.log.info('clock run not run here', { jobId: job.id, seq: e.seq, verdict: verdict.kind, reason: verdict.reason });
        return false;
      });
      if (supersededSeqs.length > 0) await persist(state);
    }
    const passed = { duplicateSeqs, supersededSeqs, heldSeqs };
    if (fresh.length === 0) return { duplicate: true as const, job, ...passed };
    // The trigger's delivery is in its long wait: a new fire joins the owed ones untried and is
    // acked, to go with them on the server's next try.
    // A fire its host delivered already is only recorded, as ever: never kept to be sent again,
    // nor held back by the retry clock (nothing is sent for it).
    const recordOnly = fresh.every((e) => isHostDelivery(e.host));
    if (!opts.owed && owedNow.length > 0 && !recordOnly) {
      jobState.owedFires = [...owedNow, ...fresh.map(owedCopy)];
      await persist(state);
      return { joined: fresh.map((e) => e.seq), job, ...passed };
    }
    // A fire waiting out its retry clock: not tried before it is due (fireRetryWaitMs).
    const notDue = recordOnly ? undefined : fireRetryNotDue(jobState, fresh, state.deps.nowMs());
    if (notDue) return { notDue, job, ...passed };
    job.state.runningAtMs = state.deps.nowMs();
    job.state.lastError = undefined;
    await persist(state);
    emit(state, { jobId: job.id, action: 'started', runAtMs: newestAt(fresh, state.deps.nowMs()) });
    return { job, fresh, ...passed };
  });

  if ('found' in phase1) return { found: false, duplicate: false, delivered: false, retry: false };
  const { duplicateSeqs, supersededSeqs, heldSeqs } = phase1;
  const skipped = {
    duplicateSeqs,
    ...(supersededSeqs.length ? { supersededSeqs } : {}),
    ...(heldSeqs.length ? { heldSeqs } : {}),
  };
  if ('duplicate' in phase1) {
    return { found: true, duplicate: true, delivered: false, retry: false, jobName: phase1.job.name, ...skipped };
  }
  if ('joined' in phase1) {
    const lastError = phase1.job.state.lastError;
    const atMs = fireRetryDueAt(phase1.job.state);
    return {
      found: true, duplicate: false, delivered: false, retry: true, waiting: true, owedSeqs: phase1.joined,
      ...(atMs !== undefined ? { nextTryAtMs: atMs } : {}),
      jobName: phase1.job.name, ...(lastError ? { error: lastError } : {}), ...skipped, seq: phase1.joined[0],
    };
  }
  if ('notDue' in phase1) {
    const lastError = phase1.job.state.lastError;
    return {
      found: true, duplicate: false, delivered: false, retry: true, waiting: true, nextTryAtMs: phase1.notDue.atMs,
      jobName: phase1.job.name, ...(lastError ? { error: lastError } : {}), ...skipped, seq: phase1.notDue.seq,
    };
  }

  const { job, fresh } = phase1;
  const identity = fresh[0];
  const startedAt = newestAt(fresh, state.deps.nowMs());
  const firstAtMs = Math.min(...fresh.map((e) => (Number.isFinite(e.atMs) ? e.atMs : startedAt)));
  const itemCount = fresh.reduce((n, e) => n + (e.items?.length ?? 0), 0);
  const newestEvent = fresh.reduce((a, b) => (b.atMs > a.atMs ? b : a));
  // ONE clock for "how late": the envelope is built from it and the audit row
  // records it, so the model and the human are told the same thing.
  const deliveryStartedAt = state.deps.nowMs();
  let result: DeliverResult;
  try {
    let timeoutId: ReturnType<typeof setTimeout>;
    result = await Promise.race([
      deliver(job, fresh, { startedAtMs: deliveryStartedAt }),
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
    const target = state.store?.jobs.find((j) => j.id === head.id) ?? job;
    if (!target.state) target.state = {};

    // Attempt accounting for the trigger's delivery: every fire of one trigger goes to the same
    // place, so the failed tries count for the trigger, whichever fire made them. A transient
    // failure is always a retry; the count only sets how long the next try waits.
    const { chain, chainSeqs } = retryChainOf(target.state, fresh);
    const attempts = (chain ? chain.attempts : 0) + 1;
    const retry = result.status === 'error' && result.retryable === true;
    const nextTryAtMs = retry ? endedAt + fireRetryWaitMs(attempts) : undefined;
    const error = retry && attempts >= FIRE_DELIVERY_FAST_ATTEMPTS
      ? `delivery failed ${attempts} times, trying again at ${new Date(nextTryAtMs!).toISOString()}: ${result.error ?? 'unknown error'}`
      : result.error;

    const clockRun = !!head.clock && !target.check;
    // Read after the delivery: the clock may have changed hands meanwhile.
    const tenure = clockTenureOf(target, identity, opts.fromHost);
    const shouldDelete = clockRun
      ? applyClockRun(target, { status: result.status, error, startedAt, endedAt, retry, tenure, slotsMs: fresh.flatMap((e) => (e.clock ? [e.clock.slotMs] : [])), ...(result.summary ? { summary: result.summary } : {}) })
      : applyJobResult(state, target, {
        status: result.status,
        error,
        startedAt,
        endedAt,
      });
    // A replayed backlog lands after the checks that ran since it was held, so
    // it replaces lastCheck only when it is not older than the one recorded.
    const priorCheckAt = target.state.lastCheck?.atMs;
    if (!clockRun && !(Number.isFinite(priorCheckAt) && priorCheckAt! > startedAt)) {
      target.state.lastCheck = {
        atMs: startedAt,
        outcome: 'fired',
        items: itemCount,
        ...(Number.isFinite(newestEvent.durationMs) ? { durationMs: newestEvent.durationMs } : {}),
        ...(target.check ? { limitSeconds: timeLimitSeconds(target.check) } : {}),
        ...(error ? { error } : {}),
        ...(retry ? { retryPending: true } : {}),
      };
    }
    // The audit line for this fire: what went where, and the text the session got.
    // A replayed attempt of the SAME fire updates its row rather than adding one,
    // so three attempts read as one fire that took three tries. A batch is one
    // row too: one delivery, however many fires it carried.
    const auditEntry = firedAuditEntry({
      atMs: startedAt,
      seq: identity.seq,
      items: itemCount,
      // The authoritative count, not one re-derived from whatever row survived:
      // checkLog is short enough that a slow retry can outlive its own row.
      attempts,
      coalesced: fresh.length,
      firstAtMs,
      deliveredAtMs: Number.isFinite(result.deliveredAtMs) ? result.deliveredAtMs! : deliveryStartedAt,
      ...(Number.isFinite(newestEvent.durationMs) ? { durationMs: newestEvent.durationMs } : {}),
      ...(target.check ? { limitSeconds: timeLimitSeconds(target.check) } : {}),
      ...(error ? { error } : {}),
      delivery: auditDelivery({
        status: result.status,
        retry,
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.delivered?.sessionId ? { sessionId: result.delivered.sessionId } : {}),
      }),
      ...(result.delivered?.text ? { injected: injectedPreview(result.delivered.text) } : {}),
      warnings: fresh.flatMap((e) => (Array.isArray(e.warnings) ? e.warnings : [])),
    });
    // A fire's envelope carries its warnings, so a delivered one has told the session.
    if (result.status === 'ok' && auditEntry.warnings) target.state.warningNoticeAtMs = endedAt;
    // A fire is a check that worked: a "keeps failing" bell an older Walnut left is out of date.
    const recovered = !clockRun && typeof target.state.checkErrorUserNoticeSinceMs === 'number';
    if (recovered) target.state.checkErrorUserNoticeSinceMs = undefined;
    // A check that worked ends a run of checks the machine failed: one found after the run began,
    // never a replay of a fire from before it.
    if (!clockRun && typeof target.state.machineFaultSinceMs === 'number' && newestEvent.atMs > target.state.machineFaultSinceMs) {
      target.state.machineFaultSinceMs = undefined;
    }
    const stamped = { ...auditEntry, ...(identity.epoch ? { epoch: identity.epoch } : {}) };
    target.state.fireLog = mergeFireAttempt(target.state.fireLog, stamped, TRIGGER_FIRE_LOG_MAX);
    // Both lists carry the fire: checkLog is "what has this trigger been doing",
    // and a fire absent from it would read as a gap in the clock. Merged there
    // too, so a replayed attempt updates its row instead of adding one. A clock
    // routine runs no check, so it keeps the fire row alone.
    if (!clockRun) target.state.checkLog = mergeFireAttempt(target.state.checkLog, stamped, TRIGGER_CHECK_LOG_MAX);
    // Counted only when the fire is being recorded (an unacked retry is still the
    // same fire), so the total never double-counts a replay. A trigger that was
    // already firing before this trail existed seeds its total from the daemon's
    // seq (fires in the current epoch) rather than claiming this is its first.
    if (!retry) {
      const seeded = target.state.fireCount ?? (typeof target.state.lastFireSeq === 'number' ? target.state.lastFireSeq : 0);
      target.state.fireCount = seeded + fresh.length;
    }
    const freshSeqs = fresh.map((e) => e.seq);
    let owedSeqs: number[] | undefined;
    if (retry) {
      // Not recorded as processed: the replay must pass the dedup again.
      const seqs = [...new Set([...chainSeqs, ...freshSeqs])].sort((a, b) => a - b);
      target.state.fireRetry = {
        ...(identity.epoch ? { epoch: identity.epoch } : {}),
        seq: seqs[0] ?? identity.seq,
        attempts,
        seqs,
        lastTryAtMs: endedAt,
      };
      // Past the fast tries a check's fires are kept here and acked: the daemon's list of unacked
      // fires is capped (PENDING_FIRES_MAX) and drops the oldest, which would lose them.
      if (!clockRun && target.check && attempts >= FIRE_DELIVERY_FAST_ATTEMPTS && fresh.every((e) => !isHostDelivery(e.host))) {
        const kept = target.state.owedFires ?? [];
        const added = fresh.filter((e) => !kept.some((o) => sameFire(o, e)));
        target.state.owedFires = [...kept, ...added.map(owedCopy)];
        owedSeqs = added.map((e) => e.seq);
      }
    } else {
      // Recorded on success and on a refusal: the daemon is about to be acked
      // in both cases (owed fires were acked already).
      for (const event of fresh) recordFireSeq(target.state, event);
      const left = (target.state.owedFires ?? []).filter((o) => !fresh.some((e) => sameFire(o, e)));
      target.state.owedFires = left.length > 0 ? left : undefined;
      // The trigger's delivery worked (or was refused for good): fires still waiting are tried at
      // once. A fire its host delivered says nothing of this server's delivery: the clock stays.
      if (fresh.some((e) => !isHostDelivery(e.host))) target.state.fireRetry = undefined;
    }
    // The daemon's next check. A clock routine's next slot is its owner's
    // (clock-fire.ts): the host's report while it holds the clock, else the
    // server's own, moved past a slot this run covered.
    const nextRun = Math.max(...batch.map((e) => (Number.isFinite(e.nextRunAtMs) ? e.nextRunAtMs : Number.NEGATIVE_INFINITY)));
    if (!clockRun) {
      target.state.nextRunAtMs = target.enabled && Number.isFinite(nextRun) ? nextRun : undefined;
    } else if (!retry && !shouldDelete) {
      const ranAtMs = Number.isFinite(result.deliveredAtMs) ? result.deliveredAtMs! : endedAt;
      settleClockNext(state, target, { tenure, reportedNext: Number.isFinite(nextRun) ? nextRun : undefined, ranAtMs });
    }
    if (shouldDelete && state.store) {
      state.store.jobs = state.store.jobs.filter((j) => j.id !== target.id);
    }
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
    if (shouldDelete) emit(state, { jobId: target.id, action: 'removed' });
    return {
      found: true,
      duplicate: false,
      delivered: result.status === 'ok',
      retry,
      ...(nextTryAtMs !== undefined ? { nextTryAtMs, attempts } : {}),
      ...(owedSeqs?.length ? { owedSeqs } : {}),
      jobName: target.name,
      status: result.status,
      ...(error ? { error } : {}),
      ...(result.summary ? { summary: result.summary } : {}),
      ...skipped,
      seq: identity.seq,
      ...(recovered ? { recovered } : {}),
    };
  });
}

/**
 * The trigger's retry chain: its failed tries in a row, whichever fires they carried (every fire of
 * one trigger goes to the same place, so a new fire waits out the chain's clock too, and several
 * unacked fires never restart each other's count). `chainSeqs` are the waiting fires of the same
 * epoch as these (another epoch numbers its fires apart).
 */
function retryChainOf(s: CronJob['state'], fresh: readonly TriggerFiredEvent[]) {
  const head = fresh[0];
  const chain = s.fireRetry;
  const sameEpoch = !!chain && !!head && (chain.epoch ?? '') === (head.epoch ?? '');
  const chainSeqs = chain && sameEpoch ? chain.seqs ?? [chain.seq] : [];
  return { chain, chainSeqs };
}

/** When the trigger's next delivery try is due, if it waits for one. */
export function fireRetryDueAt(s: CronJob['state'] | undefined): number | undefined {
  const chain = s?.fireRetry;
  const last = chain?.lastTryAtMs;
  if (!chain || typeof last !== 'number' || !Number.isFinite(last)) return undefined;
  return last + fireRetryWaitMs(chain.attempts);
}

/**
 * When the trigger's next try is not due yet: when it is. A last try dated after now (the clock
 * moved back) is not waited on.
 */
function fireRetryNotDue(s: CronJob['state'], fresh: readonly TriggerFiredEvent[], nowMs: number): { atMs: number; seq: number } | undefined {
  const last = s.fireRetry?.lastTryAtMs;
  const atMs = fireRetryDueAt(s);
  if (atMs === undefined || nowMs < last!) return undefined;
  return nowMs < atMs ? { atMs, seq: s.fireRetry!.seq ?? fresh[0]?.seq } : undefined;
}

/** One daemon fire: its trigger, numbering and number. */
function sameFire(a: { id: string; epoch?: string; seq: number }, b: { id: string; epoch?: string; seq: number }): boolean {
  return a.id === b.id && (a.epoch ?? '') === (b.epoch ?? '') && a.seq === b.seq;
}

/** A fire as the server keeps it: the daemon's event, without a host's delivery mark or a replay flag. */
function owedCopy(e: TriggerFiredEvent): OwedFire {
  const { host: _host, ...rest } = e;
  const copy = { ...rest } as OwedFire & { replay?: unknown };
  delete copy.replay;
  return copy;
}

/** The newest fire's time: a batch is dated by the moment its backlog ends. */
function newestAt(fires: readonly TriggerFiredEvent[], fallback: number): number {
  const times = fires.map((e) => e.atMs).filter((t) => Number.isFinite(t));
  return times.length ? Math.max(...times) : fallback;
}
