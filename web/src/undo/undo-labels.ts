/** Words of the undo toasts (undo/TaskUndoContext.tsx). */
import { dayDate, pointInTime } from '@/utils/time';

/** How the toast says a snooze, as every time reads: a day ("Nov 6", "tomorrow"), or a day and its clock ("today 3:30 PM"). */
export function formatSnoozeDate(value: string, now = new Date()): string {
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const at = dayOnly ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return dayOnly ? dayDate(at, { now: now.getTime() }) : pointInTime(at, { now: now.getTime() });
}
