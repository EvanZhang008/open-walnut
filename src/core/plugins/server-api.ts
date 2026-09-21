import type {
  DisplayMeta,
  ExtIndexSpec,
  HttpRoute,
  IntegrationSync,
  MigrateFn,
  PluginApi,
  PluginConnection,
  PluginToolSpec,
  ProjectClaimFn,
} from '../integration-types.js'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IntegrationRegistry } from '../integration-registry.js'
import type { PluginContext, PluginLogger } from './plugin-context.js'
import { PluginStorage, PluginSecretStore } from './plugin-storage.js'
import { createPluginHttpRoute, type PluginRouteHandler } from './plugin-route-adapter.js'
import { namespacePluginId, pluginOpName } from './ids.js'
import { registerOwnedCommand, type PluginCommandDefinition } from './command-registry.js'
import { registerOwnedSkillDir, type PluginSkillDefinition } from './skill-registry.js'
import {
  assertServiceAvailable,
  createServiceHandle,
  currentServiceCaller,
  publishService,
  resolveServiceAccess,
  SERVICE_CHANGED_EVENT,
  type ServiceApi,
  type ServiceChange,
} from './service-registry.js'
import { clearSkillsCache } from '../skill-loader.js'
import { toDisposable, type Disposable } from './disposable.js'
import { bus, EventNames, type BusEvent } from '../event-bus.js'
import type { HumanInboxAnsweredEvent } from '../event-types.js'
import { getConfig, updatePluginConfig } from '../config-manager.js'
import { getVersion } from '../version.js'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'
import { getDb } from '../task-db.js'
import type { AgentDefinition, Task, TaskPhase, TaskPriority } from '../types.js'
import type { SlimTask } from '../task-manager.js'
import type { TaskQuery } from '../task-query.js'
import { registerOwnedAction, type ActionResult } from '../cron/actions.js'
import { getSessionHookDispatcher } from '../session-hooks/index.js'
import { HOOK_POINT_DOMAIN, type HookFilter, type HookPoint } from '../session-hooks/types.js'
// EAGER on purpose, not the lazy import the call sites below also do. Plugins
// activate long before anything first needs an op, so without this the core ops
// are absent while a plugin registers, `definePluginOp` cannot see the name it
// would shadow, and the first later `import('../../ops/index.js')` throws on the
// duplicate — a failure ESM caches for the life of the process.
import '../../ops/index.js'
import { executeOp } from '../../ops/executor.js'
import { countOwnerOps, definePluginOp, listOpEntries, type HttpBinding, type WalnutOp } from '../../ops/registry.js'
import { jsonSchemaToZodShape } from '../../ops/schema-to-zod.js'
import { registerOwnedMethod } from '../../web/ws/handler.js'
import { registerOwnedAgent } from '../agent-registry.js'
import { registerOwnedProviderAdapter } from '../../model/providers/registry.js'
import type {
  AdapterCallOptions,
  ModelResult,
  ProtocolAdapter,
} from '../../model/providers/types.js'

/** Plugins already warned about agentContext — once each, not once per reload. */
const agentContextWarned = new Set<string>()

interface ContributionCollector {
  sync: IntegrationSync | null
  claim: { fn: ProjectClaimFn; priority: number } | null
  display: DisplayMeta | null
  connection: PluginConnection | null
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
  /** This plugin's manifest `dependencies`. `services.get` refuses a key published by a
   *  plugin that is not in here, because only a declared dependency is ordered before us. */
  dependencies?: Record<string, string>
  /** Another plugin's current lifecycle state, so an unavailable service says why. */
  lookupPluginState?: (pluginId: string) => string | undefined
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

interface PluginOpSpec {
  name: string
  title: string
  description: string
  inputSchema?: Record<string, unknown>
  readonly: boolean
  remote?: 'allow' | 'deny'
  destructive?: boolean
  /** Deadline for EACH `ctx.call`, not for the handler as a whole. */
  timeoutMs?: number
  handler(
    args: Record<string, unknown>,
    ctx: { call(method: HttpBinding['method'], path: string, body?: unknown): Promise<unknown> },
  ): Promise<unknown>
}

/**
 * Same 1024-char number the loader uses for tool descriptions, but a different
 * answer: the loader TRUNCATES a long tool description, this REFUSES the op. An op
 * description is its documented contract on every surface, so silently publishing
 * a sentence cut in half is worse than making the author shorten it.
 */
const MAX_OP_DESCRIPTION = 1024

/** A plugin curating the agent-facing surface is fine; a plugin flooding it is not. */
const MAX_OPS_PER_PLUGIN = 24

/**
 * Letters one plugin may send per minute.
 *
 * A letter is the loudest thing a plugin can do: it lands in the human inbox, it badges the
 * bell and it pushes to the phone. A loop that asks for approval per item would otherwise
 * turn one bug into a night of notifications, so the ceiling is low enough that a runaway is
 * refused with words the author can act on, and high enough that a real burst (a batch of
 * drafts approved one at a time) still gets through.
 */
const LETTERS_PER_MINUTE = 30
const LETTER_WINDOW_MS = 60_000

/** The letter kind for a plugin letter with no buttons: a document, not a decision. */
const INFORMATIONAL_LETTER_TYPE = 'info' as const

interface PluginLetterInput {
  subject: string
  markdown?: string
  html?: string
  text?: string
  actions?: Array<{ id: string; label: string; description?: string }>
  taskRefs?: string[]
  pin?: boolean
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

/**
 * Letter send times per plugin, in module scope rather than per api instance.
 *
 * A plugin reload builds a fresh api bag, so a counter living on that bag would let a
 * reload loop send without limit. Keyed by plugin id, the window survives the reload.
 */
const letterSendTimes = new Map<string, number[]>()

function chargeLetterQuota(pluginId: string): void {
  const now = Date.now()
  const recent = (letterSendTimes.get(pluginId) ?? []).filter((at) => now - at < LETTER_WINDOW_MS)
  if (recent.length >= LETTERS_PER_MINUTE) {
    letterSendTimes.set(pluginId, recent)
    throw new Error(
      `The plugin "${pluginId}" has already sent ${LETTERS_PER_MINUTE} letters in the last minute, `
      + 'which is the limit. A letter badges the bell and pushes to the phone, so a loop that sends '
      + 'one per item would bury the human. Roll the batch up into one letter, or wait out the minute.',
    )
  }
  recent.push(now)
  letterSendTimes.set(pluginId, recent)
}

/** Test-only: forget every plugin's letter window, so one test's burst is not the next one's. */
export function _resetPluginLetterQuotaForTesting(): void {
  letterSendTimes.clear()
}

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

export async function listPluginOps(): Promise<Array<{ name: string; title: string; readonly: boolean; owner: string }>> {
  await import('../../ops/index.js')
  return listOpEntries().map(({ owner, op }) => ({
    name: op.name,
    title: op.title,
    readonly: op.tags.readonly,
    owner,
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

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fsp.stat(candidate)).isFile()
  } catch {
    return false
  }
}

/**
 * A registered skill directory is the ROOT ABOVE `<name>/SKILL.md`. Handing over the
 * folder that holds SKILL.md registers happily, contributes nothing, and used to be
 * silent at every layer, so probe the layout and say so.
 *
 * Deliberately fail-soft and off the registration path: async (never delays activate),
 * never throws, and a MISSING directory says nothing because a plugin creating it later
 * is legitimate. Accepts the flat and the `<category>/<name>` layouts the loader accepts,
 * so a correct registration is never warned about.
 */
async function warnOnSkillDirLayout(
  logger: PluginLogger,
  pluginId: string,
  definition: PluginSkillDefinition,
): Promise<void> {
  const directory = path.resolve(definition.directory)
  let entries: string[]
  try {
    entries = await fsp.readdir(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    if (await isFile(path.join(directory, entry, 'SKILL.md'))) return
    let nested: string[]
    try {
      nested = await fsp.readdir(path.join(directory, entry))
    } catch {
      continue
    }
    for (const child of nested) {
      if (await isFile(path.join(directory, entry, child, 'SKILL.md'))) return
    }
  }
  const isSkillFolderItself = await isFile(path.join(directory, 'SKILL.md'))
  logger.warn(
    isSkillFolderItself
      ? 'Plugin skill directory is the skill folder itself; register its parent'
      : 'Plugin skill directory holds no <name>/SKILL.md',
    { pluginId, skillId: definition.id, directory },
  )
}

export function createServerPluginApi(options: CreateServerPluginApiOptions) {
  const { context, legacyApi, contributions, integrationRegistry } = options
  const pluginId = context.id
  const storage = context.own(new PluginStorage(context.dataDir))
  const secrets = new PluginSecretStore(pluginId)
  const contextSnippets: string[] = contributions.agentContext ? [contributions.agentContext] : []
  let unsafeWarned = false

  const own = <T extends Disposable>(registration: T): T => context.own(registration)

  /** Refuse a registration BEFORE it writes: `own()` notices too late, so a late publish from a replaced generation lands on the live row and the dispose that follows deletes it. Reads, logging, storage and config stay open for the teardown itself. */
  const assertLive = (registration: string): void => {
    if (!context.signal.aborted) return
    context.logger.warn('Plugin registration refused after disposal', { registration })
    context.signal.throwIfAborted()
  }

  // Declared as consts, not methods on the bag: a plugin may destructure
  // `const { require } = walnut.services`, which would strip `this`.
  const serviceHandle = <T>(key: string, assertNow: boolean): T => {
    const publisherId = resolveServiceAccess(pluginId, key, options.dependencies)
    if (assertNow) assertServiceAvailable(key, publisherId, options.lookupPluginState)
    return createServiceHandle<T>({
      key,
      publisherId,
      consumerId: pluginId,
      ...(options.lookupPluginState ? { lookupState: options.lookupPluginState } : {}),
    })
  }

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
    // A plugin that owns an outside account has to know which box it is on: two Walnuts
    // polling one mailbox double every fetch and every write.
    replica: CLOUD_MODE,
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
        const created = input.phase && input.phase !== task.phase
          ? (await updateTask(task.id, { phase: input.phase })).task
          : task
        // `addTask` emits NOTHING, so every create path emits at its own call site. This one did
        // not, and the symptom was a task nobody could see: no open browser learned the row existed
        // (its list only refetches on the event), and the search index never picked it up, so a task
        // a plugin made was unfindable until something unrelated triggered a full reload. Emitted
        // AFTER the optional phase update so the payload is the task as it was persisted.
        bus.emit(EventNames.TASK_CREATED, { task: created }, ['web-ui'], { source: `plugin/${pluginId}` })
        return publicTask(created)
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
        assertLive('config.onChange')
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

    /**
     * Letters: ask the ONE human a question, wherever they are, and hear the answer back.
     *
     * A letter is a document in the human inbox with optional one-tap actions, and it renders
     * on the console and on the phone. It is the host's approval object: a plugin that must not
     * act without a human decision (sending mail, spending money, deleting somebody else's
     * data) sends a letter with actions and does nothing until `onAnswered` fires.
     *
     * The envelope is stamped HERE, never by the caller: `sessionId: 'external'` because a
     * plugin is not a session, plus this plugin's id, which is what makes `onAnswered` an exact
     * filter instead of "anything external". A plugin letter therefore has no origin session to
     * deliver a choice to, and the bus event is the return path by design.
     */
    letters: {
      async send(input: PluginLetterInput): Promise<{ letterId: string }> {
        chargeLetterQuota(pluginId)
        const { sendLetter } = await import('../human-inbox/store.js')
        const letter = await sendLetter({
          subject: input.subject,
          // Buttons are what makes it a decision. Without them it is a document, and the store
          // refuses `action_required` with no actions precisely so a dead end cannot ship.
          type: input.actions?.length ? 'action_required' : INFORMATIONAL_LETTER_TYPE,
          ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
          ...(input.html !== undefined ? { html: input.html } : {}),
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.actions?.length ? { actions: input.actions.map((one) => ({ ...one })) } : {}),
          ...(input.taskRefs ? { taskRefs: [...input.taskRefs] } : {}),
          ...(input.pin !== undefined ? { pin: input.pin } : {}),
          // `local` matches the sender the inbox already uses for a caller with no session: a
          // plugin runs inside THIS server process, which is the box the human is looking at.
          sender: { sessionId: 'external', host: 'local', pluginId },
        })
        return { letterId: letter.id }
      },
      async reply(letterId: string, input: { markdown?: string; html?: string; text?: string }): Promise<void> {
        const { agentReply } = await import('../human-inbox/store.js')
        // A thread turn always carries plain text (that is what the thread renders), so a rich
        // reply that omitted it would be refused by the store. Derived rather than rejected.
        const text = input.text?.trim() || (input.markdown ?? input.html ?? '').trim()
        await agentReply(letterId, {
          text,
          ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
          ...(input.html !== undefined ? { html: input.html } : {}),
        })
      },
      async withdraw(letterId: string, input: { note: string }): Promise<void> {
        const { withdrawLetterAndAnnounce } = await import('../human-inbox/letter-ops.js')
        await withdrawLetterAndAnnounce(letterId, input)
      },
      async get(letterId: string): Promise<{
        letterId: string
        subject: string
        actions: Array<{ id: string; label: string; description?: string }>
        answered?: { actionId: string; label: string; freeText?: string; at: number }
      } | null> {
        const { getLetter } = await import('../human-inbox/store.js')
        // `inlineMaxBytes: 0` keeps a 100MB media body off this path: the caller asked about the
        // letter's STATE, and reading the document to answer that would be the expensive bug.
        const letter = await getLetter(letterId, { inlineMaxBytes: 0 })
        if (!letter) return null
        return {
          letterId: letter.id,
          subject: letter.subject,
          actions: (letter.actions ?? []).map((one) => ({ ...one })),
          ...(letter.answered ? { answered: { ...letter.answered } } : {}),
        }
      },
      onAnswered(handler: (event: HumanInboxAnsweredEvent) => void | Promise<void>) {
        assertLive('letters.onAnswered')
        const subscriber = `plugin:${pluginId}:letters:${++subscriberSequence}`
        bus.subscribe(subscriber, async (event) => {
          const payload = event.data as HumanInboxAnsweredEvent | undefined
          // ONLY this plugin's own letters. Without the filter a plugin would be handed every
          // session's approval and every other plugin's, and an approval ledger keyed on a
          // letter id it never issued is a bug waiting for a collision.
          if (!payload?.letterId || payload.pluginId !== pluginId) return
          try { await handler(payload) }
          catch (error) {
            context.logger.error('Plugin letter answer handler failed', {
              letterId: payload.letterId,
              error: error instanceof Error ? error.message : String(error),
            })
            await notifyError(`Letter answer handler failed for ${payload.letterId}`, error)
          }
        }, { global: true, interest: ['human-inbox:answered'] })
        return own(toDisposable(() => bus.unsubscribe(subscriber)))
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

    services: {
      publish(name: string, api: ServiceApi) {
        // The one that matters most: publish REPLACES the key, so a late one lands on the live row.
        assertLive(`services.publish("${name}")`)
        return own(publishService(pluginId, name, api))
      },
      // Lazy: nothing is resolved until the first call, so a plugin may take a handle to a
      // key that is not published yet (a peer that publishes later in its own activate).
      get<T = ServiceApi>(key: string): T {
        return serviceHandle<T>(key, false)
      },
      // Eager: asserts a publisher exists RIGHT NOW, so a typo'd key fails inside the
      // caller's activate where the stack still names it, not at some later call.
      require<T = ServiceApi>(key: string): T {
        return serviceHandle<T>(key, true)
      },
      // Meaningful only inside the synchronous body of one of THIS plugin's published
      // methods; `undefined` when the host called, or outside a service call entirely.
      caller(): string | undefined {
        return currentServiceCaller()
      },
      onChange(handler: (change: ServiceChange) => void | Promise<void>) {
        assertLive('services.onChange')
        const subscriber = `plugin:${pluginId}:services:${++subscriberSequence}`
        bus.subscribe(subscriber, async (event) => {
          // A subscriber that throws must not reach the emitter: publish and teardown
          // both emit synchronously from inside a lifecycle step.
          try { await handler(event.data as ServiceChange) }
          catch (error) {
            context.logger.error('Plugin service change handler failed', {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }, { global: true, interest: [SERVICE_CHANGED_EVENT] })
        return own(toDisposable(() => bus.unsubscribe(subscriber)))
      },
    },

    events: {
      on(namesInput: string | string[], handler: (event: BusEvent) => void | Promise<void>) {
        assertLive('events.on')
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
        assertLive(`http.route(${method} ${routePath})`)
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
        assertLive('timers.timeout')
        const timer = setTimeout(() => {
          void Promise.resolve(handler()).catch((error) => notifyError('Timer callback failed', error))
        }, Math.max(0, delayMs))
        timer.unref?.()
        return own(toDisposable(() => clearTimeout(timer)))
      },
      interval(handler: () => void | Promise<void>, intervalMs: number) {
        assertLive('timers.interval')
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
        assertLive('registry.sync')
        const internal = adapter as IntegrationSync
        legacyApi.registerSync(internal)
        return own(toDisposable(() => {
          if (contributions.sync === internal) contributions.sync = null
        }))
      },
      sourceClaim(claim: ProjectClaimFn, options?: { priority?: number }) {
        assertLive('registry.sourceClaim')
        legacyApi.registerSourceClaim(claim, options)
        const registered = contributions.claim
        return own(toDisposable(() => {
          if (contributions.claim === registered) contributions.claim = null
        }))
      },
      display(meta: unknown) {
        assertLive('registry.display')
        const internal = meta as DisplayMeta
        legacyApi.registerDisplay(internal)
        return own(toDisposable(() => {
          if (contributions.display === internal) contributions.display = null
        }))
      },
      connection(link: unknown) {
        assertLive('registry.connection')
        const internal = link as PluginConnection
        legacyApi.registerConnection(internal)
        return own(toDisposable(() => {
          if (contributions.connection === internal) contributions.connection = null
        }))
      },
      migration(migrate: unknown) {
        assertLive('registry.migration')
        const internal = migrate as MigrateFn
        legacyApi.registerMigration(internal)
        return own(toDisposable(() => removeIdentity(contributions.migrations, internal)))
      },
      extIndex(spec: unknown) {
        assertLive('registry.extIndex')
        const internal = spec as ExtIndexSpec
        legacyApi.registerExtIndex(internal)
        return own(toDisposable(() => {
          if (contributions.extIndex === internal) contributions.extIndex = null
        }))
      },
      tool(spec: { name: string; description: string; inputSchema?: Record<string, unknown>; execute(input: Record<string, unknown>): unknown | Promise<unknown> }) {
        assertLive(`registry.tool("${spec.name}")`)
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
      op(spec: PluginOpSpec) {
        assertLive(`registry.op("${spec.name}")`)
        const name = pluginOpName(pluginId, spec.name)
        const title = spec.title?.trim()
        const description = spec.description?.trim()
        if (!title) throw new Error(`Plugin op "${name}" requires a title`)
        if (!description) throw new Error(`Plugin op "${name}" requires a description`)
        if (description.length > MAX_OP_DESCRIPTION) {
          throw new Error(`Plugin op "${name}" description exceeds ${MAX_OP_DESCRIPTION} characters`)
        }
        if (countOwnerOps(pluginId) >= MAX_OPS_PER_PLUGIN) {
          throw new Error(`Plugin "${pluginId}" may register at most ${MAX_OPS_PER_PLUGIN} ops`)
        }
        // `=== true`, not the raw value: a plain-JS plugin that omits `readonly`
        // would otherwise land `undefined` in the tags, which the cloud relay's
        // validator rejects, silently dropping the op from a replica's catalogue.
        const readonly = spec.readonly === true
        const op: WalnutOp = {
          name,
          title,
          description,
          input: jsonSchemaToZodShape(spec.inputSchema),
          // A plugin op is in-process by construction: it never gets an HTTP `bind`,
          // so `call` is the only way it can reach a route, exactly like a core handler.
          handler: (args, call) => spec.handler(args, { call }),
          ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
          tags: {
            readonly,
            remote: spec.remote ?? (readonly ? 'allow' : 'deny'),
            ...(spec.destructive !== undefined ? { destructive: spec.destructive } : {}),
          },
        }
        return own(definePluginOp(pluginId, op))
      },
      wsMethod(id: string, handler: (payload: unknown) => unknown | Promise<unknown>) {
        assertLive(`registry.wsMethod("${id}")`)
        const name = namespacePluginId(pluginId, id)
        return own(registerOwnedMethod(pluginId, name, async (payload) => handler(payload)))
      },
      agent(spec: PluginAgentSpec) {
        assertLive(`registry.agent("${spec.id}")`)
        const id = namespacePluginId(pluginId, spec.id)
        return own(registerOwnedAgent(pluginId, { ...spec, id }))
      },
      provider(id: string, adapter: PluginProviderAdapter) {
        assertLive(`registry.provider("${id}")`)
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
        assertLive(`registry.cronAction("${id}")`)
        return own(registerOwnedAction(pluginId, namespacePluginId(pluginId, id), handler, description))
      },
      hook(definition: PluginHookSpec) {
        assertLive(`registry.hook("${definition.id}")`)
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
        assertLive('registry.agentContext')
        if (!text.trim()) throw new Error('Plugin agent context must not be empty')
        // Collected, then read by nothing: a session gets its instructions from
        // skills. Warned once per plugin because only the author can fix it.
        if (!agentContextWarned.has(pluginId)) {
          agentContextWarned.add(pluginId)
          context.logger.warn('registry.agentContext is deprecated and reaches no model — register a skill instead')
        }
        contextSnippets.push(text.trim())
        contributions.agentContext = contextSnippets.join('\n')
        return own(toDisposable(() => {
          const index = contextSnippets.indexOf(text.trim())
          if (index >= 0) contextSnippets.splice(index, 1)
          contributions.agentContext = contextSnippets.join('\n') || null
        }))
      },
      command(definition: PluginCommandDefinition) {
        assertLive(`registry.command("${definition.id}")`)
        return own(registerOwnedCommand(pluginId, definition))
      },
      skill(definition: PluginSkillDefinition) {
        assertLive(`registry.skill("${definition.id}")`)
        const registration = registerOwnedSkillDir(pluginId, definition)
        // The skills index + prompt are cached until explicitly invalidated, so both
        // edges of a registration have to clear it — otherwise a newly installed
        // plugin's skills stay invisible until the next unrelated cache clear, and a
        // disabled plugin's skills keep being advertised.
        clearSkillsCache()
        warnOnSkillDirLayout(context.logger, pluginId, definition).catch(() => undefined)
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
