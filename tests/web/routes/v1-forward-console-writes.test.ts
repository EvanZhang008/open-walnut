/**
 * The web console's task-store writes on the companion (replica plan WP13, "one writer
 * while the Mac answers"): src/web/v1-forward/proxy.ts consoleMiddleware on the
 * companion, the exact list in policy.ts (CONSOLE_TASK_WRITES), and the Mac's two doors
 * for it (stream-door.ts on a stream, target.ts for a server.http frame).
 *
 * Pinned:
 *   - while the Mac answers, a listed console write goes to the Mac and its answer comes
 *     back as it came; this server's own route never runs (nothing applied here first);
 *   - away, or refused by an older Mac, or this server's own call: the companion's own
 *     route runs, as before (its local write then goes to the Mac as an op or queued);
 *   - a forward that went out unanswered is a 504 with `sent: true` (the web client does
 *     not retry it) and runs nothing here, and the next write waits for the Mac no more;
 *   - a console read, and a write not on the list, never leave the companion;
 *   - while this box still holds task writes for the Mac (queued, or a live op on its
 *     way), a new task write, console or phone, runs here behind them, in order;
 *   - on the Mac, only the listed writes are run; every other call under /api/tasks and
 *     /api/focus is refused at both doors. A ratchet walks the two routers the Mac mounts
 *     there, so a route added later is refused until it is listed on purpose;
 *   - no credential, cookie or caller header of the companion's request reaches the route.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express, { type Router } from 'express'
import request from 'supertest'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-console-writes'))

import { createV1Forward, type CallOutcome, type PrimarySnapshot } from '../../../src/web/v1-forward/proxy.js'
import { CONSOLE_TASK_WRITES, parseConsoleTaskWrite } from '../../../src/web/v1-forward/policy.js'
import { createCompanionDoor } from '../../../src/web/v1-forward/stream-door.js'
import { checkForwardTarget } from '../../../src/web/v1-forward/target.js'
import { runForwardedCall, ForwardError } from '../../../src/web/v1-forward/target.js'
import { setSelfApiRoot } from '../../../src/lib/self-api-root.js'
import { createStreamRelay } from '../../../src/providers/stream-relay-core.js'
import { createStreamEndpoint, type StreamEndpoint } from '../../../src/lib/link-stream.js'
import { tasksRouter } from '../../../src/web/routes/tasks.js'
import { focusRouter } from '../../../src/web/routes/focus.js'
import { leaderRouter } from '../../../src/web/routes/leader.js'
import { replicasStatusRouter } from '../../../src/web/routes/replicas-status.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

const fresh = (over: Partial<PrimarySnapshot> = {}): PrimarySnapshot => ({
  bridge: true, heard: true, lastSeenAt: Date.now() - 1_000, leading: 0, backupAllowed: true, takeoverMs: 60_000, ...over,
})

const reply = (status: number, value: unknown): CallOutcome => {
  const buf = Buffer.from(JSON.stringify(value))
  return { ok: true, result: { status, headers: { 'content-type': 'application/json; charset=utf-8' }, size: buf.byteLength, data: buf.toString('base64') } }
}

/** The companion: the console middleware in front of a stand-in for its own task routes. */
function companion(opts: { primary?: () => PrimarySnapshot | null; call?: (p: Record<string, unknown>) => Promise<CallOutcome>; ownToken?: string; stream?: { capable: () => boolean; open: () => Promise<import('node:stream').Duplex> }; pending?: () => boolean } = {}) {
  const calls: Array<Record<string, unknown>> = []
  const localRuns: string[] = []
  const fwd = createV1Forward({
    now: () => Date.now(),
    enabled: () => true,
    ownCall: (req) => opts.ownToken !== undefined && req.headers.authorization === `Bearer ${opts.ownToken}`,
    primary: async () => (opts.primary ? opts.primary() : fresh()),
    call: async (params) => { calls.push(params); return opts.call ? opts.call(params) : reply(201, { from: 'mac', task: { id: 'k-mac-1' } }) },
    ...(opts.stream ? { stream: opts.stream } : {}),
    ...(opts.pending ? { taskWritesPending: opts.pending } : {}),
  })
  const app = express()
  app.use(express.json())
  app.use(['/api/tasks', '/api/focus'], fwd.consoleMiddleware)
  // The phone's /api/v1 beside it, the same forward instance.
  app.use('/api/v1', fwd.middleware)
  app.all('/api/v1/*rest', (req, res) => {
    localRuns.push(`${req.method} ${req.originalUrl}`)
    res.status(200).json({ from: 'companion' })
  })
  // The companion's own routes: a local write (that the task-outbox subscriber would send on).
  app.all(['/api/tasks', '/api/tasks/*rest', '/api/focus/*rest'], (req, res) => {
    localRuns.push(`${req.method} ${req.originalUrl}`)
    res.status(200).json({ from: 'companion' })
  })
  return { app, fwd, calls, localRuns }
}

describe('the console\'s task writes on the companion', () => {
  it('while the Mac answers, a listed write goes to the Mac and nothing runs here', async () => {
    const h = companion()
    const created = await request(h.app).post('/api/tasks').set('Authorization', 'Bearer phone').send({ title: 'Marina harbour plan', client_request_id: 'c-1' })
    expect(created.status).toBe(201)
    expect(created.body).toEqual({ from: 'mac', task: { id: 'k-mac-1' } })
    expect(created.headers['x-walnut-answered-by']).toBe('primary')
    for (const [method, url] of [['patch', '/api/tasks/k-mac-1'], ['post', '/api/tasks/k-mac-1/complete'], ['delete', '/api/tasks/k-mac-1'], ['put', '/api/focus/tasks/k-mac-1/tier'], ['patch', '/api/tasks/reorder']] as const) {
      expect((await request(h.app)[method](url).send({ priority: 'important' })).headers['x-walnut-answered-by']).toBe('primary')
    }
    expect(h.localRuns).toEqual([])
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/tasks', 'PATCH /api/tasks/k-mac-1', 'POST /api/tasks/k-mac-1/complete', 'DELETE /api/tasks/k-mac-1',
      'PUT /api/focus/tasks/k-mac-1/tier', 'PATCH /api/tasks/reorder',
    ])
    // The body goes as it came; a write waits the write budget.
    expect(JSON.parse(Buffer.from(String(h.calls[0].data), 'base64').toString('utf8'))).toEqual({ title: 'Marina harbour plan', client_request_id: 'c-1' })
    expect(h.calls[0].timeoutMs).toBe(23_000)
    expect(JSON.stringify(h.calls[0].headers)).not.toMatch(/phone|authorization/i)
    expect(h.fwd.status().forwarded).toBe(6)
  })

  it('a console read and a write not on the list never leave the companion', async () => {
    const h = companion()
    await request(h.app).get('/api/tasks')
    await request(h.app).get('/api/focus/tasks')
    await request(h.app).post('/api/tasks/k1/merge').send({ victim_ids: ['k2'] })
    await request(h.app).put('/api/tasks/k1/plugin-field').send({ pluginId: 'p', key: 'k', value: 'v' })
    await request(h.app).delete('/api/tasks/k1?force=true')
    await request(h.app).post('/api/tasks/quick-parse').send({ text: 'x' })
    await request(h.app).post('/api/tasks/folders').send({ label: 'f', project: 'Acme' })
    await request(h.app).post('/api/focus/tiers').send({ label: 'Later' })
    expect(h.calls).toEqual([])
    expect(h.localRuns).toHaveLength(8)
  })

  it('away: the companion\'s own route runs, as before', async () => {
    for (const snapshot of [fresh({ bridge: false }), fresh({ lastSeenAt: Date.now() - 600_000 }), fresh({ leading: 1 }), fresh({ heard: false }), null]) {
      const h = companion({ primary: () => snapshot })
      const r = await request(h.app).patch('/api/tasks/k1').send({ title: 'away' })
      expect(r.body).toEqual({ from: 'companion' })
      expect(r.headers['x-walnut-answered-by']).toBe('companion')
      expect(h.calls).toEqual([])
      expect(h.localRuns).toEqual(['PATCH /api/tasks/k1'])
    }
  })

  it('an older Mac refuses the path: the companion\'s own route runs, as before', async () => {
    const h = companion({ call: async () => ({ ok: false, failure: { kind: 'error', status: 400, code: 'forward_refused', message: 'Invalid forwarded path' } }) })
    const r = await request(h.app).post('/api/tasks').send({ title: 'Acme launch checklist' })
    expect(r.body).toEqual({ from: 'companion' })
    expect(h.calls).toHaveLength(1)
    expect(h.localRuns).toEqual(['POST /api/tasks'])
    // Not a suspect Mac: the next write is asked again.
    expect(h.fwd.status().suspectAt).toBeNull()
  })

  it('while this box still holds task writes for the Mac, a new task write runs here behind them, in order', async () => {
    let pending = true
    const h = companion({ pending: () => pending })
    // Console and phone task writes alike: they would overtake the queued ones on the forward.
    expect((await request(h.app).patch('/api/tasks/k1').send({ title: 'behind the queue' })).body).toEqual({ from: 'companion' })
    expect((await request(h.app).post('/api/tasks/k1/complete')).body).toEqual({ from: 'companion' })
    expect((await request(h.app).patch('/api/v1/tasks/k1').send({ title: 'phone, behind the queue' })).body).toEqual({ from: 'companion' })
    expect((await request(h.app).put('/api/v1/focus/reorder').send({ task_ids: ['k1'] })).body).toEqual({ from: 'companion' })
    expect(h.calls).toEqual([])
    expect(h.fwd.status().answeredHere['queue-first']).toBe(4)
    // A write that is not of the task store does not wait on the task queue.
    expect((await request(h.app).put('/api/v1/memory/user').send({ content: 'x' })).headers['x-walnut-answered-by']).toBe('primary')
    // The queue drained: the Mac is the one writer again.
    pending = false
    expect((await request(h.app).patch('/api/tasks/k1').send({ title: 'to the Mac' })).headers['x-walnut-answered-by']).toBe('primary')
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['PUT /api/v1/memory/user', 'PATCH /api/tasks/k1'])
    expect(h.localRuns).toEqual(['PATCH /api/tasks/k1', 'POST /api/tasks/k1/complete', 'PATCH /api/v1/tasks/k1', 'PUT /api/v1/focus/reorder'])
  })

  it('this server\'s own call keeps its own path', async () => {
    const h = companion({ ownToken: 'self-token' })
    expect((await request(h.app).patch('/api/tasks/k1').set('Authorization', 'Bearer self-token').send({ title: 'x' })).body).toEqual({ from: 'companion' })
    expect(h.calls).toEqual([])
  })

  it('a forward that went out unanswered is a 504 with sent: true and runs nothing here; the next write is not held on the Mac', async () => {
    let lastSeenAt = Date.now() - 1_000
    const h = companion({ primary: () => fresh({ lastSeenAt }), call: async () => ({ ok: false, failure: { kind: 'bridge_offline', message: 'timed out', notSent: false } }) })
    const r = await request(h.app).patch('/api/tasks/k1').send({ title: 'maybe applied' })
    expect(r.status).toBe(504)
    expect(r.body.error).toMatchObject({ code: 'primary_timeout', sent: true })
    expect(h.localRuns).toEqual([])
    expect(h.fwd.status().unanswered).toBe(1)
    // The Mac is suspect until it is heard again: the next write runs here at once.
    const next = await request(h.app).patch('/api/tasks/k2').send({ title: 'next' })
    expect(next.body).toEqual({ from: 'companion' })
    expect(h.localRuns).toEqual(['PATCH /api/tasks/k2'])
    expect(h.calls).toHaveLength(1)
    lastSeenAt = Date.now() + 1_000
    await request(h.app).patch('/api/tasks/k3').send({ title: 'heard again' })
    expect(h.calls).toHaveLength(2)
  })
})

// The Mac's side: both doors, over the real pieces.

/** The Mac's own task routes: echo what crossed. */
async function macRoutes() {
  const seen: Array<Record<string, unknown>> = []
  const app = express()
  app.use(express.json())
  app.all(['/api/tasks', '/api/tasks/*rest', '/api/focus/*rest'], (req, res) => {
    seen.push({
      method: req.method, path: req.originalUrl, origin: req.headers['x-walnut-origin'] ?? null,
      auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null,
      callerSid: req.headers['x-walnut-caller-sid'] ?? null, opId: req.headers['x-walnut-op-id'] ?? null, body: req.body ?? null,
    })
    res.status(req.method === 'POST' ? 201 : 200).json({ task: { id: 'k-mac-1', title: 'on the Mac' } })
  })
  const server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { port: (server.address() as net.AddressInfo).port, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
}

type RelayLink = { ep: StreamEndpoint | null }

/** The companion's bridge and the Mac's link on one in-memory daemon, the Mac's door behind it. */
function streamPair(root: () => string | null) {
  const relay = createStreamRelay<RelayLink>({ send: (link, ev, data) => { queueMicrotask(() => link.ep?.handle({ ev, ...data })) }, log: () => {} })
  const bridge: RelayLink = { ep: null }
  const primary: RelayLink = { ep: null }
  const daemonGets = (from: RelayLink) => (frame: Record<string, unknown>) => {
    queueMicrotask(() => {
      const cmd = String(frame.cmd)
      if (cmd === 'stream.open') relay.open(from, frame.sid, from === bridge && frame.to === 'primary' ? primary : null, { from: 'companion' }, 'the companion opens streams to the primary only')
      else relay.frame(from, cmd.slice('stream.'.length), frame)
    })
  }
  const door = createCompanionDoor({ root })
  bridge.ep = createStreamEndpoint({ send: daemonGets(bridge), openTimeoutMs: 2_000 })
  primary.ep = createStreamEndpoint({ send: daemonGets(primary), openTimeoutMs: 2_000, accept: (info) => (info.from === 'companion' ? (s) => door.accept(s, 'remote-http') : null) })
  return { door, open: () => bridge.ep!.open('primary', { purpose: 'web' }) }
}

/** A raw request on a stream to the Mac's door, as any sender could write one. */
function rawOnStream(open: () => Promise<import('node:stream').Duplex>, method: string, url: string, headers: Record<string, string> = {}): Promise<{ status: number; refused: unknown }> {
  return open().then((s) => new Promise((resolve, reject) => {
    const req = http.request({ method, path: url, headers: { host: 'primary', 'content-type': 'application/json', ...headers }, createConnection: () => s } as http.RequestOptions, (res) => {
      res.resume()
      res.on('end', () => { s.destroy(); resolve({ status: res.statusCode ?? 0, refused: res.headers['x-walnut-forward-refused'] ?? null }) })
    })
    req.on('error', reject)
    req.end('{}')
  }))
}

describe('the Mac runs only the listed console writes, at both doors', () => {
  let mac: Awaited<ReturnType<typeof macRoutes>>
  const closers: Array<() => unknown> = []
  beforeAll(async () => { mac = await macRoutes() })
  afterAll(async () => { for (const c of closers) await c(); setSelfApiRoot(null); await mac.close() })

  it('on a stream: the companion\'s console write reaches the route as a paired client; no token, cookie or caller header crosses', async () => {
    const pair = streamPair(() => `http://127.0.0.1:${mac.port}`)
    closers.push(() => pair.door.close())
    const h = companion({ stream: { capable: () => true, open: pair.open } })
    const r = await request(h.app).patch('/api/tasks/k-mac-1')
      .set('Authorization', 'Bearer phone-token').set('Cookie', 'session=abc')
      .set('x-walnut-caller-sid', 'aaaaaaaa-1111-4111-8111-111111111111')
      .send({ title: 'Caf\u00e9 \u4e2d plan' })
    expect(r.status).toBe(200)
    expect(r.headers['x-walnut-answered-by']).toBe('primary')
    expect(r.body).toEqual({ task: { id: 'k-mac-1', title: 'on the Mac' } })
    expect(mac.seen.at(-1)).toEqual({
      method: 'PATCH', path: '/api/tasks/k-mac-1', origin: 'remote-http', auth: null, cookie: null, callerSid: null, opId: null,
      body: { title: 'Caf\u00e9 \u4e2d plan' },
    })
    expect(h.localRuns).toEqual([])
    expect(h.fwd.status()).toMatchObject({ forwarded: 1, streamed: 1 })
  })

  it('on a stream: a call under these routes that is not on the list is refused at the door, nothing runs', async () => {
    const pair = streamPair(() => `http://127.0.0.1:${mac.port}`)
    closers.push(() => pair.door.close())
    const before = mac.seen.length
    for (const [method, url] of [['POST', '/api/tasks/k1/merge'], ['DELETE', '/api/tasks/k1?force=true'], ['PUT', '/api/tasks/k1/plugin-field'], ['GET', '/api/tasks'], ['POST', '/api/focus/tiers'], ['POST', '/api/tasks/batch/delete']]) {
      expect([method, url, await rawOnStream(pair.open, method, url, { 'x-walnut-caller-sid': 'aaaaaaaa-1111-4111-8111-111111111111' })]).toEqual([method, url, { status: 400, refused: '1' }])
    }
    expect(mac.seen.length).toBe(before)
  })

  it('as a server.http frame: a listed write runs with no caller header; one not on the list is refused before any route runs', async () => {
    setSelfApiRoot(`http://127.0.0.1:${mac.port}`)
    const payload = Buffer.from(JSON.stringify({ title: 'Acme launch checklist' }))
    const ok = await runForwardedCall({
      method: 'POST', url: '/api/tasks', data: payload.toString('base64'), size: payload.byteLength,
      headers: { 'content-type': 'application/json', authorization: 'Bearer phone-token', cookie: 'a=b', 'x-walnut-caller-sid': 'aaaaaaaa-1111-4111-8111-111111111111' },
    }, 'remote-http')
    expect(ok.status).toBe(201)
    expect(mac.seen.at(-1)).toMatchObject({ method: 'POST', path: '/api/tasks', origin: 'remote-http', auth: null, cookie: null, callerSid: null })
    const before = mac.seen.length
    for (const [method, url] of [['POST', '/api/tasks/k1/merge'], ['DELETE', '/api/tasks/k1?force=true'], ['GET', '/api/tasks'], ['POST', '/api/tasks/groups']]) {
      const err = await runForwardedCall({ method, url }, 'remote-http').then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(ForwardError)
      expect((err as ForwardError).code).toBe('forward_refused')
    }
    expect(mac.seen.length).toBe(before)
  })
})

// The ratchet: every non-GET route the Mac mounts under /api/tasks and /api/focus.

interface RouteLayer { route?: { path: unknown; methods?: Record<string, boolean> }; match(path: string): boolean }

/** Every non-GET route of a router as `METHOD /full/path`, read from its stack. */
function writeRoutes(router: Router, prefix: string): Array<{ method: string; route: string; layer: RouteLayer }> {
  const out: Array<{ method: string; route: string; layer: RouteLayer }> = []
  for (const layer of (router as unknown as { stack: RouteLayer[] }).stack) {
    if (!layer.route || typeof layer.route.path !== 'string') continue
    for (const [m, on] of Object.entries(layer.route.methods ?? {})) {
      const method = m.toUpperCase()
      if (!on || method === 'GET' || method === 'HEAD') continue
      out.push({ method, route: `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`, layer })
    }
  }
  return out
}

/** A concrete path for a route pattern (each `:param` an id-like segment). */
const sample = (route: string): string => route.replace(/:[A-Za-z]+/g, 'k9x8w7')

/** The listed writes, named here a second time on purpose: a change to the list is a decision. */
const EXPECTED = [
  'POST /api/tasks', 'PATCH /api/tasks/reorder', 'POST /api/tasks/batch/phase', 'PATCH /api/tasks/:id', 'DELETE /api/tasks/:id',
  'POST /api/tasks/:id/complete', 'POST /api/tasks/:id/toggle-complete', 'POST /api/tasks/:id/notes', 'PUT /api/tasks/:id/note',
  'PUT /api/tasks/:id/description', 'PUT /api/tasks/:id/summary', 'PUT /api/tasks/:id/depends-on',
  'POST /api/focus/batch', 'POST /api/focus/tasks/:id', 'DELETE /api/focus/tasks/:id', 'PUT /api/focus/reorder', 'PUT /api/focus/tasks/:id/tier',
]

describe('ratchet: the console writes the Mac runs for the companion', () => {
  const routes = [...writeRoutes(tasksRouter, '/api/tasks'), ...writeRoutes(focusRouter, '/api/focus')]
  const norm = (r: string) => r.replace(/:[A-Za-z]+/g, ':id')

  it('the two routers are the only ones the server mounts at /api/tasks and /api/focus', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/web/server.ts'), 'utf8')
    const mounts = src.split('\n')
      .map((line) => /app\.use\((\[[^\]]*\]|'[^']*'),\s*(.+)\)\s*$/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => !!m && /'\/api\/(tasks|focus)'/.test(m[1]!))
      .map((m) => `${m[1]} -> ${m[2]!.trim()}`)
    expect(mounts).toEqual([
      "['/api/tasks', '/api/focus'] -> getV1Forward().consoleMiddleware",
      "'/api/tasks' -> tasksRouter",
      "'/api/focus' -> focusRouter",
    ])
    // And neither router the server mounts at /api itself serves a /tasks or /focus path.
    for (const r of [leaderRouter, replicasStatusRouter]) {
      expect(((r as unknown as { stack: RouteLayer[] }).stack).map((l) => l.route?.path).filter((p) => typeof p === 'string' && /^\/(tasks|focus)(\/|$)/.test(p))).toEqual([])
    }
  })

  it('the list is exactly the expected writes, and each names a route that exists', () => {
    expect(CONSOLE_TASK_WRITES.map((w) => `${w.method} ${w.route}`).sort()).toEqual([...EXPECTED].sort())
    const have = new Set(routes.map((r) => `${r.method} ${norm(r.route)}`))
    for (const w of EXPECTED) expect([w, have.has(w)]).toEqual([w, true])
  })

  it('every non-GET route there is either listed (and run by both doors) or refused by both doors', async () => {
    expect(routes.length).toBeGreaterThanOrEqual(EXPECTED.length + 10)
    for (const r of routes) {
      const name = `${r.method} ${norm(r.route)}`
      const url = sample(r.route)
      const listed = EXPECTED.includes(name)
      expect([name, parseConsoleTaskWrite(r.method, url) !== null]).toEqual([name, listed])
      expect([name, (await checkForwardTarget(r.method, url)).ok]).toEqual([name, listed])
      if (!listed) {
        const err = await runForwardedCall({ method: r.method, url }, 'remote-http').then(() => null, (e: unknown) => e)
        expect([name, err instanceof ForwardError && err.code === 'forward_refused']).toEqual([name, true])
      }
    }
  })

  it('a listed path reaches exactly the listed route on the Mac\'s router, never a sibling', () => {
    for (const w of CONSOLE_TASK_WRITES) {
      const prefix = w.route.startsWith('/api/focus') ? '/api/focus' : '/api/tasks'
      const own = routes.filter((r) => r.route.startsWith(prefix))
      const rel = sample(w.route).slice(prefix.length) || '/'
      const first = own.find((r) => r.method === w.method && r.layer.match(rel))
      expect([w.route, first && norm(first.route)]).toEqual([w.route, w.route])
    }
  })

  it('a query string, a dot segment, a case variant or a trailing slash is never a listed write', () => {
    for (const url of ['/api/tasks/k1?force=true', '/api/tasks?x=1', '/api/tasks/../v1/x', '/api/tasks/%2e%2e/x', '/api/TASKS/k1', '/api/tasks/k1/', '/api/tasks//k1', '/api/tasks/k1/complete/x']) {
      expect([url, parseConsoleTaskWrite('PATCH', url) ?? parseConsoleTaskWrite('POST', url) ?? parseConsoleTaskWrite('DELETE', url)]).toEqual([url, null])
    }
    expect(parseConsoleTaskWrite('patch', '/api/tasks/k1')).toEqual({ rel: '/tasks/k1', pathname: '/api/tasks/k1', search: '' })
  })
})
