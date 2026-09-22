/**
 * Cron job types — adapted from moltbot/src/cron/types.ts
 * Simplified for Walnut's single-process model (no agentId, no multi-channel delivery).
 */

import type { SubsystemLogger } from '../../logging/index.js';

// ── Schedule: three kinds ──

export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

// ── Session target ──

export type CronSessionTarget = 'main' | 'isolated';

// ── Wake: the counter half of a routine's trigger ──

/**
 * A second, INDEPENDENT reason to run: enough new items arrived. Deliberately
 * not a fourth `CronSchedule` kind — a schedule must answer "when is the next
 * run", and a counter has no answer to that. The clock and the counter sit side
 * by side: `schedule` still drives the timed run, `wake` runs the job early.
 *
 * The subscription that FEEDS the counter lives in the routines layer
 * (src/core/routines/wake-events.ts). The cron engine never imports the event
 * bus, which is what keeps it testable with nothing but an injected clock.
 */
export type CronWake = {
  /**
   * EXACT bus event names ('plugin:mail:messages-received'). Not prefixes: a
   * prefix would count every sibling event a plugin emits
   * (plugin:mail:draft-changed) as a new item to process.
   */
  events: string[];
  /** Numeric payload field to add per event; absent = +1 per event. */
  countField?: string;
  /** Run as soon as the counter reaches this. 0 = clock only. */
  threshold: number;
  /** A timed run whose counter is 0 is skipped instead of dispatched. */
  skipWhenIdle?: boolean;
};

// ── Check (walnut-trigger) ──

/**
 * A trigger: the routine's `check` script, run by the DAEMON on `host` on the
 * schedule's interval. The daemon owns the clock, the run and the dedup state;
 * the server only stores this, pushes it, and delivers the fires it reports.
 * See docs/plan/walnut-trigger.md.
 */
export type TriggerCheck = {
  /** Shell command. Reads `{state,lastFireAt,now}` on stdin, prints one JSON line. */
  run: string;
  cwd?: string;
  /** Which daemon runs it. '__local__' = this machine. Never optional in a
   *  stored job: a check with no host has nowhere to run. */
  host: string;
  timeoutSeconds?: number;
  maxFiresPerDay?: number;
};

/** Where a fire ended up. `retrying` = still owned by the daemon, not a failure. */
export type TriggerAuditDelivery = {
  status: 'ok' | 'error' | 'retrying';
  /** The executor's own sentence ("sent to session …", "resumed …"). */
  summary?: string;
  /** The session that received it, when one was picked (absent for a fresh start). */
  sessionId?: string;
  error?: string;
};

/**
 * One line of a trigger's audit trail (src/core/cron/trigger-audit.ts). A quiet
 * or failed check carries the verdict only; a fire also carries where it went and
 * a preview of the exact text the session received.
 */
export type TriggerAuditEntry = {
  atMs: number;
  outcome: 'fired' | 'quiet' | 'error';
  reason?: 'fire-false' | 'all-seen' | 'rate-limited';
  items?: number;
  durationMs?: number;
  error?: string;
  /** Fires only: the daemon's (epoch, seq) for this fire. */
  seq?: number;
  epoch?: string;
  /** Fires only: how many delivery attempts this ONE fire took. */
  attempts?: number;
  /** Fires only. */
  delivery?: TriggerAuditDelivery;
  /** Fires only: the message the session actually received, clamped. */
  injected?: { chars: number; preview: string };
};

/** The daemon's last report about a check, for the card and the error counter. */
export type TriggerLastCheck = {
  atMs: number;
  outcome: 'fired' | 'quiet' | 'error';
  reason?: 'fire-false' | 'all-seen' | 'rate-limited';
  items?: number;
  error?: string;
  durationMs?: number;
  /** A fired check whose delivery failed transiently; the daemon will replay it. */
  retryPending?: boolean;
};

// ── Executor (routines layer) ──
//
// Base shapes live here (not in ../routines/) so the cron engine can reference
// them without a circular import. The routines module re-exports them and adds
// the registry/definition machinery.

/** Which executor runs this job + its type-specific config. */
export type RoutineExecutorRef = {
  type: string;
  config: Record<string, unknown>;
};

export type ExecutorRunResult = {
  status: 'ok' | 'error';
  summary?: string;
  error?: string;
  /**
   * The failure was transient (a throw, a timeout, an unreachable host) and the
   * same message may be delivered again later. A deliberate refusal (the target
   * task is complete, the config is invalid) leaves this unset: retrying it
   * would only repeat the refusal.
   */
  retryable?: boolean;
  /**
   * What a trigger's delivery actually did, for the audit trail: which session
   * received it and the exact text it was handed. The executor is the only layer
   * that knows both (it picks the session and builds the envelope).
   */
  delivered?: { sessionId?: string; text?: string };
};

/** Injected by the server: dispatches a due job to its executor implementation. */
export type RunExecutorFn = (
  job: CronJob,
  executor: RoutineExecutorRef,
  message: string,
) => Promise<ExecutorRunResult>;

// ── Wake mode ──

export type CronWakeMode = 'now' | 'next-cycle';

// ── Init Processor (optional pre-step action) ──

export interface InitProcessor {
  actionId: string;
  params?: Record<string, unknown>;
  invokeAgent?: boolean;            // pipe output to session target (default: true)
  targetAgent?: string;             // specific subagent (bypasses payload flow)
  targetAgentModel?: string;        // model override for target agent
  timeoutSeconds?: number;
}

export type InitProcessorPatch = Partial<InitProcessor> | null; // null = remove

// ── Payload ──

export type CronPayload =
  | { kind: 'systemEvent'; text: string }
  | { kind: 'agentTurn'; message: string; timeoutSeconds?: number };

export type CronPayloadPatch =
  | { kind: 'systemEvent'; text?: string }
  | { kind: 'agentTurn'; message?: string; timeoutSeconds?: number };

// ── Delivery (for isolated jobs) ──

export type CronDeliveryMode = 'none' | 'announce';

export type CronDelivery = {
  mode: CronDeliveryMode;
  bestEffort?: boolean;
};

// ── Runtime state ──

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  /** Check jobs only: what the daemon reported about the most recent run. */
  lastCheck?: TriggerLastCheck;
  /**
   * Check jobs only: the highest fire already processed, as (epoch, seq). The
   * daemon's seq restarts at 0 whenever its state file is recreated (a reboot
   * that cleared its dir, a very old daemon re-arming); the epoch it mints with
   * that file tells the server to start its mark over instead of swallowing the
   * next N fires as replays. `lastFireEpoch` is absent for a pre-epoch daemon.
   */
  lastFireSeq?: number;
  lastFireEpoch?: string;
  /**
   * Check jobs only: a fire whose delivery failed for a transient reason (the
   * target host unreachable, the send timing out) is NOT acked, so the daemon
   * replays it; this counts the attempts so a permanently failing delivery is
   * given up on (recorded, acked, notified) instead of retried forever.
   */
  fireRetry?: { epoch?: string; seq: number; attempts: number };
  /**
   * Check jobs only: recorded fire seqs ABOVE `lastFireSeq`, which is the highest
   * CONTIGUOUS one. Fires are not processed in order (see isDuplicateFire), so a
   * plain high-water mark would judge a slow retry of an earlier seq a duplicate
   * and drop its items.
   */
  fireSeqsDone?: number[];
  /**
   * Check jobs only: the audit trail. `lastCheck` is one snapshot and cannot
   * answer "did this ever fire, and what did it inject" — these can. Newest
   * first, both bounded (trigger-audit.ts): checkLog is recent activity of any
   * outcome, fireLog is the fires with their delivery and injected preview.
   */
  checkLog?: TriggerAuditEntry[];
  fireLog?: TriggerAuditEntry[];
  /** Check jobs only: total fires ever, which the bounded fireLog cannot report. */
  fireCount?: number;
  /**
   * Wake jobs only: counted events that have arrived since the last run.
   *
   * RUNTIME state on purpose, so it rides the machine-local cron-state.json
   * sidecar and never the git-synced definitions file — a counter echoing back
   * from another box firing a job here is the 2026-08-04 storm in a new costume.
   *
   * A run SUBTRACTS the value it observed at dispatch rather than zeroing this
   * (applyJobResult): an event that arrived mid-run belongs to the next batch.
   */
  wakeCount?: number;
  /** Wake jobs only: when the counter was last bumped. */
  wakeLastAtMs?: number;
};

// ── The job itself ──

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  initProcessor?: InitProcessor;
  payload: CronPayload;
  delivery?: CronDelivery;
  /**
   * Routines layer: which executor runs this job. Kept in sync with the legacy
   * sessionTarget/payload fields (both directions) so old binaries/tools keep
   * working. Canonical source of the instructions text when present.
   */
  executor?: RoutineExecutorRef;
  /**
   * Present = this routine is a TRIGGER: the daemon on `check.host` decides
   * whether it fires, so the server's timer never ticks it and its
   * `state.nextRunAtMs` is whatever that daemon last reported.
   */
  check?: TriggerCheck;
  /**
   * Present = this routine ALSO runs on a count of events, not just its clock.
   * Mutually exclusive with `check`: a check trigger already decides its own
   * fires on its host, so a server-side counter next to it would be a second,
   * disagreeing answer to the same question.
   */
  wake?: CronWake;
  state: CronJobState;
};

export type CronStoreFile = {
  version: 1 | 2;
  jobs: CronJob[];
};

/**
 * On-disk sidecar (cron-state.json, next to cron-jobs.json) holding per-job
 * runtime state. Machine-local and gitignored: job definitions sync between
 * machines via the git data repo, runtime state must NOT — a synced stale
 * nextRunAtMs echoing back from another box re-fires jobs (2026-08-04 storm).
 */
export type CronStateFile = {
  version: 1;
  states: Record<string, CronJobState>;
};

export type CronJobCreate = Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state' | 'sessionTarget' | 'payload'> & {
  state?: Partial<CronJobState>;
  /** Legacy fields — optional when `executor` is provided (derived from it). */
  sessionTarget?: CronSessionTarget;
  payload?: CronPayload;
};

export type CronJobPatch = Partial<Omit<CronJob, 'id' | 'createdAtMs' | 'state' | 'payload' | 'initProcessor' | 'check' | 'wake'>> & {
  initProcessor?: InitProcessorPatch;
  payload?: CronPayloadPatch;
  delivery?: Partial<CronDelivery>;
  state?: Partial<CronJobState>;
  executor?: RoutineExecutorRef;
  /** `null` turns a trigger back into a plain time-only routine. */
  check?: TriggerCheck | null;
  /**
   * `null` clears the counter trigger; ABSENT leaves it alone. The routine form
   * does not render `wake`, so its save must not be able to erase one.
   */
  wake?: CronWake | null;
};

// ── Events ──

export type CronEvent = {
  jobId: string;
  action: 'added' | 'updated' | 'removed' | 'started' | 'finished';
  runAtMs?: number;
  durationMs?: number;
  status?: 'ok' | 'error' | 'skipped';
  error?: string;
  summary?: string;
  nextRunAtMs?: number;
};

// ── Dependency injection ──

export type CronServiceDeps = {
  nowMs?: () => number;
  log: SubsystemLogger;
  storePath: string;
  cronEnabled: boolean;
  broadcastCronNotification: (text: string, jobName: string, opts?: { agentWillRespond?: boolean }) => Promise<void>;
  queueCronNotificationForAgent?: (text: string, jobName: string) => void;
  runMainAgentWithPrompt: (prompt: string, jobName: string) => Promise<void>;
  runIsolatedAgentJob: (params: { job: CronJob; message: string }) => Promise<{
    status: 'ok' | 'error';
    summary?: string;
    error?: string;
  }>;
  /**
   * Routines layer: dispatch a due job to its registered executor. When
   * provided, this supersedes runMainAgentWithPrompt/runIsolatedAgentJob for
   * job dispatch (those remain for the announce/delivery path and as the
   * fallback when no executor registry is wired, e.g. in unit tests).
   */
  runExecutor?: RunExecutorFn;
  runAction?: (actionId: string, params: Record<string, unknown>) => Promise<{
    status: 'ok' | 'error';
    summary?: string;
    error?: string;
    data?: unknown;
  }>;
  onEvent?: (evt: CronEvent) => void;
};

export type CronServiceDepsInternal = Omit<CronServiceDeps, 'nowMs'> & {
  nowMs: () => number;
};

// ── Internal state ──

export type CronServiceState = {
  deps: CronServiceDepsInternal;
  store: CronStoreFile | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  op: Promise<unknown>;
  warnedDisabled: boolean;
  /**
   * In-memory replay guard: jobId → earliest ms a subsequent run may start
   * (null = no future runs, e.g. a finished one-shot). Never persisted — it is
   * this process's own memory of what it already executed, so a cron store
   * file that gets reverted by an external writer (a second server process, a
   * git-sync echo of an older snapshot) cannot re-fire a slot that already
   * ran. 2026-08-04 incident: the daily-report job re-fired ~19× in one day
   * because the shared store kept flapping back to a due state. Cleared when
   * the user edits the job's schedule/enabled state or removes the job.
   * Optional so hand-built test states don't break; access via replayGuardOf().
   */
  replayGuard?: Map<string, number | null>;
};

// ── Result types ──

export type CronStatusSummary = {
  enabled: boolean;
  storePath: string;
  jobs: number;
  nextWakeAtMs: number | null;
};

export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; ran: false; reason: 'not-due' }
  | { ok: true; ran: false; reason: 'already-running' }
  | { ok: false };
