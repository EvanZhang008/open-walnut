/**
 * Day keys for health data.
 *
 * The store keeps UTC instants plus the timezone each sample was recorded in (the
 * sample's own metadata tz, else the batch tz). A sample's local date is computed
 * in THAT zone, never in the Mac's: a night recorded while traveling belongs to
 * the traveler's calendar. Durations always come from instants, so a DST night
 * is as long as it really was.
 *
 * The night rule (Walnut's own, not Apple's): a sample belongs to the night of
 * wake date D when its END falls in (D-1 18:00, D 18:00] of its own zone. So a
 * sample ending at exactly 18:00 still belongs to D, and one ending a millisecond
 * later belongs to D+1 (sampleNightDate: the sample's last instant, end - 1 ms,
 * falls in [D-1 18:00, D 18:00)). A zero-length sample uses its one instant. A
 * bucket belongs to the night of its midpoint. That keeps an evening's first
 * sleep samples with the night they start, instead of counting them on the day
 * they were recorded.
 */

/** Local hour at which a sample stops counting for the night it follows and starts the next one. */
export const NIGHT_SPLIT_HOUR = 18

const formatters = new Map<string, Intl.DateTimeFormat>()
const validZones = new Map<string, boolean>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatters.set(tz, f)
  }
  return f
}

/** An IANA zone this runtime can resolve. Cached, so a batch pays for each zone once. */
export function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false
  const known = validZones.get(tz)
  if (known !== undefined) return known
  let ok = false
  try {
    formatter(tz)
    ok = true
  } catch {
    ok = false
  }
  if (validZones.size < 512) validZones.set(tz, ok)
  return ok
}

export interface LocalParts {
  year: number; month: number; day: number; hour: number; minute: number; second: number
}

export function localParts(ms: number, tz: string): LocalParts {
  const out: Record<string, number> = {}
  for (const part of formatter(tz).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value)
  }
  return {
    year: out.year, month: out.month, day: out.day,
    hour: out.hour === 24 ? 0 : out.hour, minute: out.minute, second: out.second,
  }
}

function pad(n: number, width = 2): string {
  return String(Math.trunc(Math.abs(n))).padStart(width, '0')
}

function dateOf(p: LocalParts): string {
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
}

/** Local YYYY-MM-DD of an instant in a zone. */
export function localDate(ms: number, tz: string): string {
  return dateOf(localParts(ms, tz))
}

/** The wake date whose night an instant belongs to (see NIGHT_SPLIT_HOUR). */
export function nightDate(ms: number, tz: string): string {
  const p = localParts(ms, tz)
  const date = dateOf(p)
  return p.hour >= NIGHT_SPLIT_HOUR ? addDays(date, 1) : date
}

/** The last instant a sample covers: end - 1 ms, or its one instant when it has no length. */
export function sampleLastInstant(start: number, end: number): number {
  return Math.max(start, end - 1)
}

/** The wake date of a sample's night: END in (D-1 18:00, D 18:00] (see the header). */
export function sampleNightDate(start: number, end: number, tz: string): string {
  return nightDate(sampleLastInstant(start, end), tz)
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar date string (rejects 2026-02-30). */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

/** Pure calendar arithmetic on a date key (no zone involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** Inclusive list of date keys from `from` to `to` (bounded by `max`). */
export function dateRange(from: string, to: string, max = 400): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d)
  return out
}

/** Minutes the zone is ahead of UTC at this instant. */
export function offsetMinutes(ms: number, tz: string): number {
  const p = localParts(ms, tz)
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000)
}

/** `YYYY-MM-DDTHH:mm:ss+HH:MM`, the local wall time with its offset. */
export function localIso(ms: number, tz: string): string {
  const p = localParts(ms, tz)
  const off = offsetMinutes(ms, tz)
  const sign = off < 0 ? '-' : '+'
  return `${dateOf(p)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.abs(off) / 60)}:${pad(Math.abs(off) % 60)}`
}

/** The instant of a local wall-clock time on a date in a zone (DST-aware; a skipped time moves forward). */
export function zonedTime(date: string, hour: number, minute: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, hour, minute)
  const first = guess - offsetMinutes(guess, tz) * 60_000
  const second = guess - offsetMinutes(first, tz) * 60_000
  return second
}

/** Instant of local midnight starting a date. */
export function zonedMidnight(date: string, tz: string): number {
  return zonedTime(date, 0, 0, tz)
}

/** The Mac's own zone, the fallback when no batch ever named one. */
export function systemTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
