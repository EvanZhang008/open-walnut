/**
 * Stateful mock CalendarSource for calendar route/tool tests.
 *
 * Behaves like the EventKit source: fixture calendars + events, write methods
 * mutate the fixture list (so write-through re-reads observe the change),
 * readonly calendars reject writes, and every call is recorded for assertions.
 */
import type {
  CalendarEvent,
  CalendarEventCreate,
  CalendarEventPatch,
  CalendarWriteOptions,
  CalendarInfo,
  CalendarSource,
} from '../../src/integrations/calendar/types.js';
import { CalendarHelperError } from '../../src/core/calendar/sources/eventkit.js';

export interface MockCalendarState {
  calendars: CalendarInfo[];
  events: CalendarEvent[];
  calls: { method: string; args: unknown[] }[];
  /** When set, every source method throws this error (e.g. permission-denied). */
  failWith: CalendarHelperError | null;
  humanConfirmation: boolean;
}

export function fixtureCalendars(): CalendarInfo[] {
  return [
    { id: 'cal-work', title: 'Work', account: 'Google', color: '#4285f4', readonly: false, hidden: false },
    { id: 'cal-home', title: 'Home', account: 'iCloud', color: '#34c759', readonly: false, hidden: false },
    { id: 'cal-holidays', title: 'Holidays', account: 'iCloud', color: '#ff9500', readonly: true, hidden: false },
  ];
}

export function fixtureEvents(): CalendarEvent[] {
  return [
    {
      id: 'ev-standup',
      source: 'eventkit',
      calendarId: 'cal-work',
      calendarName: 'Work',
      accountName: 'Google',
      title: 'Standup',
      walnutCreated: true,
      hasAttendees: false,
      writeSafetyVersion: 1,
      start: '2026-08-04T09:00:00',
      end: '2026-08-04T09:30:00',
      allDay: false,
      color: '#4285f4',
    },
    {
      // Recurring occurrence — id contains '#', must survive URL encoding.
      id: 'ev-gym#1770000000',
      source: 'eventkit',
      calendarId: 'cal-home',
      calendarName: 'Home',
      accountName: 'iCloud',
      title: 'Gym',
      walnutCreated: true,
      hasAttendees: false,
      recurring: true,
      writeSafetyVersion: 1,
      start: '2026-08-05T18:00:00',
      end: '2026-08-05T19:00:00',
      allDay: false,
      color: '#34c759',
      location: 'Downtown',
    },
    {
      // Organizer cancelled it, macOS still holds the row: must be MARKED in
      // API responses, not dropped and not served as a normal meeting.
      id: 'ev-canceled',
      source: 'eventkit',
      calendarId: 'cal-work',
      calendarName: 'Work',
      accountName: 'Google',
      title: 'Canceled: Budget review',
      start: '2026-08-06T14:00:00',
      end: '2026-08-06T15:00:00',
      allDay: false,
      color: '#4285f4',
      status: 'canceled',
      selfStatus: 'accepted',
    },
    {
      id: 'ev-declined',
      source: 'eventkit',
      calendarId: 'cal-work',
      calendarName: 'Work',
      accountName: 'Google',
      title: 'Optional all-hands',
      start: '2026-08-06T16:00:00',
      end: '2026-08-06T17:00:00',
      allDay: false,
      color: '#4285f4',
      status: 'confirmed',
      selfStatus: 'declined',
    },
    {
      id: 'ev-outside',
      source: 'eventkit',
      calendarId: 'cal-work',
      calendarName: 'Work',
      accountName: 'Google',
      title: 'Next-week planning',
      start: '2026-08-12T10:00:00',
      end: '2026-08-12T11:00:00',
      allDay: false,
      color: '#4285f4',
    },
    {
      id: 'ev-holiday',
      source: 'eventkit',
      calendarId: 'cal-holidays',
      calendarName: 'Holidays',
      accountName: 'iCloud',
      title: 'Summer Day',
      start: '2026-08-07',
      end: '2026-08-07',
      allDay: true,
      color: '#ff9500',
      readonly: true,
    },
  ];
}

/** The local date, as a day string. */
export function localDay(at = new Date()): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/** `day` (YYYY-MM-DD, with any time after it) moved by `days` whole days. */
export function shiftDay(value: string, days: number): string {
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10) + value.slice(10);
}

export function createMockCalendarSource(opts?: {
  events?: CalendarEvent[];
  calendars?: CalendarInfo[];
  /** The events are written for this day and move with the local date: when the date changes,
   *  every event moves by as many days. The browser fixture's events sit on the day it booted,
   *  and a run that went past midnight found none on its own today (2026-11-11, CI: a shard that
   *  booted at 23:49 ran its calendar specs after midnight, and every one waited for its event). */
  followToday?: { day: string; now?: () => Date };
}): { source: CalendarSource; state: MockCalendarState } {
  const state: MockCalendarState = {
    calendars: opts?.calendars ?? fixtureCalendars(),
    events: opts?.events ?? fixtureEvents(),
    calls: [],
    failWith: null,
    humanConfirmation: false,
  };
  let createdSeq = 0;

  let anchor = opts?.followToday?.day;
  const followToday = () => {
    if (!anchor) return;
    const today = localDay(opts?.followToday?.now?.() ?? new Date());
    if (today === anchor) return;
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000);
    for (const ev of state.events) { ev.start = shiftDay(ev.start, days); ev.end = shiftDay(ev.end, days); }
    anchor = today;
  };

  const guard = (method: string, args: unknown[]) => {
    state.calls.push({ method, args });
    if (state.failWith) throw state.failWith;
    followToday();
  };

  const findEvent = (id: string): CalendarEvent => {
    const ev = state.events.find((e) => e.id === id);
    if (!ev) throw new CalendarHelperError(`event not found: ${id}`, 'not-found');
    return ev;
  };

  const assertWritable = (calendarId: string) => {
    const cal = state.calendars.find((c) => c.id === calendarId);
    if (!cal) throw new CalendarHelperError(`calendar not found: ${calendarId}`, 'not-found');
    if (cal.readonly) throw new CalendarHelperError(`calendar is read-only: ${cal.title}`, 'readonly');
  };

  const source: CalendarSource = {
    id: 'eventkit',
    available: () => ({ ok: true }),

    async listCalendars(): Promise<CalendarInfo[]> {
      guard('listCalendars', []);
      return state.calendars.map((c) => ({ ...c }));
    },

    async listEvents(from: string, to: string, opts?: { refresh?: boolean }): Promise<CalendarEvent[]> {
      guard('listEvents', [from, to, ...(opts ? [opts] : [])]);
      // The service does its own range filtering; return everything like a
      // month-window fetch would.
      return state.events.map((e) => ({ ...e }));
    },

    async getEvent(id: string): Promise<CalendarEvent> {
      guard('getEvent', [id]);
      return { ...findEvent(id) };
    },

    async updateEvent(id: string, patch: CalendarEventPatch, opts?: CalendarWriteOptions): Promise<CalendarEvent> {
      guard('updateEvent', [id, patch]);
      if (opts?.humanConfirm && !state.humanConfirmation) throw new CalendarHelperError('Calendar confirmation canceled.', 'approval-canceled');
      const ev = findEvent(id);
      assertWritable(ev.calendarId);
      if (patch.start) ev.start = patch.start;
      if (patch.end) ev.end = patch.end;
      if (patch.title !== undefined) ev.title = patch.title;
      return { ...ev };
    },

    async createEvent(input: CalendarEventCreate): Promise<CalendarEvent> {
      guard('createEvent', [input]);
      assertWritable(input.calendarId);
      const cal = state.calendars.find((c) => c.id === input.calendarId)!;
      const ev: CalendarEvent = {
        id: `ev-created-${++createdSeq}`,
        source: 'eventkit',
        calendarId: cal.id,
        calendarName: cal.title,
        accountName: cal.account,
        title: input.title,
        start: input.start,
        end: input.end,
        allDay: !!input.allDay,
        walnutCreated: true,
        hasAttendees: false,
        writeSafetyVersion: 1,
        recurring: false,
        color: cal.color,
      };
      state.events.push(ev);
      return { ...ev };
    },

    async deleteEvent(id: string, opts?: CalendarWriteOptions): Promise<void> {
      guard('deleteEvent', [id]);
      if (opts?.humanConfirm && !state.humanConfirmation) throw new CalendarHelperError('Calendar confirmation canceled.', 'approval-canceled');
      const ev = findEvent(id);
      assertWritable(ev.calendarId);
      state.events = state.events.filter((e) => e.id !== id);
    },
  };

  return { source, state };
}
