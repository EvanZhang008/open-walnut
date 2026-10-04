/**
 * Per-type first and last instants for health_status, by index SEEKS only.
 *
 * health_status runs on every health question, so it must not scan rows. SQLite
 * answers `MIN(x)` or `MAX(x)` alone as one index seek, but both in one query (or
 * any COUNT) walk every entry of the type: measured at 1M rows, a grouped
 * MIN/MAX/COUNT took 75 ms of CPU against 0.1 ms for the seeks below. That is also
 * why status carries no per-type row count.
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { genericTypeSql } from './catalog.js'

export interface Span { lo: number | null; hi: number | null }

const DAY_MS = 86_400_000

/** First and last sample END of one raw type: two seeks on samples_type_end. */
export function sampleSpan(db: DatabaseType, type: string): Span {
  const lo = db.prepare('SELECT MIN(end_ms) AS v FROM samples WHERE type = ?').get(type) as { v: number | null }
  const hi = db.prepare('SELECT MAX(end_ms) AS v FROM samples WHERE type = ?').get(type) as { v: number | null }
  return { lo: lo.v, hi: hi.v }
}

/**
 * First bucket start and last bucket END of one metric. No bucket is wider than a
 * day, so the latest end is among the buckets starting in the last day: a short
 * range read after one seek, never the metric's whole history. `now` caps the end:
 * today's day bucket ends at tomorrow's midnight, a time no data has reached yet.
 */
export function bucketSpan(db: DatabaseType, metric: string, now = Date.now()): Span {
  const lo = db.prepare('SELECT MIN(start_ms) AS v FROM buckets WHERE metric = ?').get(metric) as { v: number | null }
  const last = db.prepare('SELECT MAX(start_ms) AS v FROM buckets WHERE metric = ?').get(metric) as { v: number | null }
  if (last.v === null) return { lo: lo.v, hi: null }
  const hi = db.prepare('SELECT MAX(start_ms + interval_sec * 1000) AS v FROM buckets WHERE metric = ? AND start_ms >= ?')
    .get(metric, last.v - DAY_MS) as { v: number | null }
  return { lo: lo.v, hi: hi.v === null ? null : Math.min(hi.v, now) }
}

/**
 * Every distinct generic name stored in a table, by a skip scan: each step is one
 * seek to the next name in the index, so the cost follows the number of TYPES,
 * not the number of rows.
 */
export function storedGenericNames(db: DatabaseType, table: 'samples' | 'buckets'): string[] {
  const col = table === 'samples' ? 'type' : 'metric'
  const rows = db.prepare(`WITH RECURSIVE t(name) AS (
      SELECT MIN(${col}) FROM ${table}
      UNION ALL
      SELECT (SELECT MIN(${col}) FROM ${table} WHERE ${col} > t.name) FROM t WHERE t.name IS NOT NULL
    ) SELECT name FROM t WHERE name IS NOT NULL AND (${genericTypeSql('name')})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}
