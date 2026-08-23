import type {
  DisplayMeta,
  ExtIndexSpec,
  HttpRoute,
  IntegrationSync,
  MigrateFn,
  PluginApi,
  PluginToolSpec,
  ProjectClaimFn,
} from '../integration-types.js'
import type { IntegrationRegistry } from '../integration-registry.js'
import type { PluginContext } from './plugin-context.js'
import { PluginStorage, PluginSecretStore } from './plugin-storage.js'
import { createPluginHttpRoute, type PluginRouteHandler } from './plugin-route-adapter.js'
import { namespacePluginId } from './ids.js'
import { registerOwnedCommand, type PluginCommandDefinition } from './command-registry.js'
import { registerOwnedSkillDir, type PluginSkillDefinition } from './skill-registry.js'
import { clearSkillsCache } from '../skill-loader.js'
import { toDisposable, type Disposable } from './disposable.js'
import { bus, EventNames, type BusEvent } from '../event-bus.js'
import { getConfig, updatePluginConfig } from '../config-manager.js'
import { getVersion } from '../version.js'
import { WALNUT_HOME } from '../../constants.js'
import { getDb } from '../task-db.js'
import type { AgentDefinition, Task, TaskPhase, TaskPriority } from '../types.js'
import type { SlimTask } from '../task-manager.js'
import type { TaskQuery } from '../task-query.js'
import { registerOwnedAction, type ActionResult } from '../cron/actions.js'
import { getSessionHookDispatcher } from '../session-hooks/index.js'
import { HOOK_POINT_DOMAIN, type HookFilter, type HookPoint } from '../session-hooks/types.js'
import { executeOp } from '../../ops/executor.js'
import { listOps } from '../../ops/registry.js'
import { registerOwnedMethod } from '../../web/ws/handler.js'
import { registerOwnedAgent } from '../agent-registry.js'
import { registerOwnedProviderAdapter } from '../../agent/providers/registry.js'
import type {
  AdapterCallOptions,
  ModelResult,
  ProtocolAdapter,
} from '../../agent/providers/types.js'

interface ContributionCollector {
  sync: IntegrationSync | null
  claim: { fn: ProjectClaimFn; priority: number } | null
  display: DisplayMeta | null
  migrations: MigrateFn[]
  extIndex: ExtIndexSpec | null
  tools: PluginToolSpec[]
  httpRoutes: HttpRoute[]
  agentContext: string | null
}

export interface CreateServerPluginApiOptions {
  context: PluginContext
  pluginName: string
  legacyApi: PluginApi
  contributions: ContributionCollector
  integrationRegistry: IntegrationRegistry
}

interface PluginAgentSpec extends Omit<AgentDefinition, 'id' | 'source' | 'overrides_builtin'> {
  id: string
}

interface PluginHookSpec {
  id: string
  point?: HookPoint
  points?: HookPoint[]
  priority?: number
  enabled?: boolean
  timeoutMs?: number
  filter?: HookFilter
  handler(context: unknown): unknown | Promise<unknown>
}

interface PluginProviderCallOptions {
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

interface PluginProviderResult {
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

interface PluginProviderAdapter {
  sendMessage(options: PluginProviderCallOptions): Promise<PluginProviderResult>
  sendMessageStream(
    options: PluginProviderCallOptions & { onTextDelta?: (delta: string) => void },
  ): Promise<PluginProviderResult>
  resetClient?(): void
}

let subscriberSequence = 0
let configuredApiBase: string | undefined

export function setPluginApiBase(apiBase: string | undefined): void {
  configuredApiBase = apiBase
}

export function getPluginApiBase(): string | undefined {
  return configuredApiBase
}

// Plugins are full-trust. pluginId stamps provenance and caller identity; it is
// not an authorization boundary, so every active Plugin sees the core op catalog.
export async function callPluginOp<T = unknown>(
  pluginId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; result: T } | { ok: false; message: string }> {
  await import('../../ops/index.js')
  return await executeOp(name, args, {
    apiBase: configuredApiBase,
    callerSid: `plugin:${pluginId}`,
  }) as { ok: true; result: T } | { ok: false; message: string }
}

export async function listPluginOps(): Promise<Array<{ name: string; title: string; readonly: boolean }>> {
  await import('../../ops/index.js')
  return listOps().map((op) => ({
    name: op.name,
    title: op.title,
    readonly: op.tags.readonly,
  }))
}

function removeIdentity<T>(items: T[], value: T): void {
  const index = items.indexOf(value)
  if (index >= 0) items.splice(index, 1)
}

function publicTask(task: Task) {
  return {
    id: task.id,
    title: task.title,
    phase: task.phase,
    priority: task.priority,
    project: task.project,
    description: task.description,
    summary: task.summary,
    note: task.note || undefined,
    parentTaskId: task.parent_task_id,
    dependsOn: task.depends_on ? [...task.depends_on] : undefined,
    tags: task.tags ? [...task.tags] : undefined,
    source: task.source,
    dueDate: task.due_date,
    startDate: task.start_date,
    endDate: task.end_date,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    completedAt: task.completed_at,
  }
}

function publicTaskSummary(task: Task | SlimTask) {
  return {
    id: task.id,
    title: task.title,
    phase: task.phase,
    priority: task.priority,
    project: task.project,
    parentTaskId: task.parent_task_id,
    dependsOn: task.depends_on ? [...task.depends_on] : undefined,
    tags: task.tags ? [...task.tags] : undefined,
    source: task.source,
    dueDate: task.due_date,
    startDate: task.start_date,
    endDate: task.end_date,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    completedAt: task.completed_at,
    hasDescription: 'has_description' in task ? !!task.has_description : !!task.description,
    hasSummary: 'has_summary' in task ? !!task.has_summary : !!task.summary,
    hasNote: 'has_note' in task ? !!task.has_note : !!task.note,
  }
}

function normalizeCustomEventName(pluginId: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(name)) {
    throw new Error(`Invalid Plugin event name: ${JSON.stringify(name)}`)
  }
  return `plugin:${pluginId}:${name}`
}

function namespacedDedup(pluginId: string, key: string): string {
  if (!key.trim() || key.length > 160) throw new Error('Plugin notification dedupKey must be 1-160 characters')
  return `plugin:${pluginId}:${key}`
}

function publicFetchResponse(response: Response) {
  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text: () => response.text(),
    json: <T>() => response.json() as Promise<T>,
  }
}

function publicProviderOptions(options: AdapterCallOptions): PluginProviderCallOptions {
  return {
    providerConfig: { ...options.providerConfig },
    model: options.model,
    maxTokens: options.maxTokens,
    system: options.system,
    messages: options.messages,
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.compat ? { compat: { ...options.compat } } : {}),
    ...(options.betas ? { betas: [...options.betas] } : {}),
    ...(options.thinking ? { thinking: options.thinking } : {}),
  }
}

export function createServerPluginApi(options: CreateServerPluginApiOptions) {
  const { context, legacyApi, contributions, integrationRegistry } = options
  const pluginId = context.id
  const storage = context.own(new PluginStorage(context.dataDir))
  const secrets = new PluginSecretStore(pluginId)
  const contextSnippets: string[] = contributions.agentContext ? [contributions.agentContext] : []
  let unsafeWarned = false

  const own = <T extends Disposable>(registration: T): T => context.own(registration)

  const notifyError = async (message: string, detail?: unknown): Promise<void> => {
    try {
      const { upsertNotification } = await import('../notifications/store.js')
      const { record, outcome } = await upsertNotification({
        kind: 'operation-error',
        severity: 'error',
        title: `${options.pluginName} error`,
        body: message,
        detail: detail instanceof Error ? detail.stack : detail === undefined ? undefined : String(detail),
        dedupKey: `plugin:${pluginId}:runtime`,
        recoveryKey: `plugin:${pluginId}`,
      })
      bus.emit(outcome === 'inserted' ? 'notification:new' : 'notification:updated', record, ['web-ui'], { source: `plugin/${pluginId}` })
    } catch (error) {
      context.logger.error('failed to publish Plugin error notification', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const api = {
    pluginId,
    pluginName: options.pluginName,
    walnutVersion: getVersion(),
    signal: context.signal,
    log: context.logger,

    tasks: {
      async get(id: string) {
        const { getTask } = await import('../task-manager.js')
        try { return publicTask(await getTask(id)) }
        catch (error) {
          if (error instanceof Error && /not found/i.test(error.message)) return null
          throw error
        }
      },
      async list(filter: { status?: string; phase?: TaskPhase | TaskPhase[]; project?: string; source?: string; parentTaskId?: string; limit?: number } = {}) {
        const { listTasksSlim } = await import('../task-manager.js')
        let tasks = await listTasksSlim({ status: filter.status, project: filter.project, source: filter.source, minimal: true })
        if (filter.phase) {
          const phases = new Set(Array.isArray(filter.phase) ? filter.phase : [filter.phase])
          tasks = tasks.filter((task) => phases.has(task.phase))
        }
        if (filter.parentTaskId !== undefined) tasks = tasks.filter((task) => task.parent_task_id === filter.parentTaskId)
        if (filter.limit !== undefined) tasks = tasks.slice(0, Math.max(0, filter.limit))
        return tasks.map(publicTaskSummary)
      },
      async query(query: Record<string, unknown>) {
        const { queryTasksSlim } = await import('../task-manager.js')
        return (await queryTasksSlim(query as unknown as TaskQuery, { minimal: true })).map(publicTaskSummary)
      },
      async children(id: string) {
        const { getChildTasks } = await import('../task-manager.js')
        return (await getChildTasks(id)).map(publicTaskSummary)
      },
      async create(input: {
        title: string; description?: string; priority?: TaskPriority; phase?: TaskPhase; project?: string;
        parentTaskId?: string; dependsOn?: string[]; tags?: string[]; dueDate?: string; startDate?: string; endDate?: string;
      }) {
        const { addTask, updateTask } = await import('../task-manager.js')
        const { task } = await addTask({
          title: input.title,
          description: input.description,
          priority: input.priority,
          project: input.project,
          parent_task_id: input.parentTaskId,
          depends_on: input.dependsOn,
          tags: input.tags,
          due_date: input.dueDate,
          start_date: input.startDate,
          end_date: input.endDate,
        })
        if (input.phase && input.phase !== task.phase) return publicTask((await updateTask(task.id, { phase: input.phase })).task)
        return publicTask(task)
      },
      async update(id: string, patch: Record<string, unknown>) {
        const { updateTask, updateDescription, updateNote, getTask } = await import('../task-manager.js')
        if (typeof patch.description === 'string') await updateDescription(id, patch.description)
        if (typeof patch.note === 'string') await updateNote(id, patch.note)
        const structural = {
          ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
          ...(typeof patch.priority === 'string' ? { priority: patch.priority as TaskPriority } : {}),
          ...(typeof patch.phase === 'string' ? { phase: patch.phase as TaskPhase } : {}),
          ...(typeof patch.project === 'string' ? { project: patch.project } : {}),
          ...(typeof patch.dueDate === 'string' || patch.dueDate === null ? { due_date: patch.dueDate ?? '' } : {}),
          ...(typeof patch.startDate === 'string' || patch.startDate === null ? { start_date: patch.startDate ?? '' } : {}),
          ...(typeof patch.endDate === 'string' || patch.endDate === null ? { end_date: patch.endDate ?? '' } : {}),
          ...(typeof patch.sprint === 'string' || patch.sprint === null ? { sprint: patch.sprint ?? '' } : {}),
          ...(Array.isArray(patch.tags) ? { set_tags: patch.tags as string[] } : {}),
          ...(Array.isArray(patch.dependsOn) ? { set_depends_on: patch.dependsOn as string[] } : {}),
        }
        const task = Object.keys(structural).length > 0 ? (await updateTask(id, structural)).task : await getTask(id)
        return publicTask(task)
      },
      async appendNote(id: string, markdown: string) {
        const { addNote } = await import('../task-manager.js')
        await addNote(id, markdown)
      },
      async appendLog(id: string, entry: string) {
        const { appendConversationLog } = await import('../task-manager.js')
        await appendConversationLog(id, entry)
      },
      async complete(id: string) {
        const { completeTask } = await import('../task-manager.js')
        return publicTask((await completeTask(id)).task)
      },
      async delete(id: string) {
        const { deleteTask } = await import('../task-manager.js')
        await deleteTask(id)
      },
    },

    config: {
      async get<T extends Record<string, unknown>>() {
        const config = await getConfig()
        return structuredClone((config.plugins?.[pluginId] ?? {}) as T)
      },
      async patch(partial: Record<string, unknown>) {
        const next = await updatePluginConfig(pluginId, partial)
        bus.emit(EventNames.CONFIG_CHANGED, { config: { plugins: { [pluginId]: next } } } as never, ['web-ui'], { source: `plugin/${pluginId}` })
      },
      onChange(handler: (config: Record<string, unknown>) => void | Promise<void>) {
        const subscriber = `plugin:${pluginId}:config:${++subscriberSequence}`
        bus.subscribe(subscriber, async (event) => {
          if (event.name !== EventNames.CONFIG_CHANGED) return
          const config = await getConfig()
          await handler(structuredClone(config.plugins?.[pluginId] ?? {}))
        }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
        return own(toDisposable(() => bus.unsubscribe(subscriber)))
      },
    },

    notifications: {
      async notify(notice: { title: string; body?: string; severity?: 'info' | 'success' | 'warning' | 'error'; dedupKey: string; taskId?: string; sessionId?: string }) {
        const { addNotification } = await import('../notifications/store.js')
        const record = await addNotification({
          kind: 'skill',
          severity: notice.severity ?? 'info',
          title: notice.title,
          body: notice.body,
          dedupKey: namespacedDedup(pluginId, notice.dedupKey),
          taskId: notice.taskId,
          sessionId: notice.sessionId,
        })
        bus.emit('notification:new', record, ['web-ui'], { source: `plugin/${pluginId}` })
      },
      async error(notice: { title: string; body?: string; severity?: 'info' | 'success' | 'warning' | 'error'; dedupKey: string; taskId?: string; sessionId?: string }) {
        const { upsertNotification } = await import('../notifications/store.js')
        const { record, outcome } = await upsertNotification({
          kind: 'operation-error',
          severity: notice.severity ?? 'error',
          title: notice.title,
          body: notice.body,
          dedupKey: namespacedDedup(pluginId, notice.dedupKey),
          recoveryKey: `plugin:${pluginId}`,
          taskId: notice.taskId,
          sessionId: notice.sessionId,
        })
        bus.emit(outcome === 'inserted' ? 'notification:new' : 'notification:updated', record, ['web-ui'], { source: `plugin/${pluginId}` })
      },
      async recover() {
        const { recoverNotifications } = await import('../notifications/store.js')
        const { recovered } = await recoverNotifications([`plugin:${pluginId}`])
        for (const record of recovered) bus.emit('notification:updated', record, ['web-ui'], { source: `plugin/${pluginId}` })
      },
    },

    ops: {
      async call<T = unknown>(
        name: string,
        args: Record<string, unknown> = {},
      ): Promise<{ ok: true; result: T } | { ok: false; message: string }> {
        return callPluginOp<T>(pluginId, name, args)
      },
      unwrap<T>(result: { ok: true; result: T } | { ok: false; message: string }): T {
        if (!result.ok) throw new Error(result.message)
        return result.result
      },
      async list() {
        return listPluginOps()
      },
    },

    events: {
      on(namesInput: string | string[], handler: (event: BusEvent) => void | Promise<void>) {
        const names = Array.isArray(namesInput) ? namesInput : [namesInput]
        if (names.length === 0 || names.some((name) => typeof name !== 'string' || !name)) {
          throw new Error('Plugin event subscription requires at least one event prefix')
        }
        const subscriber = `plugin:${pluginId}:event:${++subscriberSequence}`
        bus.subscribe(subscriber, async (event) => {
          try { await handler(event) }
          catch (error) {
            context.logger.error('Plugin event handler failed', {
              event: event.name,
              error: error instanceof Error ? error.message : String(error),
            })
            await notifyError(`Event handler failed for ${event.name}`, error)
          }
        }, { global: true, interest: names })
        return own(toDisposable(() => bus.unsubscribe(subscriber)))
      },
      emit(name: string, data: unknown) {
        bus.emit(normalizeCustomEventName(pluginId, name), data, ['web-ui'], { source: `plugin/${pluginId}` })
      },
    },

    http: {
      route(method: string, routePath: string, handler: PluginRouteHandler) {
        const route = createPluginHttpRoute(method, routePath, handler)
        contributions.httpRoutes.push(route)
        return own(toDisposable(() => removeIdentity(contributions.httpRoutes, route)))
      },
      async fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number } = {}) {
        const response = await fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body as BodyInit | undefined,
          signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
        })
        return publicFetchResponse(response)
      },
    },

    storage,
    secrets,

    timers: {
      timeout(handler: () => void | Promise<void>, delayMs: number) {
        const timer = setTimeout(() => {
          void Promise.resolve(handler()).catch((error) => notifyError('Timer callback failed', error))
        }, Math.max(0, delayMs))
        timer.unref?.()
        return own(toDisposable(() => clearTimeout(timer)))
      },
      interval(handler: () => void | Promise<void>, intervalMs: number) {
        let stopped = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const tick = async () => {
          try { await handler() }
          catch (error) { await notifyError('Interval callback failed', error) }
          if (!stopped) {
            timer = setTimeout(() => { void tick() }, Math.max(1, intervalMs))
            timer.unref?.()
          }
        }
        timer = setTimeout(() => { void tick() }, Math.max(1, intervalMs))
        timer.unref?.()
        return own(toDisposable(() => { stopped = true; if (timer) clearTimeout(timer) }))
      },
    },

    registry: {
      sync(adapter: unknown) {
        const internal = adapter as IntegrationSync
        legacyApi.registerSync(internal)
        return own(toDisposable(() => {
          if (contributions.sync === internal) contributions.sync = null
        }))
      },
      sourceClaim(claim: ProjectClaimFn, options?: { priority?: number }) {
        legacyApi.registerSourceClaim(claim, options)
        const registered = contributions.claim
        return own(toDisposable(() => {
          if (contributions.claim === registered) contributions.claim = null
        }))
      },
      display(meta: unknown) {
        const internal = meta as DisplayMeta
        legacyApi.registerDisplay(internal)
        return own(toDisposable(() => {
          if (contributions.display === internal) contributions.display = null
        }))
      },
      migration(migrate: unknown) {
        const internal = migrate as MigrateFn
        legacyApi.registerMigration(internal)
        return own(toDisposable(() => removeIdentity(contributions.migrations, internal)))
      },
      extIndex(spec: unknown) {
        const internal = spec as ExtIndexSpec
        legacyApi.registerExtIndex(internal)
        return own(toDisposable(() => {
          if (contributions.extIndex === internal) contributions.extIndex = null
        }))
      },
      tool(spec: { name: string; description: string; inputSchema?: Record<string, unknown>; execute(input: Record<string, unknown>): unknown | Promise<unknown> }) {
        const before = contributions.tools.length
        legacyApi.registerTool({
          name: spec.name,
          description: spec.description,
          input_schema: spec.inputSchema ?? { type: 'object', properties: {} },
          async execute(input) {
            const result = await spec.execute(input)
            if (typeof result === 'string' || Array.isArray(result)) return result as never
            return JSON.stringify(result, null, 2)
          },
        })
        const tool = contributions.tools[before]
        return own(toDisposable(() => { if (tool) removeIdentity(contributions.tools, tool) }))
      },
      wsMethod(id: string, handler: (payload: unknown) => unknown | Promise<unknown>) {
        const name = namespacePluginId(pluginId, id)
        return own(registerOwnedMethod(pluginId, name, async (payload) => handler(payload)))
      },
      agent(spec: PluginAgentSpec) {
        const id = namespacePluginId(pluginId, spec.id)
        return own(registerOwnedAgent(pluginId, { ...spec, id }))
      },
      provider(id: string, adapter: PluginProviderAdapter) {
        const protocol = namespacePluginId(pluginId, id)
        const wrapped: ProtocolAdapter = {
          protocol,
          async sendMessage(options) {
            return await adapter.sendMessage(publicProviderOptions(options)) as unknown as ModelResult
          },
          async sendMessageStream(options) {
            return await adapter.sendMessageStream({
              ...publicProviderOptions(options),
              ...(options.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
            }) as unknown as ModelResult
          },
          resetClient() {
            adapter.resetClient?.()
          },
        }
        return own(registerOwnedProviderAdapter(pluginId, protocol, wrapped))
      },
      cronAction(id: string, description: string, handler: (params: Record<string, unknown>) => Promise<ActionResult>) {
        return own(registerOwnedAction(pluginId, namespacePluginId(pluginId, id), handler, description))
      },
      hook(definition: PluginHookSpec) {
        const points = [...new Set([
          ...(definition.point ? [definition.point] : []),
          ...(definition.points ?? []),
        ])]
        if (points.length === 0) throw new Error('Plugin hook requires at least one hook point')
        for (const point of points) {
          if (!(point in HOOK_POINT_DOMAIN)) throw new Error(`Unknown Plugin hook point: ${point}`)
        }
        const dispatcher = getSessionHookDispatcher()
        if (!dispatcher) {
          context.logger.warn('Plugin hook skipped because the hook dispatcher is unavailable', {
            hookId: definition.id,
            points,
          })
          return own(toDisposable(() => undefined))
        }
        const id = namespacePluginId(pluginId, definition.id)
        dispatcher.addHook({
          id,
          name: `${options.pluginName}: ${definition.id}`,
          hooks: points,
          priority: definition.priority,
          enabled: definition.enabled,
          timeoutMs: definition.timeoutMs,
          filter: definition.filter,
          source: 'plugin',
          handler: async (payload) => { await definition.handler(payload) },
        })
        return own(toDisposable(() => dispatcher.removeHook(id)))
      },
      agentContext(text: string) {
        if (!text.trim()) throw new Error('Plugin agent context must not be empty')
        contextSnippets.push(text.trim())
        contributions.agentContext = contextSnippets.join('\n')
        return own(toDisposable(() => {
          const index = contextSnippets.indexOf(text.trim())
          if (index >= 0) contextSnippets.splice(index, 1)
          contributions.agentContext = contextSnippets.join('\n') || null
        }))
      },
      command(definition: PluginCommandDefinition) {
        return own(registerOwnedCommand(pluginId, definition))
      },
      skill(definition: PluginSkillDefinition) {
        const registration = registerOwnedSkillDir(pluginId, definition)
        // The skills index + prompt are cached until explicitly invalidated, so both
        // edges of a registration have to clear it — otherwise a newly installed
        // plugin's skills stay invisible until the next unrelated cache clear, and a
        // disabled plugin's skills keep being advertised.
        clearSkillsCache()
        return own(toDisposable(() => {
          registration.dispose()
          clearSkillsCache()
        }))
      },
    },

    get unsafe(): { readonly database: unknown; readonly bus: unknown; readonly walnutHome: string; readonly host: unknown } {
      if (!unsafeWarned) {
        unsafeWarned = true
        context.logger.warn('Plugin accessed unstable unsafe host APIs')
      }
      return {
        database: getDb(),
        bus,
        walnutHome: WALNUT_HOME,
        host: { integrationRegistry },
      }
    },
  }

  return api
}

export type WalnutServerPluginApi = ReturnType<typeof createServerPluginApi>
