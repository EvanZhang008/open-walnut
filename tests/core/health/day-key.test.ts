/**
 * Health day keys: a sample's local date comes from ITS zone, the night split is
 * 18:00 local, and a DST night is as long as it really was.
 */
import { describe, it, expect } from 'vitest'
import {
  addDays, dateRange, isDateKey, isValidTz, localDate, localIso, nightDate, offsetMinutes, zonedMidnight, zonedTime,
} from '../../../src/core/health/day-key.js'

const at = (iso: string): number => Date.parse(iso)

describe('health day keys', () => {
  it('computes the local date in the sample zone, not the machine zone', () => {
    const instant = at('2026-09-21T02:30:00Z')
    expect(localDate(instant, 'America/Los_Angeles')).toBe('2026-09-20')
    expect(localDate(instant, 'Asia/Tokyo')).toBe('2026-09-21')
    expect(localDate(instant, 'UTC')).toBe('2026-09-21')
  })

  it('files an evening sample under the NEXT wake date and a morning one under today', () => {
    const tz = 'America/New_York'
    expect(nightDate(at('2026-09-20T23:30:00-04:00'), tz)).toBe('2026-09-21')
    expect(nightDate(at('2026-09-21T06:45:00-04:00'), tz)).toBe('2026-09-21')
    expect(nightDate(at('2026-09-21T17:59:00-04:00'), tz)).toBe('2026-09-21')
    expect(nightDate(at('2026-09-21T18:00:00-04:00'), tz)).toBe('2026-09-22')
  })

  it('keeps DST honest on 2026-11-01 (New York falls back at 02:00)', () => {
    const tz = 'America/New_York'
    const bed = at('2026-10-31T23:00:00-04:00')
    const wake = at('2026-11-01T07:00:00-05:00')
    expect((wake - bed) / 3_600_000).toBe(9)
    expect(offsetMinutes(bed, tz)).toBe(-240)
    expect(offsetMinutes(wake, tz)).toBe(-300)
    expect(localIso(bed, tz)).toBe('2026-10-31T23:00:00-04:00')
    expect(localIso(wake, tz)).toBe('2026-11-01T07:00:00-05:00')
    expect(nightDate(wake, tz)).toBe('2026-11-01')
    // Local midnight of the DST day is still in EDT; 10:30 is in EST.
    expect(zonedMidnight('2026-11-01', tz)).toBe(at('2026-11-01T00:00:00-04:00'))
    expect(zonedTime('2026-11-01', 10, 30, tz)).toBe(at('2026-11-01T10:30:00-05:00'))
  })

  it('validates zones and dates without trusting input', () => {
    expect(isValidTz('Europe/Berlin')).toBe(true)
    expect(isValidTz('Mars/Olympus')).toBe(false)
    expect(isValidTz('')).toBe(false)
    expect(isValidTz(42)).toBe(false)
    expect(isDateKey('2026-02-28')).toBe(true)
    expect(isDateKey('2026-02-30')).toBe(false)
    expect(isDateKey('2026-2-3')).toBe(false)
  })

  it('does pure calendar arithmetic across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(dateRange('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'])
  })
})
