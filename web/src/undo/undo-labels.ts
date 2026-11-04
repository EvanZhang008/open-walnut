/** Words of the undo toasts (undo/TaskUndoContext.tsx). */

/** How the toast says a snooze: a day ("Nov 6"), a time today ("3:30 PM"), or both. */
export function formatSnoozeDate(value: string, now = new Date()): string {
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const at = dayOnly ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const day = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (dayOnly) return day;
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${day}, ${time}`;
}
