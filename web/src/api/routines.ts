/**
 * Routines API — canonical /api/routines surface.
 *
 * A routine is a cron job + an `executor` ref (which decides where the
 * instructions run: main-agent / walnut-agent / claude-code). Legacy
 * sessionTarget/payload fields still exist on the wire for back-compat but
 * the UI reads/writes `executor`.
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

export type RoutineState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
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
  state: RoutineState;
}

export interface ExecutorFieldSpec {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'number' | 'path';
  required?: boolean;
  placeholder?: string;
  optionsKey?: 'hosts' | 'models';
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

export async function fetchExecutors(): Promise<{ executors: ExecutorInfo[]; options: ExecutorOptions }> {
  return apiGet<{ executors: ExecutorInfo[]; options: ExecutorOptions }>('/api/routines/executors');
}

/** NL → populated draft. Throws with the server's error message on 422. */
export async function draftRoutine(text: string): Promise<CreateRoutineInput> {
  const res = await apiPost<{ draft: CreateRoutineInput }>('/api/routines/draft', { text });
  return res.draft;
}
