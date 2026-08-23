export type * from './shared.js'
export { WalnutPluginError } from './shared.js'

import type {
  Disposable,
  PluginLogger,
  TaskPhase,
  TaskPriority,
  WalnutTask,
  WalnutTaskSummary,
} from './shared.js'

export interface TaskListFilter {
  status?: 'todo' | 'in_progress' | 'done'
  phase?: TaskPhase | TaskPhase[]
  project?: string
  source?: string
  parentTaskId?: string
  limit?: number
}

export interface TaskQueryInput {
  text?: string
  where?: Record<string, unknown>
  sort?: Array<{ field: string; direction?: 'asc' | 'desc' }>
  limit?: number
}

export interface TaskCreateInput {
  title: string
  description?: string
  priority?: TaskPriority
  phase?: TaskPhase
  project?: string
  parentTaskId?: string
  dependsOn?: string[]
  tags?: string[]
  dueDate?: string
  startDate?: string
  endDate?: string
}

export interface TaskPatch {
  title?: string
  description?: string
  note?: string
  priority?: TaskPriority
  phase?: TaskPhase
  project?: string
  dependsOn?: string[]
  tags?: string[]
  dueDate?: string | null
  startDate?: string | null
  endDate?: string | null
  sprint?: string | null
}

export interface TaskService {
  get(id: string): Promise<WalnutTask | null>
  list(filter?: TaskListFilter): Promise<WalnutTaskSummary[]>
  query(query: TaskQueryInput): Promise<WalnutTaskSummary[]>
  children(id: string): Promise<WalnutTaskSummary[]>
  create(input: TaskCreateInput): Promise<WalnutTask>
  update(id: string, patch: TaskPatch): Promise<WalnutTask>
  appendNote(id: string, markdown: string): Promise<void>
  appendLog(id: string, entry: string): Promise<void>
  complete(id: string): Promise<WalnutTask>
  delete(id: string): Promise<void>
}

export interface ConfigService {
  get<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T>
  patch(partial: Record<string, unknown>): Promise<void>
  onChange(handler: (config: Record<string, unknown>) => void | Promise<void>): Disposable
}

export interface PluginNotice {
  title: string
  body?: string
  severity?: 'info' | 'success' | 'warning' | 'error'
  dedupKey: string
  taskId?: string
  sessionId?: string
}

export interface NotificationService {
  notify(notice: PluginNotice): Promise<void>
  error(notice: PluginNotice): Promise<void>
  recover(): Promise<void>
}

export type OpResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; message: string }

export interface OpSummary {
  name: string
  title: string
  readonly: boolean
}

export interface OpsService {
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<OpResult<T>>
  unwrap<T>(result: OpResult<T>): T
  list(): Promise<OpSummary[]>
}

export interface PluginEvent<T = unknown> {
  name: string
  data: T
  timestamp: number
  traceId?: string
  source?: string
}

export interface EventApi {
  on(
    names: string | string[],
    handler: (event: PluginEvent) => void | Promise<void>,
  ): Disposable
  emit(name: string, data: unknown): void
}

export interface PluginRequest {
  method: string
  path: string
  query: Record<string, string | string[]>
  headers: Record<string, string>
  json<T = unknown>(): Promise<T>
  text(): Promise<string>
}

export interface PluginReply {
  status?: number
  headers?: Record<string, string>
  json?: unknown
  text?: string
}

export type PluginRouteHandler = (request: PluginRequest) => PluginReply | Promise<PluginReply>

export interface PluginFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  timeoutMs?: number
}

export interface PluginFetchResponse {
  ok: boolean
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
}

export interface HttpService {
  route(method: string, path: string, handler: PluginRouteHandler): Disposable
  fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>
}

export type SqlValue = string | number | bigint | Uint8Array | null
export type SqlParams = Record<string, SqlValue> | SqlValue[]

export interface SqlRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface PluginDatabase {
  exec(sql: string): Promise<void>
  run(sql: string, params?: SqlParams): Promise<SqlRunResult>
  get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T | undefined>
  all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]>
  migrate(migrations: Array<{ version: number; sql: string }>): Promise<number>
}

export interface StorageService {
  readonly dataDir: string
  readJson<T>(name: string, fallback: T): Promise<T>
  writeJson(name: string, value: unknown): Promise<void>
  updateJson<T>(name: string, fallback: T, update: (current: T) => T | Promise<T>): Promise<T>
  readText(name: string): Promise<string | null>
  writeText(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
  list(prefix?: string): Promise<string[]>
  readonly database: PluginDatabase
}

export interface SecretService {
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
  keys(): Promise<string[]>
}

export interface TimerService {
  timeout(handler: () => void | Promise<void>, delayMs: number): Disposable
  interval(handler: () => void | Promise<void>, intervalMs: number): Disposable
}

export interface PluginSyncTask extends Record<string, unknown> {
  id: string
  title: string
  description: string
  summary: string
  priority: TaskPriority
  phase: TaskPhase
  project?: string
  note?: string
  conversation_log?: string
  due_date?: string
  depends_on?: string[]
  parent_task_id?: string
  ext?: Record<string, unknown>
}

export interface PluginSyncPollContext {
  getTasks(): PluginSyncTask[]
  updateTask(id: string, updates: Partial<PluginSyncTask>): Promise<PluginSyncTask>
  addTask(data: Omit<PluginSyncTask, 'id'>): Promise<PluginSyncTask>
  deleteTask(id: string): Promise<void>
  emit(event: string, data: unknown): void
}

export interface PluginSyncPushResult {
  serverTimestamp: string
  ext?: Record<string, unknown>
}

export interface PluginRemoteSyncItem {
  remoteId: string
  title: string
  remoteUpdatedAt: string
  deleted?: boolean
  fields: Partial<PluginSyncTask>
}

export interface PluginIntegrationSync {
  createTask(task: PluginSyncTask): Promise<Record<string, unknown> | null>
  deleteTask(task: PluginSyncTask): Promise<void>
  updateTitle(task: PluginSyncTask, title: string): Promise<void>
  updateDescription(task: PluginSyncTask, description: string): Promise<void>
  updateSummary(task: PluginSyncTask, summary: string): Promise<void>
  updateNote(task: PluginSyncTask, note: string): Promise<void>
  updateConversationLog(task: PluginSyncTask, log: string): Promise<void>
  updatePriority(task: PluginSyncTask, priority: TaskPriority): Promise<void>
  updatePhase(task: PluginSyncTask, phase: TaskPhase): Promise<void>
  updateDueDate(task: PluginSyncTask, date: string | null): Promise<void>
  updateProject(task: PluginSyncTask, project: string): Promise<void>
  updateDependencies(task: PluginSyncTask, dependsOn: string[]): Promise<void>
  associateSubtask(parentTask: PluginSyncTask, childTask: PluginSyncTask): Promise<void>
  disassociateSubtask(parentTask: PluginSyncTask, childTask: PluginSyncTask): Promise<void>
  validateContent?(task: PluginSyncTask, field: string, value: string): string | null
  contentRequirement?(field: string): string | null
  pushTask(task: PluginSyncTask): Promise<PluginSyncPushResult>
  syncPoll(context: PluginSyncPollContext): Promise<void>
  renameProjectRemote?(args: { oldRemoteName: string; newName: string }): Promise<void>
  deleteProjectRemote?(args: { project: string; remoteList?: string; tasks: PluginSyncTask[] }): Promise<
    | { outcome: 'container-deleted' }
    | { outcome: 'grouping-removed'; fallbackProject: string }
  >
  fullPull?(context: PluginSyncPollContext): Promise<PluginRemoteSyncItem[] | undefined | null>
  extractRemoteId?(task: PluginSyncTask): string | undefined
  extractRemoteIdAliases?(task: PluginSyncTask): string[]
  confirmRemoteDeleted?(remoteId: string, remoteList?: string | null): Promise<boolean>
}

export interface PluginDisplayMeta {
  badge: string
  badgeColor: string
  externalLinkLabel: string
  getExternalUrl(task: PluginSyncTask): string | null
  isSynced(task: PluginSyncTask): boolean
  syncTooltip?(task: PluginSyncTask): string
  languageHint?: string
}

export interface PluginExtIndexSpec {
  source: string
  paths: Array<{ key: string; json: string }>
}

export type PluginMigration = (
  tasks: PluginSyncTask[],
) => PluginSyncTask[] | Promise<PluginSyncTask[]>

export interface PluginToolSpec {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  execute(input: Record<string, unknown>): unknown | Promise<unknown>
}

export interface CronActionResult {
  status: 'ok' | 'error'
  summary?: string
  error?: string
  data?: unknown
}

export type PluginHookPoint =
  | 'onSessionStart' | 'onMessageSend' | 'onTurnStart' | 'onToolUse'
  | 'onToolResult' | 'onPlanComplete' | 'onModeChange' | 'onTurnComplete'
  | 'onTurnError' | 'onSessionWillReap' | 'onTaskCreated' | 'onTaskUpdated'
  | 'onTaskPhaseChanged' | 'onTaskCompleted' | 'onCronFired'

export type PluginSessionMode = 'bypass' | 'accept' | 'default' | 'plan' | 'auto' | 'dontAsk'

export interface PluginHookFilter {
  modes?: PluginSessionMode[]
  projects?: string[]
  phases?: TaskPhase[]
  fromPhases?: TaskPhase[]
  sources?: string[]
  requiresSession?: boolean
  predicate?: (context: unknown) => boolean
}

export interface PluginHookDefinition {
  id: string
  point?: PluginHookPoint
  points?: PluginHookPoint[]
  priority?: number
  enabled?: boolean
  timeoutMs?: number
  filter?: PluginHookFilter
  handler(context: unknown): unknown | Promise<unknown>
}

export type PluginContextSourceId =
  | 'task_details' | 'project_memory' | 'project_task_list'
  | 'global_memory' | 'daily_log' | 'session_history' | 'conversation_log'
  | 'main_global_memory' | 'main_daily_log' | 'journal_recent' | 'working_memory'

export interface PluginAgentDefinition {
  id: string
  name: string
  description?: string
  runner: 'embedded' | 'cli'
  model?: string
  provider?: string
  region?: string
  max_tokens?: number
  max_tool_rounds?: number
  system_prompt?: string
  denied_tools?: string[]
  allowed_tools?: string[]
  working_directory?: string
  context_sources?: Array<{ id: PluginContextSourceId; enabled: boolean; token_budget?: number }>
  stateful?: { memory_project: string; memory_budget_tokens?: number; memory_source?: string }
  skills?: string[]
  console?: boolean
}

export interface PluginProviderCallOptions {
  providerConfig: Record<string, unknown>
  model: string
  maxTokens: number
  system: unknown
  messages: unknown[]
  tools?: unknown[]
  signal?: AbortSignal
  compat?: Record<string, unknown>
  betas?: string[]
  thinking?: unknown
}

export interface PluginProviderResult {
  content: unknown[]
  stopReason: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    model?: string
  }
  aborted?: boolean
}

export interface PluginProviderAdapter {
  sendMessage(options: PluginProviderCallOptions): Promise<PluginProviderResult>
  sendMessageStream(
    options: PluginProviderCallOptions & { onTextDelta?: (delta: string) => void },
  ): Promise<PluginProviderResult>
  resetClient?(): void
}

/**
 * A slash command contributed by a plugin. The host names it `<pluginId>:<id>`, so it
 * can never collide with a user or built-in command; `content` is the instruction text
 * sent to the agent when the command runs. Read-only from the API and UI: editing it
 * means editing the plugin.
 */
export interface PluginCommandDefinition {
  id: string
  description: string
  content: string
}

/**
 * A directory of skills contributed by a plugin. `directory` is an ABSOLUTE path
 * holding one or more skills in the standard layout (`<directory>/<name>/SKILL.md`, or
 * `<directory>/<category>/<name>/SKILL.md`). It joins skill discovery as the
 * lowest-priority search root, so a workspace or user skill of the same name still
 * wins, and it disappears again when the plugin is disabled or reloaded.
 */
export interface PluginSkillDefinition {
  id: string
  directory: string
}

export interface RegistryService {
  sync(adapter: PluginIntegrationSync): Disposable
  sourceClaim(
    claim: (project: string) => boolean | Promise<boolean>,
    options?: { priority?: number },
  ): Disposable
  display(meta: PluginDisplayMeta): Disposable
  migration(migrate: PluginMigration): Disposable
  extIndex(spec: PluginExtIndexSpec): Disposable
  tool(spec: PluginToolSpec): Disposable
  wsMethod(id: string, handler: (payload: unknown) => unknown | Promise<unknown>): Disposable
  agent(definition: PluginAgentDefinition): Disposable
  provider(id: string, adapter: PluginProviderAdapter): Disposable
  cronAction(
    id: string,
    description: string,
    handler: (params: Record<string, unknown>) => Promise<CronActionResult>,
  ): Disposable
  hook(definition: PluginHookDefinition): Disposable
  agentContext(text: string): Disposable
  command(definition: PluginCommandDefinition): Disposable
  skill(definition: PluginSkillDefinition): Disposable
}

export interface UnsafeServerHost {
  readonly database: unknown
  readonly bus: unknown
  readonly walnutHome: string
  readonly host: unknown
}

export interface WalnutServerApi {
  readonly pluginId: string
  readonly pluginName: string
  readonly walnutVersion: string
  readonly signal: AbortSignal
  readonly log: PluginLogger
  readonly tasks: TaskService
  readonly config: ConfigService
  readonly notifications: NotificationService
  readonly ops: OpsService
  readonly events: EventApi
  readonly http: HttpService
  readonly storage: StorageService
  readonly secrets: SecretService
  readonly timers: TimerService
  readonly registry: RegistryService
  readonly unsafe: UnsafeServerHost
}

export interface WalnutServerPlugin {
  activate(walnut: WalnutServerApi): void | Disposable | Promise<void | Disposable>
  deactivate?(): void | Promise<void>
}

export function defineServerPlugin<T extends WalnutServerPlugin>(plugin: T): T {
  return plugin
}
