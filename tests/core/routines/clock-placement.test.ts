/**
 * Which routines keep their clock in a host's daemon, and the handover in both
 * directions (clock-routine-v1: src/core/routines/clock-placement.ts,
 * src/core/cron/clock-handover.ts).
 *
 * The rule under test: a run never happens twice and never on both sides. The
 * server stops ticking a routine before the push that hands it over, and takes
 * it back only from the daemon's reply, from where the daemon stood. A real cron
 * store on disk and the real timer; the daemon's replies are hand-written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { onTimer, findDueJobs } from '../../../src/core/cron/timer.js'
import { nextWakeAtMs } from '../../../src/core/cron/jobs.js'
import { placeClocks, releaseOrphanClocks, revertClocks, settleClocks } from '../../../src/core/cron/clock-handover.js'
import { applyTriggerFired } from '../../../src/core/cron/trigger-apply.js'
import { clockCandidate, placeClocksForHost, wireScheduleOf, type PlacementDeps, type ClockService } from '../../../src/core/routines/clock-placement.js'
import type { CronJob, CronJobCreate, CronServiceState } from '../../../src/core/cron/types.js'

const HOST = 'devbox'
const HOUR = 3_600_000
/** The top of an hour; the test starts a second after it, so the first hourly slot is BASE + 1h. */
const BASE = Date.UTC(2026, 9, 23, 12, 0, 0)
const T0 = BASE + 1_000
const slot = (n: number) => BASE + n * HOUR

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
}

let dir: string
let counter = 0
let now: { value: number }
let runExecutor: ReturnType<typeof vi.fn>

function makeState(): CronServiceState {
  return {
    deps: {
      nowMs: () => now.value,
      log: mockLog(),
      storePath: path.join(dir, `cron-${++counter}.json`),
      cronEnabled: false,
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok' }),
      runExecutor,
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  }
}

const sessionRoutine = (over: Partial<CronJobCreate> = {}): CronJobCreate => ({
  name: 'Daily review', enabled: true, wakeMode: 'now',
  schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
  executor: { type: 'session', config: { target: 'task-remote', prompt: 'Review the queue', instructions: 'Review the queue' } },
  ...over,
})

/** Tasks and their sessions as the Mac knows them. */
function fakeDeps(over: Partial<PlacementDeps> = {}): PlacementDeps {
  const tasks: Record<string, { id: string; phase?: string; transferred_to?: string }> = {
    'task-remote': { id: 'task-remote', phase: 'IN_PROGRESS' },
    'task-local': { id: 'task-local', phase: 'IN_PROGRESS' },
    'task-done': { id: 'task-done', phase: 'COMPLETE' },
    'task-moved': { id: 'task-moved', phase: 'COMPLETE', transferred_to: 'task-remote' },
  }
  const sessions: Record<string, Array<{ process_status: string; host?: string; lastActiveAt?: string }>> = {
    'task-remote': [{ process_status: 'idle', host: HOST }],
    'task-local': [{ process_status: 'idle' }],
    'task-done': [{ process_status: 'stopped', host: HOST }],
  }
  return {
    hosts: async () => new Set([HOST, 'other']),
    getTask: async (id) => tasks[id] ?? null,
    sessionsForTask: async (id) => sessions[id] ?? [],
    ...over,
  }
}

function serviceOf(state: CronServiceState): ClockService {
  return {
    placeClocks: (host, opts) => placeClocks(state, host, opts),
    settleClocks: (host, reply) => settleClocks(state, host, reply),
    revertClocks: (host, handed) => revertClocks(state, host, handed),
  }
}

/** The jobs as the push compiles them: as stored, never recomputed (trigger-push.ts). */
async function jobs(state: CronServiceState): Promise<CronJob[]> {
  return await ops.list(state, { includeDisabled: true, recompute: false })
}

/** A job as the Routines page reads it: through the recomputing list. */
async function jobOf(state: CronServiceState, id: string): Promise<CronJob> {
  const j = (await ops.list(state, { includeDisabled: true })).find((x) => x.id === id)
  if (!j) throw new Error(`no job ${id}`)
  return j
}

beforeEach(async () => {
  dir = WALNUT_HOME
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  now = { value: T0 }
  runExecutor = vi.fn().mockResolvedValue({ status: 'ok', summary: 'sent' })
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('which routines move to their host', () => {
  it('moves a session routine whose task session runs on a host, and a claude-code routine on a host', async () => {
    const state = makeState()
    const session = await ops.add(state, sessionRoutine())
    const moved = await ops.add(state, sessionRoutine({ name: 'Moved', executor: { type: 'session', config: { target: 'task-moved', prompt: 'p', instructions: 'p' } } }))
    const code = await ops.add(state, sessionRoutine({ name: 'Build', executor: { type: 'claude-code', config: { cwd: '/repo', host: HOST, instructions: 'Build it' } } }))
    const placed = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    expect(placed.handed.sort()).toEqual([session.id, moved.id, code.id].sort())
    const defs = new Map(placed.defs.map((d) => [d.id, d]))
    expect(defs.get(session.id)).toMatchObject({
      clock: { schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, fromMs: slot(1) },
      deliver: { home: WALNUT_HOME, taskId: 'task-remote', prompt: 'Review the queue' },
    })
    // The task a transfer moved the work to is where the host delivers.
    expect(defs.get(moved.id)?.deliver?.taskId).toBe('task-remote')
    // A claude-code routine carries no delivery: the Mac starts its session.
    expect(defs.get(code.id)?.deliver).toBeUndefined()
    const stored = await jobOf(state, session.id)
    expect(stored.state).toMatchObject({ clockHost: HOST, clockFromMs: slot(1), nextRunAtMs: slot(1) })
  })

  it('keeps everything else on the server timer', async () => {
    const state = makeState()
    const stay = [
      await ops.add(state, sessionRoutine({ name: 'Local session', executor: { type: 'session', config: { target: 'task-local', prompt: 'p', instructions: 'p' } } })),
      await ops.add(state, sessionRoutine({ name: 'Done task', executor: { type: 'session', config: { target: 'task-done', prompt: 'p', instructions: 'p' } } })),
      await ops.add(state, sessionRoutine({ name: 'Mac build', executor: { type: 'claude-code', config: { cwd: '/repo', instructions: 'b' } } })),
      await ops.add(state, sessionRoutine({ name: 'Unknown host', executor: { type: 'claude-code', config: { cwd: '/repo', host: 'ghost', instructions: 'b' } } })),
      await ops.add(state, sessionRoutine({ name: 'Main agent', executor: { type: 'main-agent', config: { text: 'hi' } } })),
      await ops.add(state, sessionRoutine({ name: 'Walnut agent', executor: { type: 'walnut-agent', config: { instructions: 'hi' } } })),
      await ops.add(state, sessionRoutine({ name: 'Watcher', executor: { type: 'watcher', config: { instructions: 'watch' } } })),
      await ops.add(state, sessionRoutine({ name: 'Second Monday', schedule: { kind: 'cron', expr: '0 9 * * 1#2', tz: 'UTC' } })),
      await ops.add(state, sessionRoutine({ name: 'Off', enabled: false })),
      await ops.add(state, sessionRoutine({ name: 'Counter', wake: { events: ['plugin:x:y'], threshold: 3 } })),
      await ops.add(state, sessionRoutine({ name: 'Init', initProcessor: { actionId: 'fetch' } })),
      await ops.add(state, sessionRoutine({ name: 'Too fast', schedule: { kind: 'every', everyMs: 1_000 } })),
    ]
    const placed = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    expect(placed.handed).toEqual([])
    expect(placed.defs).toEqual([])
    for (const j of stay) expect((await jobOf(state, j.id)).state.clockHost, j.name).toBeUndefined()
  })

  it('an older daemon (or one that never said) gets no clock and keeps none', async () => {
    const state = makeState()
    await ops.add(state, sessionRoutine())
    for (const cap of ['no', 'unknown'] as const) {
      const placed = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), cap, fakeDeps())
      expect(placed.handed).toEqual([])
      expect(placed.defs).toEqual([])
    }
    // The Mac's own daemon never holds a clock.
    const local = await placeClocksForHost(serviceOf(state), '__local__', await jobs(state), 'yes', fakeDeps())
    expect(local.defs).toEqual([])
  })

  it('a clock another host holds stays there until that host gives it back', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    // The session now runs on `other`: that host may not take the clock yet.
    const elsewhere = fakeDeps({ sessionsForTask: async () => [{ process_status: 'idle', host: 'other' }] })
    const other = await placeClocksForHost(serviceOf(state), 'other', await jobs(state), 'yes', elsewhere)
    expect(other.handed).toEqual([])
    // The old host's push leaves it out, and its reply gives it back.
    const old = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', elsewhere)
    expect(old.defs).toEqual([])
    await old.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(1) }] })
    expect((await jobOf(state, job.id)).state.clockHost).toBeUndefined()
    const next = await placeClocksForHost(serviceOf(state), 'other', await jobs(state), 'yes', elsewhere)
    expect(next.handed).toEqual([job.id])
  })

  it('fills in what a host must never guess: the zone and the anchor', () => {
    const job = { schedule: { kind: 'every', everyMs: HOUR }, createdAtMs: 123 } as unknown as CronJob
    expect(wireScheduleOf(job)).toEqual({ kind: 'every', everyMs: HOUR, anchorMs: 123 })
    const cron = wireScheduleOf({ schedule: { kind: 'cron', expr: '0 9 * * *' } } as unknown as CronJob)
    expect(cron).toMatchObject({ kind: 'cron', expr: '0 9 * * *' })
    expect(typeof (cron as { tz?: string }).tz).toBe('string')
    expect(clockCandidate({ ...job, enabled: true, executor: { type: 'session', config: { target: 't', prompt: 'p' } }, state: {} } as unknown as CronJob)).toBe(true)
  })
})

describe('server to daemon: the run happens once, on the daemon', () => {
  it('a due slot the server had not run yet is handed over and never run here', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    // The slot at 13:00 comes and the server has not ticked yet.
    now.value = slot(1) + 30_000
    const placed = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    expect(placed.defs[0].clock?.fromMs).toBe(slot(1))
    // A recomputing read must not hand the slot back to the server either.
    await ops.list(state, { includeDisabled: true })
    expect(findDueJobs(state)).toEqual([])
    expect(nextWakeAtMs(state)).toBeUndefined()
    await onTimer(state)
    expect(runExecutor).not.toHaveBeenCalled()
    expect(await ops.run(state, job.id, 'due')).toMatchObject({ ran: false, reason: 'not-due' })
  })

  it('a run the timer already started is not handed over until it ends', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    now.value = slot(1) + 1
    let release!: () => void
    runExecutor.mockImplementation(() => new Promise((r) => { release = () => r({ status: 'ok' }) }))
    const ticking = onTimer(state)
    await vi.waitFor(() => expect(runExecutor).toHaveBeenCalledTimes(1))
    const during = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    expect(during.handed).toEqual([])
    release()
    await ticking
    const after = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    expect(after.handed).toEqual([job.id])
    // The daemon owns the slot after the one the server ran.
    expect(after.defs[0].clock?.fromMs).toBe(slot(2))
    expect(runExecutor).toHaveBeenCalledTimes(1)
  })

  it('a push the daemon refused hands nothing over', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    const placed = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    await placed.rejected()
    const back = await jobOf(state, job.id)
    expect(back.state.clockHost).toBeUndefined()
    expect(back.state.nextRunAtMs).toBe(slot(1))
    now.value = slot(1) + 1
    await onTimer(state)
    expect(runExecutor).toHaveBeenCalledTimes(1)
  })
})

describe('daemon to server: the run happens once, on the server', () => {
  async function handed(state: CronServiceState): Promise<{ job: CronJob; placed: Awaited<ReturnType<typeof placeClocksForHost>> }> {
    const job = await ops.add(state, sessionRoutine())
    const placed = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    expect(placed.handed).toEqual([job.id])
    return { job, placed }
  }

  it('a run the daemon still holds runs here once when it arrives, and the slots it ran never do', async () => {
    const state = makeState()
    const { job, placed } = await handed(state)
    now.value = slot(3) + 10 * 60_000
    // The daemon ran the 13:00 and 14:00 slots, queued 15:00, and nobody took it:
    // it keeps that run (draining) and the server owns the slots from 16:00.
    await placed.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(4), pending: 1 }] })
    const back = await jobOf(state, job.id)
    expect(back.state.clockHost).toBeUndefined()
    expect(back.state.nextRunAtMs).toBe(slot(4))
    expect(back.state.clockReturned).toEqual({ host: HOST, fromMs: slot(1), beforeMs: slot(4) })
    await onTimer(state)
    expect(runExecutor).not.toHaveBeenCalled()
    // The held run replays: it is the server's to run, once.
    const deliver = vi.fn().mockResolvedValue({ status: 'ok', summary: 'sent' })
    const owed = { type: 'trigger.fired' as const, id: job.id, epoch: 'e1', seq: 3, atMs: slot(3), items: [], durationMs: 0, clock: { slotMs: slot(3), fromMs: slot(1) } }
    expect(await applyTriggerFired(state, owed, deliver, { fromHost: HOST })).toMatchObject({ delivered: true })
    expect(await applyTriggerFired(state, owed, deliver, { fromHost: HOST })).toMatchObject({ duplicate: true })
    expect(deliver).toHaveBeenCalledTimes(1)
    await onTimer(state)
    expect(runExecutor).not.toHaveBeenCalled()
    expect((await jobOf(state, job.id)).state.nextRunAtMs).toBe(slot(4))
  })

  it('a clock the server started over since (an edit) keeps the server’s new slot and never runs the old owed run', async () => {
    const state = makeState()
    const { job } = await handed(state)
    await ops.update(state, job.id, { schedule: { kind: 'cron', expr: '30 * * * *', tz: 'UTC' } })
    const edited = await jobOf(state, job.id)
    expect(edited.state).toMatchObject({ clockHost: HOST, clockFromMs: BASE + 30 * 60_000, nextRunAtMs: BASE + 30 * 60_000 })
    const placed = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'no', fakeDeps())
    await placed.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(2), pending: 1 }] })
    expect((await jobOf(state, job.id)).state.nextRunAtMs).toBe(BASE + 30 * 60_000)
    // That run of the old schedule replays: superseded, acked, nothing runs.
    const deliver = vi.fn()
    const r = await applyTriggerFired(state, {
      type: 'trigger.fired', id: job.id, epoch: 'e1', seq: 1, atMs: slot(1), items: [], durationMs: 0, clock: { slotMs: slot(1), fromMs: slot(1) },
    }, deliver, { fromHost: HOST })
    expect(r).toMatchObject({ found: true, duplicate: true, supersededSeqs: [1] })
    expect(deliver).not.toHaveBeenCalled()
  })

  it('a reply that neither holds nor names the clock, or an old daemon’s reply, gives it back as the server knew it', async () => {
    for (const reply of [{ clocks: [] }, {}]) {
      const state = makeState()
      const { job, placed } = await handed(state)
      await placed.applied(reply)
      const back = await jobOf(state, job.id)
      expect(back.state.clockHost).toBeUndefined()
      expect(back.state.nextRunAtMs).toBe(slot(1))
    }
  })

  it('a reply that holds it records where it stands, only for the current handover', async () => {
    const state = makeState()
    const { job, placed } = await handed(state)
    await placed.applied({ clocks: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(5) }] })
    expect((await jobOf(state, job.id)).state).toMatchObject({ clockHost: HOST, nextRunAtMs: slot(5) })
    await placed.applied({ clocks: [{ id: job.id, fromMs: 1, nextRunAtMs: slot(9) }] })
    expect((await jobOf(state, job.id)).state.nextRunAtMs).toBe(slot(5))
  })

  it('a clock held by a host gone from the config comes back', async () => {
    const state = makeState()
    const { job } = await handed(state)
    expect(await releaseOrphanClocks(state, new Set(['other']))).toEqual([job.id])
    expect((await jobOf(state, job.id)).state.clockHost).toBeUndefined()
  })
})

describe('a clock run the daemon reports', () => {
  const fire = (id: string, seq: number, slotMs: number, nextRunAtMs: number) => ({
    type: 'trigger.fired' as const, id, epoch: 'e1', seq, atMs: slotMs + 1_000, items: [], durationMs: 0, nextRunAtMs,
    clock: { slotMs, fromMs: slot(1) },
  })

  it('is delivered once, recorded, and its replay is a duplicate', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    const deliver = vi.fn().mockResolvedValue({ status: 'ok', summary: 'sent' })
    const first = await applyTriggerFired(state, fire(job.id, 1, slot(1), slot(2)), deliver)
    expect(first).toMatchObject({ found: true, delivered: true, duplicate: false })
    const again = await applyTriggerFired(state, fire(job.id, 1, slot(1), slot(2)), deliver)
    expect(again).toMatchObject({ found: true, duplicate: true })
    expect(deliver).toHaveBeenCalledTimes(1)
    const stored = await jobOf(state, job.id)
    expect(stored.state).toMatchObject({ nextRunAtMs: slot(2), lastStatus: 'ok', fireCount: 1 })
    expect(stored.state.lastCheck).toBeUndefined()
    expect(stored.state.checkLog).toBeUndefined()
  })

  it('a late run after the server took the clock back runs once and keeps the server’s own next run', async () => {
    const state = makeState()
    const { id } = await ops.add(state, sessionRoutine())
    const placed = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    await placed.applied({ clocks: [], released: [{ id, fromMs: slot(1), nextRunAtMs: slot(3), pending: 1 }] })
    const deliver = vi.fn().mockResolvedValue({ status: 'ok' })
    // The fire still carries a next slot; the server keeps its own.
    const r = await applyTriggerFired(state, fire(id, 1, slot(1), slot(5)), deliver, { fromHost: HOST })
    expect(r).toMatchObject({ found: true, delivered: true })
    expect((await jobOf(state, id)).state.nextRunAtMs).toBe(slot(3))
  })

  it('a one-shot that ran on its host is deleted (deleteAfterRun) or switched off', async () => {
    const state = makeState()
    const at = new Date(slot(1)).toISOString()
    const gone = await ops.add(state, sessionRoutine({ name: 'Once', schedule: { kind: 'at', at } }))
    const kept = await ops.add(state, sessionRoutine({ name: 'Once kept', schedule: { kind: 'at', at }, deleteAfterRun: false }))
    await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    const deliver = vi.fn().mockResolvedValue({ status: 'ok' })
    await applyTriggerFired(state, { ...fire(gone.id, 1, slot(1), Number.NaN), clock: { slotMs: slot(1), fromMs: slot(1) } }, deliver)
    await applyTriggerFired(state, { ...fire(kept.id, 1, slot(1), Number.NaN), clock: { slotMs: slot(1), fromMs: slot(1) } }, deliver)
    const all = await jobs(state)
    expect(all.find((j) => j.id === gone.id)).toBeUndefined()
    const off = all.find((j) => j.id === kept.id)!
    expect(off.enabled).toBe(false)
    expect(off.state.nextRunAtMs).toBeUndefined()
    // Its one run is over: no clock holds it anywhere.
    expect(off.state.clockHost).toBeUndefined()
  })

  it('a fire with no clock for a routine with no check is still not a routine’s fire', async () => {
    const state = makeState()
    const { id } = await ops.add(state, sessionRoutine())
    const r = await applyTriggerFired(state, { ...fire(id, 1, T0, T0), clock: undefined }, vi.fn())
    expect(r.found).toBe(false)
  })
})

describe('edits and resumes start a host clock over', () => {
  it('pause then resume mints a new first slot from now', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    await ops.toggle(state, job.id)
    now.value = slot(5) + 1
    await ops.toggle(state, job.id)
    expect((await jobOf(state, job.id)).state).toMatchObject({ clockHost: HOST, clockFromMs: slot(6), nextRunAtMs: slot(6) })
  })

  it('a paused clock keeps its host and runs nowhere; Resume arms it there from a new slot', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    await ops.toggle(state, job.id)
    // The push after the pause leaves it out; the daemon disarms it and keeps the run it owed.
    const paused = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    expect(paused.defs).toEqual([])
    await paused.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(2), pending: 1 }] })
    const kept = await jobOf(state, job.id)
    expect(kept.enabled).toBe(false)
    expect(kept.state.clockHost).toBe(HOST)
    expect(kept.state.nextRunAtMs).toBeUndefined()
    // That run replays while it is paused: nothing runs, and it is acked.
    const deliver = vi.fn()
    const owed = await applyTriggerFired(state, {
      type: 'trigger.fired', id: job.id, epoch: 'e1', seq: 1, atMs: slot(1), items: [], durationMs: 0, clock: { slotMs: slot(1), fromMs: slot(1) },
    }, deliver, { fromHost: HOST })
    expect(owed.supersededSeqs).toEqual([1])
    expect(deliver).not.toHaveBeenCalled()
    now.value = slot(3) + 1
    await onTimer(state)
    expect(runExecutor).not.toHaveBeenCalled()
    await ops.toggle(state, job.id)
    const resumed = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    expect(resumed.handed).toEqual([])
    expect(resumed.defs.map((d) => [d.id, d.clock?.fromMs])).toEqual([[job.id, slot(4)]])
    await onTimer(state)
    expect(runExecutor).not.toHaveBeenCalled()
  })

  it('a paused clock whose work left the host comes back to the server on Resume', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    await ops.toggle(state, job.id)
    const paused = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', fakeDeps())
    await paused.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(2) }] })
    await ops.toggle(state, job.id)
    // The task's session now runs on the Mac.
    const local = fakeDeps({ sessionsForTask: async () => [{ process_status: 'idle' }] })
    const placed = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', local)
    expect(placed.defs).toEqual([])
    await placed.applied({ clocks: [] })
    const back = await jobOf(state, job.id)
    expect(back.state.clockHost).toBeUndefined()
    expect(back.state.nextRunAtMs).toBe(slot(1))
    now.value = slot(1) + 1
    await onTimer(state)
    expect(runExecutor).toHaveBeenCalledTimes(1)
  })
})
