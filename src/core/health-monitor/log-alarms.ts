/**
 * Alarms on log lines, so a problem nobody wrote an alarm for still shows:
 * every kind of warn and error line (signature.ts) is counted per hour, and two
 * rules read the counts.
 *
 *  - spike: a kind is far above its own normal. Normal is the median of the
 *    same hour on the last 7 days the server was up at that hour (at least 3
 *    such days, else there is no normal yet). ALARM at 5 times normal and at
 *    least 30 in the last 60 minutes; OK again under half of that.
 *  - chronic: a kind that is high every day, which a spike never catches
 *    (2026-11-08: "JSONL read via daemon failed" ran 693 then 939 a day). ALARM
 *    when each of the last 3 whole days reached 200 errors (1,000 for a warning),
 *    each of those days with at least 12 hours recorded; OK again once one of them
 *    falls under half.
 *
 * Pure: hour buckets in, verdicts out.
 */

import type { AlarmDef } from './types.js'

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS

export const SPIKE_FACTOR = 5
export const SPIKE_MIN = 30
export const BASELINE_DAYS = 7
export const BASELINE_MIN_DAYS = 3
export const CHRONIC_DAYS = 3
export const CHRONIC_MIN_ERROR = 200
export const CHRONIC_MIN_WARN = 1000
/** A day counts for the chronic rule only with this many hours recorded (the server was up). */
export const CHRONIC_MIN_HOURS = 12

export type LogLevelKind = 'warn' | 'error'

/** Counts per hour start (epoch ms): signature → count. An hour present with `{}` was recorded with nothing. */
export type HourBuckets = Record<string, Record<string, number>>

export function hourStart(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** The normal count of `sig` for the hour around `nowMs`, or null with too few days recorded. */
export function spikeBaseline(hours: HourBuckets, sig: string, nowMs: number): number | null {
  const h = hourStart(nowMs)
  const days: number[] = []
  for (let d = 1; d <= BASELINE_DAYS; d++) {
    const bucket = hours[String(h - d * DAY_MS)]
    if (bucket) days.push(bucket[sig] ?? 0)
  }
  return days.length >= BASELINE_MIN_DAYS ? median(days) : null
}

export function spikeThreshold(baseline: number): number {
  return Math.max(SPIKE_MIN, SPIKE_FACTOR * baseline)
}

/** Spike verdict, with hysteresis: in ALARM it stays until the count falls under half the threshold. */
export function spikeVerdict(
  last60: number, baseline: number | null, wasAlarm: boolean,
): 'ALARM' | 'OK' | 'INSUFFICIENT_DATA' {
  if (baseline === null) return wasAlarm ? 'ALARM' : 'INSUFFICIENT_DATA'
  const t = spikeThreshold(baseline)
  if (last60 >= t) return 'ALARM'
  if (wasAlarm && last60 >= t / 2) return 'ALARM'
  return 'OK'
}

/** UTC day start. */
export function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

/** Totals of `sig` on the last `CHRONIC_DAYS` whole days before `nowMs`, oldest first; null for a day with too few hours recorded. */
export function chronicDays(hours: HourBuckets, sig: string, nowMs: number): Array<number | null> {
  const today = dayStart(nowMs)
  const out: Array<number | null> = []
  for (let d = CHRONIC_DAYS; d >= 1; d--) {
    const start = today - d * DAY_MS
    let recorded = 0
    let total = 0
    for (let h = 0; h < 24; h++) {
      const b = hours[String(start + h * HOUR_MS)]
      if (!b) continue
      recorded++
      total += b[sig] ?? 0
    }
    out.push(recorded >= CHRONIC_MIN_HOURS ? total : null)
  }
  return out
}

export function chronicMin(level: LogLevelKind): number {
  return level === 'error' ? CHRONIC_MIN_ERROR : CHRONIC_MIN_WARN
}

export function chronicVerdict(
  days: Array<number | null>, level: LogLevelKind, wasAlarm: boolean,
): 'ALARM' | 'OK' | 'INSUFFICIENT_DATA' {
  if (days.some((d) => d === null)) return wasAlarm ? 'ALARM' : 'INSUFFICIENT_DATA'
  const min = chronicMin(level)
  const counts = days as number[]
  if (counts.every((c) => c >= min)) return 'ALARM'
  if (wasAlarm && counts.every((c) => c >= min / 2)) return 'ALARM'
  return 'OK'
}

/** Short stable id for a signature (djb2, base 36), so an alarm id fits a URL. */
export function signatureId(sig: string): string {
  let h = 5381
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** A log alarm's def, made per kind of line. */
export function logDef(kind: 'spike' | 'chronic', sig: string, level: 'warn' | 'error'): AlarmDef {
  return {
    id: `log.${kind}`,
    title: kind === 'spike' ? 'Log line far above its normal' : 'Log line high every day',
    description: kind === 'spike'
      ? 'This kind of warn/error line came at least 5 times as often as on the same hour of the last week.'
      : `This kind of ${level} line came at least ${level === 'error' ? 200 : 1000} times on each of the last 3 days.`,
    metric: sig, kind: 'counter', stat: 'sum', periodMin: kind === 'spike' ? 60 : 1440,
    comparison: '>=', threshold: 0, evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'missing',
    unit: kind === 'spike' ? 'per hour' : 'per day', action: { then: 'fix-task' },
  }
}
