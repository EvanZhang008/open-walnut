/**
 * The user's grants for commands a task runs on another host (server:
 * src/core/hosts/exec-grants.ts, routes/host-exec-v1.ts).
 */
import { apiDelete, apiGet, apiPost } from './client';

export interface ExecGrant {
  id: string;
  taskId: string;
  taskTitle: string | null;
  host: string;
  grantedAt: number;
  via: 'letter' | 'settings';
  revokedAt?: number;
  runs: number;
  lastRunAt?: number;
  lastCommand?: string;
}

/** A task the user declined; Allow in Settings grants it after all. */
export interface ExecDenied {
  taskId: string;
  taskTitle: string | null;
  host: string;
  askedAt: number;
  answeredAt: number | null;
}

export function fetchExecGrants(): Promise<{ grants: ExecGrant[]; denied?: ExecDenied[] }> {
  return apiGet('/api/v1/host-exec/grants', undefined, { timeoutMs: 10_000, quietStatuses: [404] });
}

export function revokeExecGrant(id: string): Promise<{ grant: ExecGrant }> {
  return apiDelete(`/api/v1/host-exec/grants/${encodeURIComponent(id)}`);
}

export function allowExecGrant(taskId: string, host: string): Promise<{ grant: ExecGrant }> {
  return apiPost('/api/v1/host-exec/grants', { task_id: taskId, host });
}
