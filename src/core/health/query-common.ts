/** Shared by the health read modules (queries.ts, series.ts). */

import { getMeta } from './db.js'
import { isValidTz, systemTz } from './day-key.js'

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
