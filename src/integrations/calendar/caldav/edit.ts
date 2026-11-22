/**
 * The changes Walnut makes to a CalDAV event, as edits of its iCalendar text: a new event, a
 * move or rename (of a one-off, or of one occurrence through a RECURRENCE-ID override), and
 * the removal of one occurrence (an EXDATE). Every property Walnut does not change stays as
 * the server sent it (ics.ts keeps the source lines).
 *
 * New times are written in the style the event already uses: in its own TZID when it has one
 * (its VTIMEZONE is already in the resource), in UTC when it was UTC, as a date when it is an
 * all-day event. A new event is written in UTC, which needs no VTIMEZONE.
 *
 * A whole repeating series moves only within its own day (a new time of day, a new length or
 * title): its EXDATEs, RDATEs, overrides' RECURRENCE-IDs and a date-time UNTIL move by the same
 * amount, so a removed occurrence stays removed and a changed one stays changed. Moving a series
 * to another day would also mean rewriting its BYDAY / BYMONTHDAY rule, so it is refused.
 */
import { randomUUID } from 'node:crypto';
import { CalendarHelperError } from '../../../core/calendar/helper-error.js';
import {
  escapeText,
  formatDateValue,
  formatWallValue,
  parseRuleParts,
  parseTimeList,
  parseTimeValue,
  prop,
  props,
  removeProps,
  setProp,
  timeOfProp,
  type IcsComponent,
  type IcsProperty,
  type IcsTime,
} from './ics.js';
import { WALNUT_CREATED_PROP, clockOf, isRecurring, occurrenceKey, seriesKindOf, splitResource } from './events.js';
import { addDays, parseLocalIso, utcStamp, wallAt, wallToEpoch, type Wall } from './tz.js';

export interface TimeEdit {
  /** Tz-less local ISO, the calendar contract ("2026-08-05T09:00:00" or "2026-08-05"). */
  start: string;
  end: string;
  title?: string;
}

interface Parsed { wall: Wall; dateOnly: boolean }

function parseInput(value: string): Parsed {
  const parsed = parseLocalIso(value);
  if (!parsed) throw new CalendarHelperError(`not a local ISO date: ${value}`, 'usage');
  return parsed;
}

/** One time value written in the style of `like` (the event's own DTSTART). */
function timeProp(parsed: Parsed, localZone: string, like: IcsTime | null, allDay: boolean): { value: string; params: Record<string, string> } {
  if (allDay) return { value: formatDateValue(parsed.wall), params: { VALUE: 'DATE' } };
  const epoch = wallToEpoch(parsed.wall, localZone);
  if (like?.kind === 'zoned') return { value: formatWallValue(wallAt(epoch, like.zone)), params: { TZID: like.tzid } };
  if (like?.kind === 'floating') return { value: formatWallValue(parsed.wall), params: like.tzid ? { TZID: like.tzid } : {} };
  return { value: utcStamp(epoch), params: {} };
}

/** Write start/end (and title) onto one VEVENT. An all-day end is exclusive in iCalendar. */
function applyTimes(vevent: IcsComponent, edit: TimeEdit, localZone: string, like: IcsTime | null): void {
  const start = parseInput(edit.start);
  const end = parseInput(edit.end);
  const allDay = start.dateOnly;
  const endWall = allDay ? addDays(end.wall, end.dateOnly ? 1 : 0) : end.wall;
  const s = timeProp(start, localZone, like, allDay);
  const e = timeProp({ wall: endWall, dateOnly: allDay }, localZone, like, allDay);
  setProp(vevent, 'DTSTART', s.value, s.params);
  removeProps(vevent, 'DURATION');
  setProp(vevent, 'DTEND', e.value, e.params);
  if (edit.title !== undefined) setProp(vevent, 'SUMMARY', escapeText(edit.title));
  const sequence = parseInt(prop(vevent, 'SEQUENCE')?.value ?? '0', 10) || 0;
  setProp(vevent, 'SEQUENCE', String(sequence + 1));
  setProp(vevent, 'DTSTAMP', utcStamp(Date.now()));
}

/**
 * The RECURRENCE-ID / EXDATE value of an occurrence, in the style of the series' DTSTART.
 * The key is events.ts `occurrenceKey`: an instant, or for an all-day or floating series the
 * wall clock read as UTC.
 */
function occurrenceValue(master: IcsComponent, occurrenceSec: number): { value: string; params: Record<string, string> } {
  const like = timeOfProp(prop(master, 'DTSTART'));
  const epoch = occurrenceSec * 1000;
  if (like?.kind === 'date') return { value: formatDateValue(wallAt(epoch, 'UTC')), params: { VALUE: 'DATE' } };
  if (like?.kind === 'zoned') {
    // An occurrence whose time a spring-forward gap moved keeps its nominal time (the series'
    // own time of day), the value other clients match it by.
    const shown = wallAt(epoch, like.zone);
    const nominal = { ...shown, h: like.wall.h, mi: like.wall.mi, s: like.wall.s };
    const wall = wallToEpoch(nominal, like.zone) === epoch ? nominal : shown;
    return { value: formatWallValue(wall), params: { TZID: like.tzid } };
  }
  if (like?.kind === 'floating') return { value: formatWallValue(wallAt(epoch, 'UTC')), params: like.tzid ? { TZID: like.tzid } : {} };
  return { value: utcStamp(epoch), params: {} };
}

function overrideFor(master: IcsComponent | null, overrides: IcsComponent[], occurrenceSec: number, localZone: string): IcsComponent | undefined {
  // The keys events.ts gave the ids, a resource holding only overrides (one invited occurrence) included.
  const kind = seriesKindOf(master, overrides);
  return overrides.find((o) => {
    const t = timeOfProp(prop(o, 'RECURRENCE-ID'));
    return !!t && Math.floor(occurrenceKey(t, kind, localZone) / 1000) === occurrenceSec;
  });
}

/** Properties a new override does not copy from its series (SEQUENCE is copied, then raised). */
const SERIES_ONLY = new Set(['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID']);

const wallUtc = (w: Wall) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
const utcWall = (ms: number): Wall => wallAt(ms, 'UTC');

/** One time value moved by `deltaMs` on the series' wall clock, written in its own form. */
function shiftValue(t: IcsTime, deltaMs: number, series: { toEpoch: (w: Wall) => number; zone: string }): string {
  if (t.kind === 'date') return formatDateValue(t.wall);
  const wall = t.kind === 'utc' ? wallAt(t.epoch, series.zone) : t.wall;
  const moved = utcWall(wallUtc(wall) + deltaMs);
  if (t.kind === 'utc') return utcStamp(series.toEpoch(moved));
  return formatWallValue(moved);
}

function shiftList(p: IcsProperty, deltaMs: number, series: { toEpoch: (w: Wall) => number; zone: string }): void {
  p.value = parseTimeList(p).map((t) => shiftValue(t, deltaMs, series)).join(',');
  delete p.raw;
}

/** Move a series by `deltaMs` within its day: every value that names one of its occurrences moves too. */
function shiftSeries(master: IcsComponent, overrides: IcsComponent[], start: IcsTime, deltaMs: number, localZone: string): void {
  const clock = clockOf(start, localZone);
  const series = { toEpoch: clock.toEpoch, zone: start.kind === 'zoned' ? start.zone : start.kind === 'utc' ? 'UTC' : localZone };
  for (const p of [...props(master, 'EXDATE'), ...props(master, 'RDATE')]) shiftList(p, deltaMs, series);
  for (const o of overrides) {
    const rid = prop(o, 'RECURRENCE-ID');
    if (rid) shiftList(rid, deltaMs, series);
  }
  const rule = prop(master, 'RRULE');
  const until = rule ? parseRuleParts(rule.value).UNTIL : undefined;
  const untilTime = until ? parseTimeValue(until) : null;
  if (rule && until && untilTime && untilTime.kind !== 'date') {
    rule.value = rule.value.replace(/UNTIL=[^;]+/i, () => `UNTIL=${shiftValue(untilTime, deltaMs, series)}`);
    delete rule.raw;
  }
}

/** A whole series' new times, checked: same day, same all-day-ness; returns how far it moves. */
function seriesShift(start: IcsTime, edit: TimeEdit, localZone: string): number {
  const next = parseInput(edit.start);
  if (next.dateOnly !== (start.kind === 'date')) {
    throw new CalendarHelperError('A repeating event cannot change between all-day and timed in Walnut; change it in its own calendar app.', 'usage');
  }
  const clock = clockOf(start, localZone);
  const target = start.kind === 'date' || start.kind === 'floating'
    ? next.wall
    : wallAt(wallToEpoch(next.wall, localZone), start.kind === 'zoned' ? start.zone : 'UTC');
  const old = clock.wall;
  if (target.y !== old.y || target.m !== old.m || target.d !== old.d) {
    throw new CalendarHelperError('Walnut moves a whole repeating event only within its day. Move one occurrence, or change the series in its own calendar app.', 'usage');
  }
  return wallUtc(target) - wallUtc(old);
}

/**
 * Move or rename the event (`occurrenceSec` null) or one occurrence of its series.
 * Mutates `calendar`; the caller PUTs it back with the ETag it read.
 */
export function editTimes(calendar: IcsComponent, occurrenceSec: number | null, edit: TimeEdit, localZone: string): void {
  const { master, overrides } = splitResource(calendar);
  const series = isRecurring(master) || overrides.length > 0;
  if (occurrenceSec === null || !series) {
    const target = master ?? overrides[0];
    if (!target) throw new CalendarHelperError('the event has no VEVENT', 'not-found');
    const start = timeOfProp(prop(target, 'DTSTART'));
    if (series && master && start) {
      const delta = seriesShift(start, edit, localZone);
      if (delta !== 0) shiftSeries(master, overrides, start, delta, localZone);
    }
    applyTimes(target, edit, localZone, start);
    return;
  }
  const existing = overrideFor(master, overrides, occurrenceSec, localZone);
  if (existing) {
    applyTimes(existing, edit, localZone, timeOfProp(prop(existing, 'DTSTART')));
    return;
  }
  if (!master) throw new CalendarHelperError('the occurrence is not in this event', 'not-found');
  const rid = occurrenceValue(master, occurrenceSec);
  const override: IcsComponent = {
    name: 'VEVENT',
    props: [
      ...master.props.filter((p) => !SERIES_ONLY.has(p.name)).map((p) => ({ ...p })),
      { name: 'RECURRENCE-ID', params: rid.params, value: rid.value },
    ],
    children: master.children.map((c) => ({ ...c, props: [...c.props], children: [...c.children] })),
  };
  applyTimes(override, edit, localZone, timeOfProp(prop(master, 'DTSTART')));
  calendar.children.push(override);
}

/** Leave one occurrence out of its series: an EXDATE, and its override gone. Mutates `calendar`. */
export function removeOccurrence(calendar: IcsComponent, occurrenceSec: number, localZone: string): void {
  const { master, overrides } = splitResource(calendar);
  if (!master) throw new CalendarHelperError('the series of this occurrence is not in the event', 'not-found');
  const ex = occurrenceValue(master, occurrenceSec);
  master.props.push({ name: 'EXDATE', params: ex.params, value: ex.value });
  const override = overrideFor(master, overrides, occurrenceSec, localZone);
  if (override) calendar.children = calendar.children.filter((c) => c !== override);
}

/** A new event's VCALENDAR, marked as made by Walnut. */
export function newEventCalendar(edit: TimeEdit, localZone: string): { uid: string; calendar: IcsComponent } {
  const uid = randomUUID();
  const vevent: IcsComponent = {
    name: 'VEVENT',
    props: [
      { name: 'UID', params: {}, value: uid },
      { name: 'DTSTAMP', params: {}, value: utcStamp(Date.now()) },
      { name: WALNUT_CREATED_PROP, params: {}, value: 'TRUE' },
    ],
    children: [],
  };
  applyTimes(vevent, { ...edit, title: edit.title ?? '' }, localZone, null);
  removeProps(vevent, 'SEQUENCE');
  return {
    uid,
    calendar: {
      name: 'VCALENDAR',
      props: [
        { name: 'VERSION', params: {}, value: '2.0' },
        { name: 'PRODID', params: {}, value: '-//Open Walnut//Calendar//EN' },
      ],
      children: [vevent],
    },
  };
}
