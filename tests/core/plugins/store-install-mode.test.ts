/**
 * Install modes of Plugin Store plugins (src/core/plugins/store-install-mode.ts).
 *
 * The planner is pure and pinned case by case; the IO half runs on real git sources
 * (file:// repos in a temp WALNUT_HOME) with an in-memory config, so an add, an update that
 * brings a new plugin, and a source an older Walnut installed are each the real path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('store-install-mode-test'))

let mockConfig: { plugin_sources?: unknown[]; plugins?: Record<string, Record<string, unknown>> } = {}
let pinError: Error | null = null
let replica = false
vi.mock('../../../src/core/server-role.js', () => ({ isHostReplicaProgram: () => replica }))
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => mockConfig),
  updateConfig: vi.fn(async (partial: Record<string, unknown>) => { mockConfig = { ...mockConfig, ...partial } }),
  editPluginConfig: vi.fn(async (id: string, edit: (current: Record<string, unknown>) => Record<string, unknown> | null) => {
    if (pinError) throw pinError
    const current = mockConfig.plugins?.[id] ?? {}
    const next = edit(current)
    if (next) mockConfig = { ...mockConfig, plugins: { ...(mockConfig.plugins ?? {}), [id]: next } }
    return { config: next ?? current, changed: !!next }
  }),
}))

import { WALNUT_HOME, PLUGIN_STORES_DIR } from '../../../src/constants.js'
import { addSource, forgetKeptPlugin, listSources, updateSource } from '../../../src/core/plugin-sources.js'
import {
  availableStoreEntries,
  planStorePlugins,
  resolveStorePluginDirs,
  type StoreSourceScan,
} from '../../../src/core/plugins/store-install-mode.js'

let fixtureRoot: string

function makeRepo(name: string, files: Record<string, string>): string {
  const dir = path.join(fixtureRoot, name)
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: 'pipe' })
  git('init -q -b main')
  git('config user.email test@example.com')
  git('config user.name Test')
  git('add -A')
  git('commit -q -m init')
  return `file://${dir}`
}

function commit(url: string, rel: string, content: string): void {
  const dir = url.replace('file://', '')
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), content)
  execSync('git add -A && git commit -q -m update', { cwd: dir, stdio: 'pipe' })
}

const manifest = (id: string, install?: string) =>
  JSON.stringify({ id, name: `${id} plugin`, description: `${id} does a thing.`, ...(install ? { install } : {}) })

const loadedIds = (dirs: string[]) => dirs.map((dir) => path.basename(dir)).sort()

beforeEach(async () => {
  mockConfig = {}
  pinError = null
  replica = false
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  fixtureRoot = path.join(WALNUT_HOME, '..', `fixtures-${process.pid}-${Date.now()}`)
  await fsp.mkdir(fixtureRoot, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(fixtureRoot, { recursive: true, force: true })
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('planStorePlugins', () => {
  const source = (settled: boolean, plugins: StoreSourceScan['plugins']): StoreSourceScan => ({ slug: 's', settled, plugins })
  const p = (id: string | null, install: 'auto' | 'optional') => ({ dir: `/d/${id ?? 'broken'}`, id, install })

  it.each([
    // [what, settled, install, enabled key, loads, pinned]
    ['auto, no choice yet', true, 'auto', undefined, true, true],
    ['auto, switched off', true, 'auto', false, true, false],
    ['auto, installed', true, 'auto', true, true, false],
    ['optional, nobody installed it', true, 'optional', undefined, false, false],
    ['optional, installed', true, 'optional', true, true, false],
    ['optional, installed and off', true, 'optional', false, true, false],
    ['optional, on a source an older Walnut loaded', false, 'optional', undefined, true, true],
    ['auto, on a source an older Walnut loaded', false, 'auto', undefined, true, true],
  ] as const)('%s', (_what, settled, install, enabled, loads, pinned) => {
    const plan = planStorePlugins([source(settled, [p('x', install)])], enabled === undefined ? {} : { x: { enabled } })
    expect(plan.dirs.includes('/d/x')).toBe(loads)
    expect(plan.pin.includes('x')).toBe(pinned)
    expect(plan.available.some((entry) => entry.id === 'x')).toBe(!loads)
    expect(plan.settle).toEqual(settled ? [] : ['s'])
    expect(plan.keep.some((entry) => entry.id === 'x')).toBe(loads)
  })

  it('an id its source keeps stays installed when config.yaml lost its key, and is pinned again', () => {
    const plan = planStorePlugins([{ slug: 's', settled: true, kept: ['x'], plugins: [p('x', 'optional')] }], {})
    expect(plan.dirs).toEqual(['/d/x'])
    expect(plan.pin).toEqual(['x'])
    expect(plan.keep).toEqual([])
  })

  it('loads a manifest with no id so the loader can report it, and pins an id once', () => {
    const plan = planStorePlugins([
      source(true, [p(null, 'auto'), p('x', 'auto')]),
      { slug: 't', settled: true, plugins: [p('x', 'auto')] },
    ], {})
    expect(plan.dirs).toEqual(['/d/broken', '/d/x', '/d/x'])
    expect(plan.pin).toEqual(['x'])
  })
})

const stateFile = () => path.join(PLUGIN_STORES_DIR, 'sources.json')
const readStateFile = async () => JSON.parse(await fsp.readFile(stateFile(), 'utf-8'))

describe('resolveStorePluginDirs on real sources', () => {
  it('a pin lost to a whole-section config write comes back from the kept list; Remove forgets it', async () => {
    const url = makeRepo('team-store', { 'beta/manifest.json': manifest('beta', 'optional') })
    await addSource(url)
    mockConfig.plugins = { beta: { enabled: true } }
    await resolveStorePluginDirs(mockConfig.plugins)
    expect((await readStateFile())['team-store'].kept).toEqual(['beta'])

    // An old Settings tab writes `plugins` back from a snapshot that predates the install.
    mockConfig.plugins = {}
    expect(loadedIds(await resolveStorePluginDirs(mockConfig.plugins))).toEqual(['beta'])
    expect(mockConfig.plugins).toEqual({ beta: { enabled: true } })

    // Remove: no kept id and no key, so it waits for an Install again.
    await forgetKeptPlugin('beta')
    mockConfig.plugins = {}
    expect(await resolveStorePluginDirs(mockConfig.plugins)).toEqual([])
    expect((await readStateFile())['team-store'].kept).toBeUndefined()
  })

  it('a pin that cannot be written leaves an older source unsorted, so nothing is dropped next time', async () => {
    const url = makeRepo('team-store', { 'beta/manifest.json': manifest('beta', 'optional') })
    await addSource(url)
    const state = await readStateFile()
    delete state['team-store'].installModes
    await fsp.writeFile(stateFile(), JSON.stringify(state))
    pinError = new Error('disk full')

    expect(loadedIds(await resolveStorePluginDirs({}))).toEqual(['beta'])
    expect((await readStateFile())['team-store'].installModes).toBeUndefined()
    pinError = null
    expect(loadedIds(await resolveStorePluginDirs({}))).toEqual(['beta'])
    expect((await readStateFile())['team-store'].installModes).toBe(1)
  })

  it('a replica writes nothing and loads an unsorted source whole', async () => {
    const url = makeRepo('team-store', { 'beta/manifest.json': manifest('beta', 'optional') })
    await addSource(url)
    const state = await readStateFile()
    delete state['team-store'].installModes
    await fsp.writeFile(stateFile(), JSON.stringify(state))
    replica = true

    expect(loadedIds(await resolveStorePluginDirs({}))).toEqual(['beta'])
    expect(mockConfig.plugins).toBeUndefined()
    expect((await readStateFile())['team-store']).not.toHaveProperty('installModes')
    expect((await readStateFile())['team-store']).not.toHaveProperty('kept')
  })

  it('a new source loads its auto plugins only; Install (enabled: true) brings an optional one in', async () => {
    const url = makeRepo('team-store', {
      'alpha/manifest.json': manifest('alpha', 'auto'),
      'beta/manifest.json': manifest('beta', 'optional'),
      'gamma/manifest.json': manifest('gamma'),
    })
    await addSource(url)

    expect(loadedIds(await resolveStorePluginDirs(mockConfig.plugins ?? {}))).toEqual(['alpha', 'gamma'])
    expect(mockConfig.plugins).toEqual({ alpha: { enabled: true }, gamma: { enabled: true } })

    const entries = availableStoreEntries(await listSources(), mockConfig.plugins ?? {}, new Set(['alpha', 'gamma']))
    expect(entries).toEqual([expect.objectContaining({
      id: 'beta', name: 'beta plugin', description: 'beta does a thing.', sourceSlug: 'team-store', install: 'optional',
      source: { kind: 'git', url },
    })])

    mockConfig.plugins = { ...mockConfig.plugins, beta: { enabled: true } }
    expect(loadedIds(await resolveStorePluginDirs(mockConfig.plugins))).toEqual(['alpha', 'beta', 'gamma'])
    expect(availableStoreEntries(await listSources(), mockConfig.plugins, new Set(['alpha', 'beta', 'gamma']))).toEqual([])
  })

  it('a plugin an update brings in follows its own mode', async () => {
    const url = makeRepo('team-store', { 'alpha/manifest.json': manifest('alpha') })
    await addSource(url)
    await resolveStorePluginDirs(mockConfig.plugins ?? {})
    commit(url, 'delta/manifest.json', manifest('delta', 'optional'))
    commit(url, 'eps/manifest.json', manifest('eps', 'auto'))
    expect((await updateSource('team-store')).updated).toBe(true)

    expect(loadedIds(await resolveStorePluginDirs(mockConfig.plugins ?? {}))).toEqual(['alpha', 'eps'])
  })

  it('a store that marks an installed plugin optional later keeps it installed', async () => {
    const url = makeRepo('team-store', { 'alpha/manifest.json': manifest('alpha') })
    await addSource(url)
    await resolveStorePluginDirs(mockConfig.plugins ?? {})
    commit(url, 'alpha/manifest.json', manifest('alpha', 'optional'))
    await updateSource('team-store')

    expect(loadedIds(await resolveStorePluginDirs(mockConfig.plugins ?? {}))).toEqual(['alpha'])
  })

  it('a source an older Walnut installed keeps every plugin it had, then sorts new ones by mode', async () => {
    const url = makeRepo('team-store', {
      'alpha/manifest.json': manifest('alpha', 'auto'),
      'beta/manifest.json': manifest('beta', 'optional'),
      'off/manifest.json': manifest('off', 'optional'),
    })
    await addSource(url)
    // What an older Walnut leaves: no `installModes` in sources.json, no `enabled` keys for
    // what it loaded, `false` for what the user switched off.
    const state = await readStateFile()
    delete state['team-store'].installModes
    await fsp.writeFile(stateFile(), JSON.stringify(state))
    mockConfig.plugins = { off: { enabled: false }, beta: { room: 'r1' } }

    expect(loadedIds(await resolveStorePluginDirs(mockConfig.plugins))).toEqual(['alpha', 'beta', 'off'])
    expect(mockConfig.plugins).toEqual({ off: { enabled: false }, beta: { room: 'r1', enabled: true }, alpha: { enabled: true } })
    expect((await readStateFile())['team-store']).toMatchObject({ installModes: 1, kept: ['alpha', 'beta', 'off'] })

    // Sorted now: a new optional plugin waits; the old ones stay as they were.
    commit(url, 'zeta/manifest.json', manifest('zeta', 'optional'))
    await updateSource('team-store')
    expect(loadedIds(await resolveStorePluginDirs(mockConfig.plugins))).toEqual(['alpha', 'beta', 'off'])
  })

  it('a disabled source loads nothing and pins nothing', async () => {
    const url = makeRepo('team-store', { 'beta/manifest.json': manifest('beta', 'optional') })
    await addSource(url)
    mockConfig.plugin_sources = [{ url, enabled: false }]

    expect(await resolveStorePluginDirs({})).toEqual([])
    expect(mockConfig.plugins).toBeUndefined()
  })
})
