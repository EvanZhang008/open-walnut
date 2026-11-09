/**
 * A plugin's inbound router source (`walnut.registry.routerSource`, core/router/source-registry.ts):
 * an external chat plugin registers a cache-only adapter for its kind through the public plugin
 * API, owned by its PluginContext, the same way the built-in mail source registers in core.
 * Fixture data only: no real workspace, account or message is read.
 */
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('router-plugin-source-test'))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config-manager.js')>()
  return {
    ...actual,
    getConfig: vi.fn(async () => ({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, provider: { type: 'bedrock' }, plugins: {} })),
    updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { removePluginOps } from '../../src/ops/registry.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { currentRouterSources, readRouterItem, resolveRouterItem, RouterSourceError } from '../../src/core/router/source-registry.js'
import type { PluginRouterItemContent, PluginRouterSource, PluginRouterSourceAdapter } from '../../packages/plugin-api/src/server.js'
import { createTestPluginApi } from './plugin-test-utils.js'

const logger: PluginLogger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  child: vi.fn(() => logger),
}
const contexts: PluginContext[] = []
const owners = new Set<string>()

function pluginApi(pluginId: string) {
  owners.add(pluginId)
  const context = new PluginContext({ id: pluginId, dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId), logger })
  contexts.push(context)
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginId })
  const api = createServerPluginApi({ context, pluginName: pluginId, legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry() })
  return { context, api }
}

const source: PluginRouterSource = { kind: 'slack', account: 'T-fixture', message: 'C1/1700000000.000100' }
const itemOf = (one: PluginRouterSource, key = 'slack:T-fixture:C1:1700000000.000100') => ({
  source: { kind: one.kind, account: one.account, message: one.message }, key, threadKey: 'C1', sender: 'U-fixture', subject: '#fixture',
})
const contentOf = (one: PluginRouterSource): PluginRouterItemContent => ({
  item: itemOf(one), body: { text: 'fixture body' }, bodyAvailable: true, attachments: [], attachmentsAvailable: false,
})

/** An in-memory cache standing in for the plugin's own store: one exact item, nothing else. */
function cacheAdapter() {
  const cached = new Map([[JSON.stringify([source.kind, source.account, source.message]), source]])
  const hit = (one: PluginRouterSource) => {
    const row = cached.get(JSON.stringify([one.kind, one.account, one.message]))
    if (!row) throw new RouterSourceError('source_missing', 'The exact message is not in the cache.')
    return row
  }
  const adapter = {
    resolve: vi.fn(async (one: PluginRouterSource) => itemOf(hit(one))),
    read: vi.fn(async (one: PluginRouterSource) => contentOf(hit(one))),
  } satisfies PluginRouterSourceAdapter
  return adapter
}

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  for (const owner of owners) removePluginOps(owner)
  owners.clear()
  vi.restoreAllMocks()
})

describe('registry.routerSource', () => {
  it('registers a kind that resolves and reads the exact cached item, and is withdrawn with the plugin', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { context, api } = pluginApi('chat-plugin')
    const adapter = cacheAdapter()
    api.registry.routerSource!('slack', adapter)

    expect(await resolveRouterItem(source)).toEqual(itemOf(source))
    expect(adapter.resolve).toHaveBeenCalledWith(source)
    expect(adapter.read).not.toHaveBeenCalled()

    expect(await readRouterItem(source)).toEqual(contentOf(source))
    expect(adapter.read).toHaveBeenCalledTimes(1)
    expect(adapter.resolve).toHaveBeenCalledTimes(1)
    // Walnut asks only the plugin's cache: no network of its own on either call.
    expect(fetchSpy).not.toHaveBeenCalled()

    // A message the cache does not hold is refused by the adapter, never looked up elsewhere.
    await expect(resolveRouterItem({ ...source, message: 'C1/missing' })).rejects.toBeInstanceOf(RouterSourceError)

    await context.dispose()
    await expect(resolveRouterItem(source)).rejects.toThrow('not available')
    await expect(readRouterItem(source)).rejects.toThrow('no cache-only content reader')
  })

  it('refuses an answer that is not exactly the requested kind, account and message', async () => {
    const { api } = pluginApi('chat-plugin')
    let answer: PluginRouterSource = source
    api.registry.routerSource!('slack', {
      resolve: async () => itemOf(answer),
      read: async () => contentOf(answer),
    })
    for (const changed of [
      { ...source, account: 't-fixture' }, { ...source, message: `${source.message} ` }, { ...source, kind: 'wechat' as const },
    ]) {
      answer = changed
      await expect(resolveRouterItem(source)).rejects.toThrow('identity does not match')
      await expect(readRouterItem(source)).rejects.toThrow('identity does not match')
    }
  })

  it('hands the adapter a frozen copy, so it cannot rewrite the identity its answer is checked against', async () => {
    const { api } = pluginApi('chat-plugin')
    let frozen = false
    api.registry.routerSource!('slack', {
      resolve: async (one) => {
        frozen = Object.isFrozen(one)
        ;(one as { account: string }).account = 'rewritten'
        return itemOf(one)
      },
    })
    await expect(resolveRouterItem(source)).rejects.toMatchObject({ code: 'source_unavailable' })
    expect(frozen).toBe(true)
    expect(source.account).toBe('T-fixture')
  })

  it('disposing an earlier activation never removes the replacement, even with the same adapter object', async () => {
    const adapter = cacheAdapter()
    const first = pluginApi('chat-plugin')
    first.api.registry.routerSource!('slack', adapter)
    const second = pluginApi('chat-plugin')
    second.api.registry.routerSource!('slack', adapter)

    await first.context.dispose()
    expect(await resolveRouterItem(source)).toEqual(itemOf(source))

    await second.context.dispose()
    await expect(resolveRouterItem(source)).rejects.toThrow('not available')
  })

  it('refuses a registration after the activation was disposed, and writes nothing', async () => {
    const { context, api } = pluginApi('chat-plugin')
    await context.dispose()
    expect(() => api.registry.routerSource!('slack', cacheAdapter())).toThrow()
    await expect(resolveRouterItem(source)).rejects.toThrow('not available')
  })

  it('validates the kind and the adapter at the boundary', async () => {
    const { api } = pluginApi('chat-plugin')
    const resolve = async (one: PluginRouterSource) => itemOf(one)
    const register = (kind: unknown, adapter: unknown) => api.registry.routerSource!(kind as 'slack', adapter as PluginRouterSourceAdapter)
    expect(() => register('teams', { resolve })).toThrow(/Unknown routing source kind/)
    expect(() => register('Slack', { resolve })).toThrow(/Unknown routing source kind/)
    expect(() => register('slack', null)).toThrow(/must be an object/)
    expect(() => register('slack', {})).toThrow(/needs a resolve/)
    expect(() => register('slack', { resolve: 'nope' })).toThrow(/needs a resolve/)
    expect(() => register('slack', { resolve, read: 'nope' })).toThrow(/read must be a function/)
    expect(() => register('slack', { resolve, send: async () => undefined })).toThrow(/not "send"/)
    await expect(resolveRouterItem(source)).rejects.toThrow('not available')
  })

  it('keeps the exact delivery version in frozen copies for resolve and read, and checks currency in one batch call', async () => {
    const { api } = pluginApi('chat-plugin')
    const versioned: PluginRouterSource = { ...source, version: 'delivery-2' }
    const other: PluginRouterSource = { ...source, message: 'C1/1700000000.000200', version: 'delivery-1' }
    const seen: PluginRouterSource[] = []
    const record = (one: PluginRouterSource) => { expect(Object.isFrozen(one)).toBe(true); seen.push({ ...one }); return one }
    const versionedItem = (one: PluginRouterSource) => ({ ...itemOf(one), source: { ...itemOf(one).source, version: one.version } })
    const currentSources = vi.fn(async (sources: readonly PluginRouterSource[]) => {
      sources.forEach(record)
      return [sources[1]!]
    })
    api.registry.routerSource!('slack', {
      resolve: async (one) => versionedItem(record(one)),
      read: async (one) => ({ ...contentOf(one), item: versionedItem(record(one)) }),
      currentSources,
    })
    expect((await resolveRouterItem(versioned)).source).toEqual(versioned)
    expect((await readRouterItem(versioned)).item.source).toEqual(versioned)
    expect(await currentRouterSources([versioned, other])).toEqual([other])
    expect(currentSources).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([versioned, versioned, versioned, other])
  })

  it('passes an adapter failure through without falling back', async () => {
    const { api } = pluginApi('chat-plugin')
    const resolve = vi.fn(async () => { throw new Error('cache unavailable') })
    const read = vi.fn(async () => { throw new RouterSourceError('source_missing', 'The exact message is not in the cache.') })
    api.registry.routerSource!('slack', { resolve, read })
    await expect(resolveRouterItem(source)).rejects.toThrow('cache unavailable')
    await expect(readRouterItem(source)).rejects.toMatchObject({ code: 'source_missing' })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
  })
})
