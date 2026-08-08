/**
 * Integration Plugin System — Type Definitions
 *
 * Every integration plugin implements these interfaces.
 * Core never references specific integrations — only talks through the registry.
 */

import type { Task, TaskPhase, TaskPriority } from './types.js';
import type { SubsystemLogger } from '../logging/index.js';
import type { Router } from 'express';

// ── RemoteSyncItem: standardized representation of a remote task for reconciliation ──

export interface RemoteSyncItem {
  /** Join key — must match what extractRemoteId() returns for local tasks. */
  remoteId: string;
  /** Title for logging and fallback matching. */
  title: string;
  /** ISO timestamp — framework uses this to decide who is newer. */
  remoteUpdatedAt: string;
  /** True if the remote item was deleted/archived. */
  deleted?: boolean;
  /** Mapped local fields (including ext) — ready to merge into a Task. */
  fields: Partial<Task>;
}

// ── ExtData: plugin-specific fields written to task.ext ──

export interface ExtData {
  [key: string]: unknown;
}

// ── SyncPollContext: passed to plugins during periodic sync ──

export interface SyncPollContext {
  getTasks(): Task[];
  updateTask(id: string, updates: Partial<Task>): Promise<Task>;
  addTask(data: Omit<Task, 'id'>): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  emit(event: string, data: unknown): void;
}

// ── PushResult: server-side timestamp for echo detection ──

/** Push response — plugins MUST return server-side timestamp for echo detection. */
export interface PushResult {
  /** Server-side last-modified timestamp (ISO string) from the push API response.
   *  Framework stores this as _syncedAt for echo detection on pull. */
  serverTimestamp: string;
  /** Plugin-specific ext data updates (optional). */
  ext?: Record<string, unknown>;
}

// ── IntegrationSync: strict plugin sync interface ──
// Every method is REQUIRED. Plugin maps Walnut's features to platform capabilities.
// Phase is the only status concept — plugins map 7 phases to whatever the platform supports.

export interface IntegrationSync {
  // ── Task Lifecycle ──
  createTask(task: Task): Promise<ExtData | null>;
  deleteTask(task: Task): Promise<void>;

  // ── Field Updates (called individually per mutation) ──
  updateTitle(task: Task, title: string): Promise<void>;
  updateDescription(task: Task, description: string): Promise<void>;
  updateSummary(task: Task, summary: string): Promise<void>;
  updateNote(task: Task, note: string): Promise<void>;
  updateConversationLog(task: Task, log: string): Promise<void>;
  updatePriority(task: Task, priority: TaskPriority): Promise<void>;
  updatePhase(task: Task, phase: TaskPhase): Promise<void>;
  updateDueDate(task: Task, date: string | null): Promise<void>;
  updateStar(task: Task, starred: boolean): Promise<void>;
  /** The task moved to a different project (the single grouping layer). */
  updateProject(task: Task, project: string): Promise<void>;
  updateDependencies(task: Task, dependsOn: string[]): Promise<void>;

  // ── Subtask Relationship (child tasks are full Tasks with parent_task_id) ──
  associateSubtask(parentTask: Task, childTask: Task): Promise<void>;
  disassociateSubtask(parentTask: Task, childTask: Task): Promise<void>;

  // ── Content Validation (optional — reject content before store write) ──
  /** Return error string to reject, null to accept. */
  validateContent?(task: Task, field: string, value: string): string | null;

  /** Human-readable content rule for a field (e.g. "Titles must be in
   *  English"). AI content generators (session auto-title, …) ship it in
   *  their FIRST generation prompt so content is born compliant, instead of
   *  being rejected by validateContent after the fact and regenerated.
   *  Plugins enforcing a rule should implement BOTH: this to prevent,
   *  validateContent to enforce. Return null when the field has no rule. */
  contentRequirement?(field: string): string | null;

  // ── Full Push (single-call push with server timestamp for echo detection) ──
  /** Push all mutable fields to remote. Returns server-side timestamp for echo detection.
   *  Framework calls this for existing tasks instead of individual update* methods.
   *  Plugins MUST capture the server's lastModified from the API response. */
  pushTask(task: Task): Promise<PushResult>;

  // ── Pull (periodic sync from remote) ──
  syncPoll(ctx: SyncPollContext): Promise<void>;

  // ── Project (grouping container) lifecycle — optional ──
  // A project is Walnut's single grouping layer; providers map it to whatever
  // container they have (MS To-Do: a list; tag-based platforms: a task tag).
  // These hooks let core rename/delete the CONTAINER once instead of touching
  // N tasks — and they are the only sanctioned way core reaches a provider's
  // container (core never imports a specific integration).

  /** Rename the remote container that backs a project.
   *  `oldRemoteName` is the container's CURRENT remote name — the registry's
   *  `remote_list` alias when set (legacy "Cat / Proj" lists), else the old
   *  project name. Called only for a plain rename (not a merge — a merge's
   *  target container already exists and tasks genuinely move via
   *  updateProject). Throw to make core fall back to per-task pushes. */
  renameProjectRemote?(args: { oldRemoteName: string; newName: string }): Promise<void>;

  /** Delete the remote side of a project (cascade delete). Called BEFORE any
   *  local mutation — a throw aborts the cascade with local state untouched.
   *  Must be idempotent (an already-missing container is success, so a retry
   *  after a partial failure converges).
   *
   *  `tasks` are the project's tasks with ext intact, so the plugin can
   *  register deletion tombstones that stop a mid-flight pull re-importing
   *  the twins.
   *
   *  The RESULT tells core what happened to the remote twins — the two
   *  container models genuinely diverge here and core must not guess:
   *   - `{ outcome: 'container-deleted' }` — the remote container AND the twins
   *     in it are gone (MS To-Do: the list was deleted). Core detaches the
   *     local tasks (source='local', ext cleared, project='' = Inbox): data
   *     preserved, binding honest.
   *   - `{ outcome: 'grouping-removed', fallbackProject }` — the platform has
   *     no container; only the grouping marker was removed and the remote
   *     tasks SURVIVE (tag-based platforms: the project tag was stripped).
   *     Core moves the local tasks to `fallbackProject` KEEPING their provider
   *     binding — that must be the same project the plugin's own pull mapper
   *     falls back to for an unmarked task, so the next pull is a no-op
   *     instead of a duplicate-import. */
  deleteProjectRemote?(args: { project: string; remoteList?: string; tasks: Task[] }): Promise<
    | { outcome: 'container-deleted' }
    | { outcome: 'grouping-removed'; fallbackProject: string }
  >;

  // ── Full Reconciliation (optional — enables framework-driven full sync) ──

  /** Pull ALL remote items matching this plugin's scope (no date filter).
   *  Framework calls this periodically to detect drift, deletions, and unassignments.
   *  Return undefined/null to skip reconciliation for this tick. */
  fullPull?(ctx: SyncPollContext): Promise<RemoteSyncItem[] | undefined | null>;

  /** Extract the remote ID from a local task's ext data.
   *  Used to join local tasks with fullPull results. */
  extractRemoteId?(task: Task): string | undefined;
}

// ── ProjectClaimFn: determines if a plugin owns a project ──
// A project is the single grouping layer and carries at most one provider claim.
// Never called for Inbox (the empty project), which is structurally unclaimable.

export type ProjectClaimFn = (project: string) => boolean | Promise<boolean>;

// ── DisplayMeta: UI rendering metadata for a plugin ──

export interface DisplayMeta {
  badge: string;
  badgeColor: string;
  externalLinkLabel: string;
  getExternalUrl(task: Task): string | null;
  isSynced(task: Task): boolean;
  syncTooltip?(task: Task): string;
  /** Language hint for triage agents (e.g. 'en', 'zh'). Plugins set this so core prompts can choose the right language without hardcoding plugin IDs. */
  languageHint?: string;
}

// ── HttpRoute: plugin-registered HTTP routes ──

export interface HttpRoute {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  handler: Router;
}

// ── MigrateFn: one-time data migration function ──

export type MigrateFn = (tasks: Task[]) => Promise<Task[]> | Task[];

// ── ExtIndexSpec: plugin-declared SQLite indexes over task.ext ──
// Plugins own a JSON subkey inside `ext` (e.g. `ext.jira`, `ext['ms-todo']`).
// To support O(log N) lookup by ext-id during sync ticks, each plugin declares
// the json_extract paths it wants indexed; core opens the index on its behalf.

export interface ExtIndexPath {
  /** Stable name for this path — used in the index name + prepared-stmt cache key.
   *  Allowed chars: [a-z0-9_]. e.g. 'id', 'short_id', 'issue_key'. */
  key: string;
  /** SQLite json_extract path inside the `ext` column.
   *  e.g. '$.jira.issue_key' or '$."ms-todo".id'. */
  json: string;
}

export interface ExtIndexSpec {
  /** Must equal the plugin's manifest.id and the value written into Task.source. */
  source: string;
  /** Indexes to open. findTaskByExtId tries paths in order until one matches. */
  paths: ExtIndexPath[];
}

// ── PluginApi: the registration interface passed to plugin entry points ──

export interface PluginApi {
  id: string;
  name: string;
  config: Record<string, unknown>;
  logger: SubsystemLogger;

  registerSync(sync: IntegrationSync): void;
  registerSourceClaim(fn: ProjectClaimFn, opts?: { priority?: number }): void;
  registerDisplay(meta: DisplayMeta): void;
  registerAgentContext(snippet: string): void;
  registerMigration(fn: MigrateFn): void;
  registerHttpRoute(route: HttpRoute): void;
  /** Declare ext-id indexes the plugin wants opened on the tasks table.
   *  spec.source must equal the plugin id. May be called at most once. */
  registerExtIndex(spec: ExtIndexSpec): void;
}

// ── RegisteredPlugin: aggregated result after plugin registration ──

export interface RegisteredPlugin {
  id: string;
  name: string;
  description?: string;
  version?: string;
  config: Record<string, unknown>;
  sync: IntegrationSync;
  claim?: { fn: ProjectClaimFn; priority: number };
  display?: DisplayMeta;
  agentContext?: string;
  migrations: MigrateFn[];
  httpRoutes: HttpRoute[];
  extIndex?: ExtIndexSpec;
  /** Manifest configSchema/uiHints — drives the data-driven Settings → Integrations form. */
  configSchema?: Record<string, unknown>;
  uiHints?: Record<string, { label?: string; help?: string }>;
}

/** Plugin discovered on disk but not loaded because required config is missing.
 *  Kept so the Settings UI can tell the user exactly what to fill in. */
export interface UnconfiguredPlugin {
  id: string;
  name: string;
  description?: string;
  missing: string[];
  configSchema?: Record<string, unknown>;
  uiHints?: Record<string, { label?: string; help?: string }>;
}

// ── Manifest: plugin manifest.json schema ──

export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  version?: string;
  /** Advisory in v1 — not enforced. e.g. { walnut: ">=0.5" } */
  engines?: { walnut?: string };
  /** Capability declarations (manifest v2). ABSENT means { sync: {} } — every
   *  pre-v2 manifest is a sync plugin. Only `sync` is honored today; other keys
   *  (tools, hooks, skills, routines, ui) are reserved: a manifest declaring only
   *  unknown capabilities is reported as `unsupported` instead of being loaded,
   *  so plugins written for a future Walnut degrade gracefully here. */
  capabilities?: Record<string, Record<string, unknown>>;
  configSchema?: Record<string, unknown>;
  uiHints?: Record<string, { label?: string; help?: string }>;
}
