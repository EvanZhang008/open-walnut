/**
 * Walnut Connect on the primary, through the real server: the experiment opens and closes the
 * door (a unix socket serving the same app), a request through it always needs the device token
 * (it is never this machine), GET /api/v1/routes lists the `connect` route a phone dials, a
 * phone registers its own network id, and a new pairing's QR carries a key whose id is already
 * on the record.
 *
 * Faked: walnut-net's status (setConnectStatusSourceForTest: this Mac's id, public relay mode,
 * its home relay and addresses) and the host network's sync (net-mac.js: no daemon is told).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { netKey } from '../../helpers/net-keys.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-connect-door'))

const syncNet = vi.fn(async (_opts?: unknown) => ({}))
vi.mock('../../../src/core/net/net-mac.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/net/net-mac.js')>()
  const { updateConfig } = await import('../../../src/core/config-manager.js')
  return {
    ...actual,
    netActive: async () => true,
    startNet: async () => {},
    // Turning it on writes net.enabled, as the real one does; nothing is told to a daemon.
    syncNet: async (opts?: { enable?: boolean }) => {
      if (opts?.enable) await updateConfig({ net: { enabled: true } } as never)
      return syncNet(opts)
    },
    netState: () => ({ ...actual.netState(), enabled: true, macId: THIS_MAC, members: [{ id: MACHINE_ID, name: 'box', role: 'host' } as never] }),
  }
})

import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, listDeviceRecords } from '../../../src/core/device-auth.js'
import { connectDoor, setConnectStatusSourceForTest } from '../../../src/core/connect/connect-net.js'
import { connectPhones, endpointOfKey } from '../../../src/core/connect/connect-phones.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'

const MAC_ID = netKey('connect-mac')
/** A machine of the host network, and this Mac, as net-mac.js knows them (mocked above). */
const MACHINE_ID = netKey('connect-machine')
const THIS_MAC = netKey('connect-this-mac')
const HOME_RELAY = 'https://relay-a.example.net./'
const LAN = { 'x-forwarded-for': '192.168.1.44' }
let port = 0

beforeAll(async () => {
  setConnectStatusSourceForTest(async () => ({
    running: true, protocol: 3,
    node: { id: MAC_ID, relayMode: 'public', homeRelay: HOME_RELAY, addrs: ['127.0.0.1:4100', '[fe80::1]:4100', '192.168.1.20:4100', '[2601:600::5]:4100'] },
  }))
  const server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
}, 60_000)

afterAll(async () => {
  setConnectStatusSourceForTest(null)
  await stopServer()
})

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/** One request through the door's unix socket, as walnut-net pipes a phone's stream in. */
function viaDoor(p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: connectDoor()!, path: p, headers: { host: 'walnut-connect', ...headers } }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }) } catch { resolve({ status: res.statusCode ?? 0, body: raw }) } })
    })
    req.on('error', reject)
    req.end()
  })
}

/** A WebSocket upgrade with no token through the door: the first line of the answer. */
function upgradeViaDoor(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(connectDoor()!)
    let got = ''
    sock.on('data', (d) => { got += d.toString('latin1'); if (got.includes('\r\n')) { sock.destroy(); resolve(got.split('\r\n')[0]!) } })
    sock.on('error', reject)
    sock.on('close', () => resolve(got.split('\r\n')[0] ?? ''))
    sock.write(`GET ${p} HTTP/1.1\r\nHost: walnut-connect\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\n\r\n`)
  })
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const bearer = (t: string) => ({ ...LAN, authorization: `Bearer ${t}` })
const setFlag = (on: boolean) => call('PUT', '/api/config', { experimental: { walnut_connect: on } })

describe('Walnut Connect on the primary', () => {
  it('stays closed and unlisted while the experiment is off', async () => {
    const { token } = await createDevice('off-phone')
    expect(connectDoor()).toBeNull()
    const r = await call('GET', '/api/v1/routes', undefined, bearer(token))
    expect(r.status).toBe(200)
    expect(r.body.routes.some((x: { kind: string }) => x.kind === 'connect')).toBe(false)
    expect(r.body).not.toHaveProperty('connectEndpoint')
    // Off for sure: a phone that stored the route drops it.
    expect(r.body.connectOff).toBe(true)
  })

  it('opens the door when turned on; through it nothing is this machine', async () => {
    expect((await setFlag(true)).status).toBe(200)
    await waitFor(() => connectDoor() !== null)
    const sock = connectDoor()!
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600)
    const { token } = await createDevice('door-phone')
    _resetAuthRateLimitForTesting()
    // The loopback console needs no token on the TCP port; the door is never loopback.
    expect((await call('GET', '/api/v1/status')).status).toBe(200)
    expect((await viaDoor('/api/v1/status')).status).toBe(401)
    expect((await viaDoor('/api/tasks')).status).toBe(401)
    expect((await viaDoor('/api/v1/status', { authorization: 'Bearer nope' })).status).toBe(401)
    expect((await viaDoor('/api/v1/status', { authorization: `Bearer ${token}` })).status).toBe(200)
    // The identity probe a phone runs before it sends its token stays public, as on the Wi-Fi.
    const me = (await call('GET', '/api/v1/instance', undefined, LAN)).body.instance
    expect((await viaDoor('/api/v1/instance')).body).toEqual({ instance: me, mode: 'LIVE' })
  })

  it('lists the connect route, and a phone registers its own id once', async () => {
    const { token } = await createDevice('roam-phone')
    const me = (await call('GET', '/api/v1/instance', undefined, LAN)).body.instance
    const r = await call('GET', '/api/v1/routes', undefined, bearer(token))
    expect(r.body.routes.find((x: { kind: string }) => x.kind === 'connect')).toEqual({
      kind: 'connect', origin: `walnut-connect://${MAC_ID}`, label: 'Walnut Connect', instance: me,
      connect: { id: MAC_ID, relayMode: 'public', relays: [HOME_RELAY], addrs: ['192.168.1.20:4100', '[2601:600::5]:4100'] },
    })
    expect(r.body.connectEndpoint).toBeNull()
    expect(r.body).not.toHaveProperty('connectOff')

    syncNet.mockClear()
    const id = netKey('roam-phone-key')
    expect((await call('POST', '/api/v1/connect/register', { endpoint: id }, bearer(token))).body).toEqual({ registered: true, endpoint: id, changed: true })
    expect((await call('POST', '/api/v1/connect/register', { endpoint: id }, bearer(token))).body.changed).toBe(false)
    expect((await call('GET', '/api/v1/routes', undefined, bearer(token))).body.connectEndpoint).toBe(id)
    expect(await connectPhones()).toContainEqual({ id, name: 'roam-phone' })
    // This Mac's walnut-net is told (debounced), in a sync that starts after any running one.
    await waitFor(() => syncNet.mock.calls.length > 0)
    expect(syncNet).toHaveBeenCalledWith({ fresh: true })
  })

  it('takes a phone\'s token only: no API key, no console, no bad id, no id another phone holds', async () => {
    const a = await createDevice('reg-a')
    const b = await createDevice('reg-b')
    const id = netKey('reg-a-key')
    expect((await call('POST', '/api/v1/connect/register', { endpoint: id })).body.code).toBe('not_a_phone')
    expect((await call('POST', '/api/v1/connect/register', { endpoint: id }, LAN)).status).toBe(401)
    expect((await call('POST', '/api/v1/connect/register', { endpoint: 'zz' }, bearer(a.token))).status).toBe(400)
    expect((await call('POST', '/api/v1/connect/register', { endpoint: id }, bearer(a.token))).status).toBe(200)
    const taken = await call('POST', '/api/v1/connect/register', { endpoint: id }, bearer(b.token))
    expect(taken).toEqual({ status: 409, body: expect.objectContaining({ code: 'endpoint_taken' }) })
    // A machine's id on the host network, or this Mac's, is never a phone's.
    for (const machine of [MACHINE_ID, THIS_MAC]) {
      expect((await call('POST', '/api/v1/connect/register', { endpoint: machine }, bearer(b.token))).body.code).toBe('endpoint_taken')
    }
  })

  it('never lets a forwarded header or a WebSocket upgrade through the door without a token', async () => {
    const { token } = await createDevice('ws-phone')
    _resetAuthRateLimitForTesting()
    // A header saying "this machine" is no proof: the door has no remote address to trust.
    expect((await viaDoor('/api/v1/status', { 'x-forwarded-for': '127.0.0.1' })).status).toBe(401)
    expect((await viaDoor('/api/v1/status', { 'x-forwarded-for': '127.0.0.1', authorization: `Bearer ${token}` })).status).toBe(200)
    // An upgrade through the door goes to the main server's handler, which asks for the token.
    const refused = await upgradeViaDoor('/ws')
    expect(refused).toMatch(/^HTTP\/1\.1 (401|403)/)
  })

  it('a new pairing\'s QR carries a key for the phone, its id already let in; a revoke takes it out', async () => {
    const r = await call('POST', '/api/devices', { name: 'qr-phone' })
    expect(r.status).toBe(201)
    const param = new URL(r.body.pairingURI.replace('wn://', 'https://x/')).searchParams.get('connect')
    expect(param).toBeTruthy()
    const pc = JSON.parse(Buffer.from(param!, 'base64url').toString('utf8'))
    const me = (await call('GET', '/api/v1/instance', undefined, LAN)).body.instance
    expect(pc).toEqual({ k: expect.stringMatching(/^[0-9a-f]{64}$/), id: MAC_ID, m: 'public', r: [HOME_RELAY], i: me })
    const rec = (await listDeviceRecords()).find((d) => d.name === 'qr-phone')
    expect(rec?.connect?.endpoint).toBe(endpointOfKey(pc.k))
    expect((await connectPhones()).map((p) => p.name)).toContain('qr-phone')
    // A machine credential gets none.
    const machine = await call('POST', '/api/devices', { name: 'qr-machine', kind: 'machine' })
    if (machine.status === 201) expect(machine.body.pairingURI).not.toContain('&connect=')

    expect((await call('DELETE', '/api/devices/qr-phone')).status).toBe(200)
    expect((await connectPhones()).map((p) => p.name)).not.toContain('qr-phone')
  })

  it('a route missing for a passing reason (walnut-net not answering) is not "off"', async () => {
    const { token } = await createDevice('flaky-phone')
    setConnectStatusSourceForTest(async () => { throw new Error('net.status timed out') })
    try {
      const r = await call('GET', '/api/v1/routes', undefined, bearer(token))
      expect(r.body.routes.some((x: { kind: string }) => x.kind === 'connect')).toBe(false)
      expect(r.body).not.toHaveProperty('connectOff')
    } finally {
      setConnectStatusSourceForTest(async () => ({
        running: true, protocol: 3,
        node: { id: MAC_ID, relayMode: 'public', homeRelay: HOME_RELAY, addrs: ['127.0.0.1:4100', '[fe80::1]:4100', '192.168.1.20:4100', '[2601:600::5]:4100'] },
      }))
    }
  })

  it('closes with the host network: a network the user turned off stays off, whatever is paired', async () => {
    const sock = connectDoor()!
    syncNet.mockClear()
    expect((await call('PUT', '/api/config', { net: { enabled: false } })).status).toBe(200)
    await waitFor(() => connectDoor() === null)
    expect(fs.existsSync(sock)).toBe(false)
    // A new pairing neither carries a key nor turns the network back on.
    const r = await call('POST', '/api/devices', { name: 'net-off-phone' })
    expect(r.body.pairingURI).not.toContain('&connect=')
    await new Promise((res) => setTimeout(res, 1_500))
    expect(syncNet.mock.calls.some(([o]) => (o as { enable?: boolean } | undefined)?.enable)).toBe(false)
    const { token } = await createDevice('net-off-reader')
    expect((await call('GET', '/api/v1/routes', undefined, bearer(token))).body.connectOff).toBe(true)
    // On again (the user's own switch): the door opens again.
    expect((await call('PUT', '/api/config', { net: { enabled: true } })).status).toBe(200)
    await waitFor(() => connectDoor() !== null)
  })

  it('closes the door again when turned off, and lists no route', async () => {
    const sock = connectDoor()!
    expect((await setFlag(false)).status).toBe(200)
    await waitFor(() => connectDoor() === null)
    expect(fs.existsSync(sock)).toBe(false)
    const { token } = await createDevice('after-phone')
    const r = await call('GET', '/api/v1/routes', undefined, bearer(token))
    expect(r.body.routes.some((x: { kind: string }) => x.kind === 'connect')).toBe(false)
  })
})
