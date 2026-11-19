/**
 * The daemon's hand-off of a host's `walnut` calls to its own Walnut server while the leader
 * is away (follower-gateway-core.ts): who gets a call, what comes back, and when the
 * daemon's own away answer takes over. Both twins run this same core (daemon-source.ts
 * inlines it); tests/providers/follower-gateway-twins.test.ts holds the wiring alike.
 */
import { describe, expect, it, vi } from 'vitest'
import { createFollowerGateway, type FollowerGatewayResponse } from '../../src/providers/follower-gateway-core.js'

interface Sock { name: string; answersLocal: boolean; sent: Array<{ ev: string; data: Record<string, unknown> }>; broken?: boolean }

function setup(o: { linked?: Sock | null } = {}) {
  const sock: Sock = { name: 'follower', answersLocal: true, sent: [] }
  const linked = o.linked === undefined ? sock : o.linked
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  let id = 100
  /** Whether the follower may write (the twin's followerMayWrite), and the clock. */
  const state = { mayWrite: true, now: 1_000 }
  const g = createFollowerGateway<Sock>({
    follower: () => (linked && linked.answersLocal ? linked : null),
    mayWrite: () => state.mayWrite,
    now: () => state.now,
    send: (ws, ev, data) => { if (ws.broken) return false; ws.sent.push({ ev, data }); return true },
    nextRelayId: () => ++id,
    instanceId: 'inst-1',
    attemptMs: (deadline) => deadline - 1_000,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true },
    log: () => {},
  })
  // The timers set so far only: one a fired timer sets fires on the next call.
  const fire = () => { for (const t of [...timers]) if (!t.cleared) { t.cleared = true; t.fn() } }
  return { g, sock, timers, fire, state }
}

const call = (over: Record<string, unknown> = {}) => ({ home: '/h', capability: 'tools.call', callerSid: 'sess-1', payload: { name: 'task_update', args: { id: 't1' } }, deadline: 31_000, ...over })

describe('follower gateway', () => {
  it('no follower linked, or one that does not answer local calls: nothing is sent and the caller goes on', () => {
    expect(setup({ linked: null }).g.handOff(call(), vi.fn())).toBe(false)
    const quiet: Sock = { name: 'f', answersLocal: false, sent: [] }
    const s = setup({ linked: quiet })
    expect(s.g.answers('/h')).toBe(false)
    expect(s.g.handOff(call(), vi.fn())).toBe(false)
    expect(quiet.sent).toEqual([])
  })

  it('a write the socket refused was never sent: false, nothing pending', () => {
    const s = setup()
    s.sock.broken = true
    expect(s.g.handOff(call(), vi.fn())).toBe(false)
    expect(s.g.pendingCount()).toBe(0)
  })

  it('a linked follower gets the gateway-request, a plugin job named; its answer is the caller\'s', () => {
    const s = setup()
    const respond = vi.fn()
    expect(s.g.handOff(call({ callerSid: 'external', caller: { kind: 'plugin-job', plugin: 'acme', job: 'sync' } }), respond)).toBe(true)
    expect(s.sock.sent).toEqual([{ ev: 'gateway-request', data: {
      relayId: 101, instanceId: 'inst-1', capability: 'tools.call', callerSid: 'external',
      payload: { name: 'task_update', args: { id: 't1' } }, caller: { kind: 'plugin-job', plugin: 'acme', job: 'sync' },
    } }])
    expect(s.timers[0]!.ms).toBe(30_000)
    expect(s.g.holds(101)).toBe(true)
    expect(s.g.settle(s.sock, 101, { ok: true, result: { ok: 1 } })).toBe('ok')
    expect(respond).toHaveBeenCalledWith({ ok: true, result: { ok: 1 } })
    expect(s.timers[0]!.cleared).toBe(true)
    expect(s.g.settle(s.sock, 101, { ok: true, result: {} })).toBe('stale')
  })

  it('a session\'s call handed back (needs_leader, unsupported) takes the daemon\'s own path; a plugin job\'s answer is final', () => {
    for (const code of ['needs_leader', 'unsupported_replica', 'unsupported_version']) {
      const s = setup()
      const respond = vi.fn()
      const fallback = vi.fn()
      s.g.handOff(call({ fallback }), respond)
      s.g.settle(s.sock, 101, { ok: false, error: { code, message: 'no' } })
      expect(fallback).toHaveBeenCalledOnce()
      expect(respond).not.toHaveBeenCalled()
    }
    const s = setup()
    const respond = vi.fn()
    s.g.handOff(call({ callerSid: 'external', caller: { kind: 'plugin-job', plugin: 'acme', job: 'sync' } }), respond)
    const refused: FollowerGatewayResponse = { ok: false, error: { code: 'needs_leader', message: 'needs your Mac' } }
    s.g.settle(s.sock, 101, refused)
    expect(respond).toHaveBeenCalledWith(refused)
  })

  it('an error that is no hand-back goes to the caller as it is, never to the daemon\'s path', () => {
    const s = setup()
    const respond = vi.fn()
    const fallback = vi.fn()
    s.g.handOff(call({ fallback }), respond)
    s.g.settle(s.sock, 101, { ok: false, error: { code: 'bad_request', message: 'bad id' } })
    expect(fallback).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith({ ok: false, error: { code: 'bad_request', message: 'bad id' } })
  })

  it('no answer in time: a read takes the daemon\'s path, a write is hub_timeout (it may have run, never twice)', () => {
    const read = setup()
    const readFallback = vi.fn()
    read.g.handOff(call({ payload: { name: 'task_get' }, readable: true, fallback: readFallback }), vi.fn())
    read.fire()
    expect(readFallback).toHaveBeenCalledOnce()
    const write = setup()
    const respond = vi.fn()
    const writeFallback = vi.fn()
    write.g.handOff(call({ fallback: writeFallback }), respond)
    write.fire()
    expect(writeFallback).not.toHaveBeenCalled()
    expect(respond.mock.calls[0]![0]).toMatchObject({ ok: false, error: { code: 'hub_timeout' } })
    expect(write.g.pendingCount()).toBe(0)
  })

  it('only the socket it was sent to answers it; a closed socket ends what it held', () => {
    const s = setup()
    const respond = vi.fn()
    s.g.handOff(call(), respond)
    expect(s.g.settle({ name: 'other', answersLocal: true, sent: [] }, 101, { ok: true, result: {} })).toBe('wrong_socket')
    expect(respond).not.toHaveBeenCalled()
    s.g.dropSocket(s.sock)
    expect(respond.mock.calls[0]![0]).toMatchObject({ error: { code: 'hub_timeout' } })
  })

  it('a gateway-result\'s fields as the caller\'s answer', () => {
    const { g } = setup()
    expect(g.responseOf({ result: { a: 1 } })).toEqual({ ok: true, result: { a: 1 } })
    expect(g.responseOf({ error: 'x', errorCode: 'needs_leader', detail: { why: 'w', retryAfterMs: 5000 }, api: { status: 503 } }))
      .toEqual({ ok: false, error: { code: 'needs_leader', message: 'x', detail: { why: 'w', retryAfterMs: 5000 }, retryAfterMs: 5000, api: { status: 503 } } })
    expect(g.responseOf({})).toEqual({ ok: false, error: { code: 'internal', message: 'gateway request failed' } })
  })

  it('one rule for "away": a follower that may not write yet takes no call, and a session\'s goes its own way', () => {
    const s = setup()
    s.state.mayWrite = false
    expect(s.g.answers('/h')).toBe(false)
    expect(s.g.handOff(call(), vi.fn())).toBe(false)
    expect(s.sock.sent).toEqual([])
    s.state.mayWrite = true
    expect(s.g.answers('/h')).toBe(true)
  })

  it('a plugin job\'s call in that window waits: handed over once the follower may write', () => {
    const s = setup()
    s.state.mayWrite = false
    const respond = vi.fn()
    const job = call({ callerSid: 'external', caller: { kind: 'plugin-job', plugin: 'acme-sync', job: 'poll' } })
    let again = 0
    const route = (waited: boolean): string => s.g.routeJob(job, respond, () => { again++; route(true) }, waited)
    expect(route(false)).toBe('waiting')
    expect(s.sock.sent).toEqual([])
    s.fire()
    expect(again).toBe(1)
    expect(s.sock.sent).toEqual([])
    s.state.mayWrite = true
    s.fire()
    expect(s.sock.sent.map((x) => x.ev)).toEqual(['gateway-request'])
    expect(respond).not.toHaveBeenCalled()
  })

  it('a plugin job\'s waiting call routed afresh goes elsewhere when the leader answers again; no time left or no follower: none', () => {
    const s = setup()
    s.state.mayWrite = false
    const job = call({ callerSid: 'external', caller: { kind: 'plugin-job', plugin: 'acme-sync', job: 'poll' } })
    let routedAgain = 0
    expect(s.g.routeJob(job, vi.fn(), () => { routedAgain++ })).toBe('waiting')
    s.fire()
    // The twin routes it afresh: its leader target found, it relays there and never asks the follower.
    expect(routedAgain).toBe(1)
    expect(s.sock.sent).toEqual([])
    s.state.now = job.deadline - 1_000
    expect(s.g.routeJob(job, vi.fn(), () => {})).toBe('none')
    expect(setup({ linked: null }).g.routeJob(job, vi.fn(), () => {})).toBe('none')
  })
})
