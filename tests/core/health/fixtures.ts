/**
 * Invented Apple Health fixtures for the health tests. Every source, device and
 * value here is made up; the marker values exist so a test can prove they never
 * reach a log line.
 */

export const TZ = 'America/New_York'
export const WATCH = { bundleId: 'com.apple.health.00000000-TEST-WATCH', name: 'Marker Watch Zeta' }
export const APP = { bundleId: 'org.example.sleepnotes', name: 'Marker App Kappa' }
/** Distinctive numbers that must never appear in a log line. */
export const MARKER_HR = 57.123
export const MARKER_HRV = 43.219

let seq = 0
export function uuid(prefix = 'A'): string {
  seq++
  return `${prefix}0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`
}

export interface RawSample {
  uuid: string; start: string; end: string; code?: number; value?: number
  source: { bundleId: string; name: string }; tz?: string; device?: string; meta?: Record<string, unknown>
}

export function sleepSample(start: string, end: string, code: number, source = WATCH, extra: Partial<RawSample> = {}): RawSample {
  return { uuid: uuid(), start, end, code, source, device: source === WATCH ? 'Watch' : undefined, ...extra }
}

/** A Watch night for wake date D (YYYY-MM-DD, New York): 23:00 D-1 to 07:00 D with stages. */
export function watchNight(prevDate: string, date: string, source = WATCH): RawSample[] {
  return [
    sleepSample(`${prevDate}T23:00:00-04:00`, `${date}T01:00:00-04:00`, 3, source),
    sleepSample(`${date}T01:00:00-04:00`, `${date}T02:00:00-04:00`, 4, source),
    sleepSample(`${date}T02:00:00-04:00`, `${date}T02:10:00-04:00`, 2, source),
    sleepSample(`${date}T02:10:00-04:00`, `${date}T03:00:00-04:00`, 5, source),
    sleepSample(`${date}T03:00:00-04:00`, `${date}T07:00:00-04:00`, 3, source),
  ]
}

export function rawBatch(type: string, samples: RawSample[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device: { installId: 'install-test-1', model: 'iPhone', os: 'iOS 26' },
    tz: TZ, kind: 'raw', type, samples, deleted: [], ...extra,
  }
}

export function bucketBatch(metric: string, buckets: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { device: { installId: 'install-test-1', model: 'iPhone', os: 'iOS 26' }, tz: TZ, kind: 'buckets', metric, buckets, ...extra }
}

/** `count` five-minute heart-rate buckets starting at `startMs`. */
export function hrBuckets(startMs: number, count: number, avg = MARKER_HR): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    start: new Date(startMs + i * 300_000).toISOString(), intervalSec: 300, avg, min: avg - 5, max: avg + 5, count: 12,
  }))
}
