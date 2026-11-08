/**
 * The health monitor through a real server (src/core/health-monitor/, routes
 * src/web/routes/health-monitor-v1.ts): it starts with the server, lists every
 * built-in alarm, takes no action on a test server, and a person's or an agent's
 * change is validated, recorded with who made it, and kept. Then a real fix task:
 * a monitor on the real task store and the real openFixTask files ONE task in the
 * Walnut project for an alarm, with the evidence as its description.
 * Only the Claude CLI is mocked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-health-monitor'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { BUILTIN_ALARMS } from '../../src/core/health-monitor/alarms.js'
import { runningHealthMonitor } from '../../src/core/health-monitor/index.js'
import { MinuteCollector } from '../../src/core/health-monitor/collect.js'
import { HealthMonitor } from '../../src/core/health-monitor/engine.js'
import { HealthStore } from '../../src/core/health-monitor/store.js'
import { openFixTask, isTaskOpen, FIX_PROJECT } from '../../src/core/health-monitor/fix-task.js'
import { executeOp } from '../../src/ops/index.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { getTask } from '../../src/core/task-manager.js'

let base = ''

async function waitRunning(): Promise<void> {
  for (let i = 0; i < 100 && !runningHealthMonitor(); i++) await new Promise((r) => setTimeout(r, 50))
  expect(runningHealthMonitor()).toBeTruthy()
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await waitRunning()
})

afterAll(async () => {
  await stopServer()
})

describe('health monitor API', () => {
  it('lists every built-in alarm, and says actions are off on a test server', async () => {
    await runningHealthMonitor()!.tick()
    const res = await fetch(`${base}/api/v1/health-monitor`)
    expect(res.status).toBe(200)
    const view = await res.json()
    expect(view.actions).toBe(false)
    const ids = view.alarms.map((a: { id: string }) => a.id)
    for (const d of BUILTIN_ALARMS) if (!d.metric.includes('=*')) expect(ids).toContain(d.id)
    const disk = view.alarms.find((a: { id: string }) => a.id === 'disk.free')
    expect(disk.condition).toContain('30')
    expect(disk.spark).toHaveLength(96)
    expect(view.counts.ALARM + view.counts.OK + view.counts.INSUFFICIENT_DATA).toBe(view.alarms.length)
  })

  it('one alarm in full, and a 404 for an unknown one', async () => {
    const one = await (await fetch(`${base}/api/v1/health-monitor/alarms/disk.free`)).json()
    expect(one.id).toBe('disk.free')
    expect(Array.isArray(one.history)).toBe(true)
    expect(one.series.length).toBeGreaterThan(0)
    expect((await fetch(`${base}/api/v1/health-monitor/alarms/nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/v1/health-monitor?alarm=disk.free`)).status).toBe(200)
  })

  it('a change is validated, records who made it, and is kept across a restart of the monitor', async () => {
    const bad = await fetch(`${base}/api/v1/health-monitor/alarms/disk.free`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ muted_for: 'forever' }),
    })
    expect(bad.status).toBe(400)
    const res = await fetch(`${base}/api/v1/health-monitor/alarms/disk.free`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threshold: 12, muted_for: '2h' }),
    })
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.override).toMatchObject({ threshold: 12, by: 'human' })
    expect(out.override.mutedUntil).toBeGreaterThan(Date.now() + 3_500_000)
    const view = await (await fetch(`${base}/api/v1/health-monitor`)).json()
    const disk = view.alarms.find((a: { id: string }) => a.id === 'disk.free')
    expect(disk.condition).toContain('12')
    expect(disk.held).toBe(true)
    await runningHealthMonitor()!.flushed()
    const state = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'local', 'health-monitor', 'state.json'), 'utf-8'))
    expect(state.overrides['disk.free'].threshold).toBe(12)
    // back to the default
    const reset = await fetch(`${base}/api/v1/health-monitor/alarms/disk.free`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threshold: null, muted_until: null }),
    })
    expect((await reset.json()).override).toBeNull()
  })

  it('the ops read and change it the same way', async () => {
    const read = await executeOp('health_monitor', {}, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' }) as { ok: boolean; result: Record<string, unknown> }
    expect(read.ok).toBe(true)
    expect(String(read.result.outcome)).toMatch(/alarm/)
    const set = await executeOp('health_alarm_set', { id: 'process.fd', enabled: false }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' }) as { ok: boolean; result: Record<string, unknown> }
    expect(set.ok).toBe(true)
    expect(runningHealthMonitor()!.overrides['process.fd']).toMatchObject({ enabled: false })
  })
})

describe('a fix task on the real task store', () => {
  it('an alarm files ONE task in the Walnut project with its evidence; a later episode reuses it', async () => {
    const dir = path.join(WALNUT_HOME, 'local', 'health-monitor-fix-test')
    let now = Date.parse('2026-11-08T10:00:30Z')
    const collector = new MinuteCollector({
      dataDir: dir,
      statfs: async () => ({ bsize: 1, bavail: 1, bfree: 1, blocks: 2 }),
      fdCount: async () => 10,
      memoryPressure: () => 'normal',
    })
    const m = new HealthMonitor({
      store: new HealthStore(dir), collector, pid: 1, now: () => now, exitTraceFile: null,
      fixMode: async () => 'record', autoFix: async () => ({ ok: true, detail: 'ran' }),
      openFixTask, isTaskOpen,
    })
    await m.start({ clock: false })
    try {
      collector.setGauge('session.hung', 4)
      for (let i = 0; i < 16; i++) { now += 60_000; await m.tick() }
      const inst = m.alarms['session.hung']
      expect(inst.state).toBe('ALARM')
      expect(inst.fixTaskId).toBeTruthy()
      const task = await getTask(inst.fixTaskId!)
      expect(task.project).toBe(FIX_PROJECT)
      expect(task.title).toBe('Fix: Sessions look hung')
      expect(task.description).toContain('session.hung')
      expect(task.description).toContain('Done means')
      // calm, then hung again: the open task is reused
      collector.setGauge('session.hung', 0)
      for (let i = 0; i < 3; i++) { now += 60_000; await m.tick() }
      expect(m.alarms['session.hung'].state).toBe('OK')
      collector.setGauge('session.hung', 4)
      for (let i = 0; i < 16; i++) { now += 60_000; await m.tick() }
      expect(m.alarms['session.hung'].state).toBe('ALARM')
      expect(m.alarms['session.hung'].fixTaskId).toBe(inst.fixTaskId)
    } finally {
      m.stop()
      await m.flushed()
    }
  })
})
