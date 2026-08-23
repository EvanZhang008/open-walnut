import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('plugin-server-api-test'))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ plugins: { 'sample-plugin': { color: 'blue' } } })),
  updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { bus } from '../../src/core/event-bus.js'
import { getAgent } from '../../src/core/agent-registry.js'
import { resolveProvider } from '../../src/agent/providers/registry.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import { createPluginRouteDispatcher } from '../../src/web/plugin-route-dispatcher.js'
import { _getRpcMethodForTesting, removeOwnedMethods } from '../../src/web/ws/handler.js'
import { getAction, _resetActionsForTesting, runAction } from '../../src/core/cron/actions.js'
import { HookDispatcher, setSessionHookDispatcher } from '../../src/core/session-hooks/index.js'
import { activate as activateCalendar } from '../../src/integrations/calendar/index.js'
import { activate as activateMsTodo } from '../../src/integrations/ms-todo/index.js'
import { activate as activateJira } from '../../src/integrations/jira/index.js'
import { createMockPlugin, createTestPluginApi } from './plugin-test-utils.js'

const logger: PluginLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
}

const contexts: PluginContext[] = []
const dispatchers: HookDispatcher[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  for (const dispatcher of dispatchers.splice(0)) dispatcher.destroy()
  _resetActionsForTesting()
  removeOwnedMethods('sample-plugin')
  setSessionHookDispatcher(null)
  bus.unsubscribe('test-observer')
})

function setup(pluginId = 'sample-plugin', pluginName = 'Sample Plugin') {
  const context = new PluginContext({
    id: pluginId,
    dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId),
    logger,
  })
  contexts.push(context)
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginName })
  const registry = new IntegrationRegistry()
  const api = createServerPluginApi({
    context,
    pluginName,
    legacyApi,
    contributions: collected,
    integrationRegistry: registry,
  })
  return { api, context, collected, registry }
}

describe('createServerPluginApi', () => {
  it('adapts first-party integrations into owner-scoped registrations', async () => {
    const msTodo = setup('ms-todo', 'Microsoft To-Do')
    await activateMsTodo(msTodo.api)

    expect(msTodo.collected.sync).not.toBeNull()
    expect(msTodo.collected.claim?.priority).toBe(0)
    expect(msTodo.collected.display?.badge).toBe('M')
    expect(msTodo.collected.extIndex?.source).toBe('ms-todo')
    expect(msTodo.collected.migrations).toHaveLength(1)

    const jira = setup('jira', 'Jira')
    await activateJira(jira.api)

    expect(jira.collected.sync).not.toBeNull()
    expect(jira.collected.claim?.priority).toBe(0)
    expect(jira.collected.display?.badge).toBe('J')
    expect(jira.collected.extIndex?.source).toBe('jira')
    expect(jira.collected.migrations).toHaveLength(1)

    const calendar = setup('calendar', 'Calendar')
    await activateCalendar(calendar.api)
    expect(calendar.collected.tools.map((tool) => tool.name)).toEqual([
      'calendar_query',
      'calendar_event_create',
      'calendar_event_update',
      'calendar_event_delete',
    ])
    expect(new Set(calendar.collected.tools.map((tool) => tool.name)).size).toBe(4)

    await msTodo.context.dispose()
    await jira.context.dispose()
    await calendar.context.dispose()
    expect(msTodo.collected).toMatchObject({
      sync: null,
      claim: null,
      display: null,
      migrations: [],
      extIndex: null,
    })
    expect(jira.collected).toMatchObject({
      sync: null,
      claim: null,
      display: null,
      migrations: [],
      extIndex: null,
    })
    expect(calendar.collected.tools).toEqual([])
  })

  it('registers tool, route, cron, and context contributions', async () => {
    const { api, collected, registry } = setup()
    api.registry.tool({
      name: 'inspect',
      description: 'Inspect state',
      execute: async () => ({ ok: true }),
    })
    api.registry.cronAction('collect', 'Collect data', async () => ({ status: 'ok', summary: 'done' }))
    api.registry.agentContext('Sample Plugin is available.')
    api.http.route('GET', '/status', async () => ({ json: { active: true } }))

    registry.register('sample-plugin', createMockPlugin({
      id: 'sample-plugin',
      tools: collected.tools,
      httpRoutes: collected.httpRoutes,
      agentContext: collected.agentContext ?? undefined,
    }))
    const app = express()
    app.use('/api/plugins', createPluginRouteDispatcher(registry))

    expect(collected.tools.map((tool) => tool.name)).toEqual(['sample_plugin_inspect'])
    expect(await collected.tools[0].execute({})).toBe(JSON.stringify({ ok: true }, null, 2))
    expect(getAction('sample-plugin:collect')).toBeDefined()
    expect((await runAction('sample-plugin:collect', {})).summary).toBe('done')
    await request(app).get('/api/plugins/sample-plugin/status').expect(200, { active: true })
    expect(collected.agentContext).toBe('Sample Plugin is available.')
  })

  it('disposes every owner-scoped contribution and event subscriber', async () => {
    const { api, context, collected } = setup()
    const received = vi.fn()
    api.registry.tool({ name: 'inspect', description: 'Inspect', execute: async () => 'ok' })
    api.registry.cronAction('collect', 'Collect', async () => ({ status: 'ok' }))
    api.registry.wsMethod('ping', async (payload) => ({ payload }))
    api.registry.agent({ id: 'helper', name: 'Helper', runner: 'embedded' })
    api.registry.provider('custom', {
      sendMessage: async () => ({ content: [], stopReason: 'end_turn' }),
      sendMessageStream: async () => ({ content: [], stopReason: 'end_turn' }),
    })
    api.http.route('GET', '/status', async () => ({ json: {} }))
    api.events.on('task:', received)

    bus.emit('task:created', { task: { id: 'one' } }, ['web-ui'], { source: 'test' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(received).toHaveBeenCalledOnce()
    expect(await _getRpcMethodForTesting('sample-plugin:ping')?.({ ready: true }, {} as never)).toEqual({
      payload: { ready: true },
    })
    await expect(getAgent('sample-plugin:helper')).resolves.toMatchObject({ source: 'plugin' })
    expect(resolveProvider('custom', {
      custom: { api: 'sample-plugin:custom' },
    }).adapter.protocol).toBe('sample-plugin:custom')

    await context.dispose()
    bus.emit('task:created', { task: { id: 'two' } }, ['web-ui'], { source: 'test' })
    await new Promise((resolve) => setImmediate(resolve))

    expect(received).toHaveBeenCalledOnce()
    expect(collected.tools).toEqual([])
    expect(collected.httpRoutes).toEqual([])
    expect(getAction('sample-plugin:collect')).toBeUndefined()
    expect(_getRpcMethodForTesting('sample-plugin:ping')).toBeUndefined()
    await expect(getAgent('sample-plugin:helper')).resolves.toBeUndefined()
    expect(() => resolveProvider('custom', {
      custom: { api: 'sample-plugin:custom' },
    })).toThrow('Unknown protocol')
  })

  it('namespaces config, custom events, and persistent storage', async () => {
    const { api } = setup()
    const custom = vi.fn()
    bus.subscribe('test-observer', (event) => {
      if (event.name === 'plugin:sample-plugin:changed') custom(event.data)
    }, { global: true, interest: ['plugin:sample-plugin:'] })

    expect(await api.config.get()).toEqual({ color: 'blue' })
    await api.storage.writeJson('state.json', { ready: true })
    api.events.emit('changed', { ready: true })
    await new Promise((resolve) => setImmediate(resolve))

    expect(await api.storage.readJson('state.json', {})).toEqual({ ready: true })
    expect(custom).toHaveBeenCalledWith({ ready: true })
  })

  it('registers typed multi-point hooks with filters and timeouts', async () => {
    const dispatcher = new HookDispatcher()
    dispatchers.push(dispatcher)
    dispatcher.init([])
    setSessionHookDispatcher(dispatcher)
    const { api, context } = setup()
    const handler = vi.fn()

    api.registry.hook({
      id: 'lifecycle',
      points: ['onTaskCreated', 'onSessionWillReap'],
      priority: 25,
      timeoutMs: 1_500,
      filter: { projects: ['Example'], requiresSession: true },
      handler,
    })

    expect(dispatcher.getHooks()).toEqual([
      expect.objectContaining({
        id: 'sample-plugin:lifecycle',
        hooks: ['onTaskCreated', 'onSessionWillReap'],
        priority: 25,
        timeoutMs: 1_500,
        filter: { projects: ['Example'], requiresSession: true },
        source: 'plugin',
      }),
    ])

    await context.dispose()
    expect(dispatcher.getHooks()).toEqual([])
  })

  it('keeps activation usable when hooks are disabled', async () => {
    setSessionHookDispatcher(null)
    const { api, context } = setup()
    const warningsBefore = vi.mocked(logger.warn).mock.calls.length

    const registration = api.registry.hook({
      id: 'optional-hook',
      point: 'onTaskCreated',
      handler: vi.fn(),
    })

    expect(vi.mocked(logger.warn).mock.calls.length).toBe(warningsBefore + 1)
    await registration.dispose()
    await context.dispose()
  })

  it('logs unsafe access once', () => {
    const { api } = setup()
    const warningsBefore = vi.mocked(logger.warn).mock.calls.length
    void api.unsafe
    void api.unsafe

    expect(vi.mocked(logger.warn).mock.calls.length).toBe(warningsBefore + 1)
  })
})
