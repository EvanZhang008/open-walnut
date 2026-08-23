import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

interface Counters {
  activations: number
  taskEvents: number
  hookCalls: number
  toolCalls: number
  idleWarnings: number
}

export async function activate(walnut: WalnutServerApi) {
  const counters = await walnut.storage.updateJson<Counters>(
    'counters.json',
    { activations: 0, taskEvents: 0, hookCalls: 0, toolCalls: 0, idleWarnings: 0 },
    (current) => ({
      activations: (current.activations ?? 0) + 1,
      taskEvents: current.taskEvents ?? 0,
      hookCalls: current.hookCalls ?? 0,
      toolCalls: current.toolCalls ?? 0,
      idleWarnings: current.idleWarnings ?? 0,
    }),
  )

  await walnut.storage.database.migrate([
    {
      version: 1,
      sql: 'CREATE TABLE observations (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL)',
    },
  ])
  await walnut.storage.database.run(
    'INSERT INTO observations(kind, created_at) VALUES (?, ?)',
    ['activation', new Date().toISOString()],
  )

  walnut.registry.tool({
    name: 'snapshot',
    description: 'Show the reference Plugin state and a small sample of Walnut tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 10 },
      },
      additionalProperties: false,
    },
    async execute(input) {
      counters.toolCalls++
      await walnut.storage.writeJson('counters.json', counters)
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(10, input.limit)) : 3
      const tasks = await walnut.tasks.list({ limit })
      const observations = await walnut.storage.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM observations')
      return { pluginId: walnut.pluginId, counters, observations: observations?.count ?? 0, tasks }
    },
  })

  walnut.registry.cronAction('snapshot', 'Read the reference Plugin state', async () => ({
    status: 'ok',
    summary: `Reference Plugin has observed ${counters.taskEvents} task events.`,
    data: counters,
  }))

  walnut.registry.wsMethod('status', async () => ({
    pluginId: walnut.pluginId,
    counters,
  }))

  walnut.registry.agent({
    id: 'observer',
    name: 'Reference Observer',
    description: 'Demonstrates an owner-scoped Plugin agent.',
    runner: 'embedded',
    allowed_tools: ['reference_walnut_snapshot'],
  })

  walnut.registry.provider('echo', {
    async sendMessage() {
      return { content: [{ type: 'text', text: 'Reference provider response' }], stopReason: 'end_turn' }
    },
    async sendMessageStream(options) {
      options.onTextDelta?.('Reference provider response')
      return { content: [{ type: 'text', text: 'Reference provider response' }], stopReason: 'end_turn' }
    },
  })

  walnut.registry.hook({
    id: 'task-created',
    point: 'onTaskCreated',
    async handler() {
      counters.hookCalls++
      await walnut.storage.writeJson('counters.json', counters)
    },
  })

  walnut.registry.hook({
    id: 'session-will-reap',
    point: 'onSessionWillReap',
    async handler() {
      counters.idleWarnings++
      await walnut.storage.writeJson('counters.json', counters)
    },
  })

  walnut.events.on('task:', async () => {
    counters.taskEvents++
    await walnut.storage.writeJson('counters.json', counters)
  })

  walnut.http.route('GET', '/stats', async () => {
    const config = await walnut.config.get()
    return {
      json: {
        pluginId: walnut.pluginId,
        walnutVersion: walnut.walnutVersion,
        configured: Object.keys(config).length > 0,
        counters,
      },
    }
  })

  // Host-named `/reference-walnut:snapshot` in the palette — read-only, and it
  // disappears with the Plugin.
  walnut.registry.command({
    id: 'snapshot',
    description: 'Report the reference Plugin state and a few Walnut tasks.',
    content: 'Call reference_walnut_snapshot and summarise what the reference Plugin has observed so far.',
  })

  walnut.registry.agentContext(
    'Reference Walnut Plugin is installed. Use reference_walnut_snapshot to inspect its state.',
  )

  await walnut.notifications.notify({
    title: 'Reference Plugin active',
    body: `Activation ${counters.activations} completed.`,
    severity: 'success',
    dedupKey: 'activated',
  })
}
