/**
 * The Created / Updated / Last active rows at the foot of the session panel's
 * ⋮ menu. Dates are built with the local-time Date constructor so the expected
 * wording holds in any timezone the suite runs in.
 */
import { describe, expect, it } from 'vitest'
import { formatKebabTime, sessionKebabTimeRows } from '../../web/src/components/sessions/session-kebab-times'

const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).toISOString()
const NOW = new Date(2026, 8, 28, 18, 30).getTime() // Mon Sep 28 2026, 6:30 PM local

describe('formatKebabTime', () => {
  it('today: clock time plus how long ago', () => {
    expect(formatKebabTime(at(2026, 9, 28, 15, 2), NOW)).toBe('Today 3:02 PM · 3h ago')
    expect(formatKebabTime(at(2026, 9, 28, 18, 29, 40), NOW)).toBe('Today 6:29 PM · just now')
  })

  it('yesterday, even when it is fewer than 24 hours back', () => {
    expect(formatKebabTime(at(2026, 9, 27, 23, 50), NOW)).toBe('Yesterday 11:50 PM · 18h ago')
  })

  it('earlier this year: month and day, no year', () => {
    expect(formatKebabTime(at(2026, 9, 20, 10, 14), NOW)).toBe('Sep 20, 10:14 AM · 1w ago')
    expect(formatKebabTime(at(2026, 1, 5, 8, 0), NOW)).toBe('Jan 5, 8:00 AM · 8mo ago')
  })

  it('another year: the year is spelled out', () => {
    expect(formatKebabTime(at(2025, 3, 3, 8, 0), NOW)).toBe('Mar 3, 2025, 8:00 AM · 1y ago')
  })

  it('no plain-looking value hides a no-break space', () => {
    const text = formatKebabTime(at(2026, 9, 28, 9, 5), NOW)!
    expect(text).toBe('Today 9:05 AM · 9h ago')
    expect(text).not.toMatch(/[\u202f\u00a0]/)
  })

  it('a clock-skewed future time reads as just now, not a negative age', () => {
    expect(formatKebabTime(at(2026, 9, 28, 18, 31), NOW)).toBe('Today 6:31 PM · just now')
  })

  it('missing or unparseable input gives nothing', () => {
    expect(formatKebabTime(undefined, NOW)).toBeNull()
    expect(formatKebabTime('', NOW)).toBeNull()
    expect(formatKebabTime('not a date', NOW)).toBeNull()
  })
})

describe('sessionKebabTimeRows', () => {
  const task = { created_at: at(2026, 9, 20, 10, 14), updated_at: at(2026, 9, 28, 15, 2) }
  const session = { startedAt: at(2026, 9, 26, 9, 1), lastActiveAt: at(2026, 9, 28, 18, 25) }

  it('task created / updated plus the session last active, in that order', () => {
    const rows = sessionKebabTimeRows(task, session, NOW)
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Created', 'Sep 20, 10:14 AM · 1w ago'],
      ['Updated', 'Today 3:02 PM · 3h ago'],
      ['Last active', 'Today 6:25 PM · 5m ago'],
    ])
  })

  it('tooltips carry the full timestamp and whose time it is', () => {
    const [created, updated, active] = sessionKebabTimeRows(task, session, NOW)
    expect(created.title).toBe('Task created Sun, Sep 20, 2026, 10:14:00 AM\nSession started Sat, Sep 26, 2026, 9:01:00 AM')
    expect(updated.title).toBe('Task last changed Mon, Sep 28, 2026, 3:02:00 PM')
    expect(active.title).toBe('Session last active Mon, Sep 28, 2026, 6:25:00 PM')
  })

  it('a session born with its task does not repeat the start time', () => {
    const born = at(2026, 9, 28, 9, 0)
    const [created] = sessionKebabTimeRows(
      { created_at: born, updated_at: born },
      { startedAt: at(2026, 9, 28, 9, 0, 20), lastActiveAt: born },
      NOW,
    )
    expect(created.title).toBe('Task created Mon, Sep 28, 2026, 9:00:00 AM')
  })

  it('no task loaded: Created falls back to the session start, no Updated row', () => {
    const rows = sessionKebabTimeRows(null, session, NOW)
    expect(rows.map((r) => r.key)).toEqual(['created', 'active'])
    expect(rows[0].value).toBe('Sep 26, 9:01 AM · 2d ago')
    expect(rows[0].title).toBe('Session started Sat, Sep 26, 2026, 9:01:00 AM')
  })

  it('a bad task timestamp falls back instead of printing Invalid Date', () => {
    const rows = sessionKebabTimeRows({ created_at: 'garbage', updated_at: '' }, session, NOW)
    expect(rows.map((r) => r.key)).toEqual(['created', 'active'])
    expect(rows[0].title).toMatch(/^Session started /)
    expect(rows.map((r) => r.value).join(' ')).not.toMatch(/Invalid/)
  })

  it('nothing known: no rows, so the menu draws no empty block', () => {
    expect(sessionKebabTimeRows(undefined, undefined, NOW)).toEqual([])
    expect(sessionKebabTimeRows({}, {}, NOW)).toEqual([])
  })
})
