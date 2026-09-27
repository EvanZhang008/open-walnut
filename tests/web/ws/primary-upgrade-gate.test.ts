/**
 * /ws on a primary (non-cloud) server, through the real startServer. /ws carries
 * terminal:open and session:start, and until 2026-09 its upgrade had no gate at
 * all outside cloud mode: anyone on the same Wi-Fi, or any web page the user
 * opened (a WebSocket is never stopped by CORS), could open a terminal.
 *
 * Now the upgrade follows the HTTP rule: this machine's own pages connect
 * freely, a page from another site is refused by its Origin (403), and every
 * other caller needs a device token (401 without one). Also pins the paste
 * spill route behind auth: it used to be mounted before the auth middleware.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'node:http'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-primary-ws-gate'))

import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'

let server: HttpServer
let port = 0
let deviceToken = ''
let machineToken = ''

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

/** Send a raw WebSocket upgrade; resolves 101 on success, else the refusal status. */
function upgrade(from: string, opts: { path?: string; headers?: Record<string, string> } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: from,
      port,
      path: opts.path ?? '/ws',
      localAddress: from,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('walnut-gate-test').toString('base64'),
        ...opts.headers,
      },
    })
    req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101) })
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', (err) => {
      // The gate answers with a raw status line and then destroys the socket.
      reject(err)
    })
    req.end()
  })
}

function post(from: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      host: from, port, path, method: 'POST', localAddress: from,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)), ...headers },
    }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let parsed: unknown = text
        try { parsed = JSON.parse(text) } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('error', reject)
    req.end(data)
  })
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  deviceToken = (await createDevice('gate-phone')).token
  machineToken = (await createDevice('gate-daemon', { kind: 'machine' })).token
})

afterAll(async () => {
  await stopServer()
})

beforeEach(() => _resetAuthRateLimitForTesting())

describe('/ws upgrade from this machine', () => {
  it('opens for a local client and for this server\'s own pages', async () => {
    expect(await upgrade('127.0.0.1')).toBe(101)
    expect(await upgrade('127.0.0.1', { headers: { Origin: `http://localhost:${port}` } })).toBe(101)
    expect(await upgrade('127.0.0.1', { headers: { Origin: `http://127.0.0.1:${port}`, Host: 'localhost:5173' } })).toBe(101)
  })

  it('refuses a page on another local port with 403 (a dev server, a forwarded service)', async () => {
    expect(await upgrade('127.0.0.1', { headers: { Origin: 'http://localhost:5173' } })).toBe(403)
    expect(await upgrade('127.0.0.1', { headers: { Origin: `http://127.0.0.1:${port + 1}` } })).toBe(403)
  })

  it('a peer that resets the socket mid-check does not take the server down', async () => {
    const net = await import('node:net')
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port }, () => {
          s.write([
            `GET /ws?token=${encodeURIComponent(deviceToken)} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
            'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Key: d2FsbnV0LWdhdGUtdGVzdA==', 'X-Forwarded-For: 203.0.113.9', '', '',
          ].join('\r\n'))
          s.resetAndDestroy() // RST while the token check is still reading auth.json
          resolve()
        })
        s.on('error', () => resolve())
      })
    }
    // Malformed Host: `new URL` used to throw out of the upgrade handler.
    await new Promise<void>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.write('GET /ws HTTP/1.1\r\nHost: a b\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: d2FsbnV0LWdhdGUtdGVzdA==\r\n\r\n')
        s.on('close', () => resolve())
        s.on('error', () => resolve())
      })
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(await upgrade('127.0.0.1')).toBe(101) // still serving
  })

  it('a real ws client opens and answers an RPC round trip', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` })
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    const reply = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>
        if (f.type === 'res' && f.id === 'gate-1') resolve(f)
      })
    })
    ws.send(JSON.stringify({ type: 'req', id: 'gate-1', method: 'no-such-method', payload: {} }))
    expect((await reply).type).toBe('res')
    ws.close()
  })

  it('refuses a page from another site and a DNS-rebound name with 403', async () => {
    expect(await upgrade('127.0.0.1', { headers: { Origin: 'https://evil.example' } })).toBe(403)
    expect(await upgrade('127.0.0.1', { headers: { Origin: 'null' } })).toBe(403)
    expect(await upgrade('127.0.0.1', { headers: { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` } })).toBe(403)
    expect(await upgrade('127.0.0.1', { headers: { Host: `0.0.0.0:${port}` } })).toBe(403)
  })

  it('a local proxy or tunnel (X-Forwarded-For) needs a token', async () => {
    expect(await upgrade('127.0.0.1', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).toBe(401)
    expect(await upgrade('127.0.0.1', { path: `/ws?token=${deviceToken}`, headers: { 'X-Forwarded-For': '203.0.113.9' } })).toBe(101)
  })
})

describe.skipIf(!LAN_IP)('/ws upgrade and /api from this machine\'s own LAN address', () => {
  it('401 without a token; 101 with a device token in ?token= or the Authorization header', async () => {
    expect(await upgrade(LAN_IP!)).toBe(401)
    expect(await upgrade(LAN_IP!, { headers: { Origin: `http://${LAN_IP}:${port}` } })).toBe(401)
    expect(await upgrade(LAN_IP!, { path: `/ws?token=${encodeURIComponent(deviceToken)}` })).toBe(101)
    expect(await upgrade(LAN_IP!, { headers: { Authorization: `Bearer ${deviceToken}` } })).toBe(101)
  })

  it('refuses a daemon machine token and junk with 401, then rate-limits', async () => {
    expect(await upgrade(LAN_IP!, { path: `/ws?token=${machineToken}` })).toBe(401)
    for (let i = 0; i < 9; i++) expect(await upgrade(LAN_IP!, { path: `/ws?token=junk-${i}` })).toBe(401)
    expect(await upgrade(LAN_IP!, { path: `/ws?token=${encodeURIComponent(deviceToken)}` })).toBe(429)
  })

  it('the paste spill route is behind auth: 401 from the LAN, 200 with a token or from loopback', async () => {
    expect((await post(LAN_IP!, '/api/pastes', { text: 'x'.repeat(10) })).status).toBe(401)
    const withToken = await post(LAN_IP!, '/api/pastes', { text: 'from a paired phone' }, { Authorization: `Bearer ${deviceToken}` })
    expect(withToken).toMatchObject({ status: 200, body: { chars: 19 } })
    expect((await post('127.0.0.1', '/api/pastes', { text: 'from this machine' })).status).toBe(200)
  })

  it('an ordinary API read is 401 from the LAN, 200 with a token', async () => {
    const get = (headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
      const req = http.request({ host: LAN_IP!, port, path: '/api/tasks', localAddress: LAN_IP!, headers }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end()
    })
    expect(await get()).toBe(401)
    expect(await get({ Authorization: `Bearer ${deviceToken}` })).toBe(200)
  })
})
