/**
 * An engine switch survives a server restart (2026-11-05, the user's switch read "Load failed"
 * while a deploy restarted Walnut): switchTaskEngine (web/src/api/engine-switch.ts) tries a
 * request that got no answer again under the same op id until the server is back, so the
 * server's op-id ledger applies the pick once, and a retry that finds the earlier attempt took
 * effect reads as that. A refusal the server gave on the first attempt stays a refusal.
 *
 * The real web client over a stubbed fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OP_ID_HEADER } from '../../web/src/api/op-id'
import { switchTaskEngine, SWITCH_RETRY_TOTAL_MS } from '../../web/src/api/engine-switch'

type Answer = { status: number; body: unknown } | 'network'

let calls: Array<{ url: string; opId: string | undefined }>
let answers: Answer[]

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  answers = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({ url, opId: headers[OP_ID_HEADER] })
    const a = answers.shift() ?? 'network'
    // WebKit's words for a fetch whose connection went away.
    if (a === 'network') throw new TypeError('Load failed')
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function settle<T>(p: Promise<T>): Promise<{ ok: T } | { err: unknown }> {
  const out = p.then((ok) => ({ ok }), (err) => ({ err }))
  for (let i = 0; i < 200; i++) await vi.advanceTimersByTimeAsync(1000)
  return out
}

const URL = '/api/v1/tasks/t1/switch-engine'

describe('an engine switch across a server restart', () => {
  it('two lost connections, then the server answers: three attempts under one op id', async () => {
    answers.push('network', 'network', { status: 200, body: { state: 'done', taskId: 't1', sessionId: 'pi-1' } })
    const r = await settle(switchTaskEngine('t1', { engine: 'pi' }))
    expect(r).toEqual({ ok: { state: 'done', taskId: 't1', sessionId: 'pi-1' } })
    expect(calls.map((c) => c.url)).toEqual([URL, URL, URL])
    expect(new Set(calls.map((c) => c.opId)).size).toBe(1)
    expect(calls[0]!.opId).toMatch(/^op-[0-9a-f]{16}$/)
  })

  it('the first attempt took effect before the restart: the retry\'s same_engine reads as done', async () => {
    answers.push('network', { status: 400, body: { error: 'This task already runs on Pi', code: 'same_engine' } })
    expect(await settle(switchTaskEngine('t1', { engine: 'pi' }))).toEqual({ ok: { state: 'done', taskId: 't1' } })
  })

  it('the first attempt still runs: the retry\'s switch_in_progress reads as switching', async () => {
    answers.push('network', { status: 409, body: { error: 'switching', code: 'switch_in_progress' } })
    expect(await settle(switchTaskEngine('t1', { engine: 'pi' }))).toEqual({ ok: { state: 'switching', taskId: 't1' } })
  })

  it('a refusal on the first attempt stays a refusal, with no retry', async () => {
    answers.push({ status: 400, body: { error: 'This task already runs on Pi', code: 'same_engine' } })
    const r = await settle(switchTaskEngine('t1', { engine: 'pi' }))
    expect('err' in r && (r.err as { body?: { code?: string } }).body?.code).toBe('same_engine')
    expect(calls).toHaveLength(1)
  })

  it('a server that never comes back: it gives up within 90 seconds of the pick, with the network error', async () => {
    const t0 = Date.now()
    const at: number[] = []
    vi.mocked(fetch).mockImplementation(async () => { at.push(Date.now() - t0); throw new TypeError('Load failed') })
    const r = await settle(switchTaskEngine('t1', { engine: 'pi' }))
    expect('err' in r && r.err).toBeInstanceOf(TypeError)
    expect(at.length).toBeGreaterThan(5)
    // One deadline for the whole switch: no attempt starts after it.
    expect(Math.max(...at)).toBeLessThan(SWITCH_RETRY_TOTAL_MS)
    expect(SWITCH_RETRY_TOTAL_MS).toBe(90_000)
  })
})
