/**
 * The two linked-checkout routes, and the store row they feed.
 *
 * Git itself is covered by tests/core/plugins/linked-checkout.test.ts against real
 * repositories; here the detection unit is injected, so these tests are about the
 * CONTRACT: what a 404 means, which refusals come back as 409 with a code the store reads,
 * which plugins a successful update is allowed to reload, and what a replica answers.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import {
  LinkedCheckoutError,
  type LinkedCheckoutInfo,
} from '../../../src/core/plugins/linked-checkout.js'
import type { PluginLifecycleRecord } from '../../../src/core/plugins/plugin-manager.js'
import { UpdateStatusCache, type UpdateCheckOps } from '../../../src/core/plugins/update-status-cache.js'
import { linkedRowKey } from '../../../src/core/plugins/update-status.js'
import { createPluginRuntimeRouter, type LinkedCheckoutOps } from '../../../src/web/routes/plugin-runtime.js'

const CHECKOUT = '/tmp/checkouts/plugins-repo'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })))
})

/**
 * A cache with fake ops: the routes only WRITE it (recordCheck / recordUpdated /
 * recordRefusal), so no fetch ever runs from here. Local facts are stubbed so a snapshot
 * never spawns git against a directory that is not a repository.
 */
function cacheFor(filePath?: string, readLocalFacts?: UpdateCheckOps['readLocalFacts']): UpdateStatusCache {
  return new UpdateStatusCache({
    filePath: filePath ?? path.join(os.tmpdir(), `plugin-runtime-linked-cache-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    ops: {
      checkLinked: vi.fn(async () => ({ behind: 0, ahead: 0, dirty: false, sha: 'a'.repeat(40), branch: 'main', fetched: true })),
      checkSource: vi.fn(async () => ({ behind: 0, updateAvailable: false })),
      readLocalFacts: readLocalFacts ?? vi.fn(async () => { throw new Error('not a repository') }),
    },
  })
}

function info(overrides: Partial<LinkedCheckoutInfo> = {}): LinkedCheckoutInfo {
  return {
    path: `${CHECKOUT}/sample`,
    checkout: CHECKOUT,
    branch: 'main',
    sha: 'a'.repeat(40),
    remote: 'https://example.invalid/team/plugins.git',
    dirty: false,
    ...overrides,
  }
}

function record(overrides: Partial<PluginLifecycleRecord> = {}): PluginLifecycleRecord {
  return { id: 'sample', name: 'Sample', state: 'active', builtin: false, failureCount: 0, ...overrides }
}

function setup(options: {
  records?: PluginLifecycleRecord[]
  linked?: Partial<LinkedCheckoutOps>
  cloudMode?: boolean
  cache?: UpdateStatusCache
  updateDeadlineMs?: number
  /** What the primary answers a replica's registry listing with (cloud mode only). */
  primaryPlugins?: PluginLifecycleRecord[]
} = {}) {
  const records = options.records ?? [record()]
  const cache = options.cache ?? cacheFor()
  const linked: LinkedCheckoutOps = {
    detect: vi.fn(async () => info()),
    list: vi.fn(async () => new Map([['sample', info()]])),
    check: vi.fn(async () => ({
      behind: 2, ahead: 0, dirty: false, sha: 'a'.repeat(40), branch: 'main', fetched: true,
    })),
    update: vi.fn(async () => ({ sha: 'b'.repeat(40), fromSha: 'a'.repeat(40), updated: true })),
    ...options.linked,
  }
  const deps = {
    registry: new IntegrationRegistry(),
    list: () => records,
    reload: vi.fn(async (pluginId: string) => record({ id: pluginId })),
    disable: vi.fn(async (pluginId: string) => record({ id: pluginId, state: 'disabled' as const })),
    clearQuarantine: vi.fn(async () => undefined),
    linked,
    // The store list's other two lookups are injected so these tests stay off the plugin
    // sources file and off the loader's import graph.
    pluginSourceOwners: async () => new Map<string, { slug: string; kind: 'git' | 'npm' }>(),
    unconfiguredSchemas: async () => new Map<string, Record<string, unknown> | undefined>(),
    ...(options.cloudMode ? { cloudMode: true } : {}),
    ...(options.primaryPlugins
      ? { listPrimaryModules: async () => ({ plugins: options.primaryPlugins ?? [], tombstones: [], modules: [], errors: [] }) }
      : {}),
    ...(options.updateDeadlineMs ? { updateDeadlineMs: options.updateDeadlineMs } : {}),
    cache,
  }
  const app = express()
  app.use(express.json())
  app.use('/api/plugin-runtime', createPluginRuntimeRouter(deps))
  return { app, deps, linked, cache }
}

describe('linked checkout routes', () => {
  it('answers 404 for a plugin that is not a linked checkout', async () => {
    const { app, linked } = setup({ linked: { detect: vi.fn(async () => null) } })

    const check = await request(app).post('/api/plugin-runtime/sample/linked/check').expect(404)
    const update = await request(app).post('/api/plugin-runtime/sample/linked/update').expect(404)

    expect(check.body.error).toContain('not a linked checkout')
    expect(update.body.error).toContain('not a linked checkout')
    // Nothing was fetched or pulled on the way to that answer.
    expect(linked.check).not.toHaveBeenCalled()
    expect(linked.update).not.toHaveBeenCalled()
  })

  it('reports how far behind the checkout is', async () => {
    const { app } = setup()

    const response = await request(app).post('/api/plugin-runtime/sample/linked/check').expect(200)

    // Every field the old client read is still there, exactly as it was...
    expect(response.body).toMatchObject({
      behind: 2, ahead: 0, dirty: false, sha: 'a'.repeat(40), branch: 'main', fetched: true,
    })
    // ...and the derived state the chip renders rides alongside them.
    expect(response.body.state).toEqual({ kind: 'available', behind: 2 })
    expect(typeof response.body.checkedAt).toBe('string')
    expect(Date.parse(response.body.checkedAt)).not.toBeNaN()
  })

  it('fetches with the unattended environment so no credential prompt can hang the check', async () => {
    const { app, linked } = setup()

    await request(app).post('/api/plugin-runtime/sample/linked/check').expect(200)

    const [, opts] = (linked.check as ReturnType<typeof vi.fn>).mock.calls[0] as [LinkedCheckoutInfo, { env?: NodeJS.ProcessEnv }]
    expect(opts.env?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(opts.env?.GIT_ASKPASS).toBe('/usr/bin/true')
  })

  it('passes a missing upstream through as behind: null with the reason', async () => {
    const { app } = setup({
      linked: {
        check: vi.fn(async () => ({
          behind: null,
          ahead: null,
          dirty: false,
          sha: 'a'.repeat(40),
          branch: 'work',
          fetched: true,
          reason: 'No upstream branch is set for work, so there is nothing to compare against.',
        })),
      },
    })

    const response = await request(app).post('/api/plugin-runtime/sample/linked/check').expect(200)

    // `null` and not `0`: the store must not print "up to date" here.
    expect(response.body.behind).toBeNull()
    expect(response.body.reason).toContain('No upstream branch')
  })

  it('refuses a dirty checkout with a code the store branches on', async () => {
    const { app, deps } = setup({
      linked: {
        update: vi.fn(async () => {
          throw new LinkedCheckoutError('This checkout has uncommitted changes. Commit or stash them, then update.', 'dirty')
        }),
      },
    })

    const refused = await request(app).post('/api/plugin-runtime/sample/linked/update').expect(409)

    expect(refused.body).toEqual({ error: expect.stringContaining('uncommitted changes'), code: 'dirty' })
    // A refused update reloads nothing: the files on disk did not change.
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('refuses a diverged branch with its own code', async () => {
    const { app } = setup({
      linked: {
        update: vi.fn(async () => {
          throw new LinkedCheckoutError('cannot be fast-forwarded: not possible to fast-forward', 'diverged')
        }),
      },
    })

    const refused = await request(app).post('/api/plugin-runtime/sample/linked/update').expect(409)

    expect(refused.body.code).toBe('diverged')
    expect(refused.body.error).toContain('fast-forward')
  })

  it('reloads every running plugin in the same checkout, and only those', async () => {
    // One checkout, four plugins: the target, a sibling that is on, a sibling that is OFF,
    // and one linked out of a different repo.
    const records = [
      record({ id: 'sample' }),
      record({ id: 'sibling' }),
      record({ id: 'switched-off', state: 'disabled' }),
      record({ id: 'elsewhere' }),
    ]
    const { app, deps } = setup({
      records,
      linked: {
        list: vi.fn(async () => new Map([
          ['sample', info()],
          ['sibling', info({ path: `${CHECKOUT}/sibling` })],
          ['switched-off', info({ path: `${CHECKOUT}/switched-off` })],
          ['elsewhere', info({ path: '/tmp/checkouts/other/plugin', checkout: '/tmp/checkouts/other' })],
          ['not-installed', info({ path: `${CHECKOUT}/not-installed` })],
        ])),
      },
    })

    const response = await request(app).post('/api/plugin-runtime/sample/linked/update').expect(200)

    expect(response.body).toMatchObject({
      sha: 'b'.repeat(40),
      fromSha: 'a'.repeat(40),
      updated: true,
      reloaded: ['sample', 'sibling'],
      // Reload writes `enabled: true`, so a plugin the user turned off is named, never
      // switched back on behind their back.
      skipped: ['switched-off'],
    })
    expect(deps.reload.mock.calls.map((call) => call[0])).toEqual(['sample', 'sibling'])
  })

  it('still reports the pull when a reload fails', async () => {
    // New code that throws on activate must not read as "nothing happened": the checkout
    // really did move, and the next thing the user needs is the activation error.
    const { app, deps } = setup()
    deps.reload.mockRejectedValueOnce(new Error('activate threw'))

    const response = await request(app).post('/api/plugin-runtime/sample/linked/update').expect(200)

    expect(response.body.sha).toBe('b'.repeat(40))
    expect(response.body.reloaded).toEqual([])
    expect(response.body.failed).toEqual([{ id: 'sample', error: 'activate threw' }])
  })

  it('tells a replica where the checkout lives instead of pretending to act', async () => {
    const { app, linked } = setup({ cloudMode: true })

    const check = await request(app).post('/api/plugin-runtime/sample/linked/check').expect(501)
    const update = await request(app).post('/api/plugin-runtime/sample/linked/update').expect(501)

    expect(check.body.error).toContain('live on your Mac')
    expect(update.body.error).toContain('live on your Mac')
    expect(linked.detect).not.toHaveBeenCalled()
    expect(linked.update).not.toHaveBeenCalled()
  })

  it('rejects an unsafe plugin id before touching git', async () => {
    const { app, linked } = setup()

    await request(app).post('/api/plugin-runtime/Bad%20Plugin/linked/check').expect(400)

    expect(linked.detect).not.toHaveBeenCalled()
  })

  it('gives the store row a linked source with the checkout, branch and sha', async () => {
    const { app } = setup({
      linked: { list: vi.fn(async () => new Map([['sample', info({ dirty: true })]])) },
    })

    const registry = await request(app).get('/api/plugin-runtime/registry').expect(200)
    const row = registry.body.rows.find((candidate: { id: string }) => candidate.id === 'sample')

    expect(row.source).toEqual({
      kind: 'linked',
      path: `${CHECKOUT}/sample`,
      checkout: CHECKOUT,
      branch: 'main',
      sha: 'a'.repeat(40),
      remote: 'https://example.invalid/team/plugins.git',
      dirty: true,
    })
  })

  it('tells the client which home directory to fold checkout paths to (C21), but not from a replica', async () => {
    const local = await request(setup().app).get('/api/plugin-runtime/registry').expect(200)
    // Realpath'd, so a checkout the scan realpath'd under a symlinked home still matches.
    expect(local.body.homeDir).toBe(await fsp.realpath(os.homedir()))
    expect(path.isAbsolute(local.body.homeDir)).toBe(true)

    const replica = setup({ cloudMode: true, primaryPlugins: [record()] })
    const cloud = await request(replica.app).get('/api/plugin-runtime/registry').expect(200)
    expect(cloud.body.cloud).toBe(true)
    expect(cloud.body).not.toHaveProperty('homeDir')
  })

  it('lists plugins without linked info when the scan cannot run', async () => {
    const { app } = setup({
      linked: { list: vi.fn(async () => { throw new Error('git is not available') }) },
    })

    const registry = await request(app).get('/api/plugin-runtime/registry').expect(200)
    const row = registry.body.rows.find((candidate: { id: string }) => candidate.id === 'sample')

    // Degraded, not 500: the row reads exactly as it did before this feature existed.
    expect(row.source.kind).not.toBe('linked')
    expect(row.installed).toBe(true)
  })

  it('flips the cached row to dirty or diverged on a 409, so the chip says what the server just saw', async () => {
    const dirty = setup({
      linked: { update: vi.fn(async () => { throw new LinkedCheckoutError('uncommitted changes', 'dirty') }) },
    })
    await request(dirty.app).post('/api/plugin-runtime/sample/linked/update').expect(409)
    expect(dirty.cache.entry(linkedRowKey(CHECKOUT))?.state).toEqual({ kind: 'dirty', behind: null })

    const diverged = setup({
      linked: { update: vi.fn(async () => { throw new LinkedCheckoutError('not possible to fast-forward', 'diverged') }) },
    })
    await request(diverged.app).post('/api/plugin-runtime/sample/linked/update').expect(409)
    expect(diverged.cache.entry(linkedRowKey(CHECKOUT))?.state).toMatchObject({ kind: 'diverged' })
  })

  it('a git failure during update answers 502 with one scrubbed sentence, the cause and the raw text as detail (N1)', async () => {
    const raw = "git exited 1: fatal: '/var/folders/zz/T/linked-origin.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\nPlease make sure you have the correct access rights."
    const { app, cache } = setup({ linked: { update: vi.fn(async () => { throw new Error(raw) }) } })

    const response = await request(app).post('/api/plugin-runtime/sample/linked/update').expect(502)

    expect(response.body).toEqual({ error: "'linked-origin.git' does not appear to be a git repository.", cause: 'unknown', detail: raw })
    // The row is the one place that reports this: the response is marked as a handled failure
    // so the request logger does not mint an incident card on top of the row's sentence (N3-1).
    expect(response.headers['x-walnut-handled-failure']).toBe('1')
    expect(response.body.error).not.toMatch(/(^|\s|')\/(Users|home|private|var|tmp|opt)\//)
    expect(response.body.error).not.toMatch(/fatal:|git exited/)
    // Nothing changed, so the chip must not move either.
    expect(cache.entry(linkedRowKey(CHECKOUT))).toBeUndefined()

    const offline = setup({ linked: { update: vi.fn(async () => { throw new Error('git exited 128: ssh: Could not resolve hostname example.invalid: nodename nor servname provided') }) } })
    const network = await request(offline.app).post('/api/plugin-runtime/sample/linked/update').expect(502)
    expect(network.body).toMatchObject({ error: 'the remote could not be reached.', cause: 'network' })
    expect(network.headers['x-walnut-handled-failure']).toBe('1')
    expect(network.body.detail).toContain('example.invalid')
  })

  it('a plugin whose source update replaced its files reads pending-restart in the registry until a restart (N7)', async () => {
    const { markRestartPending, clearRestartPendingForTesting } = await import('../../../src/core/plugins/restart-pending.js')
    const { app } = setup({ records: [record({ id: 'sample' }), record({ id: 'other' })] })
    try {
      markRestartPending(['sample'])
      const registry = await request(app).get('/api/plugin-runtime/registry').expect(200)
      const byId = Object.fromEntries(registry.body.rows.map((row: { id: string; status: string }) => [row.id, row.status]))
      expect(byId.sample).toBe('pending-restart')
      expect(byId.other).toBe('active')
      // The raw state rides too, so the store can tell "still running old code" (switch ON)
      // from a merely discovered plugin (switch OFF).
      const sampleRow = registry.body.rows.find((row: { id: string }) => row.id === 'sample')
      expect(sampleRow.state).toBe('stale-after-update')
    } finally {
      clearRestartPendingForTesting()
    }
  })

  it('a reload or a disable closes the pending-restart gap for that plugin only (N7)', async () => {
    const { markRestartPending, isRestartPending, clearRestartPendingForTesting } = await import('../../../src/core/plugins/restart-pending.js')
    const { app } = setup({ records: [record({ id: 'sample' }), record({ id: 'other' })] })
    try {
      markRestartPending(['sample', 'other'])
      await request(app).post('/api/plugin-runtime/sample/reload').expect(200)
      expect(isRestartPending('sample')).toBe(false)
      expect(isRestartPending('other')).toBe(true)
      await request(app).post('/api/plugin-runtime/other/disable').expect(200)
      expect(isRestartPending('other')).toBe(false)
    } finally {
      clearRestartPendingForTesting()
    }
  })

  it('marks the whole checkout current after an update, so sibling rows flip with it (C44)', async () => {
    // Two plugins, one checkout: the row key is the checkout, so recording once is enough.
    const records = [record({ id: 'sample' }), record({ id: 'sibling' })]
    const { app, cache } = setup({
      records,
      linked: {
        check: vi.fn(async () => ({ behind: 2, ahead: 0, dirty: false, sha: 'a'.repeat(40), branch: 'main', fetched: true })),
        list: vi.fn(async () => new Map([['sample', info()], ['sibling', info({ path: `${CHECKOUT}/sibling` })]])),
      },
    })
    const key = linkedRowKey(CHECKOUT)
    await request(app).post('/api/plugin-runtime/sibling/linked/check').expect(200)
    expect(cache.entry(key)?.state).toEqual({ kind: 'available', behind: 2 })

    const response = await request(app).post('/api/plugin-runtime/sample/linked/update').expect(200)

    expect(response.body).toMatchObject({ sha: 'b'.repeat(40), updated: true, reloaded: ['sample', 'sibling'], state: { kind: 'current' } })
    expect(typeof response.body.checkedAt).toBe('string')
    expect(cache.entry(key)?.state).toEqual({ kind: 'current' })
    expect(cache.entry(key)?.remoteRef).toBe('b'.repeat(40))
  })

  it('answers 504 when the update outlives its deadline, and the row is not marked current', async () => {
    // The deadline is shortened through the deps knob; the message still names the real 60 s.
    const { app, cache } = setup({
      linked: { update: vi.fn(() => new Promise(() => undefined)) },
      updateDeadlineMs: 50,
    })

    const response = await request(app).post('/api/plugin-runtime/sample/linked/update').expect(504)

    expect(response.body.error).toBe('Update timed out after 60 s. The checkout was not changed unless git finished on its own; check again.')
    expect(response.headers['x-walnut-handled-failure'], 'a slow remote is not an endpoint incident (N3-1)').toBe('1')
    expect(cache.entry(linkedRowKey(CHECKOUT))).toBeUndefined()
  })

  it('answers the previous rows from the same cache file after a restart (C24, C45)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plugin-runtime-linked-restart-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'plugin-updates-cache.json')
    const first = setup({
      cache: cacheFor(filePath),
      linked: { check: vi.fn(async () => ({ behind: 2, ahead: 0, dirty: false, sha: 'a'.repeat(40), branch: 'main', fetched: true, upstreamSha: 'c'.repeat(40) })) },
    })
    await request(first.app).post('/api/plugin-runtime/sample/linked/check').expect(200)
    await first.cache.persist()
    // The file holds the network result only: what the fetch saw, when, and nothing derived.
    const persisted = JSON.parse(await fsp.readFile(filePath, 'utf-8')) as { entries: Record<string, Record<string, unknown>> }
    expect(Object.keys(persisted.entries[linkedRowKey(CHECKOUT)]!).sort()).toEqual(['fetchedAt', 'headAtFetch', 'remoteRef'])

    // A new process: a new router over a new cache object that loads the same file. The
    // state is read back from the checkout against the cached upstream, not from the file.
    const facts = vi.fn(async () => ({ dirty: false, head: 'a'.repeat(40), behind: 2, ahead: 0, moved: false }))
    const reloaded = cacheFor(filePath, facts)
    await reloaded.load()
    const second = setup({ cache: reloaded })
    const before = second.cache.entry(linkedRowKey(CHECKOUT))
    expect(typeof before?.fetchedAt).toBe('string')
    expect(before?.remoteRef).toBe('c'.repeat(40))
    const snap = await reloaded.snapshot([{ rowKey: linkedRowKey(CHECKOUT), kind: 'linked', info: info(), pluginIds: ['sample'] }], { autoRefresh: false })
    expect(snap.rows[linkedRowKey(CHECKOUT)]!.state).toEqual({ kind: 'available', behind: 2 })
    expect(snap.rows[linkedRowKey(CHECKOUT)]!.target).toEqual({ kind: 'linked', toRef: 'c'.repeat(7) })
    expect(facts).toHaveBeenCalledWith(CHECKOUT, 'c'.repeat(40), expect.objectContaining({ headAtFetch: 'a'.repeat(40) }))
    // Nothing was fetched to know that.
    expect(second.linked.check).not.toHaveBeenCalled()
  })

  it('flags rows the linked scan never reached instead of silently listing them as not linked (C30)', async () => {
    const records = [record({ id: 'sample' }), record({ id: 'unscanned' }), record({ id: 'builtin-one', builtin: true })]
    const { app } = setup({
      records,
      linked: {
        list: vi.fn(async () => new Map([['sample', info()]])),
        listDetailed: vi.fn(async () => ({ found: new Map([['sample', info()]]), skipped: ['unscanned'] })),
      },
    })

    const registry = await request(app).get('/api/plugin-runtime/registry').expect(200)
    const byId = new Map<string, Record<string, unknown>>(registry.body.rows.map((row: { id: string }) => [row.id, row]))

    expect(byId.get('unscanned')!.linkedScanSkipped).toBe(true)
    // The row the scan DID reach, and a builtin, carry no flag at all.
    expect('linkedScanSkipped' in byId.get('sample')!).toBe(false)
    expect('linkedScanSkipped' in byId.get('builtin-one')!).toBe(false)
    expect(byId.get('sample')!.source).toMatchObject({ kind: 'linked' })
  })
})
