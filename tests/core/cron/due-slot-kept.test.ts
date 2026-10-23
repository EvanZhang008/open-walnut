/**
 * A routine's due slot on the server's timer runs: no reader skips it, and the
 * timer never spins over a slot it will not run (src/core/cron/jobs.ts
 * recomputeNextRuns / nextWakeAtMs / scheduleNextRunAtMs).
 *
 * Before: any recompute (a Routines page read, a status, an edit of another
 * routine, the timer's own phase 3 while a long run went on) moved a due, unrun
 * slot to the next one, so that run never happened. And inside the hour a fall
 * daylight saving change repeats, a run that ended there left no next slot, so a
 * routine finer than an hour stopped until a restart.
 *
 * A real cron store on disk, the real timer and a fake clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { onTimer } from '../../../src/core/cron/timer.js'
import { nextWakeAtMs, scheduleNextRunAtMs } from '../../../src/core/cron/jobs.js'
import { clockSchedule } from '../../../src/core/cron/schedule.js'
import { persist } from '../../../src/core/cron/store.js'
import type { CronJob, CronJobCreate, CronServiceState } from '../../../src/core/cron/types.js'

const HOUR = 3_600_000
const BASE = Date.UTC(2026, 9, 23, 12, 0, 0)
const MIN = 60_000

let dir: string
let counter = 0
let now: { value: number }
let runs: Array<{ name: string; at: number }>
/** Minutes a run takes, by routine name. */
let takes: Record<string, number>

function makeState(): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return {
    deps: {
      nowMs: () => now.value,
      log,
      storePath: path.join(dir, `cron-${++counter}.json`),
      cronEnabled: false,
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok' }),
      runExecutor: vi.fn(async (job: CronJob) => {
        runs.push({ name: job.name, at: now.value })
        now.value += (takes[job.name] ?? 0) * MIN
        return { status: 'ok' as const, summary: 'sent' }
      }),
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  }
}

const routine = (name: string, expr: string, tz = 'UTC'): CronJobCreate => ({
  name, enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr, tz },
  executor: { type: 'session', config: { target: `task-${name}`, prompt: 'p', instructions: 'p' } },
})

async function stored(state: CronServiceState, id: string): Promise<CronJob> {
  const j = (await ops.list(state, { includeDisabled: true, recompute: false })).find((x) => x.id === id)
  if (!j) throw new Error(`no job ${id}`)
  return j
}

beforeEach(async () => {
  dir = WALNUT_HOME
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  now = { value: BASE + 1_000 }
  runs = []
  takes = {}
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('a due slot the timer has not run yet', () => {
  it('survives a Routines page read just before the tick, and runs', async () => {
    const state = makeState()
    const job = await ops.add(state, routine('hourly', '0 * * * *'))
    now.value = BASE + HOUR + 2_000
    await ops.list(state, { includeDisabled: true })
    expect((await stored(state, job.id)).state.nextRunAtMs).toBe(BASE + HOUR)
    await onTimer(state)
    expect(runs.map((r) => r.name)).toEqual(['hourly'])
    expect((await stored(state, job.id)).state.nextRunAtMs).toBe(BASE + 2 * HOUR)
  })

  it('survives the timer’s own pass after another routine’s long run, and runs next', async () => {
    const state = makeState()
    takes = { A: 10 }
    now.value = BASE + 59 * MIN
    await ops.add(state, routine('A', '0 * * * *'))
    const b = await ops.add(state, routine('B', '5 * * * *'))
    // 13:00:01: A is due and runs ten minutes; B's 13:05 passes meanwhile.
    now.value = BASE + HOUR + 1_000
    await onTimer(state)
    expect((await stored(state, b.id)).state.nextRunAtMs).toBe(BASE + HOUR + 5 * MIN)
    await onTimer(state)
    expect(runs.map((r) => r.name)).toEqual(['A', 'B'])
    expect((await stored(state, b.id)).state.nextRunAtMs).toBe(BASE + 2 * HOUR + 5 * MIN)
  })

  it('survives a list, a status and every edit of another routine made while a run goes on', async () => {
    const state = makeState()
    now.value = BASE + 59 * MIN
    const a = await ops.add(state, routine('A', '0 * * * *'))
    const b = await ops.add(state, routine('B', '5 * * * *'))
    let during: Promise<unknown> = Promise.resolve()
    const run = state.deps.runExecutor as ReturnType<typeof vi.fn>
    run.mockImplementationOnce(async (job: CronJob) => {
      runs.push({ name: job.name, at: now.value })
      now.value += 10 * MIN
      // Every reader and writer that recomputes, while A still runs.
      during = (async () => {
        await ops.list(state, { includeDisabled: true })
        await ops.status(state)
        const c = await ops.add(state, routine('C', '30 * * * *'))
        await ops.update(state, c.id, { name: 'C2' })
        await ops.toggle(state, c.id)
        await ops.remove(state, c.id)
      })()
      await during
      return { status: 'ok' as const, summary: 'sent' }
    })
    now.value = BASE + HOUR + 1_000
    await onTimer(state)
    await during
    expect((await stored(state, b.id)).state.nextRunAtMs).toBe(BASE + HOUR + 5 * MIN)
    await onTimer(state)
    expect(runs.map((r) => r.name)).toEqual(['A', 'B'])
    expect((await stored(state, a.id)).state.nextRunAtMs).toBe(BASE + 2 * HOUR)
  })

  it('an edit of the routine’s own schedule starts from the new schedule', async () => {
    const state = makeState()
    const job = await ops.add(state, routine('hourly', '0 * * * *'))
    now.value = BASE + HOUR + 2_000
    await ops.update(state, job.id, { schedule: { kind: 'cron', expr: '30 * * * *', tz: 'UTC' } })
    expect((await stored(state, job.id)).state.nextRunAtMs).toBe(BASE + HOUR + 30 * MIN)
  })

  it('a slot the job’s record already ran is still moved on by a recompute', async () => {
    const state = makeState()
    const job = await ops.add(state, routine('hourly', '0 * * * *'))
    now.value = BASE + HOUR + 2_000
    await onTimer(state)
    // Another process wrote the stale slot back (the 2026-08-04 shape): the run's record says it ran.
    const j = state.store!.jobs.find((x) => x.id === job.id)!
    j.state.nextRunAtMs = BASE + HOUR
    await persist(state)
    state.replayGuard!.delete(job.id)
    await ops.list(state, { includeDisabled: true })
    expect((await stored(state, job.id)).state.nextRunAtMs).toBe(BASE + 2 * HOUR)
  })
})

describe('the timer never wakes for a slot it will not run', () => {
  it('a slot the replay guard covers wakes the timer at the guard, not at once', async () => {
    const state = makeState()
    const job = await ops.add(state, routine('hourly', '0 * * * *'))
    now.value = BASE + HOUR + 2_000
    // In memory this process ran it and owns the next slot; the store says due.
    state.replayGuard!.set(job.id, BASE + 2 * HOUR)
    await ops.list(state, { includeDisabled: true, recompute: false })
    expect(nextWakeAtMs(state)).toBe(BASE + 2 * HOUR)
    state.replayGuard!.set(job.id, null)
    expect(nextWakeAtMs(state)).toBeUndefined()
  })

  it('a run in flight wakes it only when the marker would be stuck', async () => {
    const state = makeState()
    const job = await ops.add(state, routine('hourly', '0 * * * *'))
    const j = state.store!.jobs.find((x) => x.id === job.id)!
    j.state.runningAtMs = now.value
    j.state.nextRunAtMs = now.value - 1
    expect(nextWakeAtMs(state)).toBe(now.value + 2 * HOUR)
  })
})

describe('the hour a daylight saving change repeats', () => {
  it('a run that ends there still leaves a next slot, the one a host’s clock picks, and the routine goes on', async () => {
    const state = makeState()
    takes = { q15: 16 }
    now.value = Date.parse('2026-11-01T08:40:00Z') // 01:40 PDT
    const job = await ops.add(state, routine('q15', '*/15 * * * *', 'America/Los_Angeles'))
    now.value = Date.parse('2026-11-01T08:45:01Z') // the 01:45 PDT slot; the run ends at 01:01 PST
    await onTimer(state)
    const guard = state.replayGuard!.get(job.id)
    expect(typeof guard).toBe('number')
    const ended = Date.parse('2026-11-01T09:01:01Z')
    const wire = { kind: 'cron' as const, expr: '*/15 * * * *', tz: 'America/Los_Angeles' }
    expect(guard).toBe(clockSchedule.afterRun(wire, ended))
    expect(scheduleNextRunAtMs(await stored(state, job.id), ended)).toBe(guard)
    for (const iso of ['2026-11-01T10:00:01Z', '2026-11-01T12:00:01Z', '2026-11-02T08:00:01Z']) {
      now.value = Date.parse(iso)
      await onTimer(state)
      await onTimer(state)
    }
    expect(runs.map((r) => new Date(r.at).toISOString())).toEqual([
      '2026-11-01T08:45:01.000Z', '2026-11-01T12:00:01.000Z', '2026-11-02T08:00:01.000Z',
    ])
  })
})
