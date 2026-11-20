/**
 * An optional plugin of an installed Plugin Store source (manifest `install: "optional"`),
 * through the routes the Apps page speaks: the registry lists it under its source as not
 * installed, Install writes `enabled: true` and discovers it, Remove takes it back with the
 * bundled Remove's own steps. An `auto` store plugin keeps its old answer: no Remove of its
 * own (its source has one), and Install refuses because it is already there.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import type { PluginCatalogEntry } from '../../../src/core/plugins/plugin-catalog.js'
import type { PluginLifecycleRecord } from '../../../src/core/plugins/plugin-manager.js'
import { createPluginRuntimeRouter } from '../../../src/web/routes/plugin-runtime.js'

let home: string

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'store-optional-routes-'))
})

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true })
})

const MODES: Record<string, 'auto' | 'optional'> = { alpha: 'auto', beta: 'optional' }

const BETA_ENTRY: PluginCatalogEntry = {
  id: 'beta',
  name: 'Beta',
  description: 'An optional plugin.',
  source: { kind: 'git', url: 'file:///repos/team-store' },
  sourceSlug: 'team-store',
  install: 'optional',
}

function record(overrides: Partial<PluginLifecycleRecord> = {}): PluginLifecycleRecord {
  return { id: 'alpha', name: 'Alpha', state: 'active', builtin: false, failureCount: 0, ...overrides }
}

function setup(records: PluginLifecycleRecord[], opts: { fromStore?: boolean } = {}) {
  const config = { enable: vi.fn(async () => undefined), remove: vi.fn(async () => true), forgetKept: vi.fn(async () => undefined) }
  const deps = {
    registry: new IntegrationRegistry(),
    list: () => records,
    discover: vi.fn(async (pluginId: string) => {
      const loaded = record({ id: pluginId, name: pluginId === 'beta' ? 'Beta' : 'Alpha' })
      records.push(loaded)
      return loaded
    }),
    reload: vi.fn(),
    disable: vi.fn(async (pluginId: string) => record({ id: pluginId, state: 'disabled' })),
    forgetBundled: vi.fn(async () => true),
    clearQuarantine: vi.fn(),
    pluginSourceOwners: async () => new Map(records
      .filter((entry) => entry.id in MODES)
      .map((entry) => [entry.id, { slug: 'team-store', kind: 'git' as const, install: MODES[entry.id] }])),
    storePlugin: vi.fn(async (pluginId: string) => (pluginId in MODES ? { slug: 'team-store', install: MODES[pluginId] } : null)),
    loadedFromStore: vi.fn(() => opts.fromStore ?? true),
    storeCatalog: vi.fn(async (loaded: ReadonlySet<string>) => (loaded.has('beta') ? [] : [BETA_ENTRY])),
    unconfiguredSchemas: async () => new Map(),
    linked: { detect: vi.fn(async () => null), list: vi.fn(async () => new Map()), check: vi.fn(), update: vi.fn() },
    walnutHome: home,
    bundledStoreDir: null,
    bundledConfig: config,
  }
  const app = express()
  app.use(express.json())
  app.use('/api/plugin-runtime', createPluginRuntimeRouter(deps as never))
  return { app, deps, config }
}

describe('optional store plugins', () => {
  it('the registry lists an optional plugin nobody installed under its source, and an auto one as installed', async () => {
    const { app } = setup([record()])

    const { body } = await request(app).get('/api/plugin-runtime/registry').expect(200)
    const alpha = body.rows.find((row: { id: string }) => row.id === 'alpha')
    const beta = body.rows.find((row: { id: string }) => row.id === 'beta')

    expect(alpha).toMatchObject({ installed: true, sourceSlug: 'team-store', install: 'auto', toggleable: true })
    expect(beta).toMatchObject({ installed: false, status: 'available', sourceSlug: 'team-store', install: 'optional', catalog: false })
  })

  it('Install writes enabled: true, discovers it, and the registry then reads it installed', async () => {
    const records = [record()]
    const { app, deps, config } = setup(records)

    const response = await request(app).post('/api/plugin-runtime/bundled/beta/install').expect(200)

    expect(response.body.plugin).toMatchObject({ id: 'beta', state: 'active' })
    expect(config.enable).toHaveBeenCalledWith('beta')
    expect(deps.discover).toHaveBeenCalledWith('beta')
    const { body } = await request(app).get('/api/plugin-runtime/registry').expect(200)
    expect(body.rows.find((row: { id: string }) => row.id === 'beta')).toMatchObject({ installed: true, install: 'optional' })
  })

  it('Install of an installed but switched-off optional plugin changes nothing', async () => {
    const { app, config } = setup([record(), record({ id: 'beta', name: 'Beta', state: 'disabled' })])

    const response = await request(app).post('/api/plugin-runtime/bundled/beta/install').expect(200)

    expect(response.body.alreadyInstalled).toBe(true)
    expect(config.enable).not.toHaveBeenCalled()
  })

  it('Remove turns it off, forgets it as a store plugin and deletes its config key', async () => {
    const { app, deps, config } = setup([record(), record({ id: 'beta', name: 'Beta' })])

    const response = await request(app).post('/api/plugin-runtime/bundled/beta/remove').expect(200)

    expect(response.body.removed).toBe(true)
    expect(deps.disable.mock.calls[0]?.[0]).toBe('beta')
    expect(deps.forgetBundled).toHaveBeenCalledWith('beta', { storeOptional: true })
    expect(config.forgetKept).toHaveBeenCalledWith('beta')
    expect(config.remove).toHaveBeenCalledWith('beta')
  })

  it("a linked or plain-folder copy of the same id is the user's own: Remove refuses and touches nothing", async () => {
    const { app, deps, config } = setup([record(), record({ id: 'beta', name: 'Beta' })], { fromStore: false })

    const response = await request(app).post('/api/plugin-runtime/bundled/beta/remove').expect(409)

    expect(response.body.code).toBe('not-bundled')
    expect(deps.disable).not.toHaveBeenCalled()
    expect(deps.forgetBundled).not.toHaveBeenCalled()
    expect(config.remove).not.toHaveBeenCalled()
    expect(config.forgetKept).not.toHaveBeenCalled()
    // Install says the same: another copy runs under that id.
    await request(app).post('/api/plugin-runtime/bundled/beta/install').expect(409)
    expect(config.enable).not.toHaveBeenCalled()
  })

  it('an auto store plugin has no Remove or Install of its own', async () => {
    const { app, deps, config } = setup([record()])

    await request(app).post('/api/plugin-runtime/bundled/alpha/remove').expect(409)
    // Not optional: Install has nothing to offer for it (the same 404 as before install modes).
    await request(app).post('/api/plugin-runtime/bundled/alpha/install').expect(404)

    expect(deps.disable).not.toHaveBeenCalled()
    expect(config.enable).not.toHaveBeenCalled()
    expect(config.remove).not.toHaveBeenCalled()
  })

  it('an id no source carries is still refused', async () => {
    const { app, config } = setup([record()])

    const response = await request(app).post('/api/plugin-runtime/bundled/nope/install').expect(404)

    expect(response.body.error).toContain('optional plugin of an installed source')
    expect(config.enable).not.toHaveBeenCalled()
  })
})
