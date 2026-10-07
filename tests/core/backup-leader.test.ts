/**
 * The cloud companion's decision loop (src/core/leader/backup-leader.ts) against
 * hosts that hold the truth. Each fake host is the REAL leader book
 * (src/providers/leader-core.ts) behind the two bridge commands the companion
 * sends, `leader.witness` and `leader.claim`, answered in the daemon's shape.
 * One clock drives the companion and every host; "the primary is heard" is a
 * call the test makes on the host, the way a frame on its socket does.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createLeaderBook } from '../../src/providers/leader-core.js'
import { createBackupLeader } from '../../src/core/leader/backup-leader.js'

const HOME = '/fixture/walnut-home'
const WALNUT = 'wprimary0001'
const T = 60_000

let dirs: string[] = []
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs = [] })
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-leader-')); dirs.push(d); return d }

function cluster(hostNames: string[], opts: { backup?: boolean; stateFile?: string | null } = {}) {
  const clock = { now: 5_000_000 }
  const hosts = new Map<string, { book: ReturnType<typeof createLeaderBook>; primaryOpen: boolean; reachable: boolean }>()
  const sent: Array<{ host: string; cmd: string; params: Record<string, unknown> }> = []
  function addHost(name: string) {
    const book = createLeaderBook({
      fs, path, dir: tmp(), now: () => clock.now,
      keyOf: (h) => createHash('sha1').update(h).digest('hex').slice(0, 12),
      log: () => {}, takeoverMs: T, bootAt: clock.now,
    })
    book.configure({ home: HOME, walnutId: WALNUT, backup: opts.backup ?? true })
    hosts.set(name, { book, primaryOpen: true, reachable: true })
  }
  for (const h of hostNames) addHost(h)
  const leader = createBackupLeader({
    now: () => clock.now,
    takeoverMs: T,
    hosts: () => ['__local__', ...[...hosts].filter(([, h]) => h.reachable).map(([n]) => n)],
    stateFile: opts.stateFile === undefined ? null : opts.stateFile,
    request: async (host, cmd, params) => {
      sent.push({ host, cmd, params })
      const h = hosts.get(host)
      if (!h || !h.reachable) throw new Error(`bridge to ${host} is down`)
      if (cmd === 'leader.witness') return { ok: true, walnuts: h.book.witness(() => h.primaryOpen), takeoverMs: T }
      if (cmd === 'leader.claim') {
        const r = h.book.backupClaim(params.walnutId, params.epoch)
        return r.ok ? { ok: true, epoch: r.record.epoch, holder: r.record.holder } : { ok: false, error: r.message, errorKind: r.code, epoch: r.epoch }
      }
      return { ok: false, error: `unknown command ${cmd}` }
    },
  })
  /** The primary is alive: its heartbeat reaches the companion and its frames reach every host. */
  function primaryAlive() {
    leader.noteHeartbeat({ walnutId: WALNUT })
    for (const h of hosts.values()) h.book.noteHeard(HOME)
  }
  /** Time passes with the primary asleep: it says nothing to anyone, its sockets stay open. */
  async function sleepFor(ms: number, step = 5_000) {
    for (let t = 0; t < ms; t += step) { clock.now += step; await leader.tick() }
  }
  return { clock, hosts, leader, sent, primaryAlive, sleepFor, addHost }
}

describe('backup leader: the Mac goes away', () => {
  it('while the primary is heard it asks the hosts nothing', async () => {
    const c = cluster(['devbox', 'oldbox'])
    for (let i = 0; i < 30; i++) { c.clock.now += 5_000; c.primaryAlive(); await c.leader.tick() }
    expect(c.sent).toHaveLength(0)
    expect(c.leader.isLeading()).toBe(false)
  })

  it('takes the lead of every host once the primary has been silent for the window everywhere', async () => {
    const c = cluster(['devbox', 'oldbox'])
    c.primaryAlive()
    await c.sleepFor(T - 5_000)
    expect(c.leader.isLeading()).toBe(false)
    await c.sleepFor(10_000)
    expect(c.leader.status().leading.map((l) => [l.host, l.epoch]).sort()).toEqual([['devbox', 2], ['oldbox', 2]])
    expect(c.leader.leadFor('devbox')).toEqual({ walnutId: WALNUT, epoch: 2 })
    // The hosts agree: each holds the companion as the leader at that epoch.
    for (const h of c.hosts.values()) expect(h.book.backupLead(HOME)).toEqual({ walnutId: WALNUT, epoch: 2 })
    // Its own daemon is never a host it leads.
    expect(c.sent.some((s) => s.host === '__local__')).toBe(false)
  })

  it('does not take the lead when only its link to the primary is down (a host still hears it)', async () => {
    const c = cluster(['devbox', 'oldbox'])
    c.primaryAlive()
    for (let i = 0; i < 40; i++) {
      c.clock.now += 5_000
      c.hosts.get('oldbox')!.book.noteHeard(HOME) // the primary still talks to oldbox
      c.hosts.get('devbox')!.book.noteHeard(HOME)
      await c.leader.tick()
    }
    expect(c.leader.isLeading()).toBe(false)
    expect(c.leader.status().lastDecision).toMatch(/still hears the primary/)
  })

  it('one host that still hears the primary is enough to wait, even if the others do not', async () => {
    const c = cluster(['devbox', 'oldbox'])
    c.primaryAlive()
    for (let i = 0; i < 40; i++) { c.clock.now += 5_000; c.hosts.get('oldbox')!.book.noteHeard(HOME); await c.leader.tick() }
    expect(c.leader.isLeading()).toBe(false)
    expect(c.hosts.get('devbox')!.book.backupLead(HOME)).toBeNull()
  })

  it('a host the user did not let the companion lead is never claimed', async () => {
    const c = cluster(['devbox'], { backup: false })
    c.primaryAlive()
    await c.sleepFor(5 * T)
    expect(c.leader.isLeading()).toBe(false)
    expect(c.sent.filter((s) => s.cmd === 'leader.claim')).toHaveLength(0)
  })

  it('a restart notice holds the takeover off for the announced window, then it goes ahead', async () => {
    const c = cluster(['devbox'])
    c.leader.noteHeartbeat({ walnutId: WALNUT, restartingMs: 5 * 60_000 })
    for (const h of c.hosts.values()) h.book.noteHeard(HOME)
    await c.sleepFor(4 * 60_000)
    expect(c.leader.isLeading()).toBe(false)
    await c.sleepFor(90_000)
    expect(c.leader.isLeading()).toBe(true)
  })

  it('a host that cannot be reached is no witness; the others are led, and it is claimed once it comes back', async () => {
    const c = cluster(['devbox', 'oldbox'])
    c.primaryAlive()
    c.hosts.get('oldbox')!.reachable = false
    await c.sleepFor(T + 10_000)
    expect(c.leader.status().leading.map((l) => l.host)).toEqual(['devbox'])
    c.hosts.get('oldbox')!.reachable = true
    await c.sleepFor(5_000)
    expect(c.leader.status().leading.map((l) => l.host).sort()).toEqual(['devbox', 'oldbox'])
  })

  it('a host whose daemon heard the primary after the decision refuses the claim, and is not led', async () => {
    const c = cluster(['devbox'])
    c.primaryAlive()
    c.clock.now += T + 5_000
    // The host hears the primary in the gap between witness and claim.
    const book = c.hosts.get('devbox')!.book
    const orig = book.backupClaim
    book.backupClaim = (w, e) => { book.noteHeard(HOME); return orig(w, e) }
    await c.leader.tick()
    expect(c.leader.isLeading()).toBe(false)
    expect(book.backupLead(HOME)).toBeNull()
  })
})

describe('backup leader: the Mac comes back', () => {
  async function led() {
    const c = cluster(['devbox', 'oldbox'])
    c.primaryAlive()
    await c.sleepFor(T + 10_000)
    expect(c.leader.isLeading()).toBe(true)
    return c
  }

  it('its heartbeat alone gives nothing back: the hosts stay led until the primary takes each one', async () => {
    const c = await led()
    c.leader.noteHeartbeat({ walnutId: WALNUT })
    await c.sleepFor(5_000)
    expect(c.leader.status().leading).toHaveLength(2)
    expect(c.leader.status().lastDecision).toMatch(/has not taken the lead yet/)
  })

  it('a host the primary took back (a higher epoch) is given up, the others stay led', async () => {
    const c = await led()
    c.leader.noteHeartbeat({ walnutId: WALNUT })
    expect(c.hosts.get('devbox')!.book.primaryClaim(HOME)).toMatchObject({ holder: 'primary', epoch: 3 })
    await c.sleepFor(5_000)
    expect(c.leader.status().leading.map((l) => l.host)).toEqual(['oldbox'])
    expect(c.leader.leadFor('devbox')).toBeNull()
    // And the host fences the old lead off.
    expect(c.hosts.get('devbox')!.book.fence(WALNUT, 2)).toMatchObject({ ok: false, code: 'not_leader' })
    c.hosts.get('oldbox')!.book.primaryClaim(HOME)
    await c.sleepFor(5_000)
    expect(c.leader.isLeading()).toBe(false)
  })

  it('after the handback it does not grab the lead straight back while the primary is heard', async () => {
    const c = await led()
    for (const h of c.hosts.values()) h.book.primaryClaim(HOME)
    for (let i = 0; i < 20; i++) { c.clock.now += 5_000; c.primaryAlive(); await c.leader.tick() }
    expect(c.leader.isLeading()).toBe(false)
  })

  it('it goes away again later: the next takeover takes the next epoch', async () => {
    const c = await led()
    for (const h of c.hosts.values()) h.book.primaryClaim(HOME) // epoch 3
    c.primaryAlive()
    await c.sleepFor(T + 10_000)
    expect(c.leader.status().leading.map((l) => l.epoch)).toEqual([4, 4])
  })

  it('lostHost drops a host a command found stale', async () => {
    const c = await led()
    c.leader.lostHost('devbox', 'stale_epoch')
    expect(c.leader.leadFor('devbox')).toBeNull()
    expect(c.leader.leadFor('oldbox')).not.toBeNull()
  })
})

describe('backup leader: a companion restart', () => {
  it('keeps the Walnut id on disk and, with no heartbeat since it started, counts the window from its start', async () => {
    const stateFile = path.join(tmp(), 'leader', 'companion.json')
    const first = cluster(['devbox'], { stateFile })
    first.primaryAlive()
    // The id is written without blocking the heartbeat.
    for (let i = 0; i < 100 && !fs.existsSync(stateFile); i++) await new Promise((r) => setTimeout(r, 20))
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ walnutId: WALNUT })

    // A new companion process: no heartbeat yet. It must not lead before T from its own start.
    const again = cluster(['devbox'], { stateFile })
    await again.sleepFor(T - 5_000)
    expect(again.leader.isLeading()).toBe(false)
    await again.sleepFor(10_000)
    expect(again.leader.status()).toMatchObject({ walnutId: WALNUT, primaryHeard: false })
    expect(again.leader.isLeading()).toBe(true)
  })
})
