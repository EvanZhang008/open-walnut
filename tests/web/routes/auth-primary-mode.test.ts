/**
 * Primary-mode (non-cloud) /api auth. Only this machine is waived; every other
 * caller, private networks included, presents a device token or an API key.
 * Until 2026-09 any private-network address was waived, so anyone on the same
 * Wi-Fi could drive the API (and open a terminal through /ws).
 *
 * The first block drives the middleware with plain request objects; the second
 * sends real HTTP from this machine's own private IPv4 address.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-auth-primary'))

import { authMiddleware } from '../../../src/web/middleware/auth.js'
import { createDevice } from '../../../src/core/device-auth.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'

type Outcome = { next: boolean; status?: number; body?: any; deviceName?: string; apiKeyName?: string }

async function run(remoteAddress: string, headers: Record<string, string> = {}): Promise<Outcome> {
  const req = { socket: { remoteAddress, localPort: 3456 }, ip: remoteAddress, headers, path: '/tasks' } as Record<string, unknown>
  const out: Outcome = { next: false }
  const res = {
    status(code: number) { out.status = code; return res },
    json(body: unknown) { out.body = body; return res },
  }
  await authMiddleware(req as never, res as never, () => { out.next = true })
  out.deviceName = req.deviceName as string | undefined
  out.apiKeyName = req.apiKeyName as string | undefined
  return out
}

let deviceToken = ''
let machineToken = ''
const API_KEY = 'wlnt_sk_primary_mode_test'

beforeAll(async () => {
  deviceToken = (await createDevice('test-phone')).token
  machineToken = (await createDevice('test-daemon', { kind: 'machine' })).token
  await updateConfig({ api_keys: [{ name: 'script', key: API_KEY, created_at: new Date().toISOString() }] })
})

beforeEach(() => _resetAuthRateLimitForTesting())

describe('authMiddleware, primary mode', () => {
  it('waives this machine: the CLI, the browser, the Mac app, the Vite dev proxy', async () => {
    expect(await run('127.0.0.1', { host: '127.0.0.1:3456' })).toMatchObject({ next: true })
    expect(await run('::1', { host: 'localhost:3456', origin: 'http://localhost:3456' })).toMatchObject({ next: true })
    // The dev proxy restates its own pages' Origin as its target's (web/dev-proxy-origin.ts).
    expect(await run('::ffff:127.0.0.1', { host: 'localhost:3456', origin: 'http://localhost:3456' })).toMatchObject({ next: true })
  })

  it('401 bodies carry the code the web console keys its notice on', async () => {
    expect((await run('192.168.1.20')).body).toMatchObject({ code: 'not_paired' })
    expect((await run('192.168.1.20', { authorization: 'Bearer nope' })).body).toMatchObject({ code: 'token_refused' })
  })

  it('still identifies a local caller that presents a token', async () => {
    const out = await run('127.0.0.1', { host: 'localhost:3456', authorization: `Bearer ${deviceToken}` })
    expect(out).toMatchObject({ next: true, deviceName: 'test-phone' })
  })

  it('a private-network caller without a token is refused 401 (the old waiver is gone)', async () => {
    for (const addr of ['192.168.1.20', '10.0.0.2', '172.16.4.4', '::ffff:192.168.1.20']) {
      const out = await run(addr, { host: '192.168.1.5:3456' })
      expect(out).toMatchObject({ next: false, status: 401 })
      expect(out.body.error).toMatch(/Authentication required/)
    }
  })

  it('a private-network caller with a device token or an API key passes and is identified', async () => {
    expect(await run('192.168.1.20', { authorization: `Bearer ${deviceToken}` })).toMatchObject({ next: true, deviceName: 'test-phone', apiKeyName: 'test-phone' })
    expect(await run('10.0.0.2', { authorization: `Bearer ${API_KEY}` })).toMatchObject({ next: true, apiKeyName: 'script', deviceName: undefined })
    expect(await run('203.0.113.7', { authorization: `Bearer ${deviceToken}` })).toMatchObject({ next: true })
  })

  it('machine tokens, junk, and a bare token without "Bearer" are refused 401', async () => {
    expect(await run('192.168.1.20', { authorization: `Bearer ${machineToken}` })).toMatchObject({ next: false, status: 401 })
    expect(await run('192.168.1.20', { authorization: 'Bearer 00000000000000000000000000000000' })).toMatchObject({ next: false, status: 401 })
    expect(await run('192.168.1.20', { authorization: deviceToken })).toMatchObject({ next: false, status: 401 })
  })

  it('a caller behind a local proxy or tunnel needs a token even on a loopback socket', async () => {
    expect(await run('127.0.0.1', { host: 'localhost:3456', 'x-forwarded-for': '203.0.113.9' })).toMatchObject({ next: false, status: 401 })
    expect(await run('127.0.0.1', { host: 'localhost:3456', 'x-forwarded-for': '203.0.113.9', authorization: `Bearer ${deviceToken}` })).toMatchObject({ next: true })
  })

  it('a page from another site is refused 403 with a reason, unless it holds a token', async () => {
    const csrf = await run('127.0.0.1', { host: 'localhost:3456', origin: 'https://evil.example' })
    expect(csrf).toMatchObject({ next: false, status: 403 })
    expect(csrf.body.error).toMatch(/another site/)
    expect(await run('127.0.0.1', { host: 'evil.example:3456' })).toMatchObject({ next: false, status: 403 }) // DNS rebinding
    expect(await run('127.0.0.1', { host: 'localhost:3456', origin: 'null' })).toMatchObject({ next: false, status: 403 })
    expect(await run('127.0.0.1', { host: 'localhost:3456', origin: 'http://127.0.0.1:8080' })).toMatchObject({ next: false, status: 403 }) // another local port
    expect(await run('127.0.0.1', { host: 'localhost:3456', origin: 'https://evil.example', authorization: `Bearer ${deviceToken}` })).toMatchObject({ next: true })
  })

  it('rate-limits wrong tokens per address: 10 failures, then 429 even for a right one', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await run('192.168.1.66', { authorization: `Bearer wrong-${i}` })).status).toBe(401)
    }
    expect(await run('192.168.1.66', { authorization: `Bearer ${deviceToken}` })).toMatchObject({ next: false, status: 429 })
    // Another address is unaffected, and a missing token never feeds the limiter.
    expect(await run('192.168.1.67', { authorization: `Bearer ${deviceToken}` })).toMatchObject({ next: true })
    for (let i = 0; i < 12; i++) expect((await run('192.168.1.68')).status).toBe(401)
    expect(await run('192.168.1.68', { authorization: `Bearer ${deviceToken}` })).toMatchObject({ next: true })
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

describe.skipIf(!LAN_IP)('real HTTP from this machine\'s own LAN address', () => {
  let server: http.Server
  let port = 0

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', authMiddleware)
    app.get('/api/ping', (_req, res) => { res.json({ ok: true }) })
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function get(host: string, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host, port, path: '/api/ping', headers, localAddress: host }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('401 from the LAN without a token, 200 with one, 200 from loopback', async () => {
    expect(await get(LAN_IP!)).toBe(401)
    expect(await get(LAN_IP!, { authorization: `Bearer ${deviceToken}` })).toBe(200)
    expect(await get('127.0.0.1')).toBe(200)
  })
})
