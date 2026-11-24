/**
 * Walnut Health's real-use alarms end to end on the engine: a confirmed cut counted by the
 * recorder's counter rings `usage.cut` for that op, the alarm goes to its owner through the
 * `route` action once per episode, and with nobody to tell it takes the fix-task way.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MinuteCollector } from '../../../src/core/health-monitor/collect.js'
import { HealthMonitor, type FixTaskInput } from '../../../src/core/health-monitor/engine.js'
import { HealthStore } from '../../../src/core/health-monitor/store.js'
import type { RouteAlarmInput, RouteAlarmResult } from '../../../src/core/health-monitor/types.js'
import { USAGE_ALARMS, usageTargetOf } from '../../../src/core/health-monitor/usage-alarms.js'
import { USAGE_COUNTERS } from '../../../src/core/usage-watch/counters.js'
import { addObserveTap, count } from '../../../src/core/observability/metrics.js'
import { _resetUsageRecorderForTesting, STALL_KIND, recordHttp, recordPageError, settlePageFailures } from '../../../src/core/usage-watch/record.js'

const START = Date.parse('2026-11-21T10:00:30Z')
let dir: string
let monitors: HealthMonitor[] = []

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-route-')) })
afterEach(async () => {
  for (const m of monitors) { m.stop(); await m.flushed() }
  monitors = []
  await fs.rm(dir, { recursive: true, force: true })
})

async function harness(route: (input: RouteAlarmInput) => Promise<RouteAlarmResult>) {
  const clock = { now: START }
  const fixes: FixTaskInput[] = []
  const collector = new MinuteCollector({
    dataDir: dir,
    statfs: async () => ({ bsize: 1024 ** 3, bavail: 500, bfree: 500, blocks: 1000 }),
    fdCount: async () => 10, memoryPressure: () => 'normal', sshCertExpiring: async () => false, rssBytes: () => 1,
  })
  const m = new HealthMonitor({
    store: new HealthStore(dir), collector, pid: 1, now: () => clock.now,
    fixMode: async () => 'record',
    autoFix: async () => ({ ok: true, detail: '' }),
    openFixTask: async (input) => { fixes.push(input); return { taskId: `fix-${fixes.length}`, started: false } },
    isTaskOpen: async () => true,
    tellTask: async () => ({ delivered: false, started: false, detail: '' }),
    route,
  })
  await m.start({ clock: false })
  monitors.push(m)
  const minutes = async (n: number, each?: (i: number) => void) => {
    for (let i = 0; i < n; i++) { each?.(i); clock.now += 60_000; await m.tick() }
  }
  return { m, fixes, minutes, now: () => clock.now }
}

describe('real-use alarms', () => {
  it('every real-use alarm reads a counter or gauge the recorder writes, and names its target', () => {
    for (const def of USAGE_ALARMS) {
      const name = def.metric.split('{')[0]!
      if (def.kind === 'counter') expect(USAGE_COUNTERS as readonly string[]).toContain(name)
      expect(def.action.then).toBe('route')
      const label = /\{(\w+)=\*\}/.exec(def.metric)![1]!
      expect(usageTargetOf(def.id, { [label]: 'x' })).not.toBeNull()
    }
  })

  it('one confirmed cut rings usage.cut for that op and is routed once per episode', async () => {
    const calls: RouteAlarmInput[] = []
    const h = await harness(async (input) => { calls.push(input); return { handled: true, delivered: true, taskId: 'owner', detail: 'delivered to "Owner"' } })
    await h.minutes(3, (i) => { if (i === 0) count('usage.op.cut', 1, { op: 'thread_update' }) })
    const a = h.m.alarms['usage.cut{op=thread_update}']
    expect(a?.state).toBe('ALARM')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inst.labels).toEqual({ op: 'thread_update' })
    expect(a?.actions.at(-1)).toMatchObject({ kind: 'fix-task', ok: true, taskId: 'owner', detail: 'delivered to "Owner"' })
    // Another cut in the same episode is not sent again.
    await h.minutes(5, (i) => { if (i === 0) count('usage.op.cut', 1, { op: 'thread_update' }) })
    expect(calls).toHaveLength(1)
    expect(h.fixes).toHaveLength(0)
  })

  it('a count of one reads singular in the note', async () => {
    const { unitFor } = await import('../../../src/core/usage-watch/runtime.js')
    // Every unit of a real-use alarm reads singular for one (no unit ends in an s once it is one).
    for (const d of USAGE_ALARMS) if (!d.unit.startsWith('%')) expect(unitFor(d.unit, 1)).not.toMatch(/s(?:$| in )/)
    expect(unitFor('confirmed cuts', 1)).toBe('confirmed cut')
    expect(unitFor('errors in 6 h', 1)).toBe('error in 6 h')
    expect(unitFor('confirmed cuts', 2)).toBe('confirmed cuts')
    expect(unitFor('% of calls', 1)).toBe('% of calls')
  })

  it('page requests that went wrong on the way never ring alone: never reached the server, never sent, or timed out', async () => {
    _resetUsageRecorderForTesting(true)
    try {
      const h = await harness(async () => ({ handled: true, delivered: true, taskId: 'vp', detail: 'delivered' }))
      // 2026-11-22: a deploy's restart left 19 requests unsent in an open page at once.
      await h.minutes(4, (i) => {
        if (i === 0) {
          for (let n = 0; n < 19; n++) recordPageError({ kind: 'GET unknown request rejected in the page', request: true, how: 'rejected' as const }, h.now())
          // A sleeping Mac's page: nine requests failed with a network error at one instant.
          for (let n = 0; n < 9; n++) recordPageError({ kind: 'GET unknown request failed in the page', request: true, how: 'failed' as const }, h.now())
          for (let n = 0; n < 5; n++) recordPageError({ kind: 'GET /api/x timed out in the page', route: 'GET /api/x', request: true, how: 'timed out' as const }, h.now())
        }
        if (i === 1) settlePageFailures(h.now())
      })
      expect(h.m.alarms['usage.page{kind=GET unknown request rejected in the page}']?.state ?? 'none').not.toBe('ALARM')
      expect(h.m.alarms['usage.page{kind=GET unknown request failed in the page}']?.state ?? 'none').not.toBe('ALARM')
      // 2026-11-24: a notes list the server answered in 24 ms timed out in the page: the route
      // answered, the page did nothing wrong. A route that hung rings as its own slow read (below).
      expect(h.m.alarms['usage.page{kind=GET /api/x timed out in the page}']?.state ?? 'none').not.toBe('ALARM')
    } finally { _resetUsageRecorderForTesting(false) }
  })

  it('many requests timing out together ring once as a stall; one route timing out alone rings as its own slow read', async () => {
    // 2026-11-22: the lead got notes for every route an open page lost at once.
    const kinds = ['GET /api/a', 'GET /api/b', 'GET /api/c'].map((r) => ({ kind: `${r} timed out in the page`, route: r, request: true, how: 'timed out' as const }))
    _resetUsageRecorderForTesting(true)
    try {
      const h = await harness(async () => ({ handled: true, delivered: true, taskId: 'vp', detail: 'delivered' }))
      await h.minutes(9, (i) => {
        // A stall: three routes time out in the same minute, five times each.
        if (i === 0) for (const k of kinds) for (let n = 0; n < 5; n++) recordPageError(k, h.now())
        // One route hangs while the rest answer: its page gives up on it twice a minute (from two
        // minutes on, outside the stall's window), and its server sees each hang-up at 15 s.
        if (i >= 2 && i <= 6) {
          for (let n = 0; n < 2; n++) {
            recordHttp({ method: 'GET', template: '/api/slow', status: 200, ms: 15_002, waits: false, hungUp: true, now: h.now() })
            recordPageError({ kind: 'GET /api/slow timed out in the page', route: 'GET /api/slow', request: true, how: 'timed out' as const }, h.now())
          }
        }
        settlePageFailures(h.now())
      })
      for (const k of kinds) expect(h.m.alarms[`usage.page{kind=${k.kind}}`]?.state ?? 'none', k.kind).not.toBe('ALARM')
      // One stall is one count of its own kind, not one per route: it rings only when it recurs.
      expect(h.m.alarms[`usage.page{kind=${STALL_KIND}}`]?.state ?? 'none').not.toBe('ALARM')
      expect(h.m.alarms['usage.page{kind=GET /api/slow timed out in the page}']?.state ?? 'none').not.toBe('ALARM')
      expect(h.m.alarms['usage.slow{route=GET /api/slow}']?.state).toBe('ALARM')
    } finally { _resetUsageRecorderForTesting(false) }
    // A stall that recurs (five times in six hours) rings once, as itself.
    _resetUsageRecorderForTesting(true)
    try {
      const h = await harness(async () => ({ handled: true, delivered: true, taskId: 'vp', detail: 'delivered' }))
      await h.minutes(12, (i) => {
        if (i % 2 === 0 && i <= 8) for (const k of kinds) recordPageError(k, h.now())
        settlePageFailures(h.now())
      })
      expect(h.m.alarms[`usage.page{kind=${STALL_KIND}}`]?.state).toBe('ALARM')
      for (const k of kinds) expect(h.m.alarms[`usage.page{kind=${k.kind}}`]?.state ?? 'none', k.kind).not.toBe('ALARM')
    } finally { _resetUsageRecorderForTesting(false) }
    // Within two minutes of the server's start, timeouts together are the restart's, not a stall.
    _resetUsageRecorderForTesting(true, START)
    const stalls: string[] = []
    const off = addObserveTap((name, _v, labels) => { if (name === 'usage.page.errors') stalls.push(labels?.kind ?? '') })
    try {
      const h = await harness(async () => ({ handled: true, delivered: true, taskId: 'vp', detail: 'delivered' }))
      await h.minutes(6, (i) => {
        if (i === 0) {
          for (const k of kinds) recordPageError(k, h.now())
          // Nor are they context: two routes failing late in the grace and one timing out just after
          // it are not three kinds of a stall.
          for (const r of ['GET /api/d', 'GET /api/e']) recordPageError({ kind: `${r} failed in the page`, route: r, request: true, how: 'failed' as const }, START + 100_000)
          recordPageError({ kind: 'GET /api/f timed out in the page', route: 'GET /api/f', request: true, how: 'timed out' as const }, START + 125_000)
        }
        settlePageFailures(h.now())
      })
      expect(stalls).toEqual([])
    } finally { off(); _resetUsageRecorderForTesting(false) }
  })

  it('with nobody to tell it files a fix task; switched off it only records why', async () => {
    const h = await harness(async (input) => (input.inst.labels?.op === 'a'
      ? { handled: false, fallback: true, detail: 'no watch and no project lead to tell' }
      : { handled: false, fallback: false, detail: 'real-use watch is off' }))
    await h.minutes(3, (i) => { if (i === 0) { count('usage.op.cut', 1, { op: 'a' }); count('usage.op.cut', 1, { op: 'b' }) } })
    expect(h.fixes).toHaveLength(1)
    expect(h.m.alarms['usage.cut{op=b}']?.actions.at(-1)).toMatchObject({ ok: false, detail: 'real-use watch is off' })
  })
})
