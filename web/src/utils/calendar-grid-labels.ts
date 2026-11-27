/**
 * The words a calendar grid draws that are not a point in time: a weekday column head ("Mon"),
 * the first of a month in its cell ("Nov 1"), a view's title ("November 2026", "Nov 23 - 29,
 * 2026" with an en dash, "November 23, 2026") and a day cell's name for a screen reader. The
 * Calendar page and the date picker's month both draw them from here. The time of something
 * (an event's start, a due date, a snooze) is written through '@/utils/time' instead.
 */
import { weekRange } from './calendar-date';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Mon": a week grid's column head. */
export const weekdayShort = (d: Date): string => WEEKDAYS[d.getDay()].slice(0, 3);

/** "Mo": the date picker's narrow column head (Sunday first). */
export const WEEKDAYS_NARROW = WEEKDAYS.map((w) => w.slice(0, 2));

/** "Nov 1": a month grid cell that starts a month. */
export const monthDayShort = (d: Date): string => `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;

/** "November 2026": a month's title. */
export const monthTitle = (year: number, month: number): string => `${MONTHS[month]} ${year}`;

/** "Monday, November 16, 2026": a day cell's name for a screen reader. */
export const dayCellName = (d: Date): string =>
  `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

/** The Calendar toolbar's title: a month, a day, or a week's range (above). */
export function calendarTitle(view: 'day' | 'week' | 'month', anchor: Date): string {
  if (view === 'month') return monthTitle(anchor.getFullYear(), anchor.getMonth());
  if (view === 'day') return `${MONTHS[anchor.getMonth()]} ${anchor.getDate()}, ${anchor.getFullYear()}`;
  const days = weekRange(anchor);
  const [a, b] = [days[0], days[6]];
  if (a.getMonth() === b.getMonth()) return `${monthDayShort(a)} – ${b.getDate()}, ${b.getFullYear()}`;
  return `${monthDayShort(a)} – ${monthDayShort(b)}, ${b.getFullYear()}`;
}
