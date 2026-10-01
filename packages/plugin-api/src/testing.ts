import type { Disposable, PluginLogger, WalnutTask, WalnutTaskSummary } from './shared.js'
import type {
  LetterAnsweredEvent,
  LetterSendInput,
  LetterState,
  PluginEvent,
  PluginNotice,
  PluginNotifyInput,
  PluginOpDefinition,
  QuietHold,
  QuietState,
  ServiceApi,
  StatusItemState,
  ServiceChange,
  HostInfo,
  HostRunInput,
  HostRunResult,
  TaskFilingInput,
  TaskFilingResult,
  WalnutServerApi,
} from './server.js'

/** Walnut's importer tag and project names, restated so a fake behaves like the host. */
const FAKE_IMPORT_TAG = 'walnut:external-sessions'
const fakeImportProject = (host: string) => host === '__local__' ? 'Imported from this Mac' : `Imported from ${host}`

function disposable(dispose: () => void = () => undefined): Disposable {
  let active = true
  return {
    dispose() {
      if (!active) return
      active = false
      dispose()
    },
  }
}

function logger(): PluginLogger {
  const value: PluginLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    child: () => value,
  }
  return value
}

function summary(task: WalnutTask): WalnutTaskSummary {
  const { description, summary: taskSummary, note, ...rest } = task
  return {
    ...rest,
    hasDescription: !!description,
    hasSummary: !!taskSummary,
    hasNote: !!note,
  }
}

export interface FakeWalnutOptions {
  pluginId?: string
  pluginName?: string
  walnutVersion?: string
  tasks?: WalnutTask[]
  /** Folders that exist before activate. A task files into one through its `groupId`. */
  folders?: Array<{ id: string; label: string; project: string; parentId?: string }>
  /** Hosts besides this machine (`__local__`, always present). */
  hosts?: HostInfo[]
  /** Answers `hosts.run`. Without one, a run throws: a test must never reach a real host. */
  runOnHost?: (alias: string, input: HostRunInput) => HostRunResult | Promise<HostRunResult>
  /** What `sessionImports.autoCompleteAfterDays()` answers. Default 7, the host's default. */
  importAutoCompleteAfterDays?: number
  /** Pin groups that exist before activate (`tasks.pinGroups`); their ids are tiers a
   *  `pinTier` may name besides the built-in ones. */
  pinGroups?: Array<{ id: string; label: string }>
  /** Custom tier ids a `pinTier` may name besides the built-in ones (no label; prefer `pinGroups`). */
  customTiers?: string[]
  config?: Record<string, unknown>
  overrides?: Partial<WalnutServerApi>
}

export interface FakeWalnutResult {
  api: WalnutServerApi
  /** Live notices: a reminder re-fire replaces its key, `dismiss` removes it. */
  notices: PluginNotifyInput[]
  errors: PluginNotice[]
  emitted: PluginEvent[]
  /** Ops the plugin registered and has not disposed, in registration order. */
  registeredOps: PluginOpDefinition[]
  /**
   * Every live service, keyed `<pluginId>:<name>`. Seed a dependency's api here BEFORE
   * calling `activate` to stand in for the plugin you depend on, and read it after to
   * assert what your own plugin published.
   */
  services: Map<string, ServiceApi>
  /** Every letter the plugin sent, in order, with its current state. */
  letters: LetterState[]
  /**
   * Stand in for the human: records the answer on the letter and fires the plugin's
   * `onAnswered` handlers, the way the real inbox does. A letter can be answered once.
   */
  answerLetter(letterId: string, actionId: string, freeText?: string): Promise<void>
  /** What each status item shows now, by id. A cleared or disposed item is absent. */
  statusItems: Map<string, StatusItemState>
  /** Every `hosts.run` call, in order. */
  hostRuns: Array<{ alias: string; input: HostRunInput }>
  /** Stand in for Walnut's importer finishing a run: fires every `sessionImports.onRun` handler. */
  importRun(): Promise<void>
  /** Projects the plugin extended the importer's lifecycle to (`sessionImports.extendTo`), live ones only. */
  importLifecycleProjects: string[]
  /** The plugin's live tag display defaults (`tags.setDefaultDisplay`), by pattern. */
  tagDisplayDefaults: Map<string, 'shown' | 'hidden'>
  /** The board's pin groups, seeded ones and those the plugin ensured, in order. */
  pinGroups: Array<{ id: string; label: string }>
}

export function createFakeWalnut(options: FakeWalnutOptions = {}): FakeWalnutResult {
  const taskMap = new Map((options.tasks ?? []).map((task) => [task.id, structuredClone(task)]))
  const folderMap = new Map<string, { id: string; label: string; project: string; parentId?: string }>(
    (options.folders ?? []).map((folder) => [folder.id, structuredClone(folder)]),
  )
  let nextFolder = 1
  const notices: PluginNotifyInput[] = []
  const errors: PluginNotice[] = []
  const emitted: PluginEvent[] = []
  const registeredOps: PluginOpDefinition[] = []
  const services = new Map<string, ServiceApi>()
  const letters: LetterState[] = []
  const statusItems = new Map<string, StatusItemState>()
  const hostList: HostInfo[] = [{ alias: '__local__', local: true, enabled: true }, ...(options.hosts ?? []).map((host) => structuredClone(host))]
  const hostRuns: Array<{ alias: string; input: HostRunInput }> = []
  const importWatchers = new Set<() => void | Promise<void>>()
  const importRun = async () => { for (const handler of [...importWatchers]) await handler() }
  const importLifecycleProjects: string[] = []
  const tagDisplayDefaults = new Map<string, 'shown' | 'hidden'>()
  const pinGroups: Array<{ id: string; label: string }> = (options.pinGroups ?? []).map((group) => ({ ...group }))
  const knownTiers = new Set(['focus', 'satellite', 'backlog', 'wait', ...(options.customTiers ?? []), ...pinGroups.map((group) => group.id)])
  let nextGroup = 1
  const registeredItems = new Set<string>()
  const letterWatchers = new Set<(event: LetterAnsweredEvent) => void | Promise<void>>()
  const answerLetter = async (letterId: string, actionId: string, freeText?: string, source: LetterAnsweredEvent['source'] = 'web') => {
    const letter = letters.find((one) => one.letterId === letterId)
    if (!letter) throw new Error(`Letter "${letterId}" not found`)
    if (letter.answered) throw new Error(`Letter "${letterId}" was already answered`)
    const action = letter.actions.find((one) => one.id === actionId)
    const label = action?.label ?? actionId
    const answeredAt = Date.now()
    letter.answered = { actionId, label, freeText, at: answeredAt }
    const event: LetterAnsweredEvent = { letterId, actionId, label, freeText, answeredAt, source, pluginId: options.pluginId ?? 'test-plugin' }
    for (const handler of letterWatchers) await handler(event)
  }
  const serviceWatchers = new Set<(change: ServiceChange) => void | Promise<void>>()
  const subscriptions = new Set<{ names: string[]; handler: (event: PluginEvent) => void | Promise<void> }>()
  const files = new Map<string, unknown>()
  // The real `updateJson` holds a cross-process file lock across read + mutate + write.
  // Without the same serialization here, two updates that await inside their mutation both
  // read the pre-update value and the later write drops the earlier one, so a plugin's
  // concurrency test passes against the fake and loses data in production.
  const updateChains = new Map<string, Promise<unknown>>()
  const secrets = new Map<string, string>()
  let config = structuredClone(options.config ?? {})
  const controller = new AbortController()
  let nextTask = 1

  /** The host's filing rules, for both targets: with a `groupId` every task joins that
   *  folder; without one a task keeps its folder unless it changes project. */
  function fileTasks(items: TaskFilingInput[], place: { project: string; groupId?: string }): TaskFilingResult {
    const result: TaskFilingResult = { filed: [], skipped: [] }
    const seen = new Set<string>()
    const sameProject = (a: string | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase()
    for (const item of items) {
      if (typeof item.pinTier === 'string' && !knownTiers.has(item.pinTier)) throw new Error(`unknown pin tier "${item.pinTier}"`)
    }
    // The pinned order as the host keeps it: a new pin at the bottom, or in a block above
    // every pin so far when the item asks for the top, item order kept either way.
    const orders = [...taskMap.values()].filter((task) => task.pinned).map((task) => task.pinOrder ?? 0)
    const topAsked = items.filter((item) => typeof item.pinTier === 'string' && item.pinAt === 'top').length
    let nextPin = orders.length ? Math.max(...orders) + 1 : 0
    let topPin = orders.length ? Math.min(...orders) - topAsked : 0
    for (const item of items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      const task = taskMap.get(item.id)
      if (!task) { result.skipped.push({ id: item.id, reason: 'missing' }); continue }
      if (item.expectProject !== undefined && !sameProject(task.project, item.expectProject)) {
        result.skipped.push({ id: task.id, reason: 'changed' }); continue
      }
      // Same rules as the host: a synced task is only filed, tags are added.
      const moving = !sameProject(task.project, place.project)
      const removes = new Set((item.removeTags ?? []).filter((tag) => (task.tags ?? []).includes(tag)))
      const adds = (item.addTags ?? []).filter((tag) => tag.trim() && (removes.has(tag) || !(task.tags ?? []).includes(tag)))
      for (const tag of adds) removes.delete(tag)
      const title = item.title?.trim()
      const retitle = !!title && title !== task.title && (item.expectTitle === undefined || item.expectTitle === task.title)
      const createdMs = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : NaN
      const createdAt = Number.isFinite(createdMs) && createdMs <= Date.now() ? new Date(createdMs).toISOString() : undefined
      const redate = !!createdAt && createdAt !== task.createdAt
      if (task.source !== 'local' && (moving || adds.length > 0 || removes.size > 0 || retitle || redate)) {
        result.skipped.push({ id: task.id, reason: 'synced' }); continue
      }
      const joining = place.groupId !== undefined && task.groupId !== place.groupId
      const unfiling = place.groupId === undefined && item.topLevel === true && task.groupId !== undefined
      const unpinning = item.pinTier === null && !!task.pinned
      const wantTier = typeof item.pinTier === 'string' && task.phase !== 'COMPLETE'
        ? (item.pinTier === 'satellite' ? undefined : item.pinTier) : undefined
      const pinning = typeof item.pinTier === 'string' && task.phase !== 'COMPLETE' && !task.pinned
      const retiering = typeof item.pinTier === 'string' && task.phase !== 'COMPLETE' && (task.focusTier ?? undefined) !== wantTier
      const reorder = !!task.pinned && typeof item.pinTier === 'string' && task.phase !== 'COMPLETE' && item.pinAt !== undefined
      if (!moving && !joining && !unfiling && adds.length === 0 && removes.size === 0 && !retitle && !redate && !unpinning && !pinning && !retiering && !reorder) continue
      // A folder never follows a task into another project.
      if (moving || unfiling) delete task.groupId
      if (moving) task.project = place.project
      if (place.groupId !== undefined) task.groupId = place.groupId
      if (adds.length || removes.size) task.tags = [...new Set([...(task.tags ?? []).filter((tag) => !removes.has(tag)), ...adds])]
      if (retitle) task.title = title!
      if (redate) task.createdAt = createdAt
      if (unpinning) { task.pinned = false; delete task.pinOrder; delete task.focusTier }
      const replacing = !pinning && !!task.pinned && typeof item.pinTier === 'string' && task.phase !== 'COMPLETE' && item.pinAt !== undefined
      if (pinning) { task.pinned = true; task.pinOrder = item.pinAt === 'top' ? topPin++ : nextPin++ }
      else if (replacing) task.pinOrder = item.pinAt === 'top' ? topPin++ : nextPin++
      if (pinning || retiering) {
        if (wantTier === undefined) delete task.focusTier
        else task.focusTier = wantTier
      }
      task.updatedAt = new Date().toISOString()
      result.filed.push(task.id)
    }
    return result
  }

  function notifyServices(change: ServiceChange): void {
    for (const watcher of serviceWatchers) void watcher(change)
  }

  /** The host's method-bag rule, restated so a plugin test fails the same way the host does. */
  function assertMethodBag(key: string, api: ServiceApi): void {
    const rule = 'a service api must be a plain object whose own enumerable properties are all functions'
    const prototype = Object.getPrototypeOf(api)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Service "${key}" cannot be published: ${rule}`)
    }
    for (const [name, value] of Object.entries(api)) {
      if (typeof value !== 'function') {
        throw new Error(`Service "${key}" cannot be published: ${rule}, but "${name}" is ${typeof value}`)
      }
    }
    if (Object.prototype.hasOwnProperty.call(api, 'then')) {
      throw new Error(`Service "${key}" cannot be published: a service api may not have a method named "then"`)
    }
  }

  function requireService(key: string): ServiceApi {
    const api = services.get(key)
    if (!api) throw new Error(`No fake service published: ${key}`)
    return api
  }

  /** Resolved from the map at CALL time, like the host's handle. */
  function serviceHandle<T>(key: string): T {
    return new Proxy({} as ServiceApi, {
      get(_target, property) {
        if (typeof property === 'symbol') return undefined
        const value = requireService(key)[property]
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          const api = requireService(key)
          return api[property].apply(api, args)
        }
      },
      has(_target, property) { return typeof property === 'string' && property in (services.get(key) ?? {}) },
      ownKeys() { return Object.keys(services.get(key) ?? {}) },
      getOwnPropertyDescriptor(_target, property) {
        const api = services.get(key)
        if (typeof property === 'symbol' || !api || !Object.prototype.hasOwnProperty.call(api, property)) return undefined
        return { value: api[property], writable: false, enumerable: true, configurable: true }
      },
      set() { return false },
      deleteProperty() { return false },
      defineProperty() { return false },
      preventExtensions() { return false },
      setPrototypeOf() { return false },
    }) as T
  }

  // This plugin's one quiet hold, observable through `events.on('quiet:changed')` like the host.
  let quietHold: QuietHold | null = null
  let quietAllowsPermissions = true
  const quietState = (): QuietState => {
    const live = quietHold && (quietHold.until === undefined || quietHold.until > Date.now()) ? quietHold : null
    return live
      ? { active: true, allowPermissions: quietAllowsPermissions, holds: [{ ...live }] }
      : { active: false, allowPermissions: true, holds: [] }
  }
  const publishQuiet = () => {
    const event: PluginEvent = { name: 'quiet:changed', data: quietState(), timestamp: Date.now(), source: 'quiet' }
    for (const subscription of subscriptions) {
      if (subscription.names.some((prefix) => event.name.startsWith(prefix))) void subscription.handler(event)
    }
  }

  const events = {
    on(names: string | string[], handler: (event: PluginEvent) => void | Promise<void>) {
      const subscription = { names: Array.isArray(names) ? names : [names], handler }
      subscriptions.add(subscription)
      return disposable(() => subscriptions.delete(subscription))
    },
    emit(name: string, data: unknown) {
      const event: PluginEvent = { name, data, timestamp: Date.now(), source: `plugin/${options.pluginId ?? 'test-plugin'}` }
      emitted.push(event)
      for (const subscription of subscriptions) {
        if (subscription.names.some((prefix) => name.startsWith(prefix))) void subscription.handler(event)
      }
    },
  }

  const api: WalnutServerApi = {
    pluginId: options.pluginId ?? 'test-plugin',
    pluginName: options.pluginName ?? 'Test Plugin',
    walnutVersion: options.walnutVersion ?? '0.0.0-test',
    replica: false,
    signal: controller.signal,
    log: logger(),
    tasks: {
      async get(id) { return structuredClone(taskMap.get(id) ?? null) },
      async list() { return [...taskMap.values()].map(summary) },
      async query() { return [...taskMap.values()].map(summary) },
      async children(id) { return [...taskMap.values()].filter((task) => task.parentTaskId === id).map(summary) },
      async create(input) {
        const now = new Date().toISOString()
        const task: WalnutTask = {
          id: `task-${nextTask++}`,
          title: input.title,
          phase: input.phase ?? 'TODO',
          priority: input.priority ?? 'none',
          project: input.project,
          description: input.description ?? '',
          summary: '',
          parentTaskId: input.parentTaskId,
          dependsOn: input.dependsOn,
          tags: input.tags,
          source: 'local',
          dueDate: input.dueDate,
          startDate: input.startDate,
          endDate: input.endDate,
          createdAt: now,
          updatedAt: now,
        }
        taskMap.set(task.id, task)
        return structuredClone(task)
      },
      async update(id, patch) {
        const task = taskMap.get(id)
        if (!task) throw new Error(`Task "${id}" not found`)
        const { addTags, removeTags, ...rest } = patch
        const mapped = {
          ...rest,
          ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate ?? undefined } : {}),
          ...(patch.startDate !== undefined ? { startDate: patch.startDate ?? undefined } : {}),
          ...(patch.endDate !== undefined ? { endDate: patch.endDate ?? undefined } : {}),
        }
        // Same rule as the host: a folder never follows a task into another project.
        if (patch.project !== undefined && patch.project !== (task.project ?? '')) delete task.groupId
        Object.assign(task, mapped, { updatedAt: new Date().toISOString() })
        if (patch.tags === undefined && (addTags?.length || removeTags?.length)) {
          const drop = new Set(removeTags ?? [])
          const next = [...new Set([...(task.tags ?? []), ...(addTags ?? [])])].filter((tag) => !drop.has(tag))
          task.tags = next.length ? next : undefined
        }
        return structuredClone(task)
      },
      async appendNote(id, markdown) {
        const task = taskMap.get(id)
        if (!task) throw new Error(`Task "${id}" not found`)
        task.note = `${task.note ?? ''}${task.note ? '\n\n' : ''}${markdown}`
      },
      async appendLog() { return undefined },
      async complete(id) {
        const task = taskMap.get(id)
        if (!task) throw new Error(`Task "${id}" not found`)
        task.phase = 'COMPLETE'
        task.completedAt = new Date().toISOString()
        return structuredClone(task)
      },
      async delete(id) { taskMap.delete(id) },
      async folders() {
        return [...folderMap.values()].map((folder) => ({
          ...structuredClone(folder),
          memberCount: [...taskMap.values()].filter((task) => task.groupId === folder.id).length,
        }))
      },
      async createFolder(input) {
        const label = input.label.trim()
        if (!label) throw new Error('Folder name cannot be empty.')
        const project = input.project ?? ''
        if (input.parentId !== undefined) {
          const parent = folderMap.get(input.parentId)
          if (!parent) throw new Error(`Parent folder "${input.parentId}" not found.`)
          if (parent.project !== project) throw new Error('A folder can only nest inside a folder of the same project.')
        }
        const folder = { id: `folder-${nextFolder++}`, label, project, ...(input.parentId ? { parentId: input.parentId } : {}) }
        folderMap.set(folder.id, folder)
        return { ...structuredClone(folder), memberCount: 0 }
      },
      async fileIntoFolder(folderId, items) {
        const folder = folderMap.get(folderId)
        if (!folder) throw new Error(`Group "${folderId}" not found.`)
        return fileTasks(items, { project: folder.project, groupId: folderId })
      },
      async fileIntoProject(project, items) {
        if (!project?.trim()) throw new Error('Project name cannot be empty.')
        const known = [...taskMap.values()].find((task) => (task.project ?? '').toLowerCase() === project.trim().toLowerCase())
        return fileTasks(items, { project: known?.project ?? project.trim() })
      },
      async deleteFolder(folderId) {
        const folder = folderMap.get(folderId)
        if (!folder) throw new Error(`Folder "${folderId}" not found.`)
        const busy = [...taskMap.values()].some((task) => task.groupId === folderId)
          || [...folderMap.values()].some((one) => one.parentId === folderId)
        if (busy) throw new Error(`Folder "${folder.label}" is not empty; a plugin only deletes an empty folder.`)
        folderMap.delete(folderId)
      },
      async pinGroups() {
        return pinGroups.map((group) => ({ ...group }))
      },
      async ensurePinGroup(label) {
        const wanted = label.replace(/\s+/g, ' ').trim()
        if (!wanted) throw new Error('Pin group name cannot be empty.')
        if (['focus', 'satellite', 'backlog', 'wait', 'all', 'recent', 'tasks', 'pinned', 'notes'].includes(wanted.toLowerCase())) {
          throw new Error(`Tier label "${wanted}" conflicts with a built-in tier`)
        }
        const found = pinGroups.find((group) => group.label.trim().toLowerCase() === wanted.toLowerCase())
        if (found) return { ...found }
        const group = { id: `ct_test${String(nextGroup++).padStart(4, '0')}`, label: wanted }
        pinGroups.push(group)
        knownTiers.add(group.id)
        return { ...group }
      },
    },
    hosts: {
      async list() { return structuredClone(hostList) },
      async get(alias) { return structuredClone(hostList.find((host) => host.alias === alias) ?? null) },
      async run(alias, input) {
        hostRuns.push({ alias, input: structuredClone(input) })
        if (!hostList.some((host) => host.alias === alias)) throw new Error(`Walnut has no host named "${alias}" (Settings, Hosts).`)
        if (!options.runOnHost) throw new Error('hosts.run is not available in the fake plugin api without runOnHost')
        return await options.runOnHost(alias, input)
      },
    },
    sessionImports: {
      tag: FAKE_IMPORT_TAG,
      projectFor: fakeImportProject,
      onRun(handler) {
        importWatchers.add(handler)
        return disposable(() => importWatchers.delete(handler))
      },
      async autoCompleteAfterDays() { return options.importAutoCompleteAfterDays ?? 7 },
      extendTo(project) {
        if (!project?.trim()) throw new Error('Project name cannot be empty.')
        importLifecycleProjects.push(project)
        return disposable(() => {
          const at = importLifecycleProjects.indexOf(project)
          if (at >= 0) importLifecycleProjects.splice(at, 1)
        })
      },
    },
    tags: {
      setDefaultDisplay(pattern, display) {
        if (display !== 'shown' && display !== 'hidden') throw new Error('display must be "shown" or "hidden".')
        if (!pattern?.trim() || pattern.startsWith('walnut:')) throw new Error(`Not a tag rule: "${pattern}"`)
        tagDisplayDefaults.set(pattern, display)
        return disposable(() => { if (tagDisplayDefaults.get(pattern) === display) tagDisplayDefaults.delete(pattern) })
      },
      async displayRules() {
        return [
          { pattern: 'walnut:*', display: 'hidden' as const, source: 'builtin' as const },
          ...[...tagDisplayDefaults].map(([pattern, display]) => ({ pattern, display, source: 'plugin' as const, pluginId: options.pluginId ?? 'test-plugin' })),
        ]
      },
    },
    config: {
      async get() { return structuredClone(config) as any },
      async patch(partial) { config = { ...config, ...structuredClone(partial) } },
      onChange: () => disposable(),
    },
    notifications: {
      async notify(notice) {
        // Same replace rule as the host: a reminder re-fire takes the old one's place.
        if (notice.kind === 'reminder') {
          const at = notices.findIndex((one) => one.dedupKey === notice.dedupKey)
          if (at >= 0) notices.splice(at, 1)
        }
        notices.push(structuredClone(notice))
      },
      async error(notice) { errors.push(structuredClone(notice)) },
      async recover() { errors.length = 0 },
      async dismiss(dedupKey) {
        const at = notices.findIndex((one) => one.dedupKey === dedupKey)
        if (at >= 0) notices.splice(at, 1)
      },
      quiet: {
        async get() { return quietState() },
        async set(input = {}) {
          const now = Date.now()
          if (input.until !== undefined && input.until <= now) { quietHold = null } else {
            quietHold = {
              source: `plugin:${options.pluginId ?? 'test-plugin'}`,
              since: quietHold?.since ?? now,
              ...(input.until !== undefined ? { until: input.until } : {}),
              ...(input.reason ? { reason: input.reason } : {}),
            }
            quietAllowsPermissions = input.allowPermissions !== false
          }
          publishQuiet()
        },
        async clear() { quietHold = null; publishQuiet() },
      },
    },
    // Same limits as the host (id shape, two per plugin, one registration per id), so a
    // plugin that passes here does not throw on its first real activation.
    ui: {
      statusItem({ id }) {
        if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) throw new Error('Status item id must be 1-40 characters of a-z, 0-9, - and _')
        if (registeredItems.has(id)) throw new Error(`Status item "${id}" is already registered`)
        if (registeredItems.size >= 2) throw new Error('A plugin shows at most 2 status items')
        registeredItems.add(id)
        let live = true
        const handle = disposable(() => { live = false; registeredItems.delete(id); statusItems.delete(id) })
        return {
          set(state) {
            if (!live) throw new Error(`Status item "${id}" was disposed`)
            if ((state.actions ?? []).length > 3) throw new Error('A status item carries at most 3 actions')
            statusItems.set(id, structuredClone(state))
          },
          clear() { if (live) statusItems.delete(id) },
          dispose: handle.dispose,
        }
      },
    },
    ops: {
      async call(name) { return { ok: false, message: `No fake op registered: ${name}` } },
      unwrap(result) { if (!result.ok) throw new Error(result.message); return result.result },
      async list() { return [] },
    },
    // Backed by the in-memory map above: a plugin test stands in for a dependency by
    // putting an api in it. The rules that make a real service safe are enforced here too
    // (method bag, replace-then-stale-dispose, lazy `get` vs eager `require`), so a test
    // that passes against the fake is not passing against a laxer contract.
    services: {
      publish(name, api) {
        const key = `${options.pluginId ?? 'test-plugin'}:${name}`
        assertMethodBag(key, api as ServiceApi)
        const action = services.has(key) ? 'replaced' : 'published'
        services.set(key, api as ServiceApi)
        notifyServices({ key, pluginId: options.pluginId ?? 'test-plugin', action })
        return disposable(() => {
          if (services.get(key) !== api) return
          services.delete(key)
          notifyServices({ key, pluginId: options.pluginId ?? 'test-plugin', action: 'removed' })
        })
      },
      get(key) { return serviceHandle(key) },
      require(key) { requireService(key); return serviceHandle(key) },
      onChange(handler) {
        serviceWatchers.add(handler)
        return disposable(() => serviceWatchers.delete(handler))
      },
      // The fake never runs a service method on another plugin's behalf, so there is no caller.
      caller() { return undefined },
    },
    // In-memory inbox: `send` records the letter, `answerLetter` on the result plays the human.
    letters: {
      async send(input: LetterSendInput) {
        const letterId = `letter-${letters.length + 1}`
        letters.push({ letterId, subject: input.subject, actions: structuredClone(input.actions ?? []) })
        return { letterId }
      },
      async reply() { return undefined },
      async withdraw(letterId, input) {
        const letter = letters.find((one) => one.letterId === letterId)
        if (!letter || letter.answered) return
        await answerLetter(letterId, 'withdrawn', input.note, 'plugin')
      },
      async get(letterId) {
        const letter = letters.find((one) => one.letterId === letterId)
        return letter ? structuredClone(letter) : null
      },
      onAnswered(handler) {
        letterWatchers.add(handler)
        return disposable(() => letterWatchers.delete(handler))
      },
    },
    events,
    http: {
      route: () => disposable(),
      async fetch() { throw new Error('No fake HTTP handler registered') },
    },
    storage: {
      dataDir: '/tmp/fake-walnut-plugin',
      async readJson(name, fallback) { return structuredClone((files.get(name) as typeof fallback | undefined) ?? fallback) },
      async writeJson(name, value) { files.set(name, structuredClone(value)) },
      async updateJson(name, fallback, update) {
        const run = (updateChains.get(name) ?? Promise.resolve()).then(async () => {
          const next = await update(structuredClone((files.get(name) as typeof fallback | undefined) ?? fallback))
          files.set(name, structuredClone(next))
          return next
        })
        // The chain link is settled either way: one caller's failed mutation must not
        // reject the next caller's update, which is what a bare `run` here would do.
        updateChains.set(name, run.then(() => undefined, () => undefined))
        return run
      },
      async readText(name) { return (files.get(name) as string | undefined) ?? null },
      async writeText(name, value) { files.set(name, value) },
      async delete(name) { files.delete(name) },
      async list(prefix = '') { return [...files.keys()].filter((name) => name.startsWith(prefix)) },
      get database() {
        return {
          async exec() { return undefined },
          async run() { return { changes: 0, lastInsertRowid: 0 } },
          async get() { return undefined },
          async all() { return [] },
          async migrate(migrations: Array<{ version: number }>) {
            return migrations.reduce((latest, migration) => Math.max(latest, migration.version), 0)
          },
        }
      },
    },
    secrets: {
      async get(name) { return secrets.get(name) },
      async set(name, value) { secrets.set(name, value) },
      async delete(name) { secrets.delete(name) },
      async keys() { return [...secrets.keys()] },
    },
    timers: {
      timeout: () => disposable(),
      interval: () => disposable(),
    },
    registry: {
      sync: () => disposable(),
      sourceClaim: () => disposable(),
      display: () => disposable(),
      connection: () => disposable(),
      migration: () => disposable(),
      extIndex: () => disposable(),
      tool: () => disposable(),
      // Recorded, not just accepted: a plugin test's whole question is usually
      // "which ops did activate() declare, with which schema".
      op: (definition) => {
        registeredOps.push(definition)
        return disposable(() => {
          const index = registeredOps.indexOf(definition)
          if (index >= 0) registeredOps.splice(index, 1)
        })
      },
      wsMethod: () => disposable(),
      agent: () => disposable(),
      provider: () => disposable(),
      cronAction: () => disposable(),
      hook: () => disposable(),
      agentContext: () => disposable(),
      command: () => disposable(),
      skill: () => disposable(),
    },
    // Throws by default: a plugin test must never reach a real model, so one that needs an
    // answer passes `overrides.model` with its own canned `fastText`.
    model: {
      fastText: async () => { throw new Error('model.fastText is not available in the fake plugin api') },
    },
    unsafe: { database: undefined, bus: undefined, walnutHome: '/tmp/fake-walnut', host: undefined },
    ...options.overrides,
  }

  return { api, notices, errors, emitted, registeredOps, services, letters, answerLetter, statusItems, hostRuns, importRun, importLifecycleProjects, tagDisplayDefaults, pinGroups }
}
