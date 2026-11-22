/**
 * iCalendar (RFC 5545) text: a small tree reader and writer.
 *
 * Small on purpose: Walnut reads VEVENTs and edits a handful of their properties, and every
 * property it does not touch must go back to the server exactly as it came (a client that
 * rewrote alarms, attendees or X- properties it never understood would damage the user's
 * event). So a property keeps its unfolded source line, and serializing writes that line back
 * unless the property was replaced.
 */
import { resolveZone, zoneByOffsets, type Wall } from './tz.js';

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
  /** The unfolded source line, written back as is while the property is unchanged. */
  raw?: string;
  /** The zone the resource's own VTIMEZONE gives a TZID no name lookup knows (never written). */
  zone?: string;
}

export interface IcsComponent {
  name: string;
  props: IcsProperty[];
  children: IcsComponent[];
}

function unfold(text: string): string[] {
  return text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.length > 0);
}

/** Split "NAME;A=1;B="x:y":value" at the first colon outside quotes. */
function parseLine(line: string): IcsProperty | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments: string[] = [];
  let current = '';
  quoted = false;
  for (const ch of head) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) { segments.push(current); current = ''; } else current += ch;
  }
  segments.push(current);
  const name = segments[0].trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    params[seg.slice(0, eq).trim().toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value, raw: line };
}

/** Every top-level component in the text (normally one VCALENDAR). Malformed lines are skipped. */
export function parseIcs(text: string): IcsComponent[] {
  const roots: IcsComponent[] = [];
  const stack: IcsComponent[] = [];
  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      const comp: IcsComponent = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
      if (stack.length) stack[stack.length - 1].children.push(comp);
      else roots.push(comp);
      stack.push(comp);
    } else if (prop.name === 'END') {
      const name = prop.value.trim().toUpperCase();
      // Close up to the matching BEGIN; an unmatched END is ignored.
      const at = stack.map((c) => c.name).lastIndexOf(name);
      if (at >= 0) {
        if (at === 0) applyVtimezones(stack[0]);
        stack.length = at;
      }
    } else if (stack.length) {
      stack[stack.length - 1].props.push(prop);
    }
  }
  return roots;
}

/** "+0100", "-0800", "+053000" in minutes east of UTC. */
function offsetMinutes(value: string | undefined): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec((value ?? '').trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** The latest STANDARD or DAYLIGHT rule of a VTIMEZONE (by its DTSTART). */
function latestRule(tz: IcsComponent, name: string): IcsComponent | undefined {
  const rules = tz.children.filter((c) => c.name === name);
  return rules.sort((a, b) => (prop(a, 'DTSTART')?.value ?? '').localeCompare(prop(b, 'DTSTART')?.value ?? '')).pop();
}

/** The IANA zone a VTIMEZONE stands for: its X-LIC-LOCATION, else the zone with its offsets. */
function zoneOfVtimezone(tz: IcsComponent): string | null {
  const named = resolveZone(prop(tz, 'X-LIC-LOCATION')?.value);
  if (named) return named;
  const standard = offsetMinutes(prop(latestRule(tz, 'STANDARD') ?? tz, 'TZOFFSETTO')?.value);
  const daylightRule = latestRule(tz, 'DAYLIGHT');
  const daylight = daylightRule ? offsetMinutes(prop(daylightRule, 'TZOFFSETTO')?.value) : null;
  if (standard === null) return null;
  return zoneByOffsets(standard, daylight ?? undefined);
}

/** Give every time property whose TZID no name lookup knows the zone of the resource's VTIMEZONE. */
function applyVtimezones(calendar: IcsComponent): void {
  const zones = new Map<string, string>();
  for (const tz of calendar.children.filter((c) => c.name === 'VTIMEZONE')) {
    const tzid = prop(tz, 'TZID')?.value.trim();
    if (!tzid || resolveZone(tzid)) continue;
    const zone = zoneOfVtimezone(tz);
    if (zone) zones.set(tzid, zone);
  }
  if (zones.size === 0) return;
  const walk = (c: IcsComponent) => {
    if (c.name === 'VTIMEZONE') return;
    for (const p of c.props) {
      const zone = p.params.TZID ? zones.get(p.params.TZID.trim()) : undefined;
      if (zone) p.zone = zone;
    }
    c.children.forEach(walk);
  };
  walk(calendar);
}

const encoder = new TextEncoder();

/** Fold one content line at 75 octets, never inside a UTF-8 character. */
function fold(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

function paramValue(v: string): string {
  return /[:;,]/.test(v) ? `"${v.replace(/"/g, '')}"` : v;
}

function propLine(p: IcsProperty): string {
  if (p.raw !== undefined) return p.raw;
  const params = Object.entries(p.params).map(([k, v]) => `;${k}=${paramValue(v)}`).join('');
  return `${p.name}${params}:${p.value}`;
}

export function serializeIcs(comp: IcsComponent): string {
  const lines: string[] = [];
  const walk = (c: IcsComponent) => {
    lines.push(`BEGIN:${c.name}`);
    for (const p of c.props) lines.push(fold(propLine(p)));
    for (const child of c.children) walk(child);
    lines.push(`END:${c.name}`);
  };
  walk(comp);
  return `${lines.join('\r\n')}\r\n`;
}

export function prop(comp: IcsComponent, name: string): IcsProperty | undefined {
  return comp.props.find((p) => p.name === name);
}

export function props(comp: IcsComponent, name: string): IcsProperty[] {
  return comp.props.filter((p) => p.name === name);
}

/** Replace (or add) a property; the new one is written from its fields, not from a raw line. */
export function setProp(comp: IcsComponent, name: string, value: string, params: Record<string, string> = {}): void {
  const next: IcsProperty = { name, params, value };
  const at = comp.props.findIndex((p) => p.name === name);
  if (at >= 0) comp.props.splice(at, 1, next);
  else comp.props.push(next);
}

export function removeProps(comp: IcsComponent, name: string): void {
  comp.props = comp.props.filter((p) => p.name !== name);
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

export function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/**
 * A DATE or DATE-TIME value:
 * - `date`: an all-day date (VALUE=DATE);
 * - `utc`: an instant ("...Z");
 * - `zoned`: wall time in an IANA zone (TZID that this platform knows);
 * - `floating`: wall time with no zone (or a TZID nobody can resolve), read as local.
 */
export type IcsTime =
  | { kind: 'date'; wall: Wall }
  | { kind: 'utc'; epoch: number }
  | { kind: 'zoned'; wall: Wall; zone: string; tzid: string }
  | { kind: 'floating'; wall: Wall; tzid?: string };

export function parseTimeValue(value: string, params: Record<string, string> = {}, zoneHint?: string): IcsTime | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const wall: Wall = { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  if (m[4] === undefined) return { kind: 'date', wall };
  if (m[7]) return { kind: 'utc', epoch: Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s) };
  const tzid = params.TZID;
  const zone = resolveZone(tzid) ?? (tzid ? zoneHint : undefined);
  if (zone) return { kind: 'zoned', wall, zone, tzid: tzid! };
  return { kind: 'floating', wall, ...(tzid ? { tzid } : {}) };
}

/** The time a property holds (DTSTART, RECURRENCE-ID ...), its VTIMEZONE's zone included. */
export function timeOfProp(p: IcsProperty | undefined): IcsTime | null {
  return p ? parseTimeValue(p.value, p.params, p.zone) : null;
}

/** All values of a list property (EXDATE and RDATE may carry several, comma separated). */
export function parseTimeList(p: IcsProperty): IcsTime[] {
  return p.value.split(',').map((v) => parseTimeValue(v, p.params, p.zone)).filter((t): t is IcsTime => !!t);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatDateValue(w: Pick<Wall, 'y' | 'm' | 'd'>): string {
  return `${pad(w.y, 4)}${pad(w.m)}${pad(w.d)}`;
}

export function formatWallValue(w: Wall): string {
  return `${formatDateValue(w)}T${pad(w.h)}${pad(w.mi)}${pad(w.s)}`;
}

/** Parse an RRULE value into its parts ("FREQ=WEEKLY;BYDAY=MO,WE" → { FREQ: 'WEEKLY', BYDAY: 'MO,WE' }). */
export function parseRuleParts(value: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const seg of value.split(';')) {
    const eq = seg.indexOf('=');
    if (eq > 0) parts[seg.slice(0, eq).trim().toUpperCase()] = seg.slice(eq + 1).trim();
  }
  return parts;
}
