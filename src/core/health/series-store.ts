/**
 * Recordings in the store (series-catalog.ts): write one sync call's chunks,
 * delete by uuid, and the reads behind health_recordings.
 *
 * Rules (each pinned by tests/core/health/series.test.ts):
 *   - a chunk is insert-or-ignore by (uuid, index): a resent call stores nothing twice;
 *   - the header is written by the first chunk that arrives; a chunk that names a
 *     different chunk count than the stored header (a phone build that chunks
 *     differently) replaces the recording: its old chunks no longer line up;
 *   - once every chunk is stored, the summary is computed in the same
 *     transaction, and the recording reads as complete;
 *   - a deleted uuid removes the header and every chunk.
 *
 * Logs carry counts only, never a point.
 */

import type { Database as DatabaseType } from '../../lib/sqlite.js'
import { getHealthDb } from './db.js'
import { localDate, localIso } from './day-key.js'
import { HealthQueryError, MAX_RANGE_DAYS, healthTz, toInstant } from './query-common.js'
import type { CleanSeriesItem } from './sanitize.js'
import { SERIES_TYPES, SERIES_TYPE_NAMES, seriesSpec, seriesSummary, type SeriesPoint } from './series-catalog.js'

export interface SeriesApplied { accepted: number; inserted: number; completed: number; dates: Set<string> }

/** Store one call's chunks (call inside the sync transaction). */
export function applySeries(type: string, items: readonly CleanSeriesItem[]): SeriesApplied {
  const db = getHealthDb()
  const header = db.prepare('SELECT chunks, summary FROM series WHERE uuid = ?')
  const insertHeader = db.prepare(`INSERT INTO series
    (uuid, type, start_ms, end_ms, source_bundle, source_name, device, tz, local_date, chunks, summary)
    VALUES (@uuid, @type, @start, @end, @bundle, @name, @device, @tz, @localDate, @chunks, NULL)`)
  const insertChunk = db.prepare('INSERT OR IGNORE INTO series_chunks (uuid, idx, points, data) VALUES (?, ?, ?, ?)')
  const out: SeriesApplied = { accepted: 0, inserted: 0, completed: 0, dates: new Set() }
  const touched = new Set<string>()
  for (const item of items) {
    const stored = header.get(item.uuid) as { chunks: number; summary: string | null } | undefined
    if (stored && stored.chunks !== item.chunks) removeSeries(db, [item.uuid])
    if (!stored || stored.chunks !== item.chunks) {
      insertHeader.run({
        uuid: item.uuid, type, start: item.start, end: item.end, bundle: item.source.bundleId, name: item.source.name,
        device: item.device ?? null, tz: item.tz, localDate: localDate(item.end, item.tz), chunks: item.chunks,
      })
    }
    out.accepted++
    if (insertChunk.run(item.uuid, item.chunk, item.points.length, JSON.stringify(item.points)).changes === 1) {
      out.inserted++
      touched.add(item.uuid)
      out.dates.add(localDate(item.end, item.tz))
    }
  }
  for (const uuid of touched) if (completeIfReady(db, uuid)) out.completed++
  return out
}

/** Compute the summary once the last chunk is in. True when this call completed it. */
function completeIfReady(db: DatabaseType, uuid: string): boolean {
  const row = db.prepare('SELECT type, chunks, summary FROM series WHERE uuid = ?').get(uuid) as
    { type: string; chunks: number; summary: string | null } | undefined
  if (!row || row.summary !== null) return false
  const have = db.prepare('SELECT COUNT(*) AS n FROM series_chunks WHERE uuid = ?').get(uuid) as { n: number }
  if (have.n < row.chunks) return false
  const summary = seriesSummary(row.type, readPoints(db, uuid))
  db.prepare('UPDATE series SET summary = ? WHERE uuid = ?').run(JSON.stringify(summary), uuid)
  return true
}

function readPoints(db: DatabaseType, uuid: string): SeriesPoint[] {
  const rows = db.prepare('SELECT data FROM series_chunks WHERE uuid = ? ORDER BY idx').all(uuid) as Array<{ data: string }>
  return rows.flatMap((r) => JSON.parse(r.data) as SeriesPoint[])
}

function removeSeries(db: DatabaseType, uuids: readonly string[]): number {
  const delChunks = db.prepare('DELETE FROM series_chunks WHERE uuid = ?')
  const delHeader = db.prepare('DELETE FROM series WHERE uuid = ?')
  let removed = 0
  for (const uuid of uuids) {
    delChunks.run(uuid)
    removed += delHeader.run(uuid).changes
  }
  return removed
}

/** Remove the recordings these uuids name (a HealthKit deletion). Returns how many existed. */
export function deleteSeries(uuids: readonly string[]): number {
  return removeSeries(getHealthDb(), uuids)
}

/** Remove every recording of these types (a category delete). Returns header rows removed. */
export function deleteSeriesTypes(db: DatabaseType, types: readonly string[]): number {
  if (types.length === 0) return 0
  const marks = types.map(() => '?').join(', ')
  db.prepare(`DELETE FROM series_chunks WHERE uuid IN (SELECT uuid FROM series WHERE type IN (${marks}))`).run(...types)
  return db.prepare(`DELETE FROM series WHERE type IN (${marks})`).run(...types).changes
}

export function countSeries(db: DatabaseType): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM series').get() as { n: number }).n
}

/** Last recording end of a type: one seek on series_type_end. */
export function seriesLastEnd(db: DatabaseType, type: string): number | null {
  return (db.prepare('SELECT MAX(end_ms) AS v FROM series WHERE type = ?').get(type) as { v: number | null }).v
}

// ── reads (health_recordings) ──

const DAY_MS = 86_400_000
const DEFAULT_ROWS = 50
const MAX_ROWS = 200
/** Most points one detail read returns; a longer route is thinned evenly, keeping both ends. */
export const MAX_DETAIL_POINTS = 2000

interface SeriesRow {
  uuid: string; type: string; start_ms: number; end_ms: number; source_name: string; device: string | null
  tz: string; chunks: number; summary: string | null
}

function thin(points: SeriesPoint[], max: number): SeriesPoint[] {
  if (points.length <= max) return points
  const step = (points.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)])
}

/** The workout a route was recorded in: the workout sample whose span holds the route's middle. */
function workoutFor(db: DatabaseType, row: SeriesRow): Record<string, unknown> | null {
  const mid = Math.round((row.start_ms + row.end_ms) / 2)
  const w = db.prepare(`SELECT start_ms, end_ms, value, tz, meta FROM samples
    WHERE type = 'workout' AND start_ms <= ? AND end_ms >= ? ORDER BY start_ms DESC LIMIT 1`).get(mid, mid) as
    { start_ms: number; end_ms: number; value: number | null; tz: string; meta: string | null } | undefined
  if (!w) return null
  let activity: unknown = null
  try { activity = w.meta ? (JSON.parse(w.meta) as Record<string, unknown>).activity ?? null : null } catch { /* none */ }
  return { start: localIso(w.start_ms, w.tz), end: localIso(w.end_ms, w.tz), minutes: w.value, activity }
}

function rowView(db: DatabaseType, r: SeriesRow, have: number) {
  return {
    id: r.uuid,
    start: localIso(r.start_ms, r.tz),
    end: localIso(r.end_ms, r.tz),
    source: r.source_name,
    device: r.device,
    tz: r.tz,
    complete: r.summary !== null,
    ...(r.summary === null ? { chunksReceived: have, chunks: r.chunks } : {}),
    summary: r.summary === null ? null : JSON.parse(r.summary) as Record<string, unknown>,
    ...(r.type === 's.WorkoutRoute' ? { workout: workoutFor(db, r) } : {}),
  }
}

function resolveLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_ROWS
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_ROWS) {
    throw new HealthQueryError(`limit must be an integer from 1 to ${MAX_ROWS}`)
  }
  return n
}

/**
 * Without `id`: the recordings of one type, newest first, each with its summary.
 * With `id`: that one recording with its points (columns named by `columns`).
 */
export function recordingsQuery(args: { type?: string; id?: string; from?: string; to?: string; limit?: unknown }, now = Date.now()) {
  const type = args.type ?? ''
  const spec = seriesSpec(type)
  if (!spec) throw new HealthQueryError(`type must be one of: ${SERIES_TYPE_NAMES.join(', ')}`)
  const db = getHealthDb()
  const count = db.prepare('SELECT COUNT(*) AS n FROM series_chunks WHERE uuid = ?')
  if (args.id !== undefined) {
    const r = db.prepare(`SELECT uuid, type, start_ms, end_ms, source_name, device, tz, chunks, summary
      FROM series WHERE uuid = ? AND type = ?`).get(args.id, type) as SeriesRow | undefined
    if (!r) throw new HealthQueryError(`no ${type} recording with id ${args.id}: list them first (without id)`)
    const all = readPoints(db, r.uuid)
    const points = thin(all, MAX_DETAIL_POINTS)
    return {
      type, recording: rowView(db, r, (count.get(r.uuid) as { n: number }).n),
      columns: SERIES_TYPES[type].columns,
      points,
      ...(points.length < all.length ? { thinned: { from: all.length, to: points.length } } : {}),
    }
  }
  const tz = healthTz()
  const limit = resolveLimit(args.limit)
  const toMs = toInstant(args.to ?? localDate(now, tz), tz, true)
  const fromMs = args.from !== undefined ? toInstant(args.from, tz, false) : 0
  if (!(fromMs < toMs)) throw new HealthQueryError('from must be before to')
  if (args.from !== undefined && toMs - fromMs > (MAX_RANGE_DAYS * 4 + 1) * DAY_MS) {
    throw new HealthQueryError(`a read covers at most ${MAX_RANGE_DAYS * 4} days`)
  }
  const rows = db.prepare(`SELECT uuid, type, start_ms, end_ms, source_name, device, tz, chunks, summary
    FROM series WHERE type = ? AND end_ms >= ? AND end_ms < ? ORDER BY end_ms DESC LIMIT ?`)
    .all(type, fromMs, toMs, limit + 1) as SeriesRow[]
  const truncated = rows.length > limit
  return {
    type, tz, columns: SERIES_TYPES[type].columns,
    recordings: rows.slice(0, limit).map((r) => rowView(db, r, r.summary === null ? (count.get(r.uuid) as { n: number }).n : r.chunks)),
    truncated,
    ...(truncated ? { note: `Only the newest ${limit} recordings are listed: narrow from/to to read older ones.` } : {}),
  }
}
