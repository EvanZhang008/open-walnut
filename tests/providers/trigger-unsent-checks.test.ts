/**
 * The checks a host ran while no server of the trigger's Walnut was there are kept, bounded, in the
 * trigger's state (src/providers/trigger-unsent-checks.ts), and read back from disk the same way.
 *
 * 2026-11-25: a clouddev trigger checked every 30 minutes from 05:09 to 08:40Z while the Mac slept;
 * every report but the latest was dropped, and the record on the Mac had a four-hour hole.
 */
import { describe, it, expect } from 'vitest'
import {
  UNSENT_CHECKS_MAX, keepUnsentCheck, takeUnsentChecks,
} from '../../src/providers/trigger-unsent-checks.js'
import { coerceHostState, coerceUnsentChecks, emptyHostState, type TriggerCheckedEvent, type TriggerHostState } from '../../src/providers/trigger-check-core.js'

const T0 = Date.UTC(2026, 10, 25, 5, 9, 0)
const HALF_HOUR = 30 * 60_000

function check(atMs: number, extra: Partial<TriggerCheckedEvent> = {}): TriggerCheckedEvent {
  return {
    type: 'trigger.checked', id: 'trg-1', atMs, outcome: 'quiet', reason: 'fire-false',
    durationMs: 120, nextRunAtMs: atMs + HALF_HOUR, consecutiveErrors: 0, ...extra,
  }
}

const fresh = (): TriggerHostState => emptyHostState(T0)
const times = (list: TriggerCheckedEvent[] | undefined) => (list ?? []).map((c) => c.atMs)

describe('keepUnsentCheck', () => {
  it('keeps each report oldest first, whatever order they come in', () => {
    const s = fresh()
    keepUnsentCheck(s, check(T0 + 2 * HALF_HOUR))
    keepUnsentCheck(s, check(T0))
    keepUnsentCheck(s, check(T0 + HALF_HOUR))
    expect(times(s.unsentChecks)).toEqual([T0, T0 + HALF_HOUR, T0 + 2 * HALF_HOUR])
  })

  it('a report of the same time is kept once', () => {
    const s = fresh()
    keepUnsentCheck(s, check(T0))
    keepUnsentCheck(s, check(T0, { outcome: 'error', error: 'exit 1', reason: undefined }))
    expect(s.unsentChecks).toHaveLength(1)
    expect(s.unsentChecks![0]).toMatchObject({ atMs: T0, outcome: 'quiet' })
  })

  it(`keeps at most ${UNSENT_CHECKS_MAX}, the newest, dropping the oldest first`, () => {
    const s = fresh()
    const n = UNSENT_CHECKS_MAX + 7
    for (let i = 0; i < n; i++) keepUnsentCheck(s, check(T0 + i * HALF_HOUR))
    expect(s.unsentChecks).toHaveLength(UNSENT_CHECKS_MAX)
    expect(s.unsentChecks![0]!.atMs).toBe(T0 + 7 * HALF_HOUR)
    expect(s.unsentChecks!.at(-1)!.atMs).toBe(T0 + (n - 1) * HALF_HOUR)
    // An older report than all kept, coming late to a full list, is the one that goes.
    keepUnsentCheck(s, check(T0 - HALF_HOUR))
    expect(s.unsentChecks).toHaveLength(UNSENT_CHECKS_MAX)
    expect(s.unsentChecks![0]!.atMs).toBe(T0 + 7 * HALF_HOUR)
  })
})

describe('takeUnsentChecks', () => {
  it('hands the kept reports on oldest first and empties the list', () => {
    const s = fresh()
    keepUnsentCheck(s, check(T0 + HALF_HOUR))
    keepUnsentCheck(s, check(T0))
    expect(times(takeUnsentChecks(s))).toEqual([T0, T0 + HALF_HOUR])
    expect(s.unsentChecks).toBeUndefined()
    expect('unsentChecks' in s).toBe(false)
    expect(takeUnsentChecks(s)).toEqual([])
  })
})

describe('coerceUnsentChecks: the kept reports as read from disk', () => {
  it('anything but a list is nothing, and an empty list is nothing', () => {
    for (const raw of [undefined, null, 1, 'x', {}, { 0: check(T0) }]) expect(coerceUnsentChecks(raw)).toBeUndefined()
    expect(coerceUnsentChecks([])).toBeUndefined()
    expect(coerceUnsentChecks([null, 'x', { type: 'trigger.checked' }])).toBeUndefined()
  })

  it('drops each invalid row and keeps the valid ones, oldest first', () => {
    const raw = [
      check(T0 + 2 * HALF_HOUR),
      { ...check(T0 + 3 * HALF_HOUR), type: 'trigger.fired' },
      { ...check(T0 + 4 * HALF_HOUR), outcome: 'fired' },
      { ...check(T0 + 5 * HALF_HOUR), atMs: 'soon' },
      { ...check(T0 + 6 * HALF_HOUR), consecutiveErrors: -1 },
      { ...check(T0 + 7 * HALF_HOUR), reason: 'because' },
      { ...check(T0 + 8 * HALF_HOUR), id: '' },
      check(T0),
      null,
      check(T0 + HALF_HOUR, { outcome: 'error', error: 'exit 3', reason: undefined }),
    ]
    const got = coerceUnsentChecks(raw)!
    expect(times(got)).toEqual([T0, T0 + HALF_HOUR, T0 + 2 * HALF_HOUR])
    expect(got[1]).toMatchObject({ outcome: 'error', error: 'exit 3' })
  })

  it(`a list longer than ${UNSENT_CHECKS_MAX} keeps the newest ${UNSENT_CHECKS_MAX}`, () => {
    const n = UNSENT_CHECKS_MAX * 3
    const got = coerceUnsentChecks(Array.from({ length: n }, (_, i) => check(T0 + i * HALF_HOUR)))!
    expect(got).toHaveLength(UNSENT_CHECKS_MAX)
    expect(got[0]!.atMs).toBe(T0 + (n - UNSENT_CHECKS_MAX) * HALF_HOUR)
    expect(got.at(-1)!.atMs).toBe(T0 + (n - 1) * HALF_HOUR)
  })
})

describe('coerceHostState keeps the unsent reports across a read of the state file', () => {
  it('a state written with kept reports reads back with the same reports', () => {
    const s = fresh()
    for (let i = 0; i < 4; i++) keepUnsentCheck(s, check(T0 + i * HALF_HOUR))
    s.lastCheck = check(T0 + 3 * HALF_HOUR)
    const back = coerceHostState(JSON.parse(JSON.stringify(s)), T0 + 4 * HALF_HOUR)
    expect(back.unsentChecks).toEqual(s.unsentChecks)
    expect(back.lastCheck).toEqual(s.lastCheck)
    expect(back.epoch).toBe(s.epoch)
  })

  it('a state with none, or with only invalid rows, has no unsentChecks field', () => {
    const s = fresh()
    expect('unsentChecks' in coerceHostState(JSON.parse(JSON.stringify(s)), T0)).toBe(false)
    expect('unsentChecks' in coerceHostState({ ...s, unsentChecks: [{ junk: 1 }] }, T0)).toBe(false)
  })
})
