/**
 * A same-host send handed to this host's Walnut server while the leader answers is written once
 * (offline-host-core.ts openOnline / endOnline and the follower.peer claim), with the gateway's
 * hand-off as the twins wire it (sendGatewayRequest's online branch, replayed here over the real
 * follower-gateway-core.ts): the hand-off timing out while the follower is late, or while its
 * follower.peer still writes, never lets both the leader and this host deliver it, and opens one
 * request row at most.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupJournalDirs, JHOME, journalHost, journalTmpDir, jslice, SID_A, SID_B, TASK_B } from '../helpers/offline-journal-harness.js'
import { createOfflineHost } from '../../src/providers/offline-host-core.js'
import { createFollowerGateway, type FollowerGatewayResponse } from '../../src/providers/follower-gateway-core.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'

const T0 = Date.parse('2026-11-20T12:00:00Z')
const MID = 'qm-host-call7'
const PEER = { kind: 'send', online: true, fromSessionId: SID_A, toSessionId: SID_B, toTaskId: TASK_B, text: '<walnut-message kind="peer-note">hi</walnut-message>', dupText: 'hi', messageId: MID, ask: { id: 'rq-0c0c0c0c0c0c', preview: 'hi', secs: 3600 }, opId: 'op-online-1' }

afterEach(() => cleanupJournalDirs())

function cluster(o: { fail?: string } = {}) {
  const h = journalHost(journalTmpDir(), { now: T0 }, { drains: [...JOURNAL_V2_DRAINS, 'held-op'] })
  let gate: Promise<void> | null = null
  const delivered: string[] = []
  const host = createOfflineHost({
    ...h.deps,
    pendingPrompt: () => null,
    deliver: async (sid) => {
      if (gate) await gate
      if (o.fail) return { ok: false, reason: o.fail }
      delivered.push(sid)
      return { ok: true }
    },
  })
  host.configure(jslice())
  const sock = { name: 'follower' }
  const timers: Array<() => void> = []
  const sent: Array<Record<string, unknown>> = []
  const gw = createFollowerGateway<typeof sock>({
    follower: () => sock, mayWrite: () => false, answersOnline: () => true, now: () => T0,
    send: (_ws, _ev, data) => { sent.push(data); return true },
    nextRelayId: (() => { let n = 0; return () => ++n })(), instanceId: 'daemon-1', attemptMs: () => 20_000, minRelayMs: 8_000,
    setTimer: (fn) => { timers.push(fn); return fn }, clearTimer: (t) => { const i = timers.indexOf(t as () => void); if (i >= 0) timers.splice(i, 1) },
    log: () => {},
  })
  const relayed: unknown[] = []
  const answers: FollowerGatewayResponse[] = []
  /** Whether a leader answers when the hand-off ends (its link may close during it). */
  const leader = { answers: true }
  /**
   * The twins' online branch: open, hand off, and on its end, when nothing was written here, relay
   * it to the leader that answers then, else answer it with this host's own away code (handle).
   */
  function call(): Record<string, unknown> {
    const payload: Record<string, unknown> = { name: 'task_send', args: { to: TASK_B, text: 'hi', messageId: MID } }
    const relay = () => { relayed.push(payload) }
    if (!host.openOnline(JHOME, payload)) { relay(); return payload }
    const ended = () => {
      void host.endOnline(JHOME, payload).then(async (r) => {
        if (r) return answers.push(r as FollowerGatewayResponse)
        if (leader.answers) return relay()
        answers.push(await host.handle(JHOME, SID_A, 'tools.call', payload) as FollowerGatewayResponse)
      })
    }
    if (!gw.handOff({ home: JHOME, capability: 'tools.call', callerSid: SID_A, payload, deadline: T0 + 20_000, online: true, fallback: ended }, (r) => answers.push(r))) ended()
    return payload
  }
  const hold = () => { let open!: () => void; gate = new Promise<void>((r) => { open = r }); return () => { gate = null; open() } }
  const timeout = () => timers.shift()!()
  const settle = () => new Promise((r) => setTimeout(r, 10))
  return { host, journal: h.journal, gw, sock, sent, delivered, relayed, answers, leader, call, hold, timeout, settle }
}

describe('an online hand-off is written once: by this host or by the leader, never both', () => {
  it('the hand-off times out before the follower writes: relayed once, and the late follower.peer is refused, nothing written', async () => {
    const c = cluster()
    c.call()
    c.timeout()
    await c.settle()
    expect(c.relayed).toHaveLength(1)
    const late = await c.host.handleFollowerPeer(JHOME, PEER)
    expect(late).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'server_delivers' } } })
    expect(c.delivered).toEqual([])
    expect(c.journal.records(JHOME)).toEqual([])
    expect(c.host.journal.state(JHOME)).toMatchObject({ rows: {} })
    // The follower's own answer after that finds nothing waiting on it.
    expect(c.gw.settle(c.sock, c.sent[0]!.relayId as number, { ok: false, error: { code: 'needs_leader', message: 'x' } })).toBe('stale')
    expect(c.relayed).toHaveLength(1)
  })

  it('the hand-off times out while the follower.peer writes: no relay; the caller hears the write, one delivery, one row', async () => {
    const c = cluster()
    c.call()
    const open = c.hold()
    const writing = c.host.handleFollowerPeer(JHOME, PEER)
    c.timeout()
    await c.settle()
    expect(c.relayed).toEqual([])
    expect(c.answers).toEqual([])
    open()
    expect(await writing).toMatchObject({ ok: true, result: { delivered: true, requestId: 'rq-0c0c0c0c0c0c' } })
    await c.settle()
    expect(c.relayed).toEqual([])
    expect(c.answers).toEqual([expect.objectContaining({ ok: true, result: expect.objectContaining({ delivery: 'queued', via: 'host', requestId: 'rq-0c0c0c0c0c0c', messageId: MID }) })])
    expect(c.delivered).toEqual([SID_B])
    expect(c.journal.records(JHOME).map((r) => r.kind)).toEqual(['row', 'delivery'])
    // A retry of that call (same message id) is answered from the write, never relayed.
    c.call()
    c.timeout()
    await c.settle()
    expect(c.relayed).toEqual([])
    expect(c.delivered).toEqual([SID_B])
  })

  it('the write fails while the hand-off timed out: relayed once, no row left', async () => {
    const c = cluster({ fail: 'fifo_closed' })
    c.call()
    const open = c.hold()
    const writing = c.host.handleFollowerPeer(JHOME, PEER)
    c.timeout()
    open()
    expect(await writing).toMatchObject({ ok: false, error: { code: 'needs_leader' } })
    await c.settle()
    expect(c.relayed).toHaveLength(1)
    expect(c.journal.records(JHOME)).toEqual([])
    expect(c.host.journal.state(JHOME)).toMatchObject({ rows: {} })
  })

  it('a call that went to the leader once goes there again on a retry, never to the follower', async () => {
    const c = cluster()
    c.call()
    c.timeout()
    await c.settle()
    c.call()
    expect(c.relayed).toHaveLength(2)
    expect(c.sent).toHaveLength(1)
    expect(await c.host.handleFollowerPeer(JHOME, { ...PEER, opId: 'op-online-2' })).toMatchObject({ ok: false, error: { code: 'needs_leader' } })
    expect(c.delivered).toEqual([])
  })

  it('the follower answers in time: its answer is the caller\'s, nothing relayed', async () => {
    const c = cluster()
    c.call()
    expect(await c.host.handleFollowerPeer(JHOME, PEER)).toMatchObject({ ok: true })
    expect(c.gw.settle(c.sock, c.sent[0]!.relayId as number, { ok: true, result: { delivery: 'queued' } })).toBe('ok')
    await c.settle()
    expect(c.answers).toEqual([{ ok: true, result: { delivery: 'queued' } }])
    expect(c.relayed).toEqual([])
    expect(c.delivered).toEqual([SID_B])
  })

  // The leader drops mid hand-off: the follower, seeing it gone, sends the same message on its away
  // path (follower.peer online:false). Review round 2, N1: it wrote with no claim, and the hand-off's
  // end then relayed it to the leader too (two deliveries, two rows).
  it('the leader drops mid hand-off and the follower writes it away: no relay, one delivery, one row', async () => {
    const c = cluster()
    c.call()
    const away = await c.host.handleFollowerPeer(JHOME, { ...PEER, online: false, opId: 'op-away-1' })
    expect(away).toMatchObject({ ok: true, result: { delivered: true, messageId: MID } })
    c.timeout()
    await c.settle()
    expect(c.relayed).toEqual([])
    expect(c.answers).toEqual([expect.objectContaining({ ok: true, result: expect.objectContaining({ messageId: MID }) })])
    expect(c.delivered).toEqual([SID_B])
    expect(c.journal.records(JHOME).map((r) => r.kind)).toEqual(['row', 'delivery'])
  })

  // The leader's link closes during the hand-off and the follower does not answer in time: the twins
  // relayed it to the leader captured when the call came, on its dead socket with the hand-off's time
  // spent, so nobody delivered it and the caller heard hub_timeout (tests/e2e/replica-cluster-handoff-cut-e2e.test.ts).
  it('the hand-off times out with the leader gone: this host\'s own away answer delivers it once; the follower\'s late write is refused', async () => {
    const c = cluster()
    c.call()
    c.leader.answers = false
    c.timeout()
    await c.settle()
    expect(c.relayed).toEqual([])
    expect(c.answers).toEqual([expect.objectContaining({ ok: true, result: expect.objectContaining({ messageId: MID }) })])
    expect(c.delivered).toEqual([SID_B])
    for (const late of [PEER, { ...PEER, online: false, opId: 'op-away-late' }]) {
      expect(await c.host.handleFollowerPeer(JHOME, late)).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'server_delivers' } } })
    }
    expect(c.delivered).toEqual([SID_B])
    expect(c.journal.records(JHOME).filter((r) => r.kind === 'delivery').map((r) => (r as { messageId?: string }).messageId)).toEqual([MID])
  })

  it('a hand-off already relayed to the leader: the follower\'s away write of it is refused, nothing written', async () => {
    const c = cluster()
    c.call()
    c.timeout()
    await c.settle()
    expect(c.relayed).toHaveLength(1)
    const away = await c.host.handleFollowerPeer(JHOME, { ...PEER, online: false, opId: 'op-away-2' })
    expect(away).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'server_delivers' } } })
    expect(c.delivered).toEqual([])
    expect(c.journal.records(JHOME)).toEqual([])
  })

  it('a message never handed over: an away follower.peer writes it with no claim', async () => {
    const c = cluster()
    expect(await c.host.handleFollowerPeer(JHOME, { ...PEER, online: false, opId: 'op-away-3' })).toMatchObject({ ok: true, result: { delivered: true } })
    expect(c.delivered).toEqual([SID_B])
  })

  it('no hand-off open for it: an online follower.peer writes nothing', async () => {
    const c = cluster()
    expect(await c.host.handleFollowerPeer(JHOME, PEER)).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'server_delivers' } } })
    expect(c.delivered).toEqual([])
  })
})
