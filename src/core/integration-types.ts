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

  /** FORMER remote ids this task was known by (e.g. ms-todo re-keys an item on
   *  list migration and records the old id in ext previous_ids). The
   *  reconciler joins these too, so a re-keyed remote item is ADOPTED by the
   *  task that owned it instead of imported as a duplicate. Return [] / omit
   *  when the platform's ids are stable. */
  extractRemoteIdAliases?(task: Task): string[];

  /** Confirm one remote item is gone (used to retry unacknowledged deletions).
   *  MUST resolve true when the item is verified deleted (including "already
   *  404"), false to retry next tick. Omit → deletions are considered
   *  confirmed at local-delete time (pre-ledger behavior). */
  confirmRemoteDeleted?(remoteId: string, remoteList?: string | null): Promise<boolean>;
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

// ── TaskFieldSpec: plugin-declared task fields (manifest `taskFields`) ──
// A plugin can expose extra per-task fields (e.g. a tracker's sprint) that the
// console renders generically — a picker in the task kebab menu + a pill on the
// card — without core or the frontend knowing the field exists. Values live in
// task.ext.<pluginId>.<key> unless the spec binds an existing core column via
// `coreField` (sprint predates this system and stays a core field).

export interface TaskFieldOption {
  /** Value stored on the task (and shown unless label is set). */
  value: string;
  label?: string;
  /** Extra context rendered dim next to the label (e.g. sprint date range). */
  hint?: string;
}

export interface TaskFieldSpec {
  /** Field key — storage subkey inside ext.<pluginId> (or the coreField name). [a-z0-9_]+ */
  key: string;
  /** Display name for menus and pills (e.g. "Sprint"). */
  label: string;
  /** v1 supports single-choice enums only; other types are reserved. */
  type: 'enum';
  /** Plugin HTTP route (relative to /api/plugins/<id>) returning
   *  { options: TaskFieldOption[], current?: string|null } — `current` marks
   *  the suggested default (e.g. the active sprint). Options are fetched
   *  lazily when the picker opens, never cached by core. */
  optionsRoute: string;
  /** Allow clearing the value (adds a "None" row). Default true. */
  clearable?: boolean;
  /** Bind to an existing core Task column instead of ext.<pluginId>.<key>.
   *  Only 'sprint' is honored — it predates taskFields as a core field. */
  coreField?: 'sprint';
}

// ── UiAppCapability: plugin-declared embedded app (manifest `capabilities.ui`) ──
// A plugin may ship a small static HTML surface Walnut embeds in a sandboxed
// iframe. The files live in `<pluginDir>/app/` and are served read-only under
// /plugin-apps/<pluginId>/app/… — nothing else in the plugin directory is
// reachable, so plugin server code, manifests and configs stay private.

export interface UiAppSpec {
  /** Sidebar / page title. Required, non-empty, ≤64 chars. */
  title: string;
  /** Entry page, relative to the plugin's `app/` dir. Default `index.html`.
   *  An explicit `app/` prefix is accepted and normalized away. */
  entry?: string;
  /** Icon (png/svg) relative to the plugin's `app/` dir. Same rules as entry. */
  icon?: string;
}

export interface UiAppCapability {
  app?: UiAppSpec;
}

/** Validated ui app, as stored on RegisteredPlugin. Paths are plugin-dir
 *  relative and always start with `app/`. */
export interface RegisteredUiApp {
  title: string;
  /** e.g. `app/index.html` — resolve against the plugin dir. */
  entry: string;
  /** e.g. `app/icon.svg`, when declared. */
  icon?: string;
}

// ── PluginToolSpec: plugin-contributed Personal AI tool (capability `tools`) ──
// Structurally compatible with src/agent/tools.ts ToolDefinition. Declared here
// rather than imported so core keeps no dependency (not even a type one) on the
// agent layer — integration-types.ts is a leaf that task-manager and the whole
// core tree import.

export type PluginToolTextBlock = { type: 'text'; text: string };
export type PluginToolImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
/** Plain string, or content blocks (text + image). Mirrors ToolResultContent. */
export type PluginToolResult = string | Array<PluginToolTextBlock | PluginToolImageBlock>;

/** Mirrors ToolExecuteMeta — correlation id + the calling turn's source. */
export interface PluginToolMeta {
  toolUseId?: string;
  source?: string;
}

export interface PluginToolSpec {
  /** [a-z0-9_]+. The loader prefixes it with the plugin id unless already prefixed. */
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (object schema). */
  input_schema: Record<string, unknown>;
  execute(params: Record<string, unknown>, meta?: PluginToolMeta): Promise<PluginToolResult>;
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

  /** Required only when the plugin's effective capabilities include `sync`
   *  (which is the case whenever `capabilities` is absent — every pre-v2
   *  manifest is a sync plugin). A ui/tools/skills-only plugin omits it. */
  registerSync(sync: IntegrationSync): void;
  registerSourceClaim(fn: ProjectClaimFn, opts?: { priority?: number }): void;
  registerDisplay(meta: DisplayMeta): void;
  registerAgentContext(snippet: string): void;
  registerMigration(fn: MigrateFn): void;
  registerHttpRoute(route: HttpRoute): void;
  /** Contribute a tool to the Personal AI's tool set (capability `tools`).
   *  Names are namespaced `<pluginId>_<name>` so two plugins can't collide;
   *  a built-in tool of the same name always wins. */
  registerTool(tool: PluginToolSpec): void;
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
  apiVersion?: number;
  serverEntry?: string;
  webEntry?: string;
  config: Record<string, unknown>;
  /**
   * The plugin's sync implementation.
   *
   * ALWAYS present so the dozens of `registry.get(task.source)!.sync.xxx()` call
   * sites stay total. For a plugin WITHOUT the `sync` capability (ui/tools/skills
   * only) this is an inert stub and `hasSync` is false — read `hasSync`, never
   * the presence of this field, when deciding whether a plugin syncs anything.
   */
  sync: IntegrationSync;
  /** False only for a plugin without the `sync` capability (ui/tools/skills
   *  only): its `sync` is an inert stub, it must not be polled, and it must
   *  never be offered as a task source. ABSENT is read as `true` so any
   *  hand-constructed registration (tests, the local fallback) keeps working. */
  hasSync?: boolean;
  /** Effective capability names (absent manifest capabilities ⇒ ['sync']). */
  capabilities?: string[];
  claim?: { fn: ProjectClaimFn; priority: number };
  display?: DisplayMeta;
  agentContext?: string;
  migrations: MigrateFn[];
  httpRoutes: HttpRoute[];
  extIndex?: ExtIndexSpec;
  /** Manifest configSchema/uiHints — drives the data-driven Settings → Integrations form. */
  configSchema?: Record<string, unknown>;
  uiHints?: Record<string, { label?: string; help?: string }>;
  /** Manifest taskFields — plugin-declared per-task fields the console renders generically. */
  taskFields?: TaskFieldSpec[];
  /** Tools contributed via registerTool (capability `tools`), names already
   *  namespaced with the plugin id. */
  tools?: PluginToolSpec[];
  /** Validated manifest `capabilities.ui.app` (capability `ui`). */
  uiApp?: RegisteredUiApp;
  /** Absolute path of the plugin's directory on disk. Needed to serve its app
   *  files and to find its `skills/` dir. */
  pluginDir?: string;
  /** True when `<pluginDir>/skills/` exists (capability `skills`) — the skill
   *  loader appends it as a lowest-priority discovery source. */
  hasSkills?: boolean;
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
  /** Unified full-trust Plugin contract. Absent means the legacy loader. */
  apiVersion?: number;
  /** Enforced for apiVersion 1 before any Plugin code is imported. */
  engines?: { walnut?: string };
  /** Server and native Web entrypoints, relative to the Plugin root. */
  server?: string;
  web?: string;
  /** Optional sandboxed HTML surface retained for external/legacy content. */
  webview?: RegisteredUiApp;
  /** Capability declarations (manifest v2). ABSENT means { sync: {} } — every
   *  pre-v2 manifest is a sync plugin.
   *
   *  Implemented: `sync` (task provider), `ui` (an embedded app — see
   *  UiAppCapability), `tools` (Personal AI tools via api.registerTool),
   *  `skills` (a `<pluginDir>/skills/` dir folded into the skills index).
   *  Still reserved: `hooks`, `routines`. A manifest declaring ONLY
   *  unimplemented capabilities is reported as `unsupported` instead of being
   *  loaded (its code is never imported), so a plugin written for a future
   *  Walnut degrades gracefully here. */
  capabilities?: Record<string, Record<string, unknown>>;
  configSchema?: Record<string, unknown>;
  uiHints?: Record<string, { label?: string; help?: string }>;
  /** Per-task fields this plugin exposes to the console (see TaskFieldSpec). */
  taskFields?: TaskFieldSpec[];
}
