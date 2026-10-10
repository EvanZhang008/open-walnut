/**
 * Calendar API client — external calendar events (EventKit via the server;
 * covers ALL macOS system-account calendars: iCloud, Google, Exchange…).
 * Dates are tz-less local ISO, same contract as task dates.
 */
import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from './client';

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

export function calendarEventNeedsApproval(event: CalendarEvent): boolean {
  return event.writeSafetyVersion !== 1 || event.walnutCreated !== true || event.hasAttendees !== false ||
    (event.organizerIsCurrentUser !== undefined && event.organizerIsCurrentUser !== true);
}

export interface CalendarSourceStatus {
  id: 'eventkit';
  available: boolean;
  enabled: boolean;
  reason?: 'cloud' | 'permission-denied' | 'not-configured' | 'fetch-error' | 'disabled';
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
