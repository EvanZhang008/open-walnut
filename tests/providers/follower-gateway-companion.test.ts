/**
 * A call this host's Walnut server refuses for want of a leader (`needs_leader`, final) while the
 * cloud companion leads (follower-gateway-core.ts askElsewhere): relayed to the companion, never to
 * the daemon's own away answer. 2026-11-22: with the Mac away and the companion leading, every such
 * refusal went to the daemon's away code, which asked the companion anyway, waited out the call's
 * time for the Mac when it took nothing (82 s for host_list), asked again and was counted twice:
 * 770 "daemon offline answer used" in a night, host_exec and host_exec_read most of them.
 */
import { describe, expect, it, vi } from 'vitest'
import { type FollowerGatewayResponse } from '../../src/providers/follower-gateway-core.js'
import { GATEWAY_MIN_RELAY_MS } from '../../src/providers/gateway-core.js'
import { call, setup } from '../helpers/follower-gateway-harness.js'

const refused: FollowerGatewayResponse = { ok: false, error: { code: 'needs_leader', message: 'host_exec needs your Mac', detail: { final: true } } }
const hostExec = { payload: { name: 'host_exec', args: { host: 'box', command: 'ls' } } }

/** A call handed while the companion leads, refused finally by the follower. */
function refusedWhileCompanionLeads(over: Record<string, unknown> = hostExec, linked = true) {
  const s = setup()
  s.state.companion = true
  s.state.companionLinked = linked
  const respond = vi.fn()
  const fallback = vi.fn()
  expect(s.g.handOff(call({ fallback, ...over }), respond)).toBe(true)
  s.g.settle(s.sock, 101, refused)
  return { s, respond, fallback }
}

describe('follower gateway: a final refusal while the companion leads', () => {
  it('goes to the companion, whose answer is the caller\'s; the daemon\'s away answer is never used nor counted', () => {
    const { s, respond, fallback } = refusedWhileCompanionLeads({ payload: { name: 'task_get', args: { id: 't9' } } })
    expect(fallback).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
    expect(s.relayed).toHaveLength(1)
    expect(s.relayed[0]!.call.payload).toEqual({ name: 'task_get', args: { id: 't9' } })
    const ok: FollowerGatewayResponse = { ok: true, result: { id: 't9', viaLeader: true } }
    s.relayed[0]!.answer(ok)
    expect(respond).toHaveBeenCalledWith(ok)
    expect(s.holds).toEqual([])
    expect(s.g.ownAnswers().total).toBe(0)
    expect(s.logs.map((l) => l.msg)).toContain('gateway: this host\'s Walnut server needs a leader for the call; asked of the cloud companion, which leads')
  })

  it('a companion answer that ran (an op error, a timeout that may have run) is the caller\'s as it is', () => {
    for (const answer of [
      { ok: false, error: { code: 'unknown_peer', message: 'no task "x"' } },
      { ok: false, error: { code: 'hub_timeout', message: 'the cloud companion did not answer in time' } },
      { ok: false, error: { code: 'internal', message: 'task_get failed', api: { status: 404, code: 'not_found' } } },
    ] satisfies FollowerGatewayResponse[]) {
      const { s, respond } = refusedWhileCompanionLeads()
      s.relayed[0]!.answer(answer)
      expect(respond).toHaveBeenCalledWith(answer)
      expect(s.holds).toEqual([])
    }
  })

  it('what the companion does not take (it needs the Mac too) ends as the follower said, at once', () => {
    for (const notTaken of [
      { ok: false, error: { code: 'hub_unreachable', message: '"host_exec" needs the Walnut server, which is away' } },
      { ok: false, error: { code: 'needs_leader', message: 'needs the Mac' } },
      // The companion's replica route refusing for the Mac: its API's code, not lifted.
      { ok: false, error: { code: 'internal', message: 'needs the Mac', api: { status: 503, code: 'needs_leader' } } },
    ] satisfies FollowerGatewayResponse[]) {
      const { s, respond, fallback } = refusedWhileCompanionLeads()
      s.relayed[0]!.answer(notTaken)
      expect(respond).toHaveBeenCalledWith(refused)
      expect(fallback).not.toHaveBeenCalled()
      expect(s.timers.filter((t) => !t.cleared)).toEqual([])
      expect(s.g.ownAnswers().total).toBe(0)
    }
  })

  it('the companion is given only what is left of the call\'s deadline, never a whole hub wait on top of the follower\'s', () => {
    // The call is due at 31 000; the follower answered at 13 000: 18 s are left for the companion.
    const s = setup()
    s.state.companion = true
    const respond = vi.fn()
    expect(s.g.handOff(call({ fallback: vi.fn(), ...hostExec }), respond)).toBe(true)
    s.state.now = 13_000
    s.g.settle(s.sock, 101, refused)
    expect(s.relayed).toHaveLength(1)
    expect(s.relayed[0]!.timeoutMs).toBe(18_000)
    expect(s.logs.find((l) => l.msg.startsWith('gateway: this host\'s Walnut server needs a leader'))?.data).toMatchObject({ timeoutMs: 18_000 })
  })

  it('with less than the floor left of the call\'s deadline, nothing is asked of the companion: held for the Mac, else the refusal stands', () => {
    // An older companion knows no limit of ours and would run the call past the moment this host gave up.
    for (const [held, now] of [[null, 31_000], [{ ok: true, result: { held: true } }, 31_000], [null, 31_000 - GATEWAY_MIN_RELAY_MS + 1]] as Array<[FollowerGatewayResponse | null, number]>) {
      const s = setup()
      s.state.companion = true
      s.state.held = held
      const respond = vi.fn()
      const fallback = vi.fn()
      expect(s.g.handOff(call({ fallback, ...hostExec }), respond)).toBe(true)
      s.state.now = now
      s.g.settle(s.sock, 101, refused)
      expect(s.relayed).toEqual([])
      expect(fallback).not.toHaveBeenCalled()
      expect(respond).toHaveBeenCalledWith(held ?? refused)
      expect(s.logs.find((l) => l.data?.why === 'no_time')).toBeTruthy()
      expect(s.g.ownAnswers().total).toBe(0)
    }
  })

  it('no link to the companion now: the follower\'s refusal stands, nothing relayed, nothing waits', () => {
    const { s, respond, fallback } = refusedWhileCompanionLeads(hostExec, false)
    expect(s.relayed).toEqual([])
    expect(fallback).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith(refused)
    expect(s.logs.find((l) => l.msg === 'gateway: this host\'s Walnut server\'s refusal stands')?.data).toMatchObject({ why: 'no_link', op: 'host_exec' })
  })

  it('a message nobody leading takes is held for the Mac, as the daemon holds it (its hold is refused to the follower while the companion leads)', () => {
    const held: FollowerGatewayResponse = { ok: true, result: { queued: true, seq: 7 } }
    const send = { payload: { name: 'task_send', args: { to: 't2', text: 'hi' } } }
    // The companion could not deliver it.
    const a = setup()
    a.state.companion = true
    a.state.held = held
    const respond = vi.fn()
    a.g.handOff(call({ fallback: vi.fn(), ...send }), respond)
    a.g.settle(a.sock, 101, refused)
    a.relayed[0]!.answer({ ok: false, error: { code: 'hub_unreachable', message: '"t2" has no running session; starting one needs the Walnut server' } })
    expect(a.holds.map((c) => c.payload.name)).toEqual(['task_send'])
    expect(respond).toHaveBeenCalledWith(held)
    // No link: held at once.
    const b = setup()
    b.state.companion = true
    b.state.companionLinked = false
    b.state.held = held
    const respondB = vi.fn()
    b.g.handOff(call({ fallback: vi.fn(), ...send }), respondB)
    b.g.settle(b.sock, 101, refused)
    expect(respondB).toHaveBeenCalledWith(held)
  })

  it('only a final needs_leader of a session\'s call: a plugin job\'s answer, a refusal that is not final, and a same-host send keep their ways', () => {
    // A plugin job's call (no fallback): the follower's answer is final.
    const job = setup()
    job.state.companion = true
    const respondJob = vi.fn()
    job.g.handOff(call({ callerSid: 'external', caller: { kind: 'plugin-job', plugin: 'acme', job: 'sync' } }), respondJob)
    job.g.settle(job.sock, 101, refused)
    expect(respondJob).toHaveBeenCalledWith(refused)
    expect(job.relayed).toEqual([])
    // Not final (no host key yet): the daemon's path, as before.
    const nf = setup()
    nf.state.companion = true
    const fallback = vi.fn()
    nf.g.handOff(call({ fallback }), vi.fn())
    nf.g.settle(nf.sock, 101, { ok: false, error: { code: 'needs_leader', message: 'no host key', detail: { why: 'no_host_key' } } })
    expect(fallback).toHaveBeenCalledOnce()
    expect(nf.relayed).toEqual([])
    // A same-host send handed while the leader answers: to the leader, as before.
    const on = setup()
    on.state.companion = true
    on.sock.answersOnline = true
    const relay = vi.fn()
    on.g.handOff(call({ payload: { name: 'task_send', args: { to: 't2', text: 'hi' } }, online: true, fallback: relay }), vi.fn())
    on.g.settle(on.sock, 101, refused)
    expect(relay).toHaveBeenCalledOnce()
    expect(on.relayed).toEqual([])
  })

  it('with no companion leading, a final refusal stands as before (no relay, no hold)', () => {
    const s = setup()
    const respond = vi.fn()
    s.g.handOff(call({ fallback: vi.fn(), ...hostExec }), respond)
    s.g.settle(s.sock, 101, refused)
    expect(respond).toHaveBeenCalledWith(refused)
    expect(s.relayed).toEqual([])
    expect(s.holds).toEqual([])
  })
})
