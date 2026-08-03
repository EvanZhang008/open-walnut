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
  CalendarInfo,
  CalendarSource,
} from '../../src/core/calendar/types.js';
import { CalendarHelperError } from '../../src/core/calendar/index.js';

export interface MockCalendarState {
  calendars: CalendarInfo[];
  events: CalendarEvent[];
  calls: { method: string; args: unknown[] }[];
  /** When set, every source method throws this error (e.g. permission-denied). */
  failWith: CalendarHelperError | null;
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
      start: '2026-08-05T18:00:00',
      end: '2026-08-05T19:00:00',
      allDay: false,
      color: '#34c759',
      location: 'Downtown',
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

export function createMockCalendarSource(opts?: {
  events?: CalendarEvent[];
  calendars?: CalendarInfo[];
}): { source: CalendarSource; state: MockCalendarState } {
  const state: MockCalendarState = {
    calendars: opts?.calendars ?? fixtureCalendars(),
    events: opts?.events ?? fixtureEvents(),
    calls: [],
    failWith: null,
  };
  let createdSeq = 0;

  const guard = (method: string, args: unknown[]) => {
    state.calls.push({ method, args });
    if (state.failWith) throw state.failWith;
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

    async listEvents(from: string, to: string): Promise<CalendarEvent[]> {
      guard('listEvents', [from, to]);
      // The service does its own range filtering; return everything like a
      // month-window fetch would.
      return state.events.map((e) => ({ ...e }));
    },

    async updateEvent(id: string, patch: CalendarEventPatch): Promise<CalendarEvent> {
      guard('updateEvent', [id, patch]);
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
        color: cal.color,
      };
      state.events.push(ev);
      return { ...ev };
    },

    async deleteEvent(id: string): Promise<void> {
      guard('deleteEvent', [id]);
      const ev = findEvent(id);
      assertWritable(ev.calendarId);
      state.events = state.events.filter((e) => e.id !== id);
    },
  };

  return { source, state };
}
