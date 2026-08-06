/**
 * Project API client — Project is the single grouping layer.
 *
 * Inbox is the ABSENCE of a project ('' on the task). It has no registry row, so
 * it is never in `projects[]`, never renamable/deletable, and never claimable —
 * its task counts ride along as the separate `inbox` field of the list response.
 *
 * Names can contain slashes and '%', so every path segment is
 * encodeURIComponent'd and the rename target rides in the request BODY.
 */

import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from './client';

export interface ProjectCounts {
  todo: number;
  active: number;
  done: number;
}

/** Registry-row settings blob (`task_projects.metadata`). */
export interface ProjectMetadata {
  default_cwd?: string;
  default_host?: string;
  /** Fast-model project summary (project-summary.ts), regenerated at task-count thresholds. */
  summary?: string;
  summary_task_count?: number;
  /** MS To-Do list alias — a migrated project keeps pushing to its old "Cat / Proj" list. */
  remote_list?: string;
  /** Archived pre-refactor category name(s) this project inherited. Not displayed. */
  legacy_category?: string | string[];
  [key: string]: unknown;
}

export interface ProjectSummary {
  name: string;
  /** 'local' or a plugin id ('ms-todo', 'jira', …). At most ONE claim per project. */
  source: string;
  order_index?: number;
  metadata?: ProjectMetadata;
  /** Folded in from config.favorites.projects so the UI needs no second call. */
  favorite: boolean;
  counts: ProjectCounts;
}

export interface ProjectListResponse {
  projects: ProjectSummary[];
  /** Inbox has no registry row — only counts. */
  inbox: { counts: ProjectCounts };
}

export interface ProjectDetail {
  /** Canonical spelling from the registry (project identity is case-insensitive). */
  name: string;
  source: string;
  metadata: ProjectMetadata;
  /** MEMORY.md header for memory/projects/<project>/, or null. */
  memorySummary: string | null;
  counts: ProjectCounts;
}

export function fetchProjects(): Promise<ProjectListResponse> {
  return apiGet<ProjectListResponse>('/api/projects');
}

/**
 * Create a project registry row. IDEMPOTENT: an existing name resolves with
 * `created: false` and the EXISTING row's source — a second caller can never
 * steal another provider's claim.
 */
export function createProject(name: string, source?: string): Promise<{ name: string; source: string; created: boolean }> {
  return apiPost('/api/projects', { name, ...(source ? { source } : {}) });
}

/** Rename (merges into the target on collision, case-insensitively). */
export function renameProject(from: string, to: string): Promise<{ count: number; merged: boolean }> {
  return apiPatch(`/api/projects/${encodeURIComponent(from)}`, { name: to });
}

export interface DeleteProjectResult {
  project: string;
  movedToInbox: number;
  /** 'grouping-removed' cascade — tasks moved to the provider's fallback project, binding kept. */
  movedToProject?: { project: string; count: number };
  remoteDeleted: boolean;
  source: string;
}

/**
 * Delete the registry row; its tasks fall back to Inbox.
 *
 * A provider-claimed project without `remote: true` rejects with 409 (the remote
 * container still exists — the next pull would just recreate the row). The 409
 * body's `cascade_available` says whether the plugin supports the cascade.
 * `remote: true` opts into it: the plugin deletes the remote container
 * (IRREVERSIBLE — MS To-Do deletes the list itself), so the UI must confirm first.
 */
export function deleteProject(name: string, opts?: { remote?: boolean }): Promise<DeleteProjectResult> {
  const qs = opts?.remote ? '?remote=1' : '';
  return apiDelete<DeleteProjectResult>(`/api/projects/${encodeURIComponent(name)}${qs}`);
}

/** Everything the detail pane needs in one call. */
export function fetchProjectDetail(name: string): Promise<ProjectDetail> {
  return apiGet<ProjectDetail>(`/api/projects/${encodeURIComponent(name)}/metadata`);
}

/**
 * MERGE settings into the registry row. Returns the merged blob.
 *
 * Clear a field with `null`, never `undefined`: JSON.stringify DROPS undefined
 * properties, so an `{field: undefined}` body serializes to `{}` and the merge is
 * a silent no-op (the old value comes right back and the clear looks like a
 * self-revert). The route maps `null` → delete-key.
 */
export function saveProjectMetadata(
  name: string,
  settings: Record<string, unknown>,
): Promise<ProjectMetadata> {
  return apiPut<ProjectMetadata>(`/api/projects/${encodeURIComponent(name)}/metadata`, settings);
}

/** Rebuild the fast-model summary on demand. Rejects 422 when it produced nothing. */
export function regenerateProjectSummary(name: string): Promise<{ summary: string | null; summary_task_count: number | null }> {
  return apiPost(`/api/projects/${encodeURIComponent(name)}/summary/regenerate`);
}
