/**
 * Wall-clock time in a named time zone, with the platform's own zone database (Intl), so a
 * calendar event's "09:00 America/New_York" turns into the right instant on both sides of a
 * daylight-saving change, and back into the server's local tz-less ISO that every calendar
 * event carries (types.ts: "SERVER-LOCAL wall time").
 *
 * A TZID that is not an IANA name is mapped where the name says which zone it means: a Windows
 * zone id ("Pacific Standard Time", CLDR windowsZones), an Outlook display name ("(UTC-08:00)
 * Pacific Time (US & Canada)"), a path-like "/mozilla.org/.../Europe/Berlin". Otherwise the
 * resource's own VTIMEZONE decides (ics.ts: its X-LIC-LOCATION, else the zone with the same
 * standard and summer offsets, `zoneByOffsets`). Only a TZID none of that can tell is read as
 * floating local time.
 */

export interface Wall {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** The zone the server's local wall time is in. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Windows zone ids (CLDR windowsZones, the "001" territory of each), lower case. */
const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  'dateline standard time': 'Etc/GMT+12',
  'utc-11': 'Etc/GMT+11',
  'hawaiian standard time': 'Pacific/Honolulu',
  'alaskan standard time': 'America/Anchorage',
  'pacific standard time (mexico)': 'America/Tijuana',
  'pacific standard time': 'America/Los_Angeles',
  'us mountain standard time': 'America/Phoenix',
  'mountain standard time (mexico)': 'America/Mazatlan',
  'mountain standard time': 'America/Denver',
  'central america standard time': 'America/Guatemala',
  'central standard time': 'America/Chicago',
  'central standard time (mexico)': 'America/Mexico_City',
  'canada central standard time': 'America/Regina',
  'sa pacific standard time': 'America/Bogota',
  'eastern standard time (mexico)': 'America/Cancun',
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/Indianapolis',
  'venezuela standard time': 'America/Caracas',
  'paraguay standard time': 'America/Asuncion',
  'atlantic standard time': 'America/Halifax',
  'central brazilian standard time': 'America/Cuiaba',
  'sa western standard time': 'America/La_Paz',
  'pacific sa standard time': 'America/Santiago',
  'newfoundland standard time': 'America/St_Johns',
  'e. south america standard time': 'America/Sao_Paulo',
  'sa eastern standard time': 'America/Cayenne',
  'argentina standard time': 'America/Buenos_Aires',
  'greenland standard time': 'America/Godthab',
  'montevideo standard time': 'America/Montevideo',
  'utc-02': 'Etc/GMT+2',
  'azores standard time': 'Atlantic/Azores',
  'cape verde standard time': 'Atlantic/Cape_Verde',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'morocco standard time': 'Africa/Casablanca',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'romance standard time': 'Europe/Paris',
  'central european standard time': 'Europe/Warsaw',
  'w. central africa standard time': 'Africa/Lagos',
  'jordan standard time': 'Asia/Amman',
  'gtb standard time': 'Europe/Bucharest',
  'middle east standard time': 'Asia/Beirut',
  'egypt standard time': 'Africa/Cairo',
  'e. europe standard time': 'Europe/Chisinau',
  'syria standard time': 'Asia/Damascus',
  'south africa standard time': 'Africa/Johannesburg',
  'fle standard time': 'Europe/Kiev',
  'israel standard time': 'Asia/Jerusalem',
  'kaliningrad standard time': 'Europe/Kaliningrad',
  'arabic standard time': 'Asia/Baghdad',
  'turkey standard time': 'Europe/Istanbul',
  'arab standard time': 'Asia/Riyadh',
  'russian standard time': 'Europe/Moscow',
  'e. africa standard time': 'Africa/Nairobi',
  'iran standard time': 'Asia/Tehran',
  'arabian standard time': 'Asia/Dubai',
  'azerbaijan standard time': 'Asia/Baku',
  'georgian standard time': 'Asia/Tbilisi',
  'caucasus standard time': 'Asia/Yerevan',
  'afghanistan standard time': 'Asia/Kabul',
  'west asia standard time': 'Asia/Tashkent',
  'ekaterinburg standard time': 'Asia/Yekaterinburg',
  'pakistan standard time': 'Asia/Karachi',
  'india standard time': 'Asia/Kolkata',
  'sri lanka standard time': 'Asia/Colombo',
  'nepal standard time': 'Asia/Kathmandu',
  'central asia standard time': 'Asia/Almaty',
  'bangladesh standard time': 'Asia/Dhaka',
  'myanmar standard time': 'Asia/Yangon',
  'se asia standard time': 'Asia/Bangkok',
  'n. central asia standard time': 'Asia/Novosibirsk',
  'north asia standard time': 'Asia/Krasnoyarsk',
  'china standard time': 'Asia/Shanghai',
  'north asia east standard time': 'Asia/Irkutsk',
  'singapore standard time': 'Asia/Singapore',
  'w. australia standard time': 'Australia/Perth',
  'taipei standard time': 'Asia/Taipei',
  'ulaanbaatar standard time': 'Asia/Ulaanbaatar',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'yakutsk standard time': 'Asia/Yakutsk',
  'cen. australia standard time': 'Australia/Adelaide',
  'aus central standard time': 'Australia/Darwin',
  'e. australia standard time': 'Australia/Brisbane',
  'aus eastern standard time': 'Australia/Sydney',
  'west pacific standard time': 'Pacific/Port_Moresby',
  'tasmania standard time': 'Australia/Hobart',
  'vladivostok standard time': 'Asia/Vladivostok',
  'central pacific standard time': 'Pacific/Guadalcanal',
  'utc+12': 'Etc/GMT-12',
  'new zealand standard time': 'Pacific/Auckland',
  'fiji standard time': 'Pacific/Fiji',
  'tonga standard time': 'Pacific/Tongatapu',
  'samoa standard time': 'Pacific/Apia',
  'line islands standard time': 'Pacific/Kiritimati',
};

/** Outlook's display names (after their "(UTC+hh:mm) " prefix), the common ones. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'pacific time (us & canada)': 'America/Los_Angeles',
  'mountain time (us & canada)': 'America/Denver',
  'central time (us & canada)': 'America/Chicago',
  'eastern time (us & canada)': 'America/New_York',
  'atlantic time (canada)': 'America/Halifax',
  'arizona': 'America/Phoenix',
  'alaska': 'America/Anchorage',
  'hawaii': 'Pacific/Honolulu',
  'coordinated universal time': 'UTC',
  'dublin, edinburgh, lisbon, london': 'Europe/London',
  'amsterdam, berlin, bern, rome, stockholm, vienna': 'Europe/Berlin',
  'brussels, copenhagen, madrid, paris': 'Europe/Paris',
  'belgrade, bratislava, budapest, ljubljana, prague': 'Europe/Budapest',
  'sarajevo, skopje, warsaw, zagreb': 'Europe/Warsaw',
  'athens, bucharest': 'Europe/Bucharest',
  'helsinki, kyiv, riga, sofia, tallinn, vilnius': 'Europe/Helsinki',
  'jerusalem': 'Asia/Jerusalem',
  'moscow, st. petersburg': 'Europe/Moscow',
  'abu dhabi, muscat': 'Asia/Dubai',
  'chennai, kolkata, mumbai, new delhi': 'Asia/Kolkata',
  'beijing, chongqing, hong kong, urumqi': 'Asia/Shanghai',
  'kuala lumpur, singapore': 'Asia/Singapore',
  'taipei': 'Asia/Taipei',
  'osaka, sapporo, tokyo': 'Asia/Tokyo',
  'seoul': 'Asia/Seoul',
  'canberra, melbourne, sydney': 'Australia/Sydney',
  'brisbane': 'Australia/Brisbane',
  'perth': 'Australia/Perth',
  'auckland, wellington': 'Pacific/Auckland',
  'brasilia': 'America/Sao_Paulo',
  'bogota, lima, quito, rio branco': 'America/Bogota',
  'guadalajara, mexico city, monterrey': 'America/Mexico_City',
};

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  if (formatters.has(zone)) return formatters.get(zone)!;
  let made: Intl.DateTimeFormat | null = null;
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    made = null;
  }
  formatters.set(zone, made);
  return made;
}

/** An IANA zone the TZID names, or null when it names none this platform knows. */
export function resolveZone(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const raw = tzid.trim().replace(/^"|"$/g, '');
  if (formatter(raw)) return raw;
  const lower = raw.toLowerCase();
  const mapped = WINDOWS_ZONES[lower] ?? DISPLAY_NAMES[lower.replace(/^\((utc|gmt)([+-]\d{1,2}:\d{2})?\)\s*/, '')];
  if (mapped && formatter(mapped)) return mapped;
  // "/mozilla.org/20070129_1/Europe/Berlin", "/softwarestudio.org/Olson_20011030_5/America/New_York"
  const parts = raw.split('/').filter(Boolean);
  for (let take = Math.min(3, parts.length); take >= 2; take--) {
    const tail = parts.slice(-take).join('/');
    if (formatter(tail)) return tail;
  }
  return null;
}

const HOUR_MS = 3_600_000;
/** Zone offset per UTC hour since 1970, NaN for an hour in which the offset changes. */
const hourOffsets = new Map<string, number>();

/**
 * The wall clock in `zone` at `epochMs`. An expansion asks thousands of instants: the offset is
 * read once per hour of UTC (checked at both ends of the hour), and an hour holding a change
 * of offset is answered exactly.
 */
export function wallAt(epochMs: number, zone: string): Wall {
  if (epochMs < 0 || !Number.isFinite(epochMs)) return exactWallAt(epochMs, zone);
  const hour = Math.floor(epochMs / HOUR_MS);
  const key = `${zone}|${hour}`;
  let offset = hourOffsets.get(key);
  if (offset === undefined) {
    const first = hour * HOUR_MS;
    const a = wallAsUtc(exactWallAt(first, zone)) - first;
    const b = wallAsUtc(exactWallAt(first + HOUR_MS - 1000, zone)) - (first + HOUR_MS - 1000);
    offset = a === b ? a : NaN;
    if (hourOffsets.size >= 50_000) hourOffsets.clear();
    hourOffsets.set(key, offset);
  }
  if (Number.isNaN(offset)) return exactWallAt(epochMs, zone);
  const d = new Date(epochMs + offset);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

function exactWallAt(epochMs: number, zone: string): Wall {
  const f = formatter(zone) ?? formatter('UTC')!;
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(epochMs))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour === 24 ? 0 : parts.hour, mi: parts.minute, s: parts.second };
}

function wallAsUtc(w: Wall): number {
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
}

/** Wall clock minus UTC at an instant, in milliseconds. */
function offsetAt(epochMs: number, zone: string): number {
  return wallAsUtc(wallAt(epochMs, zone)) - epochMs;
}

/**
 * The instant a wall clock in `zone` shows `wall`. A time skipped by a spring-forward gap
 * moves forward by the gap (02:30 in a gap from 02:00 to 03:00 reads 03:30, in either
 * hemisphere), and an hour that repeats in the autumn takes its first occurrence, as calendar
 * programs do. The candidates are the offsets a day before and a day after: no zone changes
 * its offset twice within two days.
 */
export function wallToEpoch(wall: Wall, zone: string): number {
  const target = wallAsUtc(wall);
  const key = `${zone}|${target}`;
  const known = toEpochMemo.get(key);
  if (known !== undefined) return known;
  const epoch = solveWall(target, zone);
  // An expansion asks the same walls several times (its rule, its key, its span): answer once.
  if (toEpochMemo.size >= 50_000) toEpochMemo.clear();
  toEpochMemo.set(key, epoch);
  return epoch;
}

const toEpochMemo = new Map<string, number>();

function solveWall(target: number, zone: string): number {
  const early = target - offsetAt(target - 86_400_000, zone);
  const late = target - offsetAt(target + 86_400_000, zone);
  const earlyOk = wallAsUtc(wallAt(early, zone)) === target;
  if (early === late) return early;
  const lateOk = wallAsUtc(wallAt(late, zone)) === target;
  if (earlyOk && lateOk) return Math.min(early, late);
  if (lateOk) return late;
  // In a gap neither fits; the offset from before it carries the time forward past it.
  return early;
}

/** Zones to match a VTIMEZONE's offsets against: one per Windows zone, so one per region. */
const OFFSET_CANDIDATES = [...new Set(Object.values(WINDOWS_ZONES))];
const offsetMatches = new Map<string, string | null>();

/**
 * The zone with this standard offset and (when it has one) this summer offset, in minutes
 * east of UTC: how a VTIMEZONE whose name says nothing is read. Null when none matches.
 */
export function zoneByOffsets(standardMin: number, daylightMin: number | undefined): string | null {
  const key = `${standardMin}/${daylightMin ?? ''}`;
  if (offsetMatches.has(key)) return offsetMatches.get(key)!;
  const year = new Date().getUTCFullYear();
  const jan = Date.UTC(year, 0, 15, 12);
  const jul = Date.UTC(year, 6, 15, 12);
  let found: string | null = null;
  for (const zone of OFFSET_CANDIDATES) {
    if (!formatter(zone)) continue;
    const a = offsetAt(jan, zone) / 60_000;
    const b = offsetAt(jul, zone) / 60_000;
    const ok = daylightMin === undefined || daylightMin === standardMin
      ? a === standardMin && b === standardMin
      : (a === standardMin && b === daylightMin) || (a === daylightMin && b === standardMin);
    if (ok) { found = zone; break; }
  }
  if (!found && (daylightMin === undefined || daylightMin === standardMin) && standardMin % 60 === 0) {
    // Etc/GMT names carry the opposite sign.
    const hours = -standardMin / 60;
    const etc = hours === 0 ? 'UTC' : `Etc/GMT${hours > 0 ? '+' : ''}${hours}`;
    if (formatter(etc)) found = etc;
  }
  offsetMatches.set(key, found);
  return found;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function wallDay(w: Pick<Wall, 'y' | 'm' | 'd'>): string {
  return `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}`;
}

/** The tz-less local ISO of the calendar contract: "2026-08-05T09:00:00". */
export function wallIso(w: Wall): string {
  return `${wallDay(w)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
}

/** Parse the contract's tz-less ISO ("2026-08-05" or "2026-08-05T09:00:00"). */
export function parseLocalIso(value: string): { wall: Wall; dateOnly: boolean } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!m) return null;
  return {
    wall: { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) },
    dateOnly: m[4] === undefined,
  };
}

/** Calendar-day arithmetic on a wall date (no zone involved). */
export function addDays(w: Wall, days: number): Wall {
  const t = new Date(Date.UTC(w.y, w.m - 1, w.d + days, w.h, w.mi, w.s));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
}

/** 0 = Sunday ... 6 = Saturday, for a wall date. */
export function weekday(w: Pick<Wall, 'y' | 'm' | 'd'>): number {
  return new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "20260805T090000Z", the UTC form CalDAV time-range filters take. */
export function utcStamp(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
