/**
 * The session channel (src/core/session-channel/channel.ts) over an in-memory link that can be
 * cut after any record: every record reaches the leader exactly once and in order, across cuts,
 * a leader that was away, a move to another leader, and a leader below what the log still keeps.
 * A stale leader is refused; a listener never confirms; deltas go only to a caught-up reader.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FACT_FLUSH_MS, FactLog, type FactRecord } from '../../../src/core/session-channel/fact-log.js'
import { HostChannel, attachLeaderChannel, comparePermit, permitOfResume, type AppliedFact, type ChannelCursor, type ChannelFrame, type ChannelLink } from '../../../src/core/session-channel/channel.js'
import type { SessionRecord } from '../../../src/core/types.js'

let dir = ''
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sess-channel-')) })
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }) })

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await tick(2) }
}

/** A leader's data: what it applied, the rows a snapshot gave it, and its position. */
class Leader {
  applied: AppliedFact[] = []
  rows = new Map<string, SessionRecord>()
  snapshots = 0
  flows: string[] = []
  cursor: ChannelCursor | null = null
  constructor(public permit = 1) {}
  copy(): Leader {
    const b = new Leader(this.permit + 1)
    b.applied = [...this.applied]
    b.rows = new Map(this.rows)
    b.cursor = this.cursor ? { ...this.cursor } : null
    return b
  }
}

/** One link: frames delivered asynchronously in order; cut() drops everything after. */
/** The leader's clock: a test moves it on to say the leader was away. */
let clockOffset = 0
beforeEach(() => { clockOffset = 0 })

function connect(host: HostChannel, leader: Leader, opts: { cutAfterSeq?: number } = {}) {
  let up = true
  let hostSide: ReturnType<HostChannel['attach']> | null = null
  let leaderSide: ReturnType<typeof attachLeaderChannel> | null = null
  const cut = () => {
    if (!up) return
    up = false
    hostSide?.onClose()
    leaderSide?.onClose()
  }
  const toLeader: ChannelLink = {
    send: (f: ChannelFrame) => {
      if (!up) return
      queueMicrotask(() => {
        if (!up) return
        leaderSide!.onFrame(f)
        if (opts.cutAfterSeq !== undefined && f.op === 'facts' && f.recs.some((r) => r.seq >= opts.cutAfterSeq!)) cut()
      })
    },
    close: cut,
  }
  const toHost: ChannelLink = { send: (f) => { if (up) queueMicrotask(() => { if (up) hostSide!.onFrame(f) }) }, close: cut }
  leaderSide = attachLeaderChannel(toHost, {
    walnutId: 'w1', hostId: 'devbox', permit: () => ({ permitNumber: 0, epoch: leader.permit }), ackEveryMs: 1, now: () => Date.now() + clockOffset,
    loadCursor: async () => leader.cursor,
    apply: async (_h, recs, next) => { leader.applied.push(...recs); leader.cursor = next },
    applyRows: async (_h, rows, next) => { leader.snapshots++; for (const r of rows) leader.rows.set(r.claudeSessionId, r); leader.cursor = next },
    onFlow: (_h, _sid, _name, data) => { leader.flows.push(String((data as { text?: string }).text)) },
  })
  hostSide = host.attach(toLeader)
  return { cut, get up() { return up }, idle: () => leaderSide!.idle(), resync: (sids: string[]) => leaderSide!.resync(sids) }
}

async function hostOf(over: Partial<Parameters<typeof FactLog.open>[0]> = {}) {
  // The host's clock moves with the leader's (both machines' time passes), unless a test says otherwise.
  const log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false, now: () => Date.now() + clockOffset, ...over })
  const own: SessionRecord[] = [{ claudeSessionId: 's1', taskId: 't', project: 'P', process_status: 'running', mode: 'default', host: 'devbox', judge: 'host' } as SessionRecord]
  const host = new HostChannel({ log, walnutId: 'w1', hostId: 'devbox', ownRows: async () => own, now: () => Date.now() + clockOffset })
  return { log, host }
}

const seqs = (l: Leader) => l.applied.map((r) => r.seq)
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

describe('exactly once across a cut after any record', () => {
  const N = 24
  for (let k = 1; k <= N; k++) {
    it(`cut after record ${k}, more written while down, then reconnect`, async () => {
      const { log, host } = await hostOf()
      const leader = new Leader()
      const first = connect(host, leader, { cutAfterSeq: k })
      for (let i = 1; i <= N; i++) {
        log.append(`s${i % 3}`, i % 4 ? 'session:tool-use' : 'session:result', { i })
        await log.flush()
        await tick()
      }
      await until(() => !first.up)
      await first.idle()
      const firstApplied = leader.applied.length
      clockOffset = 120_000 // the leader comes back two minutes later
      const second = connect(host, leader)
      await until(() => leader.applied.length >= N)
      await tick(5)
      await second.idle()
      expect(seqs(leader)).toEqual(range(1, N))
      expect(leader.snapshots).toBe(0)
      // What the first link applied was live; what came back after the cut is read back, late.
      // (A record the cut caught between delivery and apply is sent again: it is in the second part.)
      expect(firstApplied).toBeLessThanOrEqual(k)
      expect(leader.applied.slice(0, firstApplied).every((r) => !r.late)).toBe(true)
      expect(leader.applied.slice(firstApplied).every((r) => r.late)).toBe(true)
      second.cut()
      await log.close()
    })
  }
})

describe('a host the leader knew under another log', () => {
  it('gets the host\'s rows first, though the new log still holds every record', async () => {
    const { log, host } = await hostOf()
    const leader = new Leader()
    // The leader's position is of the log this host had before it was set up again.
    leader.cursor = { logId: 'an-older-log', seq: 40 }
    for (let i = 1; i <= 3; i++) log.append('s1', 'session:tool-use', { i })
    await log.flush()
    const link = connect(host, leader)
    await until(() => leader.applied.length === 3)
    await link.idle()
    expect(leader.snapshots).toBe(1)
    expect([...leader.rows.keys()]).toEqual(['s1'])
    expect(seqs(leader)).toEqual([1, 2, 3])
    link.cut()
    await log.close()
  })
})

describe('the leader asks for whole rows again', () => {
  it('a resync frame reaches the host\'s handler from its leader only', async () => {
    const log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
    const asked: string[][] = []
    const host = new HostChannel({ log, walnutId: 'w1', hostId: 'devbox', ownRows: async () => [], onResync: (sids) => { asked.push(sids) } })
    const leader = new Leader()
    const link = connect(host, leader)
    await tick(20)
    link.resync(['s1', '', 's2'])
    await until(() => asked.length === 1)
    expect(asked).toEqual([['s1', 's2']])
    // A listener (no leader) asking is ignored.
    const other = host.attach({ send: () => {}, close: () => {} })
    other.onFrame({ ch: 'sf', op: 'resync', sids: ['x'] })
    await tick(5)
    expect(asked).toHaveLength(1)
    link.cut()
    await log.close()
  })
})

describe('moving to another leader', () => {
  it('a copied leader that is behind resumes from its own position; the old one is refused after', async () => {
    const { log, host } = await hostOf()
    const a = new Leader(1)
    const la = connect(host, a)
    for (let i = 1; i <= 6; i++) log.append('s1', 'session:tool-use', { i })
    await log.flush()
    await until(() => a.applied.length === 6)
    const b = a.copy() // the standby's copy as of record 6
    for (let i = 7; i <= 10; i++) log.append('s1', 'session:tool-use', { i })
    await log.flush()
    await until(() => a.applied.length === 10)
    la.cut()
    // B takes over with a higher permit: it gets 7..14, once.
    for (let i = 11; i <= 14; i++) log.append('s1', 'session:tool-use', { i })
    await log.flush()
    const lb = connect(host, b)
    await until(() => b.applied.length === 14)
    expect(seqs(b)).toEqual(range(1, 14))
    // A wakes with its old permit: refused, nothing replayed to it, nothing trimmed by it.
    const before = a.applied.length
    const lateA = connect(host, a)
    await until(() => !lateA.up)
    expect(a.applied.length).toBe(before)
    expect(log.permit).toBe(2)
    lb.cut()
    await log.close()
  })

  it('a leader below what the log keeps gets the host\'s rows, then the rest, once', async () => {
    const { log, host } = await hostOf({ compactBytes: 1 })
    const a = new Leader(1)
    const la = connect(host, a)
    for (let i = 1; i <= 8; i++) log.append('s1', i % 2 ? 'session:user-line' : 'session:result', { i })
    await log.flush()
    await until(() => a.applied.length === 8)
    await until(() => log.acked === 8)
    await log.compact()
    expect(log.floor).toBeGreaterThan(8)
    la.cut()
    const b = new Leader(2) // no position at all
    for (let i = 9; i <= 12; i++) log.append('s1', 'session:tool-use', { i })
    log.append('s1', 'row', { patch: { messageCount: 4 } }) // already in the rows: not applied again
    await log.flush()
    const lb = connect(host, b)
    await until(() => b.applied.length === 4)
    expect(b.snapshots).toBe(1)
    expect(b.rows.get('s1')).toMatchObject({ judge: 'host' })
    expect(seqs(b)).toEqual([9, 10, 11, 12])
    await until(() => b.cursor?.seq === 13)
    expect(seqs(b)).toEqual([9, 10, 11, 12])
    lb.cut()
    await log.close()
  })
})

describe('readers', () => {
  it('a listener gets the rows and then live records; its acks trim nothing; deltas reach only caught-up readers', async () => {
    const { log, host } = await hostOf()
    const got: ChannelFrame[] = []
    let side: ReturnType<HostChannel['attach']> | null = null
    side = host.attach({ send: (f) => got.push(f), close: () => {} })
    host.flow('s1', 'session:text-delta', { text: 'early' }) // not listening yet: dropped
    side.onFrame({ ch: 'sf', op: 'listen', walnutId: 'w1' })
    await until(() => got.some((f) => f.op === 'rows'))
    await tick(5)
    log.append('s1', 'session:tool-use', {})
    await log.flush()
    await until(() => got.some((f) => f.op === 'facts'))
    host.flow('s1', 'session:text-delta', { text: 'live' })
    side.onFrame({ ch: 'sf', op: 'ack', logId: log.logId, upTo: 1 })
    await tick(5)
    expect(log.acked).toBe(0)
    expect(got.filter((f) => f.op === 'flow').map((f) => (f as { data: { text: string } }).data.text)).toEqual(['live'])
    await log.close()
  })

  it('a leader from another Walnut is refused', async () => {
    const { log, host } = await hostOf()
    const got: ChannelFrame[] = []
    let closed = ''
    const side = host.attach({ send: (f) => got.push(f), close: (w) => { closed = w ?? '' } })
    side.onFrame({ ch: 'sf', op: 'resume', walnutId: 'other', hostId: 'devbox', permitNumber: 9, logId: log.logId, after: 0 })
    await tick(5)
    expect(closed).toBe('walnut_mismatch')
    expect(log.permit).toBe(0)
    await log.close()
  })
})

describe('latency', () => {
  it('a fact is applied on the leader within 1 s of the host writing it (durable, live link)', async () => {
    const { log, host } = await hostOf({ durable: true, flushMs: FACT_FLUSH_MS })
    const leader = new Leader()
    const l = connect(host, leader)
    await tick(10)
    const worst: number[] = []
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now()
      log.append('s1', 'session:tool-use', { i })
      await until(() => leader.applied.length === i + 1)
      worst.push(performance.now() - t0)
    }
    const max = Math.max(...worst)
    console.log(`session channel in-process latency: max ${max.toFixed(1)} ms, median ${worst.sort((a, b) => a - b)[20].toFixed(1)} ms`)
    expect(max).toBeLessThan(1000)
    l.cut()
    await log.close()
  })
})

describe('late facts, on the leader\'s clock', () => {
  const T = 1_800_000_000_000
  function leaderAt(clock: { now: number }) {
    const applied: AppliedFact[] = []
    const sent: ChannelFrame[] = []
    const side = attachLeaderChannel({ send: (f) => { sent.push(f) }, close: () => {} }, {
      walnutId: 'w1', hostId: 'devbox', permit: () => ({ permitNumber: 0, epoch: 1 }), ackEveryMs: 1_000_000, now: () => clock.now,
      loadCursor: async () => null,
      apply: async (_h, recs) => { applied.push(...recs) },
      applyRows: async () => {},
    })
    return { side, applied, sent }
  }
  const rec = (seq: number, at: number) => ({ v: 2, seq, opId: `o${seq}`, rev: 1, at, kind: 'session-fact', sid: 's1', sseq: seq, name: 'session:tool-use', data: {} }) as const

  it('live frames that waited in the link while the leader was stopped are late; fresh ones are not', async () => {
    const clock = { now: T }
    const { side, applied } = leaderAt(clock)
    side.onFrame({ ch: 'sf', op: 'hello', walnutId: 'w1', hostId: 'devbox', logId: 'L', floor: 1, head: 0, now: T })
    await side.idle()
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(1, T + 10)], sentAt: T + 10 })
    await side.idle()
    clock.now = T + 120_000 // stopped two minutes with a frame waiting in the socket
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(2, T + 20)], sentAt: T + 20 })
    await side.idle()
    expect(applied.map((r) => [r.seq, r.late])).toEqual([[1, false], [2, true]])
  })

  it('a host clock ten minutes ahead reads neither late nor fresh by mistake', async () => {
    const skew = 600_000
    const clock = { now: T }
    const { side, applied } = leaderAt(clock)
    side.onFrame({ ch: 'sf', op: 'hello', walnutId: 'w1', hostId: 'devbox', logId: 'L', floor: 1, head: 0, now: T + skew })
    await side.idle()
    clock.now = T + 30
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(1, T + skew + 20)], sentAt: T + skew + 25 })
    await side.idle()
    clock.now = T + 200_000
    // Read back after a cut: it happened 3 minutes ago on the host's own clock.
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(2, T + skew + 20_000)], replay: true, sentAt: T + skew + 199_990 })
    await side.idle()
    expect(applied.map((r) => [r.seq, r.late])).toEqual([[1, false], [2, true]])
    // When each happened, on the leader's clock: the host's time moved by the smallest offset seen (the hello's).
    expect(applied.map((r) => r.happenedAt)).toEqual([T + 20, T + 20_000])
  })

  it('a record never happened after the leader applies it', async () => {
    const clock = { now: T }
    const { side, applied } = leaderAt(clock)
    side.onFrame({ ch: 'sf', op: 'hello', walnutId: 'w1', hostId: 'devbox', logId: 'L', floor: 1, head: 0, now: T })
    await side.idle()
    // A host time a little past the leader's now (rounding on a fast link): it happened now.
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(1, T + 50)], sentAt: T })
    await side.idle()
    expect(applied.map((r) => r.happenedAt)).toEqual([T])
  })

  it('a host clock behind does not make a fresh record late', async () => {
    const skew = -600_000
    const clock = { now: T }
    const { side, applied } = leaderAt(clock)
    side.onFrame({ ch: 'sf', op: 'hello', walnutId: 'w1', hostId: 'devbox', logId: 'L', floor: 1, head: 0, now: T + skew })
    await side.idle()
    clock.now = T + 40
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(1, T + skew + 30)], sentAt: T + skew + 35 })
    await side.idle()
    expect(applied.map((r) => r.late)).toEqual([false])
  })
})

describe('the leader standing: (permitNumber, epoch), compared in that order', () => {
  it('comparePermit orders by the permit number first, then the epoch', () => {
    expect(comparePermit({ permitNumber: 1, epoch: 9 }, { permitNumber: 2, epoch: 0 })).toBeLessThan(0)
    expect(comparePermit({ permitNumber: 2, epoch: 0 }, { permitNumber: 1, epoch: 9 })).toBeGreaterThan(0)
    expect(comparePermit({ permitNumber: 3, epoch: 4 }, { permitNumber: 3, epoch: 5 })).toBeLessThan(0)
    expect(comparePermit({ permitNumber: 3, epoch: 5 }, { permitNumber: 3, epoch: 5 })).toBe(0)
    // A resume from an older leader (no epoch): its one number was the epoch.
    expect(permitOfResume({ permitNumber: 7 })).toEqual({ permitNumber: 0, epoch: 7 })
    expect(permitOfResume({ permitNumber: 2, epoch: 1 })).toEqual({ permitNumber: 2, epoch: 1 })
    expect(permitOfResume({ permitNumber: -1, epoch: 1 })).toBeNull()
    expect(permitOfResume({ permitNumber: 1.5 })).toBeNull()
  })

  it('a resume is refused below the highest pair seen; a higher permit number wins whatever its epoch', async () => {
    const { log, host } = await hostOf()
    const resume = (permitNumber: number, epoch?: number) => new Promise<string>((resolve) => {
      const side = host.attach({ send: (f) => { if (f.op === 'rows' || f.op === 'facts') resolve('taken') }, close: (w) => resolve(w ?? '') })
      side.onFrame({ ch: 'sf', op: 'resume', walnutId: 'w1', hostId: 'devbox', permitNumber, ...(epoch === undefined ? {} : { epoch }), logId: log.logId, after: -1 })
    })
    log.append('s1', 'session:tool-use', {})
    await log.flush()
    expect(await resume(1, 5)).toBe('taken')
    expect(log.permitPair).toEqual({ permitNumber: 1, epoch: 5 })
    expect(await resume(1, 4)).toBe('stale_permit')
    // An older leader's resume reads (0, 9): below (1, 5).
    expect(await resume(9)).toBe('stale_permit')
    expect(await resume(2, 0)).toBe('taken')
    expect(log.permitPair).toEqual({ permitNumber: 2, epoch: 0 })
    // The epoch an older build reads stays in `permit`.
    expect(log.permit).toBe(0)
    await log.close()
  })

  it('a log an older build wrote (one number) reads as (0, n), and an older build still reads its epoch', async () => {
    await fsp.writeFile(path.join(dir, 'facts-w1.state.json'), JSON.stringify({ v: 1, logId: 'abcd', acked: 0, permit: 6, sseq: {} }))
    const log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
    expect(log.permitPair).toEqual({ permitNumber: 0, epoch: 6 })
    await log.notePermit({ permitNumber: 0, epoch: 5 })
    expect(log.permitPair).toEqual({ permitNumber: 0, epoch: 6 })
    await log.notePermit({ permitNumber: 3, epoch: 2 })
    await log.close()
    const state = JSON.parse(await fsp.readFile(path.join(dir, 'facts-w1.state.json'), 'utf8'))
    expect(state).toMatchObject({ permit: 2, permitNumber: 3 })
    const again = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
    expect(again.permitPair).toEqual({ permitNumber: 3, epoch: 2 })
    await again.close()
  })
})

describe('deltas merge on the host for a moment; facts stay one record each', () => {
  /** A listener that is caught up, its frames as they come. */
  async function caughtUpReader(host: HostChannel) {
    const got: ChannelFrame[] = []
    const side = host.attach({ send: (f) => got.push(f), close: () => {} })
    side.onFrame({ ch: 'sf', op: 'listen', walnutId: 'w1' })
    await until(() => got.some((f) => f.op === 'rows'))
    await tick(5)
    return got
  }
  const flowsOf = (got: ChannelFrame[]) => got.filter((f): f is Extract<ChannelFrame, { op: 'flow' }> => f.op === 'flow')

  it('the deltas of one message in 50 ms go as one flow frame with the whole text', async () => {
    const { log, host } = await hostOf()
    const got = await caughtUpReader(host)
    for (const piece of ['the build ', 'reads its ', 'config']) host.flow('s1', 'session:text-delta', { sessionId: 's1', delta: piece, msgId: 'm1' }, ['main-ai'])
    expect(flowsOf(got)).toHaveLength(0)
    await until(() => flowsOf(got).length > 0, 1000)
    expect(flowsOf(got).map((f) => f.data)).toEqual([{ sessionId: 's1', delta: 'the build reads its config', msgId: 'm1' }])
    expect(flowsOf(got)[0]!.to).toEqual(['main-ai'])
    await log.close()
  })

  it('a session\'s order holds: another message, another kind of flow, and a fact each send what is open first', async () => {
    const { log, host } = await hostOf()
    const got = await caughtUpReader(host)
    host.flow('s1', 'session:text-delta', { sessionId: 's1', delta: 'a', msgId: 'm1' })
    host.flow('s1', 'session:text-delta', { sessionId: 's1', delta: 'b', msgId: 'm1' })
    host.flow('s1', 'session:thinking-delta', { sessionId: 's1', delta: 'hmm', msgId: 'm1' })
    host.flow('s1', 'session:live-activity', { sessionId: 's1', activity: 'writing' })
    host.flow('s1', 'session:text-delta', { sessionId: 's1', delta: 'c', msgId: 'm2' })
    host.flow('s2', 'session:text-delta', { sessionId: 's2', delta: 'other', msgId: 'm9' })
    log.append('s1', 'session:tool-use', { sessionId: 's1' })
    await log.flush()
    await until(() => got.some((f) => f.op === 'facts'), 1000)
    const order = got.filter((f) => f.op === 'flow' || f.op === 'facts').map((f) => (f.op === 'facts' ? 'facts' : `${f.sid}:${f.name.slice(8)}:${(f.data as { delta?: string }).delta ?? '-'}`))
    // s1's deltas before its fact, in their order; s2's still open (nothing of s2 in the frame).
    expect(order).toEqual(['s1:text-delta:ab', 's1:thinking-delta:hmm', 's1:live-activity:-', 's1:text-delta:c', 'facts'])
    await until(() => flowsOf(got).some((f) => f.sid === 's2'), 1000)
    expect(flowsOf(got).find((f) => f.sid === 's2')!.data).toMatchObject({ delta: 'other' })
    await log.close()
  })

  it('every fact still goes as its own record, and nothing is merged when the merge is off', async () => {
    const log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
    const host = new HostChannel({ log, walnutId: 'w1', hostId: 'devbox', ownRows: async () => [], flowMergeMs: 0 })
    const got = await caughtUpReader(host)
    host.flow('s1', 'session:text-delta', { sessionId: 's1', delta: 'a' })
    host.flow('s1', 'session:text-delta', { sessionId: 's1', delta: 'b' })
    expect(flowsOf(got).map((f) => (f.data as { delta: string }).delta)).toEqual(['a', 'b'])
    for (let i = 0; i < 3; i++) log.append('s1', 'session:tool-use', { i })
    await log.flush()
    await until(() => got.filter((f) => f.op === 'facts').flatMap((f) => (f as { recs: FactRecord[] }).recs).length === 3, 1000)
    await log.close()
  })
})

describe('the leader applies the facts frames that queued behind one apply in one call', () => {
  it('in order, its position the last one\'s, a rows frame between them kept in its place', async () => {
    const calls: Array<{ seqs: number[]; next: number }> = []
    const kinds: string[] = []
    let release: () => void = () => {}
    let hold = true
    const sent: ChannelFrame[] = []
    const side = attachLeaderChannel({ send: (f) => sent.push(f), close: () => {} }, {
      walnutId: 'w1', hostId: 'devbox', permit: () => ({ permitNumber: 0, epoch: 1 }), ackEveryMs: 1,
      loadCursor: async () => null,
      apply: async (_h, recs, next) => {
        kinds.push('facts')
        calls.push({ seqs: recs.map((r) => r.seq), next: next.seq })
        if (hold) { hold = false; await new Promise<void>((r) => { release = r }) }
      },
      applyRows: async () => { kinds.push('rows') },
    })
    const rec = (seq: number): FactRecord => ({ seq, opId: `o${seq}`, at: Date.now(), sid: 's1', sseq: seq, name: 'session:tool-use', data: { seq } })
    side.onFrame({ ch: 'sf', op: 'hello', walnutId: 'w1', hostId: 'devbox', logId: 'L', floor: 1, head: 0, now: Date.now() })
    await tick(5)
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(1)], sentAt: Date.now() })
    await until(() => calls.length === 1)
    // While the first apply runs: three frames, then a rows frame, then two more.
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(2)], sentAt: Date.now() })
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(3), rec(4)], sentAt: Date.now() })
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(4), rec(5)], sentAt: Date.now() })
    side.onFrame({ ch: 'sf', op: 'rows', rows: [], upTo: 5, rowsAt: 5, logId: 'L' })
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(6)], sentAt: Date.now() })
    side.onFrame({ ch: 'sf', op: 'facts', recs: [rec(7)], sentAt: Date.now() })
    release()
    await side.idle()
    await tick(5)
    await side.idle()
    expect(calls).toEqual([{ seqs: [1], next: 1 }, { seqs: [2, 3, 4, 5], next: 5 }, { seqs: [6, 7], next: 7 }])
    expect(kinds).toEqual(['facts', 'facts', 'rows', 'facts'])
    await until(() => sent.some((f) => f.op === 'ack' && f.upTo === 7))
  })
})
