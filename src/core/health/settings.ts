/**
 * Health settings (PUT /api/v1/health/settings) and the privacy delete
 * (DELETE /api/v1/health/data). Both run on the primary only.
 *
 * DELETE rotates the store id and pauses uploads, whatever its scope: the phone's
 * next upload answers 409 store_mismatch, so it clears its anchors instead of
 * silently refilling what was just removed. A full delete drops the database FILE
 * (secure_delete covers a scoped one), so the bytes are gone, not just unlinked rows.
 */

import { log } from '../../logging/index.js'
import { HEALTH_CATEGORIES, isHealthCategory, metricsInCategories, type HealthCategory } from './catalog.js'
import {
  bumpMaterializedRev, destroyHealthDbFiles, getHealthDb, getMeta, getMetaJson, newStoreId, setMeta, setMetaJson,
} from './db.js'
import { enabledCategories } from './ingest.js'
import { resetMaterializeQueue, savedSourceOrder } from './materialize.js'
import { cleanPreferredUnits, type PreferredUnits } from './sanitize.js'
import { disarmMissingCheck } from './sleep-ready.js'

export class HealthSettingsError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
    this.name = 'HealthSettingsError'
  }
}

export interface HealthSettingsView {
  storeId: string
  paused: boolean
  sleepSourceOrder: string[] | null
  categories: HealthCategory[]
  preferredUnits: PreferredUnits
}

export function readHealthSettings(): HealthSettingsView {
  return {
    storeId: getMeta('storeId') as string,
    paused: getMeta('paused') === '1',
    sleepSourceOrder: savedSourceOrder(),
    categories: [...enabledCategories()].sort(),
    preferredUnits: getMetaJson<PreferredUnits>('preferredUnits') ?? {},
  }
}

function parseOrder(raw: unknown): string[] | null {
  if (raw === null) return null
  if (!Array.isArray(raw) || raw.length > 50 || !raw.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 200)) {
    throw new HealthSettingsError('sleepSourceOrder must be null or an array of at most 50 source bundle ids')
  }
  return [...new Set(raw as string[])]
}

function parseCategories(raw: unknown): HealthCategory[] {
  if (!Array.isArray(raw) || !raw.every(isHealthCategory)) {
    throw new HealthSettingsError(`categories must be an array of: ${HEALTH_CATEGORIES.join(', ')}`)
  }
  return [...new Set(raw as HealthCategory[])]
}

export function updateHealthSettings(body: unknown): HealthSettingsView {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  if (b.paused !== undefined && typeof b.paused !== 'boolean') throw new HealthSettingsError('paused must be a boolean')
  const order = b.sleepSourceOrder === undefined ? undefined : parseOrder(b.sleepSourceOrder)
  const categories = b.categories === undefined ? undefined : parseCategories(b.categories)
  const units = b.preferredUnits === undefined ? undefined : cleanPreferredUnits(b.preferredUnits)
  const db = getHealthDb()
  db.transaction(() => {
    if (typeof b.paused === 'boolean') setMeta('paused', b.paused ? '1' : '0')
    if (order !== undefined) {
      if (JSON.stringify(order) !== JSON.stringify(savedSourceOrder())) {
        if (order === null) db.prepare("DELETE FROM meta WHERE key = 'sleepSourceOrder'").run()
        else setMetaJson('sleepSourceOrder', order)
        // Every night may merge differently now; reads recompute lazily.
        bumpMaterializedRev()
      }
    }
    if (categories !== undefined) setMetaJson('categories', categories)
    if (units) setMetaJson('preferredUnits', units)
  })()
  log.web.info('health settings updated', {
    paused: typeof b.paused === 'boolean' ? b.paused : undefined,
    sourceOrder: order === undefined ? undefined : (order?.length ?? 0),
    categories: categories?.length,
  })
  return readHealthSettings()
}

export interface HealthDeleteResult { deleted: 'all' | HealthCategory[]; storeId: string; paused: true; removed: number }

export function deleteHealthData(body: unknown): HealthDeleteResult {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const scoped = b.categories === undefined ? null : parseCategories(b.categories)
  resetMaterializeQueue()
  if (!scoped || scoped.length === 0) {
    // Keep the user's preferences, drop everything else by dropping the file.
    const keep = {
      sleepSourceOrder: savedSourceOrder(),
      categories: getMetaJson<unknown>('categories'),
      preferredUnits: getMetaJson<unknown>('preferredUnits'),
    }
    const removed = countRows()
    disarmMissingCheck()
    destroyHealthDbFiles()
    getHealthDb() // fresh file, fresh storeId
    if (keep.sleepSourceOrder) setMetaJson('sleepSourceOrder', keep.sleepSourceOrder)
    if (keep.categories !== undefined) setMetaJson('categories', keep.categories)
    if (keep.preferredUnits !== undefined) setMetaJson('preferredUnits', keep.preferredUnits)
    setMeta('paused', '1')
    log.web.info('health data deleted', { scope: 'all', removed })
    return { deleted: 'all', storeId: getMeta('storeId') as string, paused: true, removed }
  }
  const names = metricsInCategories(scoped)
  const db = getHealthDb()
  let removed = 0
  db.transaction(() => {
    const marks = names.map(() => '?').join(', ')
    removed += db.prepare(`DELETE FROM samples WHERE type IN (${marks})`).run(...names).changes
    removed += db.prepare(`DELETE FROM buckets WHERE metric IN (${marks})`).run(...names).changes
    db.prepare('DELETE FROM nights').run()
    db.prepare('DELETE FROM days').run()
    const enabled = [...enabledCategories()].filter((c) => !scoped.includes(c))
    setMetaJson('categories', enabled)
    setMeta('storeId', newStoreId())
    setMeta('paused', '1')
    for (const n of names) db.prepare('DELETE FROM meta WHERE key IN (?, ?)').run(`resync:raw:${n}`, `resync:buckets:${n}`)
    bumpMaterializedRev()
  })()
  // Push the deleted pages out of the WAL too.
  try { db.pragma('wal_checkpoint(TRUNCATE)') } catch { /* next checkpoint does it */ }
  log.web.info('health data deleted', { scope: 'categories', categories: scoped.length, removed })
  return { deleted: scoped, storeId: getMeta('storeId') as string, paused: true, removed }
}

function countRows(): number {
  const db = getHealthDb()
  const s = db.prepare('SELECT COUNT(*) AS n FROM samples').get() as { n: number }
  const b = db.prepare('SELECT COUNT(*) AS n FROM buckets').get() as { n: number }
  return s.n + b.n
}
