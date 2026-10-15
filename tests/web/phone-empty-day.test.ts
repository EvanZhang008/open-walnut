/**
 * N27: a phone's empty day view says so in one line. What counts as empty is
 * what the day's grid would draw (timed and all-day items alike).
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { tasksToCalendarItems } from '../../web/src/components/calendar/calendar-items';
import { emptyDayLine, isDayEmpty } from '../../web/src/components/calendar/phone-empty-day';

const task = (over: Partial<Task>) => ({ id: 'mtask-0001', title: 'Water the seedlings', phase: 'TODO', ...over }) as Task;

describe('phone empty day', () => {
  it('a day with no item is empty; an all-day or a timed task is not', () => {
    const day = '2026-10-14';
    expect(isDayEmpty([], day)).toBe(true);
    const allDay = tasksToCalendarItems([task({ start_date: day })], day, '2026-10-15');
    expect(isDayEmpty(allDay, day)).toBe(false);
    const timed = tasksToCalendarItems([task({ start_date: `${day}T09:30:00` })], day, '2026-10-15');
    expect(isDayEmpty(timed, day)).toBe(false);
    // An item on the next day (the grid fetches one day past the view) does not fill this one.
    const next = tasksToCalendarItems([task({ start_date: '2026-10-15T09:30:00' })], day, '2026-10-15');
    expect(isDayEmpty(next, day)).toBe(true);
  });

  it('the line names today, or the weekday and date of another day', () => {
    expect(emptyDayLine('2026-10-14', '2026-10-14')).toBe('Nothing scheduled today.');
    expect(emptyDayLine('2026-10-16', '2026-10-14')).toBe('Nothing scheduled on Friday, October 16.');
  });
});
