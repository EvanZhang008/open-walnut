/**
 * health_series: one metric over time, folded IN SQL (GROUP BY), so a 90-day
 * read of 5-minute heart-rate buckets moves at most MAX_SERIES_POINTS rows into
 * JavaScript instead of 26k.
 *
 * Bucket rows are ONE tiling per metric: the widest stored interval that is not
 * coarser than the requested bucket (else the finest there is). Mixing a 1h and a
 * 1d bucket of the same steps would count them twice.
 *
 * A generic quantity type (`q.<Suffix>`) is a metric too: its buckets fold by the
 * agg pinned at its first bucket sync, its raw samples answer avg/min/max plus a
 * sum (meaningful only for cumulative types such as dietary intake). A generic
 * name the catalog covers (`q.HeartRate`) reads the catalog metric.
 */

import { GENERIC_COVERED, aggPinKey, isGenericType, isQuantityType, metricSpec, unitPinKey } from './catalog.js'
import { getHealthDb, getMeta } from './db.js'
import { localDate } from './day-key.js'
import { HealthQueryError, MAX_RANGE_DAYS, MAX_SERIES_POINTS, healthTz, toInstant } from './query-common.js'

const BUCKETS = { '5m': 300, '1h': 3600, '1d': 86_400 } as const
type BucketName = keyof typeof BUCKETS

interface Row { k: number | string; t: number; s: number | null; wa: number | null; w: number | null; lo: number | null; hi: number | null; n: number | null }

/** How one metric reads: its unit, whether it has buckets and raw rows, and how bucket points fold. */
interface SeriesSpec { unit: string | null; raw: boolean; buckets: boolean; fold: 'sum' | 'avg'; generic: boolean }

function seriesSpec(metric: string): SeriesSpec {
  const spec = metricSpec(metric)
  if (spec && metric !== 'sleep') {
    return { unit: spec.unit, raw: spec.raw, buckets: spec.buckets, fold: spec.agg === 'sum' ? 'sum' : 'avg', generic: false }
  }
  if (isQuantityType(metric)) {
    const agg = getMeta(aggPinKey(metric))
    return { unit: getMeta(unitPinKey(metric)) ?? null, raw: true, buckets: true, fold: agg === 'sum' ? 'sum' : 'avg', generic: true }
  }
  if (isGenericType(metric)) {
    throw new HealthQueryError(`${metric} is not a quantity type, so it has no series: read its rows with health_samples`)
  }
  throw new HealthQueryError('metric must be a catalog name other than sleep (use health_sleep for nights) or a q.<Suffix> type from health_status')
}

export async function seriesQuery(args: { metric?: string; from?: string; to?: string; bucket?: string }, now = Date.now()) {
  const requested = args.metric ?? ''
  const metric = Object.hasOwn(GENERIC_COVERED, requested) ? GENERIC_COVERED[requested] : requested
  const spec = seriesSpec(metric)
  const tz = healthTz()
  const today = localDate(now, tz)
  const fromMs = toInstant(args.from ?? today, tz, false)
  const toMs = toInstant(args.to ?? today, tz, true)
  if (!(fromMs < toMs)) throw new HealthQueryError('from must be before to')
  if (toMs - fromMs > (MAX_RANGE_DAYS + 1) * 86_400_000) throw new HealthQueryError(`a series covers at most ${MAX_RANGE_DAYS} days`)
  const span = toMs - fromMs
  const bucket: BucketName = args.bucket && Object.hasOwn(BUCKETS, args.bucket)
    ? args.bucket as BucketName
    : span <= 2 * 86_400_000 ? '5m' : span <= 31 * 86_400_000 ? '1h' : '1d'
  if (args.bucket && !Object.hasOwn(BUCKETS, args.bucket)) throw new HealthQueryError('bucket must be 5m, 1h or 1d')
  const size = BUCKETS[bucket]
  const db = getHealthDb()
  const key = size === 86_400 ? 'local_date' : null
  let rows: Row[] = []
  let sourceIntervalSec: number | null = null

  if (spec.buckets) {
    const has = db.prepare('SELECT 1 FROM buckets WHERE metric = ? AND interval_sec = ? AND start_ms >= ? AND start_ms < ? LIMIT 1')
    const available = [300, 3600, 86_400].filter((i) => has.get(metric, i, fromMs, toMs))
    sourceIntervalSec = [...available].reverse().find((i) => i <= size) ?? available[0] ?? null
    if (sourceIntervalSec !== null) {
      const group = key ?? `(start_ms / ${Math.max(size, sourceIntervalSec) * 1000})`
      rows = db.prepare(`SELECT ${group} AS k, MIN(start_ms) AS t, SUM(sum) AS s,
          SUM(avg * COALESCE(count, 1)) AS wa, SUM(CASE WHEN avg IS NULL THEN 0 ELSE COALESCE(count, 1) END) AS w,
          MIN(min) AS lo, MAX(max) AS hi, SUM(count) AS n
        FROM buckets WHERE metric = ? AND interval_sec = ? AND start_ms >= ? AND start_ms < ?
        GROUP BY k ORDER BY t DESC LIMIT ?`).all(metric, sourceIntervalSec, fromMs, toMs, MAX_SERIES_POINTS + 1) as Row[]
    }
  }
  let fromRaw = false
  if (rows.length === 0 && spec.raw) {
    const group = key ?? `(end_ms / ${size * 1000})`
    rows = db.prepare(`SELECT ${group} AS k, MIN(end_ms) AS t, SUM(value) AS s, SUM(value) AS wa, COUNT(value) AS w,
        MIN(value) AS lo, MAX(value) AS hi, COUNT(*) AS n
      FROM samples WHERE type = ? AND end_ms >= ? AND end_ms < ? AND value IS NOT NULL
      GROUP BY k ORDER BY t DESC LIMIT ?`).all(metric, fromMs, toMs, MAX_SERIES_POINTS + 1) as Row[]
    fromRaw = rows.length > 0
    sourceIntervalSec = fromRaw ? 0 : sourceIntervalSec
  }

  const truncated = rows.length > MAX_SERIES_POINTS
  const kept = rows.slice(0, MAX_SERIES_POINTS).reverse()
  const round = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10)
  // Catalog metrics keep their one fold; raw generic samples carry no fold, so they get all four.
  const fields = spec.generic && fromRaw ? 'all' : spec.fold
  const points = kept.map((r) => {
    const avg = round(r.w && r.w > 0 && r.wa !== null ? r.wa / r.w : null)
    return {
      t: key ? String(r.k) : new Date(r.t).toISOString(),
      ...(fields === 'sum' ? { sum: round(r.s) }
        : fields === 'avg' ? { avg, min: round(r.lo), max: round(r.hi) }
          : { avg, min: round(r.lo), max: round(r.hi), sum: round(r.s) }),
      count: r.n ?? 0,
    }
  })
  return {
    metric,
    ...(metric !== requested ? { requested } : {}),
    unit: spec.unit,
    bucket,
    /** 0 = folded from raw samples; otherwise the stored bucket width the points were built from. */
    sourceIntervalSec,
    ...(spec.generic && !fromRaw && sourceIntervalSec !== null ? { agg: spec.fold } : {}),
    tz,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    points,
    truncated,
    ...(truncated ? { note: `Only the latest ${MAX_SERIES_POINTS} points are returned: use a wider bucket or a shorter range.` } : {}),
  }
}
