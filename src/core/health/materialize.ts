/**
 * Derived nights and days, recomputed only for the dates a batch touched.
 *
 * A sync marks its dates dirty IN ITS OWN TRANSACTION (the `dirty` table), so a
 * restart between commit and recompute re-reads the marks instead of serving a
 * stale night. The in-memory sets below mirror that table for the open handle.
 * A drain rebuilds ONE date per event-loop tick (setImmediate), and a read that
 * lands on a dirty or stale date recomputes it on the spot, yielding after EVERY
 * recompute: a cold rebuild of 118 nights after a source-order change never holds
 * the loop for more than one night's work. A date with no data is stored too
 * (json `null`), so an empty baseline window costs one indexed read per date on
 * the next call, not a recompute and a tick each time.
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { log } from '../../logging/index.js'
import { DAY_BUCKET_METRICS, DAY_RAW_TYPES } from './catalog.js'
import { getHealthDb, getMetaJson, materializedRev } from './db.js'
import { assembleNight, type NightSummary, type NightVitalsIn, type SleepSampleIn, type VitalPoint } from './sleep-merge.js'
import { foldDay, type BucketIn, type DaySummary, type RawIn } from './day-summary.js'
import { rankSources, sourceKey, type SourceInfo } from './source-order.js'

const dirtyNights = new Set<string>()
const dirtyDays = new Set<string>()
let drainScheduled = false
/** The handle the sets above mirror; a new handle (a restart, a delete) re-reads the table. */
let loadedFor: DatabaseType | null = null

function syncDirty(): void {
  const db = getHealthDb()
  if (loadedFor === db) return
  loadedFor = db
  dirtyNights.clear()
  dirtyDays.clear()
  const rows = db.prepare('SELECT kind, date FROM dirty').all() as Array<{ kind: string; date: string }>
  for (const r of rows) (r.kind === 'night' ? dirtyNights : dirtyDays).add(r.date)
  scheduleDrain()
}

/** Record stale dates. Call INSIDE the transaction that made them stale. */
export function persistDirty(nights: Iterable<string>, days: Iterable<string>): void {
  const insert = getHealthDb().prepare('INSERT OR IGNORE INTO dirty (kind, date) VALUES (?, ?)')
  for (const d of nights) insert.run('night', d)
  for (const d of days) insert.run('day', d)
}

/** After the commit: mirror the marks in memory and schedule the drain. */
export function markDirty(nights: Iterable<string>, days: Iterable<string>): void {
  syncDirty()
  for (const d of nights) dirtyNights.add(d)
  for (const d of days) dirtyDays.add(d)
  scheduleDrain()
}

/** Boot: pick up marks a previous process committed but never drained. */
export function resumeMaterialize(): void {
  syncDirty()
}

export function pendingRecomputes(): number {
  syncDirty()
  return dirtyNights.size + dirtyDays.size
}

/** Forget the in-memory mirror (tests; a restart does the same). The table stays. */
export function resetMaterializeQueue(): void {
  dirtyNights.clear()
  dirtyDays.clear()
  loadedFor = null
}

function scheduleDrain(): void {
  if (drainScheduled || (dirtyNights.size === 0 && dirtyDays.size === 0)) return
  drainScheduled = true
  setImmediate(drainStep)
}

function takeFirst(set: Set<string>): string | undefined {
  const first = set.values().next()
  if (first.done) return undefined
  set.delete(first.value)
  return first.value
}

function drainStep(): void {
  drainScheduled = false
  try {
    syncDirty()
    const night = takeFirst(dirtyNights)
    if (night !== undefined) computeNight(night)
    else {
      const day = takeFirst(dirtyDays)
      if (day !== undefined) computeDay(day)
    }
  } catch (err) {
    // A closed or deleted store: the next read recomputes on demand anyway.
    log.web.debug('health materialize step skipped', { error: err instanceof Error ? err.message : String(err) })
  }
  scheduleDrain()
}

/** Wait until every queued recompute has run (tests and the perf probe). */
export async function drainMaterializeQueue(): Promise<void> {
  while (dirtyNights.size > 0 || dirtyDays.size > 0 || drainScheduled) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function sourceInfos(): Map<string, SourceInfo> {
  const rows = getHealthDb().prepare('SELECT bundle, first_seen_ms, first_sample_ms, apple FROM sources').all() as Array<{
    bundle: string; first_seen_ms: number; first_sample_ms: number; apple: number
  }>
  return new Map(rows.map((r) => [r.bundle, {
    bundle: r.bundle, firstSeenMs: r.first_seen_ms, firstSampleMs: r.first_sample_ms, apple: r.apple === 1,
  }]))
}

export function savedSourceOrder(): string[] | null {
  const order = getMetaJson<unknown>('sleepSourceOrder')
  return Array.isArray(order) && order.every((v) => typeof v === 'string') ? order as string[] : null
}

function vitalPoints(metric: string, date: string): VitalPoint[] {
  const db = getHealthDb()
  const raw = db.prepare('SELECT start_ms, end_ms, value FROM samples WHERE type = ? AND night_date = ? AND value IS NOT NULL')
    .all(metric, date) as Array<{ start_ms: number; end_ms: number; value: number }>
  const buckets = db.prepare('SELECT start_ms, interval_sec, avg, count FROM buckets WHERE metric = ? AND night_date = ? AND avg IS NOT NULL')
    .all(metric, date) as Array<{ start_ms: number; interval_sec: number; avg: number; count: number | null }>
  // Prefer the finest bucket tiling for a vital measured across a night.
  const finest = buckets.length ? Math.min(...buckets.map((b) => b.interval_sec)) : 0
  return [
    ...raw.map((r) => ({ start: r.start_ms, end: r.end_ms, value: r.value })),
    ...buckets.filter((b) => b.interval_sec === finest).map((b) => ({
      start: b.start_ms, end: b.start_ms + b.interval_sec * 1000, value: b.avg, weight: b.count ?? 1,
    })),
  ]
}

/** Rebuild one night and store it. Returns null when the night has no sleep samples. */
export function computeNight(date: string): NightSummary | null {
  const db = getHealthDb()
  dirtyNights.delete(date)
  const rows = db.prepare(
    "SELECT start_ms, end_ms, code, source_bundle, source_name, tz, user_entered FROM samples WHERE type = 'sleep' AND night_date = ?",
  ).all(date) as Array<{
    start_ms: number; end_ms: number; code: number; source_bundle: string; source_name: string; tz: string; user_entered: number
  }>
  if (rows.length === 0) {
    storeDerived('nights', 'night', date, null)
    return null
  }
  const samples: SleepSampleIn[] = rows.map((r) => ({
    start: r.start_ms, end: r.end_ms, code: r.code, key: sourceKey(r.source_bundle, r.user_entered === 1),
    bundle: r.source_bundle, name: r.source_name, tz: r.tz,
  }))
  const ranks = rankSources(samples.map((s) => s.key), sourceInfos(), savedSourceOrder())
  const vitals: NightVitalsIn = {
    heartRate: vitalPoints('heart_rate', date),
    hrvSdnn: vitalPoints('hrv_sdnn', date),
    respiratoryRate: vitalPoints('respiratory_rate', date),
    spo2: vitalPoints('spo2', date),
    wristTemp: vitalPoints('wrist_temp', date),
  }
  const night = assembleNight(date, samples, (k) => ranks.get(k) ?? Number.MAX_SAFE_INTEGER, vitals)
  storeDerived('nights', 'night', date, night)
  return night
}

/** Rebuild one day and store it. Returns null when the day holds no data at all. */
export function computeDay(date: string): DaySummary | null {
  const db = getHealthDb()
  dirtyDays.delete(date)
  // Catalog rows only: a day summary never folds a generic type, so it never reads one.
  const buckets = db.prepare(
    `SELECT metric, start_ms, interval_sec, sum, avg, min, max, count FROM buckets WHERE local_date = ? AND metric IN (${marks(DAY_BUCKET_METRICS)})`,
  ).all(date, ...DAY_BUCKET_METRICS) as Array<{ metric: string; start_ms: number; interval_sec: number; sum: number | null; avg: number | null; min: number | null; max: number | null; count: number | null }>
  const raw = db.prepare(
    `SELECT type, start_ms, end_ms, value, tz, source_name, meta FROM samples WHERE local_date = ? AND type IN (${marks(DAY_RAW_TYPES)})`,
  ).all(date, ...DAY_RAW_TYPES) as Array<{ type: string; start_ms: number; end_ms: number; value: number | null; tz: string; source_name: string; meta: string | null }>
  if (buckets.length === 0 && raw.length === 0) {
    storeDerived('days', 'day', date, null)
    return null
  }
  const bucketsIn: BucketIn[] = buckets.map((b) => ({
    metric: b.metric, start: b.start_ms, intervalSec: b.interval_sec, sum: b.sum, avg: b.avg, min: b.min, max: b.max, count: b.count,
  }))
  const rawIn: RawIn[] = raw.map((r) => ({
    type: r.type, start: r.start_ms, end: r.end_ms, value: r.value, tz: r.tz, sourceName: r.source_name,
    meta: r.meta ? safeJson(r.meta) : null,
  }))
  const day = foldDay(date, bucketsIn, rawIn)
  storeDerived('days', 'day', date, day)
  return day
}

/** Store one derived date (null = no data) and clear its dirty mark, atomically. */
function storeDerived(table: 'nights' | 'days', kind: 'night' | 'day', date: string, value: unknown): void {
  const db = getHealthDb()
  db.transaction(() => {
    db.prepare(`INSERT INTO ${table} (date, rev, json) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET rev = excluded.rev, json = excluded.json`)
      .run(date, materializedRev(), JSON.stringify(value))
    db.prepare('DELETE FROM dirty WHERE kind = ? AND date = ?').run(kind, date)
  })()
}

function marks(list: readonly string[]): string {
  return list.map(() => '?').join(', ')
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

async function readMany<T>(
  table: 'nights' | 'days',
  dates: readonly string[],
  dirty: Set<string>,
  compute: (date: string) => T | null,
): Promise<Map<string, T | null>> {
  syncDirty()
  const db = getHealthDb()
  const rev = materializedRev()
  const out = new Map<string, T | null>()
  const stmt = db.prepare(`SELECT rev, json FROM ${table} WHERE date = ?`)
  for (const date of dates) {
    const row = stmt.get(date) as { rev: number; json: string } | undefined
    if (row && row.rev === rev && !dirty.has(date)) {
      out.set(date, JSON.parse(row.json) as T | null)
      continue
    }
    out.set(date, compute(date))
    // One recompute per tick: every other route gets the loop between nights.
    await new Promise((resolve) => setImmediate(resolve))
  }
  return out
}

export function readNights(dates: readonly string[]): Promise<Map<string, NightSummary | null>> {
  return readMany('nights', dates, dirtyNights, computeNight)
}

export function readDays(dates: readonly string[]): Promise<Map<string, DaySummary | null>> {
  return readMany('days', dates, dirtyDays, computeDay)
}
