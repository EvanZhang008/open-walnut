/**
 * Wall-clock helpers: local day keys and how a time of day reads. PURE.
 *
 * Everything here works in the SERVER's local time zone, because that is the
 * person's own clock: a day log named 2026-09-25 means their Thursday, and "Started
 * 10:05" is their 10:05.
 */

export const MINUTE_MS = 60_000

/** Local YYYY-MM-DD for an epoch-ms instant. */
export function localDayKey(now: number): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** "10:05" (24-hour, local), for the sidebar's "Started 10:05, ends 10:30". */
export function clockTime(epochMs: number): string {
  const date = new Date(epochMs)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
