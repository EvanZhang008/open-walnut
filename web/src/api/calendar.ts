/**
 * Calendar API client — external calendar events (EventKit via the server).
 * Types land in Phase 1 (calendar-items consumes them); fetchers in Phase 2.
 */

export interface CalendarEvent {
  /** Source-prefixed stable id, e.g. "eventkit:<ekEventId>". */
  id: string;
  source: 'eventkit';
  calendarId: string;
  calendarName: string;
  /** Owning account, e.g. "iCloud", "Google" — how users tell calendars apart. */
  accountName: string;
  title: string;
  /** Tz-less local ISO, same contract as task dates. */
  start: string;
  end: string;
  allDay: boolean;
  /** Calendar color (hex) from the source, drives chip tint. */
  color?: string;
  location?: string;
  /** True when the source calendar can't be written (subscriptions, holidays). */
  readonly?: boolean;
}

export interface CalendarSourceStatus {
  id: 'eventkit';
  available: boolean;
  enabled: boolean;
  reason?: 'cloud' | 'permission-denied' | 'not-configured' | 'fetch-error' | 'disabled';
  message?: string;
  lastRefresh?: string;
  eventCount?: number;
}
