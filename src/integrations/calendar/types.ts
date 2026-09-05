/**
 * Calendar subsystem types — external calendar events surfaced in the
 * calendar view (and to agents via calendar_* tools / REST).
 *
 * Timezone contract: all event dates are SERVER-LOCAL wall time serialized as
 * tz-less ISO strings — "2026-08-05T09:00:00", or "2026-08-05" for all-day —
 * exactly matching the task start_date/due_date contract.
 */

/**
 * Source-reported lifecycle of the event itself. 'canceled' is the one that
 * matters: an invitation the organizer cancelled STAYS in the EventKit store
 * (often re-titled "Canceled: …") until someone processes the cancellation, so
 * without this field it is indistinguishable from a live meeting.
 * Absent means the source said nothing (normal for personal, non-invite events).
 */
export type CalendarEventStatus = 'confirmed' | 'tentative' | 'canceled';

/** The current user's own response to an invitation, when the source tracks it. */
export type CalendarSelfStatus = 'pending' | 'accepted' | 'declined' | 'tentative' | 'delegated';

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
  /** Omitted when the source reports nothing. Cancelled events are MARKED, never
   *  dropped: the API stays honest and each caller decides how to render them. */
  status?: CalendarEventStatus;
  /** Omitted when the source reports nothing (e.g. an event with no attendees). */
  selfStatus?: CalendarSelfStatus;
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
  /** Working, but not the way it should be: reads are coming from an older helper
   *  generation that still holds the macOS grant. Says what the user should fix. */
  degraded?: string;
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
  /** Optional: reads work but through a degraded path, described for the user. */
  degraded?(): string | undefined;
  listCalendars(): Promise<CalendarInfo[]>;
  /** `refresh` asks the platform to pull from remote accounts first. macOS does
   *  that pull asynchronously, so it freshens the NEXT fetch, not this one —
   *  only the background refresh loop passes it. */
  listEvents(from: string, to: string, opts?: { refresh?: boolean }): Promise<CalendarEvent[]>;
  updateEvent(id: string, patch: CalendarEventPatch): Promise<CalendarEvent>;
  createEvent(input: CalendarEventCreate): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}
