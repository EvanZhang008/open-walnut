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

export type CronJobPatch = Partial<Omit<CronJob, 'id' | 'createdAtMs' | 'state' | 'payload' | 'initProcessor'>> & {
  initProcessor?: InitProcessorPatch;
  payload?: CronPayloadPatch;
  delivery?: Partial<CronDelivery>;
  state?: Partial<CronJobState>;
  executor?: RoutineExecutorRef;
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
  runActionWithAgent?: (actionResult: {
    status: 'ok' | 'error'; summary?: string; error?: string; data?: unknown;
  }, agentId: string, modelOverride?: string) => Promise<{
    status: 'ok' | 'error';
    summary?: string;
    error?: string;
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
