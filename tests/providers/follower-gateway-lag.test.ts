/**
 * The seconds after the leader's link drops (follower-gateway-core.ts waitOutLag): this daemon
 * already sees the leader away and hands a session's call to the host's own Walnut server, whose
 * view (a poll of follower.status) still says the leader answers, so it refuses `leader_answers`.
 * That refusal must not send the call to the daemon's own away answer while the follower is there:
 * the call goes to the follower again (same relayId) until it answers, or is relayed once the
 * leader answers here again; only a spent lag budget or deadline keeps today's way (counted).
 */
import { describe, expect, it, vi } from 'vitest'
import type { FollowerGatewayResponse } from '../../src/providers/follower-gateway-core.js'
import { call, setup } from '../helpers/follower-gateway-harness.js'

const lagging: FollowerGatewayResponse = { ok: false, error: { code: 'needs_leader', message: 'your Mac answers again; the call goes to it', detail: { why: 'leader_answers' } } }

/** A session's call as the twin hands it (sendGatewayRequest): its fallback relays while the leader answers, else answers offline, counted. */
function sessionCall(s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) {
  const respond = vi.fn()
  const relayed = vi.fn()
  const offline = vi.fn()
  const c = call(over)
  const fallback = () => {
    if (!s.state.mayWrite) return relayed()
    s.g.noteOwnOffline(c.home, c.capability, c.callerSid, c.payload, true)
    offline()
  }
  expect(s.g.handOff({ ...c, fallback }, respond)).toBe(true)
  return { respond, relayed, offline }
}

const relayIds = (s: ReturnType<typeof setup>) => s.sock.sent.map((x) => x.data.relayId)

describe('a hand-back while the follower\'s view of the leader lags', () => {
  it('the follower\'s presence flips: handed again under the same relayId, answered by it, no offline answer', () => {
    const s = setup()
    const c = sessionCall(s)
    expect(s.g.settle(s.sock, 101, lagging)).toBe('ok')
    expect(c.offline).not.toHaveBeenCalled()
    expect(s.sock.sent).toHaveLength(1)
    // A first step: the follower still lags.
    s.state.now += 500
    s.fire()
    expect(relayIds(s)).toEqual([101, 101])
    s.g.settle(s.sock, 101, lagging)
    // Its view caught up: it answers.
    s.state.now += 500
    s.fire()
    expect(relayIds(s)).toEqual([101, 101, 101])
    // The retry is timed by what is left of the call's own time.
    expect(s.sock.sent[2]!.data.answerInMs).toBe(31_000 - s.state.now)
    s.g.settle(s.sock, 101, { ok: true, result: { updated: true } })
    expect(c.respond).toHaveBeenCalledWith({ ok: true, result: { updated: true } })
    expect(c.offline).not.toHaveBeenCalled()
    expect(c.relayed).not.toHaveBeenCalled()
    expect(s.g.ownAnswers().total).toBe(0)
    expect(s.g.pendingCount()).toBe(0)
  })

  it('the leader answers here again within the wait: routed afresh and relayed, the follower not asked again', () => {
    const s = setup()
    const c = sessionCall(s)
    s.g.settle(s.sock, 101, lagging)
    s.state.mayWrite = false
    s.state.now += 500
    s.fire()
    expect(c.relayed).toHaveBeenCalledOnce()
    expect(c.offline).not.toHaveBeenCalled()
    expect(s.sock.sent).toHaveLength(1)
    expect(s.g.ownAnswers().total).toBe(0)
  })

  it('the follower never catches up: after the lag budget, today\'s way (the daemon\'s offline answer, counted)', () => {
    const s = setup()
    const c = sessionCall(s)
    for (let i = 0; i < 40 && !c.offline.mock.calls.length; i++) {
      s.g.settle(s.sock, 101, lagging)
      s.state.now += 500
      s.fire()
    }
    expect(c.offline).toHaveBeenCalledOnce()
    // At most 5 s of re-handing, every time under the call's one relayId.
    expect(s.sock.sent.length).toBe(11)
    expect(new Set(relayIds(s))).toEqual(new Set([101]))
    expect(s.g.ownAnswers()).toMatchObject({ total: 1, byWhy: { handed_back: 1 }, byOp: { task_update: 1 } })
  })

  it('too little of the call\'s time left for the follower to run it: today\'s way at once', () => {
    const s = setup()
    const c = sessionCall(s, { deadline: s.state.now + 10_000 })
    s.g.settle(s.sock, 101, lagging)
    expect(c.offline).toHaveBeenCalledOnce()
    expect(s.timers.filter((t) => !t.cleared)).toEqual([])
  })

  it('only `leader_answers` waits: another non-final needs_leader, the companion leading, or the leader back already take today\'s way at once', () => {
    const noKey = setup()
    const a = sessionCall(noKey)
    noKey.g.settle(noKey.sock, 101, { ok: false, error: { code: 'needs_leader', message: 'no host name', detail: { why: 'no_host_key' } } })
    expect(a.offline).toHaveBeenCalledOnce()

    const companion = setup()
    const b = sessionCall(companion)
    companion.state.companion = true
    companion.g.settle(companion.sock, 101, lagging)
    expect(b.offline).toHaveBeenCalledOnce()

    const back = setup()
    const d = sessionCall(back)
    back.state.mayWrite = false
    back.g.settle(back.sock, 101, lagging)
    expect(d.relayed).toHaveBeenCalledOnce()
    expect(back.sock.sent).toHaveLength(1)
  })

  it('the follower unlinked during the wait: the twin\'s rules decide (today\'s hand-back)', () => {
    const s = setup()
    const c = sessionCall(s)
    s.g.settle(s.sock, 101, lagging)
    s.link.ws = null
    s.state.now += 500
    s.fire()
    expect(c.offline).toHaveBeenCalledOnce()
    expect(s.sock.sent).toHaveLength(1)
  })

  it('handed again only as a first hand would be: a caller that hung up ends it, a daemon that stops answers it so; counted while it waits', () => {
    // A session's call whose `walnut` was stopped in the gap: neither handed again nor answered offline.
    const s = setup()
    let gone = false
    const c = sessionCall(s, { left: () => gone })
    s.g.settle(s.sock, 101, lagging)
    expect(s.g.pendingCount()).toBe(1)
    gone = true
    s.state.now += 500
    s.fire()
    expect(s.sock.sent).toHaveLength(1)
    expect(c.offline).not.toHaveBeenCalled()
    expect(c.relayed).not.toHaveBeenCalled()
    expect(c.respond).not.toHaveBeenCalled()
    expect(s.g.pendingCount()).toBe(0)
    expect(s.logs.some((l) => /its caller left/.test(l.msg))).toBe(true)

    // A plugin job's call: the same, before the job's own route could run.
    const j = setup()
    const again = vi.fn()
    const respond = vi.fn()
    let jobGone = false
    j.g.routeJob(call({ callerSid: 'external', caller: { kind: 'plugin-job', plugin: 'acme-sync', job: 'poll' }, left: () => jobGone }), respond, again)
    j.g.settle(j.sock, 101, lagging)
    jobGone = true
    j.state.now += 500
    j.fire()
    expect(j.sock.sent).toHaveLength(1)
    expect(again).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()

    // The daemon stopping in the gap (its follower link closing): the caller is told, nothing is handed on.
    const d = setup()
    const dc = sessionCall(d)
    d.g.settle(d.sock, 101, lagging)
    d.state.stopping = true
    d.state.now += 500
    d.fire()
    expect(d.sock.sent).toHaveLength(1)
    expect(dc.respond).toHaveBeenCalledWith({ ok: false, error: { code: 'hub_unreachable', message: 'daemon is shutting down; retry after reconnecting', detail: { stopping: true } } })
    expect(dc.offline).not.toHaveBeenCalled()
    expect(dc.relayed).not.toHaveBeenCalled()
  })

  it('a same-host send while the leader answers is not held: its refusal goes to the leader at once', () => {
    const s = setup()
    s.sock.answersOnline = true
    const relay = vi.fn()
    s.g.handOff(call({ payload: { name: 'task_send', args: { to: 't2', text: 'hi' } }, online: true, fallback: relay }), vi.fn())
    s.g.settle(s.sock, 101, lagging)
    expect(relay).toHaveBeenCalledOnce()
    expect(s.sock.sent).toHaveLength(1)
  })

  it('a plugin job\'s call: handed again and answered by the follower; the leader back, routed afresh by the job\'s own route', () => {
    const job = call({ callerSid: 'external', caller: { kind: 'plugin-job', plugin: 'acme-sync', job: 'poll' } })
    const s = setup()
    const respond = vi.fn()
    expect(s.g.routeJob(job, respond, vi.fn())).toBe('handed')
    s.g.settle(s.sock, 101, lagging)
    expect(respond).not.toHaveBeenCalled()
    s.state.now += 500
    s.fire()
    expect(relayIds(s)).toEqual([101, 101])
    s.g.settle(s.sock, 101, { ok: true, result: { id: 't9' } })
    expect(respond).toHaveBeenCalledWith({ ok: true, result: { id: 't9' } })

    const back = setup()
    const again = vi.fn()
    const respond2 = vi.fn()
    back.g.routeJob(job, respond2, again)
    back.g.settle(back.sock, 101, lagging)
    back.state.mayWrite = false
    back.state.now += 500
    back.fire()
    expect(again).toHaveBeenCalledOnce()
    expect(respond2).not.toHaveBeenCalled()
  })
})
