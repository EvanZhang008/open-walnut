/**
 * One night from raw sleep samples: pure, no I/O, so every rule is unit tested.
 *
 * Merge (Apple's documented source priority, see source-order.ts): for each class
 * (inBed; the asleep stages plus awake) sweep over time, and at every instant the
 * highest-ranked source covering it wins. Lower sources fill only time no higher
 * source covers. So a Watch that dies at 3am keeps the first half of the night
 * and an app that kept recording fills the rest.
 *
 * Walnut's own rules (labelled as such in the caveats, not Apple's):
 *   - asleep segments form one run unless the time between them that NO awake or
 *     in-bed sample of the same source covers reaches 60 min: a long awake stretch
 *     the Watch recorded is part of the night (counted as awake), a dead battery
 *     is not. The main night is the longest run ending on the wake date, every
 *     other run is a nap;
 *   - a night with In Bed samples only (an iPhone without a Watch records nothing
 *     else) is still a night: `in_bed_only`, with bedtime, wake and in-bed minutes
 *     from the in-bed span, and asleepMin null;
 *   - stages are reported only for the part of the main night a stage-capable
 *     source won (stagesCoverage 0..1), never extrapolated;
 *   - sleep recorded within 3 h of the main night, on the same wake date, with the
 *     split between them, is REPORTED (`unrecordedGaps` plus a caveat), never
 *     joined. A 70 min hole with nothing recorded (a Watch battery, a sensor off
 *     the wrist) otherwise reads as a 03:00 wake plus a long "nap", and nothing in
 *     the samples tells that apart from a real wake: Apple documents no rule for
 *     joining sleep across a recording gap, so Walnut does not invent one.
 */

import { ASLEEP_CODES, STAGE_CODES } from './catalog.js'
import { localDate, localIso } from './day-key.js'

export const RUN_JOIN_GAP_MS = 60 * 60_000
/** A non-asleep stretch inside the main night shorter than this is not an awakening. */
const AWAKENING_MIN_MS = 60_000

export interface SleepSampleIn {
  start: number
  end: number
  code: number
  /** source-order.ts sourceKey(): a bundle id, or `manual`. */
  key: string
  bundle: string
  name: string
  tz: string
}

export interface VitalPoint { start: number; end: number; value: number; weight?: number }

export interface NightVitalsIn {
  heartRate?: VitalPoint[]
  hrvSdnn?: VitalPoint[]
  respiratoryRate?: VitalPoint[]
  spo2?: VitalPoint[]
  wristTemp?: VitalPoint[]
}

export interface Segment { start: number; end: number; code: number; key: string; tz: string }

export type StageLabel = 'asleep' | 'awake' | 'core' | 'deep' | 'rem'
const STAGE_LABELS: Record<number, StageLabel> = { 1: 'asleep', 2: 'awake', 3: 'core', 4: 'deep', 5: 'rem' }

export interface NightSourceRow { key: string; bundleId: string; name: string; asleepMin: number; usedMin: number }

/** Per-night caveat for a night that recorded time in bed and nothing else. */
export const IN_BED_ONLY_CAVEAT = 'Only time in bed was recorded for this night: no asleep time or stages '
  + '(an iPhone without an Apple Watch records In Bed only).'

/** Per-night caveat for a night with sleep recorded just across a gap from it. */
export const UNRECORDED_GAP_CAVEAT = 'Sleep was also recorded close to this night with nothing recorded in between '
  + '(see unrecordedGaps; that sleep is listed under naps). Walnut cannot tell a real wake from a recording gap such as '
  + 'a flat battery, so the wake time (or bedtime) and the length of this night are not known: say the recording has a '
  + 'gap, and do not state them as fact.'

/** The split between the main night and sleep recorded near it on the same wake date. */
export interface UnrecordedGap {
  /** Which side of the main night the other sleep lies on. */
  side: 'before' | 'after'
  start: string
  end: string
  min: number
  /** The part of the split that no sample of any source covers. */
  unrecordedMin: number
  /** Asleep minutes of the sleep on the other side (listed under naps). */
  otherSleepMin: number
}

/** Sleep this close to the main night, split from it, is reported as a possible recording gap. */
const NEAR_SPLIT_MS = 3 * 60 * 60_000

export interface NightSummary {
  date: string
  /** `in_bed_only`: In Bed samples only, so asleepMin, awakeMin and awakenings are null. */
  status: 'ok' | 'no_main_night' | 'in_bed_only'
  tz: string | null
  bedtime: string | null
  wake: string | null
  inBedMin: number | null
  asleepMin: number | null
  awakeMin: number | null
  stages: { deepMin: number; coreMin: number; remMin: number; unspecifiedMin: number } | null
  stagesCoverage: number
  efficiency: number | null
  efficiencyBasis: 'inBed' | 'span' | null
  awakenings: number | null
  sleepingHr: number | null
  hrvSdnn: number | null
  respiratoryRate: number | null
  spo2: number | null
  wristTemp: number | null
  primarySource: { bundleId: string; name: string } | null
  otherSources: NightSourceRow[]
  naps: Array<{ start: string; end: string; asleepMin: number }>
  /** The merged stage timeline of the main night (dropped from `detail: summary` reads). */
  hypnogram: Array<{ start: string; end: string; stage: StageLabel }>
  /** Epoch ms of the main night's first sleep and final wake (for vitals and sleep-ready). */
  startMs: number | null
  endMs: number | null
  /** Set when the night needs one: IN_BED_ONLY_CAVEAT or UNRECORDED_GAP_CAVEAT. */
  caveat?: string
  /** Present when sleep was recorded just across a split from the main night (see the header). */
  unrecordedGaps?: UnrecordedGap[]
}

const minutes = (ms: number): number => Math.round(ms / 60_000)
const round1 = (v: number): number => Math.round(v * 10) / 10

function specificity(code: number): number {
  if (STAGE_CODES.has(code)) return 3
  if (code === 2) return 2
  return code === 1 ? 1 : 0
}

/** Highest-priority coverage over time. Adjacent pieces with the same code and source merge. */
export function sweepSegments(samples: readonly SleepSampleIn[], rank: (key: string) => number): Segment[] {
  const items = samples.filter((s) => s.end > s.start).map((s, order) => ({ ...s, order }))
  if (items.length === 0) return []
  const xs = [...new Set(items.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b)
  const sorted = [...items].sort((a, b) => a.start - b.start)
  const active: typeof items = []
  const out: Segment[] = []
  let next = 0
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i]
    const b = xs[i + 1]
    while (next < sorted.length && sorted[next].start <= a) active.push(sorted[next++])
    for (let k = active.length - 1; k >= 0; k--) if (active[k].end <= a) active.splice(k, 1)
    if (active.length === 0) continue
    let best = active[0]
    for (const c of active) {
      const dr = rank(c.key) - rank(best.key)
      if (dr < 0 || (dr === 0 && (specificity(c.code) > specificity(best.code)
        || (specificity(c.code) === specificity(best.code) && c.order < best.order)))) best = c
    }
    const last = out[out.length - 1]
    if (last && last.end === a && last.code === best.code && last.key === best.key && last.tz === best.tz) last.end = b
    else out.push({ start: a, end: b, code: best.code, key: best.key, tz: best.tz })
  }
  return out
}

interface Run { start: number; end: number; asleepMs: number; segments: Segment[] }

/** Awake (2) or in-bed (0) samples: they say the person was still in the night. */
type Cover = ReadonlyArray<{ start: number; end: number; key: string }>

/**
 * Join asleep segments into runs. The gap between two segments counts against
 * RUN_JOIN_GAP_MS only for the part that no awake or in-bed sample of either
 * bounding segment's source covers: a 70 min awake bout the Watch recorded stays
 * inside the night, an unrecorded 70 min hole splits it.
 */
function buildRuns(asleep: Segment[], cover: Cover): Run[] {
  const runs: Run[] = []
  for (const seg of asleep) {
    const cur = runs[runs.length - 1]
    let join = false
    if (cur) {
      const gap = seg.start - cur.end
      if (gap < RUN_JOIN_GAP_MS) join = true
      else {
        const prev = cur.segments[cur.segments.length - 1]
        const same = cover.filter((c) => c.key === prev.key || c.key === seg.key)
        join = gap - unionMs(same, cur.end, seg.start) < RUN_JOIN_GAP_MS
      }
    }
    if (cur && join) {
      cur.end = Math.max(cur.end, seg.end)
      cur.asleepMs += seg.end - seg.start
      cur.segments.push(seg)
    } else {
      runs.push({ start: seg.start, end: seg.end, asleepMs: seg.end - seg.start, segments: [seg] })
    }
  }
  return runs
}

function unionMs(intervals: Array<{ start: number; end: number }>, clipStart = -Infinity, clipEnd = Infinity): number {
  const sorted = intervals
    .map((i) => ({ start: Math.max(i.start, clipStart), end: Math.min(i.end, clipEnd) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)
  let total = 0
  let curStart = -Infinity
  let curEnd = -Infinity
  for (const i of sorted) {
    if (i.start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart
      curStart = i.start
      curEnd = i.end
    } else curEnd = Math.max(curEnd, i.end)
  }
  if (curEnd > curStart) total += curEnd - curStart
  return total
}

/**
 * The splits between `main` and the runs right before and after it that end on
 * the same wake date within NEAR_SPLIT_MS. Runs come out of buildRuns in time order.
 */
function nearSplits(runs: Run[], main: Run, date: string, samples: readonly SleepSampleIn[]): UnrecordedGap[] {
  const i = runs.indexOf(main)
  const out: UnrecordedGap[] = []
  const endsOnDate = (r: Run): boolean => localDate(r.end - 1, r.segments[r.segments.length - 1].tz) === date
  const add = (side: UnrecordedGap['side'], other: Run | undefined, from: number, to: number, fromTz: string, toTz: string): void => {
    if (!other || !endsOnDate(other) || to - from >= NEAR_SPLIT_MS || to <= from) return
    out.push({
      side,
      start: localIso(from, fromTz),
      end: localIso(to, toTz),
      min: minutes(to - from),
      unrecordedMin: minutes(to - from - unionMs([...samples], from, to)),
      otherSleepMin: minutes(other.asleepMs),
    })
  }
  const before = runs[i - 1]
  const after = runs[i + 1]
  if (before) add('before', before, before.end, main.start, before.segments[before.segments.length - 1].tz, main.segments[0].tz)
  if (after) add('after', after, main.end, after.start, main.segments[main.segments.length - 1].tz, after.segments[0].tz)
  return out
}

/** Weighted mean of the points whose midpoint falls inside [from, to]. */
function meanWithin(points: VitalPoint[] | undefined, from: number, to: number): number | null {
  if (!points?.length) return null
  let sum = 0
  let weight = 0
  for (const p of points) {
    const mid = (p.start + p.end) / 2
    if (mid < from || mid > to) continue
    const w = p.weight && p.weight > 0 ? p.weight : 1
    sum += p.value * w
    weight += w
  }
  return weight > 0 ? round1(sum / weight) : null
}

function emptyNight(date: string, status: NightSummary['status']): NightSummary {
  return {
    date, status, tz: null, bedtime: null, wake: null, inBedMin: null, asleepMin: 0, awakeMin: 0,
    stages: null, stagesCoverage: 0, efficiency: null, efficiencyBasis: null, awakenings: 0,
    sleepingHr: null, hrvSdnn: null, respiratoryRate: null, spo2: null, wristTemp: null,
    primarySource: null, otherSources: [], naps: [], hypnogram: [], startMs: null, endMs: null,
  }
}

/**
 * The night of a person whose sources recorded In Bed only: the longest in-bed run
 * ending on the wake date gives bedtime, wake and in-bed minutes. Asleep time is
 * unknown (null), never guessed from time in bed.
 */
function inBedOnlyNight(
  date: string,
  samples: readonly SleepSampleIn[],
  inBedSegs: Segment[],
  naps: NightSummary['naps'],
): NightSummary | null {
  const runs = buildRuns(inBedSegs, [])
  const main = runs
    .filter((r) => localDate(r.end - 1, r.segments[r.segments.length - 1].tz) === date)
    .reduce<Run | null>((best, r) => (!best || r.asleepMs > best.asleepMs ? r : best), null)
  if (!main) return null
  const used = new Map<string, number>()
  for (const seg of main.segments) used.set(seg.key, (used.get(seg.key) ?? 0) + seg.end - seg.start)
  const byKey = new Map<string, SleepSampleIn>()
  for (const s of samples) if (!byKey.has(s.key)) byKey.set(s.key, s)
  const rows: NightSourceRow[] = [...byKey.values()].map((s) => ({
    key: s.key, bundleId: s.bundle, name: s.name, asleepMin: 0, usedMin: minutes(used.get(s.key) ?? 0),
  })).sort((a, b) => b.usedMin - a.usedMin)
  const primary = rows.find((r) => r.usedMin > 0) ?? null
  const lastTz = main.segments[main.segments.length - 1].tz
  return {
    ...emptyNight(date, 'in_bed_only'),
    tz: lastTz,
    bedtime: localIso(main.start, main.segments[0].tz),
    wake: localIso(main.end, lastTz),
    inBedMin: minutes(main.asleepMs),
    asleepMin: null,
    awakeMin: null,
    awakenings: null,
    primarySource: primary ? { bundleId: primary.bundleId, name: primary.name } : null,
    otherSources: rows.filter((r) => r !== primary),
    naps,
    startMs: main.start,
    endMs: main.end,
    caveat: IN_BED_ONLY_CAVEAT,
  }
}

/**
 * Assemble the night of wake date `date` from the samples filed under it
 * (day-key.ts nightDate) and the vitals recorded in the same window.
 */
export function assembleNight(
  date: string,
  samples: readonly SleepSampleIn[],
  rank: (key: string) => number,
  vitals: NightVitalsIn = {},
): NightSummary | null {
  if (samples.length === 0) return null
  const inBedSegs = sweepSegments(samples.filter((s) => s.code === 0), rank)
  const stageSegs = sweepSegments(samples.filter((s) => s.code !== 0), rank)
  const asleep = stageSegs.filter((s) => ASLEEP_CODES.has(s.code))
  const runs = buildRuns(asleep, samples.filter((s) => s.code === 0 || s.code === 2))
  const endsToday = runs.filter((r) => localDate(r.end - 1, r.segments[r.segments.length - 1].tz) === date)
  const main = endsToday.reduce<Run | null>((best, r) => (!best || r.asleepMs > best.asleepMs
    || (r.asleepMs === best.asleepMs && r.end > best.end) ? r : best), null)
  const naps = runs.filter((r) => r !== main).map((r) => ({
    start: localIso(r.start, r.segments[0].tz),
    end: localIso(r.end, r.segments[r.segments.length - 1].tz),
    asleepMin: minutes(r.asleepMs),
  }))
  if (!main) return inBedOnlyNight(date, samples, inBedSegs, naps) ?? { ...emptyNight(date, 'no_main_night'), naps }

  const { start, end } = main
  const splits = nearSplits(runs, main, date, samples)
  const firstTz = main.segments[0].tz
  const lastTz = main.segments[main.segments.length - 1].tz
  // Awake inside the main night: coded awake segments plus uncovered gaps between sleep.
  let awakeMs = 0
  let awakenings = 0
  let cursor = start
  for (const seg of main.segments) {
    const gap = seg.start - cursor
    if (gap > 0) {
      awakeMs += gap
      if (gap >= AWAKENING_MIN_MS) awakenings++
    }
    cursor = Math.max(cursor, seg.end)
  }

  const stageCapable = new Set(samples.filter((s) => STAGE_CODES.has(s.code)).map((s) => s.key))
  const stage = { deepMs: 0, coreMs: 0, remMs: 0, unspecifiedMs: 0 }
  let stageCoveredMs = 0
  const usedMs = new Map<string, number>()
  for (const seg of main.segments) {
    const len = seg.end - seg.start
    usedMs.set(seg.key, (usedMs.get(seg.key) ?? 0) + len)
    if (!stageCapable.has(seg.key)) continue
    stageCoveredMs += len
    if (seg.code === 4) stage.deepMs += len
    else if (seg.code === 3) stage.coreMs += len
    else if (seg.code === 5) stage.remMs += len
    else stage.unspecifiedMs += len
  }
  const coverage = main.asleepMs > 0 ? Math.round((stageCoveredMs / main.asleepMs) * 100) / 100 : 0

  const inBedNear = inBedSegs.filter((s) => s.end > start - RUN_JOIN_GAP_MS && s.start < end + RUN_JOIN_GAP_MS)
  const inBedMs = inBedNear.length ? unionMs(inBedNear) : null
  const efficiencyBasis: NightSummary['efficiencyBasis'] = inBedMs ? 'inBed' : 'span'
  const denominator = inBedMs ?? end - start
  const efficiency = denominator > 0 ? Math.min(1, Math.round((main.asleepMs / denominator) * 100) / 100) : null

  const byKey = new Map<string, SleepSampleIn>()
  for (const s of samples) if (!byKey.has(s.key)) byKey.set(s.key, s)
  const sourceRows: NightSourceRow[] = [...byKey.values()].map((s) => ({
    key: s.key,
    bundleId: s.bundle,
    name: s.name,
    asleepMin: minutes(unionMs(samples.filter((x) => x.key === s.key && ASLEEP_CODES.has(x.code)), start, end)),
    usedMin: minutes(usedMs.get(s.key) ?? 0),
  })).sort((a, b) => b.usedMin - a.usedMin || b.asleepMin - a.asleepMin)
  const primary = sourceRows.find((r) => r.usedMin > 0) ?? null

  return {
    date,
    status: 'ok',
    tz: lastTz,
    bedtime: localIso(start, firstTz),
    wake: localIso(end, lastTz),
    inBedMin: inBedMs === null ? null : minutes(inBedMs),
    asleepMin: minutes(main.asleepMs),
    awakeMin: minutes(awakeMs),
    stages: stageCoveredMs > 0
      ? { deepMin: minutes(stage.deepMs), coreMin: minutes(stage.coreMs), remMin: minutes(stage.remMs), unspecifiedMin: minutes(stage.unspecifiedMs) }
      : null,
    stagesCoverage: coverage,
    efficiency,
    efficiencyBasis: efficiency === null ? null : efficiencyBasis,
    awakenings,
    sleepingHr: meanWithin(vitals.heartRate, start, end),
    hrvSdnn: meanWithin(vitals.hrvSdnn, start, end),
    respiratoryRate: meanWithin(vitals.respiratoryRate, start, end),
    spo2: meanWithin(vitals.spo2, start, end),
    wristTemp: meanWithin(vitals.wristTemp, start - 2 * 3600_000, end + 2 * 3600_000),
    primarySource: primary ? { bundleId: primary.bundleId, name: primary.name } : null,
    otherSources: sourceRows.filter((r) => r !== primary),
    naps,
    hypnogram: stageSegs.filter((s) => s.end > start && s.start < end && STAGE_LABELS[s.code]).map((s) => ({
      start: localIso(Math.max(s.start, start), s.tz),
      end: localIso(Math.min(s.end, end), s.tz),
      stage: STAGE_LABELS[s.code],
    })),
    startMs: start,
    endMs: end,
    ...(splits.length ? { caveat: UNRECORDED_GAP_CAVEAT, unrecordedGaps: splits } : {}),
  }
}
