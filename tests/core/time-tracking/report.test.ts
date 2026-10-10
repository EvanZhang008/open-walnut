/**
 * The time report fold: two views (whole day, work hours), task/project/app joins,
 * the outside sampler with Walnut's own foreground kept out, agent time apart,
 * compacted days, and fragmentation. Local wall-clock timestamps throughout.
 */

import { describe, expect, it } from 'vitest'
import { buildTimeReport, REPORT_DEFAULTS, type ReportOptions } from '../../../src/core/time-tracking/report.js'
import { DEFAULT_WORK_HOURS } from '../../../src/core/time-tracking/work-hours.js'
import type { OutsideRecord } from '../../../src/core/time-tracking/outside-store.js'
import type { TimeRecord } from '../../../src/core/time-tracking/types.js'

const MON = '2026-10-05'
const SAT = '2026-10-10'
const MIN = 60_000
const iso = (day: number, h: number, m = 0, s = 0): string => new Date(2026, 9, day, h, m, s).toISOString()

/** `n` back-to-back one-minute leases on one task from a local start. */
function leases(date: string, day: number, h: number, m: number, n: number, taskId: string, over: Partial<TimeRecord> = {}): TimeRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    date, ts: iso(day, h, m + i), durationMs: MIN, kind: 'session' as const, taskId, ...over,
  }))
}

function opts(over: Partial<ReportOptions> = {}): ReportOptions {
  return {
    ...REPORT_DEFAULTS,
    dates: [MON],
    workHours: DEFAULT_WORK_HOURS,
    workHoursSource: 'default',
    groupBy: ['task', 'project', 'hour', 'kind', 'app', 'host'],
    includeOutside: true,
    walnutHosts: ['localhost', '127.0.0.1'],
    ...over,
  }
}

const tasks = new Map([
  ['t_marina', { title: 'Marina design', project: 'Marina', createdAt: '2026-09-20T10:00:00.000Z' }],
  ['t_ops', { title: 'Ops ticket', project: 'Ops', createdAt: `${MON}T17:00:00.000Z`, source: 'tracker' }],
])

describe('buildTimeReport', () => {
  it('splits every number into the whole day and work hours, and joins titles and projects', () => {
    const records = new Map([[MON, [
      ...leases(MON, 5, 10, 0, 60, 't_marina'), // 10:00-11:00, all inside work hours
      ...leases(MON, 5, 19, 0, 30, 't_marina'), // evening
      ...leases(MON, 5, 17, 50, 20, 't_ops'), // 17:50-18:10: 10 in, 10 out
    ]]])
    const r = buildTimeReport({ records, tasks }, opts({ includeOutside: false })) as any
    expect(r.totals.denominator).toBe('walnut')
    expect(r.totals.wholeDay.walnutMin).toBe(110)
    expect(r.totals.workHours.walnutMin).toBe(70)
    expect(r.totals.offHours.walnutMin).toBe(40)
    const marina = r.groups.task.rows.find((t: any) => t.taskId === 't_marina')
    expect(marina).toMatchObject({ title: 'Marina design', project: 'Marina', min: 90, workMin: 60, offMin: 30, createdBeforeRange: true })
    expect(marina.source).toBeUndefined()
    expect(marina.workShare).toBeCloseTo(60 / 70, 2)
    expect(r.groups.task.rows.find((t: any) => t.taskId === 't_ops')).toMatchObject({ min: 20, workMin: 10, createdBeforeRange: false, source: 'tracker' })
    expect(r.groups.project.rows.map((p: any) => p.project)).toEqual(['Marina', 'Ops'])
    expect(r.days[0]).toMatchObject({ date: MON, weekday: 'mon', workday: true, walnutMin: 110, workMin: 70, offMin: 40 })
    expect(r.workHours).toMatchObject({ start: '09:00', end: '18:00', label: '09:00-18:00 Mon-Fri', source: 'default' })
  })

  it('keeps agent time apart and never in attention, unless asked for as a kind', () => {
    const records = new Map([[MON, [
      ...leases(MON, 5, 10, 0, 10, 't_marina'),
      { date: MON, ts: iso(5, 11), durationMs: 120 * MIN, kind: 'agent' as const, taskId: 't_marina' },
    ]]])
    const r = buildTimeReport({ records, tasks }, opts({ includeOutside: false })) as any
    expect(r.totals.wholeDay).toMatchObject({ walnutMin: 10, agentMin: 120 })
    expect(r.groups.task.rows[0]).toMatchObject({ taskId: 't_marina', min: 10, agentMin: 120 })
    const withAgent = buildTimeReport({ records, tasks }, opts({ includeOutside: false, kinds: ['session', 'agent'] })) as any
    expect(withAgent.totals.wholeDay.walnutMin).toBe(130)
  })

  it('adds the outside sampler to attention, leaves Walnut\'s own foreground out, and groups apps and sites', () => {
    const records = new Map([[MON, leases(MON, 5, 10, 0, 30, 't_marina')]])
    const out = (h: number, m: number, mins: number, app: string, bundleId: string, host?: string): OutsideRecord => ({
      date: MON, ts: iso(5, h, m), durationMs: mins * MIN, app, bundleId, ...(host ? { host } : {}),
    })
    const outside = new Map([[MON, [
      out(9, 0, 40, 'Slack', 'com.tinyspeck.slackmacgap'),
      out(18, 30, 20, 'Slack', 'com.tinyspeck.slackmacgap'),
      out(11, 0, 15, 'Google Chrome', 'com.google.Chrome', 'docs.example.com'),
      out(11, 15, 25, 'Google Chrome', 'com.google.Chrome', 'localhost'), // Walnut in a browser
      out(12, 0, 30, 'Walnut', 'com.local.walnut-desktop'), // the desktop app
    ]]])
    const r = buildTimeReport({ records, outside, tasks }, opts()) as any
    expect(r.totals.denominator).toBe('attention')
    expect(r.totals.wholeDay).toMatchObject({ walnutMin: 30, outsideMin: 75, attentionMin: 105, walnutForegroundMin: 55 })
    expect(r.totals.workHours).toMatchObject({ walnutMin: 30, outsideMin: 55, attentionMin: 85 })
    const slack = r.groups.app.rows.find((a: any) => a.app === 'Slack')
    expect(slack).toMatchObject({ min: 60, workMin: 40, offMin: 20 })
    const chrome = r.groups.app.rows.find((a: any) => a.app === 'Google Chrome')
    expect(chrome.min).toBe(15)
    expect(chrome.topHosts).toEqual([{ host: 'docs.example.com', min: 15, workMin: 15 }])
    expect(r.groups.host.rows).toEqual([expect.objectContaining({ host: 'docs.example.com', min: 15 })])
    expect(r.days[0].outside).toMatchObject({ min: 75, workMin: 55, walnutForegroundMin: 55 })
    expect(r.days[0]).toMatchObject({ attentionMin: 105, attentionWorkMin: 85 })
  })

  it('a weekend day has no work-hours minutes', () => {
    const records = new Map([[SAT, leases(SAT, 10, 10, 0, 30, 't_marina')]])
    const r = buildTimeReport({ records, tasks }, opts({ dates: [SAT], includeOutside: false })) as any
    expect(r.days[0]).toMatchObject({ workday: false, walnutMin: 30, workMin: 0, offMin: 30 })
  })

  it('counts a compacted day in the totals but places none of it in an hour or in work hours', () => {
    const records = new Map([[MON, [{ date: MON, ts: `${MON}T00:00:00.000Z`, durationMs: 90 * MIN, kind: 'session' as const, taskId: 't_marina' }]]])
    const r = buildTimeReport({ records, tasks }, opts({ includeOutside: false })) as any
    expect(r.days[0]).toMatchObject({ walnutMin: 90, workMin: 0, offMin: 0, unplacedMin: 90 })
    expect(r.totals.wholeDay.unplacedMin).toBe(90)
    expect(r.groups.hour).toEqual([])
  })

  it('measures fragmentation: switches ignore glances, a stretch breaks on another task or a long gap', () => {
    const records = new Map([[MON, [
      ...leases(MON, 5, 9, 0, 50, 't_marina'), // 09:00-09:50, one 50-min stretch
      { date: MON, ts: iso(5, 9, 50), durationMs: 5_000, kind: 'session' as const, taskId: 't_ops' }, // a glance
      ...leases(MON, 5, 9, 51, 9, 't_marina'), // back on Marina; the glance still breaks the stretch
      ...leases(MON, 5, 11, 0, 20, 't_ops'),
      ...leases(MON, 5, 11, 30, 10, 't_ops'), // 10-min gap > 5 min merge gap: a new stretch
    ]]])
    const r = buildTimeReport({ records, tasks }, opts({ includeOutside: false })) as any
    const f = r.days[0].fragmentation
    expect(f.tasks).toBe(2)
    expect(f.switches).toBe(1) // marina to ops; the 5-second glance is not a switch
    expect(f.longest).toMatchObject({ min: 50, taskId: 't_marina' })
    expect(f.deepMin).toBe(50)
    expect(r.fragmentation.longest).toMatchObject({ min: 50, title: 'Marina design' })
    expect(r.fragmentation.rules).toEqual({ mergeGapMin: 5, longMin: 45, glanceSec: 10 })
  })

  it('names time with no task and a task that no longer exists, instead of dropping them', () => {
    const records = new Map([[MON, [
      { date: MON, ts: iso(5, 10), durationMs: 5 * MIN, kind: 'chat' as const },
      ...leases(MON, 5, 11, 0, 5, 't_gone'),
    ]]])
    const r = buildTimeReport({ records, tasks }, opts({ includeOutside: false })) as any
    const rows = r.groups.task.rows
    expect(rows.find((t: any) => t.taskId === '')).toMatchObject({ min: 5 })
    expect(rows.find((t: any) => t.taskId === 't_gone')).toMatchObject({ title: null, missing: true, min: 5 })
    expect(r.groups.project.rows.map((p: any) => p.project).sort()).toEqual(['(deleted or unknown task)', '(no task)'])
  })

  it('cuts each group at `top` and sums the rest', () => {
    const records = new Map([[MON, Array.from({ length: 6 }, (_, i) => leases(MON, 5, 10 + i, 0, 10 - i, `t_${i}`)).flat()]])
    const r = buildTimeReport({ records, tasks: new Map() }, opts({ includeOutside: false, top: 2 })) as any
    expect(r.groups.task.rows.map((t: any) => t.min)).toEqual([10, 9])
    expect(r.groups.task).toMatchObject({ otherMin: 8 + 7 + 6 + 5, more: 4 })
  })
})
