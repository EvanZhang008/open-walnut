/**
 * The one colour of a calendar item, for its chip and for every preview of it.
 *
 * A drag shows a block in the user's hand before anything is written: the block being
 * created, a chip being moved, copied or resized. Each used to pick its own colour (the
 * accent blue while dragging, the calendar's own colour once dropped), so a new event
 * turned from blue to purple as the mouse let go (2026-11-20). Every chip and every
 * preview takes its tint from here instead (guard: tests/web/calendar-drag-tint-guard.test.ts).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CalendarDefault, CalendarInfo } from '@/api/calendar';
import { ensureCalendarsLoaded, getCalendarSourcesEntry, subscribeCalendarSources } from '@/stores/calendar-events-store';
import type { CalendarItem } from './calendar-items';

const ACCENT = 'var(--accent)';
const DUE = 'var(--error)';

/** The CSS colour an item's chip is drawn in (`--cal-chip-tint`). */
export function chipTint(item: CalendarItem): string {
  if (item.kind === 'event') return item.event.color || ACCENT;
  return item.kind === 'task-due' ? DUE : ACCENT;
}

/** The colour a new task's chip has. */
export const NEW_TASK_TINT = ACCENT;

/**
 * The calendars a new event can go to, and the one the form starts on: the configured
 * default, not whichever calendar macOS lists first. A default that is set but unusable
 * preselects nothing (the server refuses to guess a replacement), with its warning.
 */
export function newEventCalendars(calendars: CalendarInfo[], def: CalendarDefault | undefined): {
  writable: CalendarInfo[];
  preselect: CalendarInfo | null;
  warning: string | null;
} {
  const defaultId = def?.id ?? null;
  // The default stays pickable even when hidden in Walnut: the user chose it on purpose.
  const writable = calendars.filter((c) => !c.readonly && (!c.hidden || c.id === defaultId));
  if (def?.configuredId && !defaultId) {
    return { writable, preselect: null, warning: def.warning ?? 'The default calendar cannot be used. Pick a calendar.' };
  }
  return { writable, preselect: writable.find((c) => c.id === defaultId) ?? writable[0] ?? null, warning: null };
}

/** The colour a new event will have before its form opens: its preselected calendar's. */
export function useNewEventTint(): string | undefined {
  const shared = useSyncExternalStore(subscribeCalendarSources, getCalendarSourcesEntry, getCalendarSourcesEntry);
  useEffect(() => { void ensureCalendarsLoaded(); }, []);
  if (!shared.calendarsLoaded) return undefined;
  return newEventCalendars(shared.calendars, shared.defaultCalendar).preselect?.color;
}
