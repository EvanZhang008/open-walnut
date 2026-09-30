/**
 * Who may reach Apple Health on the primary.
 *
 * The global /api rule (auth.ts + local-trust.ts) waives a credential for this
 * machine only; every other caller, private networks included, needs a device
 * token or an API key. The phone contract (/api/v1/health/*) is narrower: this
 * machine or a paired DEVICE token, so an API key gets 403 there. The internal
 * reads (/api/health/*) are narrower still: this machine only, so a caller that
 * holds a VALID device token still gets 403 there.
 *
 * "This machine" is the caller's ORIGIN (x-walnut-origin, src/lib/caller-origin.ts),
 * not only its socket: the server calls itself over loopback for callers that are
 * elsewhere, and such a self-call is refused on both health surfaces. POST
 * /api/v1/actions/invoke refuses local-only ops (health, task deletion) to any
 * caller off this Mac, device token or API key.
 *
 * The first block drives the guard with plain request objects; the second one
 * sends real HTTP from this machine's own private IPv4 address (the shape the
 * gate reproduced with curl from the LAN) through the real auth middleware.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-health-access'))

import { requireThisMachine } from '../../../src/web/middleware/health-access.js'
import { createDevice } from '../../../src/core/device-auth.js'
import { authMiddleware } from '../../../src/web/middleware/auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { healthV1Router } from '../../../src/web/routes/health-v1.js'
import { healthRouter } from '../../../src/web/routes/health.js'
import { actionsV1Router } from '../../../src/web/routes/actions-v1.js'
import { HEALTH_LOCAL_ONLY_MESSAGE, ORIGIN_HEADER, LOCAL_ORIGIN, hostOrigin } from '../../../src/lib/caller-origin.js'
import { HEALTH_DEVICE_ONLY_MESSAGE } from '../../../src/web/middleware/health-access.js'
import { rawBatch, watchNight } from '../../core/health/fixtures.js'

type Outcome = { next: boolean; status?: number; body?: any }

function fakeReq(remoteAddress: string, headers: Record<string, string> = {}) {
  return { socket: { remoteAddress, localPort: 3456 }, headers, path: '/status' } as never
}

function run(req: never): Outcome {
  const out: Outcome = { next: false }
  const res = {
    status(code: number) { out.status = code; return res },
    json(body: unknown) { out.body = body; return res },
  }
  requireThisMachine(req, res as never, () => { out.next = true })
  return out
}

let deviceToken = ''
let machineToken = ''
const API_KEY = 'wlnt_sk_health_access_test'

beforeAll(async () => {
  deviceToken = (await createDevice('test-phone')).token
  machineToken = (await createDevice('test-daemon', { kind: 'machine' })).token
  await updateConfig({ api_keys: [{ name: 'script', key: API_KEY, created_at: new Date().toISOString() }] })
})

describe('the internal health reads guard', () => {
  it('passes this machine: a loopback socket with no proxy header and a loopback Host', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(run(fakeReq(addr, { host: 'localhost:3456' }))).toMatchObject({ next: true })
    }
    expect(run(fakeReq('127.0.0.1'))).toMatchObject({ next: true })
    expect(run(fakeReq('127.0.0.1', { host: '127.0.0.1:3456', origin: 'http://localhost:3456' }))).toMatchObject({ next: true })
  })

  it('refuses every other caller with 403, a device token changes nothing', () => {
    const refused = { next: false, status: 403, body: { error: 'forbidden' } }
    expect(run(fakeReq('10.0.0.2'))).toMatchObject(refused)
    expect(run(fakeReq('192.168.1.20', { authorization: `Bearer ${deviceToken}` }))).toMatchObject(refused)
    // A local proxy or tunnel forwarding someone else's request.
    expect(run(fakeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }))).toMatchObject(refused)
    expect(run(fakeReq('127.0.0.1', { forwarded: 'for=203.0.113.9' }))).toMatchObject(refused)
    expect(run(fakeReq('127.0.0.1', { 'x-real-ip': '203.0.113.9' }))).toMatchObject(refused)
    // A DNS-rebound name, and a page from another site driving this machine's browser.
    expect(run(fakeReq('127.0.0.1', { host: 'rebind.example:3456' }))).toMatchObject(refused)
    expect(run(fakeReq('127.0.0.1', { host: 'localhost:3456', origin: 'https://site.example' }))).toMatchObject(refused)
  })

  it('refuses a loopback self-call made for a caller off this Mac, and says only the rule', () => {
    const onBehalf = run(fakeReq('127.0.0.1', { host: '127.0.0.1:3456', [ORIGIN_HEADER]: hostOrigin('remote-dev') }))
    expect(onBehalf).toMatchObject({ next: false, status: 403, body: { error: 'forbidden', message: HEALTH_LOCAL_ONLY_MESSAGE } })
    expect(run(fakeReq('127.0.0.1', { [ORIGIN_HEADER]: 'remote-http' }))).toMatchObject({ status: 403 })
    expect(run(fakeReq('127.0.0.1', { [ORIGIN_HEADER]: '' }))).toMatchObject({ status: 403 })
    expect(run(fakeReq('127.0.0.1', { [ORIGIN_HEADER]: LOCAL_ORIGIN }))).toMatchObject({ next: true })
    // A header cannot raise trust: from the LAN, claiming to be local changes nothing.
    expect(run(fakeReq('192.168.1.20', { authorization: `Bearer ${deviceToken}`, [ORIGIN_HEADER]: LOCAL_ORIGIN }))).toMatchObject({ status: 403 })
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

describe.skipIf(!LAN_IP)('health over real HTTP from a LAN address', () => {
  let server: http.Server
  let port = 0

  beforeAll(async () => {
    // Same order as server.ts: the global auth on /api, then the routers.
    const app = express()
    app.use(express.json())
    app.use('/api', authMiddleware)
    app.use('/api/v1', healthV1Router)
    app.use('/api/v1', actionsV1Router)
    app.use('/api/health', healthRouter)
    app.get('/api/tasks-probe', (_req, res) => { res.json({ ok: true }) })
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => _resetAuthRateLimitForTesting())

  function send(method: string, from: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const all = payload === undefined ? headers : { ...headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
      const req = http.request({ host: from, port, path, method, headers: all, localAddress: from }, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => {
          let parsed: unknown = text
          try { parsed = JSON.parse(text) } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  function get(from: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: from, port, path, headers, localAddress: from }, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => {
          let body: unknown = text
          try { body = JSON.parse(text) } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body })
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  it('control: from the LAN address, even an ordinary route needs a token', async () => {
    expect(await get(LAN_IP!, '/api/tasks-probe')).toMatchObject({ status: 401, body: { code: 'not_paired' } })
    expect((await get(LAN_IP!, '/api/tasks-probe', bearer(deviceToken))).status).toBe(200)
  })

  it('the phone contract: 401 without a token or with a daemon token, 200 with a device token', async () => {
    expect(await get(LAN_IP!, '/api/v1/health/status')).toMatchObject({ status: 401, body: { code: 'not_paired' } })
    expect(await get(LAN_IP!, '/api/v1/health/status', bearer(machineToken))).toMatchObject({ status: 401, body: { code: 'token_refused' } })
    expect((await get(LAN_IP!, '/api/v1/health/status', bearer(deviceToken))).status).toBe(200)
  })

  it('the phone contract takes a device token only: an API key is refused on all four routes', async () => {
    const batch = rawBatch('sleep', watchNight('2026-09-20', '2026-09-21'))
    const routes: Array<[string, string, unknown?]> = [
      ['POST', '/api/v1/health/sync', batch],
      ['GET', '/api/v1/health/status'],
      ['PUT', '/api/v1/health/settings', { paused: true }],
      ['DELETE', '/api/v1/health/data', {}],
    ]
    for (const [method, path, body] of routes) {
      const r = await send(method, LAN_IP!, path, bearer(API_KEY), body)
      expect(r, `${method} ${path}`).toMatchObject({ status: 403, body: { error: { code: 'forbidden', message: HEALTH_DEVICE_ONLY_MESSAGE } } })
      // A daemon machine token never gets that far: auth refuses it everywhere.
      expect((await send(method, LAN_IP!, path, bearer(machineToken), body)).status, `${method} ${path} machine`).toBe(401)
      // Claiming to be local does not help an API key.
      expect((await send(method, LAN_IP!, path, { ...bearer(API_KEY), [ORIGIN_HEADER]: LOCAL_ORIGIN }, body)).status).toBe(403)
    }
    // Nothing moved: the store is not paused and holds no rows from those calls.
    const after = await get('127.0.0.1', '/api/v1/health/status')
    expect(after.status).toBe(200)
    expect(after.body.paused ?? false).toBe(false)
    expect(after.body.lastUploadAt ?? null).toBeNull()

    // The paired phone's device token reaches every route.
    for (const [method, path, body] of routes) {
      expect((await send(method, LAN_IP!, path, bearer(deviceToken), body)).status, `${method} ${path} device`).toBe(200)
    }
    // Leave the store running for the tests that follow (the delete paused it).
    expect((await send('PUT', '127.0.0.1', '/api/v1/health/settings', {}, { paused: false })).status).toBe(200)
  })

  it('the internal reads: 403 from the LAN even with a valid device token', async () => {
    for (const path of ['/api/health/status', '/api/health/sleep?from=2026-09-20&to=2026-09-21', '/api/health/daily', '/api/health/series?metric=heart_rate']) {
      expect(await get(LAN_IP!, path, bearer(deviceToken)), path).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    }
    // A token holder behind a local proxy is not this machine either.
    expect((await get('127.0.0.1', '/api/health/status', { ...bearer(deviceToken), 'x-forwarded-for': LAN_IP! })).status).toBe(403)
  })

  it('this machine reads both, with no token', async () => {
    expect((await get('127.0.0.1', '/api/health/status')).status).toBe(200)
    expect((await get('127.0.0.1', '/api/v1/health/status')).status).toBe(200)
  })

  it('a loopback self-call for a remote host reaches neither surface: read, settings and delete all refused', async () => {
    const behalf = { [ORIGIN_HEADER]: hostOrigin('remote-dev') }
    expect(await get('127.0.0.1', '/api/health/status', behalf)).toMatchObject({ status: 403, body: { message: HEALTH_LOCAL_ONLY_MESSAGE } })
    expect(await get('127.0.0.1', '/api/v1/health/status', behalf)).toMatchObject({ status: 403, body: { error: { code: 'forbidden', message: HEALTH_LOCAL_ONLY_MESSAGE } } })
    expect((await send('PUT', '127.0.0.1', '/api/v1/health/settings', behalf, { paused: true })).status).toBe(403)
    expect((await send('DELETE', '127.0.0.1', '/api/v1/health/data', behalf, {})).status).toBe(403)
    expect((await send('DELETE', '127.0.0.1', '/API/V1/HEALTH/DATA', behalf, {})).status).toBe(403)
    // The same request with no label (or the local one) is this Mac, and is served.
    expect((await get('127.0.0.1', '/api/v1/health/status', { [ORIGIN_HEADER]: LOCAL_ORIGIN })).status).toBe(200)
  })

  it('actions/invoke from the LAN refuses local-only ops, with a device token or an API key', async () => {
    for (const credential of [deviceToken, API_KEY]) {
      const headers = bearer(credential)
      const health = await send('POST', LAN_IP!, '/api/v1/actions/invoke', headers, { tool: 'health_status' })
      expect(health).toMatchObject({ status: 403, body: { error: { code: 'local_only', message: `health_status refused: ${HEALTH_LOCAL_ONLY_MESSAGE}` } } })
      for (const tool of ['health_sleep', 'day_review']) {
        expect((await send('POST', LAN_IP!, '/api/v1/actions/invoke', headers, { tool })).status, tool).toBe(403)
      }
      const del = await send('POST', LAN_IP!, '/api/v1/actions/invoke', headers, { tool: 'task_delete', args: { id: 'abc123' }, confirmed: true })
      expect(del).toMatchObject({ status: 403, body: { error: { code: 'local_only' } } })
      // Claiming to be local in the header changes nothing from the LAN.
      const spoofed = await send('POST', LAN_IP!, '/api/v1/actions/invoke', { ...headers, [ORIGIN_HEADER]: LOCAL_ORIGIN }, { tool: 'health_status' })
      expect(spoofed.status).toBe(403)
    }
  })

  it('actions/invoke on this Mac still runs a health op; a self-call made for a remote host does not', async () => {
    const local = await send('POST', '127.0.0.1', '/api/v1/actions/invoke', {}, { tool: 'health_status' })
    expect(local).toMatchObject({ status: 200, body: { ok: true, tool: 'health_status' } })
    const nested = await send('POST', '127.0.0.1', '/api/v1/actions/invoke', { [ORIGIN_HEADER]: hostOrigin('remote-dev') }, { tool: 'health_status' })
    expect(nested).toMatchObject({ status: 403, body: { error: { code: 'local_only' } } })
  })
})
