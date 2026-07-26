/**
 * Per-session bounding for the health monitor tick.
 *
 * Two gaps this covers, both of which produced multi-second (and once 11 s)
 * ticks in production:
 *
 *   1. The tick budget was only consulted BETWEEN phases, never inside the
 *      per-session loops. One slow session — or simply a large scan set — ran
 *      the loop arbitrarily past the budget, and the next tick then stacked
 *      behind it ("previous still running").
 *   2. `await runner.isBackgroundWorkActive(id)` reaches a daemon RPC whose own
 *      timeout is COMMAND_TIMEOUT_MS = 30 s. Serial across sessions on a host in
 *      the stale-connection window, that is unbounded from the tick's point of
 *      view. It must be raced against a per-session ceiling, and the timeout
 *      answer must be the SAFE one (assume busy), never "idle" — the idle branch
 *      kills the session.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { probeWithTimeout } from '../../src/core/session-health-monitor.js'
import { log } from '../../src/logging/index.js'

afterEach(() => {
  delete process.env.WALNUT_HEALTH_PROBE_TIMEOUT_MS
  vi.restoreAllMocks()
})

describe('probeWithTimeout', () => {
  it('returns the real answer when the probe resolves in time', async () => {
    expect(await probeWithTimeout(Promise.resolve(false), true, 'p', 's1')).toBe(false)
    expect(await probeWithTimeout(Promise.resolve(true), false, 'p', 's1')).toBe(true)
  })

  it('passes a synchronous answer straight through (no timer, no await hop)', async () => {
    // isBackgroundWorkActive is declared `boolean | Promise<boolean>` and the
    // common case is the cheap synchronous short-circuit. It must not pay a timer.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    expect(await probeWithTimeout(false, true, 'p', 's1')).toBe(false)
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('falls back to the SAFE default when the probe outlives the ceiling', async () => {
    process.env.WALNUT_HEALTH_PROBE_TIMEOUT_MS = '20'
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    // A probe that never settles — the shape of a daemon RPC to a stale tunnel.
    const stuck = new Promise<boolean>(() => {})

    const t0 = Date.now()
    // fallback=true means "assume busy", which is what keeps the idle path from
    // reaping a live session on a merely-slow host.
    const answer = await probeWithTimeout(stuck, true, 'isBackgroundWorkActive', 'sess-a')
    const elapsed = Date.now() - t0

    expect(answer).toBe(true)
    expect(elapsed).toBeLessThan(2_000) // bounded, not the daemon's 30 s
    const timedOut = warn.mock.calls.filter(
      (c) => c[0] === 'health monitor: per-session probe timed out — assuming safe default',
    )
    expect(timedOut).toHaveLength(1)
    expect((timedOut[0][1] as Record<string, unknown>).sessionId).toBe('sess-a')
  })

  it('N stuck sessions cost N × ceiling, not N × the daemon timeout', async () => {
    process.env.WALNUT_HEALTH_PROBE_TIMEOUT_MS = '20'
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const t0 = Date.now()
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await probeWithTimeout(new Promise<boolean>(() => {}), true, 'probe', id)
    }
    // 5 × 20ms ≈ 100ms. Unbounded would have been 5 × 30_000.
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('a rejecting probe yields the fallback, not a throw', async () => {
    vi.spyOn(log.session, 'debug').mockImplementation(() => {})
    const answer = await probeWithTimeout(
      Promise.reject(new Error('daemon gone')), true, 'probe', 'sess-b',
    )
    expect(answer).toBe(true)
  })

  it('a probe that rejects AFTER losing the race does not become an unhandled rejection', async () => {
    process.env.WALNUT_HEALTH_PROBE_TIMEOUT_MS = '10'
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      const late = new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('late daemon failure')), 40),
      )
      expect(await probeWithTimeout(late, true, 'probe', 'sess-c')).toBe(true)
      await new Promise((r) => setTimeout(r, 120)) // let the loser settle + macrotask drain
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('a falsy-but-real answer is not mistaken for a timeout', async () => {
    // The sentinel exists precisely so `undefined` / `false` from the probe are
    // returned as-is instead of collapsing into the fallback.
    expect(await probeWithTimeout<boolean | undefined>(
      Promise.resolve(undefined), true, 'probe', 'sess-d',
    )).toBeUndefined()
  })

  it('ignores a garbage timeout override rather than disabling the ceiling', async () => {
    process.env.WALNUT_HEALTH_PROBE_TIMEOUT_MS = 'not-a-number'
    // Falls back to the 5 s default: a fast probe still resolves normally.
    expect(await probeWithTimeout(Promise.resolve(false), true, 'probe', 'sess-e')).toBe(false)
  })
})
