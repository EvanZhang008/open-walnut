/**
 * What a host replica tells browsers about the Mac (src/replica/front.ts
 * header, the contract with the web client; presence.ts wireLeaderPresence):
 *
 *   answers:true is told only once a probe stream to the Mac opened, and only
 *     then are the replica's own sockets closed 4002 leader_back; a Mac whose
 *     frames flow while its stream door refuses is never told back
 *   a socket that joined while the replica answered alone is closed 4002
 *     companion_stands_in once a probe to the companion opened
 *   an answer from the copies says `x-walnut-offline-why: suspect` while a
 *     stream to a live Mac failed, `away` once the Mac is away; the copies' age
 *     is their last completed round, 0 (the event: null) while none completed
 *   every answer carries x-walnut-presence-seq (bumped on every change of what
 *     is told) and x-walnut-presence-boot (one per process)
 *   an alone page left open from before the host switched program is told the
 *     console answers, and reloads into it
 *
 * The real front (startReplicaFront) with its real dispatcher, presence wiring
 * and byte forwards; only the follower link is the test's (the daemon's view,
 * and streams to a test Mac and a test companion whose doors may refuse).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import vm from 'node:vm'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'
import { sha256 } from '../helpers/replica-host-env.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-presence-signals'))

import { startReplicaFront, type PresenceEvent, type ReplicaFront } from '../../src/replica/front.js'
import type { FollowerView } from '../../src/host-server/daemon-link.js'
import type { DeviceCopy } from '../../src/host-server/device-copy.js'
import { createLinkEvents } from '../../src/core/link/link.js'
import type { FollowerLink } from '../../src/core/link/follower-link.js'
import { _resetReplicaAuthForTesting, replicaDeviceCopy } from '../../src/replica/auth.js'
import { _resetCopyRoundClockForTesting, copiesAsOf } from '../../src/core/replication/kind-follower.js'
import { sha12 } from '../../src/core/replication/kind.js'
import { alonePage } from '../../src/host-server/alone-page.js'
import { memFollower } from '../helpers/replica-kind-harness.js'

const TOKEN = 'marina-phone-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const AS_OF = 1_760_000_000_000

/** A box behind a stream: /api answers say who answered; other paths 404 (a dev server, no static); /ws echoes. */
function box(name: string): { server: http.Server; seen: string[]; sockets: Set<net.Socket>; wss: WebSocketServer } {
  const seen: string[] = []
  const sockets = new Set<net.Socket>()
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    req.resume()
    req.on('end', () => {
      const api = (req.url ?? '').startsWith('/api/')
      res.writeHead(api ? 200 : 404, { 'content-type': 'application/json' })
      res.end(api ? JSON.stringify({ from: name }) : JSON.stringify({ error: { code: 'not_found' } }))
    })
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => { wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`${name}:${String(m)}`))) })
  return { server, seen, sockets, wss }
}
const mac = box('mac')
const companion = box('companion')
const ports = { mac: 0, companion: 0 }

/** The daemon's view, and whether each door takes a stream. */
const daemon = { heardAgoMs: 0, holder: 'primary' as 'primary' | 'companion', bridge: false }
const door = { primary: 'open' as 'open' | 'refuse', companion: 'open' as 'open' | 'refuse' }
const opened: string[] = []

function view(): FollowerView {
  return {
    walnutId: 'w-acme', home: '/acme', epoch: 1, holder: daemon.holder, backup: false,
    primaryConnected: true, primaryHeardAgoMs: daemon.heardAgoMs, takeoverMs: 30_000, quietMs: 30_000, drainablePending: 0,
    bridge: { connected: daemon.bridge, companion: daemon.bridge ? 'https://companion.acme.test' : null }, settings: {},
  } as unknown as FollowerView
}

function connect(port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

function fakeLink(): FollowerLink {
  const events = createLinkEvents()
  return {
    peer: { host: 'marina', walnutId: 'w-acme' },
    state: () => 'up',
    heard: () => daemon.heardAgoMs,
    request: async () => ({ ok: false, error: 'not in this test' }),
    on: (event, cb) => events.on(event, cb),
    openStream: (to) => {
      opened.push(to)
      if ((to === 'primary' ? door.primary : door.companion) === 'refuse') return Promise.reject(new Error(`the ${to}'s door refused the stream`))
      return connect(to === 'primary' ? ports.mac : ports.companion)
    },
    start: () => {},
    stop: () => {},
    view: () => ({ view: view(), at: Date.now() }),
    linkState: () => 'following',
    lastError: () => null,
    report: () => {},
    capabilities: () => ['replica-ops-v1'],
  }
}

let front: ReplicaFront
let pub: http.Server
let pubPort = 0
const told: PresenceEvent[] = []
const ownCloses: Array<{ code: number; reason: string }> = []
/** The replica's own /ws (what a browser reaches while the replica answers alone). */
const own = new WebSocketServer({ noServer: true })

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
}

function makeFront(): ReplicaFront {
  return startReplicaFront({
    env: { publicPort: 0, daemonDir: '/nonexistent-acme', leaderHome: '/acme', walnutId: 'w-acme', followerToken: 'tok-acme', label: 'marina' },
    devices: { hash: () => '' } as unknown as DeviceCopy,
    acceptFromLeader: (stream) => { stream.destroy() },
    hostKey: 'devbox',
    broadcast: (name, data) => { if (name === 'replica:presence') told.push(data as PresenceEvent) },
    closeOwnSockets: (code, reason) => {
      ownCloses.push({ code, reason })
      for (const c of own.clients) c.close(code, reason)
    },
    link: fakeLink(),
  })
}

beforeAll(async () => {
  ports.mac = await listen(mac.server)
  ports.companion = await listen(companion.server)
  _resetReplicaAuthForTesting()
  expect(replicaDeviceCopy().put({ devices: [{ name: 'marina-phone', tokenHash: sha256(TOKEN) }] })).toMatchObject({ ok: true })
})

afterAll(async () => {
  for (const b of [mac, companion]) {
    for (const s of b.sockets) s.destroy()
    b.wss.close()
    await new Promise((r) => b.server.close(r))
  }
  own.close()
})

beforeEach(async () => {
  daemon.heardAgoMs = 0; daemon.holder = 'primary'; daemon.bridge = false
  door.primary = 'open'; door.companion = 'open'
  opened.length = 0; told.length = 0; ownCloses.length = 0
  mac.seen.length = 0; companion.seen.length = 0
  _resetCopyRoundClockForTesting()
  front = makeFront()
  pub = http.createServer((req, res) => front.middleware(req, res, () => {
    const answer = () => {
      const api = (req.url ?? '').startsWith('/api/')
      res.writeHead(api ? 200 : 404, { 'content-type': 'application/json' })
      res.end(api ? JSON.stringify({ from: 'replica' }) : JSON.stringify({ error: { code: 'not_found' } }))
    }
    if (req.readableEnded) return answer()
    req.resume()
    req.on('end', answer)
  }))
  pub.on('upgrade', (req, socket, head) => front.upgrade(req, socket, head, (r, s, h) => {
    own.handleUpgrade(r, s, h, (ws) => { own.emit('connection', ws, r) })
  }))
  pubPort = await listen(pub)
  // The boot: what is told first, at once.
  expect(front.told()).toMatchObject({ answers: true, why: 'answers', route: 'leader', seq: 1 })
  told.length = 0
})

afterEach(async () => {
  vi.useRealTimers()
  for (const c of own.clients) c.terminate()
  await front.stop()
  pub.closeAllConnections?.()
  await new Promise((r) => pub.close(r))
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: string, cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}
/** Moves the (faked) wall clock: suspect marks and the view's age read it. */
function advance(ms: number): void { vi.setSystemTime(Date.now() + ms) }

function call(method: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const body = method === 'GET' ? null : Buffer.from('{"title":"acme"}')
    const req = http.request({
      host: '127.0.0.1', port: pubPort, method, path: p, agent: false,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}) },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => { let json: any = null; try { json = JSON.parse(text) } catch { /* not JSON */ } resolve({ status: res.statusCode!, json, headers: res.headers }) })
    })
    req.on('error', reject)
    req.end(body ?? undefined)
  })
}

/** A browser on the replica's own /ws (the replica answers alone, so the handshake is not spliced to the Mac). */
async function joinOwn(): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
  const before = own.clients.size
  const ws = new WebSocket(`ws://127.0.0.1:${pubPort}/ws`)
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })))
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  await until('the replica to hold the socket', () => own.clients.size === before + 1)
  return { ws, closed }
}

const brief = (t: PresenceEvent) => ({ answers: t.answers, why: t.why, seq: t.seq })

describe('back to the Mac: told only once a stream to it opened', { timeout: 20_000 }, () => {
  it('a Mac whose frames flow while its door refuses is never told back; once the door opens: answers:true, then 4002 leader_back', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    // Away: told at once.
    daemon.heardAgoMs = 31_000
    expect(front.presence()).toMatchObject({ answers: false, why: 'mac-away' })
    expect(told.map(brief)).toEqual([{ answers: false, why: 'mac-away', seq: 2 }])
    const browser = await joinOwn()

    // The Mac's frames are back; its door still refuses the probe.
    door.primary = 'refuse'
    daemon.heardAgoMs = 0
    front.presence()
    await until('the probe to fail', () => told.length === 2)
    expect(told.map(brief)).toEqual([{ answers: false, why: 'mac-away', seq: 2 }, { answers: false, why: 'unreachable', seq: 3 }])
    // The mark ends, the probe is refused again: nothing new is told (no flap through answers:true).
    for (let round = 0; round < 3; round++) {
      advance(31_000)
      const probes = opened.length
      front.presence()
      await until('the next probe', () => opened.length > probes)
      await sleep(30)
    }
    expect(told.map(brief)).toEqual([{ answers: false, why: 'mac-away', seq: 2 }, { answers: false, why: 'unreachable', seq: 3 }])
    expect(told.some((t) => t.answers)).toBe(false)
    expect(ownCloses).toEqual([])
    expect(browser.ws.readyState).toBe(WebSocket.OPEN)

    // The door opens: told back, then the replica's own sockets move.
    door.primary = 'open'
    advance(31_000)
    front.presence()
    await until('answers:true', () => told.some((t) => t.answers))
    expect(told.map(brief).at(-1)).toEqual({ answers: true, why: 'answers', seq: 4 })
    expect(ownCloses).toEqual([{ code: 4002, reason: 'leader_back' }])
    expect(await browser.closed).toEqual({ code: 4002, reason: 'leader_back' })
    // Settled: more looks tell nothing more and close nothing more.
    front.presence(); front.presence()
    await sleep(50)
    expect(told.map((t) => t.seq)).toEqual([2, 3, 4])
    expect(ownCloses).toHaveLength(1)
  })
})

describe('the companion stands in: the replica\'s own sockets move to it', { timeout: 20_000 }, () => {
  it('a socket that joined while alone is closed 4002 companion_stands_in once a probe to the companion opened, not before', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    daemon.heardAgoMs = 31_000
    front.presence()
    const browser = await joinOwn()
    expect(told.map(brief)).toEqual([{ answers: false, why: 'mac-away', seq: 2 }])

    // The bridge comes up, the companion's door refuses: the socket stays.
    door.companion = 'refuse'
    daemon.bridge = true
    front.presence()
    await until('the probe to the companion', () => opened.includes('companion'))
    await sleep(50)
    expect(ownCloses).toEqual([])
    expect(browser.ws.readyState).toBe(WebSocket.OPEN)
    expect(front.told()).toMatchObject({ route: 'alone', seq: 2 })

    // It opens: told (the route moved), then the socket closes so it reconnects there.
    door.companion = 'open'
    advance(6_000)
    front.presence()
    await until('the move to the companion', () => ownCloses.length === 1)
    expect(ownCloses).toEqual([{ code: 4002, reason: 'companion_stands_in' }])
    expect(await browser.closed).toEqual({ code: 4002, reason: 'companion_stands_in' })
    expect(front.told()).toMatchObject({ answers: false, why: 'mac-away', route: 'companion', seq: 3 })
    expect(told.map(brief).at(-1)).toEqual({ answers: false, why: 'mac-away', seq: 3 })
    // New requests are the companion's, under the seq of the move.
    const r = await call('GET', '/api/v1/tasks', AUTH)
    expect(r.json).toEqual({ from: 'companion' })
    expect(r.headers['x-walnut-presence-seq']).toBe('3')
    expect(r.headers['x-walnut-offline']).toBeUndefined()
  })
})

describe('what an answer from the copies says', { timeout: 20_000 }, () => {
  it('suspect while a stream to a live Mac failed, away once the Mac is away; a stranger is told neither', async () => {
    door.primary = 'refuse'
    const r = await call('GET', '/api/v1/tasks', AUTH)
    expect(r.json).toEqual({ from: 'replica' })
    expect(r.headers['x-walnut-offline']).toBe('0')
    expect(r.headers['x-walnut-offline-why']).toBe('suspect')
    expect(r.headers['x-walnut-presence-seq']).toBe('2')
    expect(told.map(brief)).toEqual([{ answers: false, why: 'unreachable', seq: 2 }])
    // A caller with no known token: no copy age, no why; still the seq.
    const stranger = await call('GET', '/api/v1/tasks')
    expect(stranger.headers['x-walnut-offline']).toBeUndefined()
    expect(stranger.headers['x-walnut-offline-why']).toBeUndefined()
    expect(stranger.headers['x-walnut-presence-seq']).toBe('2')

    daemon.heardAgoMs = 31_000
    const away = await call('GET', '/api/v1/tasks', AUTH)
    expect(away.headers['x-walnut-offline-why']).toBe('away')
    expect(away.headers['x-walnut-presence-seq']).toBe('3')
    // A write away is refused with the same marks.
    const write = await call('POST', '/api/v1/tasks', AUTH)
    expect(write.status).toBe(503)
    expect(write.headers['x-walnut-offline-why']).toBe('away')
    expect(write.headers['x-walnut-presence-seq']).toBe('3')
  })

  it('the copies\' age is their last completed round (never the presence time); unknown is 0 on HTTP, null in the event', async () => {
    daemon.heardAgoMs = 31_000
    expect(front.presenceEvent()).toMatchObject({ asOf: null, host: 'marina', hostKey: 'devbox', answers: false, why: 'mac-away' })
    expect((await call('GET', '/api/v1/tasks', AUTH)).headers['x-walnut-offline']).toBe('0')
    const rows = memFollower({ kind: 'acme-presence-rows' })
    // A manifest that still needs a body: not whole yet.
    const row = { id: 'r1', title: 'acme' }
    expect(await rows.handler.sync({ entries: [{ k: 'r1', h: sha12(JSON.stringify(row)) }], asOf: AS_OF })).toMatchObject({ ok: true, need: ['r1'] })
    expect(copiesAsOf()).toBeNull()
    // Its last batch, stored: whole as of the leader's clock of that manifest.
    expect(await rows.handler.put({ rows: [row], last: true })).toMatchObject({ ok: true, stored: 1 })
    expect(copiesAsOf()).toBe(AS_OF)
    const r = await call('GET', '/api/v1/tasks', AUTH)
    expect(r.headers['x-walnut-offline']).toBe(String(AS_OF))
    const ev = front.presenceEvent()
    expect(ev.asOf).toBe(AS_OF)
    expect(ev.boot).toBe(front.boot)
    // A later round that needs nothing moves it on; the oldest kind is the copies' age.
    expect(await rows.handler.sync({ entries: [{ k: 'r1', h: sha12(JSON.stringify(row)) }], asOf: AS_OF + 60_000 })).toMatchObject({ need: [] })
    expect(copiesAsOf()).toBe(AS_OF + 60_000)
    const other = memFollower({ kind: 'acme-presence-other' })
    await other.handler.sync({ entries: [], asOf: AS_OF + 30_000 })
    expect(copiesAsOf()).toBe(AS_OF + 30_000)
  })
})

describe('x-walnut-presence-seq and x-walnut-presence-boot on every answer', { timeout: 20_000 }, () => {
  it('forwarded, refused and the alone state: the seq in force, one boot per process', async () => {
    const fwd = await call('GET', '/api/v1/tasks', AUTH)
    expect(fwd.json).toEqual({ from: 'mac' })
    expect(fwd.headers['x-walnut-presence-seq']).toBe('1')
    expect(fwd.headers['x-walnut-presence-boot']).toMatch(/^[0-9a-f]{16}$/)
    expect(fwd.headers['x-walnut-presence-boot']).toBe(front.boot)
    expect(front.presenceEvent()).toMatchObject({ seq: 1, boot: front.boot, answers: true })

    daemon.heardAgoMs = 31_000
    const refused = await call('POST', '/api/v1/tasks', AUTH)
    expect(refused.status).toBe(503)
    expect(refused.headers['x-walnut-presence-seq']).toBe('2')
    expect(refused.headers['x-walnut-presence-boot']).toBe(front.boot)
    const state = await call('GET', '/_alone/state')
    expect(state.headers['x-walnut-presence-seq']).toBe('2')

    const first = front.boot
    await front.stop()
    front = makeFront()
    expect(front.boot).not.toBe(first)
    expect(front.told().seq).toBe(1)
  })
})

describe('an alone page left open from before the host switched program', { timeout: 20_000 }, () => {
  /** The alone page's own script, run as a browser runs it, against this front. */
  function openAlonePage(): { check: () => Promise<unknown>; reloads: () => number } {
    const html = alonePage('marina', 'mac-away', 'n0nce')
    const script = /<script nonce="n0nce">([\s\S]*?)<\/script>/.exec(html)![1]!
    const els = new Map<string, Record<string, unknown>>()
    const el = (id: string) => {
      if (!els.has(id)) els.set(id, { id, hidden: false, textContent: '', value: '', className: '', appendChild: () => {} })
      return els.get(id)!
    }
    let reloads = 0
    const intervals: Array<() => unknown> = []
    vm.runInNewContext(script, {
      localStorage: { getItem: () => null },
      document: { getElementById: el, createElement: () => el(`n${els.size}`), body: { scrollHeight: 0 } },
      location: { reload: () => { reloads++ }, hash: '' },
      window: { addEventListener: () => {}, innerHeight: 0, scrollY: 0, scrollTo: () => {} },
      // A browser's fetch; the page's `cache: 'no-store'` is a browser hint node's fetch need not take.
      fetch: (p: string, o: RequestInit) => { const { cache: _cache, ...rest } = o; return fetch(`http://127.0.0.1:${pubPort}${p}`, rest) },
      setInterval: (fn: () => unknown) => { intervals.push(fn); return intervals.length },
    })
    expect(intervals.length).toBeGreaterThan(0)
    return { check: () => intervals[0]!() as Promise<unknown>, reloads: () => reloads }
  }

  it('its next check is told the console answers here, and it reloads; the Mac never sees the poll', async () => {
    for (const heard of [31_000, 0]) {
      daemon.heardAgoMs = heard
      const page = openAlonePage()
      await page.check()
      expect(page.reloads(), `heard ${heard} ms ago`).toBe(1)
    }
    const r = await call('GET', '/_alone/state?x=1')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ route: 'console', label: 'marina' })
    expect(r.headers['cache-control']).toBe('no-store')
    expect(mac.seen.filter((s) => s.includes('/_alone/'))).toEqual([])
  })
})
