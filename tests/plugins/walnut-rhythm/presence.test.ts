/**
 * Rhythm presence: the sitting streak folded from attention records (pure).
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_PRESENCE, expireIfAway, foldAttention, isPresent, presenceOnBoot, restartStreak,
  sittingMs, spanFromOutside, spansFromBanked, MAX_SPAN_MS,
} from '../../../plugin-store/walnut-rhythm/src/server/presence'

const MIN = 60_000
const T0 = Date.UTC(2026, 8, 25, 16, 0)
const AWAY = 5 * MIN
const span = (fromMin: number, toMin: number) => ({ start: T0 + fromMin * MIN, end: T0 + toMin * MIN })

describe('spansFromBanked', () => {
  it('keeps console records and drops agent time and phone time', () => {
    const now = T0 + 10 * MIN
    const data = {
      records: [
        { ts: new Date(T0).toISOString(), durationMs: 60_000, kind: 'session' },
        { ts: new Date(T0 + MIN).toISOString(), durationMs: 60_000, kind: 'chat', source: 'web' },
        { ts: new Date(T0 + 2 * MIN).toISOString(), durationMs: 60_000, kind: 'triage', source: 'ios' },
        { ts: new Date(T0 + 3 * MIN).toISOString(), durationMs: 60_000, kind: 'agent' },
      ],
    }
    expect(spansFromBanked(data, now)).toEqual([span(0, 1), span(1, 2)])
  })

  it('tolerates junk and caps a single record', () => {
    const now = T0 + 120 * MIN
    expect(spansFromBanked(null, now)).toEqual([])
    expect(spansFromBanked({ records: 'nope' }, now)).toEqual([])
    expect(spansFromBanked({ records: [null, { ts: 'bad', durationMs: 5 }, { ts: new Date(T0).toISOString(), durationMs: -1 }] }, now)).toEqual([])
    const long = spansFromBanked({ records: [{ ts: new Date(T0).toISOString(), durationMs: 3 * 60 * MIN, kind: 'session' }] }, now)
    expect(long[0]!.end - long[0]!.start).toBe(MAX_SPAN_MS)
  })

  it('shifts a record from a clock slightly ahead back to now instead of dropping it', () => {
    const now = T0
    const [one] = spansFromBanked({ records: [{ ts: new Date(T0 + 30_000).toISOString(), durationMs: 60_000, kind: 'session' }] }, now)
    expect(one).toEqual({ start: T0 - 60_000, end: T0 })
  })
})

describe('spanFromOutside', () => {
  it('reads a Mac attention batch and refuses away samples', () => {
    const now = T0 + MIN
    expect(spanFromOutside({ ts: new Date(T0).toISOString(), durationMs: 30_000, bundleId: 'com.example.editor', idleSecs: 3 }, now))
      .toEqual({ start: T0, end: T0 + 30_000 })
    expect(spanFromOutside({ ts: new Date(T0).toISOString(), durationMs: 30_000, idleSecs: 400 }, now)).toBeNull()
    expect(spanFromOutside({ ts: new Date(T0).toISOString(), durationMs: 30_000, bundleId: 'com.apple.loginwindow' }, now)).toBeNull()
    expect(spanFromOutside(undefined, now)).toBeNull()
  })
})

describe('foldAttention', () => {
  it('starts a streak at the first attention and extends it while attention keeps arriving', () => {
    const one = foldAttention(EMPTY_PRESENCE, [span(0, 1), span(1, 2), span(3, 4)], AWAY)
    expect(one.state).toEqual({ streakStartedAt: T0, lastActiveAt: T0 + 4 * MIN })
    expect(one.ended).toEqual([])
    expect(sittingMs(one.state, T0 + 4 * MIN, AWAY)).toBe(4 * MIN)
  })

  it('ends the streak at a gap of the away threshold and restarts it at the next attention', () => {
    const folded = foldAttention(EMPTY_PRESENCE, [span(0, 40), span(46, 50)], AWAY)
    expect(folded.ended).toEqual([{ startedAt: T0, endedAt: T0 + 40 * MIN, streakMs: 40 * MIN, awayMs: 6 * MIN }])
    expect(folded.state.streakStartedAt).toBe(T0 + 46 * MIN)
    expect(sittingMs(folded.state, T0 + 50 * MIN, AWAY)).toBe(4 * MIN)
  })

  it('a gap just under the threshold does not end the streak', () => {
    const folded = foldAttention(EMPTY_PRESENCE, [span(0, 10), { start: T0 + 10 * MIN + AWAY - 1, end: T0 + 16 * MIN }], AWAY)
    expect(folded.ended).toEqual([])
    expect(folded.state.streakStartedAt).toBe(T0)
  })

  it('never moves backwards: a late record inside a known gap cannot reopen the old streak', () => {
    const first = foldAttention(EMPTY_PRESENCE, [span(0, 20), span(30, 32)], AWAY)
    expect(first.ended).toHaveLength(1)
    const late = foldAttention(first.state, [span(21, 29)], AWAY)
    expect(late.state).toEqual(first.state)
    expect(late.ended).toEqual([])
  })

  it('handles unsorted, overlapping records from two signals', () => {
    const folded = foldAttention(EMPTY_PRESENCE, [span(5, 9), span(0, 6), span(8, 12)], AWAY)
    expect(folded.state).toEqual({ streakStartedAt: T0, lastActiveAt: T0 + 12 * MIN })
  })
})

describe('silence and restarts', () => {
  it('a silent stretch is not sitting: the streak does not grow, then expires', () => {
    const state = foldAttention(EMPTY_PRESENCE, [span(0, 30)], AWAY).state
    expect(sittingMs(state, T0 + 33 * MIN, AWAY)).toBe(30 * MIN)
    expect(isPresent(state, T0 + 35 * MIN, AWAY)).toBe(false)
    const expired = expireIfAway(state, T0 + 35 * MIN, AWAY)
    expect(expired.state.streakStartedAt).toBe(0)
    expect(expired.ended[0]!.streakMs).toBe(30 * MIN)
    // Coming back starts a fresh streak, with no second "ended".
    const back = foldAttention(expired.state, [span(40, 41)], AWAY)
    expect(back.state.streakStartedAt).toBe(T0 + 40 * MIN)
    expect(back.ended).toEqual([])
  })

  it('a restart inside the away threshold keeps the streak; a later one restarts it', () => {
    const saved = { streakStartedAt: T0, lastActiveAt: T0 + 40 * MIN }
    expect(presenceOnBoot(saved, T0 + 42 * MIN, AWAY)).toEqual(saved)
    expect(presenceOnBoot(saved, T0 + 46 * MIN, AWAY)).toEqual({ streakStartedAt: 0, lastActiveAt: T0 + 40 * MIN })
    expect(presenceOnBoot({ streakStartedAt: 'x', lastActiveAt: NaN }, T0, AWAY)).toEqual(EMPTY_PRESENCE)
    expect(presenceOnBoot(null, T0, AWAY)).toEqual(EMPTY_PRESENCE)
  })

  it('Done restarts the streak from now; earlier attention in the same batch does not undo it', () => {
    const state = foldAttention(EMPTY_PRESENCE, [span(0, 60)], AWAY).state
    const restarted = restartStreak(state, T0 + 61 * MIN)
    expect(sittingMs(restarted, T0 + 61 * MIN, AWAY)).toBe(0)
    const next = foldAttention(restarted, [span(60, 63)], AWAY).state
    expect(next.streakStartedAt).toBe(T0 + 61 * MIN)
    expect(sittingMs(next, T0 + 63 * MIN, AWAY)).toBe(2 * MIN)
  })
})
