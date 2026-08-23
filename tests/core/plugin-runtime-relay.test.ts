import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('plugin-runtime-relay-test'))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config-manager.js')>()
  return {
    ...actual,
    getConfig: vi.fn(async () => ({
      version: 1,
      user: { name: 'test' },
      defaults: { priority: 'none' },
      provider: { type: 'bedrock' },
      plugins: {},
    })),
    updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import {
  clearPluginQuarantine,
  disableLoadedPlugin,
  disposeLoadedPlugins,
  getPluginLifecycleRecords,
  loadPlugins,
  reloadLoadedPlugin,
} from '../../src/core/integration-loader.js'
import { registry } from '../../src/core/integration-registry.js'
import { setPluginApiBase } from '../../src/core/plugins/server-api.js'
import { handleSessionControlRelay } from '../../src/core/sessions/session-controls.js'
import { createPluginRouteDispatcher } from '../../src/web/plugin-route-dispatcher.js'
import { createPluginRuntimeRouter } from '../../src/web/routes/plugin-runtime.js'

const pluginRoot = path.join(WALNUT_HOME, 'plugins', 'sample')
const source = 'export const relayed = true\n'
const sourceHash = crypto.createHash('sha256').update(source).digest('hex')
let server: Server | null = null

beforeEach(async () => {
  await disposeLoadedPlugins(registry).catch(() => undefined)
  registry.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.join(pluginRoot, 'dist'), { recursive: true })
  await fs.writeFile(path.join(pluginRoot, 'manifest.json'), JSON.stringify({
    id: 'sample',
    name: 'Sample',
    version: '1.2.3',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    web: 'dist/web.mjs',
  }))
  await fs.writeFile(path.join(pluginRoot, 'dist', 'web.mjs'), source)
  await fs.writeFile(path.join(pluginRoot, 'dist', 'server.mjs'), `
export async function activate(walnut) {
  walnut.http.route('post', '/echo', async (request) => ({
    status: 201,
    headers: { 'content-type': 'application/json', 'x-plugin': 'sample' },
    json: {
      text: await request.text(),
      path: request.path,
      signature: request.headers['x-signature'] ?? null,
      authorization: request.headers.authorization ?? null,
    },
  }))
}
`)
  await loadPlugins(registry)

  const app = express()
  app.use('/api/plugins', express.raw({ type: '*/*', limit: '3mb' }))
  app.use(express.json())
  app.use('/api/plugin-runtime', createPluginRuntimeRouter({
    registry,
    list: () => getPluginLifecycleRecords(registry),
    reload: (pluginId) => reloadLoadedPlugin(registry, pluginId),
    disable: (pluginId) => disableLoadedPlugin(registry, pluginId),
    clearQuarantine: async (pluginId) => { await clearPluginQuarantine(registry, pluginId) },
    cloudMode: false,
  }))
  app.use('/api/plugins', createPluginRouteDispatcher(registry))
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    listening.once('error', reject)
  })
  const address = server.address() as AddressInfo
  setPluginApiBase(`http://127.0.0.1:${address.port}`)
})

afterEach(async () => {
  setPluginApiBase(undefined)
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
    server = null
  }
  await disposeLoadedPlugins(registry).catch(() => undefined)
  registry.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('primary Plugin runtime control relay', () => {
  it('returns primary lifecycle diagnostics and the module catalogue without bytes', async () => {
    const response = await handleSessionControlRelay(
      'server.plugin-runtime',
      '__server__',
      undefined,
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        modules: [{
          id: 'sample',
          name: 'Sample',
          version: '1.2.3',
          hash: sourceHash,
          size: Buffer.byteLength(source),
        }],
        errors: [],
        plugins: expect.arrayContaining([{
          id: 'sample',
          name: 'Sample',
          state: 'active',
          builtin: false,
          failureCount: 0,
        }]),
        tombstones: [],
      },
    })
  })

  it('returns exact base64 bytes only for the requested active build', async () => {
    const response = await handleSessionControlRelay(
      'server.plugin-web-module',
      '__server__',
      { pluginId: 'sample', expectedHash: sourceHash },
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        id: 'sample',
        name: 'Sample',
        version: '1.2.3',
        hash: sourceHash,
        size: Buffer.byteLength(source),
        data: Buffer.from(source).toString('base64'),
      },
    })
  })

  it('executes cloud Plugin ops on the active primary owner', async () => {
    const listed = await handleSessionControlRelay(
      'server.plugin-ops',
      '__server__',
      { pluginId: 'sample' },
    )
    expect(listed).toMatchObject({
      ok: true,
      result: { ops: expect.arrayContaining([expect.objectContaining({ name: 'task_get', readonly: true })]) },
    })

    const called = await handleSessionControlRelay(
      'server.plugin-op',
      '__server__',
      { pluginId: 'sample', opName: 'not_a_real_op', args: {} },
    )
    expect(called).toEqual({
      ok: true,
      result: { ok: false, message: 'Unknown op: not_a_real_op. Run `walnut tools list` for the catalog.' },
    })
  })

  it('relays Plugin HTTP through the real primary dispatcher with raw body and filtered credentials', async () => {
    const response = await handleSessionControlRelay(
      'server.plugin-http',
      '__server__',
      {
        pluginId: 'sample',
        method: 'POST',
        path: '/echo?source=cloud',
        headers: {
          'content-type': 'text/plain',
          'x-signature': 'signed',
          authorization: 'Bearer replica-secret',
        },
        size: Buffer.byteLength('payload'),
        data: Buffer.from('payload').toString('base64'),
      },
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        status: 201,
        headers: expect.objectContaining({
          'content-type': expect.stringContaining('application/json'),
          'x-plugin': 'sample',
        }),
      },
    })
    if (!response.ok) throw new Error(response.error)
    const decoded = JSON.parse(Buffer.from(String(response.result.data), 'base64').toString('utf8'))
    expect(decoded).toEqual({
      text: 'payload',
      path: '/api/plugins/sample/echo?source=cloud',
      signature: 'signed',
      authorization: null,
    })
  })

  it('rejects relay paths that normalize outside the active Plugin namespace', async () => {
    for (const unsafePath of [
      '/../config',
      '/safe/../../config',
      '/%2e%2e/%2e%2e/config',
      '/%252e%252e/config',
      '/..\\..\\config',
    ]) {
      await expect(handleSessionControlRelay(
        'server.plugin-http',
        '__server__',
        {
          pluginId: 'sample',
          method: 'GET',
          path: unsafePath,
          headers: {},
          size: 0,
          data: '',
        },
      )).resolves.toMatchObject({ ok: false, errorKind: 'bad_request' })
    }
  })

  it('runs lifecycle management on the primary and returns current records', async () => {
    await expect(handleSessionControlRelay(
      'server.plugin-manage',
      '__server__',
      { pluginId: 'sample', operation: 'reload' },
    )).resolves.toMatchObject({ ok: true, result: { plugin: { id: 'sample', state: 'active' } } })

    await expect(handleSessionControlRelay(
      'server.plugin-manage',
      '__server__',
      { pluginId: 'sample', operation: 'clear-quarantine' },
    )).resolves.toEqual({ ok: true, result: { ok: true } })

    await expect(handleSessionControlRelay(
      'server.plugin-manage',
      '__server__',
      { pluginId: 'sample', operation: 'disable' },
    )).resolves.toMatchObject({ ok: true, result: { plugin: { id: 'sample', state: 'disabled' } } })
  })

  it('rejects stale hashes, unsafe ids, oversized bodies, and inactive Plugins precisely', async () => {
    await expect(handleSessionControlRelay(
      'server.plugin-web-module',
      '__server__',
      { pluginId: 'sample', expectedHash: 'a'.repeat(64) },
    )).resolves.toMatchObject({ ok: false, errorKind: 'conflict' })

    await expect(handleSessionControlRelay(
      'server.plugin-web-module',
      '__server__',
      { pluginId: '../escape' },
    )).resolves.toMatchObject({ ok: false, errorKind: 'bad_request' })

    await expect(handleSessionControlRelay(
      'server.plugin-http',
      '__server__',
      {
        pluginId: 'sample',
        method: 'POST',
        path: '/echo',
        headers: {},
        size: 2 * 1024 * 1024 + 1,
        data: '',
      },
    )).resolves.toMatchObject({ ok: false, errorKind: 'payload_too_large' })

    await disableLoadedPlugin(registry, 'sample')
    await expect(handleSessionControlRelay(
      'server.plugin-web-module',
      '__server__',
      { pluginId: 'sample' },
    )).resolves.toMatchObject({ ok: false, errorKind: 'not_found' })
    await expect(handleSessionControlRelay(
      'server.plugin-ops',
      '__server__',
      { pluginId: 'sample' },
    )).resolves.toMatchObject({ ok: false, errorKind: 'not_found' })
  })
})
