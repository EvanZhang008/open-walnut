/**
 * The bridge push backoff (src/providers/bridge-push-retry.ts): 10 s, 20 s, 40 s, 80 s after a
 * refused or failed push, then nothing (the 5-minute tick carries it), one retry waiting at a
 * time, reset by a push that went through and cleared when the connection closes.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { BRIDGE_RETRY_DELAYS_MS, BridgePushRetry } from '../../src/providers/bridge-push-retry.js'

describe('BridgePushRetry', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('retries after 10, 20, 40 and 80 s, then schedules nothing more', () => {
    expect(BRIDGE_RETRY_DELAYS_MS).toEqual([10_000, 20_000, 40_000, 80_000])
    const at: number[] = []
    const start = Date.now()
    const retry = new BridgePushRetry(() => { at.push(Date.now() - start); retry.failed() })
    retry.failed()
    vi.advanceTimersByTime(10 * 60_000)
    expect(at).toEqual([10_000, 30_000, 70_000, 150_000])
    expect(retry.pending).toBe(false)
    retry.failed() // spent: the tick carries it from here
    expect(retry.pending).toBe(false)
  })

  it('a failure while one retry waits adds no second one', () => {
    const fired = vi.fn()
    const retry = new BridgePushRetry(fired)
    retry.failed()
    retry.failed()
    retry.failed()
    vi.advanceTimersByTime(10_000)
    expect(fired).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10 * 60_000)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('a push that went through cancels the waiting retry and starts the next failure from 10 s', () => {
    const fired = vi.fn()
    const retry = new BridgePushRetry(fired)
    retry.failed()
    vi.advanceTimersByTime(10_000) // first retry
    retry.failed() // the 20 s one waits
    retry.succeeded()
    expect(retry.pending).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(fired).toHaveBeenCalledTimes(1)
    retry.failed()
    vi.advanceTimersByTime(9_999)
    expect(fired).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledTimes(2)
  })

  it('clear (the connection closed) drops the waiting retry and the count', () => {
    const fired = vi.fn()
    const retry = new BridgePushRetry(fired)
    for (let i = 0; i < 4; i++) { retry.failed(); vi.advanceTimersByTime(80_000) }
    expect(fired).toHaveBeenCalledTimes(4)
    retry.failed()
    expect(retry.pending).toBe(false)
    retry.clear()
    retry.failed()
    expect(retry.pending).toBe(true)
    retry.clear()
    vi.advanceTimersByTime(60_000)
    expect(fired).toHaveBeenCalledTimes(4)
  })
})
