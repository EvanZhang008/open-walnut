import type { Disposable, PluginLogger, WalnutTask, WalnutTaskSummary } from './shared.js'
import type {
  LetterAnsweredEvent,
  LetterSendInput,
  LetterState,
  PluginEvent,
  PluginNotice,
  PluginOpDefinition,
  ServiceApi,
  ServiceChange,
  WalnutServerApi,
} from './server.js'

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
  config?: Record<string, unknown>
  overrides?: Partial<WalnutServerApi>
}

export interface FakeWalnutResult {
  api: WalnutServerApi
  notices: PluginNotice[]
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
}

export function createFakeWalnut(options: FakeWalnutOptions = {}): FakeWalnutResult {
  const taskMap = new Map((options.tasks ?? []).map((task) => [task.id, structuredClone(task)]))
  const notices: PluginNotice[] = []
  const errors: PluginNotice[] = []
  const emitted: PluginEvent[] = []
  const registeredOps: PluginOpDefinition[] = []
  const services = new Map<string, ServiceApi>()
  const letters: LetterState[] = []
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
        const mapped = {
          ...patch,
          ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate ?? undefined } : {}),
          ...(patch.startDate !== undefined ? { startDate: patch.startDate ?? undefined } : {}),
          ...(patch.endDate !== undefined ? { endDate: patch.endDate ?? undefined } : {}),
        }
        Object.assign(task, mapped, { updatedAt: new Date().toISOString() })
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
    },
    config: {
      async get() { return structuredClone(config) as any },
      async patch(partial) { config = { ...config, ...structuredClone(partial) } },
      onChange: () => disposable(),
    },
    notifications: {
      async notify(notice) { notices.push(structuredClone(notice)) },
      async error(notice) { errors.push(structuredClone(notice)) },
      async recover() { errors.length = 0 },
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
    unsafe: { database: undefined, bus: undefined, walnutHome: '/tmp/fake-walnut', host: undefined },
    ...options.overrides,
  }

  return { api, notices, errors, emitted, registeredOps, services, letters, answerLetter }
}
