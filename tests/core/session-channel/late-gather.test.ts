/**
 * Late facts gathered into one go (session-channel/late-gather.ts): a backlog read back in bursts
 * fires once after it went quiet, or at its cap when it never pauses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLateGather } from '../../../src/core/session-channel/late-gather.js'

describe('createLateGather', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires once for a burst, after it went quiet, with every key once', () => {
    const fired: string[][] = []
    const g = createLateGather((keys) => fired.push([...keys]), { quietMs: 1_000, maxMs: 30_000 })
    for (let i = 0; i < 5; i++) { g.add('t1'); g.add(`t${i % 2 + 1}`); vi.advanceTimersByTime(500) }
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(fired).toEqual([['t1', 't2']])
    expect(g.size).toBe(0)
  })

  it('a backlog that never pauses still fires at its cap', () => {
    const fired: number[] = []
    const g = createLateGather((keys) => fired.push(keys.size), { quietMs: 1_000, maxMs: 3_000 })
    for (let i = 0; i < 10; i++) { g.add(`t${i}`); vi.advanceTimersByTime(400) }
    // Fired once at 3 s with what had come, then the rest gathers anew.
    expect(fired[0]).toBe(8)
    vi.advanceTimersByTime(1_000)
    expect(fired).toEqual([8, 2])
  })

  it('flush fires now; stop drops what was gathered', () => {
    const fired: string[][] = []
    const g = createLateGather((keys) => fired.push([...keys]))
    g.add('a')
    g.flush()
    g.add('b')
    g.stop()
    vi.advanceTimersByTime(60_000)
    expect(fired).toEqual([['a']])
  })
})
