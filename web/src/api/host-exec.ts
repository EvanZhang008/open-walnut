/**
 * The user's grants for commands a task runs on another host (server:
 * src/core/hosts/exec-grants.ts, routes/host-exec-v1.ts).
 */
import { apiDelete, apiGet, apiPost, apiPut } from './client';

export interface ExecGrant {
  id: string;
  taskId: string;
  taskTitle: string | null;
  host: string;
  grantedAt: number;
  /** own-host: the task runs on a host the user registered, so no one was asked. */
  via: 'letter' | 'settings' | 'own-host' | 'approvals-off';
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

export function fetchExecGrants(): Promise<{ grants: ExecGrant[]; denied?: ExecDenied[]; closedHosts?: string[] }> {
  return apiGet('/api/v1/host-exec/grants', undefined, { timeoutMs: 10_000, quietStatuses: [404] });
}

export function revokeExecGrant(id: string): Promise<{ grant: ExecGrant }> {
  return apiDelete(`/api/v1/host-exec/grants/${encodeURIComponent(id)}`);
}

export function allowExecGrant(taskId: string, host: string): Promise<{ grant: ExecGrant }> {
  return apiPost('/api/v1/host-exec/grants', { task_id: taskId, host });
}

/** The hard stop for one host: closed, no task from another host starts anything there. */
export function setExecHostClosed(host: string, closed: boolean): Promise<{ closedHosts: string[] }> {
  return apiPut(`/api/v1/host-exec/hosts/${encodeURIComponent(host)}`, { closed });
}
