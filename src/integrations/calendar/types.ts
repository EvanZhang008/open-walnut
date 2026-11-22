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

/**
 * Where an event comes from: the Mac's calendars (`eventkit`), or a mail account's calendar
 * read over CalDAV (`caldav:<mail account id>`). Id shapes: src/integrations/calendar/event-rules.ts.
 */
export type CalendarSourceId = 'eventkit' | `caldav:${string}`;

export interface CalendarEvent {
  /**
   * Stable occurrence id: "<ekEventId>" for one-off events,
   * "<ekEventId>#<startEpoch>" for occurrences of recurring events. A CalDAV event's id
   * carries its source first (event-rules.ts), so a write reaches the source that holds it.
   */
  id: string;
  source: CalendarSourceId;
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
  /** Why the event is read-only when its calendar is not (a mail account's event with attendees). */
  readonlyReason?: string;
  /** Omitted when the source reports nothing. Cancelled events are MARKED, never
   *  dropped: the API stays honest and each caller decides how to render them. */
  status?: CalendarEventStatus;
  /** Omitted when the source reports nothing (e.g. an event with no attendees). */
  selfStatus?: CalendarSelfStatus;
  /** Hidden in Walnut only (`hidden_event_ids`); set by CalendarService on `includeHidden` reads, never by a source. */
  hidden?: boolean;
  walnutCreated?: boolean;
  hasAttendees?: boolean;
  organizerIsCurrentUser?: boolean;
  organizerName?: string;
  recurring?: boolean;
  writeSafetyVersion?: number;
}

// One rule for every source and for the browser too: see event-rules.ts.
export { calendarEventNeedsApproval } from './event-rules.js';

export interface CalendarWriteOptions { humanConfirm?: boolean }

export interface CalendarInfo {
  id: string;
  title: string;
  account: string;
  color: string;
  readonly: boolean;
  /** User toggled this calendar off in Settings. */
  hidden: boolean;
  /** The configured default calendar (set by CalendarService, only while it is writable). */
  default?: boolean;
}

export type CalendarSourceReason =
  | 'cloud'
  | 'permission-denied'
  | 'not-configured'
  /** This machine's system has no calendar source Walnut can read (EventKit needs macOS). */
  | 'unsupported-platform'
  | 'fetch-error'
  | 'disabled'
  /** A mail account's calendar whose provider takes only its own sign-in (Google, Microsoft). */
  | 'needs-sign-in'
  /** The server refused the saved password for calendars. */
  | 'auth-failed'
  /** The server offers no calendar for this account. */
  | 'no-calendar';

export interface CalendarSourceStatus {
  id: CalendarSourceId;
  /** Set for a mail account's calendar; absent for the Mac's calendars (older clients read only `eventkit`). */
  kind?: 'caldav';
  /** The mail account this calendar comes with (`imap:<id>`), for a CalDAV source. */
  account?: string;
  /** What the user knows the source by (the account's address), for a CalDAV source. */
  label?: string;
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

/** A create as callers hand it to CalendarService: no calendar id means the configured default. */
export type CalendarEventCreateInput = Omit<CalendarEventCreate, 'calendarId'> & { calendarId?: string };

/** A pluggable event source: EventKit, and a CalDAV source per mail account that brings its calendar. */
export interface CalendarSource {
  id: CalendarSourceId;
  /** Extra status fields a non-EventKit source reports about itself (kind, account, label). */
  describe?(): Pick<CalendarSourceStatus, 'kind' | 'account' | 'label'>;
  /** Cheap static availability check (platform / cloud-mode gates). */
  available(): { ok: boolean; reason?: CalendarSourceReason; message?: string };
  /** Optional: reads work but through a degraded path, described for the user. */
  degraded?(): string | undefined;
  listCalendars(): Promise<CalendarInfo[]>;
  /** `refresh` asks the platform to pull from remote accounts first. macOS does
   *  that pull asynchronously, so it freshens the NEXT fetch, not this one —
   *  only the background refresh loop passes it. */
  listEvents(from: string, to: string, opts?: { refresh?: boolean }): Promise<CalendarEvent[]>;
  getEvent?(id: string): Promise<CalendarEvent>;
  updateEvent(id: string, patch: CalendarEventPatch, opts?: CalendarWriteOptions): Promise<CalendarEvent>;
  createEvent(input: CalendarEventCreate): Promise<CalendarEvent>;
  deleteEvent(id: string, opts?: CalendarWriteOptions): Promise<void>;
}
