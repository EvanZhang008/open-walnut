/**
 * Rhythm clock and config: quiet hours (across midnight too), day keys, how durations
 * read, and config clamping (pure).
 */
import { describe, expect, it } from 'vitest'
import { formatSitting, inQuietWindow, localDayKey, parseQuietHours } from '../../../plugin-store/walnut-rhythm/src/server/clock'
import { normalizeConfig } from '../../../plugin-store/walnut-rhythm/src/server/config'
import { standUpNotice } from '../../../plugin-store/walnut-rhythm/src/server/notices'

/** Local wall time on 2026-09-25 (constructed in the machine's own zone, like the plugin). */
const at = (h: number, m = 0) => new Date(2026, 8, 25, h, m).getTime()

describe('quiet hours', () => {
  it('parses a window, turns off on empty, and rejects junk', () => {
    expect(parseQuietHours('22:00-08:00')).toEqual({ kind: 'window', window: { startMin: 22 * 60, endMin: 8 * 60 } })
    expect(parseQuietHours(' 9:30 - 17:05 ')).toEqual({ kind: 'window', window: { startMin: 570, endMin: 1025 } })
    expect(parseQuietHours('')).toEqual({ kind: 'off' })
    expect(parseQuietHours('09:00-09:00')).toEqual({ kind: 'off' })
    expect(parseQuietHours('25:00-08:00').kind).toBe('invalid')
    expect(parseQuietHours('late night').kind).toBe('invalid')
  })

  it('a window across midnight covers the late evening and the early morning, end minute excluded', () => {
    const parsed = parseQuietHours('22:00-08:00')
    if (parsed.kind !== 'window') throw new Error('expected a window')
    const w = parsed.window
    expect(inQuietWindow(w, at(21, 59))).toBe(false)
    expect(inQuietWindow(w, at(22, 0))).toBe(true)
    expect(inQuietWindow(w, at(23, 30))).toBe(true)
    expect(inQuietWindow(w, at(0, 15))).toBe(true)
    expect(inQuietWindow(w, at(7, 59))).toBe(true)
    expect(inQuietWindow(w, at(8, 0))).toBe(false)
    expect(inQuietWindow(w, at(12, 0))).toBe(false)
  })

  it('a same-day window and no window', () => {
    const parsed = parseQuietHours('12:00-13:00')
    if (parsed.kind !== 'window') throw new Error('expected a window')
    expect(inQuietWindow(parsed.window, at(12, 30))).toBe(true)
    expect(inQuietWindow(parsed.window, at(13, 0))).toBe(false)
    expect(inQuietWindow(null, at(23, 0))).toBe(false)
  })
})

describe('formatting', () => {
  it('reads sitting time the way the reminder says it', () => {
    expect(formatSitting(45 * 60_000)).toBe('45 min')
    expect(formatSitting(63 * 60_000)).toBe('1h 03m')
    expect(formatSitting(-5)).toBe('0 min')
    expect(standUpNotice(63 * 60_000, 10, 10).title).toBe('Stand up: 1h 03m at the keyboard')
  })

  it('day keys are local dates', () => {
    expect(localDayKey(at(0, 5))).toBe('2026-09-25')
    expect(localDayKey(at(23, 59))).toBe('2026-09-25')
  })
})

describe('normalizeConfig', () => {
  it('fills defaults', () => {
    expect(normalizeConfig(undefined)).toEqual({
      reminderEveryMinutes: 60, awayResetMinutes: 5, snoozeMinutes: 10, standBreakMinutes: 10, quietHours: '22:00-08:00',
      deferForNaturalPauseMinutes: 5, focusMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4,
      focusQuietsWalnut: true, mirrorMacosFocus: true, macosFocusShortcuts: false,
    })
  })

  it('clamps numbers into range and keeps an explicitly empty quiet_hours', () => {
    const config = normalizeConfig({ reminder_every_minutes: 5, away_reset_minutes: '7', snooze_minutes: 'x', stand_break_minutes: 0, quiet_hours: '', long_break_every: 99, macos_focus_shortcuts: true })
    expect(config).toMatchObject({ reminderEveryMinutes: 15, awayResetMinutes: 7, snoozeMinutes: 10, standBreakMinutes: 1, quietHours: '', longBreakEvery: 12, macosFocusShortcuts: true })
  })
})
