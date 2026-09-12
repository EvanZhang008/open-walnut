/**
 * The two linked-checkout routes, and the store row they feed.
 *
 * Git itself is covered by tests/core/plugins/linked-checkout.test.ts against real
 * repositories; here the detection unit is injected, so these tests are about the
 * CONTRACT: what a 404 means, which refusals come back as 409 with a code the store reads,
 * which plugins a successful update is allowed to reload, and what a replica answers.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import {
  LinkedCheckoutError,
  type LinkedCheckoutInfo,
} from '../../../src/core/plugins/linked-checkout.js'
import type { PluginLifecycleRecord } from '../../../src/core/plugins/plugin-manager.js'
import { createPluginRuntimeRouter, type LinkedCheckoutOps } from '../../../src/web/routes/plugin-runtime.js'

const CHECKOUT = '/tmp/checkouts/plugins-repo'

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
} = {}) {
  const records = options.records ?? [record()]
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
  }
  const app = express()
  app.use(express.json())
  app.use('/api/plugin-runtime', createPluginRuntimeRouter(deps))
  return { app, deps, linked }
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

    expect(response.body).toEqual({
      behind: 2, ahead: 0, dirty: false, sha: 'a'.repeat(40), branch: 'main', fetched: true,
    })
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
})
