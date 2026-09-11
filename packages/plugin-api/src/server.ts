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
  completion?: Array<'todo' | 'in_progress' | 'complete'>
  phases?: TaskPhase[]
  projects?: string[]
  priorities?: TaskPriority[]
  sources?: string[]
  sprints?: string[]
  tagsAny?: string[]
  tagsAll?: string[]
  pinned?: boolean
  unread?: boolean
  blocked?: boolean
  parentTaskId?: string
  groupId?: string
  time?: {
    basis: 'created' | 'updated' | 'created_or_updated'
    last?: { value: number; unit: 'hours' | 'days' }
    from?: string
    until?: string
  }
  sort?: 'updated_desc' | 'created_desc' | 'completed_desc' | 'priority' | 'title_asc'
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

/** One tappable decision on a letter. Buttons are what make a letter a question. */
export interface LetterActionInput {
  id: string
  label: string
  description?: string
}

export interface LetterSendInput {
  subject: string
  /** The document. Exactly one of `markdown` or `html`. */
  markdown?: string
  html?: string
  /** A short plain preview for the envelope row and the phone push. Derived when absent. */
  text?: string
  /** Present makes this a decision the human must answer; absent makes it a document. */
  actions?: LetterActionInput[]
  taskRefs?: string[]
  pin?: boolean
}

export interface LetterAnswerRecord {
  actionId: string
  label: string
  freeText?: string
  at: number
}

export interface LetterState {
  letterId: string
  subject: string
  actions: LetterActionInput[]
  /** Present once the letter has been answered, which can happen exactly once. */
  answered?: LetterAnswerRecord
}

export interface LetterAnsweredEvent {
  letterId: string
  actionId: string
  label: string
  freeText?: string
  answeredAt: number
  /** Which edge recorded it. `'plugin'` is your own `withdraw`. */
  source: 'web' | 'phone' | 'relay' | 'plugin'
  pluginId?: string
}

/**
 * Letters: ask the one human a question, wherever they are, and hear the answer back.
 *
 * A letter is a document in the human inbox with optional one-tap actions, rendered by the
 * console and by the phone. It is the host's approval object: a plugin that must not act
 * without a human decision sends a letter with actions and does nothing until `onAnswered`
 * fires. There is no origin session behind a plugin letter, so that event is the return path.
 *
 * At most 30 letters per plugin per minute; over that, `send` rejects with a plain-words
 * error. A letter badges the bell and pushes to the phone, so roll a batch into one letter.
 */
export interface LettersService {
  send(input: LetterSendInput): Promise<{ letterId: string }>
  /** Add a turn to the letter's thread, so the human sees what happened after they answered. */
  reply(letterId: string, input: { markdown?: string; html?: string; text?: string }): Promise<void>
  /**
   * Take the question back: the letter is answered server-side with the action id
   * `withdrawn` and your note, and nothing is delivered. Use it the moment the thing the
   * letter asked about changes, so a stale approval can never be tapped. Idempotent on a
   * letter the human already answered.
   */
  withdraw(letterId: string, input: { note: string }): Promise<void>
  /** The letter's current state, with no document read. `null` when the id is unknown. */
  get(letterId: string): Promise<LetterState | null>
  /** Answers to letters THIS plugin sent, and nothing else. */
  onAnswered(handler: (event: LetterAnsweredEvent) => void | Promise<void>): Disposable
}

export type OpResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; message: string }

export interface OpSummary {
  name: string
  title: string
  readonly: boolean
  /**
   * `'core'` for a built-in op, otherwise the id of the plugin that declared it.
   * Always present from a server-side `walnut.ops.list()`; absent only when a web
   * App's list came through the cloud relay from a primary too old to send it.
   */
  owner?: string
}

export interface OpsService {
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<OpResult<T>>
  unwrap<T>(result: OpResult<T>): T
  list(): Promise<OpSummary[]>
}

/**
 * A capability another plugin can call: a plain object whose own properties are all
 * functions. Not a class instance, an EventEmitter or a Promise — a consumer's handle is
 * resolved per key, per access, so anything carrying identity or internal state would go
 * stale the moment you republished it. Close over your state in the functions instead.
 */
export type ServiceApi = Record<string, (...args: any[]) => unknown>

export interface ServiceChange {
  /** `<publisherPluginId>:<name>`, or `core:<name>` for a host capability. */
  key: string
  pluginId: string
  action: 'published' | 'replaced' | 'removed'
}

/**
 * Services are how a plugin builds on another plugin. The publisher exports the api's TYPE
 * from its own `api.ts` and the consumer takes it as an `import type`, so the shape travels
 * at build time only and never through this package: Walnut's kernel does not know what a
 * mail or a calendar looks like, and it must stay that way.
 *
 * Everything here is SYNCHRONOUS, deliberately. A plugin that declared `dependencies` in
 * its manifest is loaded after those plugins activated, so a declared service is already
 * there when your `activate` runs; an awaitable `get` could only ever wait for something
 * that is never coming.
 *
 * `get` returns a live handle, not a snapshot: hold it for the plugin's lifetime, and it
 * follows the publisher through a republish or a reload. Once the publisher is gone, every
 * property access throws instead of answering `undefined`.
 */
export interface ServicesService {
  /**
   * Publish `api` as `<yourPluginId>:<name>`. `name` matches `/^[a-z0-9][a-z0-9_-]*$/` and
   * may not contain `:`; the host owns the prefix, so two plugins can never collide.
   * Publishing the same name twice replaces the earlier value. Publish synchronously inside
   * `activate`, so a plugin that depends on you can call the service during its own.
   *
   * The constraint says "every property of `api` is a function", which an `interface` and a
   * `type` alias both satisfy. The class-instance and thenable cases it cannot express are
   * refused at runtime.
   */
  publish<T extends Record<keyof T, (...args: any[]) => unknown>>(name: string, api: T): Disposable
  /**
   * A LAZY live handle to `key`: nothing is resolved until you call a method, so you may
   * take one for a key a peer publishes later in its own `activate`. Throws when your
   * manifest does not declare the publishing plugin in `dependencies`, because a declared
   * dependency is what makes the load order a guarantee. `core:` keys are exempt: those are
   * gated by `engines.walnut`.
   */
  get<T = ServiceApi>(key: string): T
  /**
   * Like `get`, and it additionally asserts that a publisher exists right now, so a typo'd
   * key throws inside your `activate` instead of at the first call. The name to use when the
   * point is "I declared this dependency, hand it over".
   */
  require<T = ServiceApi>(key: string): T
  /**
   * The plugin id of whoever is calling the service method you are running RIGHT NOW, or
   * `undefined` when the host called you or when nobody is inside a service call.
   *
   * Only meaningful inside the SYNCHRONOUS body of one of your own published methods. The
   * host sets it for the duration of `method.apply` and restores the previous value straight
   * after, so a nested service call sees its own caller and an `await` inside your method
   * loses it: read it on the first line and keep the value.
   *
   * What it is for: a capability plugin that hands out registrations (a provider, a source, a
   * transport) can record WHO registered each one, so it can drop them when that plugin goes
   * away instead of keeping a row it cannot attribute to anybody.
   */
  caller(): string | undefined
  /** Told when any service is published, replaced or removed, including your own. */
  onChange(handler: (change: ServiceChange) => void | Promise<void>): Disposable
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

/**
 * An operation ("op") this plugin adds to the host's op catalogue, so anything that calls
 * ops by name can call this one: another plugin's `walnut.ops.call`, this plugin's own web
 * App, and `POST /api/plugin-runtime/<pluginId>/ops/<opName>`. Use it for a stable named
 * capability other code should be able to invoke; use `tool` when the audience is the
 * Personal AI's tool list.
 *
 * `name` is local and lowercase; the host names the op `<normalized_plugin_id>_<name>`, so
 * a plugin called `mail` declaring `search` becomes `mail_search`. A final name that
 * collides with a built-in op is refused rather than allowed to shadow it. `inputSchema` is
 * a JSON Schema object: `type`, `enum`, `array`, nested `object`, `required`, and
 * `description` are honoured, `default` is ignored. There is no HTTP binding, because a
 * plugin op runs in the host process; `ctx.call` reaches a Walnut API route when you need one.
 *
 * Know the reach before you declare one. As soon as the plugin activates, the op is callable
 * from `walnut.ops.call`, the plugin runtime HTTP routes, an action card, and, when `remote`
 * is `'allow'`, from `walnut tools call` inside EVERY Walnut-managed session on every host
 * (those run through the gateway, which resolves against this process's catalogue). Only two
 * surfaces are blind to plugin ops: a standalone `walnut …` command that talks HTTP from its
 * own process, and the stdio MCP server. So a read-only op, which defaults to
 * `remote: 'allow'`, is reachable by any agent in any session — pass `remote: 'deny'` when
 * that is not what you want.
 */
export interface PluginOpDefinition {
  name: string
  title: string
  description: string
  /** JSON Schema object. Default `{ type: 'object', properties: {} }`. */
  inputSchema?: Record<string, unknown>
  readonly: boolean
  /**
   * `'allow'` lets `walnut tools call <op>` inside any Walnut-managed session, local or
   * remote, reach this op through the gateway. `'deny'` keeps it to in-process callers:
   * `walnut.ops.call`, the plugin runtime routes, and action cards. Default:
   * `readonly ? 'allow' : 'deny'`.
   */
  remote?: 'allow' | 'deny'
  destructive?: boolean
  /** Deadline for EACH `ctx.call` request, not for the handler as a whole. */
  timeoutMs?: number
  handler(
    args: Record<string, unknown>,
    ctx: {
      call(
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        body?: unknown,
      ): Promise<unknown>
    },
  ): Promise<unknown>
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
  op(definition: PluginOpDefinition): Disposable
  wsMethod(id: string, handler: (payload: unknown) => unknown | Promise<unknown>): Disposable
  agent(definition: PluginAgentDefinition): Disposable
  provider(id: string, adapter: PluginProviderAdapter): Disposable
  cronAction(
    id: string,
    description: string,
    handler: (params: Record<string, unknown>) => Promise<CronActionResult>,
  ): Disposable
  hook(definition: PluginHookDefinition): Disposable
  /**
   * @deprecated No consumer: a session reads skills, so this text reaches no
   * model. Ship a `skill` instead. Still accepted (and still collected) so a
   * plugin that calls it keeps loading.
   */
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
  /**
   * True on a cloud replica, false on the primary box.
   *
   * A plugin that owns an outside account (a mailbox, a chat workspace, any polled service)
   * must not poll from two boxes: the second one double-fetches, double-writes and doubles
   * the load the other end sees. Read this and step aside, rather than assuming there is only
   * ever one Walnut.
   */
  readonly replica: boolean
  readonly signal: AbortSignal
  readonly log: PluginLogger
  readonly tasks: TaskService
  readonly config: ConfigService
  readonly notifications: NotificationService
  readonly letters: LettersService
  readonly ops: OpsService
  readonly services: ServicesService
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
