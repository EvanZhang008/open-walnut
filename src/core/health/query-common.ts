/** Shared by the health read modules (queries.ts, series.ts, samples.ts). */

import { getMeta } from './db.js'
import { addDays, isDateKey, isValidTz, systemTz, zonedMidnight } from './day-key.js'

/** A read argument the caller must fix (answered as 400). */
export class HealthQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HealthQueryError'
  }
}

export const MAX_RANGE_DAYS = 90
export const MAX_SERIES_POINTS = 2000

/** The phone's last-known zone: every date argument and answer is local to it. */
export function healthTz(): string {
  const tz = getMeta('lastTz')
  return isValidTz(tz) ? tz : systemTz()
}

/** A YYYY-MM-DD date (its local midnight, or the next one for an inclusive end) or an ISO-8601 instant. */
export function toInstant(value: string, tz: string, endOfDay: boolean): number {
  if (isDateKey(value)) return zonedMidnight(endOfDay ? addDays(value, 1) : value, tz)
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new HealthQueryError('from/to must be YYYY-MM-DD dates or ISO-8601 instants')
  return ms
}
