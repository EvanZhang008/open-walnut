/**
 * Calendar subsystem types — external calendar events surfaced in the
 * calendar view (and to agents via calendar_* tools / REST).
 *
 * Timezone contract: all event dates are SERVER-LOCAL wall time serialized as
 * tz-less ISO strings — "2026-08-05T09:00:00", or "2026-08-05" for all-day —
 * exactly matching the task start_date/due_date contract.
 */

export interface CalendarEvent {
  /**
   * Stable occurrence id: "<ekEventId>" for one-off events,
   * "<ekEventId>#<startEpoch>" for occurrences of recurring events.
   */
  id: string;
  source: 'eventkit';
  calendarId: string;
  calendarName: string;
  /** Owning account ("iCloud", "Google", "Exchange", "Local"). */
  accountName: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  /** Calendar color hex from the source. */
  color?: string;
  location?: string;
  /** Calendar disallows writes (subscriptions, holidays, shared read-only). */
  readonly?: boolean;
}

export interface CalendarInfo {
  id: string;
  title: string;
  account: string;
  color: string;
  readonly: boolean;
  /** User toggled this calendar off in Settings. */
  hidden: boolean;
}

export type CalendarSourceReason =
  | 'cloud'
  | 'permission-denied'
  | 'not-configured'
  | 'fetch-error'
  | 'disabled';

export interface CalendarSourceStatus {
  id: 'eventkit';
  available: boolean;
  enabled: boolean;
  reason?: CalendarSourceReason;
  /** Human-actionable detail (e.g. the TCC grant instructions). */
  message?: string;
  lastRefresh?: string;
  eventCount?: number;
}

export interface CalendarEventPatch {
  start?: string;
  end?: string;
  title?: string;
}

export interface CalendarEventCreate {
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
}

/** A pluggable event source (EventKit today; a direct API source later). */
export interface CalendarSource {
  id: 'eventkit';
  /** Cheap static availability check (platform / cloud-mode gates). */
  available(): { ok: boolean; reason?: CalendarSourceReason; message?: string };
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(from: string, to: string): Promise<CalendarEvent[]>;
  updateEvent(id: string, patch: CalendarEventPatch): Promise<CalendarEvent>;
  createEvent(input: CalendarEventCreate): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}
