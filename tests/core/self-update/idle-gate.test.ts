/**
 * The idle gate a live update restarts behind (src/core/self-update/idle-gate.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  IDLE_MS, MAX_TURN_WAIT_MS, idleMsFrom, judgeIdle, lastUserActivity, latestSampleEnd, noteUserActivity, resetUserActivityForTest,
} from '../../../src/core/self-update/idle-gate.js'

const T0 = 1_800_000_000_000

beforeEach(() => resetUserActivityForTest())

describe('noteUserActivity', () => {
  it('keeps the latest time, never moves back, and counts a future time as now', () => {
    expect(lastUserActivity()).toBeNull()
    noteUserActivity(T0, T0 + 10)
    noteUserActivity(T0 - 5_000, T0 + 10)
    expect(lastUserActivity()).toBe(T0)
    noteUserActivity(T0 + 3_600_000, T0 + 20) // a client clock an hour ahead
    expect(lastUserActivity()).toBe(T0 + 20)
    noteUserActivity(Number.NaN)
    expect(lastUserActivity()).toBe(T0 + 20)
  })

  it('a heartbeat batch ends at its latest window end', () => {
    expect(latestSampleEnd([])).toBeNull()
    expect(latestSampleEnd([
      { ts: new Date(T0).toISOString(), durationMs: 30_000 },
      { ts: new Date(T0 + 10_000).toISOString(), durationMs: 5_000 },
      { ts: 'not a time', durationMs: 1 },
    ])).toBe(T0 + 30_000)
  })
})

describe('judgeIdle', () => {
  const base = { now: T0, lastActivity: null as number | null, sinceMs: T0, turnsRunning: 0, waitingSinceMs: null as number | null }

  it('person activity: ready only after IDLE_MS of nothing', () => {
    expect(judgeIdle({ ...base, lastActivity: T0 - IDLE_MS + 1 })).toMatchObject({ ready: false, userIdleMs: IDLE_MS - 1 })
    expect(judgeIdle({ ...base, lastActivity: T0 - IDLE_MS })).toMatchObject({ ready: true, userIdleMs: IDLE_MS })
  })

  it('nothing seen since the server started: idleness counts from the start', () => {
    expect(judgeIdle({ ...base, sinceMs: T0 - 1_000 })).toMatchObject({ ready: false, userIdleMs: null })
    expect(judgeIdle({ ...base, sinceMs: T0 - IDLE_MS })).toMatchObject({ ready: true, userIdleMs: null })
  })

  it('a running turn holds it, until the install has waited MAX_TURN_WAIT_MS', () => {
    const away = { ...base, lastActivity: T0 - 2 * IDLE_MS, turnsRunning: 1 }
    expect(judgeIdle({ ...away, waitingSinceMs: T0 - MAX_TURN_WAIT_MS + 1 })).toMatchObject({ ready: false, turnsRunning: 1 })
    const waited = judgeIdle({ ...away, waitingSinceMs: T0 - MAX_TURN_WAIT_MS })
    expect(waited).toMatchObject({ ready: true, waitingSince: new Date(T0 - MAX_TURN_WAIT_MS).toISOString() })
    // The wait never lets it restart over a person who is there.
    expect(judgeIdle({ ...away, lastActivity: T0, waitingSinceMs: T0 - MAX_TURN_WAIT_MS }).ready).toBe(false)
  })

  it('the env override takes a positive number of milliseconds only', () => {
    expect(idleMsFrom({})).toBe(IDLE_MS)
    expect(idleMsFrom({ WALNUT_UPDATE_IDLE_MS: '5000' })).toBe(5000)
    expect(idleMsFrom({ WALNUT_UPDATE_IDLE_MS: '0' })).toBe(IDLE_MS)
    expect(idleMsFrom({ WALNUT_UPDATE_IDLE_MS: 'soon' })).toBe(IDLE_MS)
    expect(judgeIdle({ ...base, lastActivity: T0 - 5000, idleMs: 5000 }).ready).toBe(true)
  })
})
