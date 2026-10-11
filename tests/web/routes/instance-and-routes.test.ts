/**
 * GET /api/v1/instance, GET /api/v1/routes and the adoption twin on the PRIMARY,
 * through the real server and auth middleware.
 *
 * Faked: the interface list (a Wi-Fi 192.168 address and a tailnet 100.x on
 * utun3), the Tailscale CLI (absent), and the cloud companion, which is a real
 * HTTP stub on a random port answering /api/devices/adopt and /unadopt. A "LAN
 * caller" is a request carrying X-Forwarded-For, which local-trust.ts treats as
 * not this machine (exactly what a phone on the Wi-Fi is).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-instance-routes'))

let cloudEndpoint: { origin: string; token: string } | null = null
vi.mock('../../../src/core/pairing-targets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/pairing-targets.js')>()
  return { ...actual, getCloudPairingEndpointAsync: async () => cloudEndpoint }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting, createDevice } from '../../../src/core/device-auth.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { _setTailscaleProbeForTesting } from '../../../src/core/tailnet.js'
import { _resetDeviceTwinsForTesting } from '../../../src/web/routes/device-twins.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const CLOUD_ID = 'c'.repeat(32)
const CLOUD_TOKEN = 'cloudcredential0000000000000000'
const API_KEY = 'wlnt_sk_instance_routes_test'
const LAN = { 'x-forwarded-for': '192.168.1.44' }

let server: HttpServer
let port = 0

// ── the cloud companion stub ──
type StubCall = { path: string; auth: string | undefined; body: Record<string, unknown> }
const stubCalls: StubCall[] = []
let adoptStatus = 200
/** What the stub's /unadopt answers, in order (the last one repeats). */
let unadoptAnswers: Array<Record<string, unknown>> = []
let stub: http.Server

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      stubCalls.push({ path: req.url ?? '', auth: req.headers.authorization, body })
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/devices/adopt') {
        res.statusCode = adoptStatus
        res.end(JSON.stringify(adoptStatus === 200 ? { name: body.name, instance: CLOUD_ID, adopted: true } : { error: 'Not found' }))
        return
      }
      if (req.url === '/api/devices/unadopt') {
        const answer = unadoptAnswers.length > 1 ? unadoptAnswers.shift()! : unadoptAnswers[0]
        res.end(JSON.stringify(answer ?? { name: 'whatever', instance: CLOUD_ID, revoked: true, refused: false }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))

  await updateConfig({ api_keys: [{ name: 'script', key: API_KEY, created_at: new Date().toISOString() }] })
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
  // After boot, so nothing at startup sees the fake interfaces.
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:01', cidr: '192.168.1.20/24' }],
    utun3: [{ address: '100.101.102.103', family: 'IPv4', internal: false, netmask: '255.192.0.0', mac: '00:00:00:00:00:00', cidr: '100.101.102.103/10' }],
  } as ReturnType<typeof os.networkInterfaces>)
}, 60_000)

afterAll(async () => {
  vi.restoreAllMocks()
  _setTailscaleProbeForTesting(null)
  await stopServer()
  await new Promise<void>((resolve) => stub.close(() => resolve()))
})

beforeEach(() => {
  stubCalls.length = 0
  adoptStatus = 200
  unadoptAnswers = []
  cloudEndpoint = null
  _resetDeviceTwinsForTesting()
  _resetAuthRateLimitForTesting()
  _setTailscaleProbeForTesting({ locate: async () => null })
})

async function get(p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers })
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }
}

async function send(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

const bearer = (t: string) => ({ ...LAN, authorization: `Bearer ${t}` })
const withCloud = () => { cloudEndpoint = { origin: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, token: CLOUD_TOKEN } }
const adopts = () => stubCalls.filter((c) => c.path === '/api/devices/adopt')

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('GET /api/v1/instance', () => {
  it('answers a LAN caller with no token, says nothing else, and stays stable', async () => {
    // The LAN simulation is real: the same caller without a token is refused elsewhere.
    expect((await get('/api/v1/tasks', LAN)).status).toBe(401)
    const a = await get('/api/v1/instance', LAN)
    expect(a.status).toBe(200)
    expect(Object.keys(a.body).sort()).toEqual(['instance', 'mode'])
    expect(a.body).toEqual({ instance: expect.stringMatching(/^[0-9a-f]{32}$/), mode: 'LIVE' })
    expect((await get('/api/v1/instance', LAN)).body.instance).toBe(a.body.instance)
    // An invalid token does not turn it into a 401 either.
    expect((await get('/api/v1/instance', bearer('nope'))).body.instance).toBe(a.body.instance)
    const onDisk = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')) as { instanceId: string }
    expect(onDisk.instanceId).toBe(a.body.instance)
  })

  it('only GET is public', async () => {
    expect((await send('POST', '/api/v1/instance', {}, LAN)).status).toBe(401)
  })
})

describe('GET /api/v1/routes (primary)', () => {
  it('a paired phone gets the LAN and tailnet routes with this box\'s id, and no cloud without a companion', async () => {
    const { token } = await createDevice('lan-phone')
    const me = (await get('/api/v1/instance', LAN)).body.instance
    const r = await get('/api/v1/routes', bearer(token))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      routes: [
        { kind: 'lan', origin: `http://192.168.1.20:${port}`, label: 'This network (Wi-Fi)', instance: me },
        { kind: 'tailnet', origin: `http://100.101.102.103:${port}`, label: 'Tailnet (anywhere this machine is on)', instance: me },
      ],
      device: 'lan-phone',
      // No Tailscale CLI, but this Mac has a tailnet address: the Mac side is done (phone guidance).
      tailscale: { installed: false, running: true },
    })
    expect(stubCalls).toHaveLength(0)
  })

  it('with a companion: adopts the pairing there once for repeated and concurrent calls; the cloud route carries the cloud\'s id', async () => {
    withCloud()
    const { token } = await createDevice('roaming-phone')
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => get('/api/v1/routes', bearer(token))))
    const d = await get('/api/v1/routes', bearer(token))
    for (const r of [a, b, c, d]) {
      expect(r.status).toBe(200)
      expect(r.body.routes.map((x: { kind: string }) => x.kind)).toEqual(['lan', 'tailnet', 'cloud'])
      expect(r.body.routes[2]).toEqual({ kind: 'cloud', origin: cloudEndpoint!.origin, label: 'Cloud (anywhere)', instance: CLOUD_ID })
    }
    expect(adopts()).toHaveLength(1)
    const call = adopts()[0]
    expect(call.auth).toBe(`Bearer ${CLOUD_TOKEN}`)
    expect(call.body).toMatchObject({ name: 'roaming-phone', token_hash: sha(token), id: expect.stringMatching(/^d[0-9a-f]{16}$/) })
    // The token itself never leaves this box.
    expect(JSON.stringify(call.body)).not.toContain(token)
  })

  it('a companion that does not adopt (an older build: 404) leaves the cloud route out, still 200; the next call retries', async () => {
    withCloud()
    adoptStatus = 404
    const { token } = await createDevice('old-cloud-phone')
    const r = await get('/api/v1/routes', bearer(token))
    expect(r.status).toBe(200)
    expect(r.body.routes.map((x: { kind: string }) => x.kind)).toEqual(['lan', 'tailnet'])
    adoptStatus = 200
    expect((await get('/api/v1/routes', bearer(token))).body.routes.map((x: { kind: string }) => x.kind)).toEqual(['lan', 'tailnet', 'cloud'])
    expect(adopts()).toHaveLength(2)
  })

  it('an unreachable companion leaves the cloud route out', async () => {
    cloudEndpoint = { origin: 'http://127.0.0.1:1', token: CLOUD_TOKEN }
    const { token } = await createDevice('offline-cloud-phone')
    const r = await get('/api/v1/routes', bearer(token))
    expect(r.status).toBe(200)
    expect(r.body.routes.map((x: { kind: string }) => x.kind)).toEqual(['lan', 'tailnet'])
  })

  it('an API key or the loopback console gets the routes with no adoption and no device', async () => {
    withCloud()
    const key = await get('/api/v1/routes', bearer(API_KEY))
    expect(key.status).toBe(200)
    expect(key.body.device).toBeNull()
    expect(key.body.routes.map((x: { kind: string }) => x.kind)).toEqual(['lan', 'tailnet'])
    const consoleCall = await get('/api/v1/routes')
    expect(consoleCall.status).toBe(200)
    expect(consoleCall.body.device).toBeNull()
    expect(stubCalls).toHaveLength(0)
  })

  it('needs a token from the LAN', async () => {
    expect((await get('/api/v1/routes', LAN)).status).toBe(401)
  })
})

describe('the twin goes with the pairing', () => {
  it('DELETE /api/devices/:name removes the cloud copy by hash (in the background); the response does not wait for it', async () => {
    withCloud()
    const { token } = await createDevice('lost-phone')
    await get('/api/v1/routes', bearer(token))
    expect(adopts()).toHaveLength(1)
    const del = await send('DELETE', '/api/devices/lost-phone')
    expect(del.status).toBe(200)
    await waitFor(() => stubCalls.some((c) => c.path === '/api/devices/unadopt'))
    const un = stubCalls.find((c) => c.path === '/api/devices/unadopt')!
    expect(un).toEqual({ path: '/api/devices/unadopt', auth: `Bearer ${CLOUD_TOKEN}`, body: { token_hash: sha(token) } })
    expect((await get('/api/v1/routes', bearer(token))).status).toBe(401)
  })

  it('a companion unreachable at revoke time gets the removal later (retried)', async () => {
    _resetDeviceTwinsForTesting({ retryMs: 30 })
    withCloud()
    const { token } = await createDevice('flaky-phone')
    await get('/api/v1/routes', bearer(token))
    cloudEndpoint = { origin: 'http://127.0.0.1:1', token: CLOUD_TOKEN }
    expect((await send('DELETE', '/api/devices/flaky-phone')).status).toBe(200)
    await new Promise((r) => setTimeout(r, 100))
    expect(stubCalls.some((c) => c.path === '/api/devices/unadopt')).toBe(false)
    withCloud()
    await waitFor(() => stubCalls.some((c) => c.path === '/api/devices/unadopt'))
    expect(stubCalls.filter((c) => c.path === '/api/devices/unadopt').map((c) => c.body)).toEqual([{ token_hash: sha(token) }])
  })

  it('a companion that kept its copy (refused, or an older one that does not say) is asked again; nothing there is done', async () => {
    _resetDeviceTwinsForTesting({ retryMs: 30 })
    withCloud()
    const unadopts = () => stubCalls.filter((c) => c.path === '/api/devices/unadopt')
    // Refused, then the bare answer an older companion gives, then removed: three asks, then it stops.
    unadoptAnswers = [
      { name: null, instance: CLOUD_ID, revoked: false, refused: true },
      { name: null, instance: CLOUD_ID, revoked: false },
      { name: 'kept-phone', instance: CLOUD_ID, revoked: true, refused: false },
    ]
    const { token } = await createDevice('kept-phone')
    await get('/api/v1/routes', bearer(token))
    expect((await send('DELETE', '/api/devices/kept-phone')).status).toBe(200)
    await waitFor(() => unadopts().length >= 3)
    await new Promise((r) => setTimeout(r, 200))
    expect(unadopts()).toHaveLength(3)
    // Not there any more (refused: false): done at the first answer.
    stubCalls.length = 0
    unadoptAnswers = [{ name: null, instance: CLOUD_ID, revoked: false, refused: false }]
    const { token: other } = await createDevice('gone-phone')
    await get('/api/v1/routes', bearer(other))
    expect((await send('DELETE', '/api/devices/gone-phone')).status).toBe(200)
    await waitFor(() => unadopts().length >= 1)
    await new Promise((r) => setTimeout(r, 200))
    expect(unadopts()).toHaveLength(1)
  })

  it('a re-pair (new QR) removes the old token\'s cloud copy; the new token is adopted on its own', async () => {
    withCloud()
    const { token: oldToken } = await createDevice('reinstalled-phone')
    await get('/api/v1/routes', bearer(oldToken))
    const repair = await send('POST', '/api/devices', { name: 'reinstalled-phone', replace: true })
    expect(repair.status).toBe(201)
    await waitFor(() => stubCalls.some((c) => c.path === '/api/devices/unadopt'))
    expect(stubCalls.find((c) => c.path === '/api/devices/unadopt')!.body).toEqual({ token_hash: sha(oldToken) })
    const fresh = await get('/api/v1/routes', bearer(repair.body.token))
    expect(fresh.body.routes.map((x: { kind: string }) => x.kind)).toEqual(['lan', 'tailnet', 'cloud'])
    expect(adopts().map((c) => c.body.token_hash)).toEqual([sha(oldToken), sha(repair.body.token)])
  })
})

describe('this Mac\'s own cloud credential', () => {
  it('is never copied to the companion nor removed there by hash, even when a record here carries its hash', async () => {
    withCloud()
    const { adoptDeviceRecord } = await import('../../../src/core/device-adoption.js')
    await adoptDeviceRecord({ name: 'mac-on-cloud', tokenHash: sha(CLOUD_TOKEN), adoptedFrom: 'cloud' })
    const r = await get('/api/v1/routes', bearer(CLOUD_TOKEN))
    expect(r.status).toBe(200)
    expect(r.body.routes.map((x: { kind: string }) => x.kind)).toEqual(['lan', 'tailnet'])
    expect((await send('DELETE', '/api/devices/mac-on-cloud')).status).toBe(200)
    await new Promise((res) => setTimeout(res, 200))
    expect(stubCalls).toHaveLength(0)
  })
})

describe('server.devices.* relayed from the companion (primary side)', () => {
  it('adopt: the cloud pairing\'s token works here, answered with this box\'s routes; again is a no-op; revoke-by-hash ends it', async () => {
    const cloudPhoneToken = crypto.randomBytes(16).toString('hex')
    const me = (await get('/api/v1/instance', LAN)).body.instance
    const params = { name: 'cloud-phone', tokenHash: sha(cloudPhoneToken), id: 'd0a0b0c0d0e0f0a0b', platform: 'ios', info: { model: 'iPhone17,1', os: 'iOS 26.1' } }
    const first = await handleSessionControlRelay('server.devices.adopt', '__server__', params)
    expect(first).toEqual({
      ok: true,
      result: {
        name: 'cloud-phone', adopted: true, instance: me,
        routes: [
          { kind: 'lan', origin: `http://192.168.1.20:${port}`, label: 'This network (Wi-Fi)', instance: me },
          { kind: 'tailnet', origin: `http://100.101.102.103:${port}`, label: 'Tailnet (anywhere this machine is on)', instance: me },
        ],
        // The companion forwards this in its /routes answer, so a cloud-only phone hears about the Mac's Tailscale.
        tailscale: { installed: false, running: true },
      },
    })
    expect(await handleSessionControlRelay('server.devices.adopt', '__server__', params)).toMatchObject({ ok: true, result: { name: 'cloud-phone', adopted: false } })
    const record = (JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')) as { devices: Array<Record<string, unknown>> }).devices.find((d) => d.name === 'cloud-phone')
    expect(record).toMatchObject({ adoptedFrom: 'cloud', platform: 'ios', id: 'd0a0b0c0d0e0f0a0b' })
    // The phone now reaches the Mac directly with the token it got from the cloud.
    expect((await get('/api/v1/tasks', bearer(cloudPhoneToken))).status).toBe(200)

    expect(await handleSessionControlRelay('server.devices.revoke-by-hash', '__server__', { tokenHash: sha(cloudPhoneToken) }))
      .toEqual({ ok: true, result: { name: 'cloud-phone', revoked: true } })
    expect((await get('/api/v1/tasks', bearer(cloudPhoneToken))).status).toBe(401)
    expect(await handleSessionControlRelay('server.devices.revoke-by-hash', '__server__', { tokenHash: sha(cloudPhoneToken) }))
      .toEqual({ ok: true, result: { name: null, revoked: false, refused: false } })
  })

  it('revoke-by-hash of the oldest pairing here, a Mac paired over the LAN, removes it: this Mac has no owner but itself (F-B)', async () => {
    const file = path.join(WALNUT_HOME, 'auth.json')
    const saved = await fs.readFile(file, 'utf-8')
    try {
      // auth.json as a build without owners writes it: the LAN Mac first, reported as a Mac, then a phone.
      const macToken = crypto.randomBytes(16).toString('hex')
      const now = new Date().toISOString()
      await fs.writeFile(file, JSON.stringify({ ...JSON.parse(saved), devices: [
        { name: 'lan-mac', id: 'd0000000000000aa1', tokenHash: sha(macToken), createdAt: now, platform: 'other', info: { model: 'Mac15,3', os: 'macOS 26.0' } },
        { name: 'lan-phone-2', id: 'd0000000000000aa2', tokenHash: sha(crypto.randomBytes(16).toString('hex')), createdAt: now, platform: 'ios' },
      ] }, null, 2) + '\n', { mode: 0o600 })
      _resetDeviceAuthForTesting()
      expect((await get('/api/v1/tasks', bearer(macToken))).status).toBe(200)
      // The companion revoked it there: the copy here goes, and so does its access.
      expect(await handleSessionControlRelay('server.devices.revoke-by-hash', '__server__', { tokenHash: sha(macToken) }))
        .toEqual({ ok: true, result: { name: 'lan-mac', revoked: true } })
      expect((await get('/api/v1/tasks', bearer(macToken))).status).toBe(401)
    } finally {
      await fs.writeFile(file, saved, { mode: 0o600 })
      _resetDeviceAuthForTesting()
    }
  })

  it('revoke-by-hash of a pairing this box keeps (a machine credential) is refused, and says so: the companion asks again', async () => {
    const file = path.join(WALNUT_HOME, 'auth.json')
    const saved = await fs.readFile(file, 'utf-8')
    try {
      const machineToken = crypto.randomBytes(16).toString('hex')
      const parsed = JSON.parse(saved) as { devices: unknown[] }
      await fs.writeFile(file, JSON.stringify({ ...parsed, devices: [
        ...parsed.devices,
        { name: 'bridge-kept', id: 'd0000000000000ab1', tokenHash: sha(machineToken), createdAt: new Date().toISOString(), kind: 'machine' },
      ] }, null, 2) + '\n', { mode: 0o600 })
      _resetDeviceAuthForTesting()
      // `refused` rides only on an answer that removed nothing (a removal answers { name, revoked: true }).
      expect(await handleSessionControlRelay('server.devices.revoke-by-hash', '__server__', { tokenHash: sha(machineToken) }))
        .toEqual({ ok: true, result: { name: null, revoked: false, refused: true } })
      const after = JSON.parse(await fs.readFile(file, 'utf-8')) as { devices: Array<{ name: string }> }
      expect(after.devices.map((d) => d.name)).toContain('bridge-kept')
    } finally {
      await fs.writeFile(file, saved, { mode: 0o600 })
      _resetDeviceAuthForTesting()
    }
  })

  it('bad input is a bad_request, never a write', async () => {
    expect(await handleSessionControlRelay('server.devices.adopt', '__server__', { name: 'x', tokenHash: 'short' }))
      .toMatchObject({ ok: false, errorKind: 'bad_request', errorCode: 'bad_request' })
    expect(await handleSessionControlRelay('server.devices.revoke-by-hash', '__server__', {}))
      .toMatchObject({ ok: false, errorKind: 'bad_request' })
  })
})

describe('console surface', () => {
  it('GET /api/devices lists the tailnet target and the Tailscale state', async () => {
    const r = await get('/api/devices')
    expect(r.status).toBe(200)
    expect(r.body.tailscale).toEqual({ installed: false, running: false })
    expect(r.body.targets.map((t: { kind: string }) => t.kind)).toEqual(['lan', 'tailnet'])
    expect(r.body.targets[1]).toEqual({ kind: 'tailnet', origin: `http://100.101.102.103:${port}`, label: 'Tailnet (anywhere this machine is on)' })
  })

  it('POST /api/devices { target: "tailnet" } puts the tailnet address in the QR', async () => {
    const r = await send('POST', '/api/devices', { name: 'tailnet-phone', target: 'tailnet' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ target: 'tailnet', server: `http://100.101.102.103:${port}` })
    expect(r.body.pairingURI).toContain(`&server=${encodeURIComponent(`http://100.101.102.103:${port}`)}`)
    // No target: the LAN stays first.
    expect((await send('POST', '/api/devices', { name: 'wifi-phone' })).body).toMatchObject({ target: 'lan', server: `http://192.168.1.20:${port}` })
  })

  it('CORS grants a tailnet browser origin (address or MagicDNS name) and still refuses a public one', async () => {
    for (const origin of [`http://100.101.102.103:${port}`, 'https://studio-mac.tail1234.ts.net', `http://192.168.1.20:${port}`]) {
      expect((await get('/api/v1/instance', { origin })).headers.get('access-control-allow-origin'), origin).toBe(origin)
    }
    for (const origin of ['https://evil.example', 'https://evil-ts.net', 'http://100.128.0.1']) {
      expect((await get('/api/v1/instance', { origin })).headers.get('access-control-allow-origin'), origin).toBeNull()
    }
  })
})
