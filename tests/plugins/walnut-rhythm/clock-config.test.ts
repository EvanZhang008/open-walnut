/**
 * Rhythm clock and config: day keys, how a time of day reads, and config clamping (pure).
 */
import { describe, expect, it } from 'vitest'
import { clockTime, localDayKey } from '../../../plugin-store/walnut-rhythm/src/server/clock'
import { normalizeConfig } from '../../../plugin-store/walnut-rhythm/src/server/config'
import { clockText, focusPhaseText, runSpanText, runText } from '../../../plugin-store/walnut-rhythm/src/web/format'

/** Local wall time on 2026-09-25 (constructed in the machine's own zone, like the plugin). */
const at = (h: number, m = 0) => new Date(2026, 8, 25, h, m).getTime()

describe('clock', () => {
  it('day keys are local dates', () => {
    expect(localDayKey(at(0, 0))).toBe('2026-09-25')
    expect(localDayKey(at(23, 59))).toBe('2026-09-25')
  })

  it('times of day read as local 24-hour clock times', () => {
    expect(clockTime(at(9, 5))).toBe('09:05')
    expect(clockTime(at(23, 59))).toBe('23:59')
  })
})

describe('normalizeConfig', () => {
  it('fills defaults', () => {
    expect(normalizeConfig(undefined)).toEqual({
      focusMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4,
      focusQuietsWalnut: true, mirrorMacosFocus: true, macosFocusShortcuts: false,
      musicFolder: '', musicWithFocus: true,
    })
  })

  it('clamps numbers into range and ignores the old stand-up reminder keys', () => {
    const config = normalizeConfig({ focus_minutes: 2, break_minutes: '7', long_break_minutes: 'x', long_break_every: 99, macos_focus_shortcuts: true, reminder_every_minutes: 5, quiet_hours: '' })
    expect(config).toEqual(expect.objectContaining({ focusMinutes: 5, breakMinutes: 7, longBreakMinutes: 15, longBreakEvery: 12, macosFocusShortcuts: true }))
    expect(Object.keys(config)).not.toContain('reminderEveryMinutes')
    expect(Object.keys(config)).not.toContain('quietHours')
  })
})

describe('the App\'s run words', () => {
  const base = { minutes: 25, remainingMs: 0, completedInCycle: 0, longBreakEvery: 4 }
  it('off reads Off, with the last run when there was one', () => {
    const off = { ...base, phase: 'idle' as const, startedAt: null, endsAt: null, runStartedAt: null, lastRun: null }
    expect(focusPhaseText('idle')).toBe('Off')
    expect(runText(off)).toBe('No run yet')
    expect(runSpanText(off)).toBe('None yet')
    const after = { ...off, lastRun: { startedAt: at(9, 5), endedAt: at(9, 35) } }
    expect(runText(after)).toBe('Last run 09:05 to 09:35')
    expect(runSpanText(after)).toBe('09:05 to 09:35')
  })

  it('a run names its start and its end, on the same 24-hour clock as the ring', () => {
    const running = { ...base, phase: 'focus' as const, startedAt: at(9, 5), endsAt: at(9, 30), runStartedAt: at(9, 5), lastRun: null }
    expect(runText(running)).toBe('Started 09:05, ends 09:30')
    expect(runSpanText(running)).toBe('09:05 to 09:30')
    const rest = { ...running, phase: 'break' as const, startedAt: at(9, 30), endsAt: at(9, 35) }
    expect(runText(rest)).toBe('Started 09:05, break ends 09:35')
    expect(clockText(at(14, 7))).toBe('14:07')
  })
})
