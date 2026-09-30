/**
 * Night assembly, pure: Apple's source priority applied per instant, Walnut's
 * main-night and nap rule, stage coverage, In-Bed-only nights, long recorded awake
 * stretches, and the time-zone and DST nights. All sources and values are
 * invented fixtures.
 */
import { describe, it, expect } from 'vitest'
import { assembleNight, sweepSegments, type SleepSampleIn } from '../../../src/core/health/sleep-merge.js'
import { rankSources, sourceKey, MANUAL_SOURCE, isAppleDeviceSource } from '../../../src/core/health/source-order.js'
import { nightDate, sampleNightDate } from '../../../src/core/health/day-key.js'

const WATCH = 'com.apple.health.00000000-TEST-WATCH'
const APP = 'org.example.sleepnotes'
const TZ = 'America/New_York'
const at = (iso: string): number => Date.parse(iso)

function s(bundle: string, start: string, end: string, code: number, tz = TZ, userEntered = false): SleepSampleIn {
  return { start: at(start), end: at(end), code, key: sourceKey(bundle, userEntered), bundle, name: bundle === WATCH ? 'Test Watch' : 'Example Sleep', tz }
}

/**
 * Default order with the sources first seen in `newestFirst` order (index 0 = the
 * most recently added). Most tests use a Watch added after the app, so the Watch
 * leads; `appAddedLater` flips that.
 */
const rankNewestFirst = (newestFirst: string[]) => (keys: string[], order?: string[]) => {
  const infos = new Map(newestFirst.map((b, i) => [b, {
    bundle: b, firstSeenMs: at('2026-09-01T00:00:00Z') - i * 86_400_000, firstSampleMs: at('2026-01-01T00:00:00Z'), apple: b === WATCH,
  }]))
  const ranks = rankSources(keys, infos, order)
  return (k: string) => ranks.get(k) ?? 99
}
const defaultRank = rankNewestFirst([WATCH, APP])
const appAddedLater = rankNewestFirst([APP, WATCH])

/** A Watch night with stages, 23:00 to 07:00. */
function watchNight(endAt = '2026-09-21T07:00:00-04:00'): SleepSampleIn[] {
  return [
    s(WATCH, '2026-09-20T23:00:00-04:00', '2026-09-21T01:00:00-04:00', 3),
    s(WATCH, '2026-09-21T01:00:00-04:00', '2026-09-21T02:00:00-04:00', 4),
    s(WATCH, '2026-09-21T02:00:00-04:00', '2026-09-21T02:10:00-04:00', 2),
    s(WATCH, '2026-09-21T02:10:00-04:00', '2026-09-21T03:00:00-04:00', 5),
    s(WATCH, '2026-09-21T03:00:00-04:00', endAt, 3),
  ].filter((x) => x.end > x.start)
}

describe('source priority (Apple Health order)', () => {
  it('ranks manual first, then newest-added first across devices and apps (support.apple.com/108779)', () => {
    // "When you add a new data source, it appears above all apps and devices."
    const infos = new Map([
      [WATCH, { bundle: WATCH, firstSeenMs: 500, firstSampleMs: 100, apple: true }],
      ['org.example.old', { bundle: 'org.example.old', firstSeenMs: 100, firstSampleMs: 100, apple: false }],
      ['org.example.new', { bundle: 'org.example.new', firstSeenMs: 900, firstSampleMs: 100, apple: false }],
    ])
    const ranks = rankSources(['org.example.old', WATCH, 'org.example.new', MANUAL_SOURCE], infos)
    const order = [...ranks.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k)
    expect(order).toEqual([MANUAL_SOURCE, 'org.example.new', WATCH, 'org.example.old'])
  })

  it('sources first seen in the same upload: the later first sample ranks higher, then bundle id', () => {
    const infos = new Map([
      [WATCH, { bundle: WATCH, firstSeenMs: 500, firstSampleMs: 100, apple: true }],
      ['org.example.b', { bundle: 'org.example.b', firstSeenMs: 500, firstSampleMs: 300, apple: false }],
      ['org.example.a', { bundle: 'org.example.a', firstSeenMs: 500, firstSampleMs: 300, apple: false }],
    ])
    const ranks = rankSources([WATCH, 'org.example.b', 'org.example.a'], infos)
    expect([...ranks.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k)).toEqual(['org.example.a', 'org.example.b', WATCH])
  })

  it('lets a saved order win outright', () => {
    const ranks = rankSources([WATCH, APP], new Map(), [APP])
    expect(ranks.get(APP)).toBe(0)
    expect(ranks.get(WATCH)).toBe(1)
  })

  it('recognises HealthKit device sources by bundle id', () => {
    expect(isAppleDeviceSource(WATCH)).toBe(true)
    expect(isAppleDeviceSource('com.apple.Health')).toBe(false)
    expect(isAppleDeviceSource(APP)).toBe(false)
  })

  it('sweeps each instant to the highest source and fills only uncovered time from lower ones', () => {
    const segs = sweepSegments([
      s(APP, '2026-09-20T22:30:00-04:00', '2026-09-21T07:30:00-04:00', 1),
      s(WATCH, '2026-09-20T23:00:00-04:00', '2026-09-21T07:00:00-04:00', 3),
    ], defaultRank([APP, WATCH]))
    expect(segs.map((x) => [x.key, (x.end - x.start) / 60_000])).toEqual([[APP, 30], [WATCH, 480], [APP, 30]])
  })
})

describe('assembleNight', () => {
  it('reports one Watch night with stages, awake time, awakenings and efficiency by span', () => {
    const night = assembleNight('2026-09-21', watchNight(), defaultRank([WATCH]))!
    expect(night.status).toBe('ok')
    expect(night.bedtime).toBe('2026-09-20T23:00:00-04:00')
    expect(night.wake).toBe('2026-09-21T07:00:00-04:00')
    expect(night.asleepMin).toBe(470)
    expect(night.awakeMin).toBe(10)
    expect(night.awakenings).toBe(1)
    expect(night.stages).toEqual({ deepMin: 60, coreMin: 360, remMin: 50, unspecifiedMin: 0 })
    expect(night.stagesCoverage).toBe(1)
    expect(night.inBedMin).toBeNull()
    expect(night.efficiencyBasis).toBe('span')
    expect(night.efficiency).toBe(0.98)
    expect(night.hypnogram[0]).toEqual({ start: '2026-09-20T23:00:00-04:00', end: '2026-09-21T01:00:00-04:00', stage: 'core' })
  })

  it('two sources on one night: the newer Watch wins its span, the app fills the edges, stages cover only the Watch part', () => {
    const samples = [...watchNight(), s(APP, '2026-09-20T22:30:00-04:00', '2026-09-21T07:30:00-04:00', 1)]
    const night = assembleNight('2026-09-21', samples, defaultRank([WATCH, APP]))!
    expect(night.asleepMin).toBe(530)
    expect(night.bedtime).toBe('2026-09-20T22:30:00-04:00')
    expect(night.wake).toBe('2026-09-21T07:30:00-04:00')
    expect(night.stagesCoverage).toBe(0.89)
    expect(night.primarySource?.bundleId).toBe(WATCH)
    expect(night.otherSources).toEqual([expect.objectContaining({ bundleId: APP, asleepMin: 540, usedMin: 60 })])
  })

  it('an app added after the Watch outranks it for the whole night: no stage-capable minutes, stages null', () => {
    const samples = [...watchNight(), s(APP, '2026-09-20T22:30:00-04:00', '2026-09-21T07:30:00-04:00', 1)]
    const night = assembleNight('2026-09-21', samples, appAddedLater([WATCH, APP]))!
    expect(night.primarySource?.bundleId).toBe(APP)
    expect(night.asleepMin).toBe(540)
    expect(night.stages).toBeNull()
  })

  it('a saved order that puts the app first leaves no stage-capable minutes, so stages are null', () => {
    const samples = [...watchNight(), s(APP, '2026-09-20T22:30:00-04:00', '2026-09-21T07:30:00-04:00', 1)]
    const night = assembleNight('2026-09-21', samples, defaultRank([WATCH, APP], [APP]))!
    expect(night.asleepMin).toBe(540)
    expect(night.stages).toBeNull()
    expect(night.stagesCoverage).toBe(0)
    expect(night.primarySource?.bundleId).toBe(APP)
  })

  it('a Watch that dies at 3am keeps the first half; the app that kept recording fills the rest', () => {
    const samples = [
      ...watchNight('2026-09-21T03:00:00-04:00'),
      s(APP, '2026-09-20T23:10:00-04:00', '2026-09-21T07:00:00-04:00', 1),
    ]
    const night = assembleNight('2026-09-21', samples, defaultRank([WATCH, APP]))!
    expect(night.bedtime).toBe('2026-09-20T23:00:00-04:00')
    expect(night.wake).toBe('2026-09-21T07:00:00-04:00')
    expect(night.asleepMin).toBe(470)
    // Stages only for the Watch hours (23:00 to 03:00 minus 10 awake), none invented after it died.
    expect(night.stages).toEqual({ deepMin: 60, coreMin: 120, remMin: 50, unspecifiedMin: 0 })
    expect(night.stagesCoverage).toBe(0.49)
  })

  it('keeps an afternoon nap apart from the main night and labels it', () => {
    const samples = [...watchNight(), s(WATCH, '2026-09-21T14:00:00-04:00', '2026-09-21T14:45:00-04:00', 1)]
    const night = assembleNight('2026-09-21', samples, defaultRank([WATCH]))!
    expect(night.asleepMin).toBe(470)
    expect(night.naps).toEqual([{ start: '2026-09-21T14:00:00-04:00', end: '2026-09-21T14:45:00-04:00', asleepMin: 45 }])
  })

  it('joins sleep separated by less than 60 minutes into one night', () => {
    const samples = [
      s(WATCH, '2026-09-20T23:00:00-04:00', '2026-09-21T02:00:00-04:00', 3),
      s(WATCH, '2026-09-21T02:50:00-04:00', '2026-09-21T06:00:00-04:00', 3),
    ]
    const night = assembleNight('2026-09-21', samples, defaultRank([WATCH]))!
    expect(night.asleepMin).toBe(370)
    expect(night.awakeMin).toBe(50)
    expect(night.naps).toEqual([])
  })

  it('uses in-bed time for efficiency when a source recorded it', () => {
    const samples = [...watchNight(), s(APP, '2026-09-20T22:40:00-04:00', '2026-09-21T07:20:00-04:00', 0)]
    const night = assembleNight('2026-09-21', samples, defaultRank([WATCH, APP]))!
    expect(night.inBedMin).toBe(520)
    expect(night.efficiencyBasis).toBe('inBed')
    expect(night.efficiency).toBe(0.9)
  })

  it('a night across a time zone change: durations from instants, clock times in each sample zone', () => {
    const samples = [
      s(WATCH, '2026-09-20T22:00:00-07:00', '2026-09-21T02:00:00-07:00', 3, 'America/Los_Angeles'),
      s(WATCH, '2026-09-21T05:00:00-04:00', '2026-09-21T09:00:00-04:00', 3, 'America/New_York'),
    ]
    expect(samples.map((x) => nightDate(x.end - 1, x.tz))).toEqual(['2026-09-21', '2026-09-21'])
    const night = assembleNight('2026-09-21', samples, defaultRank([WATCH]))!
    expect(night.asleepMin).toBe(480)
    expect(night.bedtime).toBe('2026-09-20T22:00:00-07:00')
    expect(night.wake).toBe('2026-09-21T09:00:00-04:00')
  })

  it('the DST night of 2026-11-01 counts its extra hour', () => {
    const samples = [s(WATCH, '2026-10-31T23:00:00-04:00', '2026-11-01T07:00:00-05:00', 3)]
    const night = assembleNight('2026-11-01', samples, defaultRank([WATCH]))!
    expect(night.asleepMin).toBe(540)
    expect(night.wake).toBe('2026-11-01T07:00:00-05:00')
  })

  it('averages sleeping vitals over the main night only', () => {
    const night = assembleNight('2026-09-21', watchNight(), defaultRank([WATCH]), {
      heartRate: [
        { start: at('2026-09-21T01:00:00-04:00'), end: at('2026-09-21T01:05:00-04:00'), value: 50, weight: 3 },
        { start: at('2026-09-21T04:00:00-04:00'), end: at('2026-09-21T04:05:00-04:00'), value: 60, weight: 1 },
        { start: at('2026-09-21T12:00:00-04:00'), end: at('2026-09-21T12:05:00-04:00'), value: 110, weight: 5 },
      ],
      hrvSdnn: [{ start: at('2026-09-21T03:00:00-04:00'), end: at('2026-09-21T03:01:00-04:00'), value: 41 }],
    })!
    expect(night.sleepingHr).toBe(52.5)
    expect(night.hrvSdnn).toBe(41)
    expect(night.spo2).toBeNull()
  })

  it('a 70 min awake stretch the Watch recorded stays inside the night and counts as awake', () => {
    // The gate's fragmented night: without the rule the 04:10 to 07:00 part became a "nap".
    const samples = [
      s(WATCH, '2026-09-20T23:00:00-04:00', '2026-09-21T03:00:00-04:00', 3),
      s(WATCH, '2026-09-21T03:00:00-04:00', '2026-09-21T04:10:00-04:00', 2),
      s(WATCH, '2026-09-21T04:10:00-04:00', '2026-09-21T07:00:00-04:00', 3),
    ]
    const night = assembleNight('2026-09-21', samples, defaultRank([WATCH]))!
    expect(night).toMatchObject({ status: 'ok', asleepMin: 410, awakeMin: 70, awakenings: 1, wake: '2026-09-21T07:00:00-04:00', naps: [] })
  })

  it('an in-bed record of the same source also bridges a long gap; an unrecorded gap still splits', () => {
    const bridged = assembleNight('2026-09-21', [
      s(WATCH, '2026-09-20T23:00:00-04:00', '2026-09-21T03:00:00-04:00', 3),
      s(WATCH, '2026-09-20T22:50:00-04:00', '2026-09-21T07:05:00-04:00', 0),
      s(WATCH, '2026-09-21T04:30:00-04:00', '2026-09-21T07:00:00-04:00', 3),
    ], defaultRank([WATCH]))!
    expect(bridged).toMatchObject({ asleepMin: 390, awakeMin: 90, naps: [] })
    // Another source's awake record does not bridge the Watch's hole.
    const split = assembleNight('2026-09-21', [
      s(WATCH, '2026-09-20T23:00:00-04:00', '2026-09-21T03:00:00-04:00', 3),
      s(APP, '2026-09-21T03:00:00-04:00', '2026-09-21T04:30:00-04:00', 2),
      s(WATCH, '2026-09-21T04:30:00-04:00', '2026-09-21T07:00:00-04:00', 3),
    ], defaultRank([WATCH, APP]))!
    expect(split.asleepMin).toBe(240)
    expect(split.naps).toHaveLength(1)
  })

  it('an unrecorded 70 min hole is reported on the night, so a 03:00 wake is never stated as fact', () => {
    // The gate's case: nothing at all between 03:00 and 04:10. Not joined (Apple documents
    // no rule for joining across a recording gap), but the night says the gap is there.
    const night = assembleNight('2026-09-21', [
      s(WATCH, '2026-09-20T23:00:00-04:00', '2026-09-21T03:00:00-04:00', 3),
      s(WATCH, '2026-09-21T04:10:00-04:00', '2026-09-21T07:00:00-04:00', 3),
    ], defaultRank([WATCH]))!
    expect(night).toMatchObject({ status: 'ok', asleepMin: 240, wake: '2026-09-21T03:00:00-04:00' })
    expect(night.naps).toEqual([{ start: '2026-09-21T04:10:00-04:00', end: '2026-09-21T07:00:00-04:00', asleepMin: 170 }])
    expect(night.unrecordedGaps).toEqual([{
      side: 'after', start: '2026-09-21T03:00:00-04:00', end: '2026-09-21T04:10:00-04:00', min: 70, unrecordedMin: 70, otherSleepMin: 170,
    }])
    expect(night.caveat).toMatch(/cannot tell a real wake from a recording gap/)
    expect(night.caveat).toMatch(/do not state them as fact/)
  })

  it('a split before the night is reported too; an afternoon nap or an evening one is not a gap', () => {
    const before = assembleNight('2026-09-21', [
      s(WATCH, '2026-09-20T23:00:00-04:00', '2026-09-21T00:30:00-04:00', 3),
      s(WATCH, '2026-09-21T01:40:00-04:00', '2026-09-21T07:00:00-04:00', 3),
    ], defaultRank([WATCH]))!
    expect(before.unrecordedGaps).toEqual([{
      side: 'before', start: '2026-09-21T00:30:00-04:00', end: '2026-09-21T01:40:00-04:00', min: 70, unrecordedMin: 70, otherSleepMin: 90,
    }])
    // Seven hours after the wake, and an evening nap filed under the previous date: no gap.
    const afternoon = assembleNight('2026-09-21', [...watchNight(), s(WATCH, '2026-09-21T14:00:00-04:00', '2026-09-21T14:45:00-04:00', 1)], defaultRank([WATCH]))!
    expect(afternoon.unrecordedGaps).toBeUndefined()
    expect(afternoon.caveat).toBeUndefined()
    const evening = assembleNight('2026-09-21', [s(WATCH, '2026-09-20T21:00:00-04:00', '2026-09-20T22:00:00-04:00', 1), ...watchNight()], defaultRank([WATCH]))!
    expect(evening.unrecordedGaps).toBeUndefined()
    // A split another source's awake record covers is still a split, and says nothing went unrecorded.
    const covered = assembleNight('2026-09-21', [
      s(WATCH, '2026-09-20T23:00:00-04:00', '2026-09-21T03:00:00-04:00', 3),
      s(APP, '2026-09-21T03:00:00-04:00', '2026-09-21T04:30:00-04:00', 2),
      s(WATCH, '2026-09-21T04:30:00-04:00', '2026-09-21T07:00:00-04:00', 3),
    ], defaultRank([WATCH, APP]))!
    expect(covered.unrecordedGaps).toEqual([expect.objectContaining({ side: 'after', min: 90, unrecordedMin: 0, otherSleepMin: 150 })])
  })

  it('a night with In Bed samples only is reported: in-bed span, asleep unknown, with a caveat', () => {
    const PHONE = 'com.apple.health.00000000-TEST-PHONE'
    const night = assembleNight('2026-09-24', [
      { start: at('2026-09-23T23:30:00-04:00'), end: at('2026-09-24T07:15:00-04:00'), code: 0, key: PHONE, bundle: PHONE, name: 'Test Phone', tz: TZ },
    ], rankNewestFirst([PHONE])([PHONE]))!
    expect(night).toMatchObject({
      status: 'in_bed_only', inBedMin: 465, asleepMin: null, awakeMin: null, awakenings: null, stages: null,
      bedtime: '2026-09-23T23:30:00-04:00', wake: '2026-09-24T07:15:00-04:00', efficiency: null,
      primarySource: { bundleId: PHONE, name: 'Test Phone' },
    })
    expect(night.caveat).toMatch(/Only time in bed was recorded/)
  })

  it('the night boundary is exact: a sample ending at 18:00 is that day\'s, a millisecond later the next', () => {
    const start = at('2026-09-21T16:00:00-04:00')
    expect(sampleNightDate(start, at('2026-09-21T18:00:00-04:00'), TZ)).toBe('2026-09-21')
    expect(sampleNightDate(start, at('2026-09-21T18:00:00.001-04:00'), TZ)).toBe('2026-09-22')
    expect(sampleNightDate(at('2026-09-21T18:00:00-04:00'), at('2026-09-21T18:00:00-04:00'), TZ)).toBe('2026-09-22')
  })

  it('no run ending on the wake date means no main night (naps only)', () => {
    const night = assembleNight('2026-09-21', [s(WATCH, '2026-09-20T19:00:00-04:00', '2026-09-20T20:00:00-04:00', 1)], defaultRank([WATCH]))!
    expect(night.status).toBe('no_main_night')
    expect(night.naps).toHaveLength(1)
    expect(assembleNight('2026-09-21', [], defaultRank([]))).toBeNull()
  })
})
