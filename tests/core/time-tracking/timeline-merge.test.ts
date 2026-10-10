/**
 * The day timeline merge (pure): which source wins a minute, how screen time is
 * joined, what a gap says, and how a calendar block is checked against what
 * happened. Local wall-clock times so it passes in any zone.
 */

import { describe, expect, it } from 'vitest'
import { dayBoundsMs } from '../../../src/core/time-tracking/blocks.js'
import { mergeDay, titleTokens } from '../../../src/core/time-tracking/timeline/merge.js'
import type { SourcedSegment } from '../../../src/core/time-tracking/timeline/types.js'
import { DEFAULT_WORK_HOURS } from '../../../src/core/time-tracking/work-hours.js'
import { systemTz } from '../../../src/core/health/day-key.js'

const TZ = systemTz()
const MON = '2026-10-05'
const SAT = '2026-10-10'
const day = (date: string) => ({ date, ...dayBoundsMs(date)! })
const t = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m).getTime()
const END_OF_DAY = t(6, 0)

const PRIORITY: Record<string, number> = { walnut: 100, 'mac-apps': 90, sleep: 70, workouts: 60, calendar: 50, places: 0 }

function seg(source: string, kind: string, label: string, startMs: number, endMs: number, over: Partial<SourcedSegment> = {}): SourcedSegment {
  return {
    startMs, endMs, kind, label, source, priority: PRIORITY[source] ?? 40,
    confidence: source === 'calendar' ? 'planned' : 'measured',
    lane: source === 'places' ? 'place' : 'activity',
    ...over,
  }
}
const walnut = (taskId: string, title: string, a: number, b: number) => seg('walnut', 'walnut', title, a, b, { detail: { taskId } })
const merge = (date: string, segs: SourcedSegment[], nowMs = END_OF_DAY) =>
  mergeDay(day(date), segs, { tz: TZ, workHours: DEFAULT_WORK_HOURS, nowMs })
const real = (blocks: Array<{ kind: string }>) => blocks.filter((b) => b.kind !== 'gap')

describe('mergeDay', () => {
  it('gives each minute to the higher priority: sleep beats a workout the watch kept recording', () => {
    const out = merge(MON, [
      seg('sleep', 'sleep', 'Asleep', t(5, 1, 30), t(5, 8)),
      seg('workouts', 'workout', 'Pickleball', t(4, 20, 41), t(5, 8, 11), { flags: ['overlaps sleep: the watch was probably left running'] }),
    ])
    expect(real(out.blocks).map((b) => [b.kind, b.min])).toEqual([['workout', 90], ['sleep', 390], ['workout', 11]])
    expect(out.blocks[0]!.start).toContain('T00:00')
    expect(out.blocks[0]!.flags).toEqual(['overlaps sleep: the watch was probably left running'])
    expect(out.blocks.at(-1)).toMatchObject({ kind: 'gap', label: 'nothing recorded', confidence: 'inferred' })
  })

  it('joins screen time across short gaps, lists what was inside, and the meeting it sat through', () => {
    const out = merge(MON, [
      walnut('t1', 'Marina rollout checklist', t(5, 10), t(5, 10, 20)),
      seg('mac-apps', 'app', 'Zoom', t(5, 10, 25), t(5, 10, 55)),
      seg('calendar', 'meeting', 'Team standup', t(5, 10, 30), t(5, 10, 50)),
    ])
    const blocks = real(out.blocks)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'screen', min: 55, trackedMin: 50, source: 'walnut+mac-apps', during: ['Team standup'],
      top: [{ kind: 'app', label: 'Zoom', min: 30 }, { kind: 'walnut', label: 'Marina rollout checklist', min: 20, taskId: 't1' }],
    })
    expect(out.plan).toEqual([expect.objectContaining({ title: 'Team standup', kind: 'meeting', min: 20, screenMin: 20, verdict: 'meeting_on_screen' })])
  })

  it('says where the user was in a gap, and calls a gap between two places travel (inferred)', () => {
    const out = merge(MON, [
      seg('places', 'place', 'Office', t(5, 8), t(5, 10, 30)),
      seg('places', 'travel', 'Office -> Home', t(5, 10, 30), t(5, 11, 30), { confidence: 'inferred' }),
      walnut('t1', 'Marina rollout checklist', t(5, 9), t(5, 9, 30)),
      walnut('t1', 'Marina rollout checklist', t(5, 10), t(5, 10, 30)),
      walnut('t2', 'Evening reading', t(5, 11, 30), t(5, 12)),
      walnut('t2', 'Evening reading', t(5, 19), t(5, 19, 30)),
    ])
    const between = out.blocks.filter((b) => b.kind === 'gap' && b.start.includes('T09:30'))
    expect(between).toEqual([expect.objectContaining({ min: 30, label: 'away from the Mac (at Office)', place: 'Office' })])
    const commute = out.blocks.find((b) => b.kind === 'gap' && b.start.includes('T10:30'))
    expect(commute).toMatchObject({ min: 60, label: 'travel? Office -> Home' })
    expect(out.blocks.find((b) => b.kind === 'screen' && b.start.includes('T09:00'))?.place).toBe('Office')
    expect(out.summary.byPlaceMin).toEqual({ Office: 150, 'travel (inferred)': 60 })
    expect(out.summary.wholeDay).toMatchObject({ screenMin: 120, walnutMin: 120 })
    expect(out.summary.workHours).toMatchObject({ screenMin: 90 })
    expect(out.places.map((p) => p.label)).toEqual(['Office', 'Office -> Home'])
  })

  it('checks each planned block: kept, partly (by task id in the title), not on screen, other work', () => {
    const out = merge(MON, [
      seg('calendar', 'plan', 'Marina rollout plan', t(5, 14), t(5, 15)),
      walnut('t1', 'Marina rollout checklist', t(5, 14), t(5, 14, 40)),
      seg('calendar', 'plan', 'Finish abcd1234-5678', t(5, 16), t(5, 17)),
      walnut('abcd1234-5678', 'Other title', t(5, 16), t(5, 16, 20)),
      seg('calendar', 'plan', 'Gym', t(5, 18), t(5, 19)),
      seg('calendar', 'plan', 'Read paper', t(5, 20), t(5, 21)),
      walnut('t3', 'Unrelated thing', t(5, 20), t(5, 20, 40)),
      seg('calendar', 'plan', 'Short hold', t(5, 22), t(5, 22, 5)),
    ])
    const byTitle = Object.fromEntries(out.plan.map((p) => [p.title, p]))
    expect(byTitle['Marina rollout plan']).toMatchObject({ verdict: 'kept', matched: { taskId: 't1', minInBlock: 40, by: 'title' } })
    expect(byTitle['Finish abcd1234-5678']).toMatchObject({ verdict: 'partly', matched: { taskId: 'abcd1234-5678', minInBlock: 20, by: 'id' } })
    expect(byTitle.Gym).toMatchObject({ verdict: 'not_on_screen', screenMin: 0 })
    expect(byTitle['Read paper']).toMatchObject({ verdict: 'other_work', screenMin: 40 })
    expect(byTitle['Read paper']!.matched).toBeUndefined()
    expect(byTitle['Short hold']).toBeUndefined()
    // The plan block nobody was on screen for is still on the timeline, as planned.
    expect(out.blocks.find((b) => b.label === 'Gym')).toMatchObject({ kind: 'plan', confidence: 'planned', min: 60 })
    // Off-screen remainders: 20 (rollout) + 40 (finish) + 60 (gym) + 20 (paper) + 5 (hold).
    expect(out.summary.wholeDay).toMatchObject({ plannedNotOnScreenMin: 145 })
  })

  it('matches a planned block to its task on short names and CJK words too', () => {
    // Test data: "\u6536\u53e3" and "\u8bbe\u8ba1\u6587\u6863" are CJK words (escaped on purpose).
    const out = merge(MON, [
      seg('calendar', 'plan', '\u2605CIS Design 1 \u6536\u53e3: ship the commit', t(5, 11), t(5, 12)),
      walnut('t9', 'Feedback on CIS Design 1', t(5, 11), t(5, 11, 40)),
      // Shares more words with the block, but had only 5 minutes in it.
      walnut('t7', 'CIS Design 1 commit data', t(5, 11, 40), t(5, 11, 45)),
      seg('calendar', 'plan', '\u5199\u8bbe\u8ba1\u6587\u6863', t(5, 15), t(5, 16)),
      walnut('t8', '\u8bbe\u8ba1\u6587\u6863 draft', t(5, 15), t(5, 15, 50)),
    ])
    const [cis, cjk] = out.plan
    expect(cis).toMatchObject({ verdict: 'kept', matched: { taskId: 't9', by: 'title', minInBlock: 40 } })
    expect(cjk).toMatchObject({ verdict: 'kept', matched: { taskId: 't8', by: 'title' } })
  })

  it('reads title words: 3+ letters, short all-caps names, CJK pairs, no filler', () => {
    expect([...titleTokens('EKS Q4 plan for the API run, TBD')].sort()).toEqual(['api', 'eks', 'plan', 'q4', 'run'])
    expect([...titleTokens('\u5199\u8bbe\u8ba1')]).toEqual(['\u5199\u8bbe', '\u8bbe\u8ba1'])
    expect([...titleTokens('a b 1 x')]).toEqual([])
  })

  it('counts a room booking that repeats a meeting once', () => {
    const out = merge(MON, [
      seg('calendar', 'meeting', 'Design sync', t(5, 13), t(5, 14)),
      seg('calendar', 'meeting', 'Design sync (Room 4)', t(5, 13), t(5, 14)),
    ])
    expect(out.plan.map((p) => p.title)).toEqual(['Design sync'])
  })

  it('cuts today at now: nothing after it, and the day says it is partial', () => {
    const out = merge(MON, [
      walnut('t1', 'Marina rollout checklist', t(5, 10), t(5, 10, 30)),
      seg('calendar', 'plan', 'Later block', t(5, 15), t(5, 16)),
    ], t(5, 12))
    expect(out.partial).toBe(true)
    expect(out.blocks.at(-1)).toMatchObject({ kind: 'gap', min: 90 })
    expect(out.blocks.at(-1)!.end).toContain('T12:00')
    expect(out.plan).toEqual([])
  })

  it('a weekend day has only the whole-day view', () => {
    const out = merge(SAT, [walnut('t1', 'Marina rollout checklist', t(10, 10), t(10, 11))], t(11, 0))
    expect(out).toMatchObject({ weekday: 'sat', workday: false })
    expect(out.summary.wholeDay).toMatchObject({ walnutMin: 60 })
    expect(out.summary.workHours).toBeUndefined()
  })
})
