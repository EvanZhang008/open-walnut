/**
 * Reading the clock a caller puts on a park: a duration from now, an ISO time,
 * or "" for no clock. A bad one is refused before anything is written.
 */
import { describe, it, expect } from 'vitest'
import { parseWaitUntil } from '../../src/core/task-wait-clock.js'

const NOW = Date.parse('2026-10-04T12:00:00.000Z')

describe('parseWaitUntil', () => {
  it('reads a duration from now in every unit', () => {
    expect(parseWaitUntil('6h', NOW)).toBe('2026-10-04T18:00:00.000Z')
    expect(parseWaitUntil('3d', NOW)).toBe('2026-10-07T12:00:00.000Z')
    expect(parseWaitUntil('90m', NOW)).toBe('2026-10-04T13:30:00.000Z')
    expect(parseWaitUntil('30s', NOW)).toBe('2026-10-04T12:00:30.000Z')
    expect(parseWaitUntil('1.5h', NOW)).toBe('2026-10-04T13:30:00.000Z')
    expect(parseWaitUntil(' 2D ', NOW)).toBe('2026-10-06T12:00:00.000Z')
    // A bare number is milliseconds, the same as `every`.
    expect(parseWaitUntil(60_000, NOW)).toBe('2026-10-04T12:01:00.000Z')
  })

  it('reads an ISO datetime, offset included, as the same instant', () => {
    expect(parseWaitUntil('2026-10-09T17:00:00-07:00', NOW)).toBe('2026-10-10T00:00:00.000Z')
  })

  it('keeps "no clock" and "not named" apart', () => {
    expect(parseWaitUntil('', NOW)).toBe('')
    expect(parseWaitUntil('   ', NOW)).toBe('')
    expect(parseWaitUntil(undefined, NOW)).toBeUndefined()
    expect(parseWaitUntil(null, NOW)).toBeUndefined()
  })

  it('refuses a clock that is not a time, or not in the future', () => {
    expect(() => parseWaitUntil('next week', NOW)).toThrow(/neither an ISO datetime nor a duration/)
    expect(() => parseWaitUntil('6 weeks', NOW)).toThrow(/neither/)
    expect(() => parseWaitUntil('2026-10-01T00:00:00Z', NOW)).toThrow(/not in the future/)
    expect(() => parseWaitUntil('0h', NOW)).toThrow(/not in the future/)
    expect(() => parseWaitUntil({ at: 'x' }, NOW)).toThrow(/ISO datetime or a duration/)
    expect(() => parseWaitUntil(true, NOW)).toThrow(/ISO datetime or a duration/)
  })
})
