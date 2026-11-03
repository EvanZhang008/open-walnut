/**
 * Store plugins update by themselves: src/core/plugins/source-auto-update.ts over the real
 * update run (source-update-run.ts), real git clones (file:// origins, no network), the
 * real status cache and real plugin-sources state. Only the plugin loader is a fake: it
 * "loads" a plugin by reading its manifest from the clone and fails on `"broken": true`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('source-auto-update-test'))

let mockConfig: Record<string, unknown> = {}
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => mockConfig),
  updateConfig: vi.fn(async (partial: Record<string, unknown>) => { mockConfig = { ...mockConfig, ...partial } }),
}))

const loaded = vi.hoisted(() => new Set<string>())
vi.mock('../../../src/core/integration-registry.js', () => ({
  registry: { has: (id: string) => loaded.has(id), get: () => undefined },
}))

import { WALNUT_HOME, PLUGIN_STORES_DIR } from '../../../src/constants.js'
import { addSource, checkSource, listSources, setSourceAutoUpdate } from '../../../src/core/plugin-sources.js'
import { UpdateStatusCache } from '../../../src/core/plugins/update-status-cache.js'
import { sourceRowKey } from '../../../src/core/plugins/update-status.js'
import { runSourceUpdate } from '../../../src/core/plugins/source-update-run.js'
import { createSourceAutoUpdater, autoUpdateEnv } from '../../../src/core/plugins/source-auto-update.js'
import { isRestartPending } from '../../../src/core/plugins/restart-pending.js'

let fixtureRoot: string
let origin: string
let slug: string
let cache: UpdateStatusCache
let reloadCalls: string[][]
let notified: string[]

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim()

function commit(dir: string, rel: string, content: string, message = 'update'): string {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

const manifest = (version: string, extra = '') => `{ "id": "demo", "name": "Demo", "version": "${version}"${extra} }`
const cloneDir = () => path.join(PLUGIN_STORES_DIR, slug)
const head = () => git(cloneDir(), 'rev-parse', 'HEAD')
const sourceView = async () => (await listSources()).find((s) => s.slug === slug)!

/** The fake loader: a plugin "loads" when its manifest on disk is not marked broken. */
async function fakeReloadPlugins(ids: string[]): Promise<{ reloaded: string[]; skipped: string[] }> {
  reloadCalls.push(ids)
  const text = await fsp.readFile(path.join(cloneDir(), 'demo', 'manifest.json'), 'utf-8')
  if (text.includes('"broken": true')) throw new Error('Plugin update failed; previous versions restored: demo threw at activate')
  return { reloaded: ids, skipped: [] }
}

function updater() {
  return createSourceAutoUpdater({
    cache,
    sourceDir: (s) => path.join(PLUGIN_STORES_DIR, s),
    update: (s) => runSourceUpdate(s, {
      softReload: async () => undefined,
      reloadPlugins: fakeReloadPlugins,
      reloadPlugin: async (id) => { loaded.add(id); return { state: 'active' } },
      cache,
    }, 'auto'),
    notify: (s) => { notified.push(s) },
  })
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  fixtureRoot = path.join(WALNUT_HOME, '..', `fixtures-${process.pid}-${Date.now()}`)
  origin = path.join(fixtureRoot, 'store')
  fs.mkdirSync(origin, { recursive: true })
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, 'config', 'user.email', 'test@example.com')
  git(origin, 'config', 'user.name', 'Test')
  commit(origin, 'demo/manifest.json', manifest('1.0.0'), 'init')
  mockConfig = {}
  loaded.clear()
  reloadCalls = []
  notified = []
  const view = await addSource(`file://${origin}`)
  slug = view.slug
  for (const dir of [cloneDir()]) {
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'user.name', 'Test')
  }
  loaded.add('demo')
  cache = new UpdateStatusCache({
    filePath: path.join(WALNUT_HOME, 'tmp', 'cache.json'),
    ops: {
      checkLinked: async () => { throw new Error('no linked checkouts here') },
      checkSource: (s) => checkSource(s),
    },
  })
})

afterEach(async () => {
  await fsp.rm(fixtureRoot, { recursive: true, force: true })
})

describe('store sources update by themselves', () => {
  it('fast-forwards a clean clone that is behind, reloads its plugin, and says when', async () => {
    const before = head()
    // A coworker's clone that fell many commits behind.
    let tip = ''
    for (let i = 1; i <= 5; i++) tip = commit(origin, 'demo/manifest.json', manifest(`1.0.${i}`))
    const [result] = await updater().runOnce()
    expect(result).toMatchObject({ slug, action: 'updated', from: before, to: tip, reloaded: ['demo'] })
    expect(head()).toBe(tip)
    expect(reloadCalls).toEqual([['demo']])
    expect(isRestartPending('demo')).toBe(false)
    const view = await sourceView()
    expect(view.autoUpdate).toBe(true)
    expect(view.auto?.lastUpdate).toMatchObject({ from: before, to: tip, by: 'auto' })
    expect(view.lastSha).toBe(tip)
    expect(cache.entry(sourceRowKey(slug))?.state).toEqual({ kind: 'current' })
    expect(notified).toEqual([slug])
    // The next round finds it current and does nothing.
    const [again] = await updater().runOnce()
    expect(again).toMatchObject({ action: 'current' })
    expect(reloadCalls).toHaveLength(1)
  })

  it.each([
    ['an edited tracked file', () => fs.writeFileSync(path.join(cloneDir(), 'demo', 'manifest.json'), manifest('9.9.9-local'))],
    ['an untracked file', () => fs.writeFileSync(path.join(cloneDir(), 'demo', 'notes.txt'), 'mine')],
  ])('never touches a clone with %s, and says why', async (_label, dirty) => {
    const before = head()
    commit(origin, 'demo/manifest.json', manifest('1.1.0'))
    dirty()
    const [result] = await updater().runOnce()
    expect(result).toMatchObject({ action: 'skipped', reason: 'dirty' })
    expect(head()).toBe(before)
    expect(reloadCalls).toEqual([])
    expect((await sourceView()).auto?.skipped).toMatchObject({ reason: 'dirty', behind: 1, ahead: 0 })
    expect(notified).toEqual([slug])
    // Unchanged facts on the next round: no second write, no second notice.
    await updater().runOnce()
    expect(notified).toEqual([slug])
  })

  it('never drops commits of the clone\'s own (diverged)', async () => {
    commit(origin, 'demo/manifest.json', manifest('1.1.0'))
    const mine = commit(cloneDir(), 'demo/extra.txt', 'local work', 'local')
    const [result] = await updater().runOnce()
    expect(result).toMatchObject({ action: 'skipped', reason: 'diverged' })
    expect(head()).toBe(mine)
    expect((await sourceView()).auto?.skipped).toMatchObject({ reason: 'diverged', behind: 1, ahead: 1 })
  })

  it('clears the skip once the clone is clean again, then updates', async () => {
    const tip = commit(origin, 'demo/manifest.json', manifest('1.1.0'))
    const extra = path.join(cloneDir(), 'demo', 'notes.txt')
    fs.writeFileSync(extra, 'mine')
    await updater().runOnce()
    fs.rmSync(extra)
    const [result] = await updater().runOnce()
    expect(result).toMatchObject({ action: 'updated', to: tip })
    expect((await sourceView()).auto?.skipped).toBeUndefined()
  })

  it('leaves a source alone when its switch is off, and the switch is a config key that defaults on', async () => {
    const before = head()
    commit(origin, 'demo/manifest.json', manifest('1.1.0'))
    const off = await setSourceAutoUpdate(slug, false)
    expect(off.autoUpdate).toBe(false)
    expect((mockConfig.plugin_sources as Array<Record<string, unknown>>)[0]).toMatchObject({ url: `file://${origin}`, auto_update: false })
    const [result] = await updater().runOnce()
    expect(result).toMatchObject({ action: 'off' })
    expect(head()).toBe(before)
    const on = await setSourceAutoUpdate(slug, true)
    expect(on.autoUpdate).toBe(true)
    // On is the default: the key goes away, so config reads as an older Walnut wrote it.
    expect((mockConfig.plugin_sources as Array<Record<string, unknown>>)[0]).not.toHaveProperty('auto_update')
  })

  it('rolls a version that does not load back to the one that ran, and never pulls it again', async () => {
    const good = head()
    const bad = commit(origin, 'demo/manifest.json', manifest('2.0.0', ', "broken": true'))
    const [result] = await updater().runOnce()
    expect(result).toMatchObject({ action: 'rolled-back', sha: bad, to: good })
    // The files are the version that runs, and nothing waits for a restart.
    expect(head()).toBe(good)
    expect(fs.readFileSync(path.join(cloneDir(), 'demo', 'manifest.json'), 'utf-8')).toBe(manifest('1.0.0'))
    expect(isRestartPending('demo')).toBe(false)
    const view = await sourceView()
    expect(view.lastSha).toBe(good)
    expect(view.auto?.rolledBack).toMatchObject({ sha: bad, to: good, by: 'auto' })
    expect(view.auto?.rolledBack?.error).toMatch(/demo threw at activate/)
    expect(cache.entry(sourceRowKey(slug))?.state).toMatchObject({ kind: 'available', behind: 1 })

    // Held: the same bad commit is not pulled again.
    const [held] = await updater().runOnce()
    expect(held).toMatchObject({ action: 'held', sha: bad })
    expect(head()).toBe(good)
    expect(reloadCalls).toHaveLength(1)

    // A fix lands upstream: it is pulled as usual and the rollback is forgotten.
    const fixed = commit(origin, 'demo/manifest.json', manifest('2.0.1'))
    const [next] = await updater().runOnce()
    expect(next).toMatchObject({ action: 'updated', to: fixed })
    const after = await sourceView()
    expect(after.auto?.rolledBack).toBeUndefined()
    expect(after.auto?.lastUpdate).toMatchObject({ from: good, to: fixed, by: 'auto' })
  })

  it('says nothing about changes of its own while there is nothing to pull', async () => {
    fs.writeFileSync(path.join(cloneDir(), 'demo', 'notes.txt'), 'mine')
    const [result] = await updater().runOnce()
    expect(result).toMatchObject({ action: 'current' })
    expect((await sourceView()).auto).toBeUndefined()
  })

  it('a plugin that only a restart can replace keeps the new files and waits for the restart', async () => {
    const { PluginRestartRequiredError } = await import('../../../src/core/plugins/restart-pending.js')
    const tip = commit(origin, 'demo/manifest.json', manifest('1.1.0'))
    const outcome = await runSourceUpdate(slug, {
      softReload: async () => undefined,
      reloadPlugins: async () => { throw new PluginRestartRequiredError('native addon demo.node is loaded in place and cannot be replaced in a running process') },
      cache,
    }, 'auto')
    expect(outcome).toMatchObject({ kind: 'done', failed: [], restartRequired: true })
    expect(outcome.kind === 'done' && outcome.rolledBack).toBeFalsy()
    expect(head()).toBe(tip)
    expect(isRestartPending('demo')).toBe(true)
    expect((await sourceView()).auto?.rolledBack).toBeUndefined()
  })

  it('an Update press over edits of the user never throws them away when the new code does not load', async () => {
    const good = head()
    commit(origin, 'demo/manifest.json', manifest('2.0.0', ', "broken": true'))
    // The user edits a file the bad commit does not touch, and one it does (via the pull).
    fs.writeFileSync(path.join(cloneDir(), 'demo', 'README.md'), 'my notes')
    git(cloneDir(), 'add', 'demo/README.md')
    const outcome = await runSourceUpdate(slug, { softReload: async () => undefined, reloadPlugins: fakeReloadPlugins, cache }, 'manual')
    expect(outcome.kind).toBe('done')
    expect(fs.readFileSync(path.join(cloneDir(), 'demo', 'README.md'), 'utf-8')).toBe('my notes')
    if (outcome.kind === 'done' && outcome.rolledBack) expect(head()).toBe(good)
  })

  it('an automatic pull checks the clone again under its own lock (an edit made after the round looked)', async () => {
    const before = head()
    commit(origin, 'demo/manifest.json', manifest('1.1.0'))
    fs.writeFileSync(path.join(cloneDir(), 'demo', 'notes.txt'), 'typed a moment ago')
    const outcome = await runSourceUpdate(slug, { softReload: async () => undefined, reloadPlugins: fakeReloadPlugins, cache }, 'auto')
    expect(outcome).toEqual({ kind: 'refused', reason: 'dirty' })
    expect(head()).toBe(before)
  })

  it('a source whose remote cannot be reached is left as it is', async () => {
    const before = head()
    await fsp.rm(origin, { recursive: true, force: true })
    const [result] = await updater().runOnce()
    expect(result.action).toBe('unreachable')
    expect(head()).toBe(before)
    expect((await sourceView()).auto).toBeUndefined()
  })

  it('one round at a time: a second call joins the running one', async () => {
    commit(origin, 'demo/manifest.json', manifest('1.1.0'))
    const u = updater()
    const [a, b] = await Promise.all([u.runOnce(), u.runOnce()])
    expect(a).toBe(b)
    expect(reloadCalls).toHaveLength(1)
  })

  it('a round and an Update press at the same time pull once', async () => {
    const tip = commit(origin, 'demo/manifest.json', manifest('1.1.0'))
    const deps = { softReload: async () => undefined, reloadPlugins: fakeReloadPlugins, cache }
    const [round, press] = await Promise.all([updater().runOnce(), runSourceUpdate(slug, deps, 'manual')])
    expect(head()).toBe(tip)
    const pulled = [round[0].action === 'updated', press.kind === 'done' && press.result.updated].filter(Boolean)
    expect(pulled).toHaveLength(1)
    expect(reloadCalls).toHaveLength(1)
  })

  it('an older Walnut\'s data (no auto field, no switch key) reads as on, with nothing to say', async () => {
    const view = await sourceView()
    expect(view.autoUpdate).toBe(true)
    expect(view.auto).toBeUndefined()
    const state = JSON.parse(fs.readFileSync(path.join(PLUGIN_STORES_DIR, 'sources.json'), 'utf-8'))
    expect(state[slug]).not.toHaveProperty('auto')
  })

  it('the env turns it off everywhere and shortens the clocks only to sane values', () => {
    expect(autoUpdateEnv({}).enabled).toBe(true)
    expect(autoUpdateEnv({ WALNUT_PLUGIN_AUTO_UPDATE: '0' }).enabled).toBe(false)
    expect(autoUpdateEnv({ WALNUT_PLUGIN_AUTO_UPDATE_FIRST_MS: '5000', WALNUT_PLUGIN_AUTO_UPDATE_INTERVAL_MS: '10' }))
      .toEqual({ enabled: true, firstDelayMs: 5000 })
  })
})
