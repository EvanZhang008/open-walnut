/**
 * The plugin op paths run ANY registry op, so they are self-call paths too
 * (src/lib/caller-origin.ts): the console's plugin-runtime route, and the cloud
 * bridge's `server.plugin-op` / `server.plugin-http` relays. Each must act for its
 * real caller, never for this Mac: a paired phone or the bridge cannot read Apple
 * Health through them, a remote host's daemon cannot run a local-only op through
 * them, and a relayed plugin HTTP request reaches the plugin labelled as what it is.
 * A plugin's own route runs for its requester too: an op it calls and a request it
 * sends back to this server are refused for a caller off this Mac.
 */
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-plugin-relay-origin'))
vi.mock('../../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/config-manager.js')>()
  return {
    ...actual,
    getConfig: vi.fn(async () => ({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, provider: { type: 'bedrock' }, plugins: {} })),
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  clearPluginQuarantine, disableLoadedPlugin, disposeLoadedPlugins, getPluginLifecycleRecords, loadPlugins, reloadLoadedPlugin,
} from '../../../src/core/integration-loader.js'
import { registry } from '../../../src/core/integration-registry.js'
import { setPluginApiBase } from '../../../src/core/plugins/server-api.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { createPluginRouteDispatcher } from '../../../src/web/plugin-route-dispatcher.js'
import { createPluginRuntimeRouter } from '../../../src/web/routes/plugin-runtime.js'
import { healthRouter } from '../../../src/web/routes/health.js'
import { HEALTH_LOCAL_ONLY_MESSAGE, LOCAL_ORIGIN, ORIGIN_HEADER, REMOTE_HTTP_ORIGIN, hostOrigin } from '../../../src/lib/caller-origin.js'
import { controlRelayOrigin } from '../../../src/core/sessions/control-host-policy.js'
import { authMiddleware } from '../../../src/web/middleware/auth.js'
import { createDevice } from '../../../src/core/device-auth.js'
import http from 'node:http'
import os from 'node:os'

const pluginRoot = path.join(WALNUT_HOME, 'plugins', 'sample')
let server: Server | null = null
let base = ''

beforeEach(async () => {
  await disposeLoadedPlugins(registry).catch(() => undefined)
  registry.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.join(pluginRoot, 'dist'), { recursive: true })
  await fs.writeFile(path.join(pluginRoot, 'manifest.json'), JSON.stringify({
    id: 'sample', name: 'Sample', version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs',
  }))
  await fs.writeFile(path.join(pluginRoot, 'dist', 'server.mjs'), `
export async function activate(walnut) {
  walnut.http.route('get', '/who', async (request) => ({ status: 200, json: { origin: request.headers['x-walnut-origin'] ?? null } }))
  // A route that reaches Apple Health for its requester, the two ways plugin code can.
  walnut.http.route('get', '/via-op', async () => ({ status: 200, json: await walnut.ops.call('health_status', {}) }))
  walnut.http.route('get', '/via-fetch', async (request) => {
    const r = await walnut.http.fetch(request.query.base + '/api/health/status', { headers: { 'X-Walnut-Origin': '__local__' } })
    return { status: 200, json: { status: r.status } }
  })
}
`)
  await loadPlugins(registry)
  const app = express()
  app.use(express.json())
  app.use('/api/health', healthRouter)
  app.use('/api/plugin-runtime', createPluginRuntimeRouter({
    registry,
    list: () => getPluginLifecycleRecords(registry),
    discover: async (pluginId) => {
      const plugin = getPluginLifecycleRecords(registry).find((record) => record.id === pluginId)
      if (!plugin) throw new Error(`Plugin "${pluginId}" was not discovered`)
      return plugin
    },
    reload: (pluginId) => reloadLoadedPlugin(registry, pluginId),
    disable: (pluginId, opts) => disableLoadedPlugin(registry, pluginId, opts ?? {}),
    clearQuarantine: async (pluginId) => { await clearPluginQuarantine(registry, pluginId) },
    cloudMode: false,
  }))
  app.use('/api/plugins', createPluginRouteDispatcher(registry))
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    listening.once('error', reject)
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  setPluginApiBase(base)
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

const refused = (name: string) => ({ ok: false, message: `${name} refused: ${HEALTH_LOCAL_ONLY_MESSAGE}` })

async function invokeRoute(opName: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(`${base}/api/plugin-runtime/sample/ops/${opName}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
  })
  return res.json()
}

describe('plugin op paths act for their real caller', () => {
  it('the plugin-runtime route runs a health op for this Mac, and refuses it for a self-call made for a remote host', async () => {
    expect(await invokeRoute('health_status')).toMatchObject({ ok: true, result: { connected: false } })
    expect(await invokeRoute('health_status', { [ORIGIN_HEADER]: hostOrigin('remote-dev') })).toEqual(refused('health_status'))
    expect(await invokeRoute('health_status', { [ORIGIN_HEADER]: REMOTE_HTTP_ORIGIN })).toEqual(refused('health_status'))
  })

  it('the bridge\'s plugin-op relay never runs a health op, through either daemon', async () => {
    const viaBridge = await handleSessionControlRelay('server.plugin-op', '__server__', { pluginId: 'sample', opName: 'health_status', args: {} }, controlRelayOrigin('__local__'))
    expect(viaBridge).toEqual({ ok: true, result: refused('health_status') })
    // Even an older caller that passes no origin runs as a client off this Mac.
    const unlabelled = await handleSessionControlRelay('server.plugin-op', '__server__', { pluginId: 'sample', opName: 'health_sleep', args: {} })
    expect(unlabelled).toEqual({ ok: true, result: refused('health_sleep') })
    // A remote host's daemon is lower still: a local-only write is refused as well.
    const viaHost = await handleSessionControlRelay('server.plugin-op', '__server__', { pluginId: 'sample', opName: 'task_delete', args: { id: 'abc123' } }, controlRelayOrigin('remote-dev'))
    expect(viaHost).toMatchObject({ ok: true, result: { ok: false, message: expect.stringMatching(/task_delete is local-only/) } })
  })

  it('a relayed plugin HTTP request is labelled as a client off this Mac, over any header it sent', async () => {
    const relayed = await handleSessionControlRelay('server.plugin-http', '__server__', {
      pluginId: 'sample', method: 'GET', path: '/who', headers: { [ORIGIN_HEADER]: LOCAL_ORIGIN }, size: 0, data: '',
    }, controlRelayOrigin('__local__'))
    if (!relayed.ok) throw new Error(relayed.error)
    const body = JSON.parse(Buffer.from(String(relayed.result.data), 'base64').toString('utf8'))
    expect(body).toEqual({ origin: REMOTE_HTTP_ORIGIN })
  })

  it('a plugin route acts for its requester: its op calls and its requests back to this server', async () => {
    const q = `?base=${encodeURIComponent(base)}`
    const get = async (p: string, headers: Record<string, string> = {}) => (await fetch(`${base}/api/plugins/sample${p}${q}`, { headers })).json()
    // The console on this Mac: both ways work.
    expect(await get('/via-op')).toMatchObject({ ok: true, result: { connected: false } })
    expect(await get('/via-fetch')).toEqual({ status: 200 })
    // A self-call made for a remote host (its `api GET /api/plugins/...`): both refused.
    expect(await get('/via-op', { [ORIGIN_HEADER]: hostOrigin('remote-dev') })).toEqual(refused('health_status'))
    expect(await get('/via-fetch', { [ORIGIN_HEADER]: hostOrigin('remote-dev') })).toEqual({ status: 403 })
    // Relayed from the cloud bridge: refused too, whatever the plugin itself claims.
    for (const [route, want] of [['/via-op', refused('health_status')], ['/via-fetch', { status: 403 }]] as const) {
      const relayed = await handleSessionControlRelay('server.plugin-http', '__server__', {
        pluginId: 'sample', method: 'GET', path: `${route}${q}`, headers: {}, size: 0, data: '',
      }, controlRelayOrigin('__local__'))
      if (!relayed.ok) throw new Error(relayed.error)
      expect(JSON.parse(Buffer.from(String(relayed.result.data), 'base64').toString('utf8')), route).toEqual(want)
    }
  })

  it('a plugin route reads its requester\'s origin in the header too, not what the client sent', async () => {
    const who = async (headers: Record<string, string> = {}) => (await fetch(`${base}/api/plugins/sample/who`, { headers })).json()
    expect(await who()).toEqual({ origin: LOCAL_ORIGIN })
    expect(await who({ [ORIGIN_HEADER]: hostOrigin('remote-dev') })).toEqual({ origin: hostOrigin('remote-dev') })
    // Empty is not local.
    expect(await who({ [ORIGIN_HEADER]: '' })).toEqual({ origin: 'unknown' })
  })
})

/** A private IPv4 address of this machine, when it has one (a laptop on Wi-Fi does). */
function privateIpv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const [p0, p1] = a.address.split('.').map(Number)
      if (p0 === 10 || (p0 === 172 && p1 >= 16 && p1 <= 31) || (p0 === 192 && p1 === 168)) return a.address
    }
  }
  return null
}
const LAN_IP = privateIpv4()

describe.skipIf(!LAN_IP)('a paired device on the LAN that spoofs the origin header', () => {
  it('reaches a plugin route labelled as a client off this Mac, and its op call is refused', async () => {
    const token = (await createDevice('lan-phone')).token
    // Same order as server.ts: the global auth on /api, then the plugin routes.
    const app = express()
    app.use('/api', authMiddleware)
    app.use('/api/plugins', createPluginRouteDispatcher(registry))
    const lan = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, '0.0.0.0', () => resolve(listening))
      listening.once('error', reject)
    })
    try {
      const port = (lan.address() as AddressInfo).port
      const get = (p: string): Promise<unknown> => new Promise((resolve, reject) => {
        const req = http.request({
          host: LAN_IP!, port, path: `/api/plugins/sample${p}`, localAddress: LAN_IP!,
          headers: { authorization: `Bearer ${token}`, [ORIGIN_HEADER]: LOCAL_ORIGIN },
        }, (res) => {
          let text = ''
          res.on('data', (c) => { text += c })
          res.on('end', () => { try { resolve(JSON.parse(text)) } catch { resolve(text) } })
        })
        req.on('error', reject)
        req.end()
      })
      expect(await get('/who')).toEqual({ origin: REMOTE_HTTP_ORIGIN })
      expect(await get('/via-op')).toEqual(refused('health_status'))
    } finally {
      await new Promise<void>((resolve) => lan.close(() => resolve()))
    }
  })
})
