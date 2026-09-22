/**
 * Routines API — canonical /api/routines surface.
 *
 * A routine is a cron job + an `executor` ref (which decides where the
 * instructions run; `claude-code` is the one the UI offers). A stored job may
 * still name a retired executor type, and legacy sessionTarget/payload fields
 * still exist on the wire for back-compat, but the UI reads/writes `executor`.
 */

import { apiGet, apiPost, apiPatch, apiDelete } from './client';

export type RoutineSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

export type RoutineExecutorRef = {
  type: string;
  config: Record<string, unknown> & {
    instructions?: string;
    cwd?: string;
    host?: string;
    model?: string;
    taskTitle?: string;
    timeoutSeconds?: number;
  };
};

/**
 * walnut-trigger: a shell command the daemon on `host` runs every tick. Its
 * last stdout line decides whether the routine fires (docs/plan/walnut-trigger.md).
 */
export type RoutineCheck = {
  run: string;
  cwd?: string;
  host: string;
  timeoutSeconds?: number;
  maxFiresPerDay?: number;
};

/**
 * The counter half of a routine's trigger: it also runs once this many counted
 * events have arrived (server: src/core/cron/types.ts CronWake). Read-only in
 * the UI — the form shows it and must never erase it, which is why a save omits
 * the field entirely rather than sending it back.
 */
export type RoutineWake = {
  events: string[];
  countField?: string;
  threshold: number;
  skipWhenIdle?: boolean;
};

export type RoutineLastCheck = {
  atMs: number;
  outcome: 'fired' | 'quiet' | 'error';
  reason?: 'fire-false' | 'all-seen' | 'rate-limited';
  items?: number;
  error?: string;
  durationMs?: number;
  /** A fire whose delivery failed transiently; the daemon will replay it. */
  retryPending?: boolean;
};

/** Where a fire ended up. `retrying` = the daemon still owns it, not a failure. */
export type RoutineAuditDelivery = {
  status: 'ok' | 'error' | 'retrying';
  summary?: string;
  sessionId?: string;
  error?: string;
};

/**
 * One line of a trigger's audit trail (server: src/core/cron/trigger-audit.ts).
 * A quiet or failed check carries the verdict; a fire also carries where it went
 * and a preview of the exact text the session received.
 */
export type RoutineAuditEntry = {
  atMs: number;
  outcome: 'fired' | 'quiet' | 'error';
  reason?: 'fire-false' | 'all-seen' | 'rate-limited';
  items?: number;
  durationMs?: number;
  error?: string;
  seq?: number;
  epoch?: string;
  attempts?: number;
  delivery?: RoutineAuditDelivery;
  injected?: { chars: number; preview: string };
};

export type RoutineState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastCheck?: RoutineLastCheck;
  /** Trigger audit trail, newest first: recent checks of any outcome. */
  checkLog?: RoutineAuditEntry[];
  /** Trigger audit trail, newest first: the fires with their delivery. */
  fireLog?: RoutineAuditEntry[];
  /** Total fires ever — the bounded fireLog cannot report it. */
  fireCount?: number;
  /** The daemon's highest processed fire seq: a floor on the count for a trigger
   *  that was already firing before the audit trail existed. */
  lastFireSeq?: number;
  /** Wake routines: counted events waiting for the next run. */
  wakeCount?: number;
  wakeLastAtMs?: number;
};

export interface Routine {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: RoutineSchedule;
  wakeMode: 'now' | 'next-cycle';
  executor?: RoutineExecutorRef;
  check?: RoutineCheck;
  wake?: RoutineWake;
  state: RoutineState;
}

export interface RoutineCheckTestResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  parsed: { fire: boolean; items?: Array<{ id: string }>; input?: string } | null;
  error: string | null;
  wouldFire: boolean;
  newItemCount: number;
}

export interface ExecutorFieldSpec {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'number' | 'path';
  required?: boolean;
  placeholder?: string;
  optionsKey?: 'hosts' | 'models';
  /** `number` fields only; defaults to 1. 0 where zero is a real setting. */
  min?: number;
}

export interface ExecutorInfo {
  type: string;
  label: string;
  description: string;
  configSchema: ExecutorFieldSpec[];
}

export interface ExecutorOptions {
  hosts: Array<{ value: string; label: string }>;
  models: Array<{ value: string; label: string }>;
}

export type CreateRoutineInput = {
  name: string;
  description?: string;
  schedule: RoutineSchedule;
  executor: RoutineExecutorRef;
  /** `null` on update clears an existing check. */
  check?: RoutineCheck | null;
  /**
   * `null` on update clears the counter trigger. OMIT it to leave a stored one
   * alone: the server merges by key presence, so an absent `wake` is what lets
   * the form save a routine whose counter it does not render.
   */
  wake?: RoutineWake | null;
  wakeMode?: 'now' | 'next-cycle';
  enabled?: boolean;
};

export type UpdateRoutineInput = Partial<CreateRoutineInput>;

export async function fetchRoutines(includeDisabled = true): Promise<Routine[]> {
  const params = includeDisabled ? { includeDisabled: 'true' } : undefined;
  const res = await apiGet<{ jobs: Routine[] }>('/api/routines', params);
  return res.jobs;
}

export async function createRoutine(input: CreateRoutineInput): Promise<Routine> {
  const res = await apiPost<{ job: Routine }>('/api/routines', input);
  return res.job;
}

export async function updateRoutine(id: string, input: UpdateRoutineInput): Promise<Routine> {
  const res = await apiPatch<{ job: Routine }>(`/api/routines/${id}`, input);
  return res.job;
}

export async function deleteRoutine(id: string): Promise<void> {
  await apiDelete(`/api/routines/${id}`);
}

export async function toggleRoutine(id: string): Promise<Routine> {
  const res = await apiPost<{ job: Routine }>(`/api/routines/${id}/toggle`);
  return res.job;
}

export async function runRoutine(id: string): Promise<unknown> {
  const res = await apiPost<{ result: unknown }>(`/api/routines/${id}/run`);
  return res.result;
}

/** Run a check once on its host, writing no state. Throws with the server's reason (cold or old daemon). */
export async function testRoutineCheck(
  check: Pick<RoutineCheck, 'run'> & Partial<RoutineCheck>,
  id?: string,
): Promise<RoutineCheckTestResult> {
  const res = await apiPost<{ result: RoutineCheckTestResult }>('/api/routines/check-test', { check, ...(id ? { id } : {}) });
  return res.result;
}

export async function fetchExecutors(): Promise<{ executors: ExecutorInfo[]; options: ExecutorOptions }> {
  return apiGet<{ executors: ExecutorInfo[]; options: ExecutorOptions }>('/api/routines/executors');
}

/** NL → populated draft. Throws with the server's error message on 422. */
export async function draftRoutine(text: string): Promise<CreateRoutineInput> {
  const res = await apiPost<{ draft: CreateRoutineInput }>('/api/routines/draft', { text });
  return res.draft;
}
