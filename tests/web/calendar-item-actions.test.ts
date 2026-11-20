/**
 * The drop math the calendar views share (web/src/components/calendar/calendar-item-actions.ts):
 * a moved or copied event keeps its length, a date-only drop makes it all-day, and a task's
 * timed block keeps its length or loses its shape in the all-day row.
 */
import { describe, expect, it } from 'vitest'
import { droppedEventTimes, droppedTaskPatch, splitItemId } from '../../web/src/components/calendar/calendar-item-actions'

describe('calendar drop math', () => {
  it('an event keeps its length, across midnight too', () => {
    expect(droppedEventTimes({ start: '2026-11-20T19:00:00', end: '2026-11-20T20:30:00' }, '2026-11-21T23:00:00'))
      .toEqual({ start: '2026-11-21T23:00:00', end: '2026-11-22T00:30:00' })
  })
  it('a zero-length event lands 15 minutes long; a date-only drop is that day all-day', () => {
    expect(droppedEventTimes({ start: '2026-11-20T19:00:00', end: '2026-11-20T19:00:00' }, '2026-11-20T09:00:00').end).toBe('2026-11-20T09:15:00')
    expect(droppedEventTimes({ start: '2026-11-20T19:00:00', end: '2026-11-20T20:00:00' }, '2026-11-22')).toEqual({ start: '2026-11-22', end: '2026-11-22' })
  })
  it('a task block keeps its length; into the all-day row it loses its end', () => {
    const task = { start_date: '2026-11-20T19:00:00', end_date: '2026-11-20T19:45:00' }
    expect(droppedTaskPatch(task, '2026-11-20T21:00:00')).toEqual({ start_date: '2026-11-20T21:00:00', end_date: '2026-11-20T21:45:00' })
    expect(droppedTaskPatch(task, '2026-11-21')).toEqual({ start_date: '2026-11-21', end_date: '' })
    expect(droppedTaskPatch({ start_date: '2026-11-20' }, '2026-11-21T10:00:00')).toEqual({ start_date: '2026-11-21T10:00:00' })
  })
  it('an item id splits on its first colon only (event ids hold colons)', () => {
    expect(splitItemId('event:eventkit:abc:1')).toEqual({ kind: 'event', id: 'eventkit:abc:1' })
  })
})
