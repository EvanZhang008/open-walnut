/**
 * Work hours: parsing the setting and splitting an interval into the part inside
 * them. Timestamps are built from LOCAL wall-clock fields so the suite passes in
 * any time zone.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORK_HOURS, isWorkday, parseWorkHours, resolveWorkHours, workHoursLabel, workHoursToConfig, workMsOf,
  WorkHoursError,
} from '../../../src/core/time-tracking/work-hours.js'

// 2026-10-05 is a Monday, 2026-10-10 a Saturday.
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 9, day, hour, minute).getTime()
const MIN = 60_000

describe('parseWorkHours', () => {
  it('defaults to 09:00-18:00 Monday to Friday', () => {
    expect(parseWorkHours(undefined)).toEqual({ start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] })
    expect(workHoursLabel(DEFAULT_WORK_HOURS)).toBe('09:00-18:00 Mon-Fri')
  })

  it('takes weekday names or numbers, fills gaps from the base, and round-trips to config', () => {
    const wh = parseWorkHours({ start: '8:30', days: ['Mon', 'tue', 'WED', 4, 'fri', 'sat'] })
    expect(wh).toEqual({ start: '08:30', end: '18:00', days: [1, 2, 3, 4, 5, 6] })
    expect(workHoursToConfig(wh)).toEqual({ start: '08:30', end: '18:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] })
    expect(parseWorkHours(workHoursToConfig(wh))).toEqual(wh)
  })

  it('refuses junk with a sentence a caller can show', () => {
    expect(() => parseWorkHours({ start: '25:00' })).toThrow(WorkHoursError)
    expect(() => parseWorkHours({ start: '18:00', end: '09:00' })).toThrow(/after start/)
    expect(() => parseWorkHours({ days: ['funday'] })).toThrow(/unknown weekday/)
    expect(() => parseWorkHours({ days: 'mon' as unknown as string[] })).toThrow(/list of weekdays/)
  })

  it('a bad stored setting falls back to the default and says why', () => {
    const r = resolveWorkHours({ start: 'noon' })
    expect(r.source).toBe('default')
    expect(r.workHours).toEqual(DEFAULT_WORK_HOURS)
    expect(r.invalid).toMatch(/HH:MM/)
  })
})

describe('workMsOf', () => {
  it('counts only the part inside the window on a working day', () => {
    expect(workMsOf(at(5, 8, 30), at(5, 9, 30), DEFAULT_WORK_HOURS)).toBe(30 * MIN)
    expect(workMsOf(at(5, 17, 45), at(5, 18, 15), DEFAULT_WORK_HOURS)).toBe(15 * MIN)
    expect(workMsOf(at(5, 20), at(5, 21), DEFAULT_WORK_HOURS)).toBe(0)
  })

  it('a weekend day has no work hours; a custom Saturday does', () => {
    expect(workMsOf(at(10, 10), at(10, 11), DEFAULT_WORK_HOURS)).toBe(0)
    expect(isWorkday('2026-10-10', DEFAULT_WORK_HOURS)).toBe(false)
    const withSat = parseWorkHours({ days: ['sat'] })
    expect(workMsOf(at(10, 10), at(10, 11), withSat)).toBe(60 * MIN)
  })

  it('an interval across midnight judges each day on its own weekday', () => {
    // Friday 23:00 to Saturday 10:00 with a 00:00-24:00 every-day window.
    const allDay = parseWorkHours({ start: '00:00', end: '24:00', days: [5] })
    expect(workMsOf(at(9, 23), at(10, 10), allDay)).toBe(60 * MIN)
  })

  it('an empty or reversed interval is zero', () => {
    expect(workMsOf(at(5, 10), at(5, 10), DEFAULT_WORK_HOURS)).toBe(0)
    expect(workMsOf(at(5, 11), at(5, 10), DEFAULT_WORK_HOURS)).toBe(0)
  })
})
