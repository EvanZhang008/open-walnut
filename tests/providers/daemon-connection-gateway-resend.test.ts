/**
 * The server's half of a `walnut` call that a host's daemon sends again
 * (daemon-gateway-resend-twins-e2e.test.ts is the daemon's half).
 *
 * 2026-11-03: answers to clouddev's calls stopped arriving for two minutes while
 * its events still came in, so the ping loop (any byte heard counts) never called
 * the link dead, and each call failed after 20 s. Now a relay this run sees twice
 * runs once and is answered twice, and an answer the daemon does not ack in time,
 * with nothing else answered, starts a check that dials again: at once when nothing
 * at all is heard, after UPSTREAM_DEAD_MS while the host's bytes still come, never
 * while this Mac is still sending or on its own daemon, and at most once a while.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-gateway-resend-test'))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import * as router from '../../src/core/peers/capability-router.js'

type Internals = {
  handleGatewayRequest: (e: unknown) => Promise<void>
  _daemonInstanceId: string | null
  _connected: boolean
  ws: unknown
  bulkWs: unknown
  _lastReplyAt: number
  pendingCommands: Map<number, { bulk?: boolean }>
  dropSilentLink: (ws: unknown) => void
}

const UPSTREAM = { check: DaemonConnection.UPSTREAM_CHECK_MS, dead: DaemonConnection.UPSTREAM_DEAD_MS, gap: DaemonConnection.UPSTREAM_DROP_GAP_MS, round: DaemonConnection.UPSTREAM_MIN_ROUND_MS }
const relaysKept = () => (DaemonConnection as unknown as { gatewayRelays: Map<string, { reply: Promise<Record<string, unknown>> }> }).gatewayRelays
afterEach(() => {
  vi.restoreAllMocks()
  DaemonConnection.resetGatewayRelaysForTest()
  DaemonConnection.UPSTREAM_CHECK_MS = UPSTREAM.check
  DaemonConnection.UPSTREAM_DEAD_MS = UPSTREAM.dead
  DaemonConnection.UPSTREAM_DROP_GAP_MS = UPSTREAM.gap
  DaemonConnection.UPSTREAM_MIN_ROUND_MS = UPSTREAM.round
})

/** A relay as a daemon sends it; `instanceId` names its process (an older daemon names none). */
function relay(relayId: number, instanceId: string | null = 'd-1') {
  return { ev: 'gateway-request', relayId, ...(instanceId ? { instanceId } : {}), capability: 'tools.call', callerSid: 'sid-1', payload: { name: 'task_send', args: {} } }
}

describe('a relay the daemon sends again', () => {
  it('runs its op once and gets the same answer each time', async () => {
    const conn = new DaemonConnection('devbox', null)
    const c = conn as unknown as Internals
    const results: Array<Record<string, unknown>> = []
    let releaseAck: () => void = () => {}
    vi.spyOn(conn, 'send').mockImplementation((async (cmd: string, params: Record<string, unknown>) => {
      if (cmd === 'gateway-result') { results.push(params); if (results.length === 1) await new Promise<void>((r) => { releaseAck = r }) }
      return { ok: true }
    }) as never)
    let runs = 0
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async () => {
      runs += 1
      await new Promise((r) => setTimeout(r, 30))
      return { ok: true, result: { delivered: runs } }
    })
    // The resend arrives while the first is still running (its ack not in yet), and once more.
    const first = c.handleGatewayRequest(relay(7))
    await c.handleGatewayRequest(relay(7))
    await c.handleGatewayRequest(relay(7))
    releaseAck()
    await first
    expect(runs).toBe(1)
    expect(results).toEqual([
      { relayId: 7, result: { delivered: 1 } },
      { relayId: 7, result: { delivered: 1 } },
      { relayId: 7, result: { delivered: 1 } },
    ])
  })

  it('once the daemon took the answer, only a small word is kept for a resend still on its way', async () => {
    const conn = new DaemonConnection('devbox', null)
    const c = conn as unknown as Internals
    const results: Array<Record<string, unknown>> = []
    vi.spyOn(conn, 'send').mockImplementation((async (cmd: string, params: Record<string, unknown>) => { if (cmd === 'gateway-result') results.push(params); return { ok: true } }) as never)
    let runs = 0
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async () => { runs += 1; return { ok: true, result: { big: 'x'.repeat(10_000) } } })
    await c.handleGatewayRequest(relay(5))
    expect(await relaysKept().get('d-1:5')!.reply).toEqual({ relayId: 5, error: 'this relay was answered already', errorCode: 'internal' })
    await c.handleGatewayRequest(relay(5))
    expect(runs).toBe(1)
    expect(results[1]).toEqual({ relayId: 5, error: 'this relay was answered already', errorCode: 'internal' })
  })

  it('a resend on another connection to the same daemon still runs once', async () => {
    const a = new DaemonConnection('devbox', null)
    const b = new DaemonConnection('devbox-alias', null)
    for (const conn of [a, b]) vi.spyOn(conn, 'send').mockImplementation((async () => ({ ok: true })) as never)
    let runs = 0
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async () => { runs += 1; return { ok: true, result: {} } })
    await (a as unknown as Internals).handleGatewayRequest(relay(4))
    await (b as unknown as Internals).handleGatewayRequest(relay(4))
    expect(runs).toBe(1)
  })

  it('an answer the daemon refused (ok:false) is kept whole for its resend', async () => {
    const conn = new DaemonConnection('devbox', null)
    const c = conn as unknown as Internals
    vi.spyOn(conn, 'send').mockImplementation((async () => ({ ok: false, error: 'busy' })) as never)
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async () => ({ ok: true, result: { n: 1 } }))
    await c.handleGatewayRequest(relay(6))
    expect(await relaysKept().get('d-1:6')!.reply).toEqual({ relayId: 6, result: { n: 1 } })
  })

  it('the key is the instance the relay names, never the link\'s last hello', async () => {
    const conn = new DaemonConnection('devbox', null)
    const c = conn as unknown as Internals
    vi.spyOn(conn, 'send').mockImplementation((async () => ({ ok: true })) as never)
    let runs = 0
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async () => { runs += 1; return { ok: true, result: {} } })
    // A restarted daemon's relay 3 arrives before its hello updated the link: another call.
    c._daemonInstanceId = 'd-1'
    await c.handleGatewayRequest(relay(3, 'd-1'))
    await c.handleGatewayRequest(relay(3, 'd-2'))
    expect(runs).toBe(2)
    expect([...relaysKept().keys()]).toEqual(['d-1:3', 'd-2:3'])
  })

  it('a relay that names no instance (an older daemon, which never sends one twice) is not remembered', async () => {
    const conn = new DaemonConnection('devbox', null)
    const c = conn as unknown as Internals
    c._daemonInstanceId = 'd-1'
    vi.spyOn(conn, 'send').mockImplementation((async () => ({ ok: true })) as never)
    let runs = 0
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async () => { runs += 1; return { ok: true, result: {} } })
    await c.handleGatewayRequest(relay(3, null))
    await c.handleGatewayRequest(relay(3, null))
    expect(runs).toBe(2)
    expect(relaysKept().size).toBe(0)
  })
})

describe('an answer the daemon does not ack', () => {
  /** A fake link: `bytes` is what came in on it so far (the host's events), `sent` what went out. */
  function stalled(opts: { host?: string; pingAnswers?: boolean; incoming?: boolean; sending?: boolean } = {}) {
    DaemonConnection.UPSTREAM_CHECK_MS = 20
    DaemonConnection.UPSTREAM_MIN_ROUND_MS = 20
    const conn = new DaemonConnection(opts.host ?? 'devbox', null)
    const c = conn as unknown as Internals
    c._connected = true
    const socket = { bytesRead: 100, bytesWritten: 100 }
    const ws = { readyState: 1, _socket: socket }
    c.ws = ws
    const pings: number[] = []
    vi.spyOn(conn, 'send').mockImplementation(((cmd: string) => {
      if (cmd === 'ping') {
        pings.push(Date.now())
        // The host's events keep coming while the ping's answer does not; an upload keeps going out.
        if (opts.incoming) socket.bytesRead += 5_000
        if (opts.sending) socket.bytesWritten += 1_000_000
        return opts.pingAnswers ? Promise.resolve({ ok: true, pong: true }) : new Promise((_, reject) => setTimeout(() => reject(new Error('daemon command timeout: ping')), 5))
      }
      // The gateway-result's ack never comes.
      return new Promise(() => {})
    }) as never)
    const drop = vi.spyOn(c, 'dropSilentLink').mockImplementation(() => {})
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async () => ({ ok: true, result: {} }))
    return { conn, c, ws, pings, drop }
  }

  it('drops the link when a small command does not come back and nothing at all is heard', async () => {
    const { c, ws, pings, drop } = stalled()
    void c.handleGatewayRequest(relay(9))
    await vi.waitFor(() => expect(drop).toHaveBeenCalledTimes(1), { timeout: 2_000 })
    expect(drop).toHaveBeenCalledWith(ws)
    expect(pings.length).toBe(1)
  })

  it('while the host\'s bytes still come, it asks again and drops only once the answers stopped UPSTREAM_DEAD_MS', async () => {
    DaemonConnection.UPSTREAM_DEAD_MS = 400
    const { c, pings, drop } = stalled({ incoming: true })
    const t0 = Date.now()
    void c.handleGatewayRequest(relay(9))
    await vi.waitFor(() => expect(drop).toHaveBeenCalledTimes(1), { timeout: 3_000 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(pings.length).toBeGreaterThan(2)
  })

  it('never while this Mac is still sending (an upload on the link): the ping waits behind it', async () => {
    DaemonConnection.UPSTREAM_DEAD_MS = 300
    const { c, pings, drop } = stalled({ sending: true })
    void c.handleGatewayRequest(relay(9))
    await new Promise((r) => setTimeout(r, 600))
    expect(pings.length).toBeGreaterThan(1)
    expect(drop).not.toHaveBeenCalled()
  })

  it('never while a bulk command is in flight', async () => {
    DaemonConnection.UPSTREAM_DEAD_MS = 300
    const { c, drop } = stalled()
    c.pendingCommands.set(999, { bulk: true })
    void c.handleGatewayRequest(relay(9))
    await new Promise((r) => setTimeout(r, 600))
    expect(drop).not.toHaveBeenCalled()
  })

  it('never on the Mac\'s own daemon (no link between them dies half way)', async () => {
    const { c, pings, drop } = stalled({ host: '__local__' })
    void c.handleGatewayRequest(relay(9))
    await new Promise((r) => setTimeout(r, 150))
    expect(pings.length).toBe(0)
    expect(drop).not.toHaveBeenCalled()
  })

  it('at most once per UPSTREAM_DROP_GAP_MS: a reconnect\'s own backlog never starts a storm', async () => {
    const { c, drop } = stalled()
    void c.handleGatewayRequest(relay(9))
    await vi.waitFor(() => expect(drop).toHaveBeenCalledTimes(1), { timeout: 2_000 })
    void c.handleGatewayRequest(relay(10))
    await new Promise((r) => setTimeout(r, 200))
    expect(drop).toHaveBeenCalledTimes(1)
    DaemonConnection.UPSTREAM_DROP_GAP_MS = 0
    void c.handleGatewayRequest(relay(11))
    await vi.waitFor(() => expect(drop).toHaveBeenCalledTimes(2), { timeout: 2_000 })
  })

  it('a ping refused at once never spins the check: each round takes UPSTREAM_MIN_ROUND_MS', async () => {
    DaemonConnection.UPSTREAM_DEAD_MS = 1_000
    const { c, conn, pings } = stalled({ incoming: true })
    DaemonConnection.UPSTREAM_MIN_ROUND_MS = 200
    vi.spyOn(conn, 'send').mockImplementation(((cmd: string) => {
      if (cmd === 'ping') { pings.push(Date.now()); (c.ws as { _socket: { bytesRead: number } })._socket.bytesRead += 1; return Promise.reject(new Error('refused')) }
      return new Promise(() => {})
    }) as never)
    void c.handleGatewayRequest(relay(9))
    await new Promise((r) => setTimeout(r, 900))
    expect(pings.length).toBeGreaterThanOrEqual(2)
    expect(pings.length).toBeLessThanOrEqual(5)
  })

  it('keeps a link whose small command comes back (it is slow, not stuck)', async () => {
    const { c, pings, drop } = stalled({ pingAnswers: true })
    void c.handleGatewayRequest(relay(9))
    await vi.waitFor(() => expect(pings.length).toBe(1), { timeout: 2_000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(drop).not.toHaveBeenCalled()
  })

  it('keeps a link that answered anything else since the answer went out', async () => {
    const { c, pings, drop } = stalled()
    void c.handleGatewayRequest(relay(9))
    c._lastReplyAt = Date.now() + 5
    await new Promise((r) => setTimeout(r, 120))
    expect(pings.length).toBe(0)
    expect(drop).not.toHaveBeenCalled()
  })
})
