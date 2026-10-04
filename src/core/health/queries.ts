/**
 * Agent-facing health reads (the /api/health/* routes behind the health_* ops).
 *
 * Every read answers in canonical units with a `units` block; a display string in
 * the phone's preferred unit rides beside a converted field, never instead of it.
 * Date arguments are LOCAL dates in the phone's last-known timezone.
 */

import { HEALTH_METRICS, aggPinKey, canonicalUnits, metricSpec, supportedTypes, unitPinKey } from './catalog.js'
import { getHealthDb, getMeta, getMetaJson } from './db.js'
import { addDays, dateRange, isDateKey, localDate } from './day-key.js'
import { HealthQueryError, MAX_RANGE_DAYS, healthTz } from './query-common.js'
import { enabledCategories } from './ingest.js'
import { readDays, readNights, savedSourceOrder } from './materialize.js'
import { bucketSpan, sampleSpan, storedGenericNames, type Span } from './type-spans.js'
import { rankSources, MANUAL_SOURCE, type SourceInfo } from './source-order.js'
import type { PreferredUnits } from './sanitize.js'
import { IN_BED_ONLY_CAVEAT, UNRECORDED_GAP_CAVEAT, type NightSummary } from './sleep-merge.js'
import type { DaySummary } from './day-summary.js'
import { displayDistance, displayEnergy, displayTemperature } from './units.js'

const DAY_MS = 86_400_000
/** No sample for this long reads as `unknown_or_denied`: apps cannot see a read denial. */
const UNKNOWN_AFTER_DAYS = 14

function preferredUnits(): PreferredUnits {
  return getMetaJson<PreferredUnits>('preferredUnits') ?? {}
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
}

// ── status ──

export function healthStatus(now = Date.now()) {
  const db = getHealthDb()
  const tz = healthTz()
  const lastUploadAt = Number(getMeta('lastUploadAt') ?? 0) || null
  const enabled = enabledCategories()
  let coverageLo = Infinity
  let coverageHi = -Infinity
  const types = Object.entries(HEALTH_METRICS).map(([name, spec]) => {
    const spans = [
      spec.raw ? sampleSpan(db, name) : null,
      spec.buckets ? bucketSpan(db, name, now) : null,
    ].filter((s): s is Span => !!s)
    const hi = Math.max(...spans.map((s) => s.hi ?? -Infinity))
    const lo = Math.min(...spans.map((s) => s.lo ?? Infinity))
    if (Number.isFinite(lo)) coverageLo = Math.min(coverageLo, lo)
    if (Number.isFinite(hi)) coverageHi = Math.max(coverageHi, hi)
    const last = Number.isFinite(hi) ? hi : null
    const age = last === null ? Infinity : now - last
    const state = age > UNKNOWN_AFTER_DAYS * DAY_MS ? 'unknown_or_denied' : age > spec.staleAfterDays * DAY_MS ? 'stale' : 'ok'
    return { type: name, category: spec.category, enabled: enabled.has(spec.category), lastSampleAt: iso(last), state }
  })
  const generic = genericTypes(enabled.has('other'), now)
  if (generic.lo !== null) coverageLo = Math.min(coverageLo, generic.lo)
  if (generic.hi !== null) coverageHi = Math.max(coverageHi, generic.hi)
  const rows = db.prepare('SELECT bundle, name, first_sample_ms, first_seen_ms, last_seen_ms, apple FROM sources').all() as Array<{
    bundle: string; name: string; first_sample_ms: number; first_seen_ms: number; last_seen_ms: number; apple: number
  }>
  const infos = new Map<string, SourceInfo>(rows.map((r) => [r.bundle, {
    bundle: r.bundle, firstSeenMs: r.first_seen_ms, firstSampleMs: r.first_sample_ms, apple: r.apple === 1,
  }]))
  // samples_manual (a partial index) answers this without reading the table.
  const hasManual = !!db.prepare('SELECT 1 FROM samples WHERE user_entered = 1 LIMIT 1').get()
  const keys = [...(hasManual ? [MANUAL_SOURCE] : []), ...rows.map((r) => r.bundle)]
  const ranks = rankSources(keys, infos, savedSourceOrder())
  const sources = [
    ...(hasManual ? [{ bundleId: MANUAL_SOURCE, name: 'Entered manually', tier: 'manual', firstSeenAt: null, firstSampleAt: null, lastSeenAt: null }] : []),
    ...rows.map((r) => ({
      bundleId: r.bundle, name: r.name, tier: r.apple === 1 ? 'apple_device' : 'app_or_device',
      firstSeenAt: iso(r.first_seen_ms), firstSampleAt: iso(r.first_sample_ms), lastSeenAt: iso(r.last_seen_ms),
    })),
  ].sort((a, b) => (ranks.get(a.bundleId) ?? 0) - (ranks.get(b.bundleId) ?? 0))
  const devices = getMetaJson<Record<string, { model: string | null; os: string | null; lastSeenAt: number }>>('devices') ?? {}
  return {
    connected: lastUploadAt !== null && now - lastUploadAt <= 3 * DAY_MS,
    paused: getMeta('paused') === '1',
    storeId: getMeta('storeId') as string,
    /** The last sync (the name is a frozen contract). */
    lastUploadAt: iso(lastUploadAt),
    coverage: {
      from: Number.isFinite(coverageLo) ? localDate(coverageLo, tz) : null,
      to: Number.isFinite(coverageHi) ? localDate(coverageHi - 1, tz) : null,
    },
    types: [...types, ...generic.types],
    sources,
    sleepSourceOrder: savedSourceOrder(),
    categories: [...enabled].sort(),
    units: { ...canonicalUnits(), ...generic.units },
    preferredUnits: preferredUnits(),
    tz,
    devices: Object.values(devices).map((d) => ({ model: d.model, os: d.os, lastSeenAt: iso(d.lastSeenAt) })),
    supported: supportedTypes(),
  }
}

/**
 * Every stored generic type with its first and last instants (index seeks only,
 * type-spans.ts) and its pinned unit. A generic type is listed only when it has
 * rows, so it always reads `ok`: there is no freshness rule for a type the server
 * does not interpret.
 */
function genericTypes(enabled: boolean, now: number) {
  const db = getHealthDb()
  const raw = new Set(storedGenericNames(db, 'samples'))
  const buckets = new Set(storedGenericNames(db, 'buckets'))
  const pins = db.prepare("SELECT key, value FROM meta WHERE key GLOB 'unit:*' OR key GLOB 'agg:*'").all() as Array<{ key: string; value: string }>
  const pin = new Map(pins.map((p) => [p.key, p.value]))
  const units: Record<string, string> = {}
  let lo = Infinity
  let hi = -Infinity
  const types = [...new Set([...raw, ...buckets])].sort().map((type) => {
    const spans = [raw.has(type) ? sampleSpan(db, type) : null, buckets.has(type) ? bucketSpan(db, type, now) : null]
      .filter((s): s is Span => !!s)
    const first = Math.min(...spans.map((s) => s.lo ?? Infinity))
    const last = Math.max(...spans.map((s) => s.hi ?? -Infinity))
    lo = Math.min(lo, first)
    hi = Math.max(hi, last)
    const unit = pin.get(unitPinKey(type)) ?? null
    if (unit) units[type] = unit
    const agg = pin.get(aggPinKey(type))
    return {
      type, category: 'other' as const, enabled, lastSampleAt: iso(Number.isFinite(last) ? last : null), state: 'ok' as const,
      firstSampleAt: iso(Number.isFinite(first) ? first : null), unit,
      kind: raw.has(type) && buckets.has(type) ? 'both' as const : raw.has(type) ? 'raw' as const : 'buckets' as const,
      ...(agg ? { agg } : {}),
    }
  })
  return { types, units, lo: Number.isFinite(lo) ? lo : null, hi: Number.isFinite(hi) ? hi : null }
}

// ── date windows ──

export interface WindowArgs { last?: number; from?: string; to?: string; defaultLast: number }

/** Resolve last-N or from/to into an ascending list of local dates. */
export function resolveDates(args: WindowArgs, now = Date.now()): string[] {
  const today = localDate(now, healthTz())
  if (args.from !== undefined || args.to !== undefined) {
    const from = args.from ?? args.to
    const to = args.to ?? today
    if (!isDateKey(from) || !isDateKey(to)) throw new HealthQueryError('from/to must be YYYY-MM-DD dates')
    if (from > to) throw new HealthQueryError('from must not be after to')
    const dates = dateRange(from, to, MAX_RANGE_DAYS + 1)
    if (dates.length > MAX_RANGE_DAYS) throw new HealthQueryError(`a range covers at most ${MAX_RANGE_DAYS} days`)
    return dates
  }
  const n = args.last ?? args.defaultLast
  if (!Number.isInteger(n) || n < 1 || n > MAX_RANGE_DAYS) throw new HealthQueryError(`last must be an integer from 1 to ${MAX_RANGE_DAYS}`)
  return dateRange(addDays(today, -(n - 1)), today)
}

// ── sleep ──

const SLEEP_CAVEATS = [
  'Sleep stages come from consumer wearables; they are estimates, not a sleep study.',
  'HRV here is SDNN (what Apple records), not RMSSD: do not compare it with RMSSD numbers from other devices.',
  'This is not medical advice and must not be presented as a diagnosis.',
  'Main night and naps are Walnut\'s rule: sleep is one run unless 60 min or more between two pieces has no awake or in-bed record from the same source; the longest run ending on the wake date is the night, and recorded awake time inside it counts as awake.',
  'When several sources recorded the same night, the higher-priority source wins each minute: a saved order first, otherwise manual entries, then the newest source (Apple\'s rule that a newly added source goes to the top; Walnut uses the first time it saw the source as the added date). Stages are reported only where a stage-capable source won (stagesCoverage).',
]

/** Circular mean of clock times (minutes after local midnight), so 23:50 and 00:10 average to midnight. */
function meanClock(values: string[]): string | null {
  const mins = values.map((v) => {
    const m = /T(\d{2}):(\d{2})/.exec(v)
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
  }).filter((v): v is number => v !== null)
  if (mins.length === 0) return null
  let x = 0
  let y = 0
  for (const m of mins) {
    const a = (m / 1440) * 2 * Math.PI
    x += Math.cos(a)
    y += Math.sin(a)
  }
  let angle = Math.atan2(y, x)
  if (angle < 0) angle += 2 * Math.PI
  const total = Math.round((angle / (2 * Math.PI)) * 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function mean(values: Array<number | null | undefined>): number | null {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null
}

type SleepRow = Omit<NightSummary, 'status'> & {
  status: NightSummary['status'] | 'missing'
  restingHr: number | null
  wristTempDisplay?: string | null
}

function sleepAverages(nights: SleepRow[]) {
  const ok = nights.filter((n) => n.status === 'ok')
  // In-bed-only nights know bedtime, wake and time in bed, and nothing about sleep.
  const inBedOnly = nights.filter((n) => n.status === 'in_bed_only')
  const timed = [...ok, ...inBedOnly]
  return {
    n: ok.length,
    nInBedOnly: inBedOnly.length,
    asleepMin: mean(ok.map((n) => n.asleepMin)),
    inBedMin: mean(timed.map((n) => n.inBedMin)),
    efficiency: mean(ok.map((n) => n.efficiency === null ? null : n.efficiency * 100)),
    deepMin: mean(ok.map((n) => n.stages?.deepMin)),
    remMin: mean(ok.map((n) => n.stages?.remMin)),
    awakenings: mean(ok.map((n) => n.awakenings)),
    sleepingHr: mean(ok.map((n) => n.sleepingHr)),
    hrvSdnn: mean(ok.map((n) => n.hrvSdnn)),
    restingHr: mean(ok.map((n) => n.restingHr)),
    respiratoryRate: mean(ok.map((n) => n.respiratoryRate)),
    bedtime: meanClock(timed.map((n) => n.bedtime ?? '')),
    wake: meanClock(timed.map((n) => n.wake ?? '')),
  }
}

async function sleepRows(dates: string[], pref: PreferredUnits, detail: 'summary' | 'stages'): Promise<SleepRow[]> {
  const nights = await readNights(dates)
  const days = await readDays(dates)
  return dates.map((date) => {
    const night = nights.get(date)
    const restingHr = days.get(date)?.vitals.restingHr ?? null
    if (!night) return { ...missingNight(date), status: 'missing' as const, restingHr }
    const row: SleepRow = { ...night, restingHr, wristTempDisplay: displayTemperature(night.wristTemp, pref) }
    if (detail === 'summary') row.hypnogram = []
    return row
  })
}

function missingNight(date: string): NightSummary {
  return {
    date, status: 'no_main_night', tz: null, bedtime: null, wake: null, inBedMin: null, asleepMin: 0, awakeMin: 0,
    stages: null, stagesCoverage: 0, efficiency: null, efficiencyBasis: null, awakenings: 0, sleepingHr: null,
    hrvSdnn: null, respiratoryRate: null, spo2: null, wristTemp: null, primarySource: null, otherSources: [],
    naps: [], hypnogram: [], startMs: null, endMs: null,
  }
}

export async function healthSleep(args: { lastNights?: number; from?: string; to?: string; detail?: string }, now = Date.now()) {
  const detail = args.detail === 'stages' ? 'stages' : 'summary'
  const dates = resolveDates({ last: args.lastNights, from: args.from, to: args.to, defaultLast: 7 }, now)
  const pref = preferredUnits()
  const rows = await sleepRows(dates, pref, detail)
  const baselineDates = dateRange(addDays(dates[0], -28), addDays(dates[0], -1))
  const baseline = await sleepRows(baselineDates, pref, 'summary')
  const nights = rows.map(({ startMs: _s, endMs: _e, ...rest }) => rest)
  return {
    tz: healthTz(),
    nights,
    averages: sleepAverages(rows),
    baseline28: { from: baselineDates[0], to: baselineDates[baselineDates.length - 1], ...sleepAverages(baseline) },
    units: {
      asleepMin: 'min', inBedMin: 'min', awakeMin: 'min', sleepingHr: 'count/min', restingHr: 'count/min',
      hrvSdnn: 'ms', respiratoryRate: 'count/min', spo2: '%', wristTemp: 'degC', efficiency: 'ratio 0..1 (averages: %)',
    },
    preferredUnits: pref,
    caveats: [
      ...SLEEP_CAVEATS,
      ...(rows.some((r) => r.status === 'in_bed_only') ? [IN_BED_ONLY_CAVEAT] : []),
      ...(rows.some((r) => r.unrecordedGaps?.length) ? [UNRECORDED_GAP_CAVEAT] : []),
    ],
  }
}

// ── daily ──

const DAILY_SECTIONS = ['activity', 'vitals', 'workouts', 'mind', 'audio'] as const
type DailySection = (typeof DAILY_SECTIONS)[number]

function sectionsFor(metrics: string | undefined): Set<DailySection> {
  if (!metrics) return new Set(DAILY_SECTIONS)
  const out = new Set<DailySection>()
  for (const raw of metrics.split(',').map((m) => m.trim()).filter(Boolean)) {
    if ((DAILY_SECTIONS as readonly string[]).includes(raw)) out.add(raw as DailySection)
    else {
      const spec = metricSpec(raw)
      if (!spec) throw new HealthQueryError(`unknown metric "${raw}": use ${DAILY_SECTIONS.join(', ')} or a catalog name`)
      const section = spec.category === 'heart' ? 'vitals' : spec.category === 'sleep' ? null
        : spec.category === 'workouts' ? 'workouts' : spec.category
      if (section) out.add(section as DailySection)
    }
  }
  return out
}

function shapeDay(day: DaySummary | null, date: string, sections: Set<DailySection>, pref: PreferredUnits) {
  if (!day) return { date, status: 'missing' as const }
  return {
    date,
    status: 'ok' as const,
    ...(sections.has('activity') ? {
      activity: {
        ...day.activity,
        display: { distance: displayDistance(day.activity.distanceM, pref), activeEnergy: displayEnergy(day.activity.activeKcal, pref) },
      },
    } : {}),
    ...(sections.has('vitals') ? { vitals: day.vitals } : {}),
    ...(sections.has('workouts') ? { workouts: day.workouts } : {}),
    ...(sections.has('mind') ? { stateOfMind: day.stateOfMind, mindfulMin: day.mindfulMin } : {}),
    ...(sections.has('audio') ? { audio: day.audio } : {}),
  }
}

export async function healthDaily(args: { lastDays?: number; from?: string; to?: string; metrics?: string }, now = Date.now()) {
  const sections = sectionsFor(args.metrics)
  const dates = resolveDates({ last: args.lastDays, from: args.from, to: args.to, defaultLast: 7 }, now)
  const pref = preferredUnits()
  const days = await readDays(dates)
  return {
    tz: healthTz(),
    days: dates.map((d) => shapeDay(days.get(d) ?? null, d, sections, pref)),
    units: {
      steps: 'count', distanceM: 'm', activeKcal: 'kcal', basalKcal: 'kcal', exerciseMin: 'min', standMin: 'min',
      daylightMin: 'min', restingHr: 'count/min', walkingHr: 'count/min', hrvSdnn: 'ms', respiratoryRate: 'count/min',
      spo2: '%', vo2max: 'mL/(kg·min)', heartRate: 'count/min', durationMin: 'min', energyKcal: 'kcal',
      valence: '-1..1', mindfulMin: 'min', envAvgDb: 'dBASPL', headphoneAvgDb: 'dBASPL',
    },
    preferredUnits: pref,
  }
}

export { HealthQueryError, healthTz } from './query-common.js'
export { seriesQuery as healthSeries } from './series.js'
