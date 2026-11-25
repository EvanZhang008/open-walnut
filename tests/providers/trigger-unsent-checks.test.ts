/**
 * The checks a host ran while no server of the trigger's Walnut was there are kept, bounded, in the
 * trigger's state (src/providers/trigger-unsent-checks.ts), and read back from disk the same way.
 *
 * 2026-11-25: a clouddev trigger checked every 30 minutes from 05:09 to 08:40Z while the Mac slept;
 * every report but the latest was dropped, and the record on the Mac had a four-hour hole.
 */
import { describe, it, expect } from 'vitest'
import {
  UNSENT_CHECKS_MAX, checksToResend, keepUnsentCheck, settleChecksOnWire, type CheckOnWire,
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

describe('settleChecksOnWire: a report on the wire is kept until a server read it', () => {
  // 2026-11-25 19:22:07Z: the Mac connected in a dark wake, took the configure replay, was last
  // heard 1 s later and slept again; its socket closed silent at 19:24:17. Nothing of it was read.
  // Read = the socket answered a daemon ping sent at or after the report (readThrough).
  const sock = (name: string) => ({ name })
  const setup = () => {
    const s = fresh()
    for (let i = 0; i < 3; i++) keepUnsentCheck(s, check(T0 + i * HALF_HOUR))
    return s
  }

  it('answered a ping sent after the report: read, dropped from the kept list and from the wire', () => {
    const s = setup(); const a = sock('a'); const sentAt = T0 + 3 * HALF_HOUR
    const wire = new Map<number, CheckOnWire>(times(s.unsentChecks).map((t) => [t, { sentAt, to: [a] }]))
    expect(settleChecksOnWire(s, wire, { open: () => true, readThrough: () => sentAt + 1 })).toBe(true)
    expect(s.unsentChecks).toBeUndefined()
    expect(wire.size).toBe(0)
  })

  it('its newest answered ping was sent before the report (heard, but by its own ping or an older pong): still kept', () => {
    const s = setup(); const a = sock('a'); const sentAt = T0 + 3 * HALF_HOUR
    const wire = new Map<number, CheckOnWire>(times(s.unsentChecks).map((t) => [t, { sentAt, to: [a] }]))
    expect(settleChecksOnWire(s, wire, { open: () => true, readThrough: () => sentAt - 1 })).toBe(false)
    expect(times(s.unsentChecks)).toEqual([T0, T0 + HALF_HOUR, T0 + 2 * HALF_HOUR])
    expect(wire.size).toBe(3)
  })

  it('its socket closed unanswered: kept, the mark goes, so it is sent again', () => {
    const s = setup(); const a = sock('a'); const sentAt = T0 + 3 * HALF_HOUR
    const wire = new Map<number, CheckOnWire>([[T0, { sentAt, to: [a] }]])
    expect(settleChecksOnWire(s, wire, { open: () => false, readThrough: () => sentAt + 60_000 })).toBe(false)
    expect(wire.size).toBe(0)
    expect(times(checksToResend(s, wire, { open: () => false }))).toEqual([T0, T0 + HALF_HOUR, T0 + 2 * HALF_HOUR])
  })

  it('sent to two servers: read when either open one answered a later ping; only the reports read go', () => {
    const s = setup(); const a = sock('a'); const b = sock('b'); const sentAt = T0 + 3 * HALF_HOUR
    const wire = new Map<number, CheckOnWire>([[T0, { sentAt, to: [a, b] }], [T0 + HALF_HOUR, { sentAt, to: [a] }]])
    const heard = new Map<object, number>([[a, sentAt - 2_000], [b, sentAt]])
    expect(settleChecksOnWire(s, wire, { open: () => true, readThrough: (ws) => heard.get(ws) })).toBe(true)
    expect(times(s.unsentChecks)).toEqual([T0 + HALF_HOUR, T0 + 2 * HALF_HOUR])
    expect([...wire.keys()]).toEqual([T0 + HALF_HOUR])
  })
})

describe('checksToResend', () => {
  it('the kept reports on no open socket, oldest first, but the latest', () => {
    const s = fresh()
    for (let i = 0; i < 4; i++) keepUnsentCheck(s, check(T0 + i * HALF_HOUR))
    const live = { name: 'live' }; const gone = { name: 'gone' }
    const wire = new Map<number, CheckOnWire>([[T0, { sentAt: T0, to: [live] }], [T0 + HALF_HOUR, { sentAt: T0, to: [gone] }]])
    const open = (ws: object) => ws === live
    expect(times(checksToResend(s, wire, { open }, T0 + 3 * HALF_HOUR))).toEqual([T0 + HALF_HOUR, T0 + 2 * HALF_HOUR])
    expect(checksToResend(fresh(), wire, { open })).toEqual([])
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
