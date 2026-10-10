/**
 * The two Mac-local stores this round added: call intervals (calls-store.ts) and
 * the time detail file (detail-store.ts: open files, plugin items, sent-message
 * markers). Both live under time-tracking/outside/, the directory the data sync
 * ignores. WALNUT_HOME is a fresh tmp dir via mocked constants.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-calls-detail-store'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { appendCallLines, callLine, coverageLine, coverageLines, readCalls, resetCallsStore } from '../../../src/core/time-tracking/calls-store.js'
import {
  appendDetail, leaseDetailOf, readDetailDay, relativeFile, resetDetailStore, sentMarkerOf, startSentMarkers, stopSentMarkers,
} from '../../../src/core/time-tracking/detail-store.js'
import { localDateKey } from '../../../src/core/time-tracking/rollup.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'

const MIN = 60_000

beforeEach(async () => {
  resetCallsStore()
  resetDetailStore()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

describe('calls store', () => {
  it('keeps calls under outside/calls, skips lines a day already holds, and reads the union', async () => {
    const a = new Date(2026, 9, 5, 11, 0, 8).getTime()
    const b = new Date(2026, 9, 5, 12, 37, 33).getTime()
    const lines = [
      { startMs: a, line: callLine({ app: 'zoom.us', startMs: a, endMs: b }, 'log') },
      { startMs: a, line: callLine({ app: 'zoom.us', startMs: a + 30_000, endMs: a + 20 * MIN }, 'live') },
      { startMs: a, line: coverageLine([a - 60 * MIN, b + 60 * MIN], 'log') },
    ]
    expect(await appendCallLines(lines)).toBe(3)
    // A second backfill of the same log writes nothing.
    expect(await appendCallLines(lines)).toBe(0)
    const file = path.join(WALNUT_HOME, 'time-tracking', 'outside', 'calls', `${localDateKey(new Date(a))}.jsonl`)
    expect((await fs.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(3)
    const read = await readCalls(new Date(2026, 9, 5).getTime(), new Date(2026, 9, 6).getTime())
    expect(read.calls).toEqual([{ app: 'zoom.us', startMs: a, endMs: b }])
    expect(read.coverage).toEqual([[a - 60 * MIN, b + 60 * MIN]])
  })

  it('a week of coverage is cut per local day, so a read of any later day sees it', async () => {
    // The power log's span: Saturday 15:35 to the next Saturday 15:33 (2026-10-10 live data).
    const a = new Date(2026, 9, 3, 15, 35).getTime()
    const b = new Date(2026, 9, 10, 15, 33).getTime()
    const lines = coverageLines([a, b], 'log')
    expect(lines).toHaveLength(8)
    expect(lines.map((l) => localDateKey(new Date(l.startMs)))).toEqual(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'])
    await appendCallLines(lines)
    const thu = await readCalls(new Date(2026, 9, 8).getTime(), new Date(2026, 9, 9).getTime())
    expect(thu.coverage).toHaveLength(1)
    expect(thu.coverage[0]![0]).toBeLessThanOrEqual(new Date(2026, 9, 8).getTime())
    expect(thu.coverage[0]![1]).toBeGreaterThanOrEqual(new Date(2026, 9, 9).getTime())
    // The pieces join back into the one stretch.
    const all = await readCalls(a, b)
    expect(all.coverage).toEqual([[a, b]])
  })

  it('a call across midnight is found from the next day too', async () => {
    const a = new Date(2026, 9, 5, 23, 40).getTime()
    const b = new Date(2026, 9, 6, 0, 20).getTime()
    await appendCallLines([{ startMs: a, line: callLine({ app: 'FaceTime', startMs: a, endMs: b }, 'live') }])
    const read = await readCalls(new Date(2026, 9, 6).getTime(), new Date(2026, 9, 7).getTime())
    expect(read.calls).toEqual([{ app: 'FaceTime', startMs: a, endMs: b }])
  })

  it('a browser connection while a game stream was in front is read as not a call; a call app\'s call stays', async () => {
    const at = (h: number, m: number): number => new Date(2026, 9, 7, h, m).getTime()
    await appendCallLines([
      { startMs: at(15, 15), line: callLine({ app: 'zoom.us', startMs: at(15, 15), endMs: at(16, 44) }, 'log') },
      { startMs: at(22, 1), line: callLine({ app: 'Google Chrome', startMs: at(22, 1), endMs: at(23, 43) }, 'log') },
    ])
    const outside = path.join(WALNUT_HOME, 'time-tracking', 'outside', '2026-10-07.jsonl')
    const rows: string[] = []
    for (let t = at(22, 1); t < at(23, 43); t += 60_000) {
      const host = t < at(22, 4) ? 'discord.com' : 'play.geforcenow.com'
      rows.push(JSON.stringify({ date: '2026-10-07', ts: new Date(t).toISOString(), durationMs: 60_000, app: 'Google Chrome', bundleId: 'com.google.Chrome', host }))
    }
    await fs.writeFile(outside, rows.join('\n') + '\n')
    const read = await readCalls(new Date(2026, 9, 7).getTime(), new Date(2026, 9, 8).getTime())
    expect(read.calls).toEqual([{ app: 'zoom.us', startMs: at(15, 15), endMs: at(16, 44) }])
    expect(read.sessions).toEqual(read.calls)
    expect(read.notCalls).toEqual([{ app: 'Google Chrome', startMs: at(22, 1), endMs: at(23, 43), host: 'play.geforcenow.com' }])
  })

  it('a browser connection with no foreground record stays a call', async () => {
    const a = new Date(2026, 9, 8, 9, 0).getTime()
    await appendCallLines([{ startMs: a, line: callLine({ app: 'Google Chrome', startMs: a, endMs: a + 30 * MIN }, 'live') }])
    const read = await readCalls(new Date(2026, 9, 8).getTime(), new Date(2026, 9, 9).getTime())
    expect(read.calls).toHaveLength(1)
    expect(read.notCalls).toEqual([])
  })

  it('a torn or foreign line is skipped, never fatal', async () => {
    const dir = path.join(WALNUT_HOME, 'time-tracking', 'outside', 'calls')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, '2026-10-05.jsonl'), '{"t":"call","app":"zoom.us","start":"2026-10-05T18:00:00Z","end":"2026-10-05T19:00:00Z"}\n{"t":"call","ap\nnot json\n{"t":"call","app":"x","start":"b","end":"a"}\n')
    const read = await readCalls(new Date(2026, 9, 5).getTime(), new Date(2026, 9, 6).getTime())
    expect(read.calls).toHaveLength(1)
  })
})

describe('detail store', () => {
  it('a lease with a file or an item becomes a local line; one without detail does not', () => {
    const rec = { date: '2026-10-05', ts: '2026-10-05T17:00:00.000Z', durationMs: 30_000, kind: 'session' as const, sessionId: 's1', view: 'files' as const }
    expect(leaseDetailOf(rec, {})).toBeNull()
    expect(leaseDetailOf(rec, { file: 'src/a.ts' })).toEqual({
      t: 'lease', ts: rec.ts, durationMs: 30_000, kind: 'session', sessionId: 's1', view: 'files', file: 'src/a.ts',
    })
  })

  it('makes a path relative to the session working directory only when it lies inside it', () => {
    expect(relativeFile('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(relativeFile('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
    expect(relativeFile('/repository/x.ts', '/repo')).toBe('/repository/x.ts')
    expect(relativeFile('/other/x.ts', undefined)).toBe('/other/x.ts')
  })

  it('a sent marker keeps when, where and how long, never the text', () => {
    const now = new Date('2026-10-05T17:00:00.000Z')
    const m = sentMarkerOf({ sessionId: 's1', messageId: 'qm-1', message: 'secret plans for the launch', source: 'ui', enqueuedAt: '2026-10-05T16:59:59.000Z' }, now)
    expect(m).toEqual({ t: 'sent', ts: '2026-10-05T16:59:59.000Z', sessionId: 's1', messageId: 'qm-1', chars: 27, device: 'web' })
    expect(JSON.stringify(m)).not.toContain('secret')
    expect(sentMarkerOf({ sessionId: 's1', messageId: 'qm-2', message: 'x', source: 'mobile' }, now)?.device).toBe('ios')
    expect(sentMarkerOf({ messageId: 'qm-3', message: 'x', source: 'chat' }, now)).toMatchObject({ chat: true, device: 'web' })
  })

  it('agents, peers and automation are not the user sending', () => {
    const now = new Date()
    for (const source of ['peer', 'cli', 'auto-continue', 'routine-x', 'cron', 'triage', undefined]) {
      expect(sentMarkerOf({ sessionId: 's', messageId: 'm', message: 'x', source }, now)).toBeNull()
    }
  })

  it('records a person\'s send from the queue event, and reads the day back', async () => {
    startSentMarkers()
    try {
      const at = new Date()
      bus.emit(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: 'not-a-session', messageId: 'qm-9', message: 'hello there', source: 'ui', enqueuedAt: at.toISOString() }, ['main-ai'], { source: 'ui' })
      bus.emit(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: 'not-a-session', messageId: 'qm-10', message: 'continue', source: 'auto-continue' }, ['main-ai'], { source: 'auto-continue' })
      // A retry queues the same message id again: one marker.
      bus.emit(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: 'not-a-session', messageId: 'qm-9', message: 'hello there', source: 'ui', enqueuedAt: at.toISOString() }, ['main-ai'], { source: 'ui' })
      await vi.waitFor(async () => expect(await readDetailDay(localDateKey(at))).toHaveLength(1), { timeout: 3_000 })
      await new Promise((r) => setTimeout(r, 100))
      expect(await readDetailDay(localDateKey(at))).toHaveLength(1)
      expect((await readDetailDay(localDateKey(at)))[0]).toMatchObject({ t: 'sent', messageId: 'qm-9', chars: 11, device: 'web' })
    } finally {
      stopSentMarkers()
    }
  })

  it('files lines under the local date of their ts and skips junk on read', async () => {
    const ts = new Date(2026, 9, 5, 10, 0).toISOString()
    await appendDetail([{ t: 'lease', ts, durationMs: 1000, kind: 'app', app: 'chatapp', item: 'C1', label: '#general' }])
    const file = path.join(WALNUT_HOME, 'time-tracking', 'outside', 'detail', '2026-10-05.jsonl')
    await fs.appendFile(file, 'garbage\n{"t":"lease"}\n')
    expect(await readDetailDay('2026-10-05')).toEqual([{ t: 'lease', ts, durationMs: 1000, kind: 'app', app: 'chatapp', item: 'C1', label: '#general' }])
  })
})
