/**
 * Microsoft Graph's calendar events as the calendar's events, and back.
 *
 * Graph expands recurring series itself (calendarView answers one item per occurrence, each with
 * its own id), so nothing is expanded here. Times are asked for in UTC (`Prefer:
 * outlook.timezone="UTC"`) and shown in the server's local zone; an all-day event is a span of
 * dates, its end exclusive, read as the last day it covers (as EventKit reports it).
 *
 * The write-safety fields are filled the way every source fills them (event-rules.ts): Walnut
 * made it (its own extended property, set when Walnut creates an event), it has no attendees, and
 * its organizer is the user (`isOrganizer`). An event with attendees is read-only here.
 */
import { ATTENDEES_READONLY_TEXT } from '../event-rules.js';
import type { CalendarEvent, CalendarEventStatus, CalendarSelfStatus } from '../types.js';
import { addDays, parseLocalIso, resolveZone, wallAt, wallDay, wallIso, wallToEpoch } from '../caldav/tz.js';

/** The extended property Walnut puts on the events it makes (a property set of Walnut's own). */
export const WALNUT_CREATED_PROPERTY = 'String {0b9f7b8e-6d1a-4c5e-9c7a-57616c6e7574} Name WalnutCreated';

export const EVENT_SELECT = 'id,subject,start,end,isAllDay,location,attendees,organizer,isOrganizer,isCancelled,responseStatus,type';
export const EVENT_EXPAND = `singleValueExtendedProperties($filter=id eq '${WALNUT_CREATED_PROPERTY}')`;

export interface GraphDateTime { dateTime?: string; timeZone?: string }

export interface GraphEvent {
  id: string;
  '@odata.etag'?: string;
  subject?: string;
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  location?: { displayName?: string };
  attendees?: Array<{ emailAddress?: { address?: string; name?: string } }>;
  organizer?: { emailAddress?: { address?: string; name?: string } };
  isOrganizer?: boolean;
  isCancelled?: boolean;
  responseStatus?: { response?: string };
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  singleValueExtendedProperties?: Array<{ id?: string; value?: string }>;
}

export interface GraphCalendarInfo {
  id: string;
  /** The calendar's id in the calendar's own form (`caldav:<account>/<b64>`). */
  walnutId: string;
  title: string;
  color: string;
  readonly: boolean;
}

export interface EventContext {
  sourceId: `caldav:${string}`;
  eventId: (calendarId: string, graphId: string) => string;
  calendar: GraphCalendarInfo;
  accountName: string;
  localZone: string;
}

const SELF: Readonly<Record<string, CalendarSelfStatus>> = {
  accepted: 'accepted',
  declined: 'declined',
  tentativelyAccepted: 'tentative',
  notResponded: 'pending',
};

/** A Graph time as an instant: UTC unless it names another zone this platform knows. */
export function epochOf(t: GraphDateTime | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(t?.dateTime ?? '');
  if (!m) return null;
  const wall = { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] ?? 0) };
  const zone = !t?.timeZone || /^(utc|gmt|etc\/utc)$/i.test(t.timeZone) ? 'UTC' : resolveZone(t.timeZone) ?? 'UTC';
  return wallToEpoch(wall, zone);
}

function dateOf(t: GraphDateTime | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t?.dateTime ?? '');
  return m ? m[1] : null;
}

/** One Graph event as a calendar event; null when it has no times Walnut can read. */
export function toCalendarEvent(e: GraphEvent, ctx: EventContext): CalendarEvent | null {
  const attendees = (e.attendees ?? []).filter((a) => a.emailAddress?.address);
  const shared = attendees.length > 0;
  const readonly = ctx.calendar.readonly || shared;
  let start: string;
  let end: string;
  if (e.isAllDay) {
    const from = dateOf(e.start);
    const to = dateOf(e.end);
    if (!from) return null;
    const first = parseLocalIso(from)!.wall;
    const last = to ? addDays(parseLocalIso(to)!.wall, -1) : first;
    start = from;
    end = wallDay(last) >= from ? wallDay(last) : from;
  } else {
    const a = epochOf(e.start);
    const b = epochOf(e.end);
    if (a === null) return null;
    start = wallIso(wallAt(a, ctx.localZone));
    end = wallIso(wallAt(b ?? a, ctx.localZone));
  }
  const selfStatus = e.isOrganizer ? undefined : SELF[e.responseStatus?.response ?? ''];
  const status: CalendarEventStatus | undefined = e.isCancelled ? 'canceled' : undefined;
  const organizer = e.organizer?.emailAddress;
  const walnutCreated = (e.singleValueExtendedProperties ?? []).some((p) => p.id?.toLowerCase() === WALNUT_CREATED_PROPERTY.toLowerCase() && /^true$/i.test(p.value ?? ''));
  return {
    id: ctx.eventId(ctx.calendar.id, e.id),
    source: ctx.sourceId,
    calendarId: ctx.calendar.walnutId,
    calendarName: ctx.calendar.title,
    accountName: ctx.accountName,
    title: e.subject ?? '',
    start,
    end,
    allDay: e.isAllDay === true,
    color: ctx.calendar.color,
    ...(e.location?.displayName ? { location: e.location.displayName } : {}),
    ...(readonly ? { readonly: true } : {}),
    ...(!ctx.calendar.readonly && shared ? { readonlyReason: ATTENDEES_READONLY_TEXT } : {}),
    ...(status ? { status } : {}),
    ...(selfStatus ? { selfStatus } : {}),
    writeSafetyVersion: 1,
    walnutCreated,
    hasAttendees: shared,
    ...(organizer?.address ? { organizerIsCurrentUser: e.isOrganizer === true, organizerName: organizer.name || organizer.address } : {}),
    recurring: e.type === 'occurrence' || e.type === 'exception',
  };
}

/**
 * The start and end of a write, from the calendar contract's local times: an all-day event as
 * dates at midnight in the local zone (its end the day after its last), a timed one as UTC.
 */
export function graphTimes(startIso: string, endIso: string, zone: string): { start: GraphDateTime; end: GraphDateTime; isAllDay: boolean } | null {
  const a = parseLocalIso(startIso);
  const b = parseLocalIso(endIso);
  if (!a || !b) return null;
  if (a.dateOnly || b.dateOnly) {
    const last = b.dateOnly ? b.wall : a.wall;
    return {
      // Midnight in the person's own zone: Outlook keeps an all-day event in the zone it was made
      // in, and one made at UTC midnight shows across two days west or east of UTC.
      start: { dateTime: `${wallDay(a.wall)}T00:00:00`, timeZone: zone },
      end: { dateTime: `${wallDay(addDays(last, 1))}T00:00:00`, timeZone: zone },
      isAllDay: true,
    };
  }
  const utc = (wall: typeof a.wall) => new Date(wallToEpoch(wall, zone)).toISOString().replace(/\.\d{3}Z$/, '');
  return { start: { dateTime: utc(a.wall), timeZone: 'UTC' }, end: { dateTime: utc(b.wall), timeZone: 'UTC' }, isAllDay: false };
}
