/**
 * A clock coming back from a host's daemon (clock-routine-v1): every run the host
 * made reaches the server exactly once, as history or as the one run the server
 * makes, and nothing runs twice (src/core/cron/clock-fire.ts, clock-handover.ts,
 * src/core/routines/clock-placement.ts).
 *
 * The cases are the ones an adversarial review found: a one-shot the host
 * delivered ran again after the clock came back; a Run now on a hosted clock
 * followed by a release left a due slot the timer refused, and the timer woke
 * about a hundred times a second; one refused def looped the push; a config
 * that could not be read took every clock back; a clock stayed on a host it no
 * longer belonged to; a paused routine still ran a held run.
 *
 * A real cron store on disk, the real timer; the daemon's replies and fires are
 * hand-written in the shapes the daemon twins send (tests/integration/
 * clock-routine-twins.test.ts holds the twins to them).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())
const pushed = vi.hoisted(() => [] as string[])
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  pushTriggersToHost: (host: string) => { pushed.push(host) },
  getConnectedDaemonConnection: () => null,
}))
const cron = vi.hoisted(() => ({ service: null as unknown }))
vi.mock('../../../src/web/routes/cron.js', () => ({ getCronService: () => cron.service }))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { CronService } from '../../../src/core/cron/service.js'
import { onTimer, findDueJobs } from '../../../src/core/cron/timer.js'
import { nextWakeAtMs } from '../../../src/core/cron/jobs.js'
import { placeClocks, releaseOrphanClocks, revertClocks, settleClocks, takeBackStranded } from '../../../src/core/cron/clock-handover.js'
import { applyTriggerFired } from '../../../src/core/cron/trigger-apply.js'
import {
  _resetClockPlacementForTest, clockDefOf, defaultPlacementDeps, placeClocksForHost, takeBackStrandedClocks,
  type ClockService, type PlacementDeps,
} from '../../../src/core/routines/clock-placement.js'
import * as routinesCore from '../../../src/core/routines/routines-core.js'
import type { TriggerFiredEvent } from '../../../src/providers/trigger-check-core.js'
import type { CronJob, CronJobCreate, CronServiceState } from '../../../src/core/cron/types.js'

const HOST = 'devbox'
const HOUR = 3_600_000
const BASE = Date.UTC(2026, 9, 23, 12, 0, 0)
const slot = (n: number) => BASE + n * HOUR

let dir: string
let counter = 0
let now: { value: number }
let runExecutor: ReturnType<typeof vi.fn>

function makeState(): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return {
    deps: {
      nowMs: () => now.value, log, storePath: path.join(dir, `cron-${++counter}.json`), cronEnabled: false,
      broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok' }), runExecutor, onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  }
}

const sessionRoutine = (over: Partial<CronJobCreate> = {}): CronJobCreate => ({
  name: 'Digest', enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
  executor: { type: 'session', config: { target: 'task-remote', prompt: 'Do it', instructions: 'Do it' } },
  ...over,
})

/** Where the task's session runs: on the host, on the Mac, or (unreachable) in error. */
function deps(where: 'host' | 'mac' | 'error', over: Partial<PlacementDeps> = {}): PlacementDeps {
  const sessions = where === 'host' ? [{ process_status: 'idle', host: HOST }]
    : where === 'mac' ? [{ process_status: 'idle', lastActiveAt: new Date(now.value).toISOString() }, { process_status: 'stopped', host: HOST }]
      : [{ process_status: 'error', host: HOST }]
  return {
    hosts: async () => new Set([HOST]),
    getTask: async (id) => ({ id, phase: 'IN_PROGRESS' }),
    sessionsForTask: async () => sessions,
    connected: async () => true,
    ...over,
  }
}

function serviceOf(state: CronServiceState): ClockService {
  return {
    placeClocks: (host, opts) => placeClocks(state, host, opts),
    settleClocks: (host, reply) => settleClocks(state, host, reply),
    revertClocks: (host, handed) => revertClocks(state, host, handed),
    takeBackStranded: (host, ids) => takeBackStranded(state, host, ids),
  }
}

async function jobs(state: CronServiceState): Promise<CronJob[]> {
  return await ops.list(state, { includeDisabled: true, recompute: false })
}

async function jobOf(state: CronServiceState, id: string): Promise<CronJob | undefined> {
  return (await ops.list(state, { includeDisabled: true })).find((x) => x.id === id)
}

/** A run the host made under the clock it got at `fromMs`: owed, or delivered into the session there. */
function hostRun(id: string, seq: number, slotMs: number, fromMs: number, delivered?: number): TriggerFiredEvent {
  return {
    type: 'trigger.fired', id, epoch: 'e1', seq, atMs: slotMs + 1_000, items: [], durationMs: 0,
    clock: { slotMs, fromMs },
    ...(delivered !== undefined ? { host: { atMs: delivered, sessionId: 'sid-host', messageId: `qm-${seq}`, seqs: [seq] } } : {}),
  }
}

/** The record a host delivery leaves (trigger-events.ts recordHostDelivery). */
const recorded = (atMs: number) => vi.fn().mockResolvedValue({ status: 'ok', summary: 'devbox sent it to session [sid-host]', delivered: { sessionId: 'sid-host', text: 'x' }, deliveredAtMs: atMs })

async function handOver(state: CronServiceState, job: CronJob, fromMs: number): Promise<void> {
  const placed = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('host'))
  expect(placed.handed).toEqual([job.id])
  await placed.applied({ clocks: [{ id: job.id, fromMs, nextRunAtMs: fromMs }] })
}

beforeEach(async () => {
  dir = WALNUT_HOME
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  now = { value: BASE + 1_000 }
  runExecutor = vi.fn().mockResolvedValue({ status: 'ok', summary: 'sent' })
  pushed.length = 0
  cron.service = null
  _resetClockPlacementForTest()
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('a one-shot the host delivered while the Mac slept', () => {
  for (const pending of [1, undefined]) {
    it(`never runs again once its clock comes back${pending ? ' (the release names the run it still holds)' : ''}, and its record marks it done`, async () => {
      const state = makeState()
      const atMs = slot(2)
      const job = await ops.add(state, sessionRoutine({ name: 'Once', schedule: { kind: 'at', at: new Date(atMs).toISOString() }, deleteAfterRun: false }))
      await handOver(state, job, atMs)
      // The Mac sleeps through atMs; the host delivers into the session there.
      now.value = atMs + 30 * 60_000
      // The Mac wakes and the routine no longer belongs on the host: its daemon
      // gives the clock back, the `at` spent, its delivered run still unacked.
      const p = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('mac'))
      expect(p.defs).toEqual([])
      await p.applied({ clocks: [], released: [{ id: job.id, fromMs: atMs, ...(pending ? { pending } : {}) }] })
      const back = (await jobOf(state, job.id))!
      expect(back.state.clockHost).toBeUndefined()
      expect(back.state.nextRunAtMs).toBeUndefined()
      expect(back.state.clockReturned).toEqual({ host: HOST, fromMs: atMs })
      await onTimer(state)
      await onTimer(state)
      expect(runExecutor).not.toHaveBeenCalled()
      // The host's record of that run arrives: history, the last run, and the one-shot is done.
      const deliver = recorded(atMs + 5_000)
      const r = await applyTriggerFired(state, hostRun(job.id, 1, atMs, atMs, atMs + 5_000), deliver, { fromHost: HOST })
      expect(r).toMatchObject({ found: true, delivered: true })
      const done = (await jobOf(state, job.id))!
      expect(done.enabled).toBe(false)
      expect(done.state).toMatchObject({ lastStatus: 'ok', lastRunAtMs: atMs + 1_000, fireCount: 1 })
      expect(done.state.fireLog?.[0]).toMatchObject({ outcome: 'fired', delivery: { status: 'ok', sessionId: 'sid-host' } })
      await onTimer(state)
      expect(runExecutor).not.toHaveBeenCalled()
    })
  }

  it('a recurring clock’s host runs after the release are its history, and the server runs only its own slots', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    await handOver(state, job, slot(1))
    now.value = slot(2) + 50 * 60_000
    // The host delivered 13:00 and 14:00 while the Mac slept, and had 15:00 next.
    const p = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('mac'))
    await p.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(3), pending: 2 }] })
    expect((await jobOf(state, job.id))!.state.nextRunAtMs).toBe(slot(3))
    for (const n of [1, 2]) {
      const r = await applyTriggerFired(state, hostRun(job.id, n, slot(n), slot(1), slot(n) + 5_000), recorded(slot(n) + 5_000), { fromHost: HOST })
      expect(r).toMatchObject({ delivered: true })
    }
    const after = (await jobOf(state, job.id))!
    expect(after.state.nextRunAtMs).toBe(slot(3))
    expect(after.state.fireLog?.map((f) => f.atMs)).toEqual([slot(2) + 1_000, slot(1) + 1_000])
    await onTimer(state)
    expect(runExecutor).not.toHaveBeenCalled()
    now.value = slot(3) + 1
    await onTimer(state)
    expect(runExecutor).toHaveBeenCalledTimes(1)
  })
})

describe('Run now on a hosted clock, then the clock comes back', () => {
  async function scenario(state: CronServiceState): Promise<CronJob> {
    const job = await ops.add(state, sessionRoutine({ name: 'Guarded' }))
    await handOver(state, job, slot(1))
    // The host ran 13:00 (owed: the Mac was away) and reports 14:00 next.
    now.value = slot(1) + 20 * 60_000
    const p = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('host'))
    await p.applied({ clocks: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(2) }] })
    // The user presses Run now: the server runs it, and its row is in the History.
    expect(await ops.run(state, job.id, 'force')).toMatchObject({ ran: true })
    expect(runExecutor).toHaveBeenCalledTimes(1)
    const ran = (await jobOf(state, job.id))!
    expect(ran.state.fireLog?.[0]).toMatchObject({ outcome: 'fired', manual: true })
    return job
  }

  it('leaves no due slot the timer refuses, and the held 13:00 run is not run a second time', async () => {
    const state = makeState()
    const job = await scenario(state)
    const p = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('mac'))
    await p.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(2), pending: 1 }] })
    for (let i = 0; i < 3; i++) await onTimer(state)
    expect(findDueJobs(state)).toEqual([])
    expect(nextWakeAtMs(state)).toBe(slot(2))
    expect((state.deps.log.warn as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).startsWith('replay guard'))).toEqual([])
    // The held run replays: Run now already stood for that slot.
    const deliver = vi.fn()
    const r = await applyTriggerFired(state, hostRun(job.id, 1, slot(1), slot(1)), deliver, { fromHost: HOST })
    expect(r.supersededSeqs).toEqual([1])
    expect(deliver).not.toHaveBeenCalled()
    expect(runExecutor).toHaveBeenCalledTimes(1)
  })

  it('a live timer does not spin over it', async () => {
    const state = makeState()
    const job = await scenario(state)
    const p = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('mac'))
    state.deps.cronEnabled = true
    let ticks = 0
    const warn = state.deps.log.warn as ReturnType<typeof vi.fn>
    warn.mockImplementation((m: string) => { if (String(m).startsWith('replay guard')) ticks++ })
    await p.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(2), pending: 1 }] })
    await new Promise((r) => setTimeout(r, 500))
    state.deps.cronEnabled = false
    if (state.timer) clearTimeout(state.timer)
    expect(ticks).toBe(0)
    expect(runExecutor).toHaveBeenCalledTimes(1)
  })
})

describe('a run nobody took, after the clock came back', () => {
  it('a paused routine runs none; a run the host delivered while it was paused is still its history', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    await handOver(state, job, slot(1))
    await ops.toggle(state, job.id)
    const deliver = vi.fn()
    const owed = await applyTriggerFired(state, hostRun(job.id, 1, slot(1), slot(1)), deliver, { fromHost: HOST })
    expect(owed.supersededSeqs).toEqual([1])
    expect(deliver).not.toHaveBeenCalled()
    const delivered = await applyTriggerFired(state, hostRun(job.id, 2, slot(2), slot(1), slot(2) + 5_000), recorded(slot(2) + 5_000), { fromHost: HOST })
    expect(delivered).toMatchObject({ delivered: true })
  })

  it('waits while the routine runs on the server, and is decided by its replay', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    await handOver(state, job, slot(1))
    now.value = slot(1) + 5_000
    let release!: () => void
    runExecutor.mockImplementationOnce(() => new Promise((r) => { release = () => r({ status: 'ok' }) }))
    const running = ops.run(state, job.id, 'force')
    await vi.waitFor(() => expect(runExecutor).toHaveBeenCalledTimes(1))
    const deliver = vi.fn().mockResolvedValue({ status: 'ok' })
    const held = await applyTriggerFired(state, hostRun(job.id, 1, slot(1), slot(1)), deliver, { fromHost: HOST })
    expect(held.heldSeqs).toEqual([1])
    expect(deliver).not.toHaveBeenCalled()
    release()
    await running
    // The replay a minute later: the Run now started after that slot, so it covered it.
    const later = await applyTriggerFired(state, hostRun(job.id, 1, slot(1), slot(1)), deliver, { fromHost: HOST })
    expect(later.supersededSeqs).toEqual([1])
    expect(deliver).not.toHaveBeenCalled()
  })

  it('a one-shot whose delivery failed for a moment stays on until its replay delivers it', async () => {
    const state = makeState()
    const atMs = slot(1)
    const job = await ops.add(state, sessionRoutine({ name: 'Once', schedule: { kind: 'at', at: new Date(atMs).toISOString() }, deleteAfterRun: false }))
    await handOver(state, job, atMs)
    const flaky = vi.fn().mockResolvedValueOnce({ status: 'error', error: 'tunnel down', retryable: true }).mockResolvedValue({ status: 'ok' })
    const first = await applyTriggerFired(state, hostRun(job.id, 1, atMs, atMs), flaky, { fromHost: HOST })
    expect(first.retry).toBe(true)
    expect((await jobOf(state, job.id))!.enabled).toBe(true)
    const replay = await applyTriggerFired(state, hostRun(job.id, 1, atMs, atMs), flaky, { fromHost: HOST })
    expect(replay).toMatchObject({ delivered: true, retry: false })
    expect((await jobOf(state, job.id))!.enabled).toBe(false)
  })

  it('a run of a clock this server never handed that host is never run here', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    await handOver(state, job, slot(1))
    const deliver = vi.fn()
    const r = await applyTriggerFired(state, hostRun(job.id, 1, slot(1), slot(1)), deliver, { fromHost: 'other' })
    expect(r.supersededSeqs).toEqual([1])
    expect(deliver).not.toHaveBeenCalled()
  })
})

describe('a def the daemon refuses', () => {
  it('comes back alone and is not handed over again until the def or the connection changes', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    const other = await ops.add(state, sessionRoutine({ name: 'Other' }))
    const first = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('host'))
    expect(first.handed.sort()).toEqual([job.id, other.id].sort())
    await first.applied({ clocks: [{ id: other.id, fromMs: slot(1), nextRunAtMs: slot(1) }], released: [], refused: [{ id: job.id, error: 'trigger x: bad clock' }] })
    expect((await jobOf(state, job.id))!.state.clockHost).toBeUndefined()
    expect((await jobOf(state, other.id))!.state.clockHost).toBe(HOST)
    // The re-push after that change hands nothing: no loop.
    const again = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('host'))
    expect(again.handed).toEqual([])
    expect(again.defs.map((d) => d.id)).toEqual([other.id])
    // The server runs it meanwhile.
    now.value = slot(1) + 1
    await onTimer(state)
    expect(runExecutor).toHaveBeenCalledTimes(1)
    // A changed def, or a daemon met anew, is asked again.
    await ops.update(state, job.id, { name: 'Digest 2' })
    expect((await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('host'))).handed).toEqual([job.id])
    const job2 = await ops.add(state, sessionRoutine({ name: 'Third' }))
    const third = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('host'))
    expect(third.handed).toEqual([job2.id])
    const held = (await jobs(state)).filter((j) => j.state.clockHost === HOST && j.id !== job2.id)
    await third.applied({ clocks: held.map((j) => ({ id: j.id, fromMs: j.state.clockFromMs!, nextRunAtMs: j.state.nextRunAtMs })), refused: [{ id: job2.id, error: 'no' }] })
    expect((await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('host'))).handed).toEqual([])
    expect((await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('host'), { fresh: true })).handed).toContain(job2.id)
  })
})

describe('a config that could not be read', () => {
  it('names no hosts, so no clock moves and none comes back', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    await handOver(state, job, slot(1))
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
    await fs.writeFile(CONFIG_FILE, 'hosts: [this is: not yaml\n')
    const broken = defaultPlacementDeps()
    expect(await broken.hosts()).toBeNull()
    expect(await releaseOrphanClocks(state, await broken.hosts())).toEqual([])
    const p = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', { ...deps('host'), hosts: async () => null })
    expect(p.handed).toEqual([])
    expect(p.defs.map((d) => d.id)).toEqual([job.id])
    await p.applied({ clocks: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(1) }] })
    expect((await jobOf(state, job.id))!.state.clockHost).toBe(HOST)
    // A fresh routine is not handed over on such a config either.
    await ops.add(state, sessionRoutine({ name: 'New' }))
    expect((await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', { ...deps('host'), hosts: async () => null })).handed).toEqual([])
    expect(await takeBackStrandedClocks(serviceOf(state), await jobs(state), { ...deps('mac'), hosts: async () => null, connected: async () => false })).toEqual([])
  })
})

describe('a clock on a host that is not connected', () => {
  async function stranded(state: CronServiceState, over: Partial<CronJobCreate> = {}): Promise<CronJob> {
    const job = await ops.add(state, sessionRoutine(over))
    await handOver(state, job, slot(1))
    return job
  }
  const away = (where: 'host' | 'mac' | 'error') => deps(where, { connected: async () => false })

  it('comes back when the routine plainly left it, and stays while its session only reads as unreachable', async () => {
    const state = makeState()
    const job = await stranded(state)
    expect(await takeBackStrandedClocks(serviceOf(state), await jobs(state), away('error'))).toEqual([])
    expect(await takeBackStrandedClocks(serviceOf(state), await jobs(state), away('host'))).toEqual([])
    expect(await takeBackStrandedClocks(serviceOf(state), await jobs(state), deps('mac'))).toEqual([])
    // The task's live session is on the Mac now.
    expect(await takeBackStrandedClocks(serviceOf(state), await jobs(state), away('mac'))).toEqual([job.id])
    const back = (await jobOf(state, job.id))!
    expect(back.state.clockHost).toBeUndefined()
    expect(back.state.clockReturned).toEqual({ host: HOST, fromMs: slot(1), beforeMs: slot(1) })
  })

  it('comes back when the routine stops qualifying (now main-agent, a cron only croner reads); a paused one stays', async () => {
    const state = makeState()
    const a = await stranded(state)
    const b = await ops.add(state, sessionRoutine({ name: 'B' }))
    const c = await ops.add(state, sessionRoutine({ name: 'C' }))
    await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('host'))
    await ops.update(state, a.id, { executor: { type: 'main-agent', config: { text: 'hi' } } } as never)
    await ops.update(state, b.id, { schedule: { kind: 'cron', expr: '0 9 * * 1#2', tz: 'UTC' } })
    await ops.toggle(state, c.id)
    const back = await takeBackStrandedClocks(serviceOf(state), await jobs(state), away('host'))
    expect(back.sort()).toEqual([a.id, b.id].sort())
    expect((await jobOf(state, c.id))!.state.clockHost).toBe(HOST)
  })

  it('the server runs it from there; the host’s runs of that time are matched by their slot', async () => {
    const state = makeState()
    const job = await stranded(state)
    now.value = slot(1) + 30_000
    expect(await takeBackStrandedClocks(serviceOf(state), await jobs(state), away('mac'))).toEqual([job.id])
    await onTimer(state)
    expect(runExecutor).toHaveBeenCalledTimes(1)
    // The host reconnects: it gives the clock back, and replays what it made meanwhile.
    const p = await placeClocksForHost(serviceOf(state), HOST, await jobs(state), 'yes', deps('mac'))
    expect(p.defs).toEqual([])
    await p.applied({ clocks: [], released: [{ id: job.id, fromMs: slot(1), nextRunAtMs: slot(3), pending: 2 }] })
    // 13:00 nobody took: the server ran that slot. 14:00 it delivered there: history, and the slot it covered.
    const deliver = vi.fn()
    expect((await applyTriggerFired(state, hostRun(job.id, 1, slot(1), slot(1)), deliver, { fromHost: HOST })).supersededSeqs).toEqual([1])
    expect(deliver).not.toHaveBeenCalled()
    now.value = slot(2) + 10 * 60_000
    await applyTriggerFired(state, hostRun(job.id, 2, slot(2), slot(1), slot(2) + 5_000), recorded(slot(2) + 5_000), { fromHost: HOST })
    // The timer's next tick reads the store without a recompute: the run itself moved the slot on.
    await onTimer(state)
    expect(runExecutor).toHaveBeenCalledTimes(1)
    expect((await jobOf(state, job.id))!.state.nextRunAtMs).toBe(slot(3))
    // 15:00 nobody took, arriving before the server's own tick: that slot is the server's.
    now.value = slot(3) + 10_000
    expect((await applyTriggerFired(state, hostRun(job.id, 3, slot(3), slot(1)), deliver, { fromHost: HOST })).supersededSeqs).toEqual([3])
    expect(deliver).not.toHaveBeenCalled()
    await onTimer(state)
    expect(runExecutor).toHaveBeenCalledTimes(2)
  })
})

describe('what the push carries', () => {
  it('the last run, so a host never repeats a slot the routine already ran elsewhere', async () => {
    const state = makeState()
    const job = await ops.add(state, sessionRoutine())
    // An older Mac ran it itself at 15:30 while the clock still read as the host's.
    await handOver(state, job, slot(1))
    const stored = (await jobs(state)).find((j) => j.id === job.id)!
    stored.state.lastRunAtMs = slot(3) + 30 * 60_000
    expect(clockDefOf(stored, 'task-remote')?.clock).toMatchObject({ fromMs: slot(1), notBeforeMs: slot(3) + 30 * 60_000 })
  })

  it('a pause, an edit and a delete reach the clock’s host at once', async () => {
    const state = makeState()
    cron.service = new CronService({ ...state.deps, storePath: path.join(dir, 'core.json') } as never)
    const service = cron.service as CronService
    const job = await service.add(sessionRoutine())
    await service.placeClocks(HOST, { wanted: new Set([job.id]), handover: true, knownHosts: new Set([HOST]), eligible: () => true })
    await routinesCore.toggleRoutine(job.id)
    await vi.waitFor(() => expect(pushed).toEqual([HOST]))
    await routinesCore.toggleRoutine(job.id)
    await vi.waitFor(() => expect(pushed).toHaveLength(2))
    await routinesCore.patchRoutine(job.id, { name: 'Renamed' })
    await vi.waitFor(() => expect(pushed).toHaveLength(3))
    await routinesCore.deleteRoutine(job.id)
    await vi.waitFor(() => expect(pushed).toEqual([HOST, HOST, HOST, HOST]))
  })
})
