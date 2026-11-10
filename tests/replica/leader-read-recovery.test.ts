/**
 * The companion's file-read scenarios, run against a host replica, which is not in cloud mode and
 * has no bridge (2026-11-10, the user: "this is generic walnut replica server thing"). The real
 * dispatcher, the real route table and the real byte forward (host-server/proxy.ts) in front of a
 * door standing in for the Mac; the link to the Mac (the route, its drop) is the test's.
 *
 *   the link drops before the read, back in under a second   the read waits, then the Mac answers it
 *   a stream to the Mac fails mid-read, then it is back       the read goes to it again and is answered
 *   the drop is no longer recent (the Mac really away)        503 needs_leader at once, no wait
 *   the link stays down                                       503 needs_leader at the one deadline
 *   every stream fails                                        at most 3 tries, then 503
 *   every stream loses its link                               a resend counts as a try: 3 in all
 *   two reads pipelined on one connection wait                both answered once the Mac is back
 *   the Mac's door keeps refusing (marks go on)               no recent drop: answered at once
 *   a read that is not a leader read (a poll), a write        answered at once, never held
 *   the client leaves while the read waits                    nothing is sent to the Mac after
 *
 * The companion runs the same scenarios over its bridge (tests/web/routes/api-v1-files-cloud.test.ts,
 * tests/e2e/cloud-file-content-relay-e2e.test.ts); both follow core/leader-read-recovery.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { createDispatcher, type Dispatcher } from '../../src/replica/dispatch.js'
import { leaderDropRecent, SuspectMarks, SUSPECT_MS, type Presence } from '../../src/replica/presence.js'
import { LINK_DROPPED } from '../../src/host-server/proxy.js'
import type { Route } from '../../src/host-server/route.js'

const BYTES = Buffer.from('a file only the Mac has: '.repeat(64))
const DEADLINE_MS = 2_500

const mac = http.createServer((req, res) => {
  seen.push(req.url ?? '')
  res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': BYTES.length })
  res.end(BYTES)
})
let macPort = 0
let pub: http.Server
let pubPort = 0
let dispatcher: Dispatcher
let seen: string[] = []

const state = {
  route: { kind: 'leader' } as Route,
  dropRecent: false,
  /** Streams to the Mac that fail before they open. */
  failConnects: 0,
  failAlways: false,
  /** Every stream loses the link under it (the daemon's link to the Mac dropped). */
  linkDrops: false,
  connects: 0,
  logs: [] as Array<{ msg: string; data?: Record<string, unknown> }>,
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
}

function connectMac(): Promise<Duplex> {
  state.connects++
  if (state.linkDrops) return Promise.reject(new Error(`${LINK_DROPPED} (the test)`))
  if (state.failAlways || state.failConnects > 0) {
    state.failConnects = Math.max(0, state.failConnects - 1)
    return Promise.reject(new Error('the Mac refused the stream (its server is restarting)'))
  }
  return new Promise((resolve, reject) => {
    const s = net.connect(macPort, '127.0.0.1')
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

/** After `ms`, the route and the drop become these (the link back, or gone for good). */
function later(ms: number, next: Partial<typeof state>): void {
  setTimeout(() => Object.assign(state, next), ms).unref()
}

async function get(p: string, init: RequestInit = {}): Promise<{ status: number; body: Buffer; code?: string; ms: number }> {
  const t0 = Date.now()
  const res = await fetch(`http://127.0.0.1:${pubPort}${p}`, init)
  const body = Buffer.from(await res.arrayBuffer())
  let code: string | undefined
  if (res.headers.get('content-type')?.includes('json')) {
    try { code = (JSON.parse(body.toString()) as { error?: { code?: string } }).error?.code } catch { /* not json */ }
  }
  return { status: res.status, body, code, ms: Date.now() - t0 }
}

const FILE = '/api/v1/file-content?path=%2FUsers%2Fme%2Frun.mp4&raw=1'

beforeAll(async () => {
  macPort = await listen(mac)
  dispatcher = createDispatcher({
    route: () => state.route,
    asOf: () => 0,
    offlineWhy: () => (state.dropRecent ? 'suspect' : 'away'),
    leaderDropRecent: () => state.dropRecent,
    leaderReadMs: DEADLINE_MS,
    connect: () => connectMac(),
    suspect: () => {
      // A failed stream marks the Mac suspect: this replica answers alone until the test brings it back.
      state.route = { kind: 'alone', why: 'unreachable' }
    },
    ownUpgrade: (_req, socket) => socket.destroy(),
    log: (_level, msg, data) => { state.logs.push({ msg, data }) },
    // A file of the Mac's: the leader's (as self-host.ts judges a path with no host).
    localHere: async () => false,
  })
  pub = http.createServer((req, res) => {
    dispatcher.middleware(req, res, () => { res.writeHead(500); res.end('the replica\'s own route ran') })
  })
  pubPort = await listen(pub)
})

afterAll(async () => {
  await new Promise<void>((r) => pub.close(() => r()))
  await new Promise<void>((r) => mac.close(() => r()))
})

beforeEach(() => {
  Object.assign(state, { route: { kind: 'leader' }, dropRecent: false, failConnects: 0, failAlways: false, linkDrops: false, connects: 0, logs: [] })
  seen = []
})

describe('a host replica (no cloud mode, no bridge): a file of the Mac\'s survives a short drop of its link', () => {
  it('the link dropped just before the read and is back in under a second: the read waits and the Mac answers it', async () => {
    Object.assign(state, { route: { kind: 'alone', why: 'unreachable' }, dropRecent: true })
    later(700, { route: { kind: 'leader' }, dropRecent: false })
    const r = await get(FILE)
    expect(r.status).toBe(200)
    expect(r.body.equals(BYTES)).toBe(true)
    expect(r.ms).toBeGreaterThanOrEqual(600)
    expect(state.connects).toBe(1)
  })

  it('a stream to the Mac fails mid-read (its server restarts) and it is back: the read goes to it again', async () => {
    state.failConnects = 1
    // The failed stream marks the Mac suspect (deps.suspect above) and the drop is recent.
    state.dropRecent = true
    later(500, { route: { kind: 'leader' }, dropRecent: false })
    const r = await get(FILE)
    expect(r.status).toBe(200)
    expect(r.body.equals(BYTES)).toBe(true)
    expect(state.connects).toBe(2)
  })

  it('every stream to the Mac fails: at most 3 tries, then 503 needs_leader', async () => {
    Object.assign(state, { failAlways: true, dropRecent: true })
    // The suspect mark ends a little later each time, as presence.ts does.
    const reopen = setInterval(() => { if (state.route.kind === 'alone') state.route = { kind: 'leader' } }, 300)
    try {
      const r = await get(FILE)
      expect(r.status).toBe(503)
      expect(r.code).toBe('needs_leader')
      expect(state.connects).toBe(3)
    } finally {
      clearInterval(reopen)
    }
  })

  it('every stream loses its link: the resend counts as a try, so 3 streams in all, and no listener piles up', async () => {
    Object.assign(state, { linkDrops: true, dropRecent: true })
    const reopen = setInterval(() => { if (state.route.kind === 'alone') state.route = { kind: 'leader' } }, 300)
    const warnings: string[] = []
    const onWarning = (w: Error): void => { warnings.push(w.name) }
    process.on('warning', onWarning)
    try {
      const r = await get(FILE)
      expect(r.status).toBe(503)
      expect(r.code).toBe('needs_leader')
      expect(state.connects).toBe(3)
      expect(warnings).not.toContain('MaxListenersExceededWarning')
    } finally {
      clearInterval(reopen)
      process.off('warning', onWarning)
    }
  })

  it('two reads pipelined on one connection both wait and are both answered once the Mac is back', async () => {
    Object.assign(state, { route: { kind: 'alone', why: 'unreachable' }, dropRecent: true })
    later(500, { route: { kind: 'leader' }, dropRecent: false })
    const sock = net.connect(pubPort, '127.0.0.1')
    let got = ''
    sock.on('data', (c) => { got += c.toString('latin1') })
    const line = `GET ${FILE} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`
    sock.write(line + line)
    try {
      // The second has no socket of its own until the first is answered: it is no client that left.
      await vi.waitFor(() => expect(got.match(/HTTP\/1\.1 200/g)?.length ?? 0).toBe(2), { timeout: DEADLINE_MS + 3_000, interval: 50 })
      expect(state.logs.filter((l) => l.msg.includes('stopped waiting')).map((l) => l.data?.end)).toEqual(['back', 'back'])
    } finally {
      sock.destroy()
    }
  })

  it('the link stays down: 503 needs_leader at the one deadline, never a hung read', async () => {
    Object.assign(state, { route: { kind: 'alone', why: 'unreachable' }, dropRecent: true })
    const r = await get(FILE)
    expect(r.status).toBe(503)
    expect(r.code).toBe('needs_leader')
    expect(r.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 300)
    expect(r.ms).toBeLessThan(DEADLINE_MS + 1_500)
    expect(state.connects).toBe(0)
    expect(state.logs.find((l) => l.msg.includes('stopped waiting'))?.data?.end).toBe('deadline')
  })

  it('the Mac is really away (its drop is no longer recent): 503 at once, no wait', async () => {
    Object.assign(state, { route: { kind: 'alone', why: 'mac-away' }, dropRecent: false })
    const r = await get(FILE)
    expect(r.code).toBe('needs_leader')
    expect(r.ms).toBeLessThan(400)
  })

  it('the drop stops being recent while the read waits: answered then, not at the deadline', async () => {
    Object.assign(state, { route: { kind: 'alone', why: 'unreachable' }, dropRecent: true })
    later(400, { route: { kind: 'alone', why: 'mac-away' }, dropRecent: false })
    const r = await get(FILE)
    expect(r.code).toBe('needs_leader')
    expect(r.ms).toBeLessThan(DEADLINE_MS - 1_000)
  })

  it.each([
    ['the raw file route', '/api/v1/file-raw/__local__/Users/me/run.mp4'],
    ['the console\'s file read', '/api/file-content?path=%2FUsers%2Fme%2Fa.txt'],
    ['the console\'s raw file route', '/api/file-raw/__local__/Users/me/a.txt'],
  ])('%s is a leader read too', async (_name, p) => {
    Object.assign(state, { route: { kind: 'alone', why: 'unreachable' }, dropRecent: true })
    later(400, { route: { kind: 'leader' }, dropRecent: false })
    const r = await get(p)
    expect(r.status).toBe(200)
    expect(seen).toHaveLength(1)
  })

  it('a read that is not a leader read (a fleet poll) is answered at once, so a browser\'s connections are never held', async () => {
    Object.assign(state, { route: { kind: 'alone', why: 'unreachable' }, dropRecent: true })
    const r = await get('/api/v1/hosts')
    expect(r.code).toBe('needs_leader')
    expect(r.ms).toBeLessThan(400)
  })

  it('a write never waits nor goes again', async () => {
    Object.assign(state, { route: { kind: 'alone', why: 'unreachable' }, dropRecent: true })
    const r = await get('/api/v1/hosts/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.code).toBe('needs_leader')
    expect(r.ms).toBeLessThan(400)
    expect(state.connects).toBe(0)
  })

  it('the client leaves while the read waits: nothing is sent to the Mac after', async () => {
    Object.assign(state, { route: { kind: 'alone', why: 'unreachable' }, dropRecent: true })
    const ac = new AbortController()
    const pending = fetch(`http://127.0.0.1:${pubPort}${FILE}`, { signal: ac.signal }).catch(() => null)
    await vi.waitFor(() => expect(state.logs.some((l) => l.msg.includes('waits for it'))).toBe(true))
    ac.abort()
    await pending
    const ended = () => state.logs.find((l) => l.msg.includes('stopped waiting'))?.data?.end
    await vi.waitFor(() => expect(ended()).toBe('client-left'))
    expect(state.connects).toBe(0)
    expect(seen).toEqual([])
  })
})

describe('one rule for every replica', () => {
  it('the companion\'s bridge relay and the host replica\'s dispatcher both take it from core/leader-read-recovery.ts', () => {
    const root = path.resolve(__dirname, '../..')
    for (const f of ['src/web/routes/file-content-bridge.ts', 'src/replica/dispatch.ts']) {
      const src = fs.readFileSync(path.join(root, f), 'utf8')
      expect(src, f).toMatch(/from '\.\.\/(\.\.\/)?core\/leader-read-recovery\.js'/)
      expect(src, f).toContain('mayTryLeaderReadAgain(')
    }
  })
})

describe('a host replica\'s drop is recent only while it is young (presence.ts leaderDropRecent)', () => {
  const T = 15_000
  const at = (why: Presence['why'], asOf = 0): Presence => ({ answers: false, why, asOf })
  const now = 1_000_000

  it('a suspect mark counts from the first failed stream in a row, so marks that go on are no recent drop', () => {
    expect(leaderDropRecent(at('unreachable'), { now, failingSince: now - 3_000, drainingSince: null }, T)).toBe(true)
    // The Mac's link is up but its stream door keeps refusing (booting, this host not linked yet): 5, 10, 20, 30 s marks.
    expect(leaderDropRecent(at('unreachable'), { now, failingSince: now - 40_000, drainingSince: null }, T)).toBe(false)
    expect(leaderDropRecent(at('unreachable'), { now, failingSince: null, drainingSince: null }, T)).toBe(false)
  })

  it('an absence counts from when the Mac was last heard', () => {
    expect(leaderDropRecent(at('mac-away', now - 2_000), { now, failingSince: null, drainingSince: null }, T)).toBe(true)
    expect(leaderDropRecent(at('mac-away', now - 60_000), { now, failingSince: null, drainingSince: null }, T)).toBe(false)
    expect(leaderDropRecent(at('mac-away', 0), { now, failingSince: null, drainingSince: null }, T)).toBe(false)
  })

  it('a drain (the Mac back, its journal still draining) counts from when it began', () => {
    expect(leaderDropRecent(at('draining', now), { now, failingSince: null, drainingSince: now - 1_000 }, T)).toBe(true)
    expect(leaderDropRecent(at('draining', now), { now, failingSince: null, drainingSince: now - 20_000 }, T)).toBe(false)
  })

  it('nobody else is a recent drop of the Mac', () => {
    for (const why of ['answers', 'no-daemon', 'companion-leads'] as const) {
      expect(leaderDropRecent(at(why, now), { now, failingSince: now, drainingSince: now }, T), why).toBe(false)
    }
  })

  it('the marks keep when the failures in a row began, and an answer ends them', () => {
    const marks = new SuspectMarks(() => 30_000)
    expect(marks.failingSince('leader')).toBeNull()
    marks.fail('leader', 100)
    marks.fail('leader', 100 + SUSPECT_MS + 1)
    expect(marks.failures('leader')).toBe(2)
    expect(marks.failingSince('leader')).toBe(100)
    marks.answered('leader')
    expect(marks.failingSince('leader')).toBeNull()
    marks.fail('leader', 50_000)
    expect(marks.failingSince('leader')).toBe(50_000)
    expect(marks.failingSince('companion')).toBeNull()
  })

  it('the front reads its drop from the marks and the drain, never from the suspect mark alone', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/replica/front.ts'), 'utf8')
    expect(src).toMatch(/leaderDropRecent: \(\) => leaderDropRecent\(look\(\), \{ now: Date\.now\(\), failingSince: marks\.failingSince\('leader'\), drainingSince \}\)/)
  })
})
