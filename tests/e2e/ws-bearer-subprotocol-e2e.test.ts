/**
 * A browser off this machine opens /ws with its device token in a subprotocol,
 * never in the URL, through the real startServer (primary mode).
 *
 * The SPA offers `['walnut.v1', 'walnut.bearer.<base64url token>']`
 * (src/lib/ws-bearer-protocol.ts) because a `/ws?token=` URL lands in the access
 * log of every tunnel and proxy on the way. The caller here has the shape of a
 * browser through a tunnel: a loopback socket that says, in X-Forwarded-For, it
 * is somewhere else, with the tunnel's Host and Origin. Real `ws` clients and a
 * raw upgrade for the response headers; only the constants are mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ws-bearer-e2e'))

import { startServer, stopServer } from '../../src/web/server.js'
import { createDevice } from '../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../src/web/middleware/auth-rate-limit.js'
import { encodeBearerProtocol, wsProtocolsFor, WS_APP_PROTOCOL, WS_BEARER_PREFIX } from '../../src/lib/ws-bearer-protocol.js'

const TUNNEL = 'walnut-tunnel.example.net'
/** A browser at the tunnel's address: proxied, so this machine's trust does not apply. */
const REMOTE = { 'X-Forwarded-For': '203.0.113.40', Host: TUNNEL }
const REMOTE_ORIGIN = `https://${TUNNEL}`

let server: HttpServer
let port = 0
let deviceToken = ''
let machineToken = ''

type Opened = { status: 101; protocol: string; ws: WebSocket } | { status: number }

/** A real `ws` client with the given subprotocols: 101 and the protocol it settled on, or the refusal status. */
function open(protocols: string[] | undefined, opts: { path?: string; headers?: Record<string, string> } = {}): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? '/ws'}`, protocols, { origin: REMOTE_ORIGIN, headers: { ...REMOTE, ...opts.headers } })
    ws.once('open', () => resolve({ status: 101, protocol: ws.protocol, ws }))
    ws.once('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); ws.terminate() })
    ws.once('error', (err) => { if (ws.readyState !== WebSocket.OPEN) reject(err) })
  })
}

/** One RPC round trip on an open socket: the server took this client as its own. */
function roundTrip(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as { type?: string; id?: string }
      if (f.type === 'res' && f.id === 'bearer-1') resolve(f.type)
    })
    ws.send(JSON.stringify({ type: 'req', id: 'bearer-1', method: 'no-such-method', payload: {} }))
  })
}

/** A raw upgrade, for the response's own headers (a client library hides a header it did not ask for). */
function rawUpgrade(protocolHeader: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/ws',
      headers: {
        ...REMOTE, Origin: REMOTE_ORIGIN, Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', // A 16-byte nonce, or the server answers 400 before it reads the protocols.
        'Sec-WebSocket-Key': Buffer.from('walnut-bearer-16').toString('base64'),
        'Sec-WebSocket-Protocol': protocolHeader,
      },
    })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: 101, headers: res.headers }) })
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, headers: res.headers }) })
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
  deviceToken = (await createDevice('bearer-phone')).token
  machineToken = (await createDevice('bearer-daemon', { kind: 'machine' })).token
})

afterAll(async () => {
  await stopServer()
})

beforeEach(() => _resetAuthRateLimitForTesting())

describe('/ws with the device token in a subprotocol', () => {
  it('a browser off this machine gets in with the SPA\'s subprotocols, and the answer names walnut.v1', async () => {
    const got = await open(wsProtocolsFor(deviceToken))
    expect(got.status).toBe(101)
    if (got.status !== 101) return
    expect(got.protocol).toBe(WS_APP_PROTOCOL)
    expect(await roundTrip(got.ws)).toBe('res')
    got.ws.close()
  })

  it('the same caller with no credential is refused (the subprotocol is what let it in)', async () => {
    expect((await open([WS_APP_PROTOCOL])).status).toBe(401)
    expect((await open(undefined)).status).toBe(401)
  })

  it('a wrong token, an unreadable entry, and a daemon\'s machine token are 401', async () => {
    expect((await open(wsProtocolsFor('not-a-paired-token'))).status).toBe(401)
    expect((await open([WS_APP_PROTOCOL, `${WS_BEARER_PREFIX}QR`])).status).toBe(401)
    expect((await open(wsProtocolsFor(machineToken))).status).toBe(401)
  })

  it('an unreadable entry is not rescued by a good ?token= beside it', async () => {
    expect((await open([WS_APP_PROTOCOL, `${WS_BEARER_PREFIX}QR`], { path: `/ws?token=${deviceToken}` })).status).toBe(401)
  })

  it('the bearer entry is never echoed back, also when it is offered first', async () => {
    const entry = encodeBearerProtocol(deviceToken)
    const got = await open([entry, WS_APP_PROTOCOL])
    expect(got.status).toBe(101)
    if (got.status === 101) {
      expect(got.protocol).toBe(WS_APP_PROTOCOL)
      got.ws.close()
    }
    const raw = await rawUpgrade(`${entry}, ${WS_APP_PROTOCOL}`)
    expect(raw.status).toBe(101)
    expect(raw.headers['sec-websocket-protocol']).toBe(WS_APP_PROTOCOL)
    expect(JSON.stringify(raw.headers)).not.toContain(entry.slice(WS_BEARER_PREFIX.length))
    // Only the bearer entry offered: the answer names nothing rather than the token.
    const lone = await rawUpgrade(entry)
    expect(lone.status).toBe(101)
    expect(lone.headers['sec-websocket-protocol']).toBeUndefined()
  })

  it('older clients still get in: the legacy ?token= and an Authorization header', async () => {
    const legacy = await open(undefined, { path: `/ws?token=${encodeURIComponent(deviceToken)}` })
    expect(legacy.status).toBe(101)
    if (legacy.status === 101) { expect(legacy.protocol).toBe(''); legacy.ws.close() }
    const header = await open(undefined, { headers: { Authorization: `Bearer ${deviceToken}` } })
    expect(header.status).toBe(101)
    if (header.status === 101) header.ws.close()
  })

  it('this machine\'s own page still connects with no token and no subprotocol', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` })
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    expect(ws.protocol).toBe('')
    ws.close()
  })
})
