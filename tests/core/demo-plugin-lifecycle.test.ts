import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('demo-plugin-lifecycle-test'))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config-manager.js')>()
  return {
    ...actual,
    getConfig: vi.fn(async () => ({
      version: 1,
      user: { name: 'test' },
      defaults: { priority: 'none' },
      provider: { type: 'bedrock' },
      plugins: { 'walnut-demo': { label: 'fixture' } },
    })),
    updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { buildPlugin } from '../../packages/plugin-cli/src/build.js'
import { resolveProvider } from '../../src/agent/providers/registry.js'
import { getAgent } from '../../src/core/agent-registry.js'
import { getCommand } from '../../src/core/command-store.js'
import { bus } from '../../src/core/event-bus.js'
import {
  disableLoadedPlugin,
  disposeLoadedPlugins,
  getPluginLifecycleRecords,
  loadPlugins,
  reloadLoadedPlugin,
} from '../../src/core/integration-loader.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { getAction, _resetActionsForTesting } from '../../src/core/cron/actions.js'
import { HookDispatcher, setSessionHookDispatcher } from '../../src/core/session-hooks/index.js'
import { createPluginRouteDispatcher } from '../../src/web/plugin-route-dispatcher.js'
import { _getRpcMethodForTesting } from '../../src/web/ws/handler.js'
import { DEMO_PROJECT } from '../../examples/plugins/walnut-demo/src/server/constants.js'
import { createMockTask } from './plugin-test-utils.js'

const demoRoot = path.resolve('examples/plugins/walnut-demo')
const pluginRoot = path.join(WALNUT_HOME, 'plugins', 'walnut-demo')
const statePath = path.join(WALNUT_HOME, 'plugin-data', 'walnut-demo', 'state.json')
let registry: IntegrationRegistry
let dispatcher: HookDispatcher

interface PersistedDemoState {
  counters: Record<string, number>
  demoTaskId: string | null
}

async function readState(): Promise<PersistedDemoState> {
  return JSON.parse(await fs.readFile(statePath, 'utf8')) as PersistedDemoState
}

async function flushBus(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

async function runAction(action: string, input: Record<string, unknown> = {}) {
  const method = _getRpcMethodForTesting('walnut-demo:run')
  if (!method) throw new Error('walnut-demo:run is not registered')
  return await method({ action, input }, {} as never) as {
    ok: boolean
    receipt: {
      action: string
      ok: boolean
      detail?: Record<string, unknown>
      error?: string
    }
  }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.dirname(pluginRoot), { recursive: true })
  await fs.cp(demoRoot, pluginRoot, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}dist${path.sep}`),
  })
  await buildPlugin({ root: pluginRoot })

  _resetActionsForTesting()
  dispatcher = new HookDispatcher()
  dispatcher.init([])
  setSessionHookDispatcher(dispatcher)
  registry = new IntegrationRegistry()
  registry.ensureLocalFallback()
})

afterEach(async () => {
  await disposeLoadedPlugins(registry).catch(() => undefined)
  dispatcher.destroy()
  setSessionHookDispatcher(null)
  _resetActionsForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('Demo Plugin lifecycle', () => {
  it('activates, exercises, disposes, and reloads every owner-scoped contribution', async () => {
    await loadPlugins(registry)

    const plugin = registry.get('walnut-demo')
    expect(plugin).toMatchObject({
      id: 'walnut-demo',
      apiVersion: 1,
      hasSkills: true,
      hasSync: true,
      display: { badge: 'DEMO' },
    })
    expect(plugin?.tools?.map((tool) => tool.name)).toEqual(['walnut_demo_snapshot'])
    expect(plugin?.httpRoutes).toHaveLength(1)
    expect(plugin?.agentContext).toContain('walnut_demo_snapshot')
    expect(getAction('walnut-demo:report')).toBeDefined()
    await expect(getCommand('walnut-demo:status')).resolves.toMatchObject({ source: 'plugin' })
    expect(getPluginLifecycleRecords(registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'walnut-demo', state: 'active' }),
    ]))
    await expect(getAgent('walnut-demo:observer')).resolves.toMatchObject({
      name: 'Plugin Demo Observer',
      source: 'plugin',
    })
    expect(resolveProvider('demo', {
      demo: { api: 'walnut-demo:echo' },
    }).adapter.protocol).toBe('walnut-demo:echo')
    expect(dispatcher.getHooks().filter((hook) => hook.id.startsWith('walnut-demo:'))).toHaveLength(3)

    const app = express()
    app.use('/api/plugins', createPluginRouteDispatcher(registry))
    await request(app)
      .get('/api/plugins/walnut-demo/stats')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          pluginId: 'walnut-demo',
          demoProject: DEMO_PROJECT,
          counters: { activations: 1 },
        })
        expect(body.capabilities).toEqual(expect.arrayContaining([
          'tasks.get',
          'config.onChange',
          'ops.unwrap',
          'storage.database.migrate',
          'ui.app',
          'ui.page',
        ]))
      })

    const ping = await runAction('ping')
    expect(ping).toMatchObject({
      ok: true,
      receipt: {
        action: 'ping',
        ok: true,
        detail: { pluginId: 'walnut-demo', signalAborted: false },
      },
    })

    const toolResult = await plugin!.tools![0].execute({ limit: 1 })
    expect(JSON.parse(String(toolResult))).toMatchObject({
      pluginId: 'walnut-demo',
      demoProject: DEMO_PROJECT,
      counters: { activations: 1, toolCalls: 1 },
      demoProjectTasks: [],
    })

    expect(await plugin!.claim!.fn(DEMO_PROJECT)).toBe(false)
    await expect(runAction('task-create')).resolves.toMatchObject({ ok: true })
    expect(await plugin!.claim!.fn(DEMO_PROJECT)).toBe(true)
    expect(await plugin!.claim!.fn('Plugin Demo')).toBe(false)
    await expect(runAction('task-cleanup')).resolves.toMatchObject({ ok: true })

    bus.emit('task:created', { task: createMockTask({ id: 'task-demo' }) }, ['web-ui'], { source: 'test' })
    await flushBus()
    await runAction('config-patch')
    await vi.waitFor(async () => {
      const response = await request(app).get('/api/plugins/walnut-demo/stats')
      expect(response.body.counters).toMatchObject({
        events: expect.any(Number),
        hookCalls: 1,
        configChanges: 1,
      })
      expect(response.body.counters.events).toBeGreaterThan(0)
    }, { timeout: 2_000, interval: 20 })

    await disableLoadedPlugin(registry, 'walnut-demo')
    expect(registry.get('walnut-demo')).toBeUndefined()
    expect(getAction('walnut-demo:report')).toBeUndefined()
    await expect(getCommand('walnut-demo:status')).resolves.toBeNull()
    expect(_getRpcMethodForTesting('walnut-demo:run')).toBeUndefined()
    await expect(getAgent('walnut-demo:observer')).resolves.toBeUndefined()
    expect(() => resolveProvider('demo', {
      demo: { api: 'walnut-demo:echo' },
    })).toThrow('Unknown protocol')
    expect(dispatcher.getHooks().some((hook) => hook.id.startsWith('walnut-demo:'))).toBe(false)
    await request(app).get('/api/plugins/walnut-demo/stats').expect(404)

    const afterDisable = await readState()
    bus.emit('task:created', { task: createMockTask({ id: 'task-disabled' }) }, ['web-ui'], { source: 'test' })
    bus.emit('config:changed', { config: {} }, ['web-ui'], { source: 'test' })
    await flushBus()
    expect(await readState()).toEqual(afterDisable)

    await reloadLoadedPlugin(registry, 'walnut-demo')
    expect(registry.getAll().filter((entry) => entry.id === 'walnut-demo')).toHaveLength(1)
    expect(getAction('walnut-demo:report')).toBeDefined()
    await expect(getCommand('walnut-demo:status')).resolves.toMatchObject({ source: 'plugin' })
    expect(_getRpcMethodForTesting('walnut-demo:run')).toBeDefined()
    await expect(getAgent('walnut-demo:observer')).resolves.toBeDefined()
    expect(resolveProvider('demo', {
      demo: { api: 'walnut-demo:echo' },
    }).adapter.protocol).toBe('walnut-demo:echo')
    expect(dispatcher.getHooks().filter((hook) => hook.id.startsWith('walnut-demo:'))).toHaveLength(3)
    expect(await readState()).toMatchObject({ counters: { activations: 2 } })

    await disposeLoadedPlugins(registry)
    expect(registry.get('walnut-demo')).toBeUndefined()
    expect(getAction('walnut-demo:report')).toBeUndefined()
    await expect(getCommand('walnut-demo:status')).resolves.toBeNull()
    expect(_getRpcMethodForTesting('walnut-demo:run')).toBeUndefined()
    await expect(getAgent('walnut-demo:observer')).resolves.toBeUndefined()
    expect(dispatcher.getHooks().some((hook) => hook.id.startsWith('walnut-demo:'))).toBe(false)
  })
})
