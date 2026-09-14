/**
 * GET /api/plugin-updates through fake ops.
 *
 * The contract under test is timing and counting, not git: the route answers from the
 * cache without waiting on a check, a stale cache refreshes in the background and the
 * next read sees the new rows, one checkout means one fetch however many plugins link
 * into it, and a hung row is written off by its deadline while the others land.
 * Deadlines are injected short; the code path is the one the real constants drive.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginSourceView } from '../../../src/core/plugin-sources.js'
import type { LinkedCheckoutInfo, LinkedCheckoutStatus } from '../../../src/core/plugins/linked-checkout.js'
import { UpdateStatusCache, type LocalFacts, type UpdateCheckOps } from '../../../src/core/plugins/update-status-cache.js'
import { linkedRowKey, sourceRowKey, type PluginUpdatesResponse } from '../../../src/core/plugins/update-status.js'
import { CLOUD_LINKED_NOTE, type LinkedCheckoutOps } from '../../../src/web/routes/plugin-runtime.js'
import { createPluginUpdatesRouter } from '../../../src/web/routes/plugin-updates.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const T0 = Date.parse('2026-03-01T10:00:00.000Z')

const tempDirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })))
})

/** A real directory, because the cache stats the checkout before fetching (a missing one is `missing`). */
async function checkoutDir(name = 'acme-plugins'): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `plugin-updates-${name}-`))
  tempDirs.push(dir)
  return fsp.realpath(dir)
}

function info(checkout: string, overrides: Partial<LinkedCheckoutInfo> = {}): LinkedCheckoutInfo {
  return { path: path.join(checkout, 'sample'), checkout, branch: 'main', sha: SHA_A, remote: 'https://example.invalid/acme/plugins.git', dirty: false, ...overrides }
}

function status(overrides: Partial<LinkedCheckoutStatus> = {}): LinkedCheckoutStatus {
  return { behind: 0, ahead: 0, dirty: false, sha: SHA_A, branch: 'main', fetched: true, upstreamSha: SHA_B, ...overrides }
}

function source(slug: string, overrides: Partial<PluginSourceView> = {}): PluginSourceView {
  return { slug, kind: 'git', url: `https://example.invalid/${slug}.git`, enabled: true, cloned: true, plugins: [{ dir: `/x/${slug}`, id: `${slug}-plugin`, name: slug, version: '1.0.0' }], ...overrides }
}

/** Local facts that agree with the fetch: nothing moved, nothing dirty. */
const quietFacts: LocalFacts = { dirty: false, head: SHA_A, behind: 0, ahead: 0, moved: false }

interface Harness {
  app: express.Express
  cache: UpdateStatusCache
  ops: { checkLinked: ReturnType<typeof vi.fn>; checkSource: ReturnType<typeof vi.fn>; readLocalFacts: ReturnType<typeof vi.fn> }
  clock: { now: number }
  get(query?: string): Promise<{ status: number; body: PluginUpdatesResponse }>
  /** Wait until no batch or row is in flight (the client's poll loop, collapsed). */
  settle(): Promise<void>
}

function harness(options: {
  linked?: Map<string, LinkedCheckoutInfo>
  sources?: PluginSourceView[]
  installedIds?: string[]
  cloudMode?: boolean
  checkLinked?: UpdateCheckOps['checkLinked']
  checkSource?: UpdateCheckOps['checkSource']
  readLocalFacts?: UpdateCheckOps['readLocalFacts']
  minIntervalMs?: number
  rowDeadlineMs?: number
  batchDeadlineMs?: number
  cacheFile?: string
} = {}): Harness {
  const clock = { now: T0 }
  const ops = {
    checkLinked: vi.fn(options.checkLinked ?? (async () => status())),
    checkSource: vi.fn(options.checkSource ?? (async () => ({ behind: 0, updateAvailable: false }))),
    readLocalFacts: vi.fn(options.readLocalFacts ?? (async () => quietFacts)),
  }
  const cache = new UpdateStatusCache({
    filePath: options.cacheFile ?? path.join(os.tmpdir(), `plugin-updates-cache-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    ops: { ...ops, now: () => clock.now },
    minIntervalMs: options.minIntervalMs ?? 600_000,
    rowDeadlineMs: options.rowDeadlineMs ?? 2_000,
    batchDeadlineMs: options.batchDeadlineMs ?? 5_000,
  })
  const linkedMap = options.linked ?? new Map<string, LinkedCheckoutInfo>()
  const linked: LinkedCheckoutOps = {
    detect: vi.fn(async () => null),
    list: vi.fn(async () => linkedMap),
    check: vi.fn(async () => status()),
    update: vi.fn(async () => ({ sha: SHA_B, fromSha: SHA_A, updated: true })),
  }
  const app = express()
  app.use('/api/plugin-updates', createPluginUpdatesRouter({
    cache,
    linked,
    listSources: async () => options.sources ?? [],
    installedIds: () => options.installedIds ?? [...linkedMap.keys(), ...(options.sources ?? []).flatMap((s) => s.plugins.map((p) => p.id!))],
    ...(options.cloudMode ? { cloudMode: true } : {}),
  }))
  const get = async (query = '') => {
    const response = await request(app).get(`/api/plugin-updates${query}`)
    return { status: response.status, body: response.body as PluginUpdatesResponse }
  }
  const settle = async () => {
    for (let i = 0; i < 200 && cache.refreshing; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return { app, cache, ops, clock, get, settle }
}

describe('GET /api/plugin-updates', () => {
  it('answers from the cache without waiting on a row that never resolves (C4)', async () => {
    const checkout = await checkoutDir()
    const h = harness({
      linked: new Map([['sample', info(checkout)]]),
      sources: [source('acme-plugins')],
      checkLinked: () => new Promise<LinkedCheckoutStatus>(() => undefined),
      checkSource: () => new Promise(() => undefined),
      rowDeadlineMs: 60_000,
      batchDeadlineMs: 60_000,
    })

    const started = Date.now()
    const { status: code, body } = await h.get()

    expect(code).toBe(200)
    expect(Date.now() - started).toBeLessThan(500)
    // The list is not blank: every row is there, honestly unchecked, and the batch runs on.
    expect(body.rows[linkedRowKey(checkout)]?.state).toEqual({ kind: 'unchecked' })
    expect(body.rows[sourceRowKey('acme-plugins')]?.state).toEqual({ kind: 'unchecked' })
    expect(body.rowKeyOf).toEqual({ sample: linkedRowKey(checkout), 'acme-plugins-plugin': sourceRowKey('acme-plugins') })
    expect(body.refreshing).toBe(true)
    expect(body.checkedAt).toBeNull()
  })

  it('serves stale rows with refreshing:true, then the next read has the new rows (C43)', async () => {
    const checkout = await checkoutDir()
    const key = linkedRowKey(checkout)
    // `remote` is what a fetch would find; `fetched` is what the local rev-list can count,
    // which only moves once a fetch has actually brought the commits down.
    let remote = 0
    let fetched = 0
    const h = harness({
      linked: new Map([['sample', info(checkout)]]),
      checkLinked: async () => { fetched = remote; return status({ behind: remote }) },
      readLocalFacts: async () => ({ ...quietFacts, behind: fetched }),
    })
    // First batch at T0 sees "current"; then ten minutes pass and the remote gains 3 commits.
    await h.get()
    await h.settle()
    expect(h.ops.checkLinked).toHaveBeenCalledTimes(1)
    remote = 3
    h.clock.now = T0 + 601_000

    const stale = await h.get()
    expect(stale.body.refreshing).toBe(true)
    // Old rows, not blanks: the client keeps rendering these while it polls.
    expect(stale.body.rows[key]!.state).toEqual({ kind: 'current' })
    expect(stale.body.rows[key]!.checkedAt).toBe(new Date(T0).toISOString())

    await h.settle()
    const fresh = await h.get()
    expect(fresh.body.refreshing).toBe(false)
    expect(fresh.body.rows[key]!.state).toEqual({ kind: 'available', behind: 3 })
    expect(fresh.body.rows[key]!.checkedAt).toBe(new Date(T0 + 601_000).toISOString())
    expect(fresh.body.checkedAt).toBe(new Date(T0 + 601_000).toISOString())
    expect(h.ops.checkLinked).toHaveBeenCalledTimes(2)
  })

  it('never lists a builtin or example plugin (C2 server side)', async () => {
    const checkout = await checkoutDir()
    const h = harness({
      linked: new Map([['sample', info(checkout)]]),
      sources: [source('acme-plugins')],
      // The store's installed list, builtins excluded, is what the route is handed.
      installedIds: ['sample', 'acme-plugins-plugin'],
    })

    const { body } = await h.get()
    await h.settle()

    expect(Object.keys(body.rows).sort()).toEqual([linkedRowKey(checkout), sourceRowKey('acme-plugins')].sort())
    expect(Object.keys(body.rowKeyOf)).not.toContain('calendar')
    expect(Object.keys(body.rowKeyOf)).not.toContain('mail')
  })

  it('does not fetch again inside the minimum interval (C6)', async () => {
    const checkout = await checkoutDir()
    const h = harness({ linked: new Map([['sample', info(checkout)]]), sources: [source('acme-plugins')] })
    await h.get()
    await h.settle()
    expect(h.ops.checkLinked).toHaveBeenCalledTimes(1)
    expect(h.ops.checkSource).toHaveBeenCalledTimes(1)

    h.clock.now = T0 + 300_000
    const { body } = await h.get()
    await h.get()
    await h.settle()

    expect(body.refreshing).toBe(false)
    expect(h.ops.checkLinked).toHaveBeenCalledTimes(1)
    expect(h.ops.checkSource).toHaveBeenCalledTimes(1)
  })

  it('?refresh=1 forces a batch past the interval, answers 202, and a second click joins the first (C7)', async () => {
    const checkout = await checkoutDir()
    let release: (() => void) | undefined
    let hold = true
    const h = harness({
      linked: new Map([['sample', info(checkout)]]),
      checkLinked: () => hold
        ? new Promise<LinkedCheckoutStatus>((resolve) => { release = () => { hold = false; resolve(status()) } })
        : Promise.resolve(status()),
    })

    const first = await h.get('?refresh=1')
    const second = await h.get('?refresh=1')
    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(first.body.refreshing).toBe(true)
    expect(second.body.refreshing).toBe(true)
    // The rows ride along on a 202, so the client has something to render while it polls.
    expect(second.body.rows[linkedRowKey(checkout)]?.state).toEqual({ kind: 'unchecked' })
    expect(h.ops.checkLinked).toHaveBeenCalledTimes(1)

    release!()
    await h.settle()
    // Fresh now, and Check now still bypasses the interval: one more fetch, still 202.
    const third = await h.get('?refresh=1')
    expect(third.status).toBe(202)
    await h.settle()
    expect(h.ops.checkLinked).toHaveBeenCalledTimes(2)
    const plain = await h.get()
    expect(plain.status).toBe(200)
    expect(plain.body.refreshing).toBe(false)
  })

  it('keys sibling linked plugins by the realpath of their checkout: one fetch, one row (C44)', async () => {
    const checkout = await checkoutDir()
    // A second spelling of the same directory through a symlink.
    const alias = path.join(path.dirname(checkout), `${path.basename(checkout)}-alias`)
    await fsp.symlink(checkout, alias)
    tempDirs.push(alias)
    const h = harness({
      linked: new Map([
        ['tracker', info(checkout, { path: path.join(checkout, 'tracker') })],
        ['notes-sync', info(alias, { path: path.join(alias, 'notes-sync') })],
      ]),
    })

    const { body } = await h.get()
    await h.settle()

    const key = linkedRowKey(checkout)
    expect(body.rowKeyOf).toEqual({ tracker: key, 'notes-sync': key })
    expect(Object.keys(body.rows)).toEqual([key])
    expect(h.ops.checkLinked).toHaveBeenCalledTimes(1)
  })

  it('reports a source that is not cloned here as missing, never unreachable (C47)', async () => {
    const h = harness({
      sources: [source('acme-plugins', { cloned: false, plugins: [] })],
      installedIds: [],
      checkSource: async () => ({ behind: 0, updateAvailable: false, error: 'fatal: Could not resolve hostname example.invalid' }),
    })

    await h.get()
    await h.settle()
    const { body } = await h.get()

    expect(body.rows[sourceRowKey('acme-plugins')]!.state).toEqual({ kind: 'missing' })
  })

  it('a clone that disappears AFTER a good check is missing, not the remembered current; its last plugins keep their row key (N2-3)', async () => {
    // Same harness, two listings: first the source is on disk and checks out current, then
    // its directory is gone. The cache still holds the memo `current` for that row key.
    const listed: PluginSourceView[] = [source('acme-plugins')]
    const clock = { now: T0 }
    const ops = {
      checkLinked: vi.fn(async () => status()),
      checkSource: vi.fn(async () => ({ behind: 0, updateAvailable: false, sha: SHA_A, upstreamSha: SHA_A })),
      readLocalFacts: vi.fn(async () => quietFacts),
    }
    const cache = new UpdateStatusCache({
      filePath: path.join(os.tmpdir(), `plugin-updates-cache-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      ops: { ...ops, now: () => clock.now },
      minIntervalMs: 600_000,
      rowDeadlineMs: 2_000,
      batchDeadlineMs: 5_000,
    })
    const app = express()
    app.use('/api/plugin-updates', createPluginUpdatesRouter({
      cache,
      linked: { detect: vi.fn(async () => null), list: vi.fn(async () => new Map()), check: vi.fn(), update: vi.fn() } as unknown as LinkedCheckoutOps,
      listSources: async () => listed,
      installedIds: () => ['acme-plugins-plugin'],
      sourceDir: () => '/nowhere/acme-plugins',
    }))
    const get = async () => (await request(app).get('/api/plugin-updates')).body as PluginUpdatesResponse
    await get()
    for (let i = 0; i < 200 && cache.refreshing; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await get()).rows[sourceRowKey('acme-plugins')]!.state.kind).toBe('current')

    // The user deletes the clone. The plugin is still loaded from memory, so the store lists
    // it; the source can no longer be scanned and remembers what it carried.
    listed[0] = source('acme-plugins', {
      cloned: false,
      plugins: [],
      lastKnownPlugins: [{ id: 'acme-plugins-plugin', name: 'acme-plugins' }],
    })
    const body = await get()
    expect(body.rows[sourceRowKey('acme-plugins')]!.state).toEqual({ kind: 'missing' })
    expect(body.rowKeyOf['acme-plugins-plugin']).toBe(sourceRowKey('acme-plugins'))
    // Nothing to fetch for a directory that is not there.
    expect(ops.checkSource).toHaveBeenCalledTimes(1)
  })

  it('writes a hung row off at its deadline while the others land, keeping what it last knew (C5)', async () => {
    const checkout = await checkoutDir()
    const key = linkedRowKey(checkout)
    let hang = false
    const h = harness({
      linked: new Map([['sample', info(checkout)]]),
      sources: [source('acme-plugins')],
      checkLinked: () => hang ? new Promise<LinkedCheckoutStatus>(() => undefined) : Promise.resolve(status({ behind: 2 })),
      readLocalFacts: async () => ({ ...quietFacts, behind: 2 }),
      rowDeadlineMs: 150,
      batchDeadlineMs: 400,
    })
    // A first batch teaches the row "2 behind"; then the remote stops answering.
    await h.get()
    await h.settle()
    hang = true
    h.clock.now = T0 + 601_000

    const started = Date.now()
    await h.get()
    await h.settle()
    expect(Date.now() - started).toBeLessThan(2_000)

    const { body } = await h.get()
    expect(body.rows[key]!.state).toMatchObject({ kind: 'unreachable', cause: 'timeout', lastKnown: 'available' })
    expect(body.rows[sourceRowKey('acme-plugins')]!.state).toEqual({ kind: 'current' })
    expect(body.attempted).toBe(2)
    expect(body.failed).toBe(1)
    expect(body.allNetworkFailed).toBe(false)
  })

  it('on a replica answers linked rows unsupported with the Mac note and never fetches; sources as usual (C29)', async () => {
    const h = harness({
      cloudMode: true,
      linked: new Map([['sample', info('/home/dev/acme-plugins')], ['sibling', info('/home/dev/acme-plugins')]]),
      sources: [source('acme-plugins')],
    })

    const { status: code, body } = await h.get()
    await h.settle()

    expect(code).toBe(200)
    const key = body.rowKeyOf.sample!
    expect(key).toMatch(/^linked:/)
    expect(body.rowKeyOf.sibling).toBe(key)
    expect(body.rows[key]).toEqual({
      state: { kind: 'unsupported', reason: CLOUD_LINKED_NOTE, hint: '' },
      checkedAt: null,
      target: { kind: 'linked' },
    })
    expect(h.ops.checkLinked).not.toHaveBeenCalled()
    expect(h.ops.checkSource).toHaveBeenCalledTimes(1)
    expect(body.rows[sourceRowKey('acme-plugins')]).toBeDefined()
  })

  it('fetches with the unattended git environment (C51)', async () => {
    const checkout = await checkoutDir()
    const h = harness({ linked: new Map([['sample', info(checkout)]]) })

    await h.get()
    await h.settle()

    const [, env] = h.ops.checkLinked.mock.calls[0] as [LinkedCheckoutInfo, NodeJS.ProcessEnv]
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_ASKPASS).toBe('/usr/bin/true')
    expect(env.GIT_SSH_COMMAND).toBe(process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes')
  })

  it('says allNetworkFailed only when every attempted row failed with cause network (C49 server side)', async () => {
    const checkout = await checkoutDir()
    const h = harness({
      linked: new Map([['sample', info(checkout)]]),
      sources: [source('acme-plugins')],
      checkLinked: async () => status({ fetched: false, reason: 'fatal: Could not resolve hostname example.invalid' }),
      checkSource: async () => ({ behind: 0, updateAvailable: false, error: 'fatal: unable to access: Could not resolve host: example.invalid' }),
    })

    await h.get()
    await h.settle()
    const { body } = await h.get()

    expect(body.attempted).toBe(2)
    expect(body.failed).toBe(2)
    expect(body.allNetworkFailed).toBe(true)
    expect(body.rows[linkedRowKey(checkout)]!.state).toMatchObject({ kind: 'unreachable', cause: 'network' })
    expect(body.rows[sourceRowKey('acme-plugins')]!.state).toMatchObject({ kind: 'unreachable', cause: 'network' })
  })

  it('still answers 200 with what it has when the sources file or the linked scan fails', async () => {
    const checkout = await checkoutDir()
    const h = harness({ linked: new Map([['sample', info(checkout)]]) })
    const app = express()
    app.use('/api/plugin-updates', createPluginUpdatesRouter({
      cache: h.cache,
      linked: { detect: async () => null, list: async () => { throw new Error('git is not available') }, check: async () => status(), update: async () => ({ sha: SHA_B, fromSha: SHA_A, updated: true }) },
      listSources: async () => { throw new Error('sources file unreadable') },
      installedIds: () => ['sample'],
    }))

    const response = await request(app).get('/api/plugin-updates').expect(200)

    expect(response.body.rows).toEqual({})
    expect(response.body.rowKeyOf).toEqual({})
    expect(response.body.minIntervalMs).toBe(600_000)
  })

  it('answers the previous rows from the cache file after a restart (C24)', async () => {
    const checkout = await checkoutDir()
    const key = linkedRowKey(checkout)
    const cacheFile = path.join(await checkoutDir('cache'), 'plugin-updates-cache.json')
    const first = harness({ linked: new Map([['sample', info(checkout)]]), cacheFile, checkLinked: async () => status({ behind: 3 }), readLocalFacts: async () => ({ ...quietFacts, behind: 3 }) })
    await first.get()
    await first.settle()
    expect(first.ops.checkLinked).toHaveBeenCalledTimes(1)

    // A new process: new cache object over the same file, loaded before the first request.
    const second = harness({ linked: new Map([['sample', info(checkout)]]), cacheFile, readLocalFacts: async () => ({ ...quietFacts, behind: 3 }) })
    await second.cache.load()
    const { body } = await second.get()

    expect(body.rows[key]!.state).toEqual({ kind: 'available', behind: 3 })
    expect(body.rows[key]!.checkedAt).toBe(new Date(T0).toISOString())
    expect(body.checkedAt).toBe(new Date(T0).toISOString())
    // Fresh from the file, so no fetch was needed to say so.
    expect(body.refreshing).toBe(false)
    expect(second.ops.checkLinked).not.toHaveBeenCalled()
  })
})
