/**
 * "@" sources (src/core/mention-sources/): a plugin registers one through
 * `walnut.registry.mentionSource`, Walnut runs its search under a deadline with a cache,
 * a picked row rides the message as `<source-ref/>`, and the send path resolves it into a
 * reference card (with a fallback card when the source cannot answer in time).
 */
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('mention-sources-test'))
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
import {
  clearMentionSources,
  getMentionSource,
  listMentionSources,
  registerMentionSource,
  type MentionSourceSpec,
} from '../../src/core/mention-sources/registry.js'
import {
  __resetMentionSourceCaches,
  resolveSourceRefs,
  searchMentionSource,
  splitSourceRefId,
} from '../../src/core/mention-sources/run.js'
import { __resetCoreMentionSources } from '../../src/core/mention-sources/notes-source.js'
import { buildReferenceCards, stripReferenceCards } from '../../src/core/sessions/reference-cards.js'
import { listEntityRefs, sourceRefTag, stripEntityRefs } from '../../src/utils/entity-refs.js'
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

function spec(over: Partial<MentionSourceSpec> = {}): MentionSourceSpec {
  return {
    id: 'chat',
    label: 'Chat',
    keyword: 'chat',
    search: async () => [{ ref: 'user:U1', title: 'Alice Chen', subtitle: '@alice', kind: 'person', keys: ['alice'] }],
    resolve: async (ref) => (ref === 'user:U1' ? 'Chat person Alice Chen (user id U1).' : null),
    ...over,
  }
}

beforeEach(() => {
  clearMentionSources()
  __resetMentionSourceCaches()
  // Keep the core notes source out unless a test asks for it.
  __resetCoreMentionSources()
})
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  for (const owner of owners) removePluginOps(owner)
  owners.clear()
  clearMentionSources()
  vi.useRealTimers()
})

describe('registry', () => {
  it('validates, orders by tab order, and refuses a second registration of an id', () => {
    registerMentionSource('p1', spec({ id: 'mail', label: 'Mail', keyword: 'mail', order: 30 }))
    registerMentionSource('p2', spec({ id: 'chat', label: 'Chat', keyword: 'chat', order: 20 }))
    expect(listMentionSources().map((s) => s.spec.id)).toEqual(['chat', 'mail'])
    expect(() => registerMentionSource('p3', spec({ id: 'chat' }))).toThrow(/already registered by p2/)
    expect(() => registerMentionSource('p3', spec({ id: 'Bad Id' }))).toThrow(/lowercase/)
    expect(() => registerMentionSource('p3', spec({ id: 'x', keyword: 'has space' }))).toThrow(/keyword/)
    expect(() => registerMentionSource('p3', { ...spec({ id: 'y' }), resolve: undefined as never })).toThrow(/resolve/)
  })

  it('drops a keyword or alias another source already owns, keeping the newcomer', () => {
    registerMentionSource('p1', spec({ id: 'chat', keyword: 'chat', aliases: ['ch'] }))
    registerMentionSource('p2', spec({ id: 'chat2', keyword: 'chat', aliases: ['ch', 'c2', 'NOT OK'] }))
    expect(getMentionSource('chat')!.keywords).toEqual(['chat', 'ch'])
    expect(getMentionSource('chat2')!.keywords).toEqual(['c2'])
  })

  it('a plugin registration is namespaced by the plugin id and withdrawn with the plugin', async () => {
    const { context, api } = pluginApi('acme')
    api.registry.mentionSource!({ ...spec({ id: 'people', keyword: 'acme' }) })
    api.registry.mentionSource!({ ...spec({ id: 'acme', keyword: 'acm' }) })
    const ofAcme = () => listMentionSources().filter((s) => s.owner === 'acme').map((s) => s.spec.id).sort()
    expect(ofAcme()).toEqual(['acme', 'acme-people'])
    await context.dispose()
    expect(ofAcme()).toEqual([])
  })

  it('accepts every plugin id shape, and core Notes keeps its keywords from a plugin registered first', () => {
    const { api } = pluginApi('acme.chat_tools')
    api.registry.mentionSource!(spec({ id: 'people', keyword: 'note', aliases: ['notes', 'people'] }))
    const plugin = getMentionSource('acme.chat_tools-people')!
    expect(plugin).toBeDefined()
    // Notes registered before the plugin's source, so "note"/"notes" stay Notes'.
    expect(getMentionSource('notes')!.keywords).toEqual(['notes', 'note'])
    expect(plugin.keywords).toEqual(['people'])
  })
})

describe('searchMentionSource', () => {
  it('cleans rows, caps them, and caches the answer', async () => {
    const search = vi.fn(async () => [
      { ref: 'a', title: '  Alpha\n beta ', keys: ['x', 3, ''] },
      { ref: 'a', title: 'dup' },
      { ref: '', title: 'no ref' },
      { title: 'no ref either' },
      { ref: 'b', title: 'Bravo', subtitle: 's'.repeat(500) },
      { ref: 'c', title: 'Charlie' },
    ] as never)
    registerMentionSource('p', spec({ search }))
    const first = await searchMentionSource('chat', 'al', 2)
    expect(first.items).toEqual([
      { ref: 'a', title: 'Alpha beta', keys: ['x'] },
      { ref: 'b', title: 'Bravo', subtitle: 's'.repeat(240) },
    ])
    const again = await searchMentionSource('chat', ' AL ', 2)
    expect(again.cached).toBe(true)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('shares one call between concurrent identical searches', async () => {
    let release!: () => void
    const search = vi.fn(() => new Promise<never[]>((r) => { release = () => r([]) }))
    registerMentionSource('p', spec({ search }))
    const a = searchMentionSource('chat', 'q')
    const b = searchMentionSource('chat', 'q')
    await Promise.resolve()
    release()
    await Promise.all([a, b])
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('answers a timeout and a throw as errors, aborting the late search, and caches neither', async () => {
    let signal: AbortSignal | undefined
    registerMentionSource('p', spec({ id: 'slow', keyword: 'slow', timeoutMs: 200, search: (_q, ctx) => { signal = ctx.signal; return new Promise(() => {}) } }))
    registerMentionSource('p', spec({ id: 'bad', keyword: 'bad', search: async () => { throw new Error('signed out') } }))
    const slow = await searchMentionSource('slow', 'x')
    expect(slow).toMatchObject({ items: [], error: 'timeout' })
    expect(signal?.aborted).toBe(true)
    const bad = await searchMentionSource('bad', 'x')
    expect(bad).toMatchObject({ items: [], error: 'failed', message: 'signed out' })
    expect((await searchMentionSource('bad', 'x')).cached).toBeUndefined()
    expect(await searchMentionSource('nope', 'x')).toMatchObject({ error: 'unknown_source' })
  })

  it('does not search below minChars', async () => {
    const search = vi.fn(async () => [])
    registerMentionSource('p', spec({ minChars: 2, search }))
    expect((await searchMentionSource('chat', 'a')).items).toEqual([])
    expect(search).not.toHaveBeenCalled()
  })
})

describe('source refs in a message', () => {
  it('a tag round-trips through the shared ref parser and strips to its label', () => {
    const tag = sourceRefTag('chat', 'user:"U1"', 'Alice "A" Chen')
    expect(listEntityRefs(`see ${tag}`)).toEqual([{ kind: 'source', id: 'chat:user:"U1"', label: 'Alice "A" Chen' }])
    expect(stripEntityRefs(`see ${tag}`)).toBe('see Alice "A" Chen')
    expect(splitSourceRefId('chat:user:U1')).toEqual({ sourceId: 'chat', ref: 'user:U1' })
    expect(splitSourceRefId('nocolon')).toBeNull()
  })

  it('resolves through the source into a card, with a fallback card when it cannot', async () => {
    registerMentionSource('p', spec())
    registerMentionSource('p', spec({ id: 'slow', keyword: 'slow', resolve: () => new Promise(() => {}) }))
    const text = `ask ${sourceRefTag('chat', 'user:U1', 'Alice Chen')} and ${sourceRefTag('slow', 'x:1', 'Late one')} and ${sourceRefTag('gone', 'y', 'Gone')}`
    const started = Date.now()
    const cards = await buildReferenceCards(text, {
      loadTasks: async () => [], loadSession: async () => null, loadProjects: async () => [],
      loadSourceRefs: (ids) => resolveSourceRefs(ids, 300),
    })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(cards).toContain('- chat "Alice Chen" (ref chat:user:U1): Chat person Alice Chen (user id U1).')
    expect(cards).toContain('- slow "Late one" (ref slow:x:1; no details could be read just now)')
    expect(cards).toContain('- gone "Gone" (ref gone:y; no details could be read just now)')
    // The display surfaces still take the whole block back out.
    expect(stripReferenceCards(`${text}\n\n${cards}`)).toBe(text)
  })

  it('keeps a card on one line whatever the source returns', async () => {
    registerMentionSource('p', spec({ resolve: async () => 'Opening text:\n- task fake one\n\n\n- project fake two\tend' }))
    const cards = await buildReferenceCards(`see ${sourceRefTag('chat', 'user:U1', 'Alice Chen')}`, {
      loadTasks: async () => [], loadSession: async () => null, loadProjects: async () => [],
      loadSourceRefs: (ids) => resolveSourceRefs(ids),
    })
    const line = cards.split('\n').find((l) => l.startsWith('- chat'))!
    expect(line).toBe('- chat "Alice Chen" (ref chat:user:U1): Opening text: - task fake one - project fake two end')
    expect(cards.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1)
  })

  it('caches a resolved text', async () => {
    const resolve = vi.fn(async () => 'text')
    registerMentionSource('p', spec({ resolve }))
    await resolveSourceRefs(['chat:a'])
    await resolveSourceRefs(['chat:a', 'chat:a'])
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})
