/**
 * Wall-clock helpers: quiet hours, local day keys, and how a duration reads. PURE.
 *
 * Everything here works in the SERVER's local time zone, because that is the
 * person's own clock: "no reminders after 22:00" means their 22:00, and a day log
 * named 2026-09-25 means their Thursday.
 */

export const MINUTE_MS = 60_000

export interface QuietWindow {
  /** Minutes after local midnight, 0-1439. */
  startMin: number
  endMin: number
}

export type QuietHoursParse =
  | { kind: 'off' }
  | { kind: 'window'; window: QuietWindow }
  | { kind: 'invalid'; input: string }

const WINDOW_PATTERN = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/

/**
 * `"22:00-08:00"` into a window. An empty string turns quiet hours off. A window
 * whose start equals its end is also off: "from 09:00 to 09:00" is zero minutes
 * long, and reading it as "all day" would silence every reminder by accident.
 */
export function parseQuietHours(input: string): QuietHoursParse {
  const text = input.trim()
  if (!text) return { kind: 'off' }
  const match = WINDOW_PATTERN.exec(text)
  if (!match) return { kind: 'invalid', input: text }
  const [sh, sm, eh, em] = match.slice(1).map(Number) as [number, number, number, number]
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return { kind: 'invalid', input: text }
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  if (startMin === endMin) return { kind: 'off' }
  return { kind: 'window', window: { startMin, endMin } }
}

/** True when local `now` falls inside the window. The end minute is outside it. */
export function inQuietWindow(window: QuietWindow | null, now: number): boolean {
  if (!window) return false
  const date = new Date(now)
  const minute = date.getHours() * 60 + date.getMinutes()
  if (window.startMin < window.endMin) return minute >= window.startMin && minute < window.endMin
  // Across midnight: 22:00-08:00 covers 22:00..23:59 and 00:00..07:59.
  return minute >= window.startMin || minute < window.endMin
}

/** Local YYYY-MM-DD for an epoch-ms instant. */
export function localDayKey(now: number): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** "45 min" under an hour, "1h 03m" from an hour up. Never negative. */
export function formatSitting(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}
