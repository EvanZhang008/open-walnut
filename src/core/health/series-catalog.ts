/**
 * Apple Health recordings: HealthKit objects that are a list of points, not one
 * value. Each arrives under an `s.` name and lives in its own tables (db.ts:
 * `series`, `series_chunks`), never in `samples`:
 *
 *   s.Audiogram        HKAudiogramSample: [frequencyHz, leftDbHL|null, rightDbHL|null]
 *   s.HeartbeatSeries  HKHeartbeatSeriesSample: [offsetMs, precededByGap 0|1]
 *   s.WorkoutRoute     HKWorkoutRoute: [offsetMs, lat, lon, altitudeM|null, hAccuracyM|null, speedMps|null]
 *
 * `offsetMs` counts from the recording's start. A long recording is sent in
 * chunks (one sync item per chunk, `chunk` 0..`chunks`-1, same uuid), so a two
 * hour route never exceeds the per-call caps. A recording is complete once every
 * chunk is stored; only then is its summary computed.
 *
 * Why a separate family instead of a generic `x.` name: a server that predates
 * these would store an `x.` item's times and drop its points, answer 200, and the
 * phone would move its anchor past points that never arrived. An `s.` name is a
 * type such a server does not know, so it answers `unsupported` and the phone
 * keeps its anchor. The phone also sends one only to a server whose status lists
 * it under `supported.series`.
 */

import type { HealthCategory } from './catalog.js'

export interface SeriesSpec {
  category: HealthCategory
  /** Point columns, in order: the names the read answers with. */
  columns: readonly string[]
  /** Most points one chunk may carry. */
  maxPointsPerChunk: number
  /**
   * Most chunks one recording may have. Completing a recording parses all of it
   * once on the event loop, so this bounds that parse (a 100-chunk route of the
   * phone's 1000-point chunks is about 3 MB of JSON); the phone thins a longer
   * route before it chunks it.
   */
  maxChunks: number
  /** Longest recording (ms between start and end). */
  maxSpanMs: number
  /** No recording for this long reads as `unknown_or_denied` in health_status. */
  staleAfterDays: number
}

const DAY_MS = 86_400_000

export const SERIES_TYPES: Readonly<Record<string, SeriesSpec>> = {
  's.Audiogram': {
    category: 'audio', columns: ['frequencyHz', 'leftDbHL', 'rightDbHL'],
    maxPointsPerChunk: 64, maxChunks: 1, maxSpanMs: 2 * DAY_MS, staleAfterDays: 3650,
  },
  's.HeartbeatSeries': {
    category: 'heart', columns: ['offsetMs', 'precededByGap'],
    maxPointsPerChunk: 2000, maxChunks: 20, maxSpanMs: 2 * DAY_MS, staleAfterDays: 14,
  },
  's.WorkoutRoute': {
    category: 'workouts', columns: ['offsetMs', 'lat', 'lon', 'altitudeM', 'hAccuracyM', 'speedMps'],
    maxPointsPerChunk: 2000, maxChunks: 100, maxSpanMs: 2 * DAY_MS, staleAfterDays: 60,
  },
}

export const SERIES_TYPE_NAMES: readonly string[] = Object.keys(SERIES_TYPES)

export function seriesSpec(name: unknown): SeriesSpec | undefined {
  return typeof name === 'string' && Object.hasOwn(SERIES_TYPES, name) ? SERIES_TYPES[name] : undefined
}

export function isSeriesType(name: unknown): name is string {
  return seriesSpec(name) !== undefined
}

/** The series types that belong to a set of categories (for DELETE / settings). */
export function seriesInCategories(categories: readonly HealthCategory[]): string[] {
  const set = new Set(categories)
  return SERIES_TYPE_NAMES.filter((n) => set.has(SERIES_TYPES[n].category))
}

/** What GET /health/status lists under `supported.series`: a phone sends only these. */
export function supportedSeries() {
  return {
    types: [...SERIES_TYPE_NAMES],
    maxPointsPerChunk: Object.fromEntries(SERIES_TYPE_NAMES.map((n) => [n, SERIES_TYPES[n].maxPointsPerChunk])),
    maxChunks: Object.fromEntries(SERIES_TYPE_NAMES.map((n) => [n, SERIES_TYPES[n].maxChunks])),
  }
}

export type SeriesPoint = Array<number | null>

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function optional(v: unknown, lo: number, hi: number): number | null | undefined {
  if (v === null || v === undefined) return null
  return finite(v) && v >= lo && v <= hi ? v : undefined
}

/**
 * A route's optional reading (altitude, accuracy, speed) outside its range is
 * dropped to null, never the point: a route recorded on a plane, or one GPS
 * speed spike, must not cost the whole chunk and leave the route incomplete.
 */
function reading(v: unknown, lo: number, hi: number): number | null | undefined {
  if (v === null || v === undefined) return null
  if (!finite(v)) return undefined
  return v >= lo && v <= hi ? v : null
}

/**
 * One point, checked against its type's columns and ranges, or undefined when it
 * is junk. `spanMs` bounds an offset (a beat after the recording ended is junk).
 */
export function cleanPoint(type: string, raw: unknown, spanMs: number): SeriesPoint | undefined {
  if (!Array.isArray(raw)) return undefined
  if (type === 's.Audiogram') {
    if (raw.length !== 3) return undefined
    const [freq, left, right] = raw
    if (!finite(freq) || freq < 1 || freq > 40_000) return undefined
    const l = optional(left, -20, 150)
    const r = optional(right, -20, 150)
    if (l === undefined || r === undefined || (l === null && r === null)) return undefined
    return [freq, l, r]
  }
  const offset = raw[0]
  // One second of slack: HealthKit rounds a series' end to the second.
  if (!finite(offset) || offset < 0 || offset > spanMs + 1000) return undefined
  if (type === 's.HeartbeatSeries') {
    if (raw.length !== 2 || (raw[1] !== 0 && raw[1] !== 1)) return undefined
    return [Math.round(offset), raw[1]]
  }
  if (type === 's.WorkoutRoute') {
    if (raw.length !== 6) return undefined
    const [, lat, lon, alt, acc, speed] = raw
    if (!finite(lat) || lat < -90 || lat > 90 || !finite(lon) || lon < -180 || lon > 180) return undefined
    const a = reading(alt, -1000, 20_000)
    const h = reading(acc, 0, 10_000)
    const s = reading(speed, 0, 300)
    if (a === undefined || h === undefined || s === undefined) return undefined
    return [Math.round(offset), lat, lon, a, h, s]
  }
  return undefined
}

// ── summaries (computed once, when the last chunk lands) ──

const EARTH_RADIUS_M = 6_371_000

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

const round1 = (v: number): number => Math.round(v * 10) / 10

/** Pure-tone average over 500, 1000, 2000 and 4000 Hz, when all four were measured on that ear. */
function pureToneAverage(points: SeriesPoint[], ear: 1 | 2): number | null {
  const at = new Map(points.filter((p) => p[ear] !== null).map((p) => [p[0] as number, p[ear] as number]))
  const values = [500, 1000, 2000, 4000].map((f) => at.get(f))
  return values.every((v) => v !== undefined) ? round1((values as number[]).reduce((a, b) => a + b, 0) / 4) : null
}

/**
 * The few numbers an agent reads first. A route's summary is distance and climb,
 * never a place: coordinates stay in the points.
 */
export function seriesSummary(type: string, points: SeriesPoint[]): Record<string, unknown> {
  if (type === 's.Audiogram') {
    return {
      points: points.length,
      frequenciesHz: points.map((p) => p[0]),
      leftPureToneAverageDbHL: pureToneAverage(points, 1),
      rightPureToneAverageDbHL: pureToneAverage(points, 2),
    }
  }
  if (type === 's.HeartbeatSeries') {
    // Beat-to-beat intervals, never across a gap (a gap means beats were missed).
    const intervals: number[] = []
    for (let i = 1; i < points.length; i++) {
      if (points[i][1] === 1) continue
      const d = (points[i][0] as number) - (points[i - 1][0] as number)
      if (d > 0) intervals.push(d)
    }
    const gaps = points.filter((p, i) => i > 0 && p[1] === 1).length
    const meanMs = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null
    let rmssd: number | null = null
    if (intervals.length >= 2) {
      let sum = 0
      for (let i = 1; i < intervals.length; i++) sum += (intervals[i] - intervals[i - 1]) ** 2
      rmssd = round1(Math.sqrt(sum / (intervals.length - 1)))
    }
    return {
      beats: points.length, gaps,
      meanHeartRate: meanMs ? round1(60_000 / meanMs) : null,
      meanIntervalMs: meanMs === null ? null : round1(meanMs),
      rmssdMs: rmssd,
    }
  }
  if (type === 's.WorkoutRoute') {
    let distance = 0
    let ascent = 0
    for (let i = 1; i < points.length; i++) {
      const [, la1, lo1, a1] = points[i - 1]
      const [, la2, lo2, a2] = points[i]
      distance += haversineM(la1 as number, lo1 as number, la2 as number, lo2 as number)
      if (a1 !== null && a2 !== null && (a2 as number) > (a1 as number)) ascent += (a2 as number) - (a1 as number)
    }
    // A loop, not Math.max(...): a spread of 100k+ arguments overflows the stack.
    let maxSpeed: number | null = null
    for (const p of points) if (p[5] !== null && (maxSpeed === null || (p[5] as number) > maxSpeed)) maxSpeed = p[5] as number
    return {
      points: points.length,
      distanceM: Math.round(distance),
      ascentM: Math.round(ascent),
      maxSpeedMps: maxSpeed === null ? null : round1(maxSpeed),
      durationMin: points.length ? round1(((points[points.length - 1][0] as number) - (points[0][0] as number)) / 60_000) : 0,
    }
  }
  return { points: points.length }
}
