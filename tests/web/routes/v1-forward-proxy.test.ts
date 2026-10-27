/**
 * The companion's half of the forward (src/web/v1-forward/proxy.ts), with a
 * real Express app: the middleware in front of a stand-in for the companion's
 * own routes, and a stand-in for the bridge call to the Mac.
 *
 * The decision table it pins:
 *   - the Mac answers (bridge, fresh heartbeat, not led, allowed): forwarded,
 *     the Mac's status, headers and body as they came;
 *   - a route the companion keeps, the Mac silent or unheard, the companion
 *     leading, the user not allowing it, the forward turned off: answered here,
 *     the Mac never asked;
 *   - the Mac refused before running it, or the call never left: answered here;
 *   - an old Mac: answered here, and not asked again for a while;
 *   - sent and unanswered: a read is answered here and the Mac is not asked again
 *     until it is heard; a write is a 504 that says it may have been applied;
 *   - a reply too large to carry: a read is answered here; a write says it was applied.
 */
import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createV1Forward, macAnswers, type CallOutcome, type PrimarySnapshot } from '../../../src/web/v1-forward/proxy.js'

const NOW = 1_800_000_000_000

function fresh(over: Partial<PrimarySnapshot> = {}): PrimarySnapshot {
  return { bridge: true, heard: true, lastSeenAt: NOW - 5_000, leading: 0, backupAllowed: true, takeoverMs: 60_000, ...over }
}

const reply = (status: number, value: unknown, headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }): CallOutcome => {
  const buf = Buffer.from(JSON.stringify(value))
  return { ok: true, result: { status, headers, size: buf.byteLength, data: buf.toString('base64') } }
}

function harness(opts: { primary?: () => PrimarySnapshot | null; call?: (p: Record<string, unknown>, t: number) => Promise<CallOutcome>; enabled?: boolean; ownToken?: string } = {}) {
  let now = NOW
  const calls: Array<{ params: Record<string, unknown>; timeoutMs: number }> = []
  const fwd = createV1Forward({
    now: () => now,
    enabled: () => opts.enabled !== false,
    ownCall: (req) => opts.ownToken !== undefined && req.headers.authorization === `Bearer ${opts.ownToken}`,
    // By default the Mac was heard moments ago, whatever the clock says.
    primary: async () => (opts.primary ? opts.primary() : fresh({ lastSeenAt: now - 5_000 })),
    call: async (params, timeoutMs) => {
      calls.push({ params, timeoutMs })
      return opts.call ? opts.call(params, timeoutMs) : reply(200, { from: 'mac' })
    },
  })
  const app = express()
  app.use(express.json())
  app.use('/api/v1', fwd.middleware)
  // The companion's own routes.
  app.all('/api/v1/*rest', (req, res) => { res.status(200).json({ from: 'companion', path: req.path }) })
  return { app, fwd, calls, advance: (ms: number) => { now += ms } }
}

describe('macAnswers', () => {
  it.each([
    ['no snapshot', null, 'no-leader'],
    ['no bridge', fresh({ bridge: false }), 'no-bridge'],
    ['never heard', fresh({ heard: false }), 'primary-unheard'],
    ['silent for three beats', fresh({ lastSeenAt: NOW - 46_000 }), 'primary-silent'],
    ['silent past a short takeover window', fresh({ lastSeenAt: NOW - 7_000, takeoverMs: 6_000 }), 'primary-silent'],
    ['the companion leads a host', fresh({ leading: 1 }), 'companion-leads'],
    ['the user does not allow it', fresh({ backupAllowed: false }), 'not-allowed'],
    ['no heartbeat said', fresh({ backupAllowed: null }), 'not-allowed'],
  ])('%s: %s', (_what, snapshot, why) => {
    expect(macAnswers(snapshot as PrimarySnapshot | null, NOW, 0, 0)).toBe(why)
  })

  it('a suspect Mac is asked again once it is heard after the failure', () => {
    expect(macAnswers(fresh({ lastSeenAt: NOW - 3_000 }), NOW, NOW - 2_000, 0)).toBe('primary-suspect')
    expect(macAnswers(fresh({ lastSeenAt: NOW - 1_000 }), NOW, NOW - 2_000, 0)).toBeNull()
  })

  it('away, for a route with a copy: no bridge, silent, suspect, or the companion leads; not when unknown', async () => {
    const away = async (snapshot: PrimarySnapshot | null, setup?: (h: ReturnType<typeof harness>) => Promise<void>) => {
      const h = harness({ primary: () => snapshot, call: async () => ({ ok: false, failure: { kind: 'bridge_offline', message: 'timed out', notSent: false } }) })
      if (setup) await setup(h)
      return h.fwd.primaryAway()
    }
    expect(await away(fresh({ bridge: false }))).toBe(true)
    expect(await away(fresh({ lastSeenAt: NOW - 120_000 }))).toBe(true)
    expect(await away(fresh({ leading: 1 }))).toBe(true)
    // A read went out and came back unanswered: away until the Mac is heard again.
    expect(await away(fresh({ lastSeenAt: NOW - 1_000 }), async (h) => { await request(h.app).get('/api/v1/usage/overview') })).toBe(true)
    // Unknown is not away: the route asks the Mac as it did.
    expect(await away(null)).toBe(false)
    expect(await away(fresh({ heard: false }))).toBe(false)
    // Up, whatever the forward itself may do.
    expect(await away(fresh())).toBe(false)
    expect(await away(fresh({ backupAllowed: false }))).toBe(false)
  })

  it('the leader presence every follower route reads (core/server-role.ts) is the same view', async () => {
    const presence = (snapshot: PrimarySnapshot | null) => harness({ primary: () => snapshot }).fwd.presence()
    expect(await presence(fresh())).toEqual({ answers: true, why: 'answers' })
    expect(await presence(fresh({ backupAllowed: false }))).toEqual({ answers: true, why: 'not-allowed' })
    expect(await presence(null)).toEqual({ answers: true, why: 'no-leader' })
    expect(await presence(fresh({ bridge: false }))).toEqual({ answers: false, why: 'no-bridge' })
    expect(await presence(fresh({ leading: 1 }))).toEqual({ answers: false, why: 'companion-leads' })
  })

  it('an old Mac rests until its time is up', () => {
    expect(macAnswers(fresh(), NOW, 0, NOW + 1)).toBe('primary-too-old')
    expect(macAnswers(fresh(), NOW, 0, NOW)).toBeNull()
  })
})

describe('the forward middleware', () => {
  it('forwards a call the companion does not keep, and sends the Mac\'s answer back as it came', async () => {
    const h = harness({ call: async () => reply(201, { ok: true, renamed: 'Acme2' }, { 'content-type': 'application/json', etag: '"e1"', 'x-walnut-api': '1' }) })
    const res = await request(h.app).patch('/api/v1/projects/Acme?x=1').set('Authorization', 'Bearer phone').send({ name: 'Acme2' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ ok: true, renamed: 'Acme2' })
    expect(res.headers.etag).toBe('"e1"')
    expect(res.headers['x-walnut-api']).toBe('1')
    expect(res.headers['x-walnut-answered-by']).toBe('primary')
    expect(h.calls).toHaveLength(1)
    const p = h.calls[0].params
    expect(p).toMatchObject({ method: 'PATCH', url: '/api/v1/projects/Acme?x=1' })
    expect(JSON.parse(Buffer.from(String(p.data), 'base64').toString('utf8'))).toEqual({ name: 'Acme2' })
    expect(p.size).toBe(Buffer.byteLength(JSON.stringify({ name: 'Acme2' })))
    // No credential crosses.
    expect(JSON.stringify(p.headers)).not.toMatch(/phone|authorization/i)
    // A write waits longer than a read, and the Mac gives up first.
    expect(h.calls[0].timeoutMs).toBe(25_000)
    expect(p.timeoutMs).toBe(23_000)
    expect(h.fwd.status().forwarded).toBe(1)
  })

  it('a read waits less', async () => {
    const h = harness()
    await request(h.app).get('/api/v1/usage/overview')
    expect(h.calls[0].timeoutMs).toBe(8_000)
    expect(h.calls[0].params.data).toBeUndefined()
  })

  it('passes a 304 and a 204 through without a body', async () => {
    const h = harness({ call: async (p) => ({ ok: true, result: { status: String(p.url).endsWith('/usage/a') ? 304 : 204, headers: {}, size: 0, data: '' } }) })
    expect((await request(h.app).get('/api/v1/usage/a')).status).toBe(304)
    expect((await request(h.app).delete('/api/v1/routines/r1')).status).toBe(204)
  })

  it.each([
    ['a kept route', 'get', '/api/v1/tasks'],
    ['a stream', 'get', '/api/v1/events'],
    ['a send', 'post', '/api/v1/sessions/abc/messages'],
  ])('%s is answered here and the Mac never asked', async (_what, verb, path) => {
    const h = harness()
    const res = await (request(h.app) as unknown as Record<string, (p: string) => request.Test>)[verb](path)
    expect(res.body.from).toBe('companion')
    expect(res.headers['x-walnut-answered-by']).toBe('companion')
    expect(h.calls).toHaveLength(0)
  })

  it.each([
    ['the Mac is silent', () => fresh({ lastSeenAt: NOW - 60_000 }), 'primary-silent'],
    ['the companion leads', () => fresh({ leading: 2 }), 'companion-leads'],
    ['the user does not allow it', () => fresh({ backupAllowed: false }), 'not-allowed'],
    ['no bridge', () => fresh({ bridge: false }), 'no-bridge'],
  ])('%s: answered here', async (_what, primary, why) => {
    const h = harness({ primary })
    const res = await request(h.app).get('/api/v1/usage/overview')
    expect(res.body.from).toBe('companion')
    expect(h.calls).toHaveLength(0)
    expect(h.fwd.status().answeredHere[why]).toBe(1)
  })

  // The r4d gate's R6: a HEAD of a GET-only kept route went to the Mac.
  it('a HEAD of a kept read is answered here like its GET; a HEAD the companion does not keep is forwarded', async () => {
    const h = harness()
    for (const path of ['/api/v1/sessions/abc/messages/qm-mobile-1', '/api/v1/sessions/abc/queue']) {
      const res = await request(h.app).head(path)
      expect(res.status, path).toBe(200)
      expect(res.headers['x-walnut-answered-by'], path).toBe('companion')
    }
    expect(h.calls).toHaveLength(0)
    expect((await request(h.app).head('/api/v1/usage/overview')).status).toBe(200)
    expect(h.calls.map((c) => c.params.method)).toEqual(['HEAD'])
  })

  it('turned off: answered here', async () => {
    const h = harness({ enabled: false })
    expect((await request(h.app).get('/api/v1/usage/overview')).body.from).toBe('companion')
    expect(h.calls).toHaveLength(0)
  })

  it('this server\'s own op call keeps its own path; a phone\'s goes to the Mac', async () => {
    const h = harness({ ownToken: 'self-token' })
    const own = await request(h.app).post('/api/v1/actions/invoke').set('Authorization', 'Bearer self-token').send({ tool: 'task_list' })
    expect(own.body.from).toBe('companion')
    expect(h.calls).toHaveLength(0)
    expect(h.fwd.status().answeredHere['own-call']).toBe(1)
    const phone = await request(h.app).post('/api/v1/actions/invoke').set('Authorization', 'Bearer phone').send({ tool: 'task_list' })
    expect(phone.body.from).toBe('mac')
  })

  it('a body that is not JSON stays here', async () => {
    const h = harness()
    const res = await request(h.app).post('/api/v1/memory/global').set('Content-Type', 'text/plain').send('hello')
    expect(res.body.from).toBe('companion')
    expect(h.calls).toHaveLength(0)
  })

  it('a refusal and a call that never left are answered here, writes included', async () => {
    const refused = harness({ call: async () => ({ ok: false, failure: { kind: 'error', status: 400, code: 'forward_refused', message: 'kept' } }) })
    expect((await request(refused.app).put('/api/v1/memory/global').send({ content: 'x' })).body.from).toBe('companion')
    const notSent = harness({ call: async () => ({ ok: false, failure: { kind: 'bridge_offline', message: 'no bridge', notSent: true } }) })
    expect((await request(notSent.app).put('/api/v1/memory/global').send({ content: 'x' })).body.from).toBe('companion')
    // Neither makes the Mac suspect: the next call is forwarded again.
    expect(notSent.fwd.status().suspectAt).toBeNull()
  })

  it('an old Mac is answered here and rests for ten minutes', async () => {
    const h = harness({ call: async () => ({ ok: false, failure: { kind: 'needs_upgrade', message: 'old' } }) })
    expect((await request(h.app).get('/api/v1/usage/overview')).body.from).toBe('companion')
    expect((await request(h.app).get('/api/v1/usage/overview')).body.from).toBe('companion')
    expect(h.calls).toHaveLength(1)
    h.advance(10 * 60_000 + 1)
    await request(h.app).get('/api/v1/usage/overview')
    expect(h.calls).toHaveLength(2)
  })

  it('a read that went out unanswered is answered here, and the Mac is not asked again until it is heard', async () => {
    let lastSeenAt = NOW - 1_000
    const h = harness({
      primary: () => fresh({ lastSeenAt }),
      call: async () => ({ ok: false, failure: { kind: 'bridge_offline', message: 'timed out', notSent: false } }),
    })
    expect((await request(h.app).get('/api/v1/usage/overview')).body.from).toBe('companion')
    expect((await request(h.app).get('/api/v1/usage/overview')).body.from).toBe('companion')
    expect(h.calls).toHaveLength(1)
    expect(h.fwd.status().answeredHere['primary-suspect']).toBe(1)
    // A heartbeat after the failure: asked again.
    h.advance(2_000)
    lastSeenAt = NOW + 1_000
    await request(h.app).get('/api/v1/usage/overview')
    expect(h.calls).toHaveLength(2)
  })

  it('a write that went out unanswered is a 504 that says it may have been applied, never run here', async () => {
    const h = harness({ call: async () => ({ ok: false, failure: { kind: 'error', status: 504, code: 'forward_failed', message: 'timed out' } }) })
    const res = await request(h.app).patch('/api/v1/projects/Acme').send({ name: 'B' })
    expect(res.status).toBe(504)
    expect(res.body.error.code).toBe('primary_timeout')
    expect(res.body.error.message).toMatch(/may have applied/)
    expect(res.body.from).toBeUndefined()
    expect(h.fwd.status().unanswered).toBe(1)
  })

  it('a reply too large to carry: a read is answered here, a write says it was applied', async () => {
    const h = harness({ call: async () => ({ ok: true, result: { status: 200, headers: {}, size: 300_000, tooLarge: true } }) })
    expect((await request(h.app).get('/api/v1/usage/recent')).body.from).toBe('companion')
    const w = await request(h.app).post('/api/v1/routines').send({ name: 'r' })
    expect(w.status).toBe(200)
    expect(w.body.from).toBeUndefined()
    expect(w.body.note).toMatch(/Applied on the Mac/)
    expect(w.headers['x-walnut-answered-by']).toBe('primary')
  })

  it('at most 16 reads are in flight; the next one is answered here', async () => {
    const releases: Array<() => void> = []
    const h = harness({ call: () => new Promise((resolve) => { releases.push(() => resolve(reply(200, { from: 'mac' }))) }) })
    const pending = Array.from({ length: 16 }, () => request(h.app).get('/api/v1/usage/overview').then((r) => r))
    while (releases.length < 16) await new Promise((r) => setTimeout(r, 5))
    const extra = await request(h.app).get('/api/v1/usage/overview')
    expect(extra.body.from).toBe('companion')
    for (const release of releases) release()
    const done = await Promise.all(pending)
    expect(done.every((r) => r.body.from === 'mac')).toBe(true)
    expect(h.fwd.status().answeredHere.busy).toBe(1)
  })
})

// The forward on a stream ('bridge-stream-v1', replica plan WP13).
//
// Real pieces end to end, in one process: the companion's stream endpoint
// (link-stream.ts), the daemon's pair table (stream-relay-core.ts, the bridge
// may open to the primary only), the Mac's endpoint, the Mac's companion door
// (stream-door.ts) and a stand-in for the Mac's own routes listening on a port.
import http from 'node:http'
import net from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { createStreamRelay } from '../../../src/providers/stream-relay-core.js'
import { createStreamEndpoint, type StreamEndpoint } from '../../../src/lib/link-stream.js'
import { createCompanionDoor } from '../../../src/web/v1-forward/stream-door.js'
import { forwardUpgrade } from '../../../src/host-server/proxy.js'
import { afterAll } from 'vitest'

type RelayLink = { name: 'bridge' | 'primary'; ep: StreamEndpoint | null; up: boolean }

/** The Mac's own routes: echo what crossed (method, path, the caller headers, the body size). */
async function macRoutes(): Promise<{ port: number; seen: Array<Record<string, unknown>>; wss: WebSocketServer; close: () => Promise<void> }> {
  const seen: Array<Record<string, unknown>> = []
  const app = express()
  app.use(express.json({ limit: '15mb' }))
  app.all('/api/v1/*rest', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : ''
    seen.push({ method: req.method, path: req.originalUrl, origin: req.headers['x-walnut-origin'], auth: req.headers.authorization ?? null, size: body.length })
    if (req.path === '/api/v1/big') { res.status(200).type('application/octet-stream').send(Buffer.alloc(3 * 1024 * 1024 + 5, 7)); return }
    res.status(req.method === 'GET' ? 200 : 201).setHeader('x-walnut-op', 'mac').json({ from: 'mac', size: body.length })
  })
  const server = http.createServer(app)
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/v1/live') { socket.destroy(); return }
    seen.push({ upgrade: req.url, origin: req.headers['x-walnut-origin'], auth: req.headers.authorization ?? null })
    wss.handleUpgrade(req, socket, head, (ws) => { ws.on('message', (m) => ws.send(`mac:${m.toString()}`)) })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { port: (server.address() as net.AddressInfo).port, seen, wss, close: () => new Promise((r) => { wss.close(); server.close(() => r()) }) }
}

/** The bridge (companion) and the Mac's link on one in-memory daemon. */
function streamHarness(macPort: () => number | null, opts: { macAccepts?: boolean; relayOrigin?: string; idleMs?: number; afterAnswerMs?: number } = {}) {
  const relay = createStreamRelay<RelayLink>({
    send: (link, ev, data) => { queueMicrotask(() => { if (link.up) link.ep?.handle({ ev, ...data }) }) },
    log: () => {},
  })
  const bridge: RelayLink = { name: 'bridge', ep: null, up: true }
  const primary: RelayLink = { name: 'primary', ep: null, up: true }
  const opens: Array<{ to: unknown }> = []
  const daemonGets = (from: RelayLink) => (frame: Record<string, unknown>) => {
    if (!from.up) throw new Error('link down')
    queueMicrotask(() => {
      const cmd = String(frame.cmd)
      if (cmd === 'stream.open') {
        opens.push({ to: frame.to })
        // The daemon's rule (streamTarget): the bridge opens to the primary only.
        const to = from === bridge && frame.to === 'primary' && primary.up ? primary : null
        relay.open(from, frame.sid, to, { from: 'companion' }, from === bridge && frame.to !== 'primary' ? 'the companion opens streams to the primary only' : 'no primary server connected')
      } else relay.frame(from, cmd.slice('stream.'.length), frame)
    })
  }
  const door = createCompanionDoor({ root: () => (macPort() ? `http://127.0.0.1:${macPort()}` : null), idleMs: opts.idleMs, afterAnswerMs: opts.afterAnswerMs })
  bridge.ep = createStreamEndpoint({ send: daemonGets(bridge), openTimeoutMs: 2_000 })
  primary.ep = createStreamEndpoint({
    send: daemonGets(primary), openTimeoutMs: 2_000,
    accept: (info) => (info.from === 'companion' && opts.macAccepts !== false ? (s) => door.accept(s, opts.relayOrigin) : null),
  })
  return { relay, bridge, primary, door, opens }
}

function forwardOver(s: ReturnType<typeof streamHarness>, opts: { capable?: () => boolean; open?: () => Promise<import('node:stream').Duplex> } = {}) {
  const calls: Array<Record<string, unknown>> = []
  const fwd = createV1Forward({
    now: () => Date.now(),
    enabled: () => true,
    primary: async () => fresh({ lastSeenAt: Date.now() - 1_000 }),
    call: async (params) => { calls.push(params); return reply(200, { from: 'mac-over-server-http' }) },
    stream: { capable: opts.capable ?? (() => true), open: opts.open ?? (() => s.bridge.ep!.open('primary', { purpose: 'web' })) },
  })
  const app = express()
  app.use(express.json({ limit: '15mb' }))
  app.use('/api/v1', fwd.middleware)
  app.all('/api/v1/*rest', (req, res) => { res.status(200).json({ from: 'companion', path: req.path }) })
  return { app, fwd, calls }
}

describe('the forward on a stream (bridge-stream-v1)', () => {
  let mac: Awaited<ReturnType<typeof macRoutes>>
  const closers: Array<() => unknown> = []
  afterAll(async () => { for (const c of closers) await c(); await mac?.close() })
  const setup = async (opts?: { macAccepts?: boolean }) => {
    mac ??= await macRoutes()
    const s = streamHarness(() => mac.port, opts)
    closers.push(() => s.door.close())
    return s
  }

  it('a call goes on the stream: the Mac\'s status, headers and body; the phone\'s token never crosses', async () => {
    const s = await setup()
    const h = forwardOver(s)
    const r = await request(h.app).patch('/api/v1/projects/Acme?x=1').set('Authorization', 'Bearer phone-token').send({ name: 'Acme 2' })
    expect(r.status).toBe(201)
    expect(r.headers['x-walnut-answered-by']).toBe('primary')
    expect(r.headers['x-walnut-op']).toBe('mac')
    expect(r.body).toEqual({ from: 'mac', size: JSON.stringify({ name: 'Acme 2' }).length })
    expect(mac.seen.at(-1)).toMatchObject({ method: 'PATCH', path: '/api/v1/projects/Acme?x=1', origin: 'remote-http', auth: null })
    expect(h.calls).toHaveLength(0)
    expect(h.fwd.status()).toMatchObject({ forwarded: 1, streamed: 1 })
    expect(s.opens).toEqual([{ to: 'primary' }])
  })

  it('no size cap: a 4 MB body goes to the Mac and a 3 MB reply comes back', async () => {
    const s = await setup()
    const h = forwardOver(s)
    const big = { text: 'x'.repeat(4 * 1024 * 1024) }
    const w = await request(h.app).post('/api/v1/notes/content/big.md').send(big)
    expect(w.status).toBe(201)
    expect(w.body.size).toBe(JSON.stringify(big).length)
    const r = await request(h.app).get('/api/v1/big').buffer(true).parse((res, cb) => { const parts: Buffer[] = []; res.on('data', (b: Buffer) => parts.push(b)); res.on('end', () => cb(null, Buffer.concat(parts))) })
    expect(r.status).toBe(200)
    expect((r.body as Buffer).length).toBe(3 * 1024 * 1024 + 5)
    expect(h.calls).toHaveLength(0)
    // The same body over server.http stays on the companion (its frame keeps the 1 MB cap).
    const old = forwardOver(s, { capable: () => false })
    const o = await request(old.app).post('/api/v1/notes/content/big.md').send(big)
    expect(o.body).toMatchObject({ from: 'companion' })
    expect(old.fwd.status().answeredHere).toMatchObject({ 'body-size': 1 })
  })

  it('a daemon without the cap: server.http as today', async () => {
    const s = await setup()
    const h = forwardOver(s, { capable: () => false })
    const r = await request(h.app).get('/api/v1/usage/overview')
    expect(r.body).toEqual({ from: 'mac-over-server-http' })
    expect(h.calls).toHaveLength(1)
    expect(h.fwd.status()).toMatchObject({ forwarded: 1, streamed: 0, streamRefused: 0 })
  })

  it('a stream refused at once was never sent: the call goes as one server.http frame, as before; the Mac is not suspect', async () => {
    const s = await setup()
    s.primary.up = false
    const h = forwardOver(s)
    const w = await request(h.app).put('/api/v1/memory/user').send({ content: 'x' })
    expect(w.body).toEqual({ from: 'mac-over-server-http' })
    expect(h.calls).toHaveLength(1)
    expect(h.fwd.status()).toMatchObject({ forwarded: 1, streamed: 0, streamRefused: 1, suspectAt: null })
    // ...its frame cap included: a 2 MB body stays on the companion.
    const big = await request(h.app).put('/api/v1/memory/user').send({ content: 'y'.repeat(2 * 1024 * 1024) })
    expect(big.body).toMatchObject({ from: 'companion' })
    expect(h.fwd.status().answeredHere).toMatchObject({ 'body-size': 1 })
    // A Mac whose link takes no companion stream: the same.
    const s2 = await setup({ macAccepts: false })
    const h2 = forwardOver(s2)
    expect((await request(h2.app).get('/api/v1/usage/overview')).body).toEqual({ from: 'mac-over-server-http' })
    expect(h2.calls).toHaveLength(1)
  })

  it('a stream the daemon or the Mac never answers: no second wait, the Mac is suspect until heard', async () => {
    const s = await setup()
    const h = forwardOver(s, { open: () => new Promise(() => { /* the daemon is frozen */ }) })
    const started = Date.now()
    const r = await request(h.app).get('/api/v1/usage/overview')
    expect(r.body).toMatchObject({ from: 'companion' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(7_500)
    expect(h.fwd.status().answeredHere).toMatchObject({ unanswered: 1 })
    expect(h.fwd.status().suspectAt).not.toBeNull()
    const again = Date.now()
    const r2 = await request(h.app).get('/api/v1/usage/overview')
    expect(r2.body).toMatchObject({ from: 'companion' })
    expect(Date.now() - again).toBeLessThan(1_000)
    expect(h.calls).toHaveLength(0)
  }, 30_000)

  it('the Mac\'s door refuses what it would not run: answered here, nothing ran there', async () => {
    const s = streamHarness(() => null)
    closers.push(() => s.door.close())
    mac ??= await macRoutes()
    const before = mac.seen.length
    const h = forwardOver(s)
    const w = await request(h.app).post('/api/v1/actions/invoke').send({ tool: 'x' })
    expect(w.body).toMatchObject({ from: 'companion' })
    expect(h.fwd.status().answeredHere).toMatchObject({ refused: 1 })
    expect(mac.seen.length).toBe(before)
    expect(s.door.stats()).toMatchObject({ refused: 1, served: 0 })
  })
})

describe('no WebSocket crosses the stream (the Mac serves none under /api/v1)', () => {
  it('an upgrade sent on a stream is refused at the door, nothing reaches the Mac\'s routes', async () => {
    const mac = await macRoutes()
    const s = streamHarness(() => mac.port)
    // A companion that handed an upgrade to the stream, as proxy.ts hands a host server's.
    const companion = http.createServer()
    companion.on('upgrade', (req, socket, head) => {
      forwardUpgrade(req, socket, head, { kind: 'leader', connect: () => s.bridge.ep!.open('primary', { purpose: 'web' }) }, () => socket.destroy())
    })
    await new Promise<void>((r) => companion.listen(0, '127.0.0.1', () => r()))
    const port = (companion.address() as net.AddressInfo).port
    try {
      for (const path of ['/api/v1/live', '/api/v1/events']) {
        const got = await new Promise<{ status: number; refused: unknown }>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Authorization: 'Bearer phone-token' } })
          ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0, refused: res.headers['x-walnut-forward-refused'] }))
          ws.on('open', () => { ws.close(); resolve({ status: 101, refused: null }) })
          ws.on('error', () => resolve({ status: -1, refused: null }))
        })
        expect(got).toEqual({ status: 404, refused: '1' })
      }
      expect(mac.seen.filter((x) => 'upgrade' in x)).toHaveLength(0)
      expect(s.door.stats()).toMatchObject({ refused: 2, served: 0 })
    } finally {
      s.door.close()
      await new Promise<void>((r) => companion.close(() => r()))
      await mac.close()
    }
  })
})

describe('the Mac takes a companion stream through its own daemon only (control-host-policy.ts, as server.http)', () => {
  it('through the Mac\'s own daemon the door takes it; through another host\'s daemon it is refused at the open', async () => {
    const { companionStreamAcceptor } = await import('../../../src/web/v1-forward/stream-door.js')
    expect(typeof companionStreamAcceptor('__local__', 's-acme-1')).toBe('function')
    expect(companionStreamAcceptor('marina', 's-acme-2')).toBeNull()
    expect(companionStreamAcceptor('', 's-acme-3')).toBeNull()
  })

  it('a call acts for whom the relaying daemon acts: a paired client, never above it', async () => {
    const mac = await macRoutes()
    try {
      // The relay origin of a remote host (kept for safety, as target.ts keeps it) lowers the call.
      const s = streamHarness(() => mac.port, { relayOrigin: 'host:marina' })
      const h = forwardOver(s)
      expect((await request(h.app).get('/api/v1/usage/overview')).status).toBe(200)
      expect(mac.seen.at(-1)).toMatchObject({ origin: 'host:marina', auth: null })
      // A local origin never lifts it above a paired client.
      const s2 = streamHarness(() => mac.port, { relayOrigin: '__local__' })
      const h2 = forwardOver(s2)
      expect((await request(h2.app).get('/api/v1/usage/overview')).status).toBe(200)
      expect(mac.seen.at(-1)).toMatchObject({ origin: 'remote-http', auth: null })
      s.door.close()
      s2.door.close()
    } finally {
      await mac.close()
    }
  })
})

describe('the Mac\'s door when its own route cannot be reached (the listener closing in a shutdown)', () => {
  it('a read is answered from the copy, a write is told it may have applied; no loopback detail reaches the phone', async () => {
    // A port that took a listener and lost it: the door's own call is refused.
    const gone = http.createServer()
    await new Promise<void>((r) => gone.listen(0, '127.0.0.1', () => r()))
    const port = (gone.address() as net.AddressInfo).port
    await new Promise<void>((r) => gone.close(() => r()))
    const s = streamHarness(() => port)
    try {
      const h = forwardOver(s)
      const r = await request(h.app).get('/api/v1/usage/overview')
      expect(r.body).toMatchObject({ from: 'companion' })
      expect(h.fwd.status().answeredHere).toMatchObject({ unanswered: 1 })
      expect(h.fwd.status().suspectAt).not.toBeNull()
      const h2 = forwardOver(s)
      const w = await request(h2.app).put('/api/v1/memory/user').send({ content: 'x' })
      expect(w.status).toBe(504)
      expect(w.body.error.code).toBe('primary_timeout')
      expect(JSON.stringify(w.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/)
      expect(h2.calls).toHaveLength(0)
    } finally {
      s.door.close()
    }
  })
})

describe('the door closes a stream that idles (a stream has no socket timeouts)', () => {
  it('a stream that sends no request is closed; one left open after its answer is closed too', async () => {
    const mac = await macRoutes()
    const s = streamHarness(() => mac.port, { idleMs: 150, afterAnswerMs: 150 })
    try {
      const closed = (d: import('node:stream').Duplex) => new Promise<number>((resolve) => {
        const t0 = Date.now()
        d.on('close', () => resolve(Date.now() - t0))
        d.on('end', () => resolve(Date.now() - t0))
        d.on('error', () => resolve(Date.now() - t0))
        d.resume()
      })
      const quiet = await s.bridge.ep!.open('primary', { purpose: 'web' })
      expect(await closed(quiet)).toBeLessThan(3_000)
      // A keep-alive call whose companion never closes the stream after the answer.
      const kept = await s.bridge.ep!.open('primary', { purpose: 'web' })
      const answered = new Promise<string>((resolve) => { let got = ''; kept.on('data', (b: Buffer) => { got += b.toString(); if (got.includes('"from":"mac"')) resolve(got) }) })
      const done = closed(kept)
      kept.write('GET /api/v1/usage/overview HTTP/1.1\r\nHost: primary\r\nConnection: keep-alive\r\n\r\n')
      expect(await answered).toMatch(/^HTTP\/1\.1 200/)
      expect(await done).toBeLessThan(3_000)
    } finally {
      s.door.close()
      await mac.close()
    }
  })
})

describe('the door is off by boot policy: refused at the open, never a request with no answer', () => {
  it('a server that takes no companion stream refuses the open (the call goes as one server.http frame)', async () => {
    const { companionStreamAcceptor } = await import('../../../src/web/v1-forward/stream-door.js')
    const { _resetServerRoleForTesting } = await import('../../../src/core/server-role.js')
    const was = process.env.WALNUT_HOST_SERVER
    process.env.WALNUT_HOST_SERVER = '1'
    _resetServerRoleForTesting()
    try {
      expect(companionStreamAcceptor('__local__', 's-acme-9')).toBeNull()
    } finally {
      if (was === undefined) delete process.env.WALNUT_HOST_SERVER
      else process.env.WALNUT_HOST_SERVER = was
      _resetServerRoleForTesting()
    }
    expect(typeof companionStreamAcceptor('__local__', 's-acme-10')).toBe('function')
  })
})
