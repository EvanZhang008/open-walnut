/**
 * The in-memory linked listing (src/web/routes/plugin-linked-listing.ts) and the two routes
 * that read it: the Apps registry and the update-status batch.
 *
 * The listing runs git on every linked dev checkout and took 1.3 to 2 s on a machine with
 * four links, on EVERY open of the Apps page. These pin the contract that replaced it: a
 * slow scan never holds a response, the next response carries what the scan found, a
 * finished scan with news tells the page, and a check or update rescans.
 */

import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import type { LinkedCheckoutInfo, LinkedCheckoutListing } from '../../../src/core/plugins/linked-checkout.js'
import type { PluginLifecycleRecord } from '../../../src/core/plugins/plugin-manager.js'
import { UpdateStatusCache } from '../../../src/core/plugins/update-status-cache.js'
import { linkedRowKey } from '../../../src/core/plugins/update-status.js'
import { createLinkedListingCache, type LinkedListingCache } from '../../../src/web/routes/plugin-linked-listing.js'
import { createPluginRuntimeRouter, type LinkedCheckoutOps } from '../../../src/web/routes/plugin-runtime.js'
import { createPluginUpdatesRouter } from '../../../src/web/routes/plugin-updates.js'

const CHECKOUT = '/tmp/checkouts/linked-listing-repo'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function info(overrides: Partial<LinkedCheckoutInfo> = {}): LinkedCheckoutInfo {
  return { path: `${CHECKOUT}/sample`, checkout: CHECKOUT, branch: 'main', sha: SHA_A, dirty: false, ...overrides }
}

function record(overrides: Partial<PluginLifecycleRecord> = {}): PluginLifecycleRecord {
  return { id: 'sample', name: 'Sample', state: 'active', builtin: false, failureCount: 0, ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Linked ops whose listing is driven by the test: each scan takes the next queued answer. */
function scriptedLinked(options: { scanMs?: number } = {}) {
  let current: LinkedCheckoutListing = { found: new Map([['sample', info()]]), skipped: [] }
  const gates: Array<ReturnType<typeof deferred<void>>> = []
  const state = { scansDone: 0 }
  const listDetailed = vi.fn(async () => {
    if (options.scanMs) await sleep(options.scanMs)
    const gate = gates.shift()
    if (gate) await gate.promise
    state.scansDone += 1
    return current
  })
  const linked: LinkedCheckoutOps = {
    detect: vi.fn(async () => info()),
    list: vi.fn(async () => current.found),
    listDetailed,
    check: vi.fn(async () => ({ behind: 0, ahead: 0, dirty: false, sha: SHA_A, branch: 'main', fetched: true })),
    update: vi.fn(async () => {
      current = { found: new Map([['sample', info({ sha: SHA_B })]]), skipped: [] }
      return { sha: SHA_B, fromSha: SHA_A, updated: true }
    }),
  }
  return {
    linked,
    listDetailed,
    state,
    /** The next scan waits until the returned function is called. */
    holdNextScan() {
      const gate = deferred<void>()
      gates.push(gate)
      return () => gate.resolve()
    },
    set(listing: LinkedCheckoutListing) { current = listing },
  }
}

function runtimeApp(linked: LinkedCheckoutOps, linkedListing: LinkedListingCache) {
  const app = express()
  app.use(express.json())
  app.use('/api/plugin-runtime', createPluginRuntimeRouter({
    registry: new IntegrationRegistry(),
    list: () => [record()],
    reload: vi.fn(async (pluginId: string) => record({ id: pluginId })),
    disable: vi.fn(async (pluginId: string) => record({ id: pluginId, state: 'disabled' as const })),
    clearQuarantine: vi.fn(async () => undefined),
    linked,
    linkedListing,
    pluginSourceOwners: async () => new Map(),
    unconfiguredSchemas: async () => new Map(),
  }))
  return app
}

async function sampleRow(app: express.Express) {
  const started = performance.now()
  const response = await request(app).get('/api/plugin-runtime/registry').expect(200)
  const ms = performance.now() - started
  const row = response.body.rows.find((candidate: { id: string }) => candidate.id === 'sample') as Record<string, unknown>
  return { row, ms }
}

/** Let the background scan's continuation (and its onChange) run. */
async function waitFor(check: () => boolean, ms = 15_000) {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await sleep(5)
  expect(check()).toBe(true)
}

describe('linked listing cache behind GET /api/plugin-runtime/registry', () => {
  it('a 1.5 s scan does not hold the first answer; the scan end announces itself and the next answer carries it', async () => {
    const script = scriptedLinked({ scanMs: 1_500 })
    const onChange = vi.fn()
    const app = runtimeApp(script.linked, createLinkedListingCache(script.linked, { onChange }))

    const first = await sampleRow(app)
    // eslint-disable-next-line no-console
    console.log(`[linked-listing] cold registry answered in ${Math.round(first.ms)} ms with a 1500 ms scan in flight`)
    // Answered while the scan was still running (no wall-clock bound: the Mac runs at high load).
    expect(script.state.scansDone).toBe(0)
    // Read exactly as an out-of-budget scan reads: "not scanned", never "not linked".
    expect(first.row.linkedScanSkipped).toBe(true)
    expect(first.row.source).not.toMatchObject({ kind: 'linked' })

    await waitFor(() => onChange.mock.calls.length === 1)
    const second = await sampleRow(app)
    // eslint-disable-next-line no-console
    console.log(`[linked-listing] warm registry answered in ${Math.round(second.ms)} ms`)
    expect(second.row.source).toMatchObject({ kind: 'linked' })
    expect('linkedScanSkipped' in second.row).toBe(false)
    // One scan served both answers.
    expect(script.listDetailed).toHaveBeenCalledTimes(1)
  })

  it('a stale listing answers at once and rescans in the background; only a changed result announces', async () => {
    const script = scriptedLinked()
    const clock = { now: 1_000_000 }
    const onChange = vi.fn()
    const app = runtimeApp(script.linked, createLinkedListingCache(script.linked, { onChange, ttlMs: 30_000, now: () => clock.now }))

    expect((await sampleRow(app)).row.source).toMatchObject({ kind: 'linked' })
    expect(script.listDetailed).toHaveBeenCalledTimes(1)
    // Fast scan inside the grace: nothing was served without it, so nothing to announce.
    expect(onChange).not.toHaveBeenCalled()

    // Within the TTL: no scan at all.
    clock.now += 10_000
    await sampleRow(app)
    expect(script.listDetailed).toHaveBeenCalledTimes(1)

    // Past it, with the same tree: a rescan, no announcement.
    clock.now += 30_000
    await sampleRow(app)
    await waitFor(() => script.listDetailed.mock.calls.length === 2)
    await sleep(20)
    expect(onChange).not.toHaveBeenCalled()

    // Past it again, the checkout moved while the scan is held: the old listing answers now.
    clock.now += 30_000
    script.set({ found: new Map([['sample', info({ sha: SHA_B, dirty: true })]]), skipped: [] })
    const release = script.holdNextScan()
    const stale = await sampleRow(app)
    expect(stale.row.source).toMatchObject({ kind: 'linked', sha: SHA_A, dirty: false })
    release()
    await waitFor(() => onChange.mock.calls.length === 1)
    expect((await sampleRow(app)).row.source).toMatchObject({ kind: 'linked', sha: SHA_B, dirty: true })
  })

  it('a linked check invalidates: the next scan starts at once and its result reaches the registry', async () => {
    const script = scriptedLinked()
    const onChange = vi.fn()
    const listing = createLinkedListingCache(script.linked, { onChange })
    const app = runtimeApp(script.linked, listing)

    await sampleRow(app)
    expect(script.listDetailed).toHaveBeenCalledTimes(1)
    script.set({ found: new Map([['sample', info({ dirty: true })]]), skipped: [] })

    await request(app).post('/api/plugin-runtime/sample/linked/check').expect(200)
    await waitFor(() => script.listDetailed.mock.calls.length === 2)
    await waitFor(() => onChange.mock.calls.length === 1)
    const after = await listing.read()
    expect(after?.found.get('sample')?.dirty).toBe(true)
  })

  it('a linked update rescans after the pull, and that scan names the siblings', async () => {
    const script = scriptedLinked()
    const onChange = vi.fn()
    const listing = createLinkedListingCache(script.linked, { onChange })
    const app = runtimeApp(script.linked, listing)

    await sampleRow(app)
    const update = await request(app).post('/api/plugin-runtime/sample/linked/update').expect(200)
    expect(update.body.sha).toBe(SHA_B)
    // The scan the update waited on ran after the pull.
    expect((await listing.read())?.found.get('sample')?.sha).toBe(SHA_B)
    expect(script.listDetailed).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('createLinkedListingCache', () => {
  it('refresh() after an invalidate mid-scan waits for a scan that started after it', async () => {
    const script = scriptedLinked()
    const listing = createLinkedListingCache(script.linked, { onChange: () => undefined })
    const release = script.holdNextScan()
    expect(await listing.read()).toBeNull()
    // The tree changes while the first scan is still running.
    script.set({ found: new Map([['sample', info({ sha: SHA_B })]]), skipped: [] })
    listing.invalidate()
    const fresh = listing.refresh()
    release()
    expect((await fresh).found.get('sample')?.sha).toBe(SHA_B)
    expect(script.listDetailed).toHaveBeenCalledTimes(2)
  })

  it('a failed scan keeps the last listing and is not retried before the TTL', async () => {
    const clock = { now: 0 }
    let fail = false
    const listDetailed = vi.fn(async (): Promise<LinkedCheckoutListing> => {
      if (fail) throw new Error('git wedged')
      return { found: new Map([['sample', info()]]), skipped: [] }
    })
    const listing = createLinkedListingCache({ ...scriptedLinked().linked, listDetailed }, { now: () => clock.now, ttlMs: 1_000, onChange: () => undefined })
    expect((await listing.read({ graceMs: 100 }))?.found.size).toBe(1)
    fail = true
    clock.now += 2_000
    await listing.read()
    await waitFor(() => listDetailed.mock.calls.length === 2)
    await sleep(10)
    expect((await listing.read())?.found.size).toBe(1)
    expect(listDetailed).toHaveBeenCalledTimes(2)
  })
})

describe('linked listing cache behind GET /api/plugin-updates', () => {
  function updatesApp(linked: LinkedCheckoutOps, linkedListing: LinkedListingCache) {
    const cache = new UpdateStatusCache({
      filePath: path.join(os.tmpdir(), `plugin-linked-listing-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
      ops: {
        checkLinked: vi.fn(async () => ({ behind: 0, ahead: 0, dirty: false, sha: SHA_A, branch: 'main', fetched: true })),
        checkSource: vi.fn(async () => ({ behind: 0, updateAvailable: false })),
        readLocalFacts: vi.fn(async () => { throw new Error('not a repository') }),
      },
    })
    const app = express()
    app.use('/api/plugin-updates', createPluginUpdatesRouter({
      cache,
      linked,
      linkedListing,
      listSources: async () => [],
      installedIds: () => ['sample'],
    }))
    return app
  }

  it('a slow first scan answers refreshing without linked rows; the poll after it has them', async () => {
    const script = scriptedLinked({ scanMs: 1_500 })
    const app = updatesApp(script.linked, createLinkedListingCache(script.linked, { onChange: () => undefined }))

    const first = await request(app).get('/api/plugin-updates').expect(200)
    expect(script.state.scansDone).toBe(0)
    expect(first.body.refreshing).toBe(true)
    expect(first.body.rowKeyOf.sample).toBeUndefined()

    // The client polls while `refreshing`; by then the scan is done.
    await waitFor(() => script.state.scansDone === 1)
    const second = await request(app).get('/api/plugin-updates').expect(200)
    expect(second.body.rowKeyOf.sample).toBe(linkedRowKey(CHECKOUT))
    expect(script.listDetailed).toHaveBeenCalledTimes(1)
  })

  it('Check now (?refresh=1) waits for a fresh listing, so a new link is in its batch', async () => {
    const script = scriptedLinked()
    const app = updatesApp(script.linked, createLinkedListingCache(script.linked, { onChange: () => undefined }))
    await request(app).get('/api/plugin-updates').expect(200)
    expect(script.listDetailed).toHaveBeenCalledTimes(1)
    const refreshed = await request(app).get('/api/plugin-updates?refresh=1').expect(202)
    expect(script.listDetailed).toHaveBeenCalledTimes(2)
    expect(refreshed.body.rowKeyOf.sample).toBe(linkedRowKey(CHECKOUT))
  })
})
