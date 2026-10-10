/**
 * The report's corrections and new detail: lease seconds another Mac app was
 * frontmost are cut (overlapMin, outside wins), Walnut frontmost without input is
 * inferred reading (readingMin, capped, never across a switch), the phone's time
 * is never touched, calls are their own number, and the session views, files,
 * plugin items and sent messages group. Local wall-clock timestamps throughout.
 */

import { describe, expect, it } from 'vitest'
import { buildTimeReport, REPORT_DEFAULTS, type ReportOptions } from '../../../src/core/time-tracking/report.js'
import { adjustLeases, READING_CAP_MS } from '../../../src/core/time-tracking/report-adjust.js'
import { DEFAULT_WORK_HOURS } from '../../../src/core/time-tracking/work-hours.js'
import type { DetailLine } from '../../../src/core/time-tracking/detail-store.js'
import type { OutsideRecord } from '../../../src/core/time-tracking/outside-store.js'
import type { TimeRecord } from '../../../src/core/time-tracking/types.js'

const MON = '2026-10-05'
const MIN = 60_000
const at = (h: number, m = 0, s = 0): number => new Date(2026, 9, 5, h, m, s).getTime()
const iso = (h: number, m = 0, s = 0): string => new Date(at(h, m, s)).toISOString()
const HOSTS = new Set(['localhost'])

const lease = (h: number, m: number, mins: number, over: Partial<TimeRecord> = {}): TimeRecord => ({
  date: MON, ts: iso(h, m), durationMs: mins * MIN, kind: 'session', taskId: 't_a', ...over,
})
/** Sampler windows, 5 s each, from a local start for `mins` minutes. */
function samples(h: number, m: number, mins: number, app: string, bundleId: string, host?: string): OutsideRecord[] {
  return Array.from({ length: mins * 12 }, (_, i) => ({
    date: MON, ts: new Date(at(h, m) + i * 5_000).toISOString(), durationMs: 5_000, app, bundleId, ...(host ? { host } : {}),
  }))
}
const slack = (h: number, m: number, mins: number) => samples(h, m, mins, 'Slack', 'com.tinyspeck.slackmacgap')
const walnutApp = (h: number, m: number, mins: number) => samples(h, m, mins, 'Walnut', 'com.local.walnut-desktop')

function opts(over: Partial<ReportOptions> = {}): ReportOptions {
  return {
    ...REPORT_DEFAULTS, dates: [MON], workHours: DEFAULT_WORK_HOURS, workHoursSource: 'default',
    groupBy: ['task', 'view', 'file', 'item'], includeOutside: true, walnutHosts: ['localhost'], ...over,
  }
}
const tasks = new Map([['t_a', { title: 'Alpha', project: 'P' }], ['t_b', { title: 'Beta', project: 'P' }]])

describe('adjustLeases: overlap', () => {
  it('cuts the lease tail that ran on while another app was frontmost', () => {
    const rec = lease(10, 0, 2) // 10:00-10:02
    const adj = adjustLeases(new Map([[MON, [rec]]]), new Map([[MON, slack(10, 1, 5)]]), HOSTS)
    expect(adj.overlap.get(rec)).toBe(MIN)
    expect(adj.pieces.get(rec)).toEqual([[at(10, 0), at(10, 1)]])
  })

  it('leaves the phone\'s time alone: the Mac sampler cannot see the phone', () => {
    const rec = lease(10, 0, 2, { source: 'ios' })
    const adj = adjustLeases(new Map([[MON, [rec]]]), new Map([[MON, slack(10, 0, 5)]]), HOSTS)
    expect(adj.overlap.size).toBe(0)
  })

  it('Walnut in a browser on a Walnut host is not another app', () => {
    const rec = lease(10, 0, 2)
    const adj = adjustLeases(new Map([[MON, [rec]]]), new Map([[MON, samples(10, 0, 5, 'Google Chrome', 'com.google.Chrome', 'localhost')]]), HOSTS)
    expect(adj.overlap.size).toBe(0)
  })

  it('a browser whose site the sampler could not read neither cuts nor credits: it may be Walnut', () => {
    const rec = lease(10, 0, 2)
    const adj = adjustLeases(new Map([[MON, [rec]]]), new Map([[MON, samples(10, 0, 10, 'Google Chrome', 'com.google.Chrome')]]), HOSTS)
    expect(adj.overlap.size).toBe(0)
    expect(adj.reading).toEqual([])
    expect(adj.other).toEqual([])
  })

  it('a browser on another site is another app', () => {
    const rec = lease(10, 0, 2)
    const adj = adjustLeases(new Map([[MON, [rec]]]), new Map([[MON, samples(10, 1, 5, 'Google Chrome', 'com.google.Chrome', 'example.org')]]), HOSTS)
    expect(adj.overlap.get(rec)).toBe(MIN)
  })
})

describe('adjustLeases: reading', () => {
  it('credits Walnut frontmost without input to the last lease, up to the cap', () => {
    const rec = lease(10, 0, 1) // ends 10:01
    const adj = adjustLeases(new Map([[MON, [rec]]]), new Map([[MON, walnutApp(10, 0, 30)]]), HOSTS)
    expect(adj.reading).toEqual([expect.objectContaining({ taskId: 't_a', kind: 'session', startMs: at(10, 1), endMs: at(10, 1) + READING_CAP_MS })])
  })

  it('stops at the next lease, which takes over', () => {
    const recs = [lease(10, 0, 1), lease(10, 5, 1, { taskId: 't_b' })]
    const adj = adjustLeases(new Map([[MON, recs]]), new Map([[MON, walnutApp(10, 0, 10)]]), HOSTS)
    expect(adj.reading.map((r) => [r.taskId, (r.endMs - r.startMs) / MIN])).toEqual([['t_a', 4], ['t_b', 4]])
  })

  it('never crosses a switch to another app: Walnut back in front later is not reading', () => {
    const rec = lease(10, 0, 1)
    const outside = [...slack(10, 1, 3), ...walnutApp(10, 4, 5)]
    const adj = adjustLeases(new Map([[MON, [rec]]]), new Map([[MON, outside]]), HOSTS)
    expect(adj.reading).toEqual([])
  })

  it('no sampler, no correction', () => {
    const rec = lease(10, 0, 1)
    expect(adjustLeases(new Map([[MON, [rec]]]), undefined, HOSTS)).toMatchObject({ reading: [], other: [] })
  })
})

describe('buildTimeReport with the corrections', () => {
  it('walnutMin drops the overlap, attention adds reading, and the parts add up', () => {
    const records = new Map([[MON, [lease(10, 0, 2), lease(11, 0, 1, { taskId: 't_b' })]]])
    const outside = new Map([[MON, [...slack(10, 1, 5), ...walnutApp(11, 0, 4)]]])
    const r = buildTimeReport({ records, outside, tasks }, opts()) as any
    expect(r.totals.wholeDay).toMatchObject({ walnutMin: 2, overlapMin: 1, readingMin: 3, outsideMin: 5, attentionMin: 10, walnutForegroundMin: 4 })
    expect(r.days[0]).toMatchObject({ walnutMin: 2, overlapMin: 1, readingMin: 3, attentionMin: 10 })
    const beta = r.groups.task.rows.find((t: any) => t.taskId === 't_b')
    expect(beta).toMatchObject({ min: 1, readingMin: 3 })
  })

  it('the phone counts by default kinds, and app (a plugin view) is a default kind', () => {
    expect(REPORT_DEFAULTS.kinds).toEqual(['session', 'triage', 'chat', 'app'])
    const records = new Map([[MON, [lease(10, 0, 3, { kind: 'app', taskId: undefined, app: 'chatapp' })]]])
    const r = buildTimeReport({ records, tasks }, opts({ includeOutside: false })) as any
    expect(r.totals.wholeDay.walnutMin).toBe(3)
    expect(r.totals.byKind.app).toBe(3)
  })

  it('a message marked twice counts once', () => {
    const detail = new Map<string, DetailLine[]>([[MON, [
      { t: 'sent', ts: iso(10, 1), messageId: 'qm-1', chars: 40, device: 'web' },
      { t: 'sent', ts: iso(10, 1), messageId: 'qm-1', chars: 40, device: 'web' },
    ]]])
    const r = buildTimeReport({ records: new Map(), tasks, detail }, opts()) as any
    expect(r.totals.wholeDay.sent).toBe(1)
  })

  it('calls are their own number per day and in total, cut at the day edges', () => {
    const calls = [
      { app: 'zoom.us', startMs: at(11, 0), endMs: at(12, 0) },
      { app: 'zoom.us', startMs: at(11, 30), endMs: at(12, 30) }, // overlaps: counted once
      { app: 'FaceTime', startMs: new Date(2026, 9, 4, 23, 30).getTime(), endMs: at(0, 15) }, // across midnight
    ]
    const r = buildTimeReport({ records: new Map([[MON, []]]), tasks, calls }, opts()) as any
    expect(r.days[0]).toMatchObject({ callMin: 105, callWorkMin: 90 })
    expect(r.totals.wholeDay.callMin).toBe(105)
    expect(r.totals.workHours.callMin).toBe(90)
  })

  it('groups by session view; records from before views count as unknown', () => {
    const records = new Map([[MON, [
      lease(10, 0, 3, { view: 'chat' }), lease(10, 3, 2, { view: 'files' }), lease(10, 5, 1),
      lease(10, 6, 1, { kind: 'triage' }), lease(10, 7, 2, { kind: 'app', taskId: undefined, app: 'chatapp' }),
    ]]])
    const r = buildTimeReport({ records, tasks }, opts({ includeOutside: false })) as any
    expect(r.groups.view.rows.map((v: any) => [v.view, v.min])).toEqual([['chat', 3], ['files', 2], ['app:chatapp', 2], ['unknown', 1], ['triage', 1]])
  })

  it('groups files and plugin items from the local detail, cut like leases, and counts sent messages', () => {
    const detail = new Map<string, DetailLine[]>([[MON, [
      { t: 'lease', ts: iso(10, 0), durationMs: 2 * MIN, kind: 'session', sessionId: 's1', taskId: 't_a', view: 'files', file: 'src/a.ts' },
      { t: 'lease', ts: iso(10, 5), durationMs: 1 * MIN, kind: 'session', sessionId: 's1', taskId: 't_a', view: 'files', file: 'src/b.ts' },
      { t: 'lease', ts: iso(11, 0), durationMs: 3 * MIN, kind: 'app', app: 'chatapp', item: 'C1', label: '#general' },
      { t: 'lease', ts: iso(11, 3), durationMs: 1 * MIN, kind: 'app', app: 'chatapp', item: 'C1', label: '#general', mode: 'reply' },
      { t: 'sent', ts: iso(10, 1), sessionId: 's1', taskId: 't_a', messageId: 'qm-1', chars: 40, device: 'web' },
      { t: 'sent', ts: iso(10, 2), messageId: 'qm-2', chars: 10, device: 'ios', chat: true },
    ]]])
    const records = new Map([[MON, [lease(10, 0, 3)]]])
    const outside = new Map([[MON, slack(10, 1, 1)]]) // 10:01-10:02 Slack in front: cut from src/a.ts
    const r = buildTimeReport({ records, outside, tasks, detail }, opts()) as any
    expect(r.groups.file.rows.map((f: any) => [f.file, f.min, f.taskId])).toEqual([['src/a.ts', 1, 't_a'], ['src/b.ts', 1, 't_a']])
    expect(r.groups.item.rows).toEqual([expect.objectContaining({ app: 'chatapp', item: 'C1', label: '#general', min: 4, replyMin: 1 })])
    expect(r.days[0].sent).toEqual({ count: 2, chars: 50 })
    expect(r.totals.wholeDay.sent).toBe(2)
    expect(r.groups.task.rows.find((t: any) => t.taskId === 't_a')).toMatchObject({ sent: 1 })
  })

  it('without the Mac-local detail the file group says so', () => {
    const r = buildTimeReport({ records: new Map([[MON, []]]), tasks }, opts({ includeOutside: false })) as any
    expect(r.groups.file).toMatchObject({ rows: [], unavailable: expect.any(String) })
  })
})
