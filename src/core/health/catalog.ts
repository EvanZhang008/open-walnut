/**
 * Apple Health catalog: every type the phone may upload, its ONE canonical unit,
 * and the per-call caps. The phone converts to these units before it sends; the
 * server never converts a stored value (ops convert only for display, see units.ts).
 *
 * Two upload kinds:
 *   raw      individual HealthKit samples, keyed by their HealthKit UUID
 *   buckets  HealthKit statistics buckets (5m / 1h / 1d), keyed by (metric, start, interval)
 *
 * Buckets are Apple's own merged numbers (a statistics query already applies the
 * Health app's source priority), so the server stores them as they arrive.
 */

/** At most this many items (samples + deleted + buckets) per sync call. Pinned by the iOS client test. */
export const HEALTH_MAX_ITEMS_PER_SYNC = 500
/** At most this many serialized bytes per sync call, so a relayed batch stays under the 256 KB bridge frame. */
export const HEALTH_MAX_SYNC_BYTES = 192 * 1024

/**
 * HKCategoryValueSleepAnalysis raw values (HealthKit, iOS 16+). `asleep` (deprecated)
 * shares the value 1 with asleepUnspecified.
 */
export const SLEEP_CODES = {
  inBed: 0,
  asleepUnspecified: 1,
  awake: 2,
  asleepCore: 3,
  asleepDeep: 4,
  asleepREM: 5,
} as const
export const ASLEEP_CODES: ReadonlySet<number> = new Set([1, 3, 4, 5])
export const STAGE_CODES: ReadonlySet<number> = new Set([3, 4, 5])

export const HEALTH_CATEGORIES = ['sleep', 'heart', 'activity', 'vitals', 'workouts', 'mind', 'audio'] as const
export type HealthCategory = (typeof HEALTH_CATEGORIES)[number]

export interface MetricSpec {
  /** Canonical unit, HealthKit's own unit string where one exists. */
  unit: string
  category: HealthCategory
  /** Accepted as raw samples. */
  raw: boolean
  /** Accepted as statistics buckets. */
  buckets: boolean
  /** How a day folds this metric. */
  agg: 'sum' | 'avg' | 'latest' | 'none'
  /** Plausible range in the canonical unit. A value outside is rejected as junk. */
  min?: number
  max?: number
  /** Last sample older than this reads as `stale` in health_status. */
  staleAfterDays: number
  /** Changes a night's summary (sleep itself, or a vital measured during sleep). */
  night?: boolean
}

export const HEALTH_METRICS: Readonly<Record<string, MetricSpec>> = {
  sleep: { unit: 'code', category: 'sleep', raw: true, buckets: false, agg: 'none', staleAfterDays: 2, night: true },
  heart_rate: { unit: 'count/min', category: 'heart', raw: true, buckets: true, agg: 'avg', min: 20, max: 250, staleAfterDays: 2, night: true },
  resting_hr: { unit: 'count/min', category: 'heart', raw: true, buckets: false, agg: 'avg', min: 20, max: 200, staleAfterDays: 3 },
  walking_hr: { unit: 'count/min', category: 'heart', raw: true, buckets: false, agg: 'avg', min: 30, max: 220, staleAfterDays: 3 },
  hrv_sdnn: { unit: 'ms', category: 'heart', raw: true, buckets: false, agg: 'avg', min: 1, max: 500, staleAfterDays: 3, night: true },
  respiratory_rate: { unit: 'count/min', category: 'vitals', raw: true, buckets: true, agg: 'avg', min: 3, max: 60, staleAfterDays: 3, night: true },
  spo2: { unit: '%', category: 'vitals', raw: true, buckets: false, agg: 'avg', min: 50, max: 100, staleAfterDays: 3, night: true },
  wrist_temp: { unit: 'degC', category: 'vitals', raw: true, buckets: false, agg: 'avg', min: 20, max: 45, staleAfterDays: 3, night: true },
  vo2max: { unit: 'mL/(kg·min)', category: 'vitals', raw: true, buckets: false, agg: 'latest', min: 5, max: 100, staleAfterDays: 30 },
  steps: { unit: 'count', category: 'activity', raw: false, buckets: true, agg: 'sum', min: 0, max: 200_000, staleAfterDays: 2 },
  distance: { unit: 'm', category: 'activity', raw: false, buckets: true, agg: 'sum', min: 0, max: 500_000, staleAfterDays: 2 },
  active_energy: { unit: 'kcal', category: 'activity', raw: false, buckets: true, agg: 'sum', min: 0, max: 20_000, staleAfterDays: 2 },
  basal_energy: { unit: 'kcal', category: 'activity', raw: false, buckets: true, agg: 'sum', min: 0, max: 20_000, staleAfterDays: 2 },
  exercise_min: { unit: 'min', category: 'activity', raw: false, buckets: true, agg: 'sum', min: 0, max: 1440, staleAfterDays: 2 },
  stand_min: { unit: 'min', category: 'activity', raw: false, buckets: true, agg: 'sum', min: 0, max: 1440, staleAfterDays: 2 },
  daylight_min: { unit: 'min', category: 'activity', raw: false, buckets: true, agg: 'sum', min: 0, max: 1440, staleAfterDays: 3 },
  workout: { unit: 'min', category: 'workouts', raw: true, buckets: false, agg: 'sum', min: 0, max: 2880, staleAfterDays: 14 },
  mindful: { unit: 'min', category: 'mind', raw: true, buckets: false, agg: 'sum', min: 0, max: 1440, staleAfterDays: 14 },
  state_of_mind: { unit: 'valence', category: 'mind', raw: true, buckets: false, agg: 'none', min: -1, max: 1, staleAfterDays: 14 },
  audio_env: { unit: 'dBASPL', category: 'audio', raw: false, buckets: true, agg: 'avg', min: 0, max: 150, staleAfterDays: 3 },
  audio_headphone: { unit: 'dBASPL', category: 'audio', raw: false, buckets: true, agg: 'avg', min: 0, max: 150, staleAfterDays: 7 },
}

/** Bucket widths the store accepts (5 minutes, 1 hour, 1 day). */
export const BUCKET_INTERVALS: ReadonlySet<number> = new Set([300, 3600, 86_400])

/** Raw types that are one continuous span per sample; a missing value is the span length in minutes. */
export const SPAN_VALUE_TYPES: ReadonlySet<string> = new Set(['workout', 'mindful'])

export function metricSpec(name: unknown): MetricSpec | undefined {
  return typeof name === 'string' && Object.hasOwn(HEALTH_METRICS, name) ? HEALTH_METRICS[name] : undefined
}

export function isHealthCategory(value: unknown): value is HealthCategory {
  return typeof value === 'string' && (HEALTH_CATEGORIES as readonly string[]).includes(value)
}

/** Every type and metric, by upload kind, for GET /health/status (a phone gates on it before sending). */
export function supportedTypes(): { raw: string[]; buckets: string[] } {
  const entries = Object.entries(HEALTH_METRICS)
  return {
    raw: entries.filter(([, s]) => s.raw).map(([n]) => n),
    buckets: entries.filter(([, s]) => s.buckets).map(([n]) => n),
  }
}

/** Canonical unit per metric, the `units` block every read answers with. */
export function canonicalUnits(): Record<string, string> {
  return Object.fromEntries(Object.entries(HEALTH_METRICS).map(([n, s]) => [n, s.unit]))
}

/** Names that belong to a set of categories (for DELETE / settings). */
export function metricsInCategories(categories: readonly HealthCategory[]): string[] {
  const set = new Set(categories)
  return Object.entries(HEALTH_METRICS).filter(([, s]) => set.has(s.category)).map(([n]) => n)
}
