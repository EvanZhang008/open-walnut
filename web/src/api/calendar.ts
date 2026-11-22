/**
 * Calendar API client — external calendar events (EventKit via the server;
 * covers ALL macOS system-account calendars: iCloud, Google, Exchange…).
 * Dates are tz-less local ISO, same contract as task dates.
 */
import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from './client';
// One rule and one id shape for the server and this browser (the server refuses exactly the
// writes this asks about first).
export { calendarEventNeedsApproval, calendarSourceOf } from '../../../src/integrations/calendar/event-rules';

/** `eventkit` for the Mac's calendars, `caldav:<mail account id>` for a mail account's calendar. */
export type CalendarSourceId = 'eventkit' | `caldav:${string}`;

export interface CalendarEvent {
  /** Stable id; a mail account's event carries its source first ("caldav:imap:<id>/..."). */
  id: string;
  source: CalendarSourceId;
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
  /** Why the event is read-only when its calendar is not (a mail account's event with other people on it). */
  readonlyReason?: string;
  /** Absent unless the source says something. 'canceled' means the organizer
   *  cancelled it and macOS still holds the row — show it struck through rather
   *  than as a live meeting. */
  status?: 'confirmed' | 'tentative' | 'canceled';
  /** The user's own answer to the invite, when the source tracks it. */
  selfStatus?: 'pending' | 'accepted' | 'declined' | 'tentative' | 'delegated';
  /** Hidden in Walnut only; the source event is untouched. Sent with `include_hidden=1`. */
  hidden?: boolean;
  walnutCreated?: boolean;
  hasAttendees?: boolean;
  organizerIsCurrentUser?: boolean;
  organizerName?: string;
  recurring?: boolean;
  writeSafetyVersion?: number;
}

export interface CalendarSourceStatus {
  id: CalendarSourceId;
  /** Set for a mail account's calendar. */
  kind?: 'caldav';
  /** The mail account it comes with (`imap:<id>`). */
  account?: string;
  /** The account's address. */
  label?: string;
  available: boolean;
  enabled: boolean;
  reason?: 'cloud' | 'permission-denied' | 'not-configured' | 'unsupported-platform' | 'fetch-error' | 'disabled' | 'needs-sign-in' | 'auth-failed' | 'no-calendar';
  message?: string;
  /** Reads work, but through a fallback the user has to fix (see CalendarPage). */
  degraded?: string;
  lastRefresh?: string;
  eventCount?: number;
}

export interface CalendarInfo {
  id: string;
  title: string;
  account: string;
  color: string;
  readonly: boolean;
  hidden: boolean;
  /** The default calendar for new events (only while it is writable). */
  default?: boolean;
}

/** `GET /sources`' check of the configured default against the calendars macOS has now. */
export interface CalendarDefault {
  /** Where a create with no calendar goes; null when nothing usable is set. */
  id: string | null;
  /** What config says, even when it is unusable. */
  configuredId: string | null;
  title?: string;
  account?: string;
  /** Why a configured default cannot be used, and what to do. */
  warning?: string;
}

export function listCalendarEvents(from: string, to: string, opts: { includeHidden?: boolean } = {}) {
  return apiGet<{ events: CalendarEvent[]; sources: CalendarSourceStatus[] }>('/api/calendar/events', {
    from,
    to,
    ...(opts.includeHidden ? { include_hidden: '1' } : {}),
  });
}

export function setCalendarEventVisibility(id: string, hidden: boolean) {
  return apiPatch<{ id: string; hidden: boolean }>(`/api/calendar/events/${encodeURIComponent(id)}/visibility`, { hidden });
}

export function listCalendarSources() {
  return apiGet<{ sources: CalendarSourceStatus[]; calendars: CalendarInfo[]; defaultCalendar?: CalendarDefault }>('/api/calendar/sources');
}

export function updateCalendarSource(patch: {
  enabled?: boolean;
  hidden_calendar_ids?: string[];
  visible_calendar_ids?: string[] | null;
  /** A writable calendar id; null clears the default. */
  default_calendar_id?: string | null;
}) {
  return apiPut<{ sources: CalendarSourceStatus[] }>('/api/calendar/sources/eventkit', patch);
}

export function refreshCalendar() {
  return apiPost<{ sources: CalendarSourceStatus[] }>('/api/calendar/refresh');
}

export function updateCalendarEvent(id: string, patch: { start: string; end: string; title?: string; human_confirm?: boolean }) {
  return apiPatch<{ event: CalendarEvent }>(`/api/calendar/events/${encodeURIComponent(id)}`, patch,
    patch.human_confirm ? { timeoutMs: 180_000, quietStatuses: [403] } : { quietStatuses: [403] });
}

export function createCalendarEvent(input: { calendarId: string; title: string; start: string; end: string; allDay?: boolean }) {
  return apiPost<{ event: CalendarEvent }>('/api/calendar/events', input);
}

export function deleteCalendarEvent(id: string, humanConfirm = false) {
  return apiDelete(`/api/calendar/events/${encodeURIComponent(id)}${humanConfirm ? '?human_confirm=1' : ''}`,
    { ...(humanConfirm ? { timeoutMs: 180_000 } : {}), quietStatuses: [403] });
}

export type AddMailCalendarAnswer =
  | { ok: true; source: CalendarSourceStatus; calendars: CalendarInfo[] }
  /** `server`: with `found-server`, a calendar server the person may pick for the account. */
  | { ok: false; reason: string; message: string; server?: string };

/**
 * Try a mail account's calendar with its saved password and, when it has one, read it from now
 * on. `server` (the person picked a server Walnut found) is saved as the account's calendar
 * server first.
 */
export function addMailCalendar(accountId: string, address: string, server?: string) {
  // Discovery may try a few URLs, each with its own deadline on the server.
  return apiPost<AddMailCalendarAnswer>(
    `/api/calendar/mail-accounts/${encodeURIComponent(accountId)}/calendar`,
    server ? { address, server } : { address },
    { timeoutMs: 60_000 },
  );
}

/** Stop reading a mail account's calendar (the calendar itself is untouched). */
export function removeMailCalendar(accountId: string) {
  return apiDelete<{ removed: boolean; sources: CalendarSourceStatus[] }>(`/api/calendar/mail-accounts/${encodeURIComponent(accountId)}/calendar`);
}
