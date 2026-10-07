/**
 * The Mac's half of the companion's forward (src/web/v1-forward/target.ts),
 * against a real HTTP server standing in for this server's own routes, and
 * through the relay entry the bridge reaches (handleSessionControlRelay).
 *
 * Pinned: the call acts as a client off this Mac (x-walnut-origin), carries no
 * credential and no Walnut caller header, keeps its body and query; a reply too
 * large for the bridge comes back as `tooLarge`; a call the companion keeps for
 * itself, or a malformed one, is refused before any route runs; a route that
 * does not answer is reported as failed (it may have run), not as refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { setSelfApiRoot } from '../../../src/lib/self-api-root.js'
import { runForwardedCall, ForwardError } from '../../../src/web/v1-forward/target.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'

let server: Server
let root = ''
const hits: string[] = []

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { hits.push(`${req.method} ${req.originalUrl}`); next() })
  app.get('/api/v1/echo', (req, res) => {
    res.setHeader('X-Walnut-API', '1')
    res.json({
      origin: req.headers['x-walnut-origin'] ?? null,
      callerSid: req.headers['x-walnut-caller-sid'] ?? null,
      auth: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null,
      query: req.query,
    })
  })
  app.post('/api/v1/echo', (req, res) => { res.status(201).json({ got: req.body, type: req.headers['content-type'] }) })
  app.get('/api/v1/big', (_req, res) => { res.type('text/plain').send('x'.repeat(300 * 1024)) })
  app.get('/api/v1/edge', (_req, res) => { res.type('text/plain').send('y'.repeat(256 * 1024)) })
  app.get('/api/v1/slow', (_req, res) => { setTimeout(() => res.json({ late: true }), 3_000) })
  app.get('/api/v1/cached', (req, res) => {
    if (req.headers['if-none-match'] === '"v1"') { res.status(304).end(); return }
    res.setHeader('ETag', '"v1"')
    res.json({ fresh: true })
  })
  app.patch('/api/v1/projects/:name', (req, res) => { res.status(409).json({ error: { code: 'conflict', message: `no ${req.params.name}` } }) })
  app.get('/api/v1/tasks', (_req, res) => { res.json({ fromMac: true }) })
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const addr = server.address()
  root = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  setSelfApiRoot(null)
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  hits.length = 0
  setSelfApiRoot(root)
})

const body = (r: { data?: string }) => JSON.parse(Buffer.from(r.data ?? '', 'base64').toString('utf8'))

async function refusal(params: Record<string, unknown>): Promise<ForwardError> {
  try {
    await runForwardedCall(params, 'remote-http')
  } catch (err) {
    expect(err).toBeInstanceOf(ForwardError)
    return err as ForwardError
  }
  throw new Error('expected a refusal')
}

describe('runForwardedCall', () => {
  it('runs the route as a client off this Mac, without any credential or caller header', async () => {
    const r = await runForwardedCall({
      method: 'GET', url: '/api/v1/echo?days=7&q=a%20b',
      headers: {
        accept: 'application/json', authorization: 'Bearer phone-token', cookie: 'a=b',
        'x-walnut-caller-sid': 'aaaaaaaa-1111-4111-8111-111111111111', 'x-walnut-origin': '__local__',
      },
    }, 'remote-http')
    expect(r.status).toBe(200)
    expect(r.headers['x-walnut-api']).toBe('1')
    expect(body(r)).toEqual({ origin: 'remote-http', callerSid: null, auth: null, cookie: null, query: { days: '7', q: 'a b' } })
  })

  it('never acts above a lower relay origin', async () => {
    const r = await runForwardedCall({ method: 'GET', url: '/api/v1/echo' }, 'host:devbox')
    expect(body(r).origin).toBe('host:devbox')
  })

  it('carries a JSON body there and the status back', async () => {
    const payload = Buffer.from(JSON.stringify({ title: 'Caf\u00e9 \u4e2d', n: 2 }))
    const r = await runForwardedCall({
      method: 'POST', url: '/api/v1/echo', headers: { 'content-type': 'application/json' },
      data: payload.toString('base64'), size: payload.byteLength,
    }, 'remote-http')
    expect(r.status).toBe(201)
    expect(body(r)).toEqual({ got: { title: 'Caf\u00e9 \u4e2d', n: 2 }, type: 'application/json' })
  })

  it('passes a domain error through as the route answered it', async () => {
    const r = await runForwardedCall({ method: 'PATCH', url: '/api/v1/projects/Acme', headers: { 'content-type': 'application/json' }, data: Buffer.from('{}').toString('base64'), size: 2 }, 'remote-http')
    expect(r.status).toBe(409)
    expect(body(r).error.code).toBe('conflict')
  })

  it('passes a 304 through with no body', async () => {
    const r = await runForwardedCall({ method: 'GET', url: '/api/v1/cached', headers: { 'if-none-match': '"v1"' } }, 'remote-http')
    expect(r.status).toBe(304)
    expect(r.size).toBe(0)
  })

  it('a reply over the bridge budget comes back as tooLarge, without its body', async () => {
    const r = await runForwardedCall({ method: 'GET', url: '/api/v1/big' }, 'remote-http')
    expect(r).toMatchObject({ status: 200, tooLarge: true })
    expect(r.data).toBeUndefined()
    const edge = await runForwardedCall({ method: 'GET', url: '/api/v1/edge' }, 'remote-http')
    expect(edge.tooLarge).toBeUndefined()
    expect(edge.size).toBe(256 * 1024)
  })

  it('a route that does not answer in time is failed (it may have run), not refused', async () => {
    const err = await refusal({ method: 'GET', url: '/api/v1/slow', timeoutMs: 300 })
    expect(err).toMatchObject({ code: 'forward_failed', status: 504 })
    expect(hits).toEqual(['GET /api/v1/slow'])
  })

  it('a server that is not there is failed too', async () => {
    setSelfApiRoot('http://127.0.0.1:1')
    const err = await refusal({ method: 'GET', url: '/api/v1/echo' })
    expect(err).toMatchObject({ code: 'forward_failed', status: 502 })
  })

  it.each([
    ['a route the companion keeps', { method: 'GET', url: '/api/v1/tasks' }, 400],
    ['a stream', { method: 'GET', url: '/api/v1/events' }, 400],
    ['a path outside /api/v1', { method: 'GET', url: '/api/config' }, 400],
    ['a dot segment', { method: 'GET', url: '/api/v1/notes/%2e%2e/x' }, 400],
    ['an unknown method', { method: 'TRACE', url: '/api/v1/echo' }, 405],
    ['a GET with a body', { method: 'GET', url: '/api/v1/echo', data: Buffer.from('x').toString('base64'), size: 1 }, 400],
    ['a body whose size does not match', { method: 'POST', url: '/api/v1/echo', data: Buffer.from('xyz').toString('base64'), size: 2 }, 400],
    ['a body that is not base64', { method: 'POST', url: '/api/v1/echo', data: '!!!', size: 3 }, 400],
    ['a body over the cap', { method: 'POST', url: '/api/v1/echo', data: 'AAAA', size: 2 * 1024 * 1024 }, 413],
  ])('refuses %s before any route runs', async (_what, params, status) => {
    const err = await refusal(params)
    expect(err).toMatchObject({ code: 'forward_refused', status })
    expect(hits).toEqual([])
  })

  it('refuses while this server is not listening', async () => {
    setSelfApiRoot(null)
    const err = await refusal({ method: 'GET', url: '/api/v1/echo' })
    expect(err).toMatchObject({ code: 'forward_refused', status: 503 })
  })
})

describe('server.http through the relay entry', () => {
  it('answers with the reply', async () => {
    const out = await handleSessionControlRelay('server.http', '__server__', { method: 'GET', url: '/api/v1/echo' }, 'remote-http')
    expect(out.ok).toBe(true)
    if (out.ok) expect(body(out.result as { data?: string }).origin).toBe('remote-http')
  })

  it('a refusal carries its code, which the companion reads as "nothing ran"', async () => {
    const out = await handleSessionControlRelay('server.http', '__server__', { method: 'GET', url: '/api/v1/tasks' }, 'remote-http')
    expect(out).toMatchObject({ ok: false, errorKind: 'bad_request', errorCode: 'forward_refused' })
  })

  it('a failure carries its own code', async () => {
    const out = await handleSessionControlRelay('server.http', '__server__', { method: 'GET', url: '/api/v1/slow', timeoutMs: 200 }, 'remote-http')
    expect(out).toMatchObject({ ok: false, errorKind: 'gateway_timeout', errorCode: 'forward_failed' })
  })
})
