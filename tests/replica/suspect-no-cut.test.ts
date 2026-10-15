/**
 * A suspect mark steers new requests only (docs/plan/walnut-replica-servers-impl.md,
 * section 3, "Presence"; WP2). One failed stream to a live Mac (an open that
 * timed out, one stream the Mac dropped) must not answer the writes the Mac is
 * still working on 504, nor close the browsers' sockets spliced to it: only a
 * real absence does (presence.ts macAway: the quiet window, no daemon, the
 * companion leads).
 *
 * The real front (src/replica/front.ts startReplicaFront): its presence
 * wiring, its dispatcher deps, the real byte forward, SuspectMarks and
 * chooseReplicaRoute. Only the follower link is the test's (the daemon's view
 * and the streams to the Mac), so a front.ts edit that cuts on a mark fails here.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { startReplicaFront, type ReplicaFront } from '../../src/replica/front.js'
import { macAway, presenceWatch, type Presence, type PresenceWhy } from '../../src/replica/presence.js'
import type { FollowerView } from '../../src/host-server/daemon-link.js'
import type { DeviceCopy } from '../../src/host-server/device-copy.js'
import { createLinkEvents } from '../../src/core/link/link.js'
import type { FollowerLink } from '../../src/core/link/follower-link.js'

/** The Mac: `/drop` closes the socket, `/slow/<ms>` answers after that long; /ws echoes. */
const sockets = new Set<net.Socket>()
const applied: string[] = []
const mac = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.url?.includes('/drop')) { req.socket.destroy(); return }
    if (req.method !== 'GET') applied.push(`${req.method} ${req.url}`)
    const slow = /\/slow\/(\d+)/.exec(req.url ?? '')
    const answer = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"from":"mac"}') }
    if (slow) setTimeout(answer, Number(slow[1])); else answer()
  })
})
mac.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
const wss = new WebSocketServer({ noServer: true })
mac.on('upgrade', (req, socket, head) => { wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`mac:${String(m)}`))) })

/** What the daemon's view says. */
const daemon = { heardAgoMs: 0, holder: 'primary' as 'primary' | 'companion' }
function view(): FollowerView {
  return {
    walnutId: 'w-acme', home: '/acme', epoch: 1, holder: daemon.holder, backup: false,
    primaryConnected: true, primaryHeardAgoMs: daemon.heardAgoMs, takeoverMs: 30_000, quietMs: 30_000, drainablePending: 0,
    bridge: { connected: false, companion: null }, settings: {},
  } as unknown as FollowerView
}

/** The follower link the front would make to its daemon: this test's view, streams to the test's Mac. */
function fakeLink(): FollowerLink {
  const events = createLinkEvents()
  return {
    peer: { host: 'marina', walnutId: 'w-acme' },
    state: () => 'up',
    heard: () => daemon.heardAgoMs,
    request: async () => ({ ok: false, error: 'not in this test' }),
    on: (event, cb) => events.on(event, cb),
    openStream: (to) => (to === 'primary' ? connectMac() : Promise.reject(new Error('no companion here'))),
    start: () => {},
    stop: () => {},
    view: () => ({ view: view(), at: Date.now() }),
    linkState: () => 'following',
    lastError: () => null,
    report: () => {},
    capabilities: () => ['replica-ops-v1'],
  }
}

let macPort = 0
let pub: http.Server
let pubPort = 0
let front: ReplicaFront
let scratch = ''
const told: Array<{ answers: boolean; why: PresenceWhy }> = []
const ownCloses: Array<{ code: number; reason: string }> = []
let aways = 0
let backs = 0
const ownSockets: Duplex[] = []

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
}

const look = (): Presence => front.presence()

beforeAll(async () => {
  macPort = await listen(mac)
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'suspect-no-cut-'))
})

afterAll(async () => {
  for (const s of sockets) s.destroy()
  wss.close()
  await new Promise((r) => mac.close(r))
  fs.rmSync(scratch, { recursive: true, force: true })
})
// Each test: a fresh front (no marks yet) over a live Mac; one presence look sets the baseline.
beforeEach(async () => {
  daemon.heardAgoMs = 0
  daemon.holder = 'primary'
  told.length = 0; applied.length = 0; ownCloses.length = 0
  aways = 0; backs = 0
  front = startReplicaFront({
    env: { publicPort: 0, daemonDir: scratch, leaderHome: '/acme', walnutId: 'w-acme', followerToken: 'tok-acme', label: 'marina' },
    devices: { hash: () => '' } as unknown as DeviceCopy,
    acceptFromLeader: (stream) => { stream.destroy() },
    broadcast: (name, data) => {
      if (name === 'replica:presence') told.push({ answers: (data as Presence).answers, why: (data as Presence).why })
    },
    closeOwnSockets: (code, reason) => { ownCloses.push({ code, reason }) },
    link: fakeLink(),
  })
  // Counts every cut and every return the front asks of its dispatcher, from wherever in front.ts.
  const presenceChanged = front.dispatcher.presenceChanged.bind(front.dispatcher)
  front.dispatcher.presenceChanged = (answers: boolean) => {
    if (answers) backs++; else aways++
    presenceChanged(answers)
  }
  pub = http.createServer((req, res) => front.middleware(req, res, () => {
    const answer = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"from":"replica"}') }
    // A read the Mac took first was already read to its end (piped into that forward).
    if (req.readableEnded) return answer()
    req.resume()
    req.on('end', answer)
  }))
  pub.on('upgrade', (req, socket, head) => front.upgrade(req, socket, head, (_req, own) => {
    ownSockets.push(own)
    own.end('HTTP/1.1 418 I am the replica\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  }))
  pubPort = await listen(pub)
  look()
  told.length = 0
})

afterEach(async () => {
  for (const s of ownSockets) s.destroy()
  ownSockets.length = 0
  await front.stop()
  pub.closeAllConnections?.()
  await new Promise((r) => pub.close(r))
})

function connectMac(): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const s = net.connect(macPort, '127.0.0.1')
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

function call(method: string, p: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const body = method === 'GET' ? null : Buffer.from('{}')
    const req = http.request({
      host: '127.0.0.1', port: pubPort, method, path: p, agent: false,
      headers: body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {},
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => { let json: any = null; try { json = JSON.parse(text) } catch { /* not JSON */ } resolve({ status: res.statusCode!, json }) })
    })
    req.on('error', reject)
    req.end(body ?? undefined)
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('a suspect mark steers new requests only', { timeout: 20_000 }, () => {
  it('a write a live Mac answers survives one dropped read beside it, and the read is answered here', async () => {
    const write = call('PATCH', '/api/acme/t1/slow/1500')
    await sleep(200)
    const read = await call('GET', '/api/acme/drop')
    expect(read.json).toEqual({ from: 'replica' })
    // The mark steers: presence says unreachable, new requests stay here.
    expect(look()).toMatchObject({ answers: false, why: 'unreachable' })
    expect(told.map((t) => t.why)).toEqual(['unreachable'])
    expect(aways).toBe(0)
    const answered = await write
    expect(answered).toEqual({ status: 200, json: { from: 'mac' } })
    expect(applied).toEqual(['PATCH /api/acme/t1/slow/1500'])
  })

  it('a socket spliced to the Mac stays open through a mark, and still talks to the Mac', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${pubPort}/ws`)
    const closes: number[] = []
    ws.on('close', (code) => closes.push(code))
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    expect(front.dispatcher.counts().spliced).toBe(1)
    await call('GET', '/api/acme/drop')
    expect(look().why).toBe('unreachable')
    await sleep(300)
    expect(closes).toEqual([])
    expect(front.dispatcher.counts().spliced).toBe(1)
    const echo = new Promise<string>((resolve) => ws.once('message', (m) => resolve(String(m))))
    ws.send('hello')
    expect(await echo).toBe('mac:hello')
    // A new handshake during the mark is steered to the replica's own socket.
    const steered = await new Promise<number>((resolve) => {
      const other = new WebSocket(`ws://127.0.0.1:${pubPort}/ws`)
      other.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); other.terminate() })
      other.on('error', () => {})
    })
    expect(steered).toBe(418)
    ws.terminate()
  })

  it('the Mac really away after a mark cuts once: the in-flight write 504 sent:true, the spliced socket 4001', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${pubPort}/ws`)
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    const write = call('POST', '/api/acme/t2/slow/5000')
    await sleep(200)
    await call('GET', '/api/acme/drop')
    expect(look().why).toBe('unreachable')
    expect(aways).toBe(0)
    // The quiet window passes: the daemon has not heard the Mac for 31 s.
    daemon.heardAgoMs = 31_000
    expect(look()).toMatchObject({ answers: false, why: 'mac-away' })
    expect(aways).toBe(1)
    const cut = await write
    expect(cut.status).toBe(504)
    expect(cut.json.error).toMatchObject({ code: 'primary_timeout', sent: true })
    expect(await closed).toBe(4001)
    look(); look()
    expect(aways).toBe(1)
  })
})

describe('presenceWatch: which absence cuts', () => {
  function watch(): { step(why: PresenceWhy): void; aways: number; backs: number; changes: PresenceWhy[] } {
    let now: Presence = { answers: true, why: 'answers', asOf: 0 }
    const out = { aways: 0, backs: 0, changes: [] as PresenceWhy[], step: (_why: PresenceWhy) => {} }
    const w = presenceWatch({
      presence: () => now,
      changed: (p) => { out.changes.push(p.why) },
      away: () => { out.aways++ },
      back: () => { out.backs++ },
    })
    out.step = (why) => { now = { answers: why === 'answers', why, asOf: 0 }; w() }
    w()
    return out
  }

  it('macAway names the real absences only', () => {
    expect((['mac-away', 'no-daemon', 'companion-leads'] as PresenceWhy[]).every(macAway)).toBe(true)
    expect((['answers', 'unreachable', 'draining'] as PresenceWhy[]).some(macAway)).toBe(false)
  })

  it('each real absence cuts once; a mark or a drain cuts nothing; a return calls back', () => {
    for (const why of ['mac-away', 'no-daemon', 'companion-leads'] as PresenceWhy[]) {
      const w = watch()
      w.step(why); w.step(why)
      expect(w.aways).toBe(1)
      w.step('answers')
      expect(w.backs).toBe(1)
    }
    for (const why of ['unreachable', 'draining'] as PresenceWhy[]) {
      const w = watch()
      w.step(why)
      expect(w.aways).toBe(0)
      w.step('answers')
      expect(w.backs).toBe(1)
    }
  })

  it('a mark then the quiet window cuts once; two absences in a row cut once; a return arms the next cut', () => {
    const w = watch()
    w.step('unreachable'); w.step('mac-away'); w.step('companion-leads'); w.step('draining')
    expect(w.aways).toBe(1)
    expect(w.changes).toEqual(['answers', 'unreachable', 'mac-away', 'companion-leads', 'draining'])
    w.step('answers'); w.step('mac-away')
    expect(w.aways).toBe(2)
    expect(w.backs).toBe(1)
  })

  it('a first look that is already away cuts nothing (nothing is in flight yet)', () => {
    let calls = 0
    const w = presenceWatch({ presence: () => ({ answers: false, why: 'mac-away', asOf: 0 }), changed: () => {}, away: () => { calls++ }, back: () => {} })
    w(); w()
    expect(calls).toBe(0)
  })
})
