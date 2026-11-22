/**
 * One CalDAV resource (a VCALENDAR holding one event and its overrides) into the calendar's
 * events: recurring series expanded into occurrences in a range, EXDATEs left out, RDATEs
 * added, RECURRENCE-ID overrides standing in for the occurrence they replace, and every time
 * turned into the server's local tz-less ISO that EventKit events carry.
 *
 * The write-safety fields are filled exactly as the EventKit helper fills them, so one rule
 * (event-rules.ts) decides for both: Walnut made it (X-WALNUT-CREATED), it has no attendees,
 * its organizer (when there is one) is this account. An event with attendees is read-only
 * here (`readonlyReason`, event-rules.ts ATTENDEES_READONLY_TEXT).
 *
 * An occurrence's id ends in `#<key>`: the epoch seconds of its original start for a timed
 * series (UTC or in a named zone), and for an all-day or floating series the seconds of that
 * wall clock read as UTC, so the id does not change when the server's own zone does.
 */
import type { CalendarEvent, CalendarEventStatus, CalendarSelfStatus } from '../types.js';
import { ATTENDEES_READONLY_TEXT } from '../event-rules.js';
import {
  parseRuleParts,
  parseTimeValue,
  prop,
  props,
  unescapeText,
  type IcsComponent,
  type IcsProperty,
  type IcsTime,
  timeOfProp,
} from './ics.js';
import { expandRule, type SharedBudget } from './recurrence.js';
import { addDays, wallAt, wallDay, wallIso, wallToEpoch, type Wall } from './tz.js';

export const WALNUT_CREATED_PROP = 'X-WALNUT-CREATED';

export interface ResourceContext {
  /** The event id before any occurrence suffix (`caldav:<account>/<href in base64url>`). */
  baseId: string;
  sourceId: `caldav:${string}`;
  calendarId: string;
  calendarName: string;
  accountName: string;
  color?: string;
  readonly: boolean;
  /** The account's own address: which attendee is the user, and whether the user organizes. */
  selfAddress: string;
  /** The server's local zone: what the tz-less ISO strings are in. */
  localZone: string;
  /** A series cost more than its read's budget (recurrence.ts): it is named here, by title. */
  noteTruncated?: (title: string) => void;
  /** The read's budget, shared by every resource it expands (source.ts: one per listEvents). */
  budget?: SharedBudget;
}

export interface EpochRange { start: number; end: number }

/** An instant's clock for one time value: how its walls turn into instants. */
export function clockOf(t: IcsTime, localZone: string): { wall: Wall; toEpoch: (w: Wall) => number } {
  switch (t.kind) {
    case 'utc': return { wall: wallAt(t.epoch, 'UTC'), toEpoch: (w) => wallToEpoch(w, 'UTC') };
    case 'zoned': return { wall: t.wall, toEpoch: (w) => wallToEpoch(w, t.zone) };
    default: return { wall: t.wall, toEpoch: (w) => wallToEpoch(w, localZone) };
  }
}

export function epochOf(t: IcsTime, localZone: string): number {
  return t.kind === 'utc' ? t.epoch : clockOf(t, localZone).toEpoch(t.wall);
}

function timeOf(p: IcsProperty | undefined): IcsTime | null {
  return timeOfProp(p);
}

const wallUtc = (w: Wall) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);

/**
 * The occurrence key (milliseconds) of a time in a series whose DTSTART is of `seriesKind`:
 * an instant for a timed series, the wall clock read as UTC for an all-day or floating one.
 * EXDATE, RDATE and RECURRENCE-ID values written in another form are converted first.
 */
export function occurrenceKey(t: IcsTime, seriesKind: IcsTime['kind'], localZone: string): number {
  if (seriesKind !== 'date' && seriesKind !== 'floating') return epochOf(t, localZone);
  const wall = t.kind === 'utc' ? wallAt(t.epoch, localZone) : t.kind === 'zoned' ? wallAt(epochOf(t, localZone), localZone) : t.wall;
  return seriesKind === 'date' ? Date.UTC(wall.y, wall.m - 1, wall.d) : wallUtc(wall);
}

/** ISO 8601 duration ("PT1H30M", "P1D", "-PT15M") in milliseconds. */
export function durationMs(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86_400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function mailtoOf(value: string): string {
  return value.replace(/^mailto:/i, '').trim().toLowerCase();
}

const STATUS: Readonly<Record<string, CalendarEventStatus>> = { CONFIRMED: 'confirmed', TENTATIVE: 'tentative', CANCELLED: 'canceled' };
const PARTSTAT: Readonly<Record<string, CalendarSelfStatus>> = {
  'NEEDS-ACTION': 'pending', ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative', DELEGATED: 'delegated',
};

/** The VEVENTs of a resource: the series (or one-off) and its overrides, of its first UID. */
export function splitResource(calendar: IcsComponent): { master: IcsComponent | null; overrides: IcsComponent[] } {
  const events = calendar.children.filter((c) => c.name === 'VEVENT');
  if (events.length === 0) return { master: null, overrides: [] };
  const uid = prop(events[0], 'UID')?.value;
  const same = events.filter((e) => prop(e, 'UID')?.value === uid);
  const master = same.find((e) => !prop(e, 'RECURRENCE-ID')) ?? null;
  return { master, overrides: same.filter((e) => e !== master && !!prop(e, 'RECURRENCE-ID')) };
}

export function isRecurring(master: IcsComponent | null): boolean {
  return !!master && (!!prop(master, 'RRULE') || !!prop(master, 'RDATE'));
}

interface Span { start: number; end: number; allDay: boolean; startWall: Wall; endWall: Wall }

/** Where one VEVENT starts and ends, given its start (an occurrence's, or its own DTSTART). */
function spanOf(vevent: IcsComponent, startTime: IcsTime, localZone: string, master?: IcsComponent): Span {
  const allDay = startTime.kind === 'date';
  const clock = clockOf(startTime, localZone);
  const start = clock.toEpoch(clock.wall);
  const source = prop(vevent, 'DTEND') || prop(vevent, 'DURATION') ? vevent : master ?? vevent;
  const ownStart = timeOf(prop(source, 'DTSTART'));
  const endTime = timeOf(prop(source, 'DTEND'));
  const duration = prop(source, 'DURATION');
  if (allDay) {
    let days = 1;
    if (endTime && ownStart && endTime.kind === 'date' && ownStart.kind === 'date') {
      days = Math.max(1, Math.round((Date.UTC(endTime.wall.y, endTime.wall.m - 1, endTime.wall.d) - Date.UTC(ownStart.wall.y, ownStart.wall.m - 1, ownStart.wall.d)) / 86_400_000));
    } else if (duration) {
      days = Math.max(1, Math.round((durationMs(duration.value) ?? 86_400_000) / 86_400_000));
    }
    const endWall = addDays(clock.wall, days);
    return { start, end: clock.toEpoch(endWall), allDay, startWall: clock.wall, endWall };
  }
  let length = 0;
  if (endTime && ownStart) length = Math.max(0, epochOf(endTime, localZone) - epochOf(ownStart, localZone));
  else if (duration) length = Math.max(0, durationMs(duration.value) ?? 0);
  return { start, end: start + length, allDay, startWall: clock.wall, endWall: clock.wall };
}

function overlaps(span: Span, range: EpochRange): boolean {
  if (span.end <= span.start) return span.start >= range.start && span.start < range.end;
  return span.start < range.end && span.end > range.start;
}

/** What every occurrence of one VEVENT shares, read once per resource read (a series may give thousands). */
const fieldsMemo = new WeakMap<IcsComponent, { master: IcsComponent; ctx: ResourceContext; title: string; tail: Partial<CalendarEvent> }>();

function fieldsOf(vevent: IcsComponent, master: IcsComponent, ctx: ResourceContext) {
  const hit = fieldsMemo.get(vevent);
  if (hit && hit.master === master && hit.ctx === ctx) return hit;
  const summary = prop(vevent, 'SUMMARY') ?? prop(master, 'SUMMARY');
  const location = prop(vevent, 'LOCATION') ?? prop(master, 'LOCATION');
  const status = STATUS[(prop(vevent, 'STATUS')?.value ?? '').trim().toUpperCase()];
  const attendees = props(vevent, 'ATTENDEE');
  const self = attendees.find((a) => mailtoOf(a.value) === ctx.selfAddress.toLowerCase());
  const selfStatus = self ? PARTSTAT[(self.params.PARTSTAT ?? 'NEEDS-ACTION').toUpperCase()] : undefined;
  const organizer = prop(vevent, 'ORGANIZER') ?? prop(master, 'ORGANIZER');
  // An occurrence of a series with other people on it is theirs too: a change to it reaches them
  // through the series (an EXDATE on the master), even when its own override lists nobody.
  const shared = attendees.length > 0 || (master !== vevent && props(master, 'ATTENDEE').length > 0);
  const tail: Partial<CalendarEvent> = {
    ...(ctx.color ? { color: ctx.color } : {}),
    ...(location && location.value ? { location: unescapeText(location.value) } : {}),
    ...(ctx.readonly || shared ? { readonly: true } : {}),
    ...(!ctx.readonly && shared ? { readonlyReason: ATTENDEES_READONLY_TEXT } : {}),
    ...(status ? { status } : {}),
    ...(selfStatus ? { selfStatus } : {}),
    writeSafetyVersion: 1,
    walnutCreated: !!prop(master, WALNUT_CREATED_PROP) || !!prop(vevent, WALNUT_CREATED_PROP),
    hasAttendees: shared,
    ...(organizer ? { organizerIsCurrentUser: mailtoOf(organizer.value) === ctx.selfAddress.toLowerCase() } : {}),
    ...(organizer ? { organizerName: organizer.params.CN || mailtoOf(organizer.value) } : {}),
  };
  const made = { master, ctx, title: summary ? unescapeText(summary.value) : '', tail };
  fieldsMemo.set(vevent, made);
  return made;
}

function toCalendarEvent(vevent: IcsComponent, span: Span, id: string, recurring: boolean, master: IcsComponent, ctx: ResourceContext): CalendarEvent {
  const fields = fieldsOf(vevent, master, ctx);
  const local = (epoch: number) => wallIso(wallAt(epoch, ctx.localZone));
  // All-day: the last day the event covers, inclusive, as EventKit reports it.
  const lastDay = span.allDay ? addDays(span.endWall, -1) : null;
  return {
    id,
    source: ctx.sourceId,
    calendarId: ctx.calendarId,
    calendarName: ctx.calendarName,
    accountName: ctx.accountName,
    title: fields.title,
    start: span.allDay ? wallDay(span.startWall) : local(span.start),
    end: span.allDay ? wallDay(lastDay && wallDay(lastDay) >= wallDay(span.startWall) ? lastDay : span.startWall) : local(span.end),
    allDay: span.allDay,
    ...fields.tail,
    recurring,
  } as CalendarEvent;
}

/** The occurrence key of an id ("...#<epoch seconds>"), or null for a one-off. */
export function occurrenceOf(id: string): number | null {
  const m = /#(\d{1,12})$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** The series' DTSTART kind, which decides how occurrence keys are formed. */
export function seriesKindOf(master: IcsComponent | null, overrides: IcsComponent[]): IcsTime['kind'] {
  if (master) return timeOf(prop(master, 'DTSTART'))?.kind ?? 'utc';
  const first = overrides[0];
  return (first ? (timeOf(prop(first, 'RECURRENCE-ID')) ?? timeOf(prop(first, 'DTSTART')))?.kind : undefined) ?? 'utc';
}

/** The most instances one resource gives one read; past it the series reads as truncated. */
export const MAX_INSTANCES = 2000;
/** The most RDATE and EXDATE values one resource is read for (each costs a parse). */
const MAX_LISTED_VALUES = 20_000;
/** How far back a range is widened for an occurrence that started earlier and still runs. */
const MAX_LONGEST_MS = 366 * 86_400_000;

/** The longest an occurrence lasts, for widening a range so one that started earlier still shows. */
function longestSpanMs(master: IcsComponent, startTime: IcsTime, localZone: string): number {
  const span = spanOf(master, startTime, localZone);
  return Math.min(MAX_LONGEST_MS, Math.max(0, span.end - span.start) + 86_400_000);
}

/**
 * The listed times of `name` (RDATE, EXDATE) that pass `keep`, at most `room.left` values parsed;
 * false when some were left unread.
 */
function eachListed(master: IcsComponent, name: string, room: { left: number; used: number }, keep: (t: IcsTime) => boolean, use: (t: IcsTime) => void): boolean {
  for (const p of props(master, name)) {
    let at = 0;
    while (at <= p.value.length) {
      if (room.left <= 0) return false;
      room.left--;
      room.used++;
      const comma = p.value.indexOf(',', at);
      const end = comma === -1 ? p.value.length : comma;
      const t = parseTimeValue(p.value.slice(at, end), p.params, p.zone);
      if (t && keep(t)) use(t);
      at = end + 1;
    }
  }
  return true;
}

/** Every instance of the resource that overlaps `range`, in start order. */
export function eventsOfResource(calendar: IcsComponent, ctx: ResourceContext, range: EpochRange): CalendarEvent[] {
  const { master, overrides } = splitResource(calendar);
  const kind = seriesKindOf(master, overrides);
  const idOf = (key: number) => `${ctx.baseId}#${Math.floor(key / 1000)}`;
  if (!master) {
    // Only overrides (a server that sent just the instances asked for): each stands alone.
    return overrides.flatMap((o) => {
      const t = timeOf(prop(o, 'DTSTART'));
      const rid = timeOf(prop(o, 'RECURRENCE-ID'));
      if (!t || !rid) return [];
      const span = spanOf(o, t, ctx.localZone);
      return overlaps(span, range) ? [toCalendarEvent(o, span, idOf(occurrenceKey(rid, kind, ctx.localZone)), true, o, ctx)] : [];
    });
  }
  const startTime = timeOf(prop(master, 'DTSTART'));
  if (!startTime) return [];
  const recurring = isRecurring(master) || overrides.length > 0;
  if (!recurring) {
    const span = spanOf(master, startTime, ctx.localZone);
    return overlaps(span, range) ? [toCalendarEvent(master, span, ctx.baseId, false, master, ctx)] : [];
  }
  const clock = clockOf(startTime, ctx.localZone);
  const longest = longestSpanMs(master, startTime, ctx.localZone);
  let cut = false;
  const noteCut = () => {
    if (!cut) ctx.noteTruncated?.(unescapeText(prop(master, 'SUMMARY')?.value ?? ''));
    cut = true;
  };
  const ruleProp = prop(master, 'RRULE');
  const walls = ruleProp
    ? expandRule({
      start: clock.wall,
      rule: parseRuleParts(ruleProp.value),
      toEpoch: clock.toEpoch,
      rangeEndEpoch: range.end,
      rangeStartEpoch: range.start - longest,
      dateOnly: startTime.kind === 'date',
      onTruncated: noteCut,
      shared: ctx.budget,
    })
    : [clock.wall];
  // Values far outside the range are dropped before any zone work (a resource may list
  // thousands of RDATEs); two days of slack cover any zone.
  const near = (t: IcsTime) => {
    const rough = t.kind === 'utc' ? t.epoch : wallUtc(t.wall);
    return rough >= range.start - longest - 2 * 86_400_000 && rough <= range.end + 2 * 86_400_000;
  };
  const starts = new Map<number, IcsTime>();
  for (const w of walls) {
    const t: IcsTime = startTime.kind === 'date' ? { kind: 'date', wall: w }
      : startTime.kind === 'zoned' ? { ...startTime, wall: w }
        : startTime.kind === 'utc' ? { kind: 'utc', epoch: clock.toEpoch(w) }
          : { ...startTime, wall: w };
    starts.set(occurrenceKey(t, kind, ctx.localZone), t);
  }
  // Listed values cost a parse each, taken from the read's budget too; a resource holding more
  // RDATEs than one read can show is cut at MAX_INSTANCES beyond what the rule gave.
  const room = { left: Math.min(MAX_LISTED_VALUES, ctx.budget?.left ?? MAX_LISTED_VALUES), used: 0 };
  const full = () => starts.size >= walls.length + MAX_INSTANCES;
  const listedAll = eachListed(master, 'RDATE', room, near, (t) => {
    starts.set(occurrenceKey(t, kind, ctx.localZone), t);
    if (full()) room.left = 0; // the rest could not be shown anyway
  })
    && eachListed(master, 'EXDATE', room, near, (t) => starts.delete(occurrenceKey(t, kind, ctx.localZone)));
  if (ctx.budget) ctx.budget.left -= room.used;
  if (!listedAll || full()) noteCut();
  const overridden = new Set<number>();
  const out: CalendarEvent[] = [];
  for (const o of overrides) {
    const rid = timeOf(prop(o, 'RECURRENCE-ID'));
    const t = timeOf(prop(o, 'DTSTART'));
    if (!rid || !t) continue;
    const key = occurrenceKey(rid, kind, ctx.localZone);
    overridden.add(key);
    const span = spanOf(o, t, ctx.localZone, master);
    if (overlaps(span, range)) out.push(toCalendarEvent(o, span, idOf(key), true, master, ctx));
  }
  // Earliest first, so a cut at MAX_INSTANCES keeps the start of the range.
  for (const key of [...starts.keys()].sort((a, b) => a - b)) {
    if (overridden.has(key)) continue;
    if (out.length >= MAX_INSTANCES) { noteCut(); break; }
    const span = spanOf(master, starts.get(key)!, ctx.localZone);
    if (overlaps(span, range)) out.push(toCalendarEvent(master, span, idOf(key), true, master, ctx));
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/**
 * The one instance an id names, with bounded work: an override is found by its RECURRENCE-ID
 * wherever it was moved to; another occurrence by expanding only the days around its key; the
 * id of a series without `#` (an older link) names its first occurrence. Null when none.
 */
export function instanceOf(calendar: IcsComponent, ctx: ResourceContext, occurrence: number | null): CalendarEvent | null {
  const { master, overrides } = splitResource(calendar);
  const startTime = master ? timeOf(prop(master, 'DTSTART')) : null;
  if (occurrence === null) {
    if (!master || !startTime) return null;
    const from = epochOf(startTime, ctx.localZone);
    // The first month nearly always holds it; two years hold the first occurrence of any rule.
    for (const days of [31, 2 * 366]) {
      const first = eventsOfResource(calendar, ctx, { start: from - 86_400_000, end: from + days * 86_400_000 })[0];
      if (first) return first;
    }
    return null;
  }
  const id = `${ctx.baseId}#${occurrence}`;
  const kind = seriesKindOf(master, overrides);
  const override = overrides.find((o) => {
    const rid = timeOf(prop(o, 'RECURRENCE-ID'));
    return !!rid && Math.floor(occurrenceKey(rid, kind, ctx.localZone) / 1000) === occurrence;
  });
  if (override) {
    const t = timeOf(prop(override, 'DTSTART'));
    if (!t) return null;
    const span = spanOf(override, t, ctx.localZone, master ?? undefined);
    return toCalendarEvent(override, span, id, true, master ?? override, ctx);
  }
  if (!master || !startTime) return null;
  const at = occurrence * 1000;
  const around: EpochRange = { start: at - 2 * 86_400_000, end: at + 2 * 86_400_000 };
  return eventsOfResource(calendar, ctx, around).find((e) => e.id === id) ?? null;
}
