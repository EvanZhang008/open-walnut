/**
 * Calls from macOS power assertions: the two pmset parsers (on synthetic lines in
 * the exact shapes macOS prints), which assertions count as a call, the interval
 * math, and the live collector's state machine.
 */

import { describe, expect, it } from 'vitest'
import {
  callAppSet, callSessions, coveredMs, createLogFolder, isCallAssertion, mergeCalls, mergeSpans, parseAssertionsNow, uncovered,
  MAX_CALL_MS,
} from '../../../src/core/time-tracking/calls.js'
import {
  applyLiveSample, emptyLiveState, flushLiveState, COVERAGE_BREAK_MS, PERSIST_EVERY_MS,
} from '../../../src/core/time-tracking/calls-collector.js'

const APPS = callAppSet()
const MIN = 60_000

// Shapes copied from `pmset -g log` (tabs and the trailing [System: ...] included).
const logLine = (stamp: string, pid: number, app: string, verb: string, type: string, name: string, age: string, id: string): string =>
  `${stamp} -0700 Assertions          \tPID ${pid}(${app}) ${verb} ${type} "${name}" ${age}  id:0x0x${id} [System: PrevIdle PrevDisp DeclUser kDisp]          `

describe('isCallAssertion', () => {
  it('a call app keeping the display awake is a call', () => {
    expect(isCallAssertion('zoom.us', 'NoDisplaySleepAssertion', 'Describe Activity Type', APPS)).toBe(true)
    expect(isCallAssertion('Microsoft Teams', 'PreventUserIdleDisplaySleep', 'Call in progress', APPS)).toBe(true)
  })
  it('housekeeping and media are not calls', () => {
    expect(isCallAssertion('Slack', 'PreventSystemSleep', 'Preparing update', APPS)).toBe(false)
    expect(isCallAssertion('zoom.us', 'NoDisplaySleepAssertion', 'Downloading update', APPS)).toBe(false)
    expect(isCallAssertion('Google Chrome', 'NoDisplaySleepAssertion', 'Video Wake Lock', APPS)).toBe(false)
    expect(isCallAssertion('Google Chrome', 'NoIdleSleepAssertion', 'Playing audio', APPS)).toBe(false)
    // A call app holding a SYSTEM (not display) assertion is background work.
    expect(isCallAssertion('zoom.us', 'PreventSystemSleep', 'Describe Activity Type', APPS)).toBe(false)
  })
  it('any process holding a WebRTC call counts (a browser call, a huddle)', () => {
    expect(isCallAssertion('Google Chrome', 'PreventUserIdleSystemSleep', 'WebRTC has active PeerConnections', APPS)).toBe(true)
  })
  it('the user can add a call app by process name, case-insensitively', () => {
    const apps = callAppSet(['MyCallApp', 42, '', 'x'.repeat(200)])
    expect(isCallAssertion('mycallapp', 'NoDisplaySleepAssertion', 'meeting', apps)).toBe(true)
    expect(apps.has('x'.repeat(200))).toBe(false)
  })
})

describe('parseAssertionsNow', () => {
  const NOW = Date.parse('2026-10-05T18:30:00.000Z')
  const text = [
    '2026-10-05 11:30:00 -0700 ',
    'Assertion status system-wide:',
    '   PreventUserIdleDisplaySleep    1',
    'Listed by owning process:',
    '   pid 357(powerd): [0x00012a5500018cfb] 02:26:20 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"  ',
    '   pid 56527(zoom.us): [0x00012a5500098cfa] 00:30:00 PreventUserIdleDisplaySleep named: "Describe Activity Type"  ',
    '\tTimeout will fire in 3585 secs Action=TimeoutActionRelease',
    '   pid 66296(caffeinate): [0x00012a6b00058d09] 02:25:58 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"  ',
    '   pid 9(zoom.us): [0x1] 99:00:00 PreventUserIdleDisplaySleep named: "stuck"  ',
  ].join('\n')

  it('finds the open call and dates its start from its age', () => {
    expect(parseAssertionsNow(text, NOW, APPS)).toEqual([{ app: 'zoom.us', key: '56527:0x00012a5500098cfa', startMs: NOW - 30 * MIN }])
  })
  it('an assertion held longer than a call can last is ignored', () => {
    expect(parseAssertionsNow(text, NOW, APPS).some((c) => c.startMs < NOW - MAX_CALL_MS)).toBe(false)
  })
})

describe('createLogFolder', () => {
  const ms = (local: string): number => Date.parse(`${local}-07:00`)

  it('pairs Created and Released by assertion id, and ignores other apps', () => {
    const f = createLogFolder(APPS)
    f.push('PM ASL data store: /var/log/powermanagement')
    f.push(logLine('2026-10-05 11:00:08', 56527, 'zoom.us', 'Created', 'NoDisplaySleepAssertion', 'Describe Activity Type', '00:00:00', '500009897'))
    f.push(logLine('2026-10-05 11:15:08', 56527, 'zoom.us', 'Summary', 'NoDisplaySleepAssertion', 'Describe Activity Type', '00:15:00', '500009897'))
    f.push(logLine('2026-10-05 12:30:17', 94645, 'Slack', 'Created', 'PreventSystemSleep', 'Preparing update', '00:00:00', '700009bec'))
    f.push(logLine('2026-10-05 12:37:33', 56527, 'zoom.us', 'Released', 'NoDisplaySleepAssertion', 'Describe Activity Type', '01:37:25', '500009897'))
    const out = f.finish(ms('2026-10-05T20:00:00'))
    expect(out.calls).toEqual([{ app: 'zoom.us', startMs: ms('2026-10-05T11:00:08'), endMs: ms('2026-10-05T12:37:33') }])
    expect(out.span).toEqual([ms('2026-10-05T11:00:08'), ms('2026-10-05T20:00:00')])
  })

  it('a Summary whose Created rotated out opens the call at its age; ClientDied closes it', () => {
    const f = createLogFolder(APPS)
    f.push(logLine('2026-10-03 12:45:00', 1877, 'zoom.us', 'Summary', 'NoDisplaySleepAssertion', 'Describe Activity Type', '00:45:00', '50000824c'))
    f.push(logLine('2026-10-03 13:00:00', 1877, 'zoom.us', 'ClientDied', 'NoDisplaySleepAssertion', 'Describe Activity Type', '01:00:00', '50000824c'))
    expect(f.finish(ms('2026-10-03T14:00:00')).calls).toEqual([{ app: 'zoom.us', startMs: ms('2026-10-03T12:00:00'), endMs: ms('2026-10-03T13:00:00') }])
  })

  it('a call still open at the end of the log runs to the end (it is running now)', () => {
    const f = createLogFolder(APPS)
    f.push(logLine('2026-10-09 15:33:09', 94991, 'zoom.us', 'Created', 'NoDisplaySleepAssertion', 'Describe Activity Type', '00:00:00', '50000a082'))
    const end = ms('2026-10-09T15:40:00')
    expect(f.finish(end).calls).toEqual([{ app: 'zoom.us', startMs: ms('2026-10-09T15:33:09'), endMs: end }])
  })

  it('a Released with no Created and a torn line are ignored', () => {
    const f = createLogFolder(APPS)
    f.push(logLine('2026-10-09 15:33:09', 1, 'zoom.us', 'Released', 'NoDisplaySleepAssertion', 'Describe Activity Type', '00:10:00', 'abc'))
    f.push('2026-10-09 15:34:00 -0700 Assertions          \tPID 1(zoom.us) Crea')
    expect(f.finish(ms('2026-10-09T16:00:00')).calls).toEqual([])
  })
})

describe('callSessions', () => {
  it('keeps back-to-back calls apart and joins the records of one call', () => {
    const at = (m: number, sec = 0) => m * MIN + sec * 1_000
    const sessions = callSessions([
      // Three meetings back to back: the app's assertions split 7 and 5 seconds apart.
      { app: 'zoom.us', startMs: at(0), endMs: at(45, 29) },
      { app: 'zoom.us', startMs: at(45, 36), endMs: at(62, 4) },
      { app: 'zoom.us', startMs: at(62, 9), endMs: at(146) },
      // The live sampler's record of the first call: its start a second off, persisted twice.
      { app: 'zoom.us', startMs: at(0, 1), endMs: at(20) },
      { app: 'zoom.us', startMs: at(0, 1), endMs: at(45, 30) },
      { app: 'FaceTime', startMs: at(10), endMs: at(11) },
    ])
    expect(sessions).toEqual([
      { app: 'zoom.us', startMs: at(0), endMs: at(45, 30) },
      { app: 'FaceTime', startMs: at(10), endMs: at(11) },
      { app: 'zoom.us', startMs: at(45, 36), endMs: at(62, 4) },
      { app: 'zoom.us', startMs: at(62, 9), endMs: at(146) },
    ])
    // mergeCalls welds them into one, which is right for "time on calls" and wrong for "which meeting".
    expect(mergeCalls(sessions).filter((c) => c.app === 'zoom.us')).toHaveLength(1)
  })
})

describe('interval math', () => {
  it('mergeCalls joins one app\'s pieces a few seconds apart, never across apps', () => {
    const merged = mergeCalls([
      { app: 'zoom.us', startMs: 0, endMs: 10 * MIN },
      { app: 'zoom.us', startMs: 10 * MIN + 7_000, endMs: 20 * MIN },
      { app: 'FaceTime', startMs: 5 * MIN, endMs: 6 * MIN },
      { app: 'zoom.us', startMs: 30 * MIN, endMs: 30 * MIN }, // empty
    ])
    expect(merged).toEqual([
      { app: 'zoom.us', startMs: 0, endMs: 20 * MIN },
      { app: 'FaceTime', startMs: 5 * MIN, endMs: 6 * MIN },
    ])
  })

  it('coveredMs and uncovered agree and add up to the span', () => {
    const merged = mergeSpans([[10, 20], [15, 30], [40, 50], [60, 70]])
    expect(merged).toEqual([[10, 30], [40, 50], [60, 70]])
    expect(coveredMs(0, 100, merged)).toBe(40)
    expect(uncovered(0, 100, merged)).toEqual([[0, 10], [30, 40], [50, 60], [70, 100]])
    expect(coveredMs(45, 65, merged)).toBe(10)
    expect(uncovered(45, 65, merged)).toEqual([[50, 60]])
    expect(uncovered(12, 18, merged)).toEqual([])
  })
})

describe('applyLiveSample', () => {
  const T = 1_800_000_000_000
  const seen = (startMs: number) => [{ app: 'zoom.us', key: '1:0xa', startMs }]
  const parse = (lines: Array<{ line: string }>) => lines.map((l) => JSON.parse(l.line) as Record<string, string>)

  it('writes a call when it appears, again every few minutes, and at its last sighting when it ends', () => {
    const st = emptyLiveState()
    let lines = parse(applyLiveSample(st, seen(T - 10 * MIN), T))
    expect(lines).toEqual([{ t: 'call', app: 'zoom.us', start: new Date(T - 10 * MIN).toISOString(), end: new Date(T).toISOString(), src: 'live' }])
    expect(parse(applyLiveSample(st, seen(T - 10 * MIN), T + 30_000))).toEqual([])
    lines = parse(applyLiveSample(st, seen(T - 10 * MIN), T + PERSIST_EVERY_MS))
    expect(lines.filter((l) => l.t === 'call')).toEqual([expect.objectContaining({ end: new Date(T + PERSIST_EVERY_MS).toISOString() })])
    lines = parse(applyLiveSample(st, [], T + PERSIST_EVERY_MS + 30_000))
    expect(lines.filter((l) => l.t === 'call')).toEqual([expect.objectContaining({ end: new Date(T + PERSIST_EVERY_MS).toISOString() })])
    expect(st.open.size).toBe(0)
  })

  it('a failed sample closes the coverage stretch and the open calls', () => {
    const st = emptyLiveState()
    applyLiveSample(st, seen(T), T)
    applyLiveSample(st, seen(T), T + 30_000)
    const lines = parse(applyLiveSample(st, null, T + 60_000))
    expect(lines).toEqual([
      { t: 'cov', start: new Date(T).toISOString(), end: new Date(T + 30_000).toISOString(), src: 'live' },
      expect.objectContaining({ t: 'call', end: new Date(T + 30_000).toISOString() }),
    ])
    expect(st.cov).toBeNull()
  })

  it('ticks far apart (the Mac slept) start a new coverage stretch', () => {
    const st = emptyLiveState()
    applyLiveSample(st, [], T)
    applyLiveSample(st, [], T + 30_000)
    const lines = parse(applyLiveSample(st, [], T + 30_000 + COVERAGE_BREAK_MS + 1))
    expect(lines).toEqual([{ t: 'cov', start: new Date(T).toISOString(), end: new Date(T + 30_000).toISOString(), src: 'live' }])
    expect(st.cov?.startMs).toBe(T + 30_000 + COVERAGE_BREAK_MS + 1)
  })

  it('flush at stop writes what is open, ending at the last sighting', () => {
    const st = emptyLiveState()
    applyLiveSample(st, seen(T), T)
    applyLiveSample(st, seen(T), T + 30_000)
    const lines = parse(flushLiveState(st))
    expect(lines.map((l) => [l.t, l.end])).toEqual([
      ['cov', new Date(T + 30_000).toISOString()],
      ['call', new Date(T + 30_000).toISOString()],
    ])
  })
})
