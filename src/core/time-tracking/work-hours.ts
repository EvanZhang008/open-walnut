/**
 * The user's work hours, and how much of an interval falls inside them. PURE: no
 * fs, no config I/O (the caller passes `config.time.work_hours`).
 *
 * Every time answer has two views, the whole day and work hours (a day of 8 h at
 * the desk reads very differently when 3 h of it was after 18:00), so this is the
 * one place that decides what "work hours" means. Local wall time of THIS machine,
 * like every other time-tracking day key; whole-day arithmetic goes through Date
 * fields, never `+ 86_400_000`, so a DST day keeps its real length.
 */

export const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type WeekdayName = (typeof WEEKDAY_NAMES)[number]

export interface WorkHours {
  /** Local "HH:MM", inclusive. */
  start: string
  /** Local "HH:MM", exclusive; after `start`. */
  end: string
  /** Working weekdays, 0 = Sunday … 6 = Saturday, ascending. */
  days: number[]
}

/** What the config may hold (`time.work_hours`); every field optional. */
export interface WorkHoursConfig {
  start?: string
  end?: string
  /** Weekday names (mon, tue, …) or numbers 0-6 (0 = Sunday). */
  days?: Array<string | number>
}

export const DEFAULT_WORK_HOURS: WorkHours = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }

export class WorkHoursError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkHoursError'
  }
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** Minutes after midnight for "HH:MM", or null. "24:00" is accepted as an end. */
export function parseClock(raw: unknown, allowMidnightEnd = false): number | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (allowMidnightEnd && t === '24:00') return 24 * 60
  const m = HHMM.exec(t)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

const pad = (n: number): string => String(n).padStart(2, '0')
const clockText = (min: number): string => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`

function parseDay(raw: string | number): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 && raw <= 6 ? raw : null
  const key = raw.trim().toLowerCase().slice(0, 3)
  const i = (WEEKDAY_NAMES as readonly string[]).indexOf(key)
  if (i >= 0) return i
  return /^[0-6]$/.test(raw.trim()) ? Number(raw.trim()) : null
}

/**
 * Validate a config/args value into WorkHours, filling gaps from `base`. Throws
 * WorkHoursError with a sentence a caller can show; a bad stored config is the
 * caller's to fall back from (see resolveWorkHours).
 */
export function parseWorkHours(raw: WorkHoursConfig | undefined, base: WorkHours = DEFAULT_WORK_HOURS): WorkHours {
  if (raw === undefined || raw === null) return { ...base, days: [...base.days] }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new WorkHoursError('work hours must be an object { start, end, days }')
  const start = raw.start === undefined ? parseClock(base.start) : parseClock(raw.start)
  const end = raw.end === undefined ? parseClock(base.end, true) : parseClock(raw.end, true)
  if (start === null) throw new WorkHoursError('start must be a local time HH:MM, e.g. 09:00')
  if (end === null) throw new WorkHoursError('end must be a local time HH:MM, e.g. 18:00')
  if (end <= start) throw new WorkHoursError('end must be after start (work hours do not run past midnight)')
  let days = base.days
  if (raw.days !== undefined) {
    if (!Array.isArray(raw.days)) throw new WorkHoursError('days must be a list of weekdays, e.g. ["mon","tue","wed","thu","fri"]')
    const parsed = raw.days.map(parseDay)
    const bad = raw.days.filter((_, i) => parsed[i] === null)
    if (bad.length) throw new WorkHoursError(`unknown weekday(s): ${bad.join(', ')} (use mon, tue, wed, thu, fri, sat, sun)`)
    days = [...new Set(parsed as number[])].sort((a, b) => a - b)
  }
  return { start: clockText(start), end: clockText(end), days: [...days] }
}

/** The config value, or the default when it is absent or invalid (with the reason). */
export function resolveWorkHours(raw: WorkHoursConfig | undefined): { workHours: WorkHours; source: 'config' | 'default'; invalid?: string } {
  if (raw === undefined || raw === null) return { workHours: { ...DEFAULT_WORK_HOURS, days: [...DEFAULT_WORK_HOURS.days] }, source: 'default' }
  try {
    return { workHours: parseWorkHours(raw), source: 'config' }
  } catch (err) {
    return {
      workHours: { ...DEFAULT_WORK_HOURS, days: [...DEFAULT_WORK_HOURS.days] },
      source: 'default',
      invalid: err instanceof Error ? err.message : String(err),
    }
  }
}

/** The config shape for a WorkHours (weekday names, the readable YAML form). */
export function workHoursToConfig(wh: WorkHours): Required<WorkHoursConfig> {
  return { start: wh.start, end: wh.end, days: wh.days.map((d) => WEEKDAY_NAMES[d]!) }
}

/** "09:00-18:00 Mon-Fri" style label for answers. */
export function workHoursLabel(wh: WorkHours): string {
  const names = wh.days.map((d) => WEEKDAY_NAMES[d]!.replace(/^./, (c) => c.toUpperCase()))
  const contiguous = wh.days.length > 2 && wh.days.every((d, i) => i === 0 || d === wh.days[i - 1]! + 1)
  const days = wh.days.length === 0 ? 'no days' : contiguous ? `${names[0]}-${names[names.length - 1]}` : names.join(',')
  return `${wh.start}-${wh.end} ${days}`
}

/** Is a local date key (YYYY-MM-DD) a working day? */
export function isWorkday(date: string, wh: WorkHours): boolean {
  const [y, m, d] = date.split('-').map(Number)
  return wh.days.includes(new Date(y!, (m ?? 1) - 1, d ?? 1, 12).getDay())
}

/**
 * Milliseconds of [startMs, endMs) that fall inside work hours, local time. An
 * interval may touch two local days (a lease across midnight); each day is
 * judged on its own weekday.
 */
export function workMsOf(startMs: number, endMs: number, wh: WorkHours): number {
  if (!(endMs > startMs)) return 0
  const startMin = parseClock(wh.start) ?? 0
  const endMin = parseClock(wh.end, true) ?? 0
  let total = 0
  const cursor = new Date(startMs)
  let day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())
  // Two or three days at most for any real record; the bound only guards junk.
  for (let i = 0; i < 400 && day.getTime() < endMs; i++) {
    if (wh.days.includes(day.getDay())) {
      const y = day.getFullYear()
      const mo = day.getMonth()
      const d = day.getDate()
      const winStart = new Date(y, mo, d, Math.floor(startMin / 60), startMin % 60).getTime()
      const winEnd = new Date(y, mo, d, Math.floor(endMin / 60), endMin % 60).getTime()
      total += Math.max(0, Math.min(endMs, winEnd) - Math.max(startMs, winStart))
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  }
  return total
}
