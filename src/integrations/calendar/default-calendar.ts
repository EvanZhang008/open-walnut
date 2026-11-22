/**
 * The configured default calendar, checked against the calendars there are right now.
 */
import type { CalendarInfo } from './types.js';

/**
 * The configured default calendar, checked against the calendars macOS has right now.
 *
 * `id` is the calendar a create with no calendar id goes to, or null when there is none.
 * A configured id that is gone or read-only is NOT replaced by some other calendar: the
 * create is refused with `warning` instead, because guessing is how agent-made blocks kept
 * landing on a work calendar.
 */
export interface CalendarDefaultState {
  id: string | null;
  /** What config.yaml says, or null when nothing is set. */
  configuredId: string | null;
  title?: string;
  account?: string;
  /** Set when a configured id cannot be used; says why and what to do. */
  warning?: string;
}

/**
 * `configuredId` checked against `calendars`. Never picks a replacement: an unusable configured
 * id comes back as `id: null` plus a warning (and `problem`, for the caller's log), and a create
 * without a calendar id is refused. A hidden calendar is still a valid default; the user chose it.
 */
export function describeDefaultCalendar(
  configuredId: string | null,
  calendars: CalendarInfo[],
): { state: CalendarDefaultState; problem: string | null } {
  if (!configuredId) return { state: { id: null, configuredId: null }, problem: null };
  const cal = calendars.find((c) => c.id === configuredId);
  const problem = !cal
    ? 'The default calendar is not on this Mac any more (it was deleted, or its account was removed).'
    : cal.readonly
      ? `The default calendar "${cal.title}" (${cal.account}) is read-only.`
      : null;
  if (!problem) return { state: { id: configuredId, configuredId, title: cal!.title, account: cal!.account }, problem: null };
  return {
    state: {
      id: null,
      configuredId,
      ...(cal ? { title: cal.title, account: cal.account } : {}),
      warning: `${problem} Pick another in Settings → Calendar Accounts → Default calendar.`,
    },
    problem,
  };
}
