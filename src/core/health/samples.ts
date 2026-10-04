/**
 * health_samples: the stored rows of ONE raw type, newest first, for the types
 * no summary covers (blood pressure, body mass, symptoms, an ECG, a GAD-7 score,
 * blood type …). Rows come as the phone sent them: `value` in the type's unit,
 * `code` the HealthKit raw value for category types and other kinds.
 *
 * One indexed read (samples_type_end), bounded by `limit`. A characteristic is a
 * current value, not a series, so its window is ignored.
 */

import {
  GENERIC_COVERED, HEALTH_MAX_SAMPLE_ROWS as MAX_SAMPLE_ROWS, SLEEP_CODES, isCharacteristic, isGenericType, metricSpec, unitPinKey,
} from './catalog.js'
import { getHealthDb, getMeta } from './db.js'
import { addDays, localDate, localIso, zonedMidnight } from './day-key.js'
import { HealthQueryError, MAX_RANGE_DAYS, healthTz, toInstant } from './query-common.js'

const DEFAULT_SAMPLE_ROWS = 100
const DAY_MS = 86_400_000

interface SampleRow {
  start_ms: number; end_ms: number; value: number | null; code: number | null
  source_name: string; device: string | null; tz: string; meta: string | null
}

function parseMeta(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function resolveLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_SAMPLE_ROWS
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_SAMPLE_ROWS) {
    throw new HealthQueryError(`limit must be an integer from 1 to ${MAX_SAMPLE_ROWS}`)
  }
  return n
}

export async function samplesQuery(args: { type?: string; from?: string; to?: string; limit?: unknown }, now = Date.now()) {
  const requested = args.type ?? ''
  const type = Object.hasOwn(GENERIC_COVERED, requested) ? GENERIC_COVERED[requested] : requested
  const spec = metricSpec(type)
  const generic = isGenericType(type)
  if (spec && !spec.raw) throw new HealthQueryError(`${type} is stored as buckets only: read it with health_series or health_daily`)
  if (!spec && !generic) throw new HealthQueryError('type must be a catalog raw type (sleep, heart_rate, …) or a q. / c. / x. type from health_status')
  const limit = resolveLimit(args.limit)
  const tz = healthTz()
  const characteristic = isCharacteristic(type)
  // Default: the longest window a read may cover, ending today.
  const toMs = characteristic ? Number.MAX_SAFE_INTEGER : toInstant(args.to ?? localDate(now, tz), tz, true)
  const fromMs = characteristic ? 0
    : args.from !== undefined ? toInstant(args.from, tz, false)
      : zonedMidnight(addDays(localDate(toMs - 1, tz), -(MAX_RANGE_DAYS - 1)), tz)
  if (!(fromMs < toMs)) throw new HealthQueryError('from must be before to')
  if (!characteristic && toMs - fromMs > (MAX_RANGE_DAYS + 1) * DAY_MS) throw new HealthQueryError(`a read covers at most ${MAX_RANGE_DAYS} days`)

  const db = getHealthDb()
  const rows = db.prepare(`SELECT start_ms, end_ms, value, code, source_name, device, tz, meta
    FROM samples WHERE type = ? AND end_ms >= ? AND end_ms < ? ORDER BY end_ms DESC LIMIT ?`)
    .all(type, fromMs, toMs, limit + 1) as SampleRow[]
  const truncated = rows.length > limit
  const unit = spec ? spec.unit : getMeta(unitPinKey(type)) ?? null
  const out = rows.slice(0, limit).map((r) => ({
    start: localIso(r.start_ms, r.tz),
    end: localIso(r.end_ms, r.tz),
    value: r.value,
    code: r.code,
    unit,
    source: r.source_name,
    device: r.device,
    tz: r.tz,
    meta: parseMeta(r.meta),
  }))
  const storedAsBuckets = out.length === 0 && generic
    && !!db.prepare('SELECT 1 FROM buckets WHERE metric = ? LIMIT 1').get(type)
  return {
    type,
    ...(type !== requested ? { requested } : {}),
    unit,
    tz,
    ...(characteristic ? {} : { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }),
    rows: out,
    truncated,
    ...(type === 'sleep' ? { codes: SLEEP_CODES } : {}),
    ...(truncated ? { note: `Only the newest ${limit} rows are returned: narrow from/to to read older ones.` } : {}),
    ...(storedAsBuckets ? { note: `${type} is stored as buckets: read it with health_series.` } : {}),
  }
}
