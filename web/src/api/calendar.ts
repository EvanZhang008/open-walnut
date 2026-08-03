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

export interface CalendarInfo {
  id: string;
  title: string;
  account: string;
  color: string;
  readonly: boolean;
  hidden: boolean;
}

export function listCalendarEvents(from: string, to: string) {
  return apiGet<{ events: CalendarEvent[]; sources: CalendarSourceStatus[] }>('/api/calendar/events', { from, to });
}

export function listCalendarSources() {
  return apiGet<{ sources: CalendarSourceStatus[]; calendars: CalendarInfo[] }>('/api/calendar/sources');
}

export function updateCalendarSource(patch: { enabled?: boolean; hidden_calendar_ids?: string[] }) {
  return apiPut<{ sources: CalendarSourceStatus[] }>('/api/calendar/sources/eventkit', patch);
}

export function refreshCalendar() {
  return apiPost<{ sources: CalendarSourceStatus[] }>('/api/calendar/refresh');
}

export function updateCalendarEvent(id: string, patch: { start: string; end: string; title?: string }) {
  return apiPatch<{ event: CalendarEvent }>(`/api/calendar/events/${encodeURIComponent(id)}`, patch);
}

export function createCalendarEvent(input: { calendarId: string; title: string; start: string; end: string; allDay?: boolean }) {
  return apiPost<{ event: CalendarEvent }>('/api/calendar/events', input);
}

export function deleteCalendarEvent(id: string) {
  return apiDelete(`/api/calendar/events/${encodeURIComponent(id)}`);
}
