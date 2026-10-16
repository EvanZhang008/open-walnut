/**
 * The dispatcher of a host replica (docs/plan/walnut-replica-servers-impl.md,
 * section 3, WP2), every branch, over real sockets: the real dispatcher and the
 * real byte forward (host-server/proxy.ts) in front of a tiny public server,
 * with doors standing in for the Mac and the companion. The link is a fake: a
 * stream "through the daemon" is a TCP connection to the door, and the route,
 * the suspect marks and follower.op are the test's.
 *
 * Branches: a read forwarded, retried on the companion, answered away; a write
 * forwarded with its op id and forwarded-at stamp; a write that reached the Mac
 * and got no answer is 504 (never journaled), one that never left is answered
 * away; the write budget; an upgrade spliced; the companion standing in; a
 * presence flip answers every in-flight forward 504 and closes spliced sockets
 * 4001; follower.op `leader_answers` forwarded once with the same op id, that
 * forward failing before any byte is 503 leader_unsure; a lost follower.op
 * answer asked again with the same op id.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { createDispatcher, closeFrame, ensureOpId, writeBudgetOf, WRITE_BUDGET_MS, MAX_WRITE_BUDGET_MS, OP_ID_HEADER, FORWARDED_AT_HEADER, OFFLINE_HEADER, WAIT_HEADER, type Dispatcher, type DispatchDeps, type ReplicaWriteResult } from '../../src/replica/dispatch.js'
import { classify, type RouteDecision } from '../../src/replica/route-table.js'
import type { Route } from '../../src/host-server/route.js'
import { notSent } from '../../src/host-server/daemon-link.js'

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

/**
 * A door: records what reached it; `/hang` never answers; `/drop` reads the
 * request and closes the socket; `/slow/<ms>` answers after that long. A
 * WebSocket to `/ws-hang` is never answered (a frozen handshake); one to
 * `/ws-partial` is accepted by hand and its socket kept in `partials`, so a test
 * writes the Mac's frames byte by byte.
 */
function door(name: string) {
  const seen: Seen[] = []
  const sockets = new Set<net.Socket>()
  const partials: net.Socket[] = []
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(parts).toString() })
      if (req.url?.includes('/hang')) return
      if (req.url?.includes('/drop')) { req.socket.destroy(); return }
      const slow = /\/slow\/(\d+)/.exec(req.url ?? '')
      const answer = () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ from: name, url: req.url, opId: req.headers[OP_ID_HEADER] ?? null }))
      }
      if (slow) setTimeout(answer, Number(slow[1]))
      else answer()
    })
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.includes('/ws-hang')) { socket.on('error', () => {}); return }
    if (req.url?.includes('/ws-partial')) {
      socket.on('error', () => {})
      const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      partials.push(socket as net.Socket)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`${name}:${String(m)}`)))
  })
  return { server, seen, sockets, partials, port: 0 }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
}

function connectTo(port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

const mac = door('mac')
const companion = door('companion')
let pub: http.Server
let pubPort = 0
let dispatcher: Dispatcher

/** What the test controls. */
const state = {
  route: { kind: 'leader' } as Route,
  /** The route after the first failure (a read retried), else the same. */
  routeAfterFail: null as Route | null,
  failConnect: new Set<'leader' | 'companion'>(),
  /** A stream takes this long to open (or to fail). */
  connectDelayMs: 0,
  /** Whether the request carries a known device token (an away write body is read only then). */
  authorized: true,
  connects: [] as string[],
  suspects: [] as string[],
  ops: [] as Array<Record<string, unknown>>,
  opAnswers: [] as Array<Record<string, unknown> | Error>,
  table: null as ((method: string, path: string) => RouteDecision) | null,
  logs: [] as Array<{ msg: string; data?: Record<string, unknown> }>,
  writeBudgetMs: 2_000,
  /** The link to the daemon (follower.op waits for it between tries); the daemon's replica-ops-v1 (null: no hello yet). */
  linked: true,
  opsCap: true as boolean | null,
  /** follower.op rejects not-sent while the link is down, as daemon-link.ts request() does. */
  opsWhileDown: 0,
  /** The link goes down once this many follower.op tries reached the daemon. */
  downAfterOps: null as number | null,
  /** WP6: whether a conditional local row is this host's data (null: never asked, a leader row). */
  localHere: null as ((req: IncomingMessage, d: RouteDecision) => boolean | Promise<boolean>) | null,
  localAsked: [] as string[],
}

function reset(): void {
  state.route = { kind: 'leader' }
  state.routeAfterFail = null
  state.failConnect.clear()
  state.connectDelayMs = 0
  state.authorized = true
  state.connects = []; state.suspects = []; state.ops = []; state.opAnswers = []; state.logs = []
  state.table = null
  state.linked = true; state.opsCap = true; state.opsWhileDown = 0; state.downAfterOps = null
  state.localHere = null; state.localAsked = []
  mac.seen.length = 0; companion.seen.length = 0
  mac.partials.length = 0
}

/** The routes of the replica itself (what next() runs): an away write submits to follower.op. */
async function local(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const w = req.replicaWrite
  if (w) {
    const r: ReplicaWriteResult = await w.submit('task-fields', { id: 't1', title: 'Acme' }, { title: 'old' })
    if (r.kind === 'answered') return
    res.writeHead(r.kind === 'applied' ? 200 : 409, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ from: 'replica', result: r, opId: w.opId, raw: w.raw.toString() }))
    return
  }
  const answer = () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ from: 'replica', offline: res.getHeader(OFFLINE_HEADER) ?? null }))
  }
  // A read the Mac took first was already read to its end (piped into that forward).
  if (req.readableEnded) return answer()
  req.resume()
  req.on('end', answer)
}

const AS_OF = 1_700_000_000_000

beforeAll(async () => {
  mac.port = await listen(mac.server)
  companion.port = await listen(companion.server)
  const deps: DispatchDeps = {
    route: () => state.route,
    asOf: () => AS_OF,
    connect: async (kind) => {
      state.connects.push(kind)
      if (state.connectDelayMs) await new Promise((r) => setTimeout(r, state.connectDelayMs))
      if (state.failConnect.has(kind)) throw new Error(`no stream to the ${kind}`)
      return connectTo(kind === 'leader' ? mac.port : companion.port)
    },
    suspect: (kind) => {
      state.suspects.push(kind)
      if (state.routeAfterFail) state.route = state.routeAfterFail
    },
    answerAlone: (_req, res, why) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<p data-why="${why}">alone</p>`) },
    followerOp: async (params) => {
      if (!state.linked) { state.opsWhileDown++; throw notSent(new Error('not linked to the daemon')) }
      state.ops.push(params)
      if (state.downAfterOps !== null && state.ops.length >= state.downAfterOps) state.linked = false
      const next = state.opAnswers.shift() ?? { ok: true, seq: 1 }
      if (next instanceof Error) throw next
      return next
    },
    followerOpCap: () => state.opsCap,
    linked: () => state.linked,
    ownUpgrade: (_req, socket) => { socket.end('HTTP/1.1 418 I am the replica\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') },
    log: (_level, msg, data) => { state.logs.push({ msg, ...(data ? { data } : {}) }) },
    authorized: () => state.authorized,
    writeBudgetMs: state.writeBudgetMs,
    classify: (method, p) => (state.table ?? classify)(method, p),
    localHere: (req, d) => {
      state.localAsked.push(req.url ?? '')
      return state.localHere ? state.localHere(req, d) : false
    },
  }
  dispatcher = createDispatcher(deps)
  pub = http.createServer((req, res) => dispatcher.middleware(req, res, () => { void local(req, res) }))
  pub.on('upgrade', (req, socket, head) => dispatcher.upgrade(req, socket, head))
  pubPort = await listen(pub)
})

afterAll(async () => {
  for (const d of [mac, companion]) { for (const s of d.sockets) s.destroy(); d.server.close() }
  pub.closeAllConnections?.()
  await new Promise((r) => pub.close(r))
})

beforeEach(reset)

/** One request to the public port, exactly these headers. */
function call(method: string, p: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? null : Buffer.from(opts.body)
    const req = http.request({
      host: '127.0.0.1', port: pubPort, method, path: p, agent: false,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}), ...opts.headers },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let json: any = null
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers, text })
      })
    })
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}

const QUEUE_ROW = (method: string, p: string): RouteDecision =>
  p.startsWith('/api/queued') ? { cls: 'leader', away: 'queue:task-fields', row: null } : classify(method, p)

describe('the Mac answers', () => {
  it('a read is forwarded as it came, with no op id, and says it was answered by the leader', async () => {
    const r = await call('GET', '/api/tasks?x=1', { headers: { authorization: 'Bearer phone' } })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ from: 'mac', url: '/api/tasks?x=1', opId: null })
    expect(r.headers['x-walnut-answered-via']).toBe('leader')
    expect(mac.seen[0]!.headers.authorization).toBe('Bearer phone')
    expect(mac.seen[0]!.headers[FORWARDED_AT_HEADER]).toBeUndefined()
  })

  it('a write keeps the client\'s op id, is stamped with when it was forwarded, and its body arrives as bytes', async () => {
    const before = Date.now()
    const r = await call('POST', '/api/tasks', { body: '{"title":"Acme"}', headers: { [OP_ID_HEADER]: 'op-client-123456' } })
    expect(r.json).toMatchObject({ from: 'mac', opId: 'op-client-123456' })
    expect(mac.seen[0]!.body).toBe('{"title":"Acme"}')
    const at = Number(mac.seen[0]!.headers[FORWARDED_AT_HEADER])
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('the forwarded-at stamp is the host\'s clock once the stream opened, not when the write arrived (an open can take seconds)', async () => {
    state.connectDelayMs = 1_000
    const arrived = Date.now()
    await call('POST', '/api/tasks', { body: '{}' })
    const at = Number(mac.seen[0]!.headers[FORWARDED_AT_HEADER])
    // A timer may fire a millisecond early by Date.now's clock.
    expect(at).toBeGreaterThanOrEqual(arrived + 990)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('a write with no op id (the phone app sends none) gets one minted here; a malformed one is replaced', async () => {
    const a = await call('PATCH', '/api/v1/tasks/t1', { body: '{}' })
    expect(a.json.opId).toMatch(/^op-[0-9a-f]{16}$/)
    const b = await call('PATCH', '/api/v1/tasks/t1', { body: '{}', headers: { [OP_ID_HEADER]: 'bad id!' } })
    expect(b.json.opId).toMatch(/^op-[0-9a-f]{16}$/)
    expect(b.json.opId).not.toBe(a.json.opId)
  })

  it('a read whose stream cannot open goes to the companion when it stands in, under the companion\'s own name', async () => {
    state.failConnect.add('leader')
    state.routeAfterFail = { kind: 'companion', origin: 'https://companion.example' }
    const r = await call('GET', '/api/tasks', { headers: { origin: 'https://devbox.example' } })
    expect(r.json).toMatchObject({ from: 'companion' })
    expect(r.headers['x-walnut-answered-via']).toBe('companion')
    expect(companion.seen[0]!.headers).toMatchObject({ host: 'companion.example', origin: 'https://companion.example' })
    expect(state.suspects).toEqual(['leader'])
  })

  it('a read nobody else can take is answered here, from the copies, marked offline', async () => {
    state.failConnect.add('leader')
    state.routeAfterFail = { kind: 'alone', why: 'mac-away' }
    const r = await call('GET', '/api/tasks')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ from: 'replica', offline: String(AS_OF) })
    expect(r.headers[OFFLINE_HEADER]).toBe(String(AS_OF))
    expect(r.headers['x-walnut-answered-via']).toBe('replica')
  })

  it('a read the Mac took and then dropped is answered here too (nothing is changed by reading)', async () => {
    state.routeAfterFail = { kind: 'alone', why: 'unreachable' }
    const r = await call('GET', '/drop/tasks')
    expect(r.json).toMatchObject({ from: 'replica' })
    expect(mac.seen.length).toBe(1)
  })

  it('the companion standing in takes reads and writes the way the host server sends them', async () => {
    state.route = { kind: 'companion', origin: 'https://companion.example' }
    const r = await call('POST', '/api/tasks', { body: '{}', headers: { [OP_ID_HEADER]: 'op-standin-1' } })
    expect(r.json).toMatchObject({ from: 'companion', opId: 'op-standin-1' })
    expect(state.connects).toEqual(['companion'])
  })
})

describe('a write to the Mac that fails', () => {
  it('after it was written: 504 primary_timeout, never journaled, never repeated', async () => {
    state.table = QUEUE_ROW
    const r = await call('POST', '/api/queued/drop', { body: '{"a":1}', headers: { [OP_ID_HEADER]: 'op-sent-0001' } })
    expect(r.status).toBe(504)
    expect(r.json.error.code).toBe('primary_timeout')
    // It reached the Mac, which may have applied it: never "nothing was saved".
    expect(r.json.error.sent).toBe(true)
    expect(r.json.error.message).toMatch(/may have kept the change/)
    expect(r.json.error.message).not.toMatch(/Nothing was saved/)
    expect(mac.seen.length).toBe(1)
    expect(state.ops).toEqual([])
    expect(state.logs.find((l) => l.msg === 'replica: a forwarded write got no answer')?.data).toMatchObject({ opId: 'op-sent-0001', to: 'leader' })
  })

  it('the write budget: a write that says its wait, no answer within it (at least 15 s) is 504, for that request alone: the Mac is not suspect', async () => {
    expect(WRITE_BUDGET_MS).toBe(15_000)
    const t0 = Date.now()
    // A wait under the floor gets the floor.
    const r = await call('PUT', '/hang/x', { body: '{}', headers: { [WAIT_HEADER]: '1000' } })
    const took = Date.now() - t0
    expect(r.status).toBe(504)
    expect(r.json.error).toMatchObject({ code: 'primary_timeout', sent: true })
    expect(took).toBeGreaterThanOrEqual(state.writeBudgetMs - 50)
    expect(took).toBeLessThan(state.writeBudgetMs + 3_000)
    expect(state.suspects).toEqual([])
  })

  it('before its stream opened: provably not sent, so answered away (503 needs_leader for a write that needs the Mac)', async () => {
    state.failConnect.add('leader')
    const r = await call('POST', '/api/tasks', { body: '{}' })
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'needs_leader', why: 'unreachable', retryAfter: 5 })
    expect(r.headers['retry-after']).toBe('5')
    expect(mac.seen).toEqual([])
  })

  it('before its stream opened, on a journaling row: the away write runs with the same op id', async () => {
    state.table = QUEUE_ROW
    state.failConnect.add('leader')
    const r = await call('POST', '/api/queued/x', { body: '{"title":"Acme"}', headers: { [OP_ID_HEADER]: 'op-notsent-01' } })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ from: 'replica', opId: 'op-notsent-01', raw: '{"title":"Acme"}', result: { kind: 'applied' } })
    expect(state.ops).toEqual([{ op: 'task-fields', args: { id: 't1', title: 'Acme' }, opId: 'op-notsent-01', base: { title: 'old' } }])
  })
})

describe('the Mac away', () => {
  beforeEach(() => { state.route = { kind: 'alone', why: 'mac-away' } })

  it('a read runs here on the copies, x-walnut-offline says how fresh; a page gets the alone page', async () => {
    const r = await call('GET', '/api/v1/tasks')
    expect(r.json).toEqual({ from: 'replica', offline: String(AS_OF) })
    const page = await call('GET', '/sessions', { headers: { accept: 'text/html' } })
    expect(page.text).toBe('<p data-why="mac-away">alone</p>')
    // An asset is no page.
    expect((await call('GET', '/assets/app.js', { headers: { accept: 'text/html' } })).json).toMatchObject({ from: 'replica' })
    expect(state.connects).toEqual([])
  })

  it('a write that needs the Mac is 503 needs_leader with its reason', async () => {
    const r = await call('PATCH', '/api/v1/tasks/t1', { body: '{}' })
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'needs_leader', why: 'task_writes_need_mac', retryAfter: 5 })
    expect(r.headers[OFFLINE_HEADER]).toBe(String(AS_OF))
  })

  it('a refusal of the daemon reaches the route', async () => {
    state.table = QUEUE_ROW
    state.opAnswers.push({ ok: false, errorKind: 'queue_full', error: 'the journal is full' })
    const r = await call('POST', '/api/queued/x', { body: '{}' })
    expect(r.json.result).toEqual({ kind: 'refused', code: 'queue_full', message: 'the journal is full' })
  })

  it('a body that is not JSON is 400 before any write', async () => {
    state.table = QUEUE_ROW
    const r = await call('POST', '/api/queued/x', { body: '{not json' })
    expect(r.status).toBe(400)
    expect(state.ops).toEqual([])
  })
})

describe('follower.op (the away write, WP10 calls it)', () => {
  beforeEach(() => { state.route = { kind: 'alone', why: 'mac-away' }; state.table = QUEUE_ROW })

  it('leader_answers (the view was stale): forwarded to the Mac once, with the same op id and the raw body', async () => {
    state.opAnswers.push({ ok: false, errorKind: 'leader_answers', error: 'the leader answers' })
    const r = await call('POST', '/api/queued/x', { body: '{"title":"Acme"}', headers: { [OP_ID_HEADER]: 'op-stale-view1' } })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ from: 'mac', opId: 'op-stale-view1' })
    expect(mac.seen.length).toBe(1)
    expect(mac.seen[0]!.body).toBe('{"title":"Acme"}')
    expect(mac.seen[0]!.headers[FORWARDED_AT_HEADER]).toBeTruthy()
    expect(state.ops.length).toBe(1)
    // The Mac answered it: no away marks left from the away path it started on.
    expect(r.headers[OFFLINE_HEADER]).toBeUndefined()
    expect(r.headers['x-walnut-answered-via']).toBe('leader')
  })

  it('leader_answers after a lost answer: the first try may be journaled, so it is not forwarded (503 leader_unsure)', async () => {
    state.opAnswers.push(new Error('follower.op timed out'), { ok: false, errorKind: 'leader_answers', error: 'the leader answers' })
    const r = await call('POST', '/api/queued/x', { body: '{}', headers: { [OP_ID_HEADER]: 'op-lost-then-mac' } })
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'leader_unsure', why: 'lost_answer', retryAfter: 5 })
    expect(mac.seen).toEqual([])
    expect(state.ops.map((o) => o.opId)).toEqual(['op-lost-then-mac', 'op-lost-then-mac'])
  })

  it('leader_answers after a lost answer, the daemon saying the op id is not in its journal: forwarded once', async () => {
    state.opAnswers.push(new Error('follower.op timed out'), { ok: false, errorKind: 'leader_answers', error: 'the leader answers', opPending: false })
    const r = await call('POST', '/api/queued/x', { body: '{}', headers: { [OP_ID_HEADER]: 'op-lost-unknown' } })
    expect(r.json).toMatchObject({ from: 'mac', opId: 'op-lost-unknown' })
    expect(mac.seen.length).toBe(1)
  })

  it('a body is read only for a known device: 401 before any byte of it, and nothing submitted', async () => {
    state.authorized = false
    const r = await call('POST', '/api/queued/x', { body: '{"title":"Acme"}' })
    expect(r.status).toBe(401)
    expect(r.json).toMatchObject({ code: 'token_refused' })
    expect(state.ops).toEqual([])
  })

  it('a body over 15 MB by its content-length is answered 413 before it is read, and the answer arrives', async () => {
    const r = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: pubPort, method: 'POST', path: '/api/queued/x', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(16 * 1024 * 1024) } }, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.write('{"a":')
    })
    expect(r.status).toBe(413)
    expect(r.json.error.code).toBe('too_large')
    expect(state.ops).toEqual([])
  })

  it('leader_answers, and that forward fails before any byte: 503 leader_unsure, retry in 5 s', async () => {
    state.opAnswers.push({ ok: false, errorKind: 'leader_answers', error: 'the leader answers' })
    state.failConnect.add('leader')
    const r = await call('POST', '/api/queued/x', { body: '{}' })
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'leader_unsure', retryAfter: 5 })
    expect(state.suspects).toEqual(['leader'])
  })

  it('leader_answers, and the Mac took that forward and dropped it: 504, never journaled', async () => {
    state.opAnswers.push({ ok: false, errorKind: 'leader_answers', error: 'the leader answers' })
    const r = await call('POST', '/api/queued/drop', { body: '{}' })
    expect(r.status).toBe(504)
    expect(state.ops.length).toBe(1)
  })

  it('a lost answer is asked again with the SAME op id (the daemon dedupes)', async () => {
    state.opAnswers.push(new Error('follower.op timed out'), { ok: false, error: 'closed' }, { ok: true, seq: 7 })
    const r = await call('POST', '/api/queued/x', { body: '{}', headers: { [OP_ID_HEADER]: 'op-lost-answer' } })
    expect(r.json.result).toEqual({ kind: 'applied', reply: { ok: true, seq: 7 } })
    expect(state.ops.map((o) => o.opId)).toEqual(['op-lost-answer', 'op-lost-answer', 'op-lost-answer'])
  })

  it('no answer at all after the tries: 503 journal_unwritable, retry in 5 s', async () => {
    state.opAnswers.push(new Error('lost'), new Error('lost'), new Error('lost'))
    const r = await call('POST', '/api/queued/x', { body: '{}' })
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'journal_unwritable', retryAfter: 5 })
    expect(new Set(state.ops.map((o) => o.opId)).size).toBe(1)
  })

  it('a try the link refused (never sent) is no lost answer: the next try waits for the link, and leader_answers then forwards', async () => {
    state.linked = false
    setTimeout(() => { state.linked = true }, 300)
    state.opAnswers.push({ ok: false, errorKind: 'leader_answers', error: 'the leader answers' })
    const t0 = Date.now()
    const r = await call('POST', '/api/queued/x', { body: '{}', headers: { [OP_ID_HEADER]: 'op-unsent-first' } })
    // Waited for the link (not three tries burnt in a millisecond), and forwarded: nothing was journaled.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(state.opsWhileDown).toBe(1)
    expect(r.json).toMatchObject({ from: 'mac', opId: 'op-unsent-first' })
    expect(state.ops.map((o) => o.opId)).toEqual(['op-unsent-first'])
  })

  it('the link down through every try: 503 needs_leader daemon_unreachable (retryable), never journal_unwritable', async () => {
    state.linked = false
    const r = await call('POST', '/api/queued/x', { body: '{}' })
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'needs_leader', why: 'daemon_unreachable', retryAfter: 5 })
    expect(state.ops).toEqual([])
    expect(state.opsWhileDown).toBe(3)
  }, 15_000)

  it('a lost answer, then the link down for the other tries: may be journaled, so 503 journal_unwritable', async () => {
    state.opAnswers.push(new Error('follower.op timed out'))
    state.downAfterOps = 1
    const r = await call('POST', '/api/queued/x', { body: '{}' })
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'journal_unwritable' })
    expect(state.ops.length).toBe(1)
    expect(state.opsWhileDown).toBe(2)
  }, 15_000)

  it('a daemon without replica-ops-v1: 503 needs_leader daemon_needs_upgrade, follower.op never asked', async () => {
    state.opsCap = false
    const r = await call('POST', '/api/queued/x', { body: '{}' })
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'needs_leader', why: 'daemon_needs_upgrade' })
    expect(state.ops).toEqual([])
    expect(state.opsWhileDown).toBe(0)
  })

  it('no hello answered yet (capabilities unknown): 503 needs_leader daemon_unreachable, follower.op never asked', async () => {
    state.opsCap = null
    const r = await call('POST', '/api/queued/x', { body: '{}' })
    expect(r.json.error).toMatchObject({ code: 'needs_leader', why: 'daemon_unreachable' })
    expect(state.ops).toEqual([])
  })

  it('ensureOpId keeps a well-formed client id and mints one otherwise', () => {
    const req = { headers: { [OP_ID_HEADER]: 'op-abcdef' } } as unknown as IncomingMessage
    expect(ensureOpId(req)).toBe('op-abcdef')
    const none = { headers: {} } as unknown as IncomingMessage
    const id = ensureOpId(none)
    expect(none.headers[OP_ID_HEADER]).toBe(id)
  })
})

async function until(fn: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function openWs(p = '/ws'): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }>; status?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${pubPort}${p}`)
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: String(reason) })))
    ws.once('open', () => resolve({ ws, closed }))
    ws.once('unexpected-response', (_req, res) => { resolve({ ws, closed, status: res.statusCode }); ws.terminate() })
    ws.once('error', (e) => { if (ws.readyState !== WebSocket.CLOSED) reject(e) })
  })
}

function echo(ws: WebSocket, text: string): Promise<string> {
  return new Promise((resolve) => { ws.once('message', (m) => resolve(String(m))); ws.send(text) })
}

describe('WebSockets and presence flips', () => {
  it('an upgrade is spliced raw to the Mac while it answers, to the companion while it stands in, and is the replica\'s own away', async () => {
    const a = await openWs()
    expect(await echo(a.ws, 'hello')).toBe('mac:hello')
    expect(dispatcher.counts().spliced).toBe(1)
    a.ws.close()
    await a.closed
    await until(() => dispatcher.counts().spliced === 0)
    state.route = { kind: 'companion', origin: 'https://companion.example' }
    const b = await openWs()
    expect(await echo(b.ws, 'hi')).toBe('companion:hi')
    // Only sockets spliced to the Mac are the ones a flip closes.
    expect(dispatcher.counts().spliced).toBe(0)
    b.ws.close()
    state.route = { kind: 'alone', why: 'mac-away' }
    expect((await openWs()).status).toBe(418)
  })

  it('an upgrade whose stream cannot open, the Mac now away: the replica\'s own socket', async () => {
    state.failConnect.add('leader')
    state.routeAfterFail = { kind: 'alone', why: 'unreachable' }
    expect((await openWs()).status).toBe(418)
  })

  it('a flip to away answers every in-flight forward to the Mac 504 at once', async () => {
    const t0 = Date.now()
    const pending = [call('PUT', '/hang/one', { body: '{}' }), call('GET', '/hang/two')]
    await until(() => mac.seen.length === 2)
    expect(dispatcher.counts().inFlight).toBe(2)
    dispatcher.presenceChanged(true) // still answering: nothing moves
    expect(dispatcher.counts().inFlight).toBe(2)
    dispatcher.presenceChanged(false)
    const [w, r] = await Promise.all(pending)
    expect(w.status).toBe(504)
    expect(r.status).toBe(504)
    expect(Date.now() - t0).toBeLessThan(state.writeBudgetMs)
    expect(dispatcher.counts().inFlight).toBe(0)
    expect(state.logs.find((l) => l.msg.startsWith('replica: the Mac went away'))?.data).toMatchObject({ forwards: 2 })
  })

  it('a flip to away closes every socket spliced to the Mac with 4001 leader_away', async () => {
    const a = await openWs()
    expect(await echo(a.ws, 'x')).toBe('mac:x')
    dispatcher.presenceChanged(false)
    expect(await a.closed).toEqual({ code: 4001, reason: 'leader_away' })
    expect(dispatcher.counts().spliced).toBe(0)
  })

  it('a close frame is a server frame: unmasked, code then reason', () => {
    const f = closeFrame(4002, 'leader_back')
    expect(f[0]).toBe(0x88)
    expect(f[1]).toBe(2 + 'leader_back'.length)
    expect(f.readUInt16BE(2)).toBe(4002)
    expect(f.subarray(4).toString()).toBe('leader_back')
  })
})

/** Uncaught errors while `fn` runs (vitest would also fail the run on one; this names it). */
async function noUncaught(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = []
  const onErr = (err: Error) => { seen.push(`${(err as Error & { code?: string }).code ?? ''} ${err.message}`) }
  process.on('uncaughtException', onErr)
  try { await fn() } finally { process.off('uncaughtException', onErr) }
  return seen
}

/** An upgrade on a raw socket, reset (RST) after `afterMs`. */
function upgradeThenReset(afterMs: number): Promise<void> {
  return new Promise((resolve) => {
    const c = net.connect(pubPort, '127.0.0.1', () => {
      c.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
      setTimeout(() => { c.resetAndDestroy(); resolve() }, afterMs)
    })
    c.on('error', () => {})
  })
}

describe('a browser that goes away', () => {
  it('resets its upgrade while the stream to the Mac opens: nothing raises, and the Mac is not suspect', async () => {
    state.connectDelayMs = 300
    const errors = await noUncaught(async () => {
      await upgradeThenReset(100)
      await new Promise((r) => setTimeout(r, 600))
    })
    expect(errors).toEqual([])
    expect(state.suspects).toEqual([])
    expect(dispatcher.counts()).toMatchObject({ handshakes: 0, spliced: 0 })
  })

  it('resets its upgrade, and then the stream fails to open: nothing raises, nothing is written', async () => {
    state.connectDelayMs = 300
    state.failConnect.add('leader')
    const errors = await noUncaught(async () => {
      await upgradeThenReset(100)
      await new Promise((r) => setTimeout(r, 600))
    })
    expect(errors).toEqual([])
    expect(dispatcher.counts().handshakes).toBe(0)
  })

  it('cancels a forwarded read: the Mac is not suspect, and a write in flight beside it is untouched', async () => {
    const write = call('PUT', '/slow/700/w', { body: '{}', headers: { [OP_ID_HEADER]: 'op-beside-cancel' } })
    const read = http.get({ host: '127.0.0.1', port: pubPort, path: '/hang/read', agent: false })
    read.on('error', () => {})
    await until(() => mac.seen.some((x) => x.url === '/hang/read'))
    read.destroy()
    await new Promise((r) => setTimeout(r, 200))
    expect(state.suspects).toEqual([])
    const w = await write
    expect(w.status).toBe(200)
    expect(w.json).toMatchObject({ from: 'mac', opId: 'op-beside-cancel' })
    expect(state.suspects).toEqual([])
  })

  it('cancels a write before its stream opened, and one the Mac took: no suspect either way', async () => {
    state.connectDelayMs = 300
    const early = http.request({ host: '127.0.0.1', port: pubPort, method: 'POST', path: '/api/tasks', agent: false, headers: { 'content-type': 'application/json', 'content-length': '2' } })
    early.on('error', () => {})
    early.end('{}')
    await new Promise((r) => setTimeout(r, 100))
    early.destroy()
    await new Promise((r) => setTimeout(r, 400))
    state.connectDelayMs = 0
    const sent = http.request({ host: '127.0.0.1', port: pubPort, method: 'POST', path: '/hang/w2', agent: false, headers: { 'content-type': 'application/json', 'content-length': '2' } })
    sent.on('error', () => {})
    sent.end('{}')
    await until(() => mac.seen.some((x) => x.url === '/hang/w2'))
    sent.destroy()
    await new Promise((r) => setTimeout(r, 200))
    expect(state.suspects).toEqual([])
    expect(dispatcher.counts().inFlight).toBe(0)
  })
})

describe('the write budget is no presence signal', () => {
  it('a write that says its own longer wait (x-walnut-wait-ms) gets it, and a live Mac answers it past 15 s worth of budget', async () => {
    const r = await call('PUT', '/slow/3000/confirm', { body: '{}', headers: { [WAIT_HEADER]: '6000' } })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ from: 'mac' })
    expect(state.suspects).toEqual([])
  })

  it('one write over its budget is 504 alone: another in flight beside it is answered by the Mac', async () => {
    const [late, slow] = await Promise.all([
      call('PUT', '/hang/late', { body: '{}', headers: { [WAIT_HEADER]: '1000' } }),
      call('PUT', '/slow/2800/beside', { body: '{}', headers: { [WAIT_HEADER]: '6000' } }),
    ])
    expect(late.status).toBe(504)
    expect(slow.status).toBe(200)
    expect(state.suspects).toEqual([])
  })

  it('the budget runs from the request fully written: a slow upload is no slow Mac', async () => {
    const r = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const body = '{"text":"' + 'a'.repeat(1000) + '"}'
      const req = http.request({ host: '127.0.0.1', port: pubPort, method: 'POST', path: '/api/uploads', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(body.length), [WAIT_HEADER]: '1000' } }, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.write(body.slice(0, 10))
      setTimeout(() => req.end(body.slice(10)), state.writeBudgetMs + 500)
    })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ from: 'mac' })
  })

  it('writeBudgetOf: the client\'s wait, at least the floor, capped; a client that says none is held past its own deadline', () => {
    const req = (v?: string) => ({ headers: v === undefined ? {} : { [WAIT_HEADER]: v } }) as unknown as IncomingMessage
    expect(writeBudgetOf(req('180000'), 15_000)).toBe(180_000)
    expect(writeBudgetOf(req('5000'), 15_000)).toBe(15_000)
    expect(writeBudgetOf(req(String(24 * 3_600_000)), 15_000)).toBe(MAX_WRITE_BUDGET_MS)
    // No wait said (the iOS app, a raw fetch), or no number: the backstop.
    expect(writeBudgetOf(req(), 15_000)).toBe(MAX_WRITE_BUDGET_MS)
    expect(writeBudgetOf(req('nope'), 15_000)).toBe(MAX_WRITE_BUDGET_MS)
    // Past the iOS app's longest own wait (a voice transcription, 900 s).
    expect(MAX_WRITE_BUDGET_MS).toBeGreaterThan(900_000)
  })

  it('a write that says no wait (the iOS app) is never cut while a live Mac works on it: a side question answered past the budget is 200', async () => {
    const t0 = Date.now()
    // The door answers after 3 s, past this dispatcher's 2 s floor (15 s in production, and the Mac took 17 s).
    const r = await call('POST', '/api/v1/sessions/s1/side-question?door=/slow/3000', { body: '{"question":"why"}', headers: { authorization: 'Bearer phone' } })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ from: 'mac' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3_000)
    expect(mac.seen[0]!.headers[OP_ID_HEADER]).toMatch(/^op-[0-9a-f]{16}$/)
    expect(state.suspects).toEqual([])
  })
})

describe('WebSocket handshakes and the companion\'s sockets', () => {
  it('a handshake the Mac never answers is 504 after the budget, and the Mac is not suspect', async () => {
    const t0 = Date.now()
    const a = await openWs('/ws-hang')
    expect(a.status).toBe(504)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(state.writeBudgetMs - 50)
    expect(state.suspects).toEqual([])
    expect(dispatcher.counts().handshakes).toBe(0)
  })

  it('a handshake still waiting on the Mac at a flip to away is dispatched again: the replica\'s own socket', async () => {
    const pending = openWs('/ws-hang')
    await until(() => dispatcher.counts().handshakes === 1)
    state.route = { kind: 'alone', why: 'mac-away' }
    dispatcher.presenceChanged(false)
    expect((await pending).status).toBe(418)
    expect(dispatcher.counts().handshakes).toBe(0)
  })

  it('the Mac back: a socket the companion took while it stood in closes 4002 leader_back', async () => {
    state.route = { kind: 'companion', origin: 'https://companion.example' }
    const b = await openWs()
    expect(await echo(b.ws, 'hi')).toBe('companion:hi')
    expect(dispatcher.counts()).toMatchObject({ standIn: 1, spliced: 0 })
    state.route = { kind: 'leader' }
    dispatcher.presenceChanged(true)
    expect(await b.closed).toEqual({ code: 4002, reason: 'leader_back' })
    expect(dispatcher.counts().standIn).toBe(0)
  })
})

describe('what a 504 or 503 tells the user', () => {
  it('a flip while the stream still opens: provably never sent, so "nothing was saved"', async () => {
    state.connectDelayMs = 400
    const pending = call('PUT', '/api/tasks/t1', { body: '{}' })
    await until(() => dispatcher.counts().inFlight === 1)
    dispatcher.presenceChanged(false)
    const r = await pending
    expect(r.status).toBe(504)
    expect(r.json.error).toMatchObject({ code: 'primary_timeout', sent: false })
    expect(r.json.error.message).toMatch(/Nothing was saved/)
    await new Promise((res) => setTimeout(res, 600))
    expect(mac.seen).toEqual([])
  })

  it('a flip once the write reached the Mac: it may have kept the change', async () => {
    const pending = call('PUT', '/hang/flip-sent', { body: '{}' })
    await until(() => mac.seen.some((x) => x.url === '/hang/flip-sent'))
    dispatcher.presenceChanged(false)
    const r = await pending
    expect(r.json.error).toMatchObject({ code: 'primary_timeout', sent: true })
    expect(r.json.error.message).toMatch(/may have kept the change; check it before you try again/)
  })

  it('follower.op answers lost after every try: the daemon may have journaled it, so never "try again" alone', async () => {
    state.table = QUEUE_ROW
    state.route = { kind: 'alone', why: 'mac-away' }
    state.opAnswers.push(new Error('lost'), new Error('lost'), new Error('lost'))
    const r = await call('POST', '/api/queued/x', { body: '{}' })
    expect(r.json.error.code).toBe('journal_unwritable')
    expect(r.json.error.message).toMatch(/may have kept the change/)
  })
})

/** A WebSocket to the door's hand-made socket: what it receives, and how it closes. */
async function partialWs() {
  const a = await openWs('/ws-partial')
  const messages: string[] = []
  // A broken frame (bad UTF-8, a bad opcode, a reserved bit) is an error here; a lost socket is not.
  const errors: string[] = []
  a.ws.on('message', (m) => messages.push(String(m)))
  a.ws.on('error', (e) => errors.push(e.message))
  await until(() => mac.partials.length === 1 && dispatcher.counts().spliced === 1)
  return { ...a, messages, errors, mac: mac.partials[0]! }
}

describe('a flip closes a spliced socket between two frames', () => {
  it('the Mac in the middle of a frame: the browser gets the whole frame, then the 4001 close', async () => {
    const w = await partialWs()
    // A text frame of 10 bytes: its header and the first 5 bytes now, the rest after the flip.
    w.mac.write(Buffer.concat([Buffer.from([0x81, 10]), Buffer.from('hello')]))
    await new Promise((r) => setTimeout(r, 150))
    dispatcher.presenceChanged(false)
    await new Promise((r) => setTimeout(r, 100))
    w.mac.write('world')
    expect(await w.closed).toEqual({ code: 4001, reason: 'leader_away' })
    expect(w.messages).toEqual(['helloworld'])
    expect(w.errors).toEqual([])
    expect(dispatcher.counts().spliced).toBe(0)
  })

  it('a frame over 125 bytes (a 16-bit length) split across writes is passed on whole too', async () => {
    const w = await partialWs()
    const text = 'acme '.repeat(60)
    const head = Buffer.from([0x81, 126, 0, 0])
    head.writeUInt16BE(text.length, 2)
    w.mac.write(Buffer.concat([Buffer.from([0x81, 2]), Buffer.from('ok'), head.subarray(0, 3)]))
    await new Promise((r) => setTimeout(r, 150))
    dispatcher.presenceChanged(false)
    w.mac.write(Buffer.concat([head.subarray(3), Buffer.from(text)]))
    expect(await w.closed).toEqual({ code: 4001, reason: 'leader_away' })
    expect(w.messages).toEqual(['ok', text])
    expect(w.errors).toEqual([])
  })

  it('a Mac frozen in the middle of a frame: the socket is dropped (1006) within a second or so, never a broken frame', async () => {
    const w = await partialWs()
    w.mac.write(Buffer.concat([Buffer.from([0x81, 10]), Buffer.from('hello')]))
    await new Promise((r) => setTimeout(r, 150))
    const t0 = Date.now()
    dispatcher.presenceChanged(false)
    expect((await w.closed).code).toBe(1006)
    // It waited for the rest of the frame (1 s), then let the socket go: no close frame read as payload.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(w.messages).toEqual([])
    expect(w.errors).toEqual([])
  })
})

describe('a local row with a condition (WP6, self-host.ts)', () => {
  it('this host\'s data runs here while the Mac answers, with no stream; anything else is the Mac\'s', async () => {
    state.localHere = () => true
    const here = await call('GET', '/api/sessions/s-host/history')
    expect(here.json).toMatchObject({ from: 'replica', offline: null })
    expect(state.connects).toEqual([])
    expect(mac.seen).toHaveLength(0)
    state.localHere = async () => { await new Promise((r) => setTimeout(r, 20)); return false }
    const there = await call('GET', '/api/sessions/s-mac/history')
    expect(there.json).toMatchObject({ from: 'mac' })
    expect(state.connects).toEqual(['leader'])
    expect(state.localAsked).toEqual(['/api/sessions/s-host/history', '/api/sessions/s-mac/history'])
  })

  it('a judge that throws is a no: the Mac answers; a local row without a condition never asks', async () => {
    state.localHere = () => { throw new Error('store unreadable') }
    expect((await call('GET', '/api/file-content?host=devbox&path=/x')).json).toMatchObject({ from: 'mac' })
    const health = await call('GET', '/api/health')
    expect(health.json).toMatchObject({ from: 'replica' })
    expect(state.localAsked).toEqual(['/api/file-content?host=devbox&path=/x'])
  })

  it('while the Mac is away a no is a read on this replica\'s copies, as any read row', async () => {
    state.route = { kind: 'alone', why: 'quiet' } as Route
    state.localHere = () => false
    const r = await call('GET', '/api/sessions/s-mac/history')
    expect(r.json).toMatchObject({ from: 'replica' })
    expect(r.json.offline).not.toBeNull()
    expect(state.connects).toEqual([])
  })

  it('the real judge: a file route with no host goes to the Mac (a sessionId of this host does not decide), and needs it while away', async () => {
    const { installSelfHost, clearSelfHost, isLocalHere } = await import('../../src/replica/self-host.js')
    installSelfHost({ aliases: ['devbox'], link: { state: () => 'up', capabilities: () => ['replica-reads-v1'], request: async () => ({ ok: true }) } })
    try {
      const lookup = async (sid: string) => (sid === 's-host' ? { host: 'devbox' } : null)
      // The judge front.ts wires (src/replica/front.ts localHere).
      state.localHere = (req, d) => (d.row?.local ? isLocalHere(req.url ?? '', d.row.local, lookup) : true)
      const own = encodeURIComponent('/home/u/.ssh/id_ed25519')
      expect((await call('GET', `/api/file-content?path=${own}&sessionId=s-host`)).json).toMatchObject({ from: 'mac' })
      expect((await call('GET', '/api/files/list?path=%2F&sessionId=s-host')).json).toMatchObject({ from: 'mac' })
      expect((await call('GET', `/api/file-content?host=devbox&path=${own}`)).json).toMatchObject({ from: 'replica' })
      expect(state.connects).toEqual(['leader', 'leader'])
      state.route = { kind: 'alone', why: 'quiet' } as Route
      for (const p of [`/api/file-content?path=${own}&sessionId=s-host`, `/api/file-content?host=other-box&path=${own}`, '/api/file-raw/devbox/etc/hosts', '/api/file-history?path=%2Fx']) {
        const r = await call('GET', p)
        expect(r.status, p).toBe(503)
        expect(r.json, p).toMatchObject({ error: { code: 'needs_leader' } })
      }
      expect((await call('GET', `/api/file-content?host=devbox&path=${own}`)).json).toMatchObject({ from: 'replica' })
    } finally {
      clearSelfHost()
    }
  })
})
