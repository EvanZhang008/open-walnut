/**
 * A misfired stand-down end to end in one process (land 6 review N5, review round 1 S1/S2): the
 * host's real pieces as host-boot.ts wires them (fact log, HostChannel, emitter, the stand-down side
 * of stand-down-held.ts, the old-leader watch) and a real leader side (leader-side.ts) linked to that
 * channel. The host stands down, a turn end of its own session comes, a leader that reads the held
 * mark links, the host stands up, and the leader says the turn end exactly once:
 *
 *   W1  the link comes first, then the stand-up: the stand-up's own say-again carries it
 *   W2  the stand-up comes first (no leader yet): the link's say-again carries it
 *   W3  a retrier that keeps the phase (the endpoint wait) takes the replayed end: said once, as
 *       taken, and it moves no phase (no needs-you)
 *   T1  the host's service restarts after the stand-up, before it said the end again: the leader's
 *       deadline says it, once
 *   T2  the end comes before its session's row (not yet own when it came): written unmarked, so the
 *       leader says it as it comes
 *   T3  a marked end whose session went on is not said at the deadline
 *
 * The leader's deadline is long in W1-W3 and T2, so only the host's own say-again can pass them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The host's store: its own rows are judged here unless it stands down.
vi.mock('../../../src/core/session-db.js', async (orig) => ({
  ...(await orig<object>()),
  sessionJudgeInStore: (sid: string) => (sid.startsWith('own') ? { judgedByHost: true, host: 'devbox' } : null),
}))
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventBus } from '../../../src/core/event-bus.js'
import { FactLog } from '../../../src/core/session-channel/fact-log.js'
import { HostChannel, isChannelFrame, READS_HELD_TURN_ENDS } from '../../../src/core/session-channel/channel.js'
import { createHostEmitter, type HostEmitter } from '../../../src/core/session-channel/host-emitter.js'
import { isStandDownHeldEnd, startStandDownSide, type StandDownSide } from '../../../src/core/session-channel/stand-down-held.js'
import { startOldLeaderWatch, type OldLeaderWatch } from '../../../src/core/session-channel/old-leader-watch.js'
import { createLeaderSide, type ChannelSocket, type LeaderSide } from '../../../src/core/session-channel/leader-side.js'
import { turnEndStamp } from '../../../src/core/session-channel/host-resend.js'
import { _resetJudgeOfForTesting, hostStandsDown, judgedHereOnly, setHostStandsDown } from '../../../src/core/sessions/judge-of.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import { __setTurnRetrierForTesting } from '../../../src/core/sessions/turn-run.js'
import { turnEndEdgeOf } from '../../../src/core/sessions/turn-end-edge.js'
import type { HostChannelBatch } from '../../../src/core/session-tracker.js'
import type { ChannelCursor } from '../../../src/core/session-channel/channel.js'
import type { SessionRecord } from '../../../src/core/types.js'

const HOST = 'devbox'
const FAMILY = 'test-wiring-family-member'
const LONG = 60_000

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  await vi.waitFor(() => { if (!cond()) throw new Error('not yet') }, { timeout: ms, interval: 5 })
}

function row(sid: string): SessionRecord {
  return { claudeSessionId: sid, taskId: `task-${sid}`, project: 'Marina', process_status: 'idle', mode: 'default', host: HOST, judge: 'host', streamEpoch: 'ep1' } as SessionRecord
}

/** A channel link in this process: the leader's socket on one side, the host's attach on the other. */
function linkTo(channel: HostChannel): ChannelSocket {
  let open = true
  let onMsg: ((t: string) => void) | null = null
  let onCl: (() => void) | null = null
  const early: string[] = []
  const toLeader = (t: string): void => { if (onMsg) onMsg(t); else early.push(t) }
  const h = channel.attach({
    send: (f) => { if (open) { const t = JSON.stringify(f); queueMicrotask(() => { if (open) toLeader(t) }) } },
    close: () => { if (open) { open = false; queueMicrotask(() => onCl?.()) } },
  })
  return {
    send: (t) => { if (open) queueMicrotask(() => { const f = JSON.parse(t); if (isChannelFrame(f)) h.onFrame(f) }) },
    close: () => { if (open) { open = false; h.onClose(); onCl?.() } },
    onMessage: (fn) => { onMsg = fn; for (const t of early.splice(0)) fn(t) },
    onClose: (fn) => { onCl = fn },
  }
}

/** The host's service, wired as host-boot.ts wires it. */
async function startHost(dir: string, o: { own: string[]; armed: Set<string> }) {
  const log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
  const bus = new EventBus()
  let rowFn: ((r: SessionRecord) => void) | null = null
  let side: StandDownSide | null = null
  let emitter: HostEmitter | null = null
  let watch: OldLeaderWatch | null = null
  const rows = o.own.map(row)
  const channel = new HostChannel({
    log, walnutId: 'w1', hostId: HOST, ownRows: async () => rows,
    onLeaderLinked: () => { emitter?.relive(); side?.onLeaderLinked(); void watch?.tick() },
  })
  const stamp = await turnEndStamp()
  emitter = createHostEmitter({
    log, channel, hostKey: HOST, ownRows: async () => rows, bus,
    rowListener: (fn) => { rowFn = fn }, liveListener: () => {},
    stamp: (name, data) => (side ? side.stamp(name, data) : stamp(name, data)),
    pendingMs: LONG,
  })
  // The resend family's member: judges only what judgedHere names, and arms its retrier at the end.
  bus.subscribe(FAMILY, judgedHereOnly((e: { data: unknown }) => { const sid = (e.data as { sessionId: string }).sessionId; if (sid.endsWith('-taken')) o.armed.add(sid) }), { global: true, interest: ['session:result', 'session:error'] })
  side = startStandDownSide({
    bus, standingDown: hostStandsDown, setStandsDown: setHostStandsDown, owns: (sid) => emitter!.owns(sid), stamp,
    replay: (ends) => { for (const e of ends) bus.deliverTo([FAMILY], e.name, e.data, { ...(e.source ? { source: e.source } : {}) }) },
    leaderLinked: () => channel.leaderLive(), leaderReadsHeld: () => channel.leaderReads(READS_HELD_TURN_ENDS),
    sayAgain: (name, data, to) => { emitter!.sayAgain(name, data, to) },
    heldOptions: { later: () => {} },
  })
  await emitter.start()
  let t = 1_000_000
  let dialerLinked = false
  watch = startOldLeaderWatch({
    leaderAnswers: () => true, channelLinked: () => channel.leaderLive() || dialerLinked,
    standDown: () => side!.standDown(), standUp: () => side!.standUp(), afterMs: 1000, now: () => t,
  }, { timer: false })
  return {
    log, bus, channel,
    /** The watch stands the host down: the leader answers, no channel, past the bound. */
    async standDown() { await watch!.tick(); t += 1001; await watch!.tick(); expect(hostStandsDown()).toBe(true) },
    /** The host's door dialer links before any leader opens the channel: the watch stands up. */
    async dialerLinks() { dialerLinked = true; await watch!.tick(); expect(hostStandsDown()).toBe(false) },
    rowWritten(sid: string) { const r = row(sid); rows.push(r); rowFn?.(r) },
    turnEnd(sid: string) { bus.emit('session:error', { sessionId: sid, error: 'API Error: overloaded' }, ['main-ai', 'session-runner'], { source: 'session-runner' }) },
    async stop() { watch!.stop(); side!.stop(); emitter!.stop(); await log.close() },
  }
}

function startLeader(host: { channel: HostChannel }, sayAgainMs: number) {
  const store = { cursor: null as ChannelCursor | null, ends: [] as Array<{ name: string; data: Record<string, unknown>; late: boolean; to?: string[] }>, logs: [] as string[] }
  const side = createLeaderSide({
    walnutId: async () => 'w1',
    permit: () => ({ permitNumber: 0, epoch: 1 }),
    switchNow: async () => () => true,
    openStream: async () => { throw new Error('not used') },
    dial: async () => linkTo(host.channel),
    applyBatch: async (b: HostChannelBatch) => { store.cursor = b.cursor; return { written: b.rows.map((r) => r.sid), skipped: [] } },
    loadCursor: async () => store.cursor,
    emit: (name, data, o) => { if (name === 'session:result' || name === 'session:error') store.ends.push({ name, data: data as Record<string, unknown>, late: o.late, ...(o.to ? { to: o.to } : {}) }) },
    noteLive: () => {}, noteRename: () => {}, noteHostJudged: () => {},
    ownerOf: (sid) => (sid.startsWith('own') ? HOST : null),
    backoffMs: () => 20,
    heldSayAgainMs: sayAgainMs,
    log: (_l, msg) => { store.logs.push(msg) },
  })
  return { side, store, link: () => side.noteHost(HOST, { connected: true, judges: true }) }
}

/** The needs-you the leader would raise: turn ends it said that move the task's phase. */
const needsYou = (store: { ends: Array<{ name: string; data: unknown }> }) => store.ends.filter((e) => turnEndEdgeOf(e.name, e.data) !== null)

let dir = ''
const cleanups: Array<() => Promise<void> | void> = []
const env = { ...process.env }
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stand-down-wiring-'))
  process.env.WALNUT_ROLE = 'replica'
  process.env.WALNUT_HOST_KEY = HOST
  _resetServerRoleForTesting()
  _resetJudgeOfForTesting()
})
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  setHostStandsDown(false)
  await __setTurnRetrierForTesting('endpoint_wait', null)
  for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  _resetServerRoleForTesting()
  _resetJudgeOfForTesting()
  await fsp.rm(dir, { recursive: true, force: true })
})

async function withRetrier(armed: Set<string>): Promise<void> {
  await __setTurnRetrierForTesting('endpoint_wait', { reason: 'endpoint_wait', sources: [], takes: (end: { sessionId: string }) => armed.has(end.sessionId), wait: () => null } as never)
}

async function hostAndLeader(o: { own: string[]; sayAgainMs?: number }) {
  const armed = new Set<string>()
  await withRetrier(armed)
  const host = await startHost(dir, { own: o.own, armed })
  cleanups.push(() => host.stop())
  const leader = startLeader(host, o.sayAgainMs ?? LONG)
  cleanups.push(() => leader.side.stop())
  return { host, leader, armed }
}

async function heldRecords(log: FactLog, sid: string) {
  await log.flush()
  return (await log.read(0)).filter((r) => r.sid === sid && (r.name === 'session:result' || r.name === 'session:error'))
}

describe('a misfired stand-down, host and leader wired as host-boot.ts and leader-boot.ts wire them', () => {
  it('W1: the leader links first, then the host stands up: one needs-you, said by the host once judged', async () => {
    const { host, leader } = await hostAndLeader({ own: ['own-1'] })
    await host.standDown()
    host.turnEnd('own-1')
    const written = await heldRecords(host.log, 'own-1')
    expect(written).toHaveLength(1)
    expect(isStandDownHeldEnd(written[0].name, written[0].data)).toBe(true)
    await leader.link()
    // The link catches up, the watch looks at once and stands up, the end is said again.
    await until(() => leader.store.ends.length > 0)
    expect(hostStandsDown()).toBe(false)
    await until(() => leader.store.cursor?.seq === host.log.head)
    expect(needsYou(leader.store)).toHaveLength(1)
    expect(leader.store.ends).toHaveLength(1)
    expect(leader.store.ends[0]).toMatchObject({ name: 'session:error', data: { sessionId: 'own-1', hostTakenBy: null } })
    expect(isStandDownHeldEnd(leader.store.ends[0].name, leader.store.ends[0].data)).toBe(false)
    // Said again to the destinations its event named.
    const again = (await heldRecords(host.log, 'own-1')).at(-1)!
    expect(again.to).toEqual(['main-ai', 'session-runner'])
  })

  it('W2: the host stands up before any leader links: the link says the owed end, once', async () => {
    const { host, leader } = await hostAndLeader({ own: ['own-2'] })
    await host.standDown()
    host.turnEnd('own-2')
    await host.dialerLinks()
    await leader.link()
    await until(() => leader.store.ends.length > 0)
    await until(() => leader.store.cursor?.seq === host.log.head)
    expect(needsYou(leader.store)).toHaveLength(1)
    expect(leader.store.ends).toHaveLength(1)
  })

  it('W3: a retrier takes the replayed end: said once, as taken, and no needs-you', async () => {
    const { host, leader, armed } = await hostAndLeader({ own: ['own-3-taken'] })
    await host.standDown()
    host.turnEnd('own-3-taken')
    expect(armed.size).toBe(0)
    await leader.link()
    await until(() => leader.store.ends.length > 0)
    await until(() => leader.store.cursor?.seq === host.log.head)
    expect([...armed]).toEqual(['own-3-taken'])
    expect(leader.store.ends).toEqual([expect.objectContaining({ data: expect.objectContaining({ hostTakenBy: 'endpoint_wait' }) })])
    expect(needsYou(leader.store)).toHaveLength(0)
  })

  it('T1: the host service restarts after the stand-up and before it said the end again: the leader says it at its deadline, once', async () => {
    const armed = new Set<string>()
    await withRetrier(armed)
    const first = await startHost(dir, { own: ['own-4'], armed })
    await first.standDown()
    first.turnEnd('own-4')
    await first.dialerLinks()
    // Owed, never said: the restart takes the host's memory of it.
    await first.stop()
    const host = await startHost(dir, { own: ['own-4'], armed })
    cleanups.push(() => host.stop())
    const leader = startLeader(host, 300)
    cleanups.push(() => leader.side.stop())
    await leader.link()
    await until(() => leader.store.ends.length > 0)
    expect(needsYou(leader.store)).toHaveLength(1)
    expect(leader.store.ends[0]).toMatchObject({ name: 'session:error', late: true, data: { sessionId: 'own-4' } })
    expect(isStandDownHeldEnd(leader.store.ends[0].name, leader.store.ends[0].data)).toBe(false)
    expect(leader.store.logs.some((m) => m.includes('not said again in time'))).toBe(true)
  })

  it('T2: a turn end that comes before its session\'s row is kept by no one, so it is written unmarked and said as it comes', async () => {
    const { host, leader } = await hostAndLeader({ own: [] })
    await host.standDown()
    host.turnEnd('own-5')
    host.rowWritten('own-5')
    const written = await heldRecords(host.log, 'own-5')
    expect(written).toHaveLength(1)
    expect(isStandDownHeldEnd(written[0].name, written[0].data)).toBe(false)
    await leader.link()
    await until(() => needsYou(leader.store).length > 0)
    expect(leader.store.ends).toHaveLength(1)
  })

  it('T3: at the deadline a marked end whose session went on meanwhile is not said; one still waiting is', async () => {
    const { host, leader } = await hostAndLeader({ own: ['own-6', 'own-7'], sayAgainMs: 200 })
    // As a host that never stands up again would leave them: marked, never said again.
    host.log.append('own-6', 'session:error', { sessionId: 'own-6', error: 'API Error: overloaded', hostTakenBy: null, standDownHeld: true })
    host.log.append('own-7', 'session:error', { sessionId: 'own-7', error: 'API Error: overloaded', hostTakenBy: null, standDownHeld: true })
    host.log.append('own-6', 'session:messages-delivered', { sessionId: 'own-6', ids: [] })
    await host.log.flush()
    await leader.link()
    // own-6's wait began first: by the time own-7's deadline said it, own-6's had passed too.
    await until(() => leader.store.ends.length > 0)
    expect(leader.store.ends.map((e) => e.data.sessionId)).toEqual(['own-7'])
  })

  it('host-boot.ts wires the stand-down side as this test does', async () => {
    const src = await fsp.readFile(new URL('../../../src/core/session-channel/host-boot.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/onLeaderLinked: \(\) => \{[^}]*standDownRef\?\.onLeaderLinked\(\)[^}]*watchRef\?\.tick\(\)/)
    expect(src).toMatch(/standUp: \(\) => standDown\.standUp\(\)/)
    expect(src).toMatch(/standDown: \(\) => standDown\.standDown\(\)/)
    expect(src).toMatch(/stamp: \(name, data\) => \(standDownRef \? standDownRef\.stamp\(name, data\) : stamp\(name, data\)\)/)
    // The held list subscribes before the emitter starts, so the stamp sees what it kept.
    expect(src.indexOf('startStandDownSide({')).toBeGreaterThan(0)
    expect(src.indexOf('startStandDownSide({')).toBeLessThan(src.indexOf('await emitter.start()'))
  })
})
