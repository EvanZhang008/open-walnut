/**
 * Presence of a host replica (docs/plan/walnut-replica-servers-impl.md, section 3,
 * "Presence"; WP2): one rule over the daemon's follower view, its age and the
 * last forward outcome.
 *
 *   leaderAnswers = holder == 'primary' && primaryConnected
 *                   && primaryHeardAgoMs + viewAge < LEADER_QUIET_MS
 *                   && !suspect && drainablePending == 0
 *
 * The view comes through the real daemon link (src/host-server/daemon-link.ts)
 * from a stand-in daemon socket, so the parse of `quietMs`, `drainablePending`
 * and the journal counts is the one the replica runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { createDaemonLink, type DaemonLink, type FollowerView } from '../../src/host-server/daemon-link.js'
import { chooseReplicaRoute, LEADER_QUIET_MS, presenceOf, quietWindow, SUSPECT_MS, VIEW_STALE_MS } from '../../src/replica/presence.js'

const NOW = 1_800_000_000_000

function view(over: Partial<FollowerView> = {}): FollowerView {
  return {
    walnutId: 'wmarina1', home: '/home/marina/.open-walnut', epoch: 1, holder: 'primary', backup: true,
    primaryConnected: true, primaryHeardAgoMs: 1_000, takeoverMs: 60_000,
    bridge: { connected: false, companion: null }, settings: {}, ...over,
  }
}
const at = (v: FollowerView, ageMs = 0) => ({ view: v, at: NOW - ageMs })

describe('presence: the one rule', () => {
  it('uses the window the daemon says (quietMs), counting the age of the view', () => {
    const v = view({ quietMs: 6_000, primaryHeardAgoMs: 4_000 })
    expect(presenceOf({ view: at(v, 1_999), now: NOW, suspect: {} })).toMatchObject({ answers: true, why: 'answers' })
    // heard 4 s before a view that is 2 s old: 6 s, the whole window, is away
    expect(presenceOf({ view: at(v, 2_000), now: NOW, suspect: {} })).toMatchObject({ answers: false, why: 'mac-away' })
    expect(quietWindow({ view: at(v), now: NOW, suspect: {} })).toBe(6_000)
  })

  it('without a window from the daemon, the knob decides (the same default as the twins)', () => {
    const v = view({ primaryHeardAgoMs: LEADER_QUIET_MS - 1 })
    expect(quietWindow({ view: at(v), now: NOW, suspect: {} })).toBe(LEADER_QUIET_MS)
    expect(presenceOf({ view: at(v), now: NOW, suspect: {} }).answers).toBe(true)
    expect(presenceOf({ view: at(view({ primaryHeardAgoMs: LEADER_QUIET_MS })), now: NOW, suspect: {} }).answers).toBe(false)
    expect(presenceOf({ view: at(v), now: NOW, suspect: {}, quietMs: 500 }).why).toBe('mac-away')
  })

  it('a socket the daemon holds open but has not heard on is away', () => {
    expect(presenceOf({ view: at(view({ primaryConnected: false, primaryHeardAgoMs: 0 })), now: NOW, suspect: {} }).why).toBe('mac-away')
  })

  it('a stale view says nothing: no daemon, and the route is this replica', () => {
    const v = view({ primaryHeardAgoMs: 0 })
    expect(presenceOf({ view: at(v, VIEW_STALE_MS + 1), now: NOW, suspect: {} })).toEqual({ answers: false, why: 'no-daemon', asOf: 0 })
    expect(chooseReplicaRoute({ view: at(v, VIEW_STALE_MS + 1), now: NOW, suspect: {} })).toEqual({ kind: 'alone', why: 'no-daemon' })
    expect(presenceOf({ view: null, now: NOW, suspect: {} }).why).toBe('no-daemon')
  })

  it('a leader marked suspect by a failed forward is unreachable until the mark ends; the companion stands in', () => {
    const v = view({ bridge: { connected: true, companion: 'https://companion.example' } })
    const suspect = { leader: NOW + SUSPECT_MS }
    expect(presenceOf({ view: at(v), now: NOW, suspect })).toMatchObject({ answers: false, why: 'unreachable' })
    expect(chooseReplicaRoute({ view: at(v), now: NOW, suspect })).toEqual({ kind: 'companion', origin: 'https://companion.example' })
    expect(presenceOf({ view: at(v), now: NOW + SUSPECT_MS, suspect }).answers).toBe(true)
    // Both suspect: this replica answers.
    expect(chooseReplicaRoute({ view: at(v), now: NOW, suspect: { ...suspect, companion: NOW + 1 } })).toEqual({ kind: 'alone', why: 'nobody-answers' })
  })

  it('drainablePending > 0 stays away even with the Mac heard, and the companion does not take the requests', () => {
    const v = view({ primaryHeardAgoMs: 0, drainablePending: 3, bridge: { connected: true, companion: 'https://companion.example' } })
    expect(presenceOf({ view: at(v), now: NOW, suspect: {} })).toMatchObject({ answers: false, why: 'draining' })
    expect(chooseReplicaRoute({ view: at(v), now: NOW, suspect: {} })).toEqual({ kind: 'alone', why: 'draining' })
    expect(presenceOf({ view: at({ ...v, drainablePending: 0 }), now: NOW, suspect: {} }).answers).toBe(true)
  })

  it('a companion that leads (holder backup) is the route, never the Mac', () => {
    const v = view({ holder: 'backup', bridge: { connected: true, companion: 'https://companion.example' } })
    expect(presenceOf({ view: at(v), now: NOW, suspect: {} }).why).toBe('companion-leads')
    expect(chooseReplicaRoute({ view: at(v), now: NOW, suspect: {} }).kind).toBe('companion')
  })

  it('asOf is when the daemon last heard the Mac', () => {
    const v = view({ quietMs: 6_000, primaryHeardAgoMs: 9_000 })
    expect(presenceOf({ view: at(v, 1_000), now: NOW, suspect: {} }).asOf).toBe(NOW - 1_000 - 9_000)
  })
})

/** A stand-in daemon socket: answers follower.hello and follower.status with `answer()`. */
function fakeDaemon(answer: () => Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-d-'))
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const sockets = new Set<WebSocket>()
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; cmd: string }
      if (m.cmd === 'follower.hello' || m.cmd === 'follower.status') ws.send(JSON.stringify({ id: m.id, ...answer() }))
    })
  })
  const ready = new Promise<void>((r) => wss.on('listening', () => {
    fs.writeFileSync(path.join(dir, 'daemon.port'), String((wss.address() as { port: number }).port))
    r()
  }))
  return {
    dir, ready,
    async close() {
      for (const s of sockets) s.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

let links: DaemonLink[] = []
let daemons: Array<ReturnType<typeof fakeDaemon>> = []
afterEach(async () => {
  for (const l of links) l.stop()
  for (const d of daemons) await d.close()
  links = []; daemons = []
})

async function viewThroughLink(extra: Record<string, unknown>) {
  const d = fakeDaemon(() => ({ ok: true, ...view({ primaryHeardAgoMs: 200 }), ...extra }))
  daemons.push(d)
  await d.ready
  const link = createDaemonLink({ daemonDir: d.dir, walnutId: 'wmarina1', home: '/home/marina/.open-walnut', token: 't', pollMs: 50, log: () => {} })
  links.push(link)
  link.start()
  for (let i = 0; i < 100 && !link.view(); i++) await new Promise((r) => setTimeout(r, 20))
  const v = link.view()
  expect(v).not.toBeNull()
  return v!
}

describe('presence: the view as the daemon link parses it', () => {
  it('parked records never count: a journal of parked records only answers', async () => {
    const v = await viewThroughLink({ journal: { records: 4, parked: 4, drainable: 0 }, quietMs: 6_000 })
    expect(v.view.drainablePending).toBeUndefined()
    expect(v.view.quietMs).toBe(6_000)
    expect(presenceOf({ view: v, now: Date.now(), suspect: {} }).answers).toBe(true)
  })

  it('records the current leader can drain keep it away (the journal count or the top-level field)', async () => {
    const a = await viewThroughLink({ journal: { records: 5, parked: 3, drainable: 2 } })
    expect(a.view.drainablePending).toBe(2)
    expect(presenceOf({ view: a, now: Date.now(), suspect: {} }).why).toBe('draining')
    const b = await viewThroughLink({ drainablePending: 1 })
    expect(presenceOf({ view: b, now: Date.now(), suspect: {} }).why).toBe('draining')
  })

  it('counts frames, not the socket: lastFrameAt moves with every answer', async () => {
    const d = fakeDaemon(() => ({ ok: true, ...view() }))
    daemons.push(d)
    await d.ready
    const link = createDaemonLink({ daemonDir: d.dir, walnutId: 'wmarina1', home: '/h', token: 't', pollMs: 50, log: () => {} })
    links.push(link)
    expect(link.lastFrameAt()).toBeNull()
    link.start()
    for (let i = 0; i < 100 && link.lastFrameAt() === null; i++) await new Promise((r) => setTimeout(r, 20))
    const first = link.lastFrameAt()!
    await new Promise((r) => setTimeout(r, 200))
    expect(link.lastFrameAt()!).toBeGreaterThan(first)
  })
})

describe('presence: the LEADER_QUIET_MS knob', () => {
  afterEach(() => { delete process.env.WALNUT_LEADER_QUIET_MS; vi.resetModules() })
  it.each([['6000', 6_000], ['100', 500], ['nope', 30_000], ['', 30_000], ['-5', 30_000]])('WALNUT_LEADER_QUIET_MS=%s is %d ms', async (raw, want) => {
    process.env.WALNUT_LEADER_QUIET_MS = raw
    vi.resetModules()
    const mod = await import('../../src/replica/presence.js')
    expect(mod.LEADER_QUIET_MS).toBe(want)
  })
})
