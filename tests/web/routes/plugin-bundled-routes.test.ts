/**
 * Install and Remove for the bundled plugin store, as routes.
 *
 * The loader and config writes are injected, so these pin the CONTRACT: Install only
 * accepts an id this build's store folder carries, writes `enabled: true` before it
 * discovers, and takes that write back when nothing loaded; Remove goes through the
 * switch's own OFF (so its dependents gate answers 409 the store already reads), then
 * forgets the record and deletes the config key; the registry labels an installed
 * bundled plugin as such; a replica relays both to the primary.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import { PluginDependentsError } from '../../../src/core/plugins/dependency-gate.js'
import type { PluginLifecycleRecord } from '../../../src/core/plugins/plugin-manager.js'
import { createPluginRuntimeRouter } from '../../../src/web/routes/plugin-runtime.js'
import { PluginRuntimeRelayError } from '../../../src/web/routes/plugin-runtime-bridge.js'

let storeDir: string
let home: string

beforeEach(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'bundled-routes-'))
  storeDir = path.join(base, 'store')
  home = path.join(base, 'home')
  await fsp.mkdir(home, { recursive: true })
  await fsp.mkdir(path.join(storeDir, 'omega', 'dist'), { recursive: true })
  await fsp.writeFile(path.join(storeDir, 'omega', 'manifest.json'), JSON.stringify({
    id: 'omega',
    name: 'Omega',
    description: 'A bundled plugin. Second sentence.',
    version: '1.2.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    catalog: { adds: ['Agent tools'] },
  }))
  await fsp.writeFile(path.join(storeDir, 'omega', 'dist', 'server.mjs'), 'export function activate() {}\n')
})

afterEach(async () => {
  await fsp.rm(path.dirname(storeDir), { recursive: true, force: true })
})

function record(overrides: Partial<PluginLifecycleRecord> = {}): PluginLifecycleRecord {
  return { id: 'omega', name: 'Omega', state: 'active', builtin: false, bundled: true, failureCount: 0, ...overrides }
}

function setup(options: {
  records?: PluginLifecycleRecord[]
  discover?: (pluginId: string) => Promise<PluginLifecycleRecord>
  disable?: (pluginId: string) => Promise<PluginLifecycleRecord>
  cloudMode?: boolean
  managePrimary?: (...args: unknown[]) => Promise<unknown>
} = {}) {
  const records = options.records ?? []
  const config = {
    enable: vi.fn(async () => undefined),
    remove: vi.fn(async () => true),
  }
  const deps = {
    registry: new IntegrationRegistry(),
    list: () => records,
    discover: vi.fn(options.discover ?? (async (pluginId: string) => record({ id: pluginId }))),
    reload: vi.fn(async (pluginId: string) => record({ id: pluginId })),
    disable: vi.fn(options.disable ?? (async (pluginId: string) => record({ id: pluginId, state: 'disabled' }))),
    forgetBundled: vi.fn(async () => true),
    clearQuarantine: vi.fn(async () => undefined),
    pluginSourceOwners: async () => new Map<string, { slug: string; kind: 'git' | 'npm' }>(),
    unconfiguredSchemas: async () => new Map<string, Record<string, unknown> | undefined>(),
    linked: {
      detect: vi.fn(async () => null),
      list: vi.fn(async () => new Map()),
      check: vi.fn(),
      update: vi.fn(),
    },
    walnutHome: home,
    bundledStoreDir: storeDir,
    bundledConfig: config,
    ...(options.cloudMode ? { cloudMode: true } : {}),
    ...(options.managePrimary ? { managePrimary: vi.fn(options.managePrimary) } : {}),
  }
  const app = express()
  app.use(express.json())
  app.use('/api/plugin-runtime', createPluginRuntimeRouter(deps as never))
  return { app, deps, config }
}

describe('POST /bundled/:id/install', () => {
  it('writes enabled: true, then discovers, and answers the record', async () => {
    const order: string[] = []
    const { app, deps, config } = setup({
      discover: async (pluginId) => { order.push('discover'); return record({ id: pluginId }) },
    })
    config.enable.mockImplementation(async () => { order.push('enable') })

    const response = await request(app).post('/api/plugin-runtime/bundled/omega/install').expect(200)

    expect(response.body.plugin).toMatchObject({ id: 'omega', state: 'active', bundled: true })
    expect(order).toEqual(['enable', 'discover'])
    expect(config.enable).toHaveBeenCalledWith('omega')
    expect(deps.discover).toHaveBeenCalledWith('omega')
    expect(config.remove).not.toHaveBeenCalled()
  })

  it('refuses an id the store folder does not carry, without touching config', async () => {
    const { app, deps, config } = setup()

    const response = await request(app).post('/api/plugin-runtime/bundled/nope/install').expect(404)

    expect(response.body.error).toContain('bundled plugin store')
    expect(config.enable).not.toHaveBeenCalled()
    expect(deps.discover).not.toHaveBeenCalled()
  })

  it('rejects an unsafe id as a bad request', async () => {
    const { app, config } = setup()
    await request(app).post('/api/plugin-runtime/bundled/Bad..Id/install').expect(400)
    expect(config.enable).not.toHaveBeenCalled()
  })

  it('takes the config write back when nothing could load it, and says why', async () => {
    // Declared artifact missing: the loader skips the folder, so discovery finds nothing.
    await fsp.rm(path.join(storeDir, 'omega', 'dist'), { recursive: true })
    const { app, config } = setup({
      discover: async (pluginId) => { throw new Error(`Plugin "${pluginId}" was not discovered`) },
    })

    const response = await request(app).post('/api/plugin-runtime/bundled/omega/install').expect(422)

    expect(response.body.error).toContain('dist/server.mjs is missing')
    expect(config.enable).toHaveBeenCalledWith('omega')
    expect(config.remove).toHaveBeenCalledWith('omega')
  })

  it('refuses when the same id already runs from another place', async () => {
    const { app, config } = setup({ records: [record({ bundled: undefined })] })

    const response = await request(app).post('/api/plugin-runtime/bundled/omega/install').expect(409)

    expect(response.body.code).toBe('not-bundled')
    expect(config.enable).not.toHaveBeenCalled()
  })

  it('answers an already-installed one as it is, without rewriting its config', async () => {
    // Switched off: an install must not write `enabled: true` behind a switch that says off.
    const { app, deps, config } = setup({ records: [record({ state: 'disabled' })] })

    const response = await request(app).post('/api/plugin-runtime/bundled/omega/install').expect(200)

    expect(response.body).toMatchObject({ alreadyInstalled: true, plugin: { id: 'omega', state: 'disabled' } })
    expect(config.enable).not.toHaveBeenCalled()
    expect(deps.discover).not.toHaveBeenCalled()
  })

  it('relays to the primary on a replica', async () => {
    const managePrimary = vi.fn(async () => ({ plugin: record() }))
    const { app, config } = setup({ cloudMode: true, managePrimary })

    const response = await request(app).post('/api/plugin-runtime/bundled/omega/install').expect(200)

    expect(managePrimary).toHaveBeenCalledWith('omega', 'bundled-install')
    expect(response.body.plugin.id).toBe('omega')
    // The replica's own config is not the primary's: nothing is written here.
    expect(config.enable).not.toHaveBeenCalled()
  })
})

describe('POST /bundled/:id/remove', () => {
  it('turns it off, forgets it, then deletes its config key', async () => {
    const order: string[] = []
    const { app, deps, config } = setup({
      records: [record()],
      disable: async (pluginId) => { order.push('disable'); return record({ id: pluginId, state: 'disabled' }) },
    })
    deps.forgetBundled.mockImplementation(async () => { order.push('forget'); return true })
    config.remove.mockImplementation(async () => { order.push('config'); return true })

    const response = await request(app).post('/api/plugin-runtime/bundled/omega/remove').expect(200)

    expect(response.body).toMatchObject({ removed: true, plugin: { id: 'omega', state: 'disabled' } })
    expect(order).toEqual(['disable', 'forget', 'config'])
  })

  it('answers 409 has-dependents and changes nothing while another plugin runs on it', async () => {
    const { app, deps, config } = setup({
      records: [record()],
      disable: async (pluginId) => { throw new PluginDependentsError(pluginId, ['beta']) },
    })

    const response = await request(app).post('/api/plugin-runtime/bundled/omega/remove').expect(409)

    expect(response.body).toMatchObject({ code: 'has-dependents', dependents: ['beta'] })
    expect(deps.forgetBundled).not.toHaveBeenCalled()
    expect(config.remove).not.toHaveBeenCalled()
  })

  it('only cleans the config key for a bundled id that was never discovered', async () => {
    const { app, deps, config } = setup({ records: [] })
    config.remove.mockResolvedValue(false)

    const response = await request(app).post('/api/plugin-runtime/bundled/omega/remove').expect(200)

    expect(response.body).toEqual({ removed: false })
    expect(deps.disable).not.toHaveBeenCalled()
    expect(deps.forgetBundled).not.toHaveBeenCalled()
    expect(config.remove).toHaveBeenCalledWith('omega')
  })

  it('refuses a plugin that did not come from the bundled store', async () => {
    const { app, deps, config } = setup({ records: [record({ bundled: undefined })] })

    const response = await request(app).post('/api/plugin-runtime/bundled/omega/remove').expect(409)

    expect(response.body.code).toBe('not-bundled')
    expect(deps.disable).not.toHaveBeenCalled()
    expect(config.remove).not.toHaveBeenCalled()
  })

  it('answers 404 for an id nobody knows', async () => {
    const { app, config } = setup({ records: [] })
    await request(app).post('/api/plugin-runtime/bundled/nope/remove').expect(404)
    expect(config.remove).not.toHaveBeenCalled()
  })

  it('carries a relayed has-dependents refusal to a replica with its list', async () => {
    const managePrimary = vi.fn(async () => {
      throw new PluginRuntimeRelayError('cannot remove', 409, { code: 'has-dependents', dependents: ['beta'] })
    })
    const { app } = setup({ cloudMode: true, managePrimary })

    const response = await request(app).post('/api/plugin-runtime/bundled/omega/remove').expect(409)

    expect(managePrimary).toHaveBeenCalledWith('omega', 'bundled-remove')
    expect(response.body).toMatchObject({ code: 'has-dependents', dependents: ['beta'] })
  })
})

describe('GET /registry with a bundled store', () => {
  it('lists an uninstalled bundled plugin as available, with what the folder says about it', async () => {
    const { app } = setup({ records: [] })

    const response = await request(app).get('/api/plugin-runtime/registry').expect(200)
    const row = response.body.rows.find((candidate: { id: string }) => candidate.id === 'omega')

    expect(row).toMatchObject({
      status: 'available',
      installed: false,
      builtin: false,
      toggleable: false,
      version: '1.2.0',
      adds: ['Agent tools'],
      source: { kind: 'bundled', path: 'plugin-store/omega' },
    })
  })

  it('labels an installed one bundled, so its row can offer Remove', async () => {
    const { app } = setup({ records: [record()] })

    const response = await request(app).get('/api/plugin-runtime/registry').expect(200)
    const row = response.body.rows.find((candidate: { id: string }) => candidate.id === 'omega')

    expect(row).toMatchObject({
      status: 'active',
      installed: true,
      builtin: false,
      toggleable: true,
      source: { kind: 'bundled', path: 'plugin-store/omega' },
    })
    expect(row.sourceSlug).toBeUndefined()
    // Not a link candidate either: no "not checked" update chip for it.
    expect(row.linkedScanSkipped).toBeUndefined()
  })
})
