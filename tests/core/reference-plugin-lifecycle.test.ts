import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('reference-plugin-lifecycle-test'))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config-manager.js')>()
  return {
    ...actual,
    getConfig: vi.fn(async () => ({
      version: 1,
      user: { name: 'test' },
      defaults: { priority: 'none' },
      provider: { type: 'bedrock' },
      plugins: { 'reference-walnut': { label: 'fixture' } },
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
import { createMockTask } from './plugin-test-utils.js'

const referenceRoot = path.resolve('examples/plugins/reference-walnut')
const pluginRoot = path.join(WALNUT_HOME, 'plugins', 'reference-walnut')
let registry: IntegrationRegistry
let dispatcher: HookDispatcher

async function readCounters() {
  return JSON.parse(await fs.readFile(
    path.join(WALNUT_HOME, 'plugin-data', 'reference-walnut', 'counters.json'),
    'utf8',
  )) as {
    activations: number
    taskEvents: number
    hookCalls: number
    toolCalls: number
    idleWarnings: number
  }
}

async function flushBus(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.dirname(pluginRoot), { recursive: true })
  await fs.cp(referenceRoot, pluginRoot, {
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

describe('reference Plugin lifecycle', () => {
  it('activates, disposes, and reloads every real contribution without residue', async () => {
    await loadPlugins(registry)

    expect(registry.get('local')).toMatchObject({
      id: 'local',
      name: 'Local',
      apiVersion: 1,
      hasSync: true,
      display: { badge: 'L' },
    })
    expect(getPluginLifecycleRecords(registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'local', state: 'active' }),
    ]))

    const plugin = registry.get('reference-walnut')
    expect(plugin).toMatchObject({
      id: 'reference-walnut',
      apiVersion: 1,
      hasSkills: true,
      hasSync: false,
    })
    expect(plugin?.tools?.map((tool) => tool.name)).toEqual(['reference_walnut_snapshot'])
    expect(plugin?.httpRoutes).toHaveLength(1)
    expect(plugin?.agentContext).toContain('reference_walnut_snapshot')
    expect(getAction('reference-walnut:snapshot')).toBeDefined()
    await expect(getCommand('reference-walnut:snapshot')).resolves.toMatchObject({ source: 'plugin' })
    expect(getPluginLifecycleRecords(registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'reference-walnut', state: 'active' }),
    ]))
    expect(await _getRpcMethodForTesting('reference-walnut:status')?.({}, {} as never)).toMatchObject({
      pluginId: 'reference-walnut',
      counters: { activations: 1 },
    })
    await expect(getAgent('reference-walnut:observer')).resolves.toMatchObject({
      name: 'Reference Observer',
      source: 'plugin',
    })
    expect(resolveProvider('reference', {
      reference: { api: 'reference-walnut:echo' },
    }).adapter.protocol).toBe('reference-walnut:echo')
    expect(dispatcher.getHooks()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'reference-walnut:task-created', source: 'plugin' }),
      expect.objectContaining({ id: 'reference-walnut:session-will-reap', source: 'plugin' }),
    ]))

    const app = express()
    app.use('/api/plugins', createPluginRouteDispatcher(registry))
    await request(app)
      .get('/api/plugins/reference-walnut/stats')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          pluginId: 'reference-walnut',
          configured: true,
          counters: { activations: 1 },
        })
      })

    const toolResult = await plugin!.tools![0].execute({ limit: 1 })
    expect(JSON.parse(String(toolResult))).toMatchObject({
      pluginId: 'reference-walnut',
      counters: { activations: 1, toolCalls: 1 },
      observations: 1,
      tasks: [],
    })

    bus.emit('task:created', { task: createMockTask({ id: 'task-reference' }) }, ['web-ui'], { source: 'test' })
    await vi.waitFor(async () => {
      expect(await readCounters()).toMatchObject({ taskEvents: 1, hookCalls: 1 })
    }, { timeout: 2_000, interval: 20 })

    bus.emit('session:will-reap', {
      sessionId: 'session-reference',
      remainingMs: 240_000,
      idleDurationMs: 3_360_000,
      idleTimeoutMs: 3_600_000,
      reason: 'idle_timeout',
      warnedAt: new Date().toISOString(),
    }, ['*'], { source: 'test' })
    await vi.waitFor(async () => {
      expect(await readCounters()).toMatchObject({ idleWarnings: 1 })
    }, { timeout: 2_000, interval: 20 })

    await disableLoadedPlugin(registry, 'reference-walnut')
    expect(registry.get('reference-walnut')).toBeUndefined()
    expect(getAction('reference-walnut:snapshot')).toBeUndefined()
    await expect(getCommand('reference-walnut:snapshot')).resolves.toBeNull()
    expect(_getRpcMethodForTesting('reference-walnut:status')).toBeUndefined()
    await expect(getAgent('reference-walnut:observer')).resolves.toBeUndefined()
    expect(() => resolveProvider('reference', {
      reference: { api: 'reference-walnut:echo' },
    })).toThrow('Unknown protocol')
    expect(dispatcher.getHooks().some((hook) => hook.id.startsWith('reference-walnut:'))).toBe(false)
    await request(app).get('/api/plugins/reference-walnut/stats').expect(404)

    const afterDisable = await readCounters()
    bus.emit('task:created', { task: createMockTask({ id: 'task-disabled' }) }, ['web-ui'], { source: 'test' })
    bus.emit('session:will-reap', {
      sessionId: 'session-disabled',
      remainingMs: 240_000,
      idleDurationMs: 3_360_000,
      idleTimeoutMs: 3_600_000,
      reason: 'idle_timeout',
      warnedAt: new Date().toISOString(),
    }, ['*'], { source: 'test' })
    await flushBus()
    expect(await readCounters()).toEqual(afterDisable)

    await reloadLoadedPlugin(registry, 'reference-walnut')
    expect(registry.getAll().filter((entry) => entry.id === 'reference-walnut')).toHaveLength(1)
    expect(getAction('reference-walnut:snapshot')).toBeDefined()
    await expect(getCommand('reference-walnut:snapshot')).resolves.toMatchObject({ source: 'plugin' })
    expect(_getRpcMethodForTesting('reference-walnut:status')).toBeDefined()
    await expect(getAgent('reference-walnut:observer')).resolves.toBeDefined()
    expect(resolveProvider('reference', {
      reference: { api: 'reference-walnut:echo' },
    }).adapter.protocol).toBe('reference-walnut:echo')
    expect(dispatcher.getHooks().filter((hook) => hook.id.startsWith('reference-walnut:'))).toHaveLength(2)
    expect(await readCounters()).toMatchObject({ activations: 2 })

    await disposeLoadedPlugins(registry)
    expect(registry.get('reference-walnut')).toBeUndefined()
    expect(getAction('reference-walnut:snapshot')).toBeUndefined()
    await expect(getCommand('reference-walnut:snapshot')).resolves.toBeNull()
    expect(_getRpcMethodForTesting('reference-walnut:status')).toBeUndefined()
    await expect(getAgent('reference-walnut:observer')).resolves.toBeUndefined()
    expect(dispatcher.getHooks().some((hook) => hook.id.startsWith('reference-walnut:'))).toBe(false)
  })
})
