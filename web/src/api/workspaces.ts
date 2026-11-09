/**
 * Task workspaces: the console's calls (server: src/web/routes/workspaces.ts).
 * State itself rides the task row (`task.workspace`) and task:updated.
 */
import { apiGet, apiPost, apiPut } from './client';
import type { Task } from '@open-walnut/core';
import type { ProjectScript, ResolvedProjectScript, WorkspaceCandidate, WorkspaceProbeSummary } from '../../../src/core/workspaces/types';

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

// ── project scripts (src/core/workspaces/scripts.ts) ──


export type { ProjectScript, ResolvedProjectScript };

export interface ScriptsAnswer {
  /** Where the scripts run: the workspace root, or the folder's git top. */
  dir?: string;
  host: string;
  /** The project whose own list this is (absent: the task has none). */
  project?: string;
  scripts: ResolvedProjectScript[];
  /** The repository's file, when there is one (its read or parse error too). */
  file?: { name: string; path: string; hash?: string; key?: string; ref?: string; error?: string; warnings?: string[] };
  /** Why the repository's file could not be looked at (offline host, older daemon). */
  file_unavailable?: string;
  /** The user allowed this exact file to run its setup and teardown by itself. */
  file_trusted?: boolean;
  setup?: string;
  teardown?: string;
  /** A session in the task's workspace: scripts run at its root. */
  workspace_root?: string;
}

/** The scripts for a session, a task, or a project (with an optional folder). */
export function fetchScripts(q: { session?: string; task?: string; project?: string; cwd?: string; host?: string | null; ref?: string }): Promise<ScriptsAnswer> {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) if (typeof v === 'string' && v) params[k] = v;
  return apiGet<ScriptsAnswer>('/api/workspaces/scripts', params, { timeoutMs: 35_000 });
}

/** Save the project's own list (the server validates it and answers the stored form). */
export function saveProjectScripts(project: string, scripts: Array<Omit<ProjectScript, 'id'> & { id?: string }>): Promise<{ project: string; scripts: ProjectScript[] }> {
  return apiPut<{ project: string; scripts: ProjectScript[] }>(`/api/workspaces/scripts/project/${encodeURIComponent(project)}`, { scripts });
}

/** Run the task's setup script again; answers once the row says it runs. `allow`: and let its walnut.json run by itself from now on. */
export function rerunTaskSetup(taskId: string, opts: { allow?: boolean; expectHash?: string } = {}): Promise<{ task: Task }> {
  return apiPost<{ task: Task }>(`/api/workspaces/task/${encodeURIComponent(taskId)}/setup`, {
    ...(opts.allow ? { allow: true } : {}), ...(opts.expectHash ? { expect_hash: opts.expectHash } : {}),
  });
}

/** A failed setup held the session: start it anyway. */
/** Give up the start that waits for the task's workspace (the waiting column's Dismiss). */
export function cancelWorkspaceStart(taskId: string): Promise<{ task: Task }> {
  return apiPost<{ task: Task }>(`/api/workspaces/task/${encodeURIComponent(taskId)}/cancel-start`, {});
}

export function startTaskAnyway(taskId: string): Promise<{ task: Task }> {
  return apiPost<{ task: Task }>(`/api/workspaces/task/${encodeURIComponent(taskId)}/start-anyway`, {});
}

/** Let this walnut.json (its `file.key` from fetchScripts: this content in this repository) run its setup and teardown by itself. */
export function allowScriptsFile(key: string): Promise<{ allowed: string }> {
  return apiPost<{ allowed: string }>('/api/workspaces/scripts/trust', { key });
}
