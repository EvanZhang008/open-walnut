import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import type { PluginLifecycleRecord } from '../../../src/core/plugins/plugin-manager.js'
import { MAX_PLUGIN_WEB_MODULE_BYTES } from '../../../src/core/plugins/plugin-web-module.js'
import { createPluginRuntimeRouter } from '../../../src/web/routes/plugin-runtime.js'
import { PluginRuntimeRelayError } from '../../../src/web/routes/plugin-runtime-bridge.js'
import { createMockPlugin } from '../../core/plugin-test-utils.js'

const temporaryRoots: string[] = []

async function createWebPlugin(
  registry: IntegrationRegistry,
  content = 'export default function activate() {}\n',
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-web-module-'))
  temporaryRoots.push(root)
  const entry = path.join(root, 'dist', 'web.mjs')
  await fs.mkdir(path.dirname(entry), { recursive: true })
  await fs.writeFile(entry, content)
  registry.register('sample', createMockPlugin({
    id: 'sample',
    name: 'Sample',
    version: '1.2.3',
    apiVersion: 1,
    webEntry: 'dist/web.mjs',
    pluginDir: root,
  }))
  return entry
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function record(overrides: Partial<PluginLifecycleRecord> = {}): PluginLifecycleRecord {
  return {
    id: 'sample',
    name: 'Sample',
    state: 'active',
    builtin: false,
    failureCount: 0,
    ...overrides,
  }
}

function setup(overrides: Partial<Parameters<typeof createPluginRuntimeRouter>[0]> = {}) {
  const registry = new IntegrationRegistry()
  const records = [record()]
  const deps = {
    registry,
    list: () => records,
    reload: vi.fn(async (pluginId: string) => record({ id: pluginId })),
    disable: vi.fn(async (pluginId: string) => record({ id: pluginId, state: 'disabled' })),
    clearQuarantine: vi.fn(async () => undefined),
    ...overrides,
  }
  const app = express()
  app.use(express.json())
  app.use('/api/plugin-runtime', createPluginRuntimeRouter(deps))
  return { app, deps, registry, records }
}

describe('plugin runtime routes', () => {
  it('returns lifecycle diagnostics and historical tombstones', async () => {
    const { app, registry } = setup()
    registry.register('old', createMockPlugin({ id: 'old', name: 'Old Plugin' }))
    registry.unregister('old', 'failed')

    const response = await request(app).get('/api/plugin-runtime').expect(200)

    expect(response.body.plugins).toEqual([expect.objectContaining({ id: 'sample', state: 'active' })])
    expect(response.body.tombstones).toEqual([expect.objectContaining({ id: 'old', reason: 'failed' })])
    expect(response.body.modules).toEqual([])
  })

  it('lists and serves active native Web modules with content caching headers', async () => {
    const { app, registry } = setup()
    const source = 'export default function activate() { return "ready" }\n'
    await createWebPlugin(registry, source)

    const catalogue = await request(app).get('/api/plugin-runtime').expect(200)
    expect(catalogue.body.modules).toEqual([
      expect.objectContaining({
        id: 'sample',
        name: 'Sample',
        version: '1.2.3',
        size: Buffer.byteLength(source),
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ])
    expect(catalogue.body.modules[0].url).toContain(`/api/plugin-runtime/sample/web-module?v=${catalogue.body.modules[0].hash}`)

    const moduleResponse = await request(app)
      .get('/api/plugin-runtime/sample/web-module')
      .expect(200)
    expect(moduleResponse.text).toBe(source)
    expect(moduleResponse.headers['content-type']).toContain('text/javascript')
    expect(moduleResponse.headers['x-content-type-options']).toBe('nosniff')
    expect(moduleResponse.headers.etag).toBe(`"${catalogue.body.modules[0].hash}"`)

    await request(app)
      .get('/api/plugin-runtime/sample/web-module')
      .set('If-None-Match', moduleResponse.headers.etag)
      .expect(304)
    await request(app).head('/api/plugin-runtime/sample/web-module').expect(200)
    await request(app).post('/api/plugin-runtime/sample/web-module').expect(405)
  })

  it('changes the build hash when module content changes', async () => {
    const { app, registry } = setup()
    const entry = await createWebPlugin(registry, 'export const version = 1\n')
    const before = (await request(app).get('/api/plugin-runtime').expect(200)).body.modules[0].hash

    await fs.writeFile(entry, 'export const version = 200\n')
    const after = (await request(app).get('/api/plugin-runtime').expect(200)).body.modules[0].hash

    expect(after).not.toBe(before)
  })

  it('never serves inactive, escaped, or oversized modules', async () => {
    const disabled = setup()
    await createWebPlugin(disabled.registry)
    disabled.records[0].state = 'disabled'
    await request(disabled.app).get('/api/plugin-runtime/sample/web-module').expect(404)
    expect((await request(disabled.app).get('/api/plugin-runtime').expect(200)).body.modules).toEqual([])

    const escaped = setup()
    const escapedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-web-escape-'))
    temporaryRoots.push(escapedRoot)
    const outside = path.join(escapedRoot, 'outside.mjs')
    const root = path.join(escapedRoot, 'plugin')
    await fs.mkdir(path.join(root, 'dist'), { recursive: true })
    await fs.writeFile(outside, 'export default 1\n')
    await fs.symlink(outside, path.join(root, 'dist', 'web.mjs'))
    escaped.registry.register('sample', createMockPlugin({
      id: 'sample',
      apiVersion: 1,
      webEntry: 'dist/web.mjs',
      pluginDir: root,
    }))
    await request(escaped.app).get('/api/plugin-runtime/sample/web-module').expect(400)

    const oversized = setup()
    await createWebPlugin(oversized.registry, 'x'.repeat(MAX_PLUGIN_WEB_MODULE_BYTES + 1))
    await request(oversized.app).get('/api/plugin-runtime/sample/web-module').expect(413)
  })

  it('exposes the curated Ops service only to active plugins', async () => {
    const { app, registry, records } = setup()
    await createWebPlugin(registry)

    const listed = await request(app).get('/api/plugin-runtime/sample/ops').expect(200)
    expect(listed.body.ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'task_get', readonly: true }),
    ]))
    const missing = await request(app)
      .post('/api/plugin-runtime/sample/ops/not_a_real_op')
      .send({})
      .expect(200)
    expect(missing.body).toMatchObject({ ok: false })

    records[0].state = 'disabled'
    await request(app).get('/api/plugin-runtime/sample/ops').expect(404)
  })

  it('reloads before returning the current record', async () => {
    const { app, deps } = setup()

    await request(app).post('/api/plugin-runtime/sample/reload').expect(200)

    expect(deps.reload).toHaveBeenCalledWith('sample')
  })

  it('disables and clears quarantine through owner-scoped callbacks', async () => {
    const { app, deps } = setup()

    const disabled = await request(app).post('/api/plugin-runtime/sample/disable').expect(200)
    await request(app).post('/api/plugin-runtime/sample/clear-quarantine').expect(200, { ok: true })

    expect(disabled.body.plugin.state).toBe('disabled')
    expect(deps.disable).toHaveBeenCalledWith('sample')
    expect(deps.clearQuarantine).toHaveBeenCalledWith('sample')
  })

  it('rejects unsafe ids before invoking callbacks', async () => {
    const { app, deps } = setup()

    await request(app).post('/api/plugin-runtime/Bad%20Plugin/disable').expect(400)

    expect(deps.disable).not.toHaveBeenCalled()
  })

  it('relays cloud catalogues and serves the exact content-addressed module', async () => {
    const source = 'export const cloud = true\n'
    const hash = crypto.createHash('sha256').update(source).digest('hex')
    const listPrimaryModules = vi.fn(async () => ({
      plugins: [record({ id: 'sample', name: 'Primary Sample' })],
      tombstones: [{ id: 'old', name: 'Old', reason: 'disabled' as const, at: '2026-08-01T00:00:00.000Z' }],
      modules: [{ id: 'sample', name: 'Sample', version: '2.0.0', hash, size: Buffer.byteLength(source) }],
      errors: [],
    }))
    const readPrimaryModule = vi.fn(async () => ({
      id: 'sample',
      name: 'Sample',
      version: '2.0.0',
      hash,
      size: Buffer.byteLength(source),
      content: Buffer.from(source),
    }))
    const { app } = setup({
      cloudMode: true,
      listPrimaryModules,
      readPrimaryModule,
    })

    const catalogue = await request(app).get('/api/plugin-runtime').expect(200)
    expect(catalogue.body.plugins).toEqual([
      expect.objectContaining({ id: 'sample', name: 'Primary Sample', state: 'active' }),
    ])
    expect(catalogue.body.tombstones).toEqual([
      expect.objectContaining({ id: 'old', reason: 'disabled' }),
    ])
    expect(catalogue.body.modules).toEqual([
      expect.objectContaining({ id: 'sample', hash, version: '2.0.0' }),
    ])
    expect(listPrimaryModules).toHaveBeenCalledOnce()

    const moduleResponse = await request(app)
      .get(`/api/plugin-runtime/sample/web-module?v=${hash}`)
      .expect(200)
    expect(moduleResponse.text).toBe(source)
    expect(moduleResponse.headers.etag).toBe(`"${hash}"`)
    expect(readPrimaryModule).toHaveBeenCalledWith('sample', hash)

    await request(app)
      .get(`/api/plugin-runtime/sample/web-module?v=${hash}`)
      .set('If-None-Match', `"${hash}"`)
      .expect(304)
    await request(app).head(`/api/plugin-runtime/sample/web-module?v=${hash}`).expect(200)
  })

  it('relays cloud Plugin ops and management without consulting the replica registry', async () => {
    const listPrimaryOps = vi.fn(async () => [
      { name: 'task_get', title: 'Get task', readonly: true },
    ])
    const callPrimaryOp = vi.fn(async () => ({ ok: true, result: { title: 'Remote task' } }))
    const managePrimary = vi.fn(async (_pluginId: string, operation: 'reload' | 'disable' | 'clear-quarantine') => {
      if (operation === 'clear-quarantine') return { ok: true as const }
      return { plugin: record({ id: 'sample', state: operation === 'disable' ? 'disabled' : 'active' }) }
    })
    const { app, registry } = setup({
      cloudMode: true,
      listPrimaryOps,
      callPrimaryOp,
      managePrimary,
    })
    expect(registry.get('sample')).toBeUndefined()

    await request(app).get('/api/plugin-runtime/sample/ops').expect(200, {
      ops: [{ name: 'task_get', title: 'Get task', readonly: true }],
    })
    await request(app)
      .post('/api/plugin-runtime/sample/ops/task_get')
      .send({ id: 'abc' })
      .expect(200, { ok: true, result: { title: 'Remote task' } })
    await request(app).post('/api/plugin-runtime/sample/reload').expect(200)
    await request(app).post('/api/plugin-runtime/sample/disable').expect(200)
    await request(app).post('/api/plugin-runtime/sample/clear-quarantine').expect(200, { ok: true })

    expect(listPrimaryOps).toHaveBeenCalledWith('sample')
    expect(callPrimaryOp).toHaveBeenCalledWith('sample', 'task_get', { id: 'abc' })
    expect(managePrimary.mock.calls.map((call) => call[1])).toEqual([
      'reload',
      'disable',
      'clear-quarantine',
    ])
  })

  it('maps cloud relay failures and rejects malformed content addresses', async () => {
    const catalogueFailure = setup({
      cloudMode: true,
      listPrimaryModules: vi.fn(async () => {
        throw new PluginRuntimeRelayError('Primary is offline', 503)
      }),
    })
    await request(catalogueFailure.app).get('/api/plugin-runtime').expect(503, {
      error: 'Primary is offline',
    })

    const moduleFailure = setup({
      cloudMode: true,
      readPrimaryModule: vi.fn(async () => {
        throw new PluginRuntimeRelayError('Primary needs an upgrade', 501)
      }),
    })
    await request(moduleFailure.app)
      .get(`/api/plugin-runtime/sample/web-module?v=${'a'.repeat(64)}`)
      .expect(501, { error: 'Primary needs an upgrade' })
    await request(moduleFailure.app)
      .get('/api/plugin-runtime/sample/web-module?v=not-a-hash')
      .expect(400, { error: 'Invalid Plugin module hash' })
  })
})
