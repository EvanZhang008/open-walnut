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
import { count } from '../../../src/core/observability/metrics.js'

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
  return { m, fixes, minutes }
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

  it('with nobody to tell it files a fix task; switched off it only records why', async () => {
    const h = await harness(async (input) => (input.inst.labels?.op === 'a'
      ? { handled: false, fallback: true, detail: 'no watch and no project lead to tell' }
      : { handled: false, fallback: false, detail: 'real-use watch is off' }))
    await h.minutes(3, (i) => { if (i === 0) { count('usage.op.cut', 1, { op: 'a' }); count('usage.op.cut', 1, { op: 'b' }) } })
    expect(h.fixes).toHaveLength(1)
    expect(h.m.alarms['usage.cut{op=b}']?.actions.at(-1)).toMatchObject({ ok: false, detail: 'real-use watch is off' })
  })
})
