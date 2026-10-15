/**
 * N27: a phone's day view with nothing on it says so in one line, above the
 * grid. An empty grid alone reads the same as a calendar that has not loaded
 * or lost its access, so the line shows only once the day's events are in and
 * no calendar problem is up.
 */
import { timeGridItems, type CalendarItem } from './calendar-items';

/** Whether the day (`YYYY-MM-DD`) has no item at any hour, all-day ones included. */
export function isDayEmpty(items: CalendarItem[], day: string): boolean {
  return timeGridItems(items, [day], 24 * 60).length === 0;
}

/** The line: `Nothing scheduled today.`, or the weekday and date for another day. */
export function emptyDayLine(day: string, today: string): string {
  if (day === today) return 'Nothing scheduled today.';
  const [y, m, d] = day.split('-').map(Number);
  const when = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return `Nothing scheduled on ${when}.`;
}
