/**
 * Presence events for in-process subscribers (src/core/time-tracking/presence-events.ts).
 *
 *   - `time:banked` carries the accepted human records, never agent-lane ones, and
 *     is emitted with NO destinations: global subscribers (plugin events.on) get
 *     it, the browser's destination-gated 'web-ui' subscriber does not.
 *   - `time:outside` is throttled to one event per 30s: the first sample after a
 *     quiet stretch goes out at once, later ones are summed, and a trailing timer
 *     sends the tail when the window closes (so walking away never loses it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import {
  emitTimeBanked, noteOutsideAttention, OUTSIDE_EMIT_MS, resetPresenceEvents,
} from '../../../src/core/time-tracking/presence-events.js'
import type { TimeBankedEvent, TimeOutsideEvent } from '../../../src/core/event-types.js'

let global: Array<{ name: string; data: unknown }> = []
let webUi: string[] = []

beforeEach(() => {
  resetPresenceEvents()
  global = []
  webUi = []
  bus.subscribe('presence-plugin', (e) => { global.push({ name: e.name, data: e.data }) }, { global: true, interest: ['time:'] })
  bus.subscribe('web-ui', (e) => { webUi.push(e.name) })
})

afterEach(() => {
  bus.unsubscribe('presence-plugin')
  bus.unsubscribe('web-ui')
  resetPresenceEvents()
  vi.useRealTimers()
})

describe('time:banked', () => {
  it('announces human records only, to in-process subscribers only', () => {
    emitTimeBanked([
      { date: '2026-09-25', ts: '2026-09-25T10:00:00.000Z', durationMs: 60_000, kind: 'session', taskId: 't1', sessionId: 's1' },
      { date: '2026-09-25', ts: '2026-09-25T10:01:00.000Z', durationMs: 30_000, kind: 'chat', source: 'ios' },
      { date: '2026-09-25', ts: '2026-09-25T10:02:00.000Z', durationMs: 90_000, kind: 'agent', taskId: 't1' },
    ])
    expect(global).toHaveLength(1)
    expect(global[0].name).toBe(EventNames.TIME_BANKED)
    expect((global[0].data as TimeBankedEvent).records).toEqual([
      { ts: '2026-09-25T10:00:00.000Z', durationMs: 60_000, kind: 'session', taskId: 't1', sessionId: 's1' },
      { ts: '2026-09-25T10:01:00.000Z', durationMs: 30_000, kind: 'chat', source: 'ios' },
    ])
    expect(webUi).toEqual([])
  })

  it('stays silent for an all-agent or empty batch', () => {
    emitTimeBanked([])
    emitTimeBanked([{ date: '2026-09-25', ts: '2026-09-25T10:00:00.000Z', durationMs: 1, kind: 'agent' }])
    expect(global).toEqual([])
  })
})

describe('time:outside throttle', () => {
  it('sends the first sample at once, sums the window, and flushes the tail on a timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const at = (s: number) => new Date(Date.UTC(2026, 8, 25, 10, 0, s)).toISOString()

    noteOutsideAttention({ ts: at(0), durationMs: 5_000, bundleId: 'com.apple.Terminal', idleSecs: 1 })
    expect(global).toHaveLength(1)
    expect(global[0].data).toEqual({ ts: at(0), durationMs: 5_000, bundleId: 'com.apple.Terminal', idleSecs: 1 })

    // Five more 5s samples inside the window: nothing goes out yet.
    for (let i = 1; i <= 5; i++) {
      await vi.advanceTimersByTimeAsync(5_000)
      noteOutsideAttention({ ts: at(i * 5), durationMs: 5_000, bundleId: i === 5 ? 'com.google.Chrome' : 'com.apple.Terminal', idleSecs: i })
    }
    expect(global).toHaveLength(1)

    // The window closes: ONE event with the sum, the first window's start, the latest sample's fields.
    await vi.advanceTimersByTimeAsync(OUTSIDE_EMIT_MS)
    expect(global).toHaveLength(2)
    expect(global[1].data as TimeOutsideEvent).toEqual({
      ts: at(5), durationMs: 25_000, bundleId: 'com.google.Chrome', idleSecs: 5,
    })
    expect(webUi).toEqual([])
  })

  it('never emits more than one event per window, over a long stretch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    for (let i = 0; i < 60; i++) { // 5 minutes of 5s samples
      noteOutsideAttention({ ts: new Date().toISOString(), durationMs: 5_000 })
      await vi.advanceTimersByTimeAsync(5_000)
    }
    await vi.advanceTimersByTimeAsync(OUTSIDE_EMIT_MS)
    const total = global.reduce((sum, e) => sum + (e.data as TimeOutsideEvent).durationMs, 0)
    expect(total).toBe(300_000) // nothing lost to the throttle
    expect(global.length).toBeLessThanOrEqual(11) // 300s / 30s, plus the leading edge
  })

  it('ignores a zero-length sample', () => {
    noteOutsideAttention({ ts: new Date().toISOString(), durationMs: 0 })
    expect(global).toEqual([])
  })
})
