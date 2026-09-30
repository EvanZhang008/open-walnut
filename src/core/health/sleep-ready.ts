/**
 * `health:sleep-ready`, once per wake date, in the phone's own timezone.
 *
 *   ready    the night's latest asleep or in-bed sample ended at least 30 min before an
 *            upload made at or after 05:00 local (the person is up and the data
 *            has stopped growing; an upload at 3am during a bathroom trip is not
 *            the end of the night)
 *   missing  10:30 local came and no night arrived
 *
 * Event driven and cheap: the ready check runs after each sync (one indexed MAX
 * query), and the missing check is ONE unref'd timer armed for the next 10:30 in
 * the last batch's zone. The fired dates live in the store, so a restart never
 * fires a date twice. Only a connected, unpaused store fires anything: a Mac that
 * never paired Apple Health, or stopped uploading days ago, stays silent.
 */

import fs from 'node:fs'
import { bus, EventNames } from '../event-bus.js'
import type { HealthSleepReadyEvent } from '../event-types.js'
import { log } from '../../logging/index.js'
import { getHealthDb, getMeta, healthDbPath } from './db.js'
import { addDays, isValidTz, localDate, localParts, systemTz, zonedTime } from './day-key.js'
import { computeNight } from './materialize.js'

export const SLEEP_READY_AFTER_MS = 30 * 60_000
export const MISSING_CHECK_HOUR = 10
export const MISSING_CHECK_MINUTE = 30
/** Before this local hour an upload is mid-night: a quiet half night is not "ready". */
export const READY_EARLIEST_HOUR = 5
/** A store with no upload for this long is not "connected" and never fires `missing`. */
const CONNECTED_WITHIN_MS = 3 * 86_400_000

let timer: ReturnType<typeof setTimeout> | null = null
let timerTz: string | null = null

function storeTz(): string {
  const tz = getMeta('lastTz')
  return isValidTz(tz) ? tz : systemTz()
}

function connected(now: number): boolean {
  if (getMeta('paused') === '1') return false
  const last = Number(getMeta('lastUploadAt') ?? 0)
  return last > 0 && now - last <= CONNECTED_WITHIN_MS
}

function fire(date: string, status: HealthSleepReadyEvent['status'], now: number): boolean {
  const res = getHealthDb().prepare('INSERT OR IGNORE INTO sleep_ready (date, status, at_ms) VALUES (?, ?, ?)').run(date, status, now)
  if (res.changes !== 1) return false
  const payload: HealthSleepReadyEvent = { date, status }
  bus.emit(EventNames.HEALTH_SLEEP_READY, payload, [], { source: 'health' })
  // No date: when someone woke up is itself personal data.
  log.web.info('health sleep-ready fired', { status })
  return true
}

/**
 * Decide for today's wake date. `atMissingCheck` is the 10:30 tick: it may fire
 * `missing`, and it also fires `ready` for a night whose last upload came too soon
 * after waking for the post-sync check to count it.
 */
export function checkSleepReady(now = Date.now(), opts: { atMissingCheck?: boolean } = {}): HealthSleepReadyEvent['status'] | null {
  if (!connected(now)) return null
  const tz = storeTz()
  const date = localDate(now, tz)
  const db = getHealthDb()
  if (db.prepare('SELECT 1 FROM sleep_ready WHERE date = ?').get(date)) return null
  const row = db.prepare(
    // In bed (0) counts: an iPhone without a Watch records nothing else.
    "SELECT MAX(end_ms) AS latest FROM samples WHERE type = 'sleep' AND night_date = ? AND code IN (0, 1, 3, 4, 5)",
  ).get(date) as { latest: number | null }
  const lateEnough = opts.atMissingCheck || localParts(now, tz).hour >= READY_EARLIEST_HOUR
  if (lateEnough && row.latest !== null && row.latest <= now && now - row.latest >= SLEEP_READY_AFTER_MS) {
    // Materialize before announcing: whatever wakes on the event reads this night.
    const night = computeNight(date)
    if (night?.status === 'ok' || night?.status === 'in_bed_only') return fire(date, 'ready', now) ? 'ready' : null
  }
  if (opts.atMissingCheck) return fire(date, 'missing', now) ? 'missing' : null
  return null
}

/** Epoch ms of the next 10:30 in `tz` strictly after `now`. */
export function nextMissingCheckAt(now: number, tz: string): number {
  const today = localDate(now, tz)
  const at = zonedTime(today, MISSING_CHECK_HOUR, MISSING_CHECK_MINUTE, tz)
  return at > now ? at : zonedTime(addDays(today, 1), MISSING_CHECK_HOUR, MISSING_CHECK_MINUTE, tz)
}

/** (Re)arm the 10:30 timer. Cheap and idempotent; called on boot and when the phone's zone changes. */
export function armMissingCheck(now = Date.now()): void {
  const tz = storeTz()
  if (timer && timerTz === tz) return
  disarmMissingCheck()
  const delay = Math.max(1_000, nextMissingCheckAt(now, tz) - now)
  timerTz = tz
  timer = setTimeout(() => {
    timer = null
    timerTz = null
    try {
      checkSleepReady(Date.now(), { atMissingCheck: true })
    } catch (err) {
      log.web.warn('health missing-night check failed', { error: err instanceof Error ? err.message : String(err) })
    }
    try { armMissingCheck() } catch { /* store gone: the next sync re-arms */ }
  }, delay)
  timer.unref?.()
}

export function disarmMissingCheck(): void {
  if (timer) clearTimeout(timer)
  timer = null
  timerTz = null
}

/** Boot hook: arm only when a store already exists, so a Mac that never used Health opens nothing. */
export function startSleepReadyTimer(): void {
  if (!fs.existsSync(healthDbPath())) return
  try { armMissingCheck() } catch (err) {
    log.web.warn('health sleep-ready timer not armed', { error: err instanceof Error ? err.message : String(err) })
  }
}
