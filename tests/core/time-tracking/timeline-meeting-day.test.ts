/**
 * One real meeting, second by second, through the real timeline sources and the
 * real stores (2026-10-07, the shape of a review whose call ran past its slot):
 * a 15:15-16:00 meeting whose Zoom call ran to 16:44, with Chrome and Walnut in
 * front for part of it, leases whose 60 s tails ran on into Zoom, and the Mac idle
 * at the end.
 *
 * Two bugs this pins: the meeting stopped at its calendar end, so the 44 minutes of
 * overrun read as an ad-hoc call; and a lease's tail over Zoom counted as Walnut,
 * so the time on the call with nothing else on screen came out far too low.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-timeline-meeting-day'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { buildTimeline } from '../../../src/core/time-tracking/timeline/build.js'
import { registerCoreTimelineSources } from '../../../src/core/time-tracking/timeline/core-sources.js'
import { loadMeetingContext } from '../../../src/core/time-tracking/timeline/meeting-context.js'
import { registerTimelineSource } from '../../../src/core/time-tracking/timeline/registry.js'
import { WALNUT_DESKTOP_BUNDLE_ID } from '../../../src/core/time-tracking/outside-view.js'
import { DEFAULT_WORK_HOURS } from '../../../src/core/time-tracking/work-hours.js'
import { systemTz } from '../../../src/core/health/day-key.js'
import type { TimelineRange, TimelineSourceResult } from '../../../src/core/time-tracking/timeline/types.js'

const D = '2026-10-07'
const at = (h: number, m: number, s = 0): number => new Date(2026, 9, 7, h, m, s).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()

/** Foreground samples every 5 s, as the sampler banks them. */
function front(from: number, to: number, app: string, bundleId: string, host?: string): string[] {
  const out: string[] = []
  for (let t = from; t < to; t += 5_000) out.push(JSON.stringify({ date: D, ts: iso(t), durationMs: 5_000, app, bundleId, ...(host ? { host } : {}) }))
  return out
}
const lease = (ms: number): string => JSON.stringify({ date: D, ts: iso(ms), durationMs: 60_000, kind: 'chat' })

const calendar = async (_r: TimelineRange): Promise<TimelineSourceResult> => ({
  segments: [
    { start: at(15, 15), end: at(16, 0), kind: 'meeting', label: 'Delivery mode review', confidence: 'planned', detail: { eventId: 'E-review' } },
    { start: at(17, 0), end: at(17, 30), kind: 'meeting', label: 'Later sync', confidence: 'planned', detail: { eventId: 'E-later' } },
  ],
})

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const tt = path.join(WALNUT_HOME, 'time-tracking')
  await fs.mkdir(path.join(tt, 'outside', 'calls'), { recursive: true })
  await fs.writeFile(path.join(tt, 'outside', 'calls', `${D}.jsonl`), [
    { t: 'cov', start: iso(at(0, 0)), end: iso(at(23, 59)), src: 'log' },
    { t: 'call', app: 'zoom.us', start: iso(at(15, 15)), end: iso(at(16, 44)), src: 'log' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  await fs.writeFile(path.join(tt, 'outside', `${D}.jsonl`), [
    ...front(at(15, 15), at(15, 20), 'zoom.us', 'us.zoom.xos'),
    ...front(at(15, 20), at(15, 47), 'Google Chrome', 'com.google.Chrome', 'example.org'),
    ...front(at(15, 47), at(16, 0), 'Walnut', WALNUT_DESKTOP_BUNDLE_ID),
    ...front(at(16, 0), at(16, 20), 'zoom.us', 'us.zoom.xos'),
    ...front(at(16, 20), at(16, 30), 'Walnut', WALNUT_DESKTOP_BUNDLE_ID),
    ...front(at(16, 30), at(16, 41), 'zoom.us', 'us.zoom.xos'),
    // 16:41-16:44: the Mac idle, the call still on.
  ].join('\n') + '\n')
  const clicks = [
    ...Array.from({ length: 12 }, (_, i) => at(15, 47 + i)), at(15, 59, 30), // the last tail runs 30 s into Zoom
    at(16, 20), at(16, 22), at(16, 24), at(16, 26), at(16, 28, 30), at(16, 29, 50), // the last tail runs 50 s into Zoom
  ]
  await fs.writeFile(path.join(tt, `${D}.jsonl`), clicks.map(lease).join('\n') + '\n')
  registerCoreTimelineSources()
  registerTimelineSource('testcal', { id: 'meetings', label: 'Test meetings', lane: 'activity', priority: 50, segments: calendar })
})

async function day() {
  const answer = await buildTimeline(D, D, {
    workHours: DEFAULT_WORK_HOURS, workHoursSource: 'default', tz: systemTz(), nowMs: at(23, 0),
    meetings: (range) => loadMeetingContext(range, calendar, []),
  })
  return answer.days[0]!
}

describe('a meeting whose call ran past its slot, second by second', () => {
  it('follows the call to its end, and counts the time with nothing else on screen', async () => {
    const d = await day()
    const review = d.plan.find((p) => p.title === 'Delivery mode review')!
    // On the call 15:15-16:44: 89 min, 44 of them past the calendar end.
    expect(review).toMatchObject({ attendance: 'attended', attendanceBasis: 'call', callMin: 89, attendedMin: 89, overrunMin: 44 })
    // Other work: Chrome 27 + Walnut 13 (15:47-16:00) + Walnut 10 (16:20-16:30) = 50.
    // The rest is Zoom in front (36) and the idle Mac (3): 39.
    expect(review).toMatchObject({ otherWorkMin: 50, meetingMin: 39 })
    expect(d.summary).toMatchObject({ callMin: 89, adHocCallMin: 0, attendedMeetingMin: 89, meetingMin: 39 })
  })

  it('a lease tail that ran on into Zoom is Zoom\'s, not Walnut\'s', async () => {
    const d = await day()
    const walnutMs = d.blocks.filter((b) => b.kind === 'screen')
      .flatMap((b) => b.top ?? []).filter((t) => t.kind === 'walnut').reduce((s, t) => s + t.min, 0)
    expect(walnutMs).toBe(23)
  })
})
