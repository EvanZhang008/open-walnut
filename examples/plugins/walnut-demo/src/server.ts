import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'
import { createDemoActions, type DemoActionRunner } from './server/actions'
import { DEMO_PROJECT } from './server/constants'
import { registerCapabilities } from './server/registrations'
import { DemoServerState, describe } from './server/state'

const CAPABILITIES = [
  'identity', 'signal', 'log',
  'tasks.get', 'tasks.list', 'tasks.query', 'tasks.children', 'tasks.create',
  'tasks.update', 'tasks.appendNote', 'tasks.appendLog', 'tasks.complete', 'tasks.delete',
  'config.get', 'config.patch', 'config.onChange',
  'notifications.notify', 'notifications.error', 'notifications.recover',
  'ops.list', 'ops.call', 'ops.unwrap',
  'events.on', 'events.emit', 'http.route', 'http.fetch',
  'storage.readJson', 'storage.writeJson', 'storage.updateJson',
  'storage.readText', 'storage.writeText', 'storage.delete', 'storage.list',
  'storage.database.exec', 'storage.database.run', 'storage.database.get',
  'storage.database.all', 'storage.database.migrate',
  'secrets.get', 'secrets.set', 'secrets.delete', 'secrets.keys',
  'timers.timeout', 'timers.interval',
  'registry.sync', 'registry.sourceClaim', 'registry.display', 'registry.migration',
  'registry.extIndex', 'registry.tool', 'registry.wsMethod', 'registry.agent',
  'registry.provider', 'registry.cronAction', 'registry.hook',
  'registry.agentContext', 'registry.command', 'registry.skill',
  'unsafe',
  'ui.app', 'ui.page', 'ui.settings', 'ui.injectCss', 'ui.views',
  'web.events', 'web.ops', 'web.ws', 'web.http', 'web.unsafe',
]

const FLUSH_INTERVAL_MS = 15_000

let active: { state: DemoServerState; actions: DemoActionRunner } | null = null

export async function activate(walnut: WalnutServerApi): Promise<void> {
  const state = new DemoServerState(walnut)
  await state.load()
  await state.initDatabase()

  // The working directory is the server's, not the plugin's, so the absolute skills path comes from this module's URL.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const skillsDirectory = path.resolve(moduleDir, '..', 'skills')

  const probes = registerCapabilities({ walnut, state, skillsDirectory })
  const actions = createDemoActions({ walnut, state, probes })
  active = { state, actions }

  walnut.registry.wsMethod('run', async (payload) => {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as { action?: unknown; input?: unknown }
      : {}
    const receipt = await actions.run(body.action, body.input)
    return { ok: receipt.ok, receipt }
  })
  state.register('wsMethod', 'walnut-demo:run', `${actions.names().length} named actions`)

  walnut.http.route('GET', '/stats', async () => {
    state.bump('statsRequests')
    return { json: await buildStats(walnut, state, actions) }
  })
  state.register('http.route', 'GET /stats', 'Read-only; no paths, no secret values')

  walnut.timers.interval(() => { void state.flush() }, FLUSH_INTERVAL_MS)

  walnut.log.info('Plugin Demo activated', {
    activations: state.counters.activations,
    registrations: state.registrations.length,
    actions: actions.names().length,
  })
}

export async function deactivate(): Promise<void> {
  const current = active
  active = null
  if (!current) return
  try {
    await current.actions.stopTimers()
    await current.state.flush(true)
  } catch (error) {
    // Deactivation must never throw: the host is already tearing the plugin down.
    current.state.counters.failures += 1
    void describe(error)
  }
}

async function buildStats(
  walnut: WalnutServerApi,
  state: DemoServerState,
  actions: DemoActionRunner,
): Promise<Record<string, unknown>> {
  const [secretKeys, storageNames, receiptRows] = await Promise.all([
    walnut.secrets.keys().catch(() => [] as string[]),
    walnut.storage.list().catch(() => [] as string[]),
    state.receiptRowCount(),
  ])
  return {
    pluginId: walnut.pluginId,
    pluginName: walnut.pluginName,
    walnutVersion: walnut.walnutVersion,
    signalAborted: walnut.signal.aborted,
    capabilities: CAPABILITIES,
    actions: actions.names(),
    counters: state.counters,
    registrations: state.registrations,
    timers: state.timers,
    demoProject: DEMO_PROJECT,
    demoTaskId: state.demoTaskId,
    // Key names only. The demo has no code path that returns a secret value.
    secretKeys,
    storage: { relativeNames: storageNames.slice(0, 10), receiptRows },
    receipts: state.receipts.slice(0, 10),
  }
}
