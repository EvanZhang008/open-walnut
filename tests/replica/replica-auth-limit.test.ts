/**
 * The auth limit of a host replica (src/replica/auth.ts). Every caller reaches
 * it through the tunnel over loopback, so a limit keyed by address is either
 * dodged (a new X-Forwarded-For per try) or turned on the user (a stranger's
 * wrong tokens lock every tunnel client out). Wrong tokens share one bucket,
 * and a token in the device copy always passes, on /api and on the /ws upgrade.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Request, Response } from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'
import { sha256 } from '../helpers/replica-host-env.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-auth-limit'))

import { _resetReplicaAuthForTesting, replicaAuthMiddleware, replicaDeviceCopy, replicaRefusal, verifyReplicaToken, verifyReplicaUpgrade } from '../../src/replica/auth.js'
import { createDispatcher, OFFLINE_HEADER } from '../../src/replica/dispatch.js'
import type { RouteDecision } from '../../src/replica/route-table.js'
import http from 'node:http'
import type net from 'node:net'
import { _resetAuthRateLimitForTesting } from '../../src/web/middleware/auth-rate-limit.js'

const PHONE_TOKEN = 'marina-phone-token'

/** One /api call: the status it answered (200 = passed to next). */
async function call(token: string | null, ip: string): Promise<number> {
  const req = {
    method: 'GET', path: '/v1/tasks', ip, socket: { remoteAddress: '127.0.0.1' },
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as Request
  let status = 0
  const res = { status(n: number) { status = n; return res }, json() { return res } } as unknown as Response
  let passed = false
  await replicaAuthMiddleware(req, res, (() => { passed = true }) as NextFunction)
  return passed ? 200 : status
}

beforeEach(() => {
  _resetAuthRateLimitForTesting()
  _resetReplicaAuthForTesting()
  expect(replicaDeviceCopy().put({ devices: [{ name: 'marina-phone', tokenHash: sha256(PHONE_TOKEN) }] })).toMatchObject({ ok: true })
})

describe('host replica auth limit', () => {
  it('a new forwarded address per try does not dodge the limit', async () => {
    const got: number[] = []
    for (let i = 0; i < 12; i++) got.push(await call(`guess-${i}`, `203.0.113.${i}`))
    expect(got.slice(0, 10)).toEqual(Array(10).fill(401))
    expect(got.slice(10)).toEqual([429, 429])
  })

  it('a stranger\'s wrong tokens never refuse the phone\'s good token, on /api or the /ws upgrade', async () => {
    for (let i = 0; i < 15; i++) await call(`guess-${i}`, '127.0.0.1')
    expect(await call('guess-x', '127.0.0.1')).toBe(429)
    expect(await verifyReplicaUpgrade('guess-y')).toBe(429)
    // The phone, through the same tunnel (same address), right after.
    expect(await call(PHONE_TOKEN, '127.0.0.1')).toBe(200)
    expect(await verifyReplicaUpgrade(PHONE_TOKEN)).toBe('ok')
  })

  it('the /ws upgrade counts into the same bucket as /api', async () => {
    for (let i = 0; i < 10; i++) expect(await verifyReplicaUpgrade(`ws-guess-${i}`)).toBe(401)
    expect(await call('api-guess', '198.51.100.7')).toBe(429)
  })

  it('no token is a first contact, never counted', async () => {
    for (let i = 0; i < 20; i++) expect(await call(null, '127.0.0.1')).toBe(401)
    expect(await call('one-guess', '127.0.0.1')).toBe(401)
  })
})

/**
 * The dispatcher runs before the auth middleware (src/replica/dispatch.ts): its
 * away answers use the same rule. A wrong token on an away write is counted in
 * the same bucket (429 once full), and the Mac's last-heard time
 * (x-walnut-offline, when it went to sleep) goes to a known device only.
 */
describe('the dispatcher\'s away answers', () => {
  const AS_OF = 1_700_000_000_000
  const rows: Record<string, RouteDecision> = {
    'POST /api/queued/x': { cls: 'leader', away: 'queue:acme', row: null },
    'POST /api/mac-only': { cls: 'leader', away: 'needs-leader', why: 'needs_mac', row: null },
    'GET /api/tasks': { cls: 'leader', away: 'read', row: null },
  }
  const dispatcher = createDispatcher({
    route: () => ({ kind: 'alone', why: 'mac-away' }),
    asOf: () => AS_OF,
    connect: async () => { throw new Error('no stream') },
    suspect: () => {},
    answerAlone: (_req, res) => { res.writeHead(200); res.end('alone') },
    followerOp: async () => ({ ok: true }),
    ownUpgrade: (_req, socket) => { socket.destroy() },
    log: () => {},
    authorized: (req) => {
      const h = req.headers.authorization
      return typeof h === 'string' && h.startsWith('Bearer ') && verifyReplicaToken(h.slice(7)) !== null
    },
    refuse: (req) => replicaRefusal(req.headers.authorization),
    classify: (method, p) => rows[`${method} ${p}`] ?? { cls: 'local', away: 'read', row: null },
  })
  // The auth middleware after the dispatcher: a read that passes it is answered 200.
  const server = http.createServer((req, res) => dispatcher.middleware(req, res, () => {
    void replicaAuthMiddleware(
      Object.assign(req, { path: (req.url ?? '').replace(/^\/api/, '') }) as unknown as Request,
      Object.assign(res, {
        status(n: number) { res.statusCode = n; return res },
        json(b: unknown) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); return res },
      }) as unknown as Response,
      (() => { req.resume(); res.writeHead(200); res.end('{}') }) as NextFunction,
    )
  }))
  let port = 0
  beforeAll(async () => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r())); port = (server.address() as net.AddressInfo).port })
  afterAll(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) })

  function send(method: string, p: string, token: string | null): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const body = method === 'GET' ? null : Buffer.from('{}')
      const req = http.request({
        host: '127.0.0.1', port, method, path: p, agent: false,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}) },
      }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers })) })
      req.on('error', reject)
      req.end(body ?? undefined)
    })
  }

  it('wrong tokens on an away write fill the shared bucket: 401 ten times, then 429, on /api too', async () => {
    const got: number[] = []
    for (let i = 0; i < 11; i++) got.push((await send('POST', '/api/queued/x', `guess-${i}`)).status)
    expect(got.slice(0, 10)).toEqual(Array(10).fill(401))
    expect(got[10]).toBe(429)
    expect(await call('api-guess', '127.0.0.1')).toBe(429)
    // The phone's good token still passes.
    expect((await send('POST', '/api/queued/x', PHONE_TOKEN)).status).toBe(200)
  })

  it('no token on an away write is a first contact: 401, never counted', async () => {
    for (let i = 0; i < 12; i++) expect((await send('POST', '/api/queued/x', null)).status).toBe(401)
    expect(await call('one-guess', '127.0.0.1')).toBe(401)
  })

  it('x-walnut-offline goes to a known device only, on a needs_leader 503 and on an away read', async () => {
    const mine = await send('POST', '/api/mac-only', PHONE_TOKEN)
    expect(mine.status).toBe(503)
    expect(mine.headers[OFFLINE_HEADER]).toBe(String(AS_OF))
    for (const token of [null, 'stranger-token']) {
      const theirs = await send('POST', '/api/mac-only', token)
      expect(theirs.status).toBe(503)
      expect(theirs.headers[OFFLINE_HEADER]).toBeUndefined()
      const read = await send('GET', '/api/tasks', token)
      expect(read.status).toBe(401)
      expect(read.headers[OFFLINE_HEADER]).toBeUndefined()
    }
    const ok = await send('GET', '/api/tasks', PHONE_TOKEN)
    expect(ok.status).toBe(200)
    expect(ok.headers[OFFLINE_HEADER]).toBe(String(AS_OF))
  })
})
