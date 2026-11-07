/**
 * A relayed call's deadline reaches the work that holds its answer (src/lib/answer-by.ts).
 *
 * 2026-11-03: host_exec from a session on another host came back `hub_timeout` at exactly
 * 20 s, the host gateway's limit, with no job id. host_exec held a relayed answer 14 s from
 * its own start, but the way in (the relay frame, the op executor's loopback call, the
 * route) and the way back were not counted, and on a loaded Mac they took the rest. Now:
 * the server notes when a relay reached it (DaemonConnection.handleGatewayRequest), the op
 * executor's self-call carries that deadline as a header, and the route runs its work in
 * that scope (tests/e2e/host-exec-e2e.test.ts covers the route and the hold).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-answer-by-test'))

import { ANSWER_BY_HEADER, ambientAnswerBy, answerByHeader, parseAnswerBy, withAnswerBy } from '../../src/lib/answer-by.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { gatewayHubTimeoutMs } from '../../src/providers/gateway-core.js'
import * as router from '../../src/core/peers/capability-router.js'
import '../../src/ops/index.js'

afterEach(() => { vi.restoreAllMocks() })

describe('the deadline scope', () => {
  it('reads a sane header only, and an inner scope can only be earlier', async () => {
    const now = 1_800_000_000_000
    expect(parseAnswerBy(String(now + 20_000), now)).toBe(now + 20_000)
    expect(parseAnswerBy([String(now + 5_000)], now)).toBe(now + 5_000)
    for (const bad of [undefined, '', 'soon', '-1', String(now + 60 * 60_000), String(now - 5 * 60_000), '1e15']) {
      expect(parseAnswerBy(bad, now)).toBeUndefined()
    }
    expect(ambientAnswerBy()).toBeUndefined()
    expect(answerByHeader()).toEqual({})
    await withAnswerBy(now + 20_000, async () => {
      await new Promise((r) => setTimeout(r, 1))
      expect(ambientAnswerBy()).toBe(now + 20_000)
      expect(answerByHeader()).toEqual({ [ANSWER_BY_HEADER]: String(now + 20_000) })
      withAnswerBy(now + 30_000, () => expect(ambientAnswerBy()).toBe(now + 20_000))
      withAnswerBy(now + 10_000, () => expect(ambientAnswerBy()).toBe(now + 10_000))
      withAnswerBy(undefined, () => expect(ambientAnswerBy()).toBe(now + 20_000))
    })
  })

  it('ends with its call: a timer or a socket made inside it sees no deadline afterwards', async () => {
    const at = Date.now() + 20_000
    let later: number | undefined | null = null
    let inner: number | undefined | null = null
    await withAnswerBy(at, async () => {
      // A long-lived thing made during the call (a link dialled for it, a reconnect timer).
      setTimeout(() => {
        later = ambientAnswerBy()
        // A new relay handled in that leftover context gets its own deadline, not the stale one.
        withAnswerBy(at + 5_000, () => { inner = ambientAnswerBy() })
      }, 30)
      await new Promise((r) => setTimeout(r, 1))
      expect(ambientAnswerBy()).toBe(at)
    })
    // The leftover timer has run once it set `inner`.
    await vi.waitFor(() => expect(inner).toBe(at + 5_000), { timeout: 10_000, interval: 10 })
    expect(later).toBeUndefined()
    // A synchronous scope ends when it returns; a throwing one too.
    let leaked: (() => number | undefined) | null = null
    withAnswerBy(at, () => { leaked = () => ambientAnswerBy() })
    expect(leaked!()).toBeUndefined()
    expect(() => withAnswerBy(at, () => { throw new Error('boom') })).toThrow('boom')
  })

  it('a fresh scope keeps only its own deadline, though made while another call still runs', async () => {
    const a = Date.now() + 5_000
    const seen: Array<number | undefined> = []
    await withAnswerBy(a, async () => {
      // Request B, handled in the context of a link call A dialled, while A is still open.
      seen.push(withAnswerBy(a + 15_000, () => ambientAnswerBy(), { fresh: true }))
      seen.push(withAnswerBy(undefined, () => ambientAnswerBy(), { fresh: true }))
      // A nested step of A itself still keeps the earlier deadline.
      seen.push(withAnswerBy(a + 15_000, () => ambientAnswerBy()))
    })
    expect(seen).toEqual([a + 15_000, undefined, a])
  })

  it('the op executor\'s self-call carries it, and only inside the scope', async () => {
    const seen: Array<string | undefined> = []
    const server = http.createServer((req, res) => {
      const v = req.headers[ANSWER_BY_HEADER]
      seen.push(Array.isArray(v) ? v[0] : v)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ host: 'devbox', jobs: [] }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      const by = Date.now() + 20_000
      const opts = { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: 'sid-1' }
      expect((await withAnswerBy(by, () => executeOp('host_exec_list', { host: 'devbox' }, opts))).ok).toBe(true)
      expect((await executeOp('host_exec_list', { host: 'devbox' }, opts)).ok).toBe(true)
      expect(seen).toEqual([String(by), undefined])
    } finally {
      server.close()
    }
  })
})

describe('a relay from a host daemon', () => {
  it('runs its op in a scope that ends when the host\'s gateway gives up', async () => {
    const conn = new DaemonConnection('__local__', null)
    const sent: Array<[string, Record<string, unknown>]> = []
    vi.spyOn(conn, 'send').mockImplementation((async (cmd: string, params: Record<string, unknown>) => { sent.push([cmd, params]); return { ok: true } }) as never)
    let scope: number | undefined
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      scope = ambientAnswerBy()
      return { ok: true, result: { done: true } }
    })
    const before = Date.now()
    // Handled in the context of an earlier call that is still running (its link was dialled there):
    // that call's nearer deadline is not this relay's.
    await withAnswerBy(before + 1_000, () => (conn as unknown as { handleGatewayRequest: (e: unknown) => Promise<void> }).handleGatewayRequest({
      ev: 'gateway-request', relayId: 7, capability: 'tools.call', callerSid: 'sid-1', payload: { name: 'host_exec', args: {} },
    }))
    const after = Date.now()
    expect(scope).toBeGreaterThanOrEqual(before + gatewayHubTimeoutMs())
    expect(scope).toBeLessThanOrEqual(after + gatewayHubTimeoutMs())
    expect(sent.find(([cmd]) => cmd === 'gateway-result')?.[1]).toMatchObject({ relayId: 7, result: { done: true } })
    // Nothing of it outlives the relay.
    expect(ambientAnswerBy()).toBeUndefined()
  })
})
