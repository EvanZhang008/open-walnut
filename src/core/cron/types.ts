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
  state: CronJobState;
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronJobCreate = Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'> & {
  state?: Partial<CronJobState>;
};

export type CronJobPatch = Partial<Omit<CronJob, 'id' | 'createdAtMs' | 'state' | 'payload' | 'initProcessor'>> & {
  initProcessor?: InitProcessorPatch;
  payload?: CronPayloadPatch;
  delivery?: Partial<CronDelivery>;
  state?: Partial<CronJobState>;
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
