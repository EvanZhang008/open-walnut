/**
 * The calendar cache's small pure helpers: month windows, the change hash, range filtering
 * and event id checks. Split out of service.ts so the service holds only its state machine.
 */
import { createHash } from 'node:crypto';
import { CalendarHelperError } from '../../core/calendar/helper-error.js';
import type { CalendarEvent } from './types.js';

export function eventsHash(events: CalendarEvent[]): string {
  const h = createHash('sha1');
  // status/selfStatus are part of the identity: a meeting being cancelled often
  // changes nothing else, and leaving them out meant open views never heard.
  for (const e of events)
    h.update(
      JSON.stringify([e.id, e.title, e.start, e.end, e.calendarId, e.status, e.selfStatus,
        e.readonly, e.walnutCreated, e.hasAttendees, e.organizerIsCurrentUser, e.organizerName,
        e.recurring, e.writeSafetyVersion])
    );
  return h.digest('hex');
}

/** Month-aligned cache window containing [from, to] (day strings). */
export function windowKey(from: string, to: string): string {
  return `${from.slice(0, 7)}..${to.slice(0, 7)}`;
}

export function windowRange(from: string, to: string): { from: string; to: string } {
  const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(ty, tm, 0).getDate(); // day 0 of next month = last of `tm`
  return { from: `${fy}-${pad(fm)}-01`, to: `${ty}-${pad(tm)}-${pad(lastDay)}` };
}

/** The window a cache key names. */
export function windowOfKey(key: string): { from: string; to: string } {
  const [fromMonth, toMonth] = key.split('..');
  return windowRange(`${fromMonth}-01`, `${toMonth}-01`);
}

export function filterRange(events: CalendarEvent[], from: string, to: string): CalendarEvent[] {
  return events.filter((e) => {
    const startDay = e.start.slice(0, 10);
    const endDay = e.end ? e.end.slice(0, 10) : startDay;
    return startDay <= to && endDay >= from;
  });
}

const MAX_EVENT_ID_LENGTH = 1024;

export function assertEventId(id: unknown): string {
  if (typeof id !== 'string' || id.trim() === '') throw new CalendarHelperError('event id is required', 'usage');
  if (id.length > MAX_EVENT_ID_LENGTH) throw new CalendarHelperError('event id is too long', 'usage');
  return id;
}

/** Local start day of an occurrence id "<id>#<epochSeconds>" (walnut-calendar.swift `eventJson`); null for one-off ids. */
export function occurrenceDay(id: string): string | null {
  const match = /^.+#(\d{1,10})$/.exec(id);
  if (!match) return null;
  const date = new Date(Number(match[1]) * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
