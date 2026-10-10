/**
 * Meeting attendance from calls (the user's rule, all their meetings run on a
 * call): a call means attended, minus other work during it; no call means not
 * attended when it is a recurring meeting never on a call or other work filled
 * it, and needs confirmation when nothing was recorded; no call data means
 * unknown. The user's own answer wins and is kept on this Mac.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-meetings'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { dayBoundsMs } from '../../../src/core/time-tracking/blocks.js'
import { mergeDay } from '../../../src/core/time-tracking/timeline/merge.js'
import {
  callsIn, EMPTY_MEETING_CONTEXT, meetingAttendance, seriesIdOf, seriesNeverOnCall, settleDoubleBooked,
  type MeetingContext, type MeetingFacts,
} from '../../../src/core/time-tracking/timeline/meetings.js'
import { ignoreList, loadMeetingContext, readMeetingAnswers, setMeetingAnswer } from '../../../src/core/time-tracking/timeline/meeting-context.js'
import { appendCallLines, callLine, coverageLines, resetCallsStore } from '../../../src/core/time-tracking/calls-store.js'
import type { SourcedSegment, TimelineRange, TimelineSourceResult } from '../../../src/core/time-tracking/timeline/types.js'
import { DEFAULT_WORK_HOURS } from '../../../src/core/time-tracking/work-hours.js'
import { systemTz } from '../../../src/core/health/day-key.js'

const MIN = 60_000
const t = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m).getTime()
const WATCHED: Array<[number, number]> = [[t(1, 0), t(12, 0)]]
const ctx = (over: Partial<MeetingContext> = {}): MeetingContext => ({ ...EMPTY_MEETING_CONTEXT, coverage: WATCHED, ...over })
const meeting = (over: Partial<MeetingFacts> = {}): MeetingFacts => ({
  startMs: t(5, 11), endMs: t(5, 12), title: 'Design review', eventId: 'E1', otherWork: [], ...over,
})

describe('meetingAttendance', () => {
  it('a call in the meeting: attended, meeting time = the call minus other work during it', () => {
    const a = meetingAttendance(meeting({ otherWork: [[t(5, 11, 40), t(5, 11, 50)]] }), ctx({ calls: [[t(5, 11, 2), t(5, 11, 55)]] }))
    expect(a).toEqual({
      attendance: 'attended', basis: 'call', callMs: 53 * MIN, meetingMs: 43 * MIN, otherWorkMs: 10 * MIN,
      spans: [[t(5, 11, 2), t(5, 11, 55)]],
      counted: [[t(5, 11, 2), t(5, 11, 40)], [t(5, 11, 50), t(5, 11, 55)]],
    })
  })

  it('a call that only ran over from the meeting before is not this meeting', () => {
    expect(callsIn(t(5, 11), t(5, 12), [[t(5, 10), t(5, 11, 5)]])).toEqual([])
    const a = meetingAttendance(meeting({ otherWork: [[t(5, 11, 5), t(5, 11, 55)]] }), ctx({ calls: [[t(5, 10), t(5, 11, 5)]] }))
    expect(a).toMatchObject({ attendance: 'not_attended', basis: 'other_work', meetingMs: 0 })
  })

  it('no call, a recurring meeting never on a call: not attended', () => {
    const a = meetingAttendance(meeting({ recurring: true, seriesId: 'S1' }), ctx({ neverOnCall: new Set(['S1']) }))
    expect(a).toMatchObject({ attendance: 'not_attended', basis: 'recurring_never_on_call', meetingMs: 0 })
  })

  it('no call, other work on screen for at least half of it: not attended, the time is that work\'s', () => {
    expect(meetingAttendance(meeting({ otherWork: [[t(5, 11), t(5, 11, 20)], [t(5, 11, 30), t(5, 11, 40)]] }), ctx()))
      .toMatchObject({ attendance: 'not_attended', basis: 'other_work' })
    // 25 of 60 minutes is not half: the user's to say, and the basis says some work was seen.
    expect(meetingAttendance(meeting({ otherWork: [[t(5, 11), t(5, 11, 25)]] }), ctx()))
      .toMatchObject({ attendance: 'needs_confirmation', basis: 'some_other_work', meetingMs: 0 })
  })

  it('no call and nothing recorded: needs confirmation, never counted', () => {
    expect(meetingAttendance(meeting({ otherWork: [[t(5, 11), t(5, 11, 5)]] }), ctx())).toEqual({
      attendance: 'needs_confirmation', basis: 'nothing_recorded', callMs: 0, meetingMs: 0, otherWorkMs: 0, spans: [], counted: [],
    })
  })


  it('outside call coverage "no call" proves nothing: unknown', () => {
    expect(meetingAttendance(meeting(), ctx({ coverage: [] }))).toMatchObject({ attendance: 'unknown', basis: 'no_call_data' })
  })

  it('the user\'s answer wins either way', () => {
    const yes = meetingAttendance(meeting({ otherWork: [[t(5, 11), t(5, 11, 15)]] }), ctx({ answers: new Map([['E1', true]]) }))
    expect(yes).toMatchObject({ attendance: 'attended', basis: 'user', meetingMs: 45 * MIN, spans: [[t(5, 11), t(5, 12)]] })
    const no = meetingAttendance(meeting(), ctx({ calls: [[t(5, 11), t(5, 12)]], answers: new Map([['E1', false]]) }))
    expect(no).toMatchObject({ attendance: 'not_attended', basis: 'user', meetingMs: 0 })
  })
})

describe('settleDoubleBooked', () => {
  const CALL: Array<[number, number]> = [[t(5, 11, 2), t(5, 11, 55)]]
  const entry = (eventId: string, answers: Map<string, boolean> = new Map()) => {
    const facts = meeting({ eventId })
    return { attendance: meetingAttendance(facts, ctx({ calls: CALL, answers })), inCall: callsIn(facts.startMs, facts.endMs, CALL) }
  }

  it('one call under two meetings at once: both go back to the user, the call stays meeting time', () => {
    const [a, b] = settleDoubleBooked([entry('A'), entry('B')])
    for (const m of [a!, b!]) {
      expect(m.attendance).toMatchObject({ attendance: 'needs_confirmation', basis: 'double_booked', meetingMs: 0, callMs: 53 * MIN })
      expect(m.attendance.counted).toEqual(CALL)
      expect(m.attendance.spans).toEqual(CALL)
    }
  })

  it('the user said one was attended: the call was that one, the other is not attended', () => {
    const yes = new Map([['A', true]])
    const [a, b] = settleDoubleBooked([entry('A', yes), entry('B', yes)])
    expect(a!.attendance).toMatchObject({ attendance: 'attended', basis: 'user', meetingMs: 53 * MIN })
    expect(b!.attendance).toMatchObject({ attendance: 'not_attended', basis: 'double_booked', meetingMs: 0, spans: [], counted: [] })
  })

  it('the user said one was NOT attended: the call is the other one\'s', () => {
    const no = new Map([['A', false]])
    const [a, b] = settleDoubleBooked([entry('A', no), entry('B', no)])
    expect(a!.attendance).toMatchObject({ attendance: 'not_attended', basis: 'user' })
    expect(b!.attendance).toMatchObject({ attendance: 'attended', basis: 'call', meetingMs: 53 * MIN })
  })

  it('two meetings with their own calls are not double booked', () => {
    const one = { attendance: meetingAttendance(meeting({ eventId: 'A' }), ctx({ calls: [[t(5, 11), t(5, 11, 30)]] })), inCall: [[t(5, 11), t(5, 11, 30)]] as Array<[number, number]> }
    const two = { attendance: meetingAttendance(meeting({ eventId: 'B' }), ctx({ calls: [[t(5, 11, 30), t(5, 12)]] })), inCall: [[t(5, 11, 30), t(5, 12)]] as Array<[number, number]> }
    settleDoubleBooked([one, two])
    expect([one.attendance.basis, two.attendance.basis]).toEqual(['call', 'call'])
  })
})

describe('seriesNeverOnCall', () => {
  const occ = (seriesId: string, d: number, h = 9) => ({ seriesId, startMs: t(d, h), endMs: t(d, h, 30) })
  it('needs two watched occurrences, none on a call', () => {
    const calls: Array<[number, number]> = [[t(6, 9), t(6, 9, 30)]]
    const out = seriesNeverOnCall([occ('A', 5), occ('A', 6), occ('B', 5, 14), occ('B', 6, 14), occ('C', 5, 15)], calls, WATCHED)
    // A had a call on the 6th, C was seen once: only B is "never".
    expect([...out]).toEqual(['B'])
  })
  it('occurrences outside coverage do not count, and an "attended" answer clears the series', () => {
    expect([...seriesNeverOnCall([occ('B', 13), occ('B', 14)], [], WATCHED)]).toEqual([])
    expect([...seriesNeverOnCall([occ('B', 5), occ('B', 6)], [], WATCHED, new Set(['B']))]).toEqual([])
  })
  it('a series id is the occurrence id before its #', () => {
    expect(seriesIdOf('AAA:BBB#1791309600')).toBe('AAA:BBB')
    expect(seriesIdOf('AAA:BBB')).toBe('AAA:BBB')
  })
})

describe('mergeDay with calls', () => {
  const TZ = systemTz()
  const MON = '2026-10-05'
  const P: Record<string, number> = { walnut: 100, 'mac-apps': 90, calls: 85, calendar: 50 }
  const seg = (source: string, kind: string, label: string, a: number, b: number, over: Partial<SourcedSegment> = {}): SourcedSegment => ({
    startMs: a, endMs: b, kind, label, source, priority: P[source] ?? 40,
    confidence: source === 'calendar' ? 'planned' : 'measured', lane: 'activity', ...over,
  })
  const cal = (title: string, a: number, b: number, eventId: string, over: Record<string, string | boolean> = {}) =>
    seg('calendar', 'meeting', title, a, b, { detail: { eventId, ...over } })
  const merge = (segs: SourcedSegment[], meetings?: MeetingContext) =>
    mergeDay({ date: MON, ...dayBoundsMs(MON)! }, segs, { tz: TZ, workHours: DEFAULT_WORK_HOURS, nowMs: t(6, 0), ...(meetings ? { meetings } : {}) })

  it('checks each meeting against the call, lists what needs the user, and counts ad-hoc calls', () => {
    const out = merge([
      cal('Planning', t(5, 10), t(5, 11), 'E-plan'),
      seg('calls', 'call', 'Zoom call', t(5, 10, 1), t(5, 10, 58)),
      seg('walnut', 'walnut', 'Alpha', t(5, 10, 30), t(5, 10, 40), { detail: { taskId: 't_a' } }),
      cal('Team sync', t(5, 14), t(5, 14, 30), 'E-sync'),
      seg('calls', 'call', 'Zoom call', t(5, 16), t(5, 16, 20)), // no meeting: ad hoc
    ], ctx())
    const plan = Object.fromEntries(out.plan.map((p) => [p.title, p]))
    expect(plan['Planning']).toMatchObject({ attendance: 'attended', attendanceBasis: 'call', callMin: 57, attendedMin: 57, meetingMin: 47, otherWorkMin: 10, eventId: 'E-plan' })
    expect(plan['Team sync']).not.toHaveProperty('attendedMin')
    expect(plan['Team sync']).toMatchObject({ attendance: 'needs_confirmation', attendanceBasis: 'nothing_recorded', meetingMin: 0 })
    expect(out.summary).toMatchObject({
      // In the meeting 57 min; 47 of them with nothing else on screen.
      callMin: 77, adHocCallMin: 20, attendedMeetingMin: 57, meetingMin: 47,
      meetings: { attended: 1, not_attended: 0, needs_confirmation: 1, unknown: 0 },
      needsConfirmation: [expect.objectContaining({ title: 'Team sync', basis: 'nothing_recorded', eventId: 'E-sync' })],
    })
    // The call the Mac heard while nothing was on screen shows as its own block.
    expect(out.blocks.find((b) => b.kind === 'call')).toMatchObject({ label: 'Zoom call', source: 'calls' })
    expect((out.summary.wholeDay as Record<string, number>).callOffScreenMin).toBeGreaterThan(0)
  })

  it('overlapping meetings count each call second once; one call under two meetings needs the user', () => {
    // A 10:00-11:00 and B 10:30-11:30 with two calls: each meeting has its own, not double booked
    // (the 10:00 call only runs ten minutes into B, so it stays A's).
    const out = merge([
      cal('Alpha review', t(5, 10), t(5, 11), 'E-a'),
      cal('Beta review', t(5, 10, 30), t(5, 11, 30), 'E-b'),
      seg('calls', 'call', 'Zoom call', t(5, 10), t(5, 10, 40)),
      seg('calls', 'call', 'Zoom call', t(5, 10, 45), t(5, 11, 30)),
      // C and D at the same hour, one call: which one is the user's to say.
      cal('Gamma sync', t(5, 15), t(5, 16), 'E-c'),
      cal('Delta sync', t(5, 15), t(5, 16), 'E-d'),
      seg('calls', 'call', 'Zoom call', t(5, 15, 5), t(5, 15, 50)),
    ], ctx())
    const plan = Object.fromEntries(out.plan.map((p) => [p.title, p]))
    expect(plan['Alpha review']).toMatchObject({ attendance: 'attended', meetingMin: 55 })
    expect(plan['Beta review']).toMatchObject({ attendance: 'attended', meetingMin: 45 })
    expect(plan['Gamma sync']).toMatchObject({ attendance: 'needs_confirmation', attendanceBasis: 'double_booked', meetingMin: 0 })
    // 40 + 45 (A and B overlap: each second once) + 45 (the shared call, once).
    expect(out.summary).toMatchObject({ attendedMeetingMin: 130, meetingMin: 130, meetings: { attended: 2, needs_confirmation: 2 } })
    expect(out.summary.needsConfirmation).toEqual([
      expect.objectContaining({ title: 'Gamma sync', basis: 'double_booked', eventId: 'E-c' }),
      expect.objectContaining({ title: 'Delta sync', basis: 'double_booked', eventId: 'E-d' }),
    ])
  })

  it('the call app in front with no call heard is not other work: still the user\'s to say', () => {
    const out = merge([
      cal('Design', t(5, 15), t(5, 16), 'E-d'),
      seg('mac-apps', 'app', 'Zoom', t(5, 15), t(5, 16)),
    ], ctx())
    expect(out.plan[0]).toMatchObject({ attendance: 'needs_confirmation', attendanceBasis: 'nothing_recorded', verdict: 'meeting_on_screen' })
  })

  it('a meeting the user asked to leave out is not checked', () => {
    const out = merge([cal('Team lunch', t(5, 12), t(5, 13), 'E-l'), cal('Design', t(5, 15), t(5, 16), 'E-d')], ctx({ ignore: ['lunch'] }))
    expect(out.plan.map((p) => p.title)).toEqual(['Design'])
    expect(out.summary.ignoredMeetings).toBe(1)
  })

  it('without call data every meeting is unknown, never "not attended"', () => {
    const out = merge([cal('Design', t(5, 15), t(5, 16), 'E-d')])
    expect(out.plan[0]).toMatchObject({ attendance: 'unknown', attendanceBasis: 'no_call_data' })
  })
})

describe('meeting context (Mac-local answers and history)', () => {
  beforeEach(async () => {
    resetCallsStore()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
  })

  it('records, replaces and clears an answer', async () => {
    await setMeetingAnswer('E1', false)
    await setMeetingAnswer('E2', true)
    await setMeetingAnswer('E1', true)
    expect([...await readMeetingAnswers()]).toEqual([['E2', true], ['E1', true]])
    await setMeetingAnswer('E2', null)
    expect([...await readMeetingAnswers()]).toEqual([['E1', true]])
    const raw = await fs.readFile(`${WALNUT_HOME}/time-tracking/outside/meeting-answers.json`, 'utf8')
    expect(raw).not.toMatch(/title/)
  })

  it('finds a recurring series never on a call from the calendar history inside coverage', async () => {
    await appendCallLines([
      ...coverageLines([t(1, 0), t(9, 0)], 'log'),
      { startMs: t(6, 9), line: callLine({ app: 'zoom.us', startMs: t(6, 9), endMs: t(6, 9, 30) }, 'log') },
    ])
    const occurrences = (series: string, days: number[]) => days.map((d) => ({
      start: t(d, 9), end: t(d, 9, 30), kind: 'meeting', label: series, confidence: 'planned' as const,
      detail: { eventId: `${series}#${d}`, seriesId: series, recurring: true },
    }))
    const calendar = async (_r: TimelineRange): Promise<TimelineSourceResult> => ({ segments: [...occurrences('S-never', [5, 6, 7]), ...occurrences('S-on', [5, 6, 7])] })
    // S-on's 9:00 call on the 6th is shared with S-never's slot: give S-never another hour.
    const cal2 = async (r: TimelineRange) => {
      const res = await calendar(r)
      return { segments: res.segments.map((s) => (s.detail!.seriesId === 'S-never' ? { ...s, start: (s.start as number) + 3_600_000, end: (s.end as number) + 3_600_000 } : s)) }
    }
    const range: TimelineRange = { from: '2026-10-08', to: '2026-10-08', ...dayBoundsMs('2026-10-08')!, tz: 'UTC' }
    const ctx2 = await loadMeetingContext(range, cal2, ignoreList(['  Lunch ', 3]))
    expect([...ctx2.neverOnCall]).toEqual(['S-never'])
    expect(ctx2.ignore).toEqual(['lunch'])
    expect(ctx2.coverage).toEqual([[t(1, 0), t(9, 0)]])
  })
})
