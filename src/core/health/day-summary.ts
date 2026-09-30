/**
 * One local day from its buckets and raw samples: pure, no I/O.
 *
 * Buckets are HealthKit statistics (the Health app's own source merge already
 * applied), so a day's total is a sum of ONE tiling: per metric the widest
 * interval present wins (1d, else 1h, else 5m). Summing a phone's 1h and 1d
 * buckets together would count the same steps twice.
 */

import { localIso } from './day-key.js'

export interface BucketIn {
  metric: string
  start: number
  intervalSec: number
  sum: number | null
  avg: number | null
  min: number | null
  max: number | null
  count: number | null
}

export interface RawIn {
  type: string
  start: number
  end: number
  value: number | null
  tz: string
  sourceName: string
  meta: Record<string, unknown> | null
}

export interface DaySummary {
  date: string
  activity: {
    steps: number | null; distanceM: number | null; activeKcal: number | null; basalKcal: number | null
    exerciseMin: number | null; standMin: number | null; daylightMin: number | null
  }
  vitals: {
    restingHr: number | null; walkingHr: number | null; hrvSdnn: number | null
    respiratoryRate: number | null; spo2: number | null; vo2max: number | null
    heartRate: { avg: number; min: number | null; max: number | null } | null
  }
  workouts: Array<{
    activity: string | null; start: string; end: string; durationMin: number
    energyKcal: number | null; distanceM: number | null; source: string
  }>
  stateOfMind: Array<{ at: string; kind: string | null; valence: number; labels: string[] }>
  audio: { envAvgDb: number | null; headphoneAvgDb: number | null }
  mindfulMin: number | null
}

const round1 = (v: number): number => Math.round(v * 10) / 10

/** The single tiling for one metric: its widest interval's buckets. */
function tiling(buckets: BucketIn[]): BucketIn[] {
  if (buckets.length === 0) return []
  const widest = Math.max(...buckets.map((b) => b.intervalSec))
  return buckets.filter((b) => b.intervalSec === widest)
}

function sumOf(buckets: BucketIn[]): number | null {
  const set = tiling(buckets).filter((b) => b.sum !== null)
  if (set.length === 0) return null
  return round1(set.reduce((acc, b) => acc + (b.sum ?? 0), 0))
}

function avgOf(buckets: BucketIn[]): { avg: number; min: number | null; max: number | null } | null {
  const set = tiling(buckets).filter((b) => b.avg !== null)
  if (set.length === 0) return null
  let sum = 0
  let weight = 0
  let min: number | null = null
  let max: number | null = null
  for (const b of set) {
    const w = b.count && b.count > 0 ? b.count : 1
    sum += (b.avg ?? 0) * w
    weight += w
    if (b.min !== null) min = min === null ? b.min : Math.min(min, b.min)
    if (b.max !== null) max = max === null ? b.max : Math.max(max, b.max)
  }
  return { avg: round1(sum / weight), min, max }
}

function rawMean(raw: RawIn[], type: string): number | null {
  const values = raw.filter((r) => r.type === type && r.value !== null).map((r) => r.value as number)
  return values.length ? round1(values.reduce((a, b) => a + b, 0) / values.length) : null
}

function rawLatest(raw: RawIn[], type: string): number | null {
  const rows = raw.filter((r) => r.type === type && r.value !== null).sort((a, b) => b.end - a.end)
  return rows.length ? round1(rows[0].value as number) : null
}

function metaString(meta: Record<string, unknown> | null, key: string): string | null {
  const v = meta?.[key]
  return typeof v === 'string' ? v : null
}

function metaNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const v = meta?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? round1(v) : null
}

export function foldDay(date: string, buckets: readonly BucketIn[], raw: readonly RawIn[]): DaySummary {
  const byMetric = new Map<string, BucketIn[]>()
  for (const b of buckets) {
    const list = byMetric.get(b.metric) ?? []
    list.push(b)
    byMetric.set(b.metric, list)
  }
  const m = (name: string): BucketIn[] => byMetric.get(name) ?? []
  const rawRows = [...raw]
  const hrBuckets = avgOf(m('heart_rate'))
  const hrRaw = rawMean(rawRows, 'heart_rate')
  const respBuckets = avgOf(m('respiratory_rate'))
  const mindful = rawRows.filter((r) => r.type === 'mindful' && r.value !== null)

  return {
    date,
    activity: {
      steps: sumOf(m('steps')),
      distanceM: sumOf(m('distance')),
      activeKcal: sumOf(m('active_energy')),
      basalKcal: sumOf(m('basal_energy')),
      exerciseMin: sumOf(m('exercise_min')),
      standMin: sumOf(m('stand_min')),
      daylightMin: sumOf(m('daylight_min')),
    },
    vitals: {
      restingHr: rawMean(rawRows, 'resting_hr'),
      walkingHr: rawMean(rawRows, 'walking_hr'),
      hrvSdnn: rawMean(rawRows, 'hrv_sdnn'),
      respiratoryRate: respBuckets?.avg ?? rawMean(rawRows, 'respiratory_rate'),
      spo2: rawMean(rawRows, 'spo2'),
      vo2max: rawLatest(rawRows, 'vo2max'),
      heartRate: hrBuckets ?? (hrRaw === null ? null : { avg: hrRaw, min: null, max: null }),
    },
    workouts: rawRows.filter((r) => r.type === 'workout').sort((a, b) => a.start - b.start).map((r) => ({
      activity: metaString(r.meta, 'activity'),
      start: localIso(r.start, r.tz),
      end: localIso(r.end, r.tz),
      durationMin: round1(r.value ?? (r.end - r.start) / 60_000),
      energyKcal: metaNumber(r.meta, 'energyKcal'),
      distanceM: metaNumber(r.meta, 'distanceM'),
      source: r.sourceName,
    })),
    stateOfMind: rawRows.filter((r) => r.type === 'state_of_mind' && r.value !== null).sort((a, b) => a.start - b.start).map((r) => ({
      at: localIso(r.start, r.tz),
      kind: metaString(r.meta, 'kind'),
      valence: Math.round((r.value as number) * 100) / 100,
      labels: Array.isArray(r.meta?.labels) ? (r.meta!.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [],
    })),
    audio: { envAvgDb: avgOf(m('audio_env'))?.avg ?? null, headphoneAvgDb: avgOf(m('audio_headphone'))?.avg ?? null },
    mindfulMin: mindful.length ? round1(mindful.reduce((a, r) => a + (r.value as number), 0)) : null,
  }
}
