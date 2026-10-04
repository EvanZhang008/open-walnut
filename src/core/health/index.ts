/**
 * Apple Health on the primary box: the store, the sync ingest, derived nights and
 * days, the agent reads, and the once-a-morning sleep-ready signal.
 *
 * The iPhone reads HealthKit and keeps this Mac up to date (POST /api/v1/health/sync);
 * a cloud replica only relays. Nothing here ever runs on a replica.
 */

import fs from 'node:fs'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { closeHealthDb, healthDbPath } from './db.js'
import { resetMaterializeQueue, resumeMaterialize } from './materialize.js'
import { disarmMissingCheck, startSleepReadyTimer } from './sleep-ready.js'

export { HEALTH_MAX_ITEMS_PER_SYNC, HEALTH_MAX_SYNC_BYTES, HEALTH_METRICS, SLEEP_CODES } from './catalog.js'
export { ingestHealthSync, type HealthSyncOutcome } from './ingest.js'
export { healthDaily, healthSeries, healthSleep, healthStatus, HealthQueryError } from './queries.js'
export { samplesQuery as healthSamples } from './samples.js'
export { runHealthAction, isHealthAction, type HealthAction, type HealthActionResult } from './relay.js'
export { sanitizeHealthSync } from './sanitize.js'

/**
 * Server boot, only when a store exists: arm the 10:30 missing-night timer and
 * drain any date a previous process committed as stale but never recomputed.
 */
export function startHealth(): void {
  if (CLOUD_MODE || !fs.existsSync(healthDbPath())) return
  startSleepReadyTimer()
  try { resumeMaterialize() } catch (err) {
    log.web.warn('health: could not resume pending recomputes', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** Server stop: no timer, no queued recompute, no open handle survives. */
export function stopHealth(): void {
  disarmMissingCheck()
  resetMaterializeQueue()
  closeHealthDb()
}
