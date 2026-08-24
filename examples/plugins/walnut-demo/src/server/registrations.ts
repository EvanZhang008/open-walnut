import type {
  PluginProviderAdapter,
  PluginSyncTask,
  WalnutServerApi,
} from '@open-walnut/plugin-api/server'
import { DEMO_PROJECT } from './constants'
import { describe, type DemoServerState } from './state'
import {
  createDemoSyncAdapter,
  createSyncCallLog,
  exerciseDemoSyncAdapter,
  inertPollContext,
} from './sync'

export interface RegistrationProbes {
  snapshot(limit: number): Promise<Record<string, unknown>>
  cronReport(): Promise<Record<string, unknown>>
  providerEcho(text: string): Promise<Record<string, unknown>>
  syncSelfTest(): Promise<Record<string, unknown>>
}

export interface RegisterOptions {
  walnut: WalnutServerApi
  state: DemoServerState
  skillsDirectory: string
}

const AGENT_CONTEXT = [
  'The Walnut Plugin Demo is installed.',
  'Call walnut_demo_snapshot to read what it has observed.',
  `It owns exactly one project ("${DEMO_PROJECT}") and one demo task; leave everything else alone.`,
].join(' ')

// Every registration below returns a host-owned Disposable, so a reload or disable drops all of them; keeping handles here would be wrong.
export function registerCapabilities(options: RegisterOptions): RegistrationProbes {
  const { walnut, state, skillsDirectory } = options

  const syncLog = createSyncCallLog()
  const syncAdapter = createDemoSyncAdapter(syncLog, () => state.bump('syncCalls'))
  walnut.registry.sync(syncAdapter)
  state.register('sync', 'walnut-demo', 'Every method implemented, every method a no-op, no network')

  walnut.registry.sourceClaim(
    async (project) => {
      if (project !== DEMO_PROJECT || !state.demoTaskId) return false
      try {
        const task = await walnut.tasks.get(state.demoTaskId)
        return task?.project === DEMO_PROJECT
      } catch (error) {
        walnut.log.warn('could not verify demo project ownership', { error: describe(error) })
        return false
      }
    },
    { priority: 0 },
  )
  state.register('sourceClaim', `owned task in "${DEMO_PROJECT}"`, 'Exact project plus persisted task ownership')

  walnut.registry.display({
    badge: 'DEMO',
    badgeColor: '#5856D6',
    externalLinkLabel: 'Open demo record',
    getExternalUrl: () => null,
    isSynced: (task: PluginSyncTask) => !!task.ext?.['walnut-demo'],
    syncTooltip: () => 'Demo source: nothing is pushed anywhere',
    languageHint: 'en',
  })
  state.register('display', 'DEMO badge', 'External URL is always null')

  walnut.registry.migration((tasks) => tasks)
  state.register('migration', 'identity', 'Returns the tasks unchanged')

  walnut.registry.extIndex({
    source: 'walnut-demo',
    paths: [{ key: 'id', json: '$."walnut-demo".id' }],
  })
  state.register('extIndex', 'walnut-demo.id', 'One json_extract path inside ext')

  const snapshot = async (limit: number): Promise<Record<string, unknown>> => {
    state.bump('toolCalls')
    const bounded = Math.max(1, Math.min(10, Math.trunc(limit) || 3))
    const tasks = await walnut.tasks.list({ project: DEMO_PROJECT, limit: bounded })
    return {
      pluginId: walnut.pluginId,
      counters: state.counters,
      demoProject: DEMO_PROJECT,
      demoTaskId: state.demoTaskId,
      demoProjectTasks: tasks.map((task) => ({ id: task.id, title: task.title, phase: task.phase })),
    }
  }

  walnut.registry.tool({
    name: 'snapshot',
    description: 'Report what the Walnut Plugin Demo has observed, plus the tasks in its own project.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', minimum: 1, maximum: 10 } },
      additionalProperties: false,
    },
    execute: (input) => snapshot(typeof input.limit === 'number' ? input.limit : 3),
  })
  state.register('tool', 'walnut_demo_snapshot', 'Read-only; the host namespaces the name')

  walnut.registry.agent({
    id: 'observer',
    name: 'Plugin Demo Observer',
    description: 'Answers questions about the Plugin Demo using its own snapshot tool.',
    runner: 'embedded',
    allowed_tools: ['walnut_demo_snapshot'],
    system_prompt: 'You describe the Walnut Plugin Demo. Use walnut_demo_snapshot for facts and keep answers short.',
  })
  state.register('agent', 'walnut-demo:observer', 'Embedded runner, one allowed tool')

  const providerAdapter: PluginProviderAdapter = {
    async sendMessage(callOptions) {
      state.bump('providerCalls')
      return {
        content: [{ type: 'text', text: echoText(callOptions.messages) }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0, model: callOptions.model },
      }
    },
    async sendMessageStream(callOptions) {
      state.bump('providerCalls')
      const text = echoText(callOptions.messages)
      callOptions.onTextDelta?.(text)
      return {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0, model: callOptions.model },
      }
    },
    resetClient() {
      state.bump('providerCalls')
    },
  }
  walnut.registry.provider('echo', providerAdapter)
  state.register('provider', 'walnut-demo:echo', 'Local echo, no credentials, no network')

  const cronReport = async (): Promise<Record<string, unknown>> => {
    state.bump('cronRuns')
    return {
      runs: state.counters.runs,
      events: state.counters.events,
      hookCalls: state.counters.hookCalls,
      syncCalls: state.counters.syncCalls,
    }
  }
  walnut.registry.cronAction('report', 'Report the Plugin Demo counters', async () => {
    const data = await cronReport()
    return { status: 'ok', summary: `Plugin Demo has handled ${data.runs} runs.`, data }
  })
  state.register('cronAction', 'walnut-demo:report', 'Read-only counter report')

  for (const [point, id] of [
    ['onSessionStart', 'count-session-start'],
    ['onTaskCreated', 'count-task-created'],
    ['onTurnComplete', 'count-turn-complete'],
  ] as const) {
    walnut.registry.hook({
      id,
      point,
      timeoutMs: 2_000,
      async handler() {
        state.bump('hookCalls')
      },
    })
    state.register('hook', `walnut-demo:${id}`, 'Counts the call and returns')
  }

  walnut.registry.agentContext(AGENT_CONTEXT)
  state.register('agentContext', `${AGENT_CONTEXT.length} chars`, 'Injected into the Personal AI prompt')

  walnut.registry.command({
    id: 'status',
    description: 'Report what the Walnut Plugin Demo has observed.',
    content: 'Call walnut_demo_snapshot and summarise the Plugin Demo state in three bullet points.',
  })
  state.register('command', '/walnut-demo:status', 'Read-only from the API and the UI')

  walnut.registry.skill({ id: 'demo', directory: skillsDirectory })
  state.register('skill', 'walnut-demo:demo', 'skills/walnut-demo, relative to the plugin root')

  walnut.config.onChange((config) => {
    state.bump('configChanges')
    walnut.events.emit('config-changed', { keys: Object.keys(config).sort() })
  })
  state.register('config.onChange', 'plugins.walnut-demo', 'Owner-scoped listener; reports key names only')

  walnut.events.on(['task:', `plugin:${walnut.pluginId}:`], () => {
    state.bump('events')
  })
  state.register('events.on', 'task: + plugin:walnut-demo:', 'Prefix subscription, owner-scoped')

  return {
    snapshot,
    cronReport,
    async providerEcho(text: string) {
      const call = {
        providerConfig: {},
        model: 'walnut-demo-echo',
        maxTokens: 64,
        system: 'Echo the user message back.',
        messages: [{ role: 'user', content: text }],
      }
      const result = await providerAdapter.sendMessage(call)
      let streamed = ''
      const streamResult = await providerAdapter.sendMessageStream({
        ...call,
        onTextDelta(delta) { streamed += delta },
      })
      providerAdapter.resetClient?.()
      return {
        protocol: 'walnut-demo:echo',
        messageStopReason: result.stopReason,
        streamStopReason: streamResult.stopReason,
        content: result.content,
        streamed,
        resetClient: true,
      }
    },
    async syncSelfTest() {
      try {
        const before = syncLog.total
        await exerciseDemoSyncAdapter(syncAdapter, inertPollContext())
        return {
          exercised: syncLog.total - before,
          calls: [...syncLog.calls],
          totalCalls: syncLog.total,
          hostMutations: 0,
          networkRequests: 0,
        }
      } catch (error) {
        walnut.log.warn('sync adapter probe failed', { error: describe(error) })
        return { exercised: 0, failed: true, error: 'Sync adapter probe failed; check Walnut logs for details.' }
      }
    },
  }
}

function echoText(messages: unknown[]): string {
  const last = messages.at(-1)
  if (last && typeof last === 'object' && 'content' in last) {
    const content = (last as { content: unknown }).content
    if (typeof content === 'string') return `echo: ${content}`
  }
  return 'echo: (no text content)'
}
