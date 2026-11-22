/**
 * A routine of a task kept local keeps its clock off a host none of that task's sessions run on
 * (routines/clock-kept.ts, clock-placement.ts): the def a host arms carries the routine's name and
 * prompt, and a portable routine's start a sample of its owner's conversation. Real task store
 * and holds (setTaskSyncHold), the real kept-off rule (keptOffHostNow), a real cron store and
 * handover; the daemon's replies are hand-written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-clock-kept-local'))

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { placeClocks, revertClocks, settleClocks } from '../../../src/core/cron/clock-handover.js'
import { placeClocksForHost, type ClockService, type PlacementDeps } from '../../../src/core/routines/clock-placement.js'
import { clockKeptOff, routineTaskIds } from '../../../src/core/routines/clock-kept.js'
import { addTask, setTaskSyncHold } from '../../../src/core/task-manager.js'
import { keptOffHostNow } from '../../../src/core/replication/host-private.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { randomUUID } from 'node:crypto'
import type { CronJob, CronJobCreate, CronServiceState } from '../../../src/core/cron/types.js'

const HOST = 'devbox'
const HOLD = { target: 'acme', state: 'private' as const, by: 'words' as const, at: '2026-11-21T00:00:00.000Z' }
let counter = 0

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
}

function makeState(): CronServiceState {
  return {
    deps: {
      nowMs: () => Date.UTC(2026, 10, 21, 12, 0, 1), log: mockLog(), storePath: path.join(WALNUT_HOME, `cron-${++counter}.json`), cronEnabled: false,
      broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok' }), runExecutor: vi.fn().mockResolvedValue({ status: 'ok' }), onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  }
}

function serviceOf(state: CronServiceState): ClockService {
  return {
    placeClocks: (host, opts) => placeClocks(state, host, opts),
    settleClocks: (host, reply) => settleClocks(state, host, reply),
    revertClocks: (host, handed) => revertClocks(state, host, handed),
  }
}

const jobsOf = (state: CronServiceState): Promise<CronJob[]> => ops.list(state, { includeDisabled: true, recompute: false })

/** A claude-code routine bound to HOST, owned by `owner`. */
const hostRoutine = (name: string, owner: string): CronJobCreate => ({
  name, enabled: true, wakeMode: 'now', ownerTaskId: owner,
  schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
  executor: { type: 'claude-code', config: { cwd: '/repo', host: HOST, instructions: `Run ${name}` } },
} as CronJobCreate)

/** A session routine delivering into `target`, whose session runs on HOST. */
const sessionRoutine = (name: string, target: string): CronJobCreate => ({
  name, enabled: true, wakeMode: 'now',
  schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
  executor: { type: 'session', config: { target, prompt: `Review ${name}`, instructions: `Review ${name}` } },
})

function deps(sessionsOnHost: string[]): PlacementDeps {
  return {
    hosts: async () => new Set([HOST]),
    getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }),
    sessionsForTask: async (id) => (sessionsOnHost.includes(id) ? [{ process_status: 'idle', host: HOST }] : []),
  }
}

beforeEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })
afterEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

describe('a kept task\'s routine keeps its clock off a host', () => {
  it('names the tasks a routine belongs to as its copy kind does, and an offline owner only when none decides', async () => {
    const job = { executor: { type: 'session', config: { target: ' a ' } }, ownerTaskId: 'b', checkActsFor: 'c' } as unknown as CronJob
    expect(routineTaskIds(job)).toEqual(['a', 'b', 'c'])
    const owner = vi.fn(async () => 'kept')
    expect(await clockKeptOff(job, (id) => id === 'b', owner)).toBe(true)
    expect(owner).not.toHaveBeenCalled()
    expect(await clockKeptOff(job, (id) => id === 'kept', owner)).toBe(true)
    expect(await clockKeptOff(job, () => false, owner)).toBe(false)
    expect(await clockKeptOff(job, (id) => id === 'kept', async () => { throw new Error('unreadable') })).toBe(false)
  })

  it('kept fixture: triggers.configure clock: a kept task\'s routine is never handed to a host, and one it holds is given back; a kept task running there keeps its own', async () => {
    const kept = (await addTask({ title: 'Appraisal notes', project: 'Work' })).task
    const open = (await addTask({ title: 'Open work', project: 'Work' })).task
    const keptHere = (await addTask({ title: 'Kept, runs here', project: 'Work' })).task
    await createSessionRecord(randomUUID(), keptHere.id, 'Work', WALNUT_HOME, { host: HOST })
    const state = makeState()
    const keptJob = await ops.add(state, hostRoutine('Kept review', kept.id))
    const openJob = await ops.add(state, hostRoutine('Open review', open.id))
    const hereJob = await ops.add(state, sessionRoutine('Here review', keptHere.id))

    // Nothing kept yet: every clock goes to the host, and the daemon holds them.
    const first = await placeClocksForHost(serviceOf(state), HOST, await jobsOf(state), 'yes', deps([keptHere.id]), { keptOff: (await keptOffHostNow([HOST])).keptOff })
    expect(first.handed.sort()).toEqual([keptJob.id, openJob.id, hereJob.id].sort())
    const held = (await jobsOf(state)).map((j) => ({ id: j.id, fromMs: j.state.clockFromMs!, nextRunAtMs: j.state.clockFromMs! }))
    await first.applied({ clocks: held })

    // The owner is kept: the next push leaves its clock out, and the daemon's reply gives it back.
    await setTaskSyncHold(kept.id, HOLD)
    await setTaskSyncHold(keptHere.id, HOLD)
    // keptHere's own session runs on the host: it is not kept off there.
    const { keptOff } = await keptOffHostNow([HOST])
    expect([keptOff(kept.id), keptOff(keptHere.id), keptOff(open.id)]).toEqual([true, false, false])
    const next = await placeClocksForHost(serviceOf(state), HOST, await jobsOf(state), 'yes', deps([keptHere.id]), { keptOff })
    const sent = next.defs.map((d) => d.id)
    expect(sent).not.toContain(keptJob.id)
    expect(JSON.stringify(next.defs)).not.toContain('Kept review')
    expect(sent).toEqual(expect.arrayContaining([openJob.id, hereJob.id]))
    await next.applied({ clocks: held.filter((c) => c.id !== keptJob.id), released: held.filter((c) => c.id === keptJob.id) })
    const after = new Map((await jobsOf(state)).map((j) => [j.id, j]))
    expect(after.get(keptJob.id)!.state.clockHost, 'back on the Mac\'s timer').toBeUndefined()
    expect(after.get(openJob.id)!.state.clockHost).toBe(HOST)

    // Released again: the clock may go back to the host.
    await setTaskSyncHold(kept.id, null)
    const again = await placeClocksForHost(serviceOf(state), HOST, await jobsOf(state), 'yes', deps([keptHere.id]), { keptOff: (await keptOffHostNow([HOST])).keptOff })
    expect(again.handed).toContain(keptJob.id)
  })

  it('a session routine whose work moved to a kept task stays on the Mac', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine('Moved', 'old-task'))
    const d: PlacementDeps = {
      ...deps(['new-task']),
      getTask: async (id) => (id === 'old-task' ? { id, phase: 'COMPLETE', transferred_to: 'new-task' } : { id, phase: 'IN_PROGRESS' }),
    }
    const placed = await placeClocksForHost(serviceOf(state), HOST, await jobsOf(state), 'yes', d, { keptOff: (id) => id === 'new-task' })
    expect(placed.handed).not.toContain(job.id)
    expect(placed.defs).toEqual([])
  })
})
