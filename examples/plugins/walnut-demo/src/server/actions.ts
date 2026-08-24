import type { Disposable, WalnutServerApi } from '@open-walnut/plugin-api/server'
import {
  DELETE_SAMPLE_FILE,
  DEMO_PROJECT,
  DEMO_SECRET_KEY,
  DEMO_SECRET_VALUE,
  NOTES_FILE,
  TEXT_FILE,
} from './constants'
import type { RegistrationProbes } from './registrations'
import { describe, type DemoServerState } from './state'
import type { DemoActionHandler, DemoReceipt } from './types'

export interface ActionDeps {
  walnut: WalnutServerApi
  state: DemoServerState
  probes: RegistrationProbes
}

export interface DemoActionRunner {
  names(): string[]
  run(rawAction: unknown, rawInput: unknown): Promise<DemoReceipt>
  stopTimers(): Promise<void>
}

class DemoInputError extends Error {}

export function safeActionError(action: string, error: unknown): string {
  return error instanceof DemoInputError
    ? error.message
    : `${action || 'Demo action'} failed. Check Walnut logs for details.`
}

export function createDemoActions(deps: ActionDeps): DemoActionRunner {
  const { walnut, state, probes } = deps
  let intervalHandle: Disposable | null = null

  const requireDemoTask = async () => {
    if (!state.demoTaskId) throw new DemoInputError('Run task-create first: the demo only ever touches its own task')
    const task = await walnut.tasks.get(state.demoTaskId)
    if (!task) throw new DemoInputError('The demo task no longer exists; run task-create again')
    if (task.project !== DEMO_PROJECT) {
      throw new DemoInputError(`The saved task left the ${DEMO_PROJECT} project, so the demo will not touch it`)
    }
    return task
  }

  const handlers = new Map<string, DemoActionHandler>([
    ['ping', async () => ({
      pong: true,
      pluginId: walnut.pluginId,
      walnutVersion: walnut.walnutVersion,
      activations: state.counters.activations,
      signalAborted: walnut.signal.aborted,
    })],

    ['task-list', async () => {
      const tasks = await walnut.tasks.list({ project: DEMO_PROJECT, limit: 5 })
      return {
        scope: DEMO_PROJECT,
        count: tasks.length,
        sample: tasks.map((task) => ({
          id: task.id,
          title: task.title.slice(0, 60),
          phase: task.phase,
        })),
      }
    }],
    ['task-query', async () => {
      const tasks = await walnut.tasks.query({ projects: [DEMO_PROJECT], limit: 3 })
      return { scope: DEMO_PROJECT, count: tasks.length, ids: tasks.map((task) => task.id) }
    }],
    ['task-create', async () => {
      const existing = state.demoTaskId ? await walnut.tasks.get(state.demoTaskId) : null
      if (existing?.project === DEMO_PROJECT) {
        return { reused: true, taskId: existing.id, phase: existing.phase, project: existing.project }
      }
      if (state.demoTaskId) {
        state.setDemoTaskId(null)
        await state.flush(true)
      }
      const task = await walnut.tasks.create({
        title: 'Plugin Demo sample task',
        description: 'Created by the Walnut Plugin Demo. Safe to delete, or press Clean up demo task.',
        project: DEMO_PROJECT,
        priority: 'backlog',
        tags: ['plugin-demo'],
      })
      state.setDemoTaskId(task.id)
      await state.flush(true)
      return {
        reused: false,
        taskId: task.id,
        project: task.project ?? '',
        source: task.source,
        phase: task.phase,
      }
    }],
    ['task-get', async () => {
      const task = await requireDemoTask()
      return { taskId: task.id, title: task.title, phase: task.phase, project: task.project }
    }],
    ['task-children', async () => {
      const task = await requireDemoTask()
      const children = await walnut.tasks.children(task.id)
      return { taskId: task.id, childCount: children.length }
    }],
    ['task-update', async () => {
      const owned = await requireDemoTask()
      const task = await walnut.tasks.update(owned.id, { priority: 'important' })
      return { taskId: task.id, priority: task.priority }
    }],
    ['task-note', async () => {
      const task = await requireDemoTask()
      await walnut.tasks.appendNote(task.id, `Demo note written at ${new Date().toISOString()}`)
      return { taskId: task.id, appended: 'note' }
    }],
    ['task-log', async () => {
      const task = await requireDemoTask()
      await walnut.tasks.appendLog(task.id, 'The Plugin Demo appended one log line')
      return { taskId: task.id, appended: 'conversation log' }
    }],
    ['task-complete', async () => {
      const owned = await requireDemoTask()
      const task = await walnut.tasks.complete(owned.id)
      return { taskId: task.id, phase: task.phase, completed: true }
    }],
    ['task-cleanup', async () => {
      const id = state.demoTaskId
      if (!id) return { deleted: false, reason: 'the demo has no task of its own right now' }
      const existing = await walnut.tasks.get(id)
      if (!existing || existing.project !== DEMO_PROJECT) {
        state.setDemoTaskId(null)
        await state.flush(true)
        return {
          deleted: false,
          reason: existing ? `the task left the ${DEMO_PROJECT} project; the demo forgot the id` : 'the task was already gone; the demo forgot the id',
          taskId: id,
        }
      }
      await walnut.tasks.delete(id)
      state.setDemoTaskId(null)
      await state.flush(true)
      return { deleted: true, taskId: id }
    }],

    ['config-read', async () => {
      const config = await walnut.config.get()
      return { scope: 'config.plugins["walnut-demo"]', keys: Object.keys(config).sort() }
    }],
    ['config-patch', async () => {
      const config = await walnut.config.get<{ demoFlag?: boolean }>()
      const demoFlag = !config.demoFlag
      await walnut.config.patch({ demoFlag, updatedAt: new Date().toISOString() })
      return { scope: 'config.plugins["walnut-demo"]', demoFlag }
    }],

    ['storage-roundtrip', async () => {
      const notes = await walnut.storage.updateJson<{ writes: number; last: string | null }>(
        NOTES_FILE,
        { writes: 0, last: null },
        (current) => ({ writes: (current.writes ?? 0) + 1, last: new Date().toISOString() }),
      )
      const savedNotes = await walnut.storage.readJson(NOTES_FILE, { writes: 0, last: null })
      await walnut.storage.writeText(TEXT_FILE, `Plugin Demo wrote this at ${notes.last}\n`)
      const text = await walnut.storage.readText(TEXT_FILE)
      return {
        json: { file: NOTES_FILE, writes: savedNotes.writes },
        text: { file: TEXT_FILE, bytes: text?.length ?? 0, firstLine: (text ?? '').split('\n')[0] ?? '' },
      }
    }],
    ['sqlite-roundtrip', async () => {
      const database = walnut.storage.database
      await database.exec('DELETE FROM demo_storage_probe')
      const inserted = await database.run(
        'INSERT INTO demo_storage_probe(value) VALUES (?)',
        ['Plugin Demo SQLite round trip'],
      )
      const first = await database.get<{ id: number; value: string }>(
        'SELECT id, value FROM demo_storage_probe ORDER BY id LIMIT 1',
      )
      const all = await database.all<{ id: number; value: string }>(
        'SELECT id, value FROM demo_storage_probe ORDER BY id',
      )
      return {
        table: 'demo_storage_probe',
        exec: true,
        runChanges: inserted.changes,
        getFound: !!first,
        allRows: all.length,
        value: first?.value ?? null,
        migrationsApplied: true,
      }
    }],
    ['storage-list', async () => {
      const files = await walnut.storage.list()
      // Safe to show: every name is relative to the plugin's private data directory, never an absolute path.
      return { count: files.length, relativeNames: files.slice(0, 10) }
    }],
    ['storage-delete', async () => {
      await walnut.storage.writeText(DELETE_SAMPLE_FILE, 'delete me')
      await walnut.storage.delete(DELETE_SAMPLE_FILE)
      return {
        file: DELETE_SAMPLE_FILE,
        deleted: (await walnut.storage.readText(DELETE_SAMPLE_FILE)) === null,
      }
    }],

    ['secret-roundtrip', async () => {
      await walnut.secrets.set(DEMO_SECRET_KEY, DEMO_SECRET_VALUE)
      const stored = await walnut.secrets.get(DEMO_SECRET_KEY)
      return {
        key: DEMO_SECRET_KEY,
        exists: typeof stored === 'string',
        keys: await walnut.secrets.keys(),
        valueReturned: false,
        note: 'The stored value is a fixed dummy and never crosses this boundary.',
      }
    }],
    ['secret-delete', async () => {
      await walnut.secrets.delete(DEMO_SECRET_KEY)
      return { deleted: DEMO_SECRET_KEY, keys: await walnut.secrets.keys() }
    }],

    ['timer-timeout', async () => {
      state.timers.timeoutScheduled = true
      walnut.timers.timeout(() => {
        state.timers.timeoutScheduled = false
        state.timers.timeoutFires += 1
        walnut.events.emit('timer-fired', { kind: 'timeout', at: new Date().toISOString() })
      }, 1_500)
      return { scheduled: true, delayMs: 1_500, note: 'It emits an event when it fires; watch the event echo.' }
    }],
    ['timer-interval-start', async () => {
      if (intervalHandle) return { running: true, reused: true, intervalMs: 5_000 }
      intervalHandle = walnut.timers.interval(() => {
        state.timers.intervalTicks += 1
        state.timers.lastTickAt = new Date().toISOString()
      }, 5_000)
      state.timers.intervalRunning = true
      return { running: true, reused: false, intervalMs: 5_000 }
    }],
    ['timer-interval-stop', async () => {
      await intervalHandle?.dispose()
      intervalHandle = null
      state.timers.intervalRunning = false
      return { running: false, ticks: state.timers.intervalTicks }
    }],

    ['notify', async () => {
      await walnut.notifications.notify({
        title: 'Walnut Plugin Demo',
        body: 'An informational notification from the demo plugin.',
        severity: 'info',
        dedupKey: 'demo-notify',
      })
      state.bump('notifications')
      return { severity: 'info', dedupKey: 'demo-notify', hostNamespaced: true }
    }],
    ['notify-error', async () => {
      await walnut.notifications.error({
        title: 'Walnut Plugin Demo',
        body: 'A recoverable error notification, raised on purpose.',
        severity: 'warning',
        dedupKey: 'demo-error',
      })
      state.bump('notifications')
      return { severity: 'warning', dedupKey: 'demo-error', recoverable: true }
    }],
    ['notify-recover', async () => {
      await walnut.notifications.recover()
      return { recovered: true, note: 'Clears the demo error notification the host is holding.' }
    }],

    ['event-echo', async () => {
      const nonce = `demo-${Date.now().toString(36)}`
      walnut.events.emit('echo', { nonce, at: new Date().toISOString() })
      return { emitted: `plugin:${walnut.pluginId}:echo`, nonce }
    }],

    ['http-probe', async (input) => {
      const rawUrl = typeof input.url === 'string' ? input.url.trim() : ''
      if (!rawUrl) {
        return { skipped: true, reason: 'Enter https://example.com/ to run the allowlisted probe.' }
      }
      let target: URL
      try {
        target = new URL(rawUrl)
      } catch {
        throw new DemoInputError('Enter a valid absolute URL')
      }
      if (target.username || target.password) throw new DemoInputError('Credentials are not allowed in the probe URL')
      if (target.href !== 'https://example.com/') {
        throw new DemoInputError('The public demo only fetches the fixed URL https://example.com/')
      }
      const response = await walnut.http.fetch(target.href, { method: 'GET', timeoutMs: 5_000 })
      const body = await response.text()
      return {
        url: target.href,
        status: response.status,
        ok: response.ok,
        bytes: body.length,
        contentType: response.headers['content-type'] ?? null,
      }
    }],

    ['ops-catalogue', async () => {
      const ops = await walnut.ops.list()
      return {
        count: ops.length,
        readonly: ops.filter((op) => op.readonly).length,
        sample: ops.slice(0, 5).map((op) => op.name),
      }
    }],
    ['ops-selftest', async () => {
      const result = await walnut.ops.call('walnut_status')
      const value = walnut.ops.unwrap(result)
      return {
        op: 'walnut_status',
        called: true,
        unwrapped: true,
        resultType: Array.isArray(value) ? 'array' : typeof value,
        resultKeys: value && typeof value === 'object' ? Object.keys(value).sort() : [],
        valuesReported: false,
      }
    }],

    ['unsafe-inspect', async () => {
      const handle = walnut.unsafe
      return {
        keys: ['database', 'bus', 'walnutHome', 'host'],
        types: {
          database: typeof handle.database,
          bus: typeof handle.bus,
          walnutHome: typeof handle.walnutHome,
          host: typeof handle.host,
        },
        valuesReported: false,
        note: 'Reading walnut.unsafe makes the host log a warning. Nothing inside it is reported.',
      }
    }],

    ['tool-handler-probe', async () => probes.snapshot(3)],
    ['cron-handler-probe', async () => ({ status: 'ok', data: await probes.cronReport() })],
    ['provider-adapter-probe', async () => probes.providerEcho('Plugin Demo provider check')],
    ['sync-adapter-probe', async () => probes.syncSelfTest()],
    ['registry-list', async () => ({
      count: state.registrations.length,
      registrations: state.registrations,
    })],
  ])

  return {
    names: () => [...handlers.keys()].sort(),

    async run(rawAction: unknown, rawInput: unknown): Promise<DemoReceipt> {
      const action = typeof rawAction === 'string' ? rawAction : ''
      const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? rawInput as Record<string, unknown>
        : {}
      const at = new Date().toISOString()
      const started = Date.now()
      // A Map lookup, not property access: a plain object would resolve `constructor` as an action.
      const handler = handlers.get(action)
      if (!handler) {
        return state.record({
          action: action || '(missing)',
          ok: false,
          at,
          ms: 0,
          error: `Unknown demo action. Known actions: ${[...handlers.keys()].sort().join(', ')}`,
        })
      }
      try {
        const detail = await handler(input)
        return state.record({ action, ok: true, at, ms: Date.now() - started, detail })
      } catch (error) {
        walnut.log.warn('demo action failed', { action, error: describe(error) })
        return state.record({ action, ok: false, at, ms: Date.now() - started, error: safeActionError(action, error) })
      }
    },

    async stopTimers() {
      await intervalHandle?.dispose()
      intervalHandle = null
      state.timers.intervalRunning = false
    },
  }
}
