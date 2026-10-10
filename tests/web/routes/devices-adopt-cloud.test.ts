/**
 * Device adoption on a companion (CLOUD_MODE), through the real server and
 * auth middleware:
 *  - POST /api/devices/adopt and /unadopt, which the Mac calls here with its
 *    own cloud credential: a phone is refused, the Mac is not, both repeat safely;
 *  - GET /api/v1/routes as a phone paired HERE: the companion's own route plus
 *    the primary's LAN and tailnet routes, from `server.devices.adopt` over the
 *    bridge (the bridge is the one thing faked);
 *  - a revoke here relays `server.devices.revoke-by-hash`, so the primary's copy goes too.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-devices-adopt-cloud', { CLOUD_MODE: true }))

const { bridgeRequestMock } = vi.hoisted(() => ({ bridgeRequestMock: vi.fn() }))
vi.mock('../../../src/web/ws/bridge-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/ws/bridge-registry.js')>()
  return { ...actual, bridgeRequest: bridgeRequestMock }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetDeviceTwinsForTesting, adoptOnPrimary, revokeAdoptionTwin } from '../../../src/web/routes/device-twins.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { BridgeOfflineError } from '../../../src/web/ws/bridge-registry.js'
import { handleDevicesRelayAction } from '../../../src/core/devices/relay.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const PRIMARY_ID = 'a'.repeat(32)
const ID = { mac: 'd00000000000000a1', phone: 'd00000000000000c3' }

let server: HttpServer
let port = 0
let T: { mac: string; phone: string }

type Rec = Record<string, unknown>
const authFile = () => path.join(WALNUT_HOME, 'auth.json')
const devices = async () => (JSON.parse(await fs.readFile(authFile(), 'utf-8')) as { devices: Rec[] }).devices
const find = async (name: string) => (await devices()).find((d) => d.name === name)

async function seed(): Promise<void> {
  T = { mac: tok(), phone: tok() }
  const now = new Date().toISOString()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(authFile(), JSON.stringify({ devices: [
    { name: 'mac-primary', id: ID.mac, tokenHash: sha(T.mac), createdAt: now },
    { name: 'my-phone', id: ID.phone, tokenHash: sha(T.phone), createdAt: now, platform: 'ios', info: { model: 'iPhone17,1', os: 'iOS 26.1' } },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
}

async function call(method: string, p: string, bearer?: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

/** Bridge frames of one action, in order. */
const frames = (action: string) => bridgeRequestMock.mock.calls
  .map((c) => c[2] as { action: string; sessionId: string; params: Rec })
  .filter((f) => f.action === action)

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const PRIMARY_ROUTES = [
  { kind: 'lan', origin: 'http://192.168.1.20:3456', label: 'This network (Wi-Fi)', instance: PRIMARY_ID },
  { kind: 'tailnet', origin: 'http://100.101.102.103:3456', label: 'Tailscale (anywhere this machine is on)', instance: PRIMARY_ID },
]

beforeAll(async () => {
  await seed()
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  await seed()
  bridgeRequestMock.mockReset()
  bridgeRequestMock.mockResolvedValue({ ok: true, result: { removed: 0 } })
  _resetDeviceTwinsForTesting()
  _resetAuthRateLimitForTesting()
})

describe('POST /api/devices/adopt and /unadopt on the companion', () => {
  const body = (hash: string) => ({ name: 'mac-phone', token_hash: hash, id: 'd0f0e0d0c0b0a0908', platform: 'ios', info: { model: 'iPhone16,2', os: 'iOS 26.0' } })

  it('a phone is refused (phone_cannot_pair) and nothing is written', async () => {
    const before = await fs.readFile(authFile(), 'utf-8')
    const r = await call('POST', '/api/devices/adopt', T.phone, body(sha(tok())))
    expect(r).toEqual({ status: 403, body: { error: expect.stringMatching(/^A phone cannot pair other devices/), code: 'phone_cannot_pair' } })
    expect((await call('POST', '/api/devices/unadopt', T.phone, { token_hash: sha(T.mac) })).body.code).toBe('phone_cannot_pair')
    expect((await devices()).map((d) => d.name)).toEqual(['mac-primary', 'my-phone'])
    expect(JSON.parse(await fs.readFile(authFile(), 'utf-8')).devices).toEqual(JSON.parse(before).devices.map((d: Rec) => (d.name === 'my-phone' ? { ...d, lastUsedAt: expect.any(String) } : d)))
  })

  it('the Mac adopts; again is idempotent; the adopted token then works here; unadopt removes it and its relayed pushes', async () => {
    const phoneToken = tok()
    const first = await call('POST', '/api/devices/adopt', T.mac, body(sha(phoneToken)))
    const instance = (await call('GET', '/api/v1/instance')).body.instance
    expect(first).toEqual({ status: 200, body: { name: 'mac-phone', instance, adopted: true } })
    expect(await call('POST', '/api/devices/adopt', T.mac, body(sha(phoneToken)))).toEqual({ status: 200, body: { name: 'mac-phone', instance, adopted: false } })
    expect(await find('mac-phone')).toMatchObject({ adoptedFrom: 'primary', platform: 'ios', tokenHash: sha(phoneToken) })
    expect((await call('GET', '/api/v1/tasks', phoneToken)).status).toBe(200)

    const un = await call('POST', '/api/devices/unadopt', T.mac, { token_hash: sha(phoneToken) })
    expect(un).toEqual({ status: 200, body: { name: 'mac-phone', instance, revoked: true } })
    expect(await find('mac-phone')).toBeUndefined()
    expect((await call('GET', '/api/v1/tasks', phoneToken)).status).toBe(401)
    // Its pushes stop too: the companion relays the device revoke to the primary.
    expect(frames('server.push.revoke-device').map((f) => f.params)).toEqual([{ keyName: 'mac-phone', revokedMsAgo: expect.any(Number) }])
    // Again: nothing there, still a 200.
    expect(await call('POST', '/api/devices/unadopt', T.mac, { token_hash: sha(phoneToken) })).toEqual({ status: 200, body: { name: null, instance, revoked: false } })
  })

  it('a name taken here gets a suffix; the existing pairing keeps its hash and id', async () => {
    const r = await call('POST', '/api/devices/adopt', T.mac, { ...body(sha(tok())), name: 'my-phone' })
    expect(r.body).toMatchObject({ name: 'my-phone-2', adopted: true })
    expect(await find('my-phone')).toMatchObject({ id: ID.phone, tokenHash: sha(T.phone) })
  })

  it('bad input is a 400 with a code', async () => {
    expect(await call('POST', '/api/devices/adopt', T.mac, { name: 'x', token_hash: 'nope' })).toEqual({ status: 400, body: { error: expect.stringMatching(/token_hash/), code: 'bad_request' } })
    expect((await call('POST', '/api/devices/adopt', T.mac, { name: 'bad name', token_hash: sha('x') })).status).toBe(400)
    expect((await call('POST', '/api/devices/unadopt', T.mac, {})).status).toBe(400)
  })

  it('needs a token', async () => {
    expect((await call('POST', '/api/devices/adopt', undefined, body(sha(tok())))).status).toBe(401)
  })
})

describe('GET /api/v1/routes on the companion', () => {
  it('a phone paired here gets the primary\'s routes (adopted over the bridge) and this box\'s own', async () => {
    bridgeRequestMock.mockImplementation(async (_alias: string, _cmd: string, frame: { action: string }) => (frame.action === 'server.devices.adopt'
      ? { ok: true, result: { name: 'my-phone', adopted: true, instance: PRIMARY_ID, routes: [...PRIMARY_ROUTES, { kind: 'cloud', origin: 'http://x', label: 'junk', instance: PRIMARY_ID }, { kind: 'lan', origin: 'javascript:alert(1)', label: 'x', instance: PRIMARY_ID }], tailscale: { installed: false, running: false, dnsName: '', extra: 1 } } }
      : { ok: true, result: {} }))
    const me = (await call('GET', '/api/v1/instance')).body
    expect(me).toEqual({ instance: expect.stringMatching(/^[0-9a-f]{32}$/), mode: 'REPLICA' })
    const r = await call('GET', '/api/v1/routes', T.phone)
    expect(r).toEqual({
      status: 200,
      body: {
        routes: [...PRIMARY_ROUTES, { kind: 'cloud', origin: `http://127.0.0.1:${port}`, label: 'Cloud (anywhere)', instance: me.instance }],
        device: 'my-phone',
        // The Mac's Tailscale state rides the adopt reply: a phone that asks the companion is the one away from home.
        tailscale: { installed: false, running: false },
      },
    })
    const [frame] = frames('server.devices.adopt')
    expect(frame.sessionId).toBe('__server__')
    expect(frame.params).toEqual({ name: 'my-phone', tokenHash: sha(T.phone), id: ID.phone, platform: 'ios', info: { model: 'iPhone17,1', os: 'iOS 26.1' } })
    // Repeats inside the cache window do not ride the bridge again.
    await call('GET', '/api/v1/routes', T.phone)
    expect(frames('server.devices.adopt')).toHaveLength(1)
  })

  it('bridge offline or a primary that predates the action: just this box\'s route, still 200', async () => {
    for (const fail of [
      () => bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__')),
      () => bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: server.devices.adopt', errorKind: 'bad_request' }),
    ]) {
      _resetDeviceTwinsForTesting()
      fail()
      const r = await call('GET', '/api/v1/routes', T.phone)
      expect(r.status).toBe(200)
      expect(r.body.routes.map((x: { kind: string }) => x.kind)).toEqual(['cloud'])
      expect(r.body).not.toHaveProperty('tailscale')
    }
  })

  it('the Mac\'s cloud credential (no phone) gets the routes too; an API-key-less unpaired call is 401', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { name: 'mac-primary', adopted: false, instance: PRIMARY_ID, routes: PRIMARY_ROUTES } })
    expect((await call('GET', '/api/v1/routes', T.mac)).body.device).toBe('mac-primary')
    expect((await call('GET', '/api/v1/routes')).status).toBe(401)
  })
})

describe('the Mac\'s own pairing on the companion', () => {
  it('is never copied to the primary nor removed by hash once it owns the machine credentials', async () => {
    const devs = await devices()
    devs.push({ name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(tok()), createdAt: new Date().toISOString(), kind: 'machine', ownerId: ID.mac })
    await fs.writeFile(authFile(), JSON.stringify({ devices: devs }), { mode: 0o600 })
    _resetDeviceAuthForTesting()
    const r = await call('GET', '/api/v1/routes', T.mac)
    expect(r.status).toBe(200)
    expect(r.body.routes.map((x: { kind: string }) => x.kind)).toEqual(['cloud'])
    expect(frames('server.devices.adopt')).toHaveLength(0)
    // Unadopting its hash (even by itself) removes nothing.
    expect((await call('POST', '/api/devices/unadopt', T.mac, { token_hash: sha(T.mac) })).body).toMatchObject({ name: null, revoked: false })
    expect(await find('mac-primary')).toBeDefined()
    expect(await find('bridge-local')).toBeDefined()
  })
})

describe('a revoke on the companion reaches the primary\'s copy', () => {
  it('DELETE /api/devices/:name relays server.devices.revoke-by-hash with the revoked token\'s hash', async () => {
    // The phone unpairs itself (the Mac here owns no machine credentials, so it may not).
    const r = await call('DELETE', '/api/devices/my-phone', T.phone)
    expect(r.status).toBe(200)
    await waitFor(() => frames('server.devices.revoke-by-hash').length > 0)
    expect(frames('server.devices.revoke-by-hash').map((f) => f.params)).toEqual([{ tokenHash: sha(T.phone) }])
  })

  it('the primary unreachable at revoke time: the removal is retried until it lands; an older primary is not retried', async () => {
    _resetDeviceTwinsForTesting({ retryMs: 30 })
    let offline = 2
    bridgeRequestMock.mockImplementation(async (_a: string, _c: string, frame: { action: string }) => {
      if (frame.action === 'server.devices.revoke-by-hash' && offline-- > 0) throw new BridgeOfflineError('__local__')
      return { ok: true, result: { name: 'my-phone', revoked: true } }
    })
    expect((await call('DELETE', '/api/devices/my-phone', T.phone)).status).toBe(200)
    await waitFor(() => frames('server.devices.revoke-by-hash').length === 3)
    await new Promise((r) => setTimeout(r, 150))
    expect(frames('server.devices.revoke-by-hash')).toHaveLength(3) // stopped once it landed

    await seed()
    bridgeRequestMock.mockReset()
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: server.devices.revoke-by-hash', errorKind: 'bad_request' })
    expect((await call('DELETE', '/api/devices/my-phone', T.phone)).status).toBe(200)
    await waitFor(() => frames('server.devices.revoke-by-hash').length === 1)
    await new Promise((r) => setTimeout(r, 150))
    expect(frames('server.devices.revoke-by-hash')).toHaveLength(1)
  })

  it('a revoke racing an adoption in flight still ends with the primary\'s copy removed', async () => {
    // What the primary saw, in order. The invariant: some revoke-by-hash is SENT
    // after the adoption was ANSWERED, so the removal is the primary's last word.
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    bridgeRequestMock.mockImplementation(async (_a: string, _c: string, frame: { action: string }) => {
      if (frame.action === 'server.devices.adopt') {
        events.push('adopt-sent')
        await gate
        events.push('adopt-answered')
        return { ok: true, result: { name: 'my-phone', adopted: true, instance: PRIMARY_ID, routes: PRIMARY_ROUTES } }
      }
      if (frame.action === 'server.devices.revoke-by-hash') events.push('revoke-sent')
      return { ok: true, result: { name: 'my-phone', revoked: true } }
    })
    const routes = call('GET', '/api/v1/routes', T.phone)
    await waitFor(() => events.includes('adopt-sent'))
    const del = await call('DELETE', '/api/devices/my-phone', T.phone)
    expect(del.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50)) // give a wrong implementation the chance to revoke early
    release()
    const answered = await routes
    expect(answered.status).toBe(200)
    // A twin revoked mid-flight is not offered as a route.
    expect(answered.body.routes.map((x: { kind: string }) => x.kind)).toEqual(['cloud'])
    await waitFor(() => events.lastIndexOf('revoke-sent') > events.indexOf('adopt-answered'))
  })

  it('an adoption asked for after the revoke never rides the bridge', async () => {
    const record = (await devices()).find((d) => d.name === 'my-phone') as unknown as import('../../../src/core/device-auth.js').DeviceRecord
    await revokeAdoptionTwin(record.tokenHash)
    bridgeRequestMock.mockClear()
    expect(await adoptOnPrimary(record)).toEqual({ routes: [], tailscale: null })
    expect(frames('server.devices.adopt')).toHaveLength(0)
  })
})

describe('GET /api/devices on the companion', () => {
  it('says nothing about Tailscale (the field is absent, so the console shows no install hint)', async () => {
    const r = await call('GET', '/api/devices', T.mac)
    expect(r.status).toBe(200)
    expect(r.body).not.toHaveProperty('tailscale')
    expect(r.body.targets).toEqual([{ kind: 'cloud', origin: `http://127.0.0.1:${port}`, label: 'This server' }])
  })
})

describe('the relay handler refuses to run on a replica', () => {
  it('wrong_box', async () => {
    await expect(handleDevicesRelayAction('adopt', { name: 'x', tokenHash: sha('x') })).rejects.toMatchObject({ code: 'wrong_box', status: 500 })
  })
})
