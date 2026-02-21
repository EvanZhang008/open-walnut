import { apiGet, apiPost, apiPatch, apiDelete } from './client';

export interface InitProcessor {
  actionId: string;
  params?: Record<string, unknown>;
  invokeAgent?: boolean;
  targetAgent?: string;
  targetAgentModel?: string;
  timeoutSeconds?: number;
}

export interface CronAction {
  id: string;
  description: string;
}

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: 'main' | 'isolated';
  wakeMode: 'now' | 'next-cycle';
  initProcessor?: InitProcessor;
  payload: CronPayload;
  delivery?: CronDelivery;
  state: CronJobState;
}

export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

export type CronPayload =
  | { kind: 'systemEvent'; text: string }
  | { kind: 'agentTurn'; message: string; timeoutSeconds?: number };

export type CronDelivery = { mode: 'none' | 'announce'; bestEffort?: boolean };

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
};

export type CronStatusSummary = {
  enabled: boolean;
  storePath: string;
  jobs: number;
  nextWakeAtMs: number | null;
};

export type CreateCronJobInput = {
  name: string;
  description?: string;
  schedule: CronSchedule;
  sessionTarget: 'main' | 'isolated';
  wakeMode: 'now' | 'next-cycle';
  initProcessor?: InitProcessor;
  payload: CronPayload;
  delivery?: CronDelivery;
  enabled?: boolean;
};

export type UpdateCronJobInput = Partial<CreateCronJobInput> & {
  initProcessor?: InitProcessor | null; // null = remove
};

export async function fetchCronJobs(includeDisabled = false): Promise<CronJob[]> {
  const params = includeDisabled ? { includeDisabled: 'true' } : undefined;
  const res = await apiGet<{ jobs: CronJob[] }>('/api/cron', params);
  return res.jobs;
}

export async function fetchCronStatus(): Promise<CronStatusSummary> {
  return apiGet<CronStatusSummary>('/api/cron/status');
}

export async function fetchCronJob(id: string): Promise<CronJob> {
  const res = await apiGet<{ job: CronJob }>(`/api/cron/${id}`);
  return res.job;
}

export async function createCronJob(input: CreateCronJobInput): Promise<CronJob> {
  const res = await apiPost<{ job: CronJob }>('/api/cron', input);
  return res.job;
}

export async function updateCronJob(id: string, input: UpdateCronJobInput): Promise<CronJob> {
  const res = await apiPatch<{ job: CronJob }>(`/api/cron/${id}`, input);
  return res.job;
}

export async function deleteCronJob(id: string): Promise<void> {
  await apiDelete(`/api/cron/${id}`);
}

export async function toggleCronJob(id: string): Promise<CronJob> {
  const res = await apiPost<{ job: CronJob }>(`/api/cron/${id}/toggle`);
  return res.job;
}

export async function runCronJob(id: string): Promise<unknown> {
  const res = await apiPost<{ result: unknown }>(`/api/cron/${id}/run`);
  return res.result;
}

export async function fetchCronActions(): Promise<CronAction[]> {
  const res = await apiGet<{ actions: CronAction[] }>('/api/cron/actions');
  return res.actions;
}
