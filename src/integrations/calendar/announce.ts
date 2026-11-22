/**
 * How the calendar service tells the world a window changed. See {@link setCalendarAnnouncer}.
 */
import { bus, EventNames } from '../../core/event-bus.js';
import type { CalendarSourceStatus } from './types.js';

/** What the service announces after a change. See {@link setCalendarAnnouncer}. */
export interface CalendarUpdatePayload {
  status: CalendarSourceStatus;
  /** Every source's status, present while a mail account's calendar is read too. */
  sources?: CalendarSourceStatus[];
}

/**
 * How the service tells the world a window changed.
 *
 * Installed by the plugin's `activate` so the event rides the HOST's bus as
 * `plugin:calendar:updated` (which core forwards to the legacy `calendar:updated`). That
 * indirection is not ceremony: a builtin plugin is its own bundle, so a `bus` imported
 * here is a DIFFERENT EventBus instance from the server's in a built install, and an event
 * emitted on it would reach nobody. The direct fallback below keeps a service built
 * outside the plugin lifecycle (a unit test) observable.
 */
let announcer: ((payload: CalendarUpdatePayload) => void) | null = null;

export function setCalendarAnnouncer(fn: ((payload: CalendarUpdatePayload) => void) | null): void {
  announcer = fn;
}

export function announce(payload: CalendarUpdatePayload): void {
  if (announcer) {
    announcer(payload);
    return;
  }
  bus.emit(EventNames.CALENDAR_UPDATED, payload, ['web-ui'], { source: 'calendar' });
}

