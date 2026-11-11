/**
 * The browser fixture's calendar events sit on the day the fixture booted
 * (tests/e2e/browser/test-server.ts), and its specs look for them on their own today. A shard that
 * booted at 23:49 ran its calendar specs after midnight, and every one waited for an event a day
 * behind (2026-11-11, CI: calendar-controls and calendar-write-safety). With followToday the mock
 * source moves its events with the local date.
 */
import { describe, expect, it } from 'vitest'
import { createMockCalendarSource, localDay, shiftDay } from '../helpers/mock-calendar-source.js'
import type { CalendarEvent } from '../../src/integrations/calendar/types.js'

const event = (id: string, start: string, end: string, allDay = false): CalendarEvent => ({
  id, source: 'eventkit', calendarId: 'cal-work', calendarName: 'Work', accountName: 'Google',
  title: id, start, end, allDay, walnutCreated: true, hasAttendees: false, writeSafetyVersion: 1,
})

describe('mock calendar source: followToday', () => {
  it('moves every event by the days the local date moved', async () => {
    let now = new Date(2026, 10, 10, 23, 49)
    const { source } = createMockCalendarSource({
      events: [event('timed', '2026-11-10T16:00:00', '2026-11-10T17:00:00'), event('all-day', '2026-11-10', '2026-11-10', true)],
      followToday: { day: '2026-11-10', now: () => now },
    })
    expect((await source.listEvents('2026-11-10', '2026-11-10')).map((e) => e.start)).toEqual(['2026-11-10T16:00:00', '2026-11-10'])
    now = new Date(2026, 10, 11, 0, 21)
    const after = await source.listEvents('2026-11-11', '2026-11-11')
    expect(after.map((e) => [e.start, e.end])).toEqual([['2026-11-11T16:00:00', '2026-11-11T17:00:00'], ['2026-11-11', '2026-11-11']])
    // A created event moves with them from then on.
    await source.createEvent({ calendarId: 'cal-work', title: 'made', start: '2026-11-11T09:00:00', end: '2026-11-11T09:30:00' })
    now = new Date(2026, 11, 1, 8, 0)
    const later = await source.listEvents('2026-12-01', '2026-12-01')
    expect(later.map((e) => e.start)).toEqual(['2026-12-01T16:00:00', '2026-12-01', '2026-12-01T09:00:00'])
  })

  it('leaves the dates alone without it', async () => {
    const { source } = createMockCalendarSource({ events: [event('timed', '2020-01-01T10:00:00', '2020-01-01T11:00:00')] })
    expect((await source.listEvents('2020-01-01', '2020-01-01'))[0]!.start).toBe('2020-01-01T10:00:00')
  })

  it('shifts a day string across a month and a year', () => {
    expect(shiftDay('2026-12-31T23:30:00', 1)).toBe('2027-01-01T23:30:00')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})
