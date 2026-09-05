/**
 * Plugin ops: `walnut.registry.op()` wired into the ONE op registry.
 *
 * Three layers, because three different things can break:
 *  - `pluginOpName`: the prefix rule. `_` and not `:` because an op name is also
 *    an MCP tool name and a CLI word; `mail` keeping `mail_search` is pinned.
 *  - `definePluginOp` / the api's validation: never shadow a core op, never let a
 *    plugin flood the catalogue.
 *  - a really loaded plugin: registering, calling (in-process AND over the
 *    gateway), reloading, and both removal paths, through the real loader.
 *
 * Core ops are present throughout WITHOUT this file importing them: server-api
 * imports `src/ops/index.js` eagerly, which is the whole point of that import.
 * The plugin-registers-first ordering lives in tests/unit/ops/core-op-name-wins.test.ts,
 * which needs a fresh module graph and so cannot share this file.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('plugin-ops-registry-test'))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config-manager.js')>()
  return {
    ...actual,
    getConfig: vi.fn(async () => ({
      version: 1,
      user: { name: 'test' },
      defaults: { priority: 'none' },
      provider: { type: 'bedrock' },
      plugins: {},
    })),
    updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import {
  definePluginOp,
  getOp,
  listOpEntries,
  removePluginOps,
  type WalnutOp,
} from '../../src/ops/registry.js'
import { pluginOpName } from '../../src/core/plugins/ids.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import {
  callPluginOp,
  createServerPluginApi,
  listPluginOps,
} from '../../src/core/plugins/server-api.js'
import { IntegrationRegistry, registry as globalRegistry } from '../../src/core/integration-registry.js'
import {
  disableLoadedPlugin,
  disposeLoadedPlugins,
  loadPlugins,
  reloadLoadedPlugin,
} from '../../src/core/integration-loader.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../src/core/peers/peer-throttle.js'
import { createTestPluginApi } from './plugin-test-utils.js'

/** Every owner this file registers an op under. Swept in afterEach, so a new test
 *  cannot leak an op into the next one by forgetting a hardcoded list entry. */
const touchedOwners = new Set<string>()

function defineOwnedOp(owner: string, op: WalnutOp) {
  touchedOwners.add(owner)
  return definePluginOp(owner, op)
}

function operation(name: string, title: string): WalnutOp {
  return {
    name,
    title,
    description: title,
    input: {},
    handler: async () => ({ title }),
    tags: { readonly: true, remote: 'allow' },
  }
}

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

/** The server api a plugin is handed, without the loader in the way. */
function pluginApi(pluginId: string) {
  touchedOwners.add(pluginId)
  const context = new PluginContext({
    id: pluginId,
    dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId),
    logger,
  })
  contexts.push(context)
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginId })
  return {
    context,
    api: createServerPluginApi({
      context,
      pluginName: pluginId,
      legacyApi,
      contributions: collected,
      integrationRegistry: new IntegrationRegistry(),
    }),
  }
}

function opSpec(overrides: Record<string, unknown> = {}) {
  return {
    name: 'ping',
    title: 'Ping',
    description: 'Answer with a greeting.',
    readonly: true,
    handler: async () => ({ ok: true }),
    ...overrides,
  } as Parameters<ReturnType<typeof pluginApi>['api']['registry']['op']>[0]
}

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  for (const owner of touchedOwners) removePluginOps(owner)
  touchedOwners.clear()
})

describe('pluginOpName', () => {
  it('prefixes the plugin id with punctuation folded to underscores', () => {
    expect(pluginOpName('walnut-demo', 'ping')).toBe('walnut_demo_ping')
    expect(pluginOpName('my.plugin', 'ping')).toBe('my_plugin_ping')
  })

  it('leaves a name that already carries the prefix alone', () => {
    // The mail base plugin keeps its natural op names: mail_search, not mail_mail_search.
    expect(pluginOpName('mail', 'search')).toBe('mail_search')
    expect(pluginOpName('mail', 'mail_search')).toBe('mail_search')
  })

  it('refuses a local name an MCP tool name or CLI word could not carry', () => {
    expect(() => pluginOpName('mail', 'Search')).toThrow(/Invalid plugin op name/)
    expect(() => pluginOpName('mail', 'mail:search')).toThrow(/Invalid plugin op name/)
    expect(() => pluginOpName('mail', '')).toThrow(/Invalid plugin op name/)
    expect(() => pluginOpName('mail', 'x'.repeat(65))).toThrow(/Invalid plugin op name/)
  })

  it('refuses a FINAL name the plugin op route could never invoke', () => {
    // The route gates on ^[a-z0-9_]{1,128}$; a longer name would register and then
    // be permanently unreachable.
    const longId = `p${'x'.repeat(63)}`
    expect(pluginOpName(longId, 'ping').length).toBe(longId.length + 5)
    expect(() => pluginOpName(longId, 'y'.repeat(64))).toThrow(/exceeds 128 characters/)
  })
})

describe('owner-scoped Plugin ops', () => {
  it('removes a contribution through its disposable', () => {
    const registration = defineOwnedOp('plugin-ops-a', operation('plugin_ops_disposable', 'Disposable'))

    expect(getOp('plugin_ops_disposable')?.title).toBe('Disposable')
    registration.dispose()
    expect(getOp('plugin_ops_disposable')).toBeUndefined()
  })

  it('removes one owner without touching another', () => {
    defineOwnedOp('plugin-ops-a', operation('plugin_ops_first', 'First'))
    defineOwnedOp('plugin-ops-a', operation('plugin_ops_second', 'Second'))
    defineOwnedOp('plugin-ops-b', operation('plugin_ops_other', 'Other'))

    expect(removePluginOps('plugin-ops-a')).toBe(2)
    expect(getOp('plugin_ops_first')).toBeUndefined()
    expect(getOp('plugin_ops_second')).toBeUndefined()
    expect(getOp('plugin_ops_other')?.title).toBe('Other')
  })

  it('does not let a stale handle remove a later registration', () => {
    const stale = defineOwnedOp('plugin-ops-a', operation('plugin_ops_reload', 'Before'))
    removePluginOps('plugin-ops-a')
    const current = defineOwnedOp('plugin-ops-a', operation('plugin_ops_reload', 'After'))

    stale.dispose()
    expect(getOp('plugin_ops_reload')?.title).toBe('After')

    current.dispose()
    expect(getOp('plugin_ops_reload')).toBeUndefined()
  })

  it('refuses a name that is already taken, naming the owner that holds it', () => {
    expect(() => defineOwnedOp('task', operation('task_get', 'Shadow')))
      .toThrow('op "task_get" is already defined by core')
    expect(getOp('task_get')?.title).not.toBe('Shadow')

    defineOwnedOp('plugin-ops-a', operation('plugin_ops_taken', 'Mine'))
    expect(() => defineOwnedOp('plugin-ops-b', operation('plugin_ops_taken', 'Theirs')))
      .toThrow('op "plugin_ops_taken" is already defined by plugin-ops-a')
  })
})

describe('registry.op validation', () => {
  it('rejects a missing or oversized description', () => {
    const { api } = pluginApi('ops-demo')
    expect(() => api.registry.op(opSpec({ description: '   ' }))).toThrow(/requires a description/)
    expect(() => api.registry.op(opSpec({ description: 'x'.repeat(1025) }))).toThrow(/exceeds 1024 characters/)
    expect(() => api.registry.op(opSpec({ title: ' ' }))).toThrow(/requires a title/)
    expect(getOp('ops_demo_ping')).toBeUndefined()
  })

  it('rejects a second op with the same local name', () => {
    const { api } = pluginApi('ops-demo')
    api.registry.op(opSpec())
    expect(() => api.registry.op(opSpec({ title: 'Ping again' })))
      .toThrow('op "ops_demo_ping" is already defined by ops-demo')
  })

  it('refuses to shadow a core op even when the prefix makes the collision look natural', () => {
    const { api } = pluginApi('task')
    expect(() => api.registry.op(opSpec({ name: 'get' })))
      .toThrow('op "task_get" is already defined by core')
  })

  it('caps a plugin at 24 ops and gives the budget back on disposal', () => {
    const { api } = pluginApi('noisy')
    const handles = Array.from({ length: 24 }, (_, index) => api.registry.op(opSpec({ name: `op_${index}` })))
    expect(() => api.registry.op(opSpec({ name: 'one_too_many' }))).toThrow(/at most 24 ops/)

    handles[0].dispose()
    const replacement = api.registry.op(opSpec({ name: 'one_too_many' }))
    expect(getOp('noisy_one_too_many')).toBeDefined()
    replacement.dispose()
  })

  it('sees the budget the registry actually holds, not a private tally', () => {
    // An owner sweep (or a core eviction) removes entries without telling the api;
    // a closure counter would keep refusing forever.
    const { api } = pluginApi('noisy')
    for (let index = 0; index < 24; index++) api.registry.op(opSpec({ name: `op_${index}` }))
    expect(removePluginOps('noisy')).toBe(24)
    expect(() => api.registry.op(opSpec({ name: 'after_sweep' }))).not.toThrow()
  })

  it('defaults remote from readonly and passes destructive through', () => {
    const { api } = pluginApi('ops-demo')
    api.registry.op(opSpec({ name: 'read' }))
    api.registry.op(opSpec({ name: 'write', readonly: false }))
    api.registry.op(opSpec({ name: 'shared', readonly: false, remote: 'allow', destructive: true }))

    expect(getOp('ops_demo_read')?.tags).toEqual({ readonly: true, remote: 'allow' })
    expect(getOp('ops_demo_write')?.tags).toEqual({ readonly: false, remote: 'deny' })
    expect(getOp('ops_demo_shared')?.tags).toEqual({ readonly: false, remote: 'allow', destructive: true })
  })

  it('treats a plain-JS plugin that omits readonly as a write, never as undefined', () => {
    // undefined in tags.readonly is dropped by the cloud relay's validator, which
    // would silently remove the op from a replica's catalogue.
    const { api } = pluginApi('ops-demo')
    api.registry.op(opSpec({ name: 'sloppy', readonly: undefined }))
    expect(getOp('ops_demo_sloppy')?.tags).toEqual({ readonly: false, remote: 'deny' })
  })

  it('drops every op the plugin owns when its context is disposed', async () => {
    const { api, context } = pluginApi('ops-demo')
    api.registry.op(opSpec())
    expect(getOp('ops_demo_ping')).toBeDefined()

    await context.dispose()
    expect(getOp('ops_demo_ping')).toBeUndefined()
  })
})

// ── The whole path, through the real loader ──

const pluginRoot = path.join(WALNUT_HOME, 'plugins', 'ops-demo')
const GATEWAY_CALLER = 'a1b2c3d4-1111-2222-3333-444455556666'

const SERVER_ENTRY = `
export async function activate(walnut) {
  const ping = walnut.registry.op({
    name: 'ping',
    title: 'Ping the demo',
    description: 'Answer with the greeting it was asked for.',
    inputSchema: {
      type: 'object',
      properties: { who: { type: 'string', description: 'Who to greet' } },
      required: ['who'],
    },
    readonly: true,
    async handler(args) {
      return { greeting: 'hello ' + args.who, pluginId: walnut.pluginId }
    },
  })

  // A freeform bag, a declared nested object, and a property whose type the host
  // cannot model — all REQUIRED, so this op pins both schema traps end to end.
  walnut.registry.op({
    name: 'echo',
    title: 'Echo the arguments',
    description: 'Return the arguments exactly as the handler received them.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: { type: 'object' },
        filter: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
        tag: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['payload', 'filter', 'tag'],
    },
    readonly: true,
    async handler(args) {
      return { seen: args }
    },
  })

  walnut.registry.op({
    name: 'drop_ping',
    title: 'Drop the ping op',
    description: 'Dispose the ping registration, so a test can observe the handle path.',
    readonly: false,
    async handler() {
      await ping.dispose()
      return { dropped: true }
    },
  })
}
`

async function loadDemoPlugin(): Promise<void> {
  await fs.mkdir(path.join(pluginRoot, 'dist'), { recursive: true })
  await fs.writeFile(path.join(pluginRoot, 'manifest.json'), JSON.stringify({
    id: 'ops-demo',
    name: 'Ops Demo',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
  }))
  await fs.writeFile(path.join(pluginRoot, 'dist', 'server.mjs'), SERVER_ENTRY)
  await loadPlugins(globalRegistry)
}

describe('registry.op through a loaded plugin', () => {
  beforeEach(async () => {
    await disposeLoadedPlugins(globalRegistry).catch(() => undefined)
    globalRegistry.clear()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    touchedOwners.add('ops-demo')
    await loadDemoPlugin()
  })

  afterEach(async () => {
    await disposeLoadedPlugins(globalRegistry).catch(() => undefined)
    globalRegistry.clear()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  })

  it('registers the prefixed op with plugin ownership and readonly defaults', async () => {
    const op = getOp('ops_demo_ping')
    expect(op?.title).toBe('Ping the demo')
    expect(op?.tags).toEqual({ readonly: true, remote: 'allow' })
    expect(op?.bind).toBeUndefined()
    expect(getOp('ops_demo_drop_ping')?.tags).toEqual({ readonly: false, remote: 'deny' })

    const listed = await listPluginOps()
    expect(listed.find((entry) => entry.name === 'ops_demo_ping'))
      .toEqual({ name: 'ops_demo_ping', title: 'Ping the demo', readonly: true, owner: 'ops-demo' })
    expect(listed.find((entry) => entry.name === 'task_get')?.owner).toBe('core')
  })

  it('runs the handler in-process for any caller, and validates args first', async () => {
    // A different plugin id on purpose: pluginId is provenance, not authorization.
    const ok = await callPluginOp('some-other-plugin', 'ops_demo_ping', { who: 'ada' })
    expect(ok).toEqual({ ok: true, result: { greeting: 'hello ada', pluginId: 'ops-demo' } })

    const bad = await callPluginOp('some-other-plugin', 'ops_demo_ping', {})
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.message).toMatch(/who/)
  })

  it('hands the handler every key the caller sent, nested ones included', async () => {
    const outcome = await callPluginOp('ops-demo', 'ops_demo_echo', {
      payload: { any: 1, deep: { kept: true } },
      filter: { project: 'walnut', extra: 7 },
      tag: 42,
    })
    expect(outcome).toEqual({
      ok: true,
      result: {
        seen: {
          payload: { any: 1, deep: { kept: true } },
          filter: { project: 'walnut', extra: 7 },
          tag: 42,
        },
      },
    })
  })

  it('refuses a required argument whose type the host could not model', async () => {
    const outcome = await callPluginOp('ops-demo', 'ops_demo_echo', {
      payload: {},
      filter: { project: 'walnut' },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.message).toMatch(/tag: Required/)
  })

  it('is callable from a managed session over the gateway when remote allows it', async () => {
    const deps = { throttle: new PeerThrottle(), cloudMode: false }

    const listed = await handleGatewayCapability('tools.list', GATEWAY_CALLER, {}, 'devbox', deps)
    expect(listed.ok).toBe(true)
    const rows = listed.ok ? listed.result.ops as Array<{ name: string; remote: string }> : []
    expect(rows.find((row) => row.name === 'ops_demo_ping')?.remote).toBe('allow')
    expect(rows.find((row) => row.name === 'ops_demo_drop_ping')?.remote).toBe('deny')

    const called = await handleGatewayCapability('tools.call', GATEWAY_CALLER, { name: 'ops_demo_ping', args: { who: 'ada' } }, 'devbox', deps)
    expect(called).toEqual({ ok: true, result: { greeting: 'hello ada', pluginId: 'ops-demo' } })

    const denied = await handleGatewayCapability('tools.call', GATEWAY_CALLER, { name: 'ops_demo_drop_ping' }, 'devbox', deps)
    expect(denied.ok).toBe(false)
    expect(denied.ok === false && denied.error.message).toMatch(/local-only/)
    expect(getOp('ops_demo_ping')).toBeDefined()
  })

  it('forgets the op when the plugin disposes its own handle', async () => {
    expect(await callPluginOp('ops-demo', 'ops_demo_drop_ping', {})).toEqual({ ok: true, result: { dropped: true } })

    expect(getOp('ops_demo_ping')).toBeUndefined()
    expect((await listPluginOps()).some((entry) => entry.name === 'ops_demo_ping')).toBe(false)
    expect(getOp('ops_demo_drop_ping')).toBeDefined()
  })

  it('survives a reload with exactly one live registration', async () => {
    await reloadLoadedPlugin(globalRegistry, 'ops-demo')

    // Two entries would mean the old registration outlived the reload; zero would
    // mean re-activation threw on its own name.
    const occurrences = listOpEntries().filter((entry) => entry.op.name === 'ops_demo_ping')
    expect(occurrences).toHaveLength(1)
    expect(occurrences[0].owner).toBe('ops-demo')
    expect(await callPluginOp('ops-demo', 'ops_demo_ping', { who: 'ada' }))
      .toEqual({ ok: true, result: { greeting: 'hello ada', pluginId: 'ops-demo' } })
  })

  it('forgets every op when the plugin is disabled', async () => {
    await disableLoadedPlugin(globalRegistry, 'ops-demo')

    expect(getOp('ops_demo_ping')).toBeUndefined()
    expect(getOp('ops_demo_drop_ping')).toBeUndefined()
    const listed = await listPluginOps()
    expect(listed.some((entry) => entry.owner === 'ops-demo')).toBe(false)
    expect(listed.some((entry) => entry.name === 'task_get')).toBe(true)
  })
})
