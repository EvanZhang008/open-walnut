/**
 * Task workspaces: the console's calls (server: src/web/routes/workspaces.ts).
 * State itself rides the task row (`task.workspace`) and task:updated.
 */
import { apiGet, apiPost } from './client';
import type { Task } from '@open-walnut/core';
import type { WorkspaceCandidate, WorkspaceProbeSummary } from '../../../src/core/workspaces/types';

export type { WorkspaceCandidate, WorkspaceProbeSummary };

export interface WorkspaceCandidatesAnswer {
  cwd: string;
  host: string;
  candidates: WorkspaceCandidate[];
  /** Set when the host could not give its verdict (offline, older daemon, timeout). */
  degraded?: string;
}

/** The providers that can isolate this folder. Called only when the user turns the option on. */
export function fetchWorkspaceCandidates(cwd: string, host: string | null | undefined): Promise<WorkspaceCandidatesAnswer> {
  return apiGet<WorkspaceCandidatesAnswer>('/api/workspaces/providers', {
    cwd, ...(host ? { host } : {}),
  }, { timeoutMs: 30_000 });
}

export function retryTaskWorkspace(taskId: string): Promise<{ task: Task }> {
  return apiPost<{ task: Task }>(`/api/workspaces/task/${encodeURIComponent(taskId)}/retry`, {});
}

export type WorkspaceRemovalPreview =
  | { degraded?: undefined; probe: WorkspaceProbeSummary; decision: { action: 'remove' | 'keep' | 'confirm'; requireMerged: boolean; reason?: string; plan: string[] } }
  /** The host did not answer in time: nothing was checked, the user tries again. */
  | { degraded: 'timeout'; error: string };

export function fetchWorkspaceRemoval(taskId: string): Promise<WorkspaceRemovalPreview> {
  return apiGet<WorkspaceRemovalPreview>(`/api/workspaces/task/${encodeURIComponent(taskId)}/removal`, undefined, { timeoutMs: 30_000 });
}

/** Answers at once; the host checks again and the task row says how it went. */
export function removeTaskWorkspace(taskId: string): Promise<{ task: Task }> {
  return apiPost<{ task: Task }>(`/api/workspaces/task/${encodeURIComponent(taskId)}/remove`, {});
}
