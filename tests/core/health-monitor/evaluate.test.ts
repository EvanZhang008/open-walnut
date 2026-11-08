/**
 * The health monitor's pure parts: how a log line folds to its kind, how an alarm
 * reads periods (M of N, missing data, counters vs gauges, a second condition), and
 * the two log rules (spike against its own normal, chronic every day).
 */
import { describe, expect, it } from 'vitest'
import { foldMessage, signatureKey } from '../../../src/core/health-monitor/signature.js'
import { evaluateAlarm, fillPattern, indexRows, matchSeries, MINUTE_MS, periodValues } from '../../../src/core/health-monitor/evaluate.js'
import {
  chronicDays, chronicVerdict, DAY_MS, HOUR_MS, hourStart, spikeBaseline, spikeVerdict, type HourBuckets,
} from '../../../src/core/health-monitor/log-alarms.js'
import { BUILTIN_ALARMS, builtinAlarm } from '../../../src/core/health-monitor/alarms.js'
import type { AlarmDef, MinuteRow } from '../../../src/core/health-monitor/types.js'

const T0 = Date.parse('2026-11-08T12:00:00Z')

describe('signature', () => {
  it('folds ids, numbers, times, paths and quoted values, keeping the words', () => {
    expect(foldMessage('[api] GET /api/sessions/3ccf06d9-dbdd-49a1-ab98-1537944f64d4/supervision FAILED after 30ms'))
      .toBe('[api] GET /api/sessions/<id>/supervision FAILED after #ms')
    expect(foldMessage('task muudy83e-d669 moved at 2026-11-08T08:17:15.231Z')).toBe('task <id> moved at <time>')
    expect(foldMessage('read /tmp/open-walnut/streams/x.jsonl failed')).toBe('read <path> failed')
    expect(foldMessage('host "clouddev" refused')).toBe('host "…" refused')
  })

  it('keeps an HTTP status, so a 403 and a 409 of one route are two kinds', () => {
    expect(foldMessage('POST /api/v1/hosts/__local__/exec → 403 (1ms)')).toBe('POST /api/v#/hosts/__local__/exec → 403 (#ms)')
    expect(signatureKey('web', 'POST /x → 403 (1ms)')).not.toBe(signatureKey('web', 'POST /x → 409 (0ms)'))
  })

  it('keeps hyphenated words without a digit (they are not ids)', () => {
    expect(foldMessage('snapshot-pull failed')).toBe('snapshot-pull failed')
  })

  it('two lines differing only in their ids are one kind; different words are two', () => {
    const a = signatureKey('browser', '[api] PATCH /api/tasks/35bad6c0-e9b2-57d2-a774-06e70ac68eec FAILED after 124ms')
    const b = signatureKey('browser', '[api] PATCH /api/tasks/11111111-e9b2-57d2-a774-06e70ac68eec FAILED after 8ms')
    expect(a).toBe(b)
    expect(signatureKey('session', 'JSONL read via daemon failed')).not.toBe(signatureKey('session', 'gateway relay refused'))
  })

  it('caps a long message', () => {
    expect(foldMessage('x'.repeat(500)).length).toBeLessThanOrEqual(121)
  })
})

function rows(n: number, f: (i: number) => Record<string, number> | null, end = T0): MinuteRow[] {
  const out: MinuteRow[] = []
  for (let i = n; i >= 1; i--) {
    const v = f(n - i)
    if (v) out.push({ t: end - i * MINUTE_MS, v })
  }
  return out
}

const gauge = (over: Partial<AlarmDef> = {}): AlarmDef => ({
  id: 'g', title: 'g', description: '', metric: 'g', kind: 'gauge', stat: 'max', periodMin: 1, comparison: '>',
  threshold: 10, evaluationPeriods: 5, datapointsToAlarm: 3, missing: 'missing', unit: '', action: { then: 'none' }, ...over,
})

describe('evaluateAlarm', () => {
  it('ALARM only when M of the last N periods cross', () => {
    const r = indexRows(rows(5, (i) => ({ g: [20, 1, 20, 1, 20][i] })))
    expect(evaluateAlarm(gauge(), r, 'g', T0).state).toBe('ALARM')
    const r2 = indexRows(rows(5, (i) => ({ g: [20, 1, 1, 1, 20][i] })))
    expect(evaluateAlarm(gauge(), r2, 'g', T0).state).toBe('OK')
  })

  it('the current minute is never read (it is still being written)', () => {
    const r = indexRows([...rows(5, () => ({ g: 1 })), { t: T0, v: { g: 99 } }])
    expect(evaluateAlarm(gauge({ datapointsToAlarm: 1 }), r, 'g', T0 + 30_000).state).toBe('OK')
  })

  it('no data at all reads INSUFFICIENT_DATA; notBreaching reads OK; breaching reads ALARM', () => {
    const empty = indexRows([])
    expect(evaluateAlarm(gauge(), empty, 'g', T0).state).toBe('INSUFFICIENT_DATA')
    expect(evaluateAlarm(gauge({ missing: 'notBreaching' }), empty, 'g', T0).state).toBe('OK')
    expect(evaluateAlarm(gauge({ missing: 'breaching' }), empty, 'g', T0).state).toBe('ALARM')
  })

  it('a counter reads 0 for a recorded minute without its key, a gauge reads nothing', () => {
    const r = indexRows(rows(10, () => ({ other: 1 })))
    expect(periodValues(r, 'c', 'counter', 'sum', 5, 2, T0)).toEqual([0, 0])
    expect(periodValues(r, 'c', 'gauge', 'max', 5, 2, T0)).toEqual([null, null])
    // a minute with no row at all (server down) is no data for a counter too
    expect(periodValues(indexRows([]), 'c', 'counter', 'sum', 5, 1, T0)).toEqual([null])
  })

  it('sums an hour of a counter', () => {
    const r = indexRows(rows(120, (i) => (i % 10 === 0 ? { c: 1 } : {})))
    expect(periodValues(r, 'c', 'counter', 'sum', 60, 2, T0)).toEqual([6, 6])
  })

  it('the second condition must hold too (disk: little free AND a high used %)', () => {
    const disk = builtinAlarm('disk.free')!
    const tight = indexRows(rows(15, () => ({ 'disk.free_gb': 24, 'disk.used_pct': 95 })))
    expect(evaluateAlarm(disk, tight, disk.metric, T0).state).toBe('ALARM')
    // a big volume mostly empty: little free in GB is still not "full"
    const roomy = indexRows(rows(15, () => ({ 'disk.free_gb': 24, 'disk.used_pct': 40 })))
    expect(evaluateAlarm(disk, roomy, disk.metric, T0).state).toBe('OK')
  })

  it('a starred label matches each host, and fills back', () => {
    expect(matchSeries('host.link.lost{host=*}', 'host.link.lost{host=clouddev}')).toEqual({ host: 'clouddev' })
    expect(matchSeries('host.link.lost{host=*}', 'host.link.lost')).toBeNull()
    expect(matchSeries('host.link.lost{host=*}', 'other{host=x}')).toBeNull()
    expect(fillPattern('host.link.lost{host=*}', { host: 'a' })).toBe('host.link.lost{host=a}')
  })

  it('every built-in alarm is well formed', () => {
    const ids = new Set<string>()
    for (const d of BUILTIN_ALARMS) {
      expect(ids.has(d.id)).toBe(false)
      ids.add(d.id)
      expect(d.datapointsToAlarm).toBeGreaterThanOrEqual(1)
      expect(d.datapointsToAlarm).toBeLessThanOrEqual(d.evaluationPeriods)
      expect(d.periodMin).toBeGreaterThanOrEqual(1)
      expect(d.description.length).toBeGreaterThan(20)
      if (d.action.autoFix) expect(['disk-sweep', 'status-recheck']).toContain(d.action.autoFix)
    }
  })
})

describe('log rules', () => {
  const sig = 'session: gateway relay refused'
  const now = T0 + 30 * 60_000

  function hoursWith(days: number[], hourOffset = 0): HourBuckets {
    const h: HourBuckets = {}
    days.forEach((n, i) => { h[String(hourStart(now) - (i + 1) * DAY_MS + hourOffset)] = { [sig]: n } })
    return h
  }

  it('normal is the median of the same hour on recorded days; fewer than 3 days is no normal', () => {
    expect(spikeBaseline(hoursWith([10, 14, 100]), sig, now)).toBe(14)
    expect(spikeBaseline(hoursWith([10, 14]), sig, now)).toBeNull()
    // a recorded hour without the kind counts 0
    const h = hoursWith([10, 14, 20])
    h[String(hourStart(now) - 4 * DAY_MS)] = {}
    expect(spikeBaseline(h, sig, now)).toBe(12)
  })

  it('spike: 5 times normal and at least 30; stays on until under half', () => {
    expect(spikeVerdict(98, 14, false)).toBe('ALARM')
    expect(spikeVerdict(60, 14, false)).toBe('OK')
    expect(spikeVerdict(29, 0, false)).toBe('OK')
    expect(spikeVerdict(30, 0, false)).toBe('ALARM')
    expect(spikeVerdict(40, 14, true)).toBe('ALARM')
    expect(spikeVerdict(30, 14, true)).toBe('OK')
    expect(spikeVerdict(500, null, false)).toBe('INSUFFICIENT_DATA')
  })

  it('chronic: every one of the last 3 whole days over the limit, each with 12+ hours recorded', () => {
    const h: HourBuckets = {}
    const today = Math.floor(now / DAY_MS) * DAY_MS
    for (let d = 1; d <= 3; d++) for (let i = 0; i < 24; i++) h[String(today - d * DAY_MS + i * HOUR_MS)] = { [sig]: 40 }
    expect(chronicDays(h, sig, now)).toEqual([960, 960, 960])
    expect(chronicVerdict(chronicDays(h, sig, now), 'error', false)).toBe('ALARM')
    expect(chronicVerdict(chronicDays(h, sig, now), 'warn', false)).toBe('OK')
    // a day the server was up for under 12 hours does not count
    for (let i = 0; i < 20; i++) delete h[String(today - 2 * DAY_MS + i * HOUR_MS)]
    expect(chronicDays(h, sig, now)[1]).toBeNull()
    expect(chronicVerdict(chronicDays(h, sig, now), 'error', false)).toBe('INSUFFICIENT_DATA')
    expect(chronicVerdict([300, 150, 120], 'error', true)).toBe('ALARM')
    expect(chronicVerdict([300, 150, 90], 'error', true)).toBe('OK')
  })
})
