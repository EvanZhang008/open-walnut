import type { Disposable, PluginLogger, WalnutTask, WalnutTaskSummary } from './shared.js'
import type { PluginEvent, PluginNotice, WalnutServerApi } from './server.js'

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
}

export function createFakeWalnut(options: FakeWalnutOptions = {}): FakeWalnutResult {
  const taskMap = new Map((options.tasks ?? []).map((task) => [task.id, structuredClone(task)]))
  const notices: PluginNotice[] = []
  const errors: PluginNotice[] = []
  const emitted: PluginEvent[] = []
  const subscriptions = new Set<{ names: string[]; handler: (event: PluginEvent) => void | Promise<void> }>()
  const files = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  let config = structuredClone(options.config ?? {})
  const controller = new AbortController()
  let nextTask = 1

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
        const next = await update(structuredClone((files.get(name) as typeof fallback | undefined) ?? fallback))
        files.set(name, structuredClone(next))
        return next
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
      migration: () => disposable(),
      extIndex: () => disposable(),
      tool: () => disposable(),
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

  return { api, notices, errors, emitted }
}
