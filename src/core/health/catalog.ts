/**
 * Apple Health catalog: every named type the phone may sync, its ONE canonical
 * unit, and the per-call caps. The phone converts to these units before it sends;
 * the server never converts a stored value (ops convert only for display, see units.ts).
 *
 * Two sync kinds:
 *   raw      individual HealthKit samples, keyed by their HealthKit UUID
 *   buckets  HealthKit statistics buckets (5m / 1h / 1d), keyed by (metric, start, interval)
 *
 * Buckets are Apple's own merged numbers (a statistics query already applies the
 * Health app's source priority), so the server stores them as they arrive.
 *
 * Beside the catalog, every other HealthKit type arrives under a GENERIC name
 * (`q.<Suffix>`, `c.<Suffix>`, `x.<Name>`, see isGenericType). The server does not
 * interpret those: it stores what the phone sends, pins the first unit it stores
 * per type, and serves them to the agent as they are.
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

/** `other` holds every generic type. */
export const HEALTH_CATEGORIES = ['sleep', 'heart', 'activity', 'vitals', 'workouts', 'mind', 'audio', 'other'] as const
export type HealthCategory = (typeof HEALTH_CATEGORIES)[number]
/**
 * The categories a saved list written before `other` existed knew about: a category
 * missing from a saved list counts as switched off only if that list knew it.
 */
export const LEGACY_HEALTH_CATEGORIES: readonly HealthCategory[] = ['sleep', 'heart', 'activity', 'vitals', 'workouts', 'mind', 'audio']

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

// ── generic types ──

/** Most rows one health_samples read returns. */
export const HEALTH_MAX_SAMPLE_ROWS = 500
/** Longest type name a sync call may carry (catalog names are far shorter). */
export const HEALTH_MAX_TYPE_LENGTH = 64
/**
 * `q.<Suffix>` = HKQuantityTypeIdentifier<Suffix>, `c.<Suffix>` = HKCategoryTypeIdentifier<Suffix>,
 * `x.<Name>` = any other kind (Electrocardiogram, GAD7, PHQ9, the characteristics).
 */
export const GENERIC_TYPE_RE = /^[qcx]\.[A-Z][A-Za-z0-9]{1,62}$/
export const GENERIC_PREFIXES = ['q', 'c', 'x'] as const
/** Only quantity types have statistics buckets. */
export const GENERIC_BUCKET_PREFIXES = ['q'] as const
/** A batch-level unit string (HealthKit unit syntax, e.g. `kg`, `mg/dL`, `mL/(kg·min)`, `count/min`). */
export const GENERIC_UNIT_RE = /^[A-Za-z0-9%/()*·._ ^-]{1,32}$/
/** Bounds for any generic value and code (no per-type ranges: the server does not interpret them). */
export const GENERIC_MAX_ABS_VALUE = 1e9
export const GENERIC_MAX_CODE = 99_999_999

/**
 * Generic names the catalog already stores under its own name. A call for one
 * answers `unsupported`, so nothing is stored twice; reads accept them as an alias.
 */
export const GENERIC_COVERED: Readonly<Record<string, string>> = {
  'q.HeartRate': 'heart_rate',
  'q.RestingHeartRate': 'resting_hr',
  'q.WalkingHeartRateAverage': 'walking_hr',
  'q.HeartRateVariabilitySDNN': 'hrv_sdnn',
  'q.RespiratoryRate': 'respiratory_rate',
  'q.OxygenSaturation': 'spo2',
  'q.AppleSleepingWristTemperature': 'wrist_temp',
  'q.VO2Max': 'vo2max',
  'q.StepCount': 'steps',
  'q.DistanceWalkingRunning': 'distance',
  'q.ActiveEnergyBurned': 'active_energy',
  'q.BasalEnergyBurned': 'basal_energy',
  'q.AppleExerciseTime': 'exercise_min',
  'q.AppleStandTime': 'stand_min',
  'q.TimeInDaylight': 'daylight_min',
  'q.EnvironmentalAudioExposure': 'audio_env',
  'q.HeadphoneAudioExposure': 'audio_headphone',
  'c.SleepAnalysis': 'sleep',
  'c.MindfulSession': 'mindful',
}

/**
 * Characteristics: one current value each, not a series. Their sample times are
 * only when the phone read them, and a re-sent uuid replaces the stored row.
 */
export const GENERIC_CHARACTERISTICS: ReadonlySet<string> = new Set([
  'x.BiologicalSex', 'x.BloodType', 'x.DateOfBirth', 'x.FitzpatrickSkinType', 'x.WheelchairUse', 'x.ActivityMoveMode',
])

/** A well-formed generic name (covered or not). */
export function isGenericName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= HEALTH_MAX_TYPE_LENGTH && GENERIC_TYPE_RE.test(name)
}

/** A generic name the store accepts: well formed and not covered by the catalog. */
export function isGenericType(name: unknown): name is string {
  return isGenericName(name) && !Object.hasOwn(GENERIC_COVERED, name)
}

export function isQuantityType(name: string): boolean {
  return name.startsWith('q.') && isGenericType(name)
}

export function isCharacteristic(name: string): boolean {
  return GENERIC_CHARACTERISTICS.has(name)
}

/** Meta keys for the unit and agg pinned at a generic type's first stored sync. */
export const unitPinKey = (type: string): string => `unit:${type}`
export const aggPinKey = (type: string): string => `agg:${type}`

/** SQL that matches generic type names in `column` as index ranges (catalog names hold no dot). */
export function genericTypeSql(column: string): string {
  return GENERIC_PREFIXES.map((p) => `(${column} >= '${p}.' AND ${column} < '${p}/')`).join(' OR ')
}

/** The category a stored type belongs to (`other` for every generic type). */
export function typeCategory(name: string): HealthCategory | undefined {
  return metricSpec(name)?.category ?? (isGenericType(name) ? 'other' : undefined)
}

/** Every type and metric, by sync kind, for GET /health/status (a phone gates on it before sending). */
export function supportedTypes() {
  const entries = Object.entries(HEALTH_METRICS)
  return {
    raw: entries.filter(([, s]) => s.raw).map(([n]) => n),
    buckets: entries.filter(([, s]) => s.buckets).map(([n]) => n),
    generic: {
      prefixes: [...GENERIC_PREFIXES],
      maxTypeLength: HEALTH_MAX_TYPE_LENGTH,
      bucketPrefixes: [...GENERIC_BUCKET_PREFIXES],
      covered: Object.keys(GENERIC_COVERED),
    },
  }
}

/** Canonical unit per metric, the `units` block every read answers with. */
export function canonicalUnits(): Record<string, string> {
  return Object.fromEntries(Object.entries(HEALTH_METRICS).map(([n, s]) => [n, s.unit]))
}

/** Catalog names that belong to a set of categories (for DELETE / settings). Generic types are not listed: match them with genericTypeSql. */
export function metricsInCategories(categories: readonly HealthCategory[]): string[] {
  const set = new Set(categories)
  return Object.entries(HEALTH_METRICS).filter(([, s]) => set.has(s.category)).map(([n]) => n)
}

/** Catalog raw types other than sleep: the rows a day summary folds. */
export const DAY_RAW_TYPES: readonly string[] = Object.entries(HEALTH_METRICS).filter(([n, s]) => s.raw && n !== 'sleep').map(([n]) => n)
/** Catalog bucket metrics: the buckets a day summary folds. */
export const DAY_BUCKET_METRICS: readonly string[] = Object.entries(HEALTH_METRICS).filter(([, s]) => s.buckets).map(([n]) => n)
