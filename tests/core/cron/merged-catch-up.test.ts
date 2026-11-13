/**
 * Slots that could not run are caught up by one run, never skipped and never called missed
 * (src/core/cron/run-log.ts runSlots, timer.ts executeJob).
 *
 * 2026-11-12, two reports:
 *  - Operations: Inbox Triage's 16:20 run waited for a free slot on a full Mac. Every run after
 *    it declined with "the previous run has not started yet", and that skip covered its slot, so
 *    those slots were neither run nor missed, and nothing ran once the wait ended.
 *  - Another team: a missed-run notice went out for a routine whose run came due while the Walnut
 *    server itself was down, although the boot ran it late (and a second slot of the same
 *    downtime had no run at all).
 *
 * Here: a held run keeps its slot owed, looks again soon, and the first run that goes ahead
 * stands for every owed slot; a run after a downtime stands for every slot of it; neither is a
 * missed run, while a run that really fails still is, for each slot it stood for; a slot a
 * person set aside is never caught up.
 *
 * A real cron store on disk, the real timer and boot, a fake clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { onTimer } from '../../../src/core/cron/timer.js'
import {
  catchUpNote, HELD_RECHECK_MS, MISSED_GRACE_MS, missedRuns, RUN_LOG_MAX, runSlots,
} from '../../../src/core/cron/run-log.js'
import { noticeMissedRunsOnce } from '../../../src/core/routines/missed-runs.js'
import type { CronJob, CronJobCreate, CronServiceState } from '../../../src/core/cron/types.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
// 2026-11-12 16:00 UTC. Hourly routines run at :20, daily ones at 08:00.
const BASE = Date.UTC(2026, 10, 12, 16, 0, 0)
const S1 = Date.UTC(2026, 10, 12, 16, 20, 0)
const D1 = Date.UTC(2026, 10, 13, 8, 0, 0)
const WAITING = 't-waiting-run'
/** The claude-code executor's summary for a run whose session waits for a free slot. */
const QUEUED = `Task ${WAITING} is waiting for a free slot (/tmp/x); not started yet, Walnut starts this run automatically when there is room`

let now: { value: number }
let counter = 0
/** While true, the init processor declines: the earlier run has not started. */
let holding: boolean
/** What the executor answers next, run by run; ok once the list is empty. */
let answers: Array<{ status: 'ok' | 'error'; error?: string; retryable?: boolean; summary?: string }>
/** Each executor call: when, its message and ctx, and the run time the start is keyed by (runningAtMs). */
let executed: Array<{ at: number; message: string; ctx?: { runForMs?: number }; runningAtMs?: number }>
/** Called inside every executor run: the missed-run sweep fired while a run was going. */
let duringRun: (() => Promise<void>) | undefined

function makeState(storePath = path.join(WALNUT_HOME, `cron-${++counter}.json`), cronEnabled = false): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return {
    deps: {
      nowMs: () => now.value,
      log,
      storePath,
      cronEnabled,
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok' }),
      runAction: vi.fn(async () => holding
        ? { status: 'skipped' as const, summary: `The previous run (task ${WAITING}) has not started yet.`, heldBy: WAITING }
        : { status: 'ok' as const, summary: 'BATCH' }),
      runExecutor: vi.fn(async (job: CronJob, _executor, message: string, ctx?: { runForMs?: number }) => {
        executed.push({ at: now.value, message, ...(ctx ? { ctx } : {}), runningAtMs: job.state.runningAtMs })
        await duringRun?.()
        now.value += 1_000
        const a = answers.shift() ?? { status: 'ok' as const }
        return a.status === 'ok'
          ? { status: 'ok' as const, summary: a.summary ?? 'Started Claude Code session for task t-run' }
          : { status: 'error' as const, error: a.error, ...(a.retryable ? { retryable: true } : {}) }
      }),
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  }
}

const triage: CronJobCreate = {
  name: 'Inbox Triage', enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '20 * * * *', tz: 'UTC' },
  initProcessor: { actionId: 'inbox-triage-batch' },
  executor: { type: 'claude-code', config: { instructions: 'Triage the batch.', cwd: '/tmp/x' } },
}
const daily: CronJobCreate = {
  name: 'reflection', enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' },
  executor: { type: 'claude-code', config: { instructions: 'Reflect.', cwd: '/tmp/x' } },
}

async function stored(state: CronServiceState, id: string): Promise<CronJob> {
  const j = (await ops.list(state, { includeDisabled: true, recompute: false })).find((x) => x.id === id)
  if (!j) throw new Error(`no job ${id}`)
  return j
}

async function tickAt(state: CronServiceState, at: number): Promise<void> {
  now.value = at
  await onTimer(state)
}

/** The routines layer's missed-run sweep, over this store, with a fake owner. */
function sweep(state: CronServiceState) {
  const tellTeam = vi.fn(async () => true)
  const bell = vi.fn(async () => {})
  const pass = () => noticeMissedRunsOnce({
    service: async () => ({
      list: (opts) => ops.list(state, { ...opts, recompute: false }),
      markMissed: (id, mark) => ops.markMissed(state, id, mark),
    }),
    tellTeam, bell, mainTaskId: async () => 'main-task', now: () => now.value,
  })
  return { pass, tellTeam, bell }
}

/** A server that comes back up at `at` on the same store: a new process, no replay guard. */
async function bootAt(storePath: string, at: number): Promise<CronServiceState> {
  now.value = at
  const state = makeState(storePath, true)
  await ops.start(state)
  ops.stop(state)
  return state
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  now = { value: BASE }
  holding = false
  answers = []
  executed = []
  duringRun = undefined
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a run held behind an earlier one that has not started (deliverable 3)', () => {
  /** 16:20 is dispatched and its session waits (T1); 17:20 and 18:20 are held behind it. */
  async function heldThroughTwoSlots(state: CronServiceState): Promise<string> {
    const job = await ops.add(state, triage)
    answers = [{ status: 'ok', summary: QUEUED }]
    await tickAt(state, S1 + 5)
    expect(executed).toHaveLength(1)
    holding = true
    await tickAt(state, S1 + HOUR + 5)
    let j = await stored(state, job.id)
    // Held: not a run, not a skip that settles the slot. Owed, looked at again in 10 min.
    expect(executed).toHaveLength(1)
    expect(j.state.runLog?.[0]).toMatchObject({ status: 'skipped', slotMs: S1 + HOUR, heldBy: WAITING })
    expect(j.state.runLog?.[0].willRetryAtMs).toBeUndefined()
    expect(j.state.owedFromMs).toBe(S1 + HOUR)
    expect(j.state.retrySlotMs).toBe(S1 + HOUR)
    expect(j.state.nextRunAtMs).toBe(S1 + HOUR + 5 + HELD_RECHECK_MS)
    // Still held at every look again (17:30 ... 18:10) and at 18:20: one row for the whole wait.
    while ((j = await stored(state, job.id)).state.nextRunAtMs! < S1 + 2 * HOUR + MIN) await tickAt(state, j.state.nextRunAtMs!)
    expect(executed).toHaveLength(1)
    expect(j.state.runLog).toHaveLength(2)
    expect(j.state.runLog?.[0]).toMatchObject({ status: 'skipped', slotMs: S1 + 2 * HOUR, firstSlotMs: S1 + HOUR, heldBy: WAITING, repeats: 7 })
    expect(j.state.runLog?.[0].attempt).toBeUndefined()
    expect(j.state.owedFromMs).toBe(S1 + HOUR)
    expect(j.state.nextRunAtMs).toBe(S1 + 2 * HOUR + HELD_RECHECK_MS)
    // Long past the grace, nothing is missed: a run still to come stands for those slots.
    expect(missedRuns(j, S1 + 2 * HOUR + 5 + MISSED_GRACE_MS + MIN)).toEqual([])
    return job.id
  }

  it('T1 starts: the next run stands for the held slots only, never claims T1 did not happen', async () => {
    const state = makeState()
    const id = await heldThroughTwoSlots(state)
    holding = false
    let j = await stored(state, id)
    const at = j.state.nextRunAtMs!
    await tickAt(state, at)
    j = await stored(state, id)
    expect(executed).toHaveLength(2)
    expect(j.state.runLog?.[0]).toMatchObject({ status: 'ok', slotMs: S1 + 2 * HOUR, firstSlotMs: S1 + HOUR })
    expect(j.state.runLog?.[0].heldBy).toBeUndefined()
    expect(executed[1].message.startsWith(catchUpNote(S1 + HOUR, at, S1 + 2 * HOUR))).toBe(true)
    expect(executed[1].message).toContain('BATCH')
    expect(executed[1].ctx).toEqual({ runForMs: S1 + HOUR })
    expect(j.state.owedFromMs).toBeUndefined()
    expect(j.state.retrySlotMs).toBeUndefined()
    expect(j.state.nextRunAtMs).toBe(S1 + 3 * HOUR)
    expect(missedRuns(j, S1 + 3 * HOUR - MIN)).toEqual([])
  })

  it('T1 recorded failed while runs are held behind it: the run that ends the backlog stands for T1’s slot too', async () => {
    const state = makeState()
    const id = await heldThroughTwoSlots(state)
    await ops.recordRunStartFailure(state, id, { runAtMs: S1 + 5, error: 'the session never started', ref: WAITING })
    let j = await stored(state, id)
    expect(j.state.runLog?.at(-1)).toMatchObject({ slotMs: S1, status: 'error' })
    expect(j.state.owedFromMs).toBe(S1)
    // Owed: not missed while the backlog lasts.
    expect(missedRuns(j, S1 + 2 * HOUR + 5 + MISSED_GRACE_MS + MIN)).toEqual([])
    // T1's claim is let go, so the next look again goes ahead with its batch: one run, 16:20 to 18:20.
    holding = false
    const at = j.state.nextRunAtMs!
    await tickAt(state, at)
    j = await stored(state, id)
    expect(executed).toHaveLength(2)
    expect(j.state.runLog?.[0]).toMatchObject({ status: 'ok', slotMs: S1 + 2 * HOUR, firstSlotMs: S1 })
    expect(executed[1].message.startsWith(catchUpNote(S1, at, S1 + 2 * HOUR))).toBe(true)
    expect(executed[1].ctx).toEqual({ runForMs: S1 })
    expect(j.state.owedFromMs).toBeUndefined()
    expect(missedRuns(j, S1 + 3 * HOUR - MIN)).toEqual([])
  })

  it('T1 recorded failed after the backlog was settled: its slot is a missed run with its error, and nothing runs again', async () => {
    const state = makeState()
    const id = await heldThroughTwoSlots(state)
    holding = false
    await tickAt(state, (await stored(state, id)).state.nextRunAtMs!)
    const before = await stored(state, id)
    await ops.recordRunStartFailure(state, id, { runAtMs: S1 + 5, error: 'the session never started', ref: WAITING })
    const j = await stored(state, id)
    expect(j.state.owedFromMs).toBeUndefined()
    expect(j.state.nextRunAtMs).toBe(before.state.nextRunAtMs)
    expect(executed).toHaveLength(2)
    expect(missedRuns(j, S1 + 3 * HOUR - MIN)).toEqual([expect.objectContaining({ slotMs: S1, reason: 'the session never started' })])
  })

  it('a waiting run that fails with no run held behind it is still a missed run, with its error', async () => {
    const state = makeState()
    const job = await ops.add(state, triage)
    answers = [{ status: 'ok', summary: QUEUED }]
    await tickAt(state, S1 + 5)
    await ops.recordRunStartFailure(state, job.id, { runAtMs: S1 + 5, error: 'the session never started', ref: WAITING })
    const j = await stored(state, job.id)
    expect(missedRuns(j, S1 + HOUR - MIN)).toEqual([expect.objectContaining({ slotMs: S1, reason: 'the session never started' })])
  })

  it('a wake routine keeps the items a held run never looked at, so its look again is not "no new items"', async () => {
    const state = makeState()
    const job = await ops.add(state, { ...triage, wake: { events: ['mail'], threshold: 0, skipWhenIdle: true } })
    await ops.bumpWake(state, job.id, 3)
    holding = true
    await tickAt(state, S1 + 5)
    let j = await stored(state, job.id)
    expect(j.state.wakeCount).toBe(3)
    holding = false
    await tickAt(state, j.state.nextRunAtMs!)
    j = await stored(state, job.id)
    expect(executed).toHaveLength(1)
    expect(j.state.runLog?.[0]).toMatchObject({ status: 'ok', slotMs: S1 })
    expect(j.state.wakeCount).toBe(0)
  })

  it('a daily routine held at 08:00 looks again in minutes, not the next morning', async () => {
    const state = makeState()
    const job = await ops.add(state, { ...daily, initProcessor: { actionId: 'batch' } })
    holding = true
    await tickAt(state, D1 + 5)
    let j = await stored(state, job.id)
    expect(j.state.nextRunAtMs).toBe(D1 + 5 + HELD_RECHECK_MS)
    holding = false
    await tickAt(state, j.state.nextRunAtMs!)
    j = await stored(state, job.id)
    expect(executed).toHaveLength(1)
    expect(j.state.runLog?.[0]).toMatchObject({ status: 'ok', slotMs: D1 })
    expect(j.state.nextRunAtMs).toBe(D1 + DAY)
  })

  it('the owed run then failing for real is a missed run for each slot it stood for, with its error', async () => {
    const state = makeState()
    const job = await ops.add(state, triage)
    holding = true
    await tickAt(state, S1 + 5)
    let j = await stored(state, job.id)
    while ((j = await stored(state, job.id)).state.nextRunAtMs! < S1 + HOUR + MIN) await tickAt(state, j.state.nextRunAtMs!)
    holding = false
    answers = [{ status: 'error', error: "unknown host 'gone'" }]
    await tickAt(state, j.state.nextRunAtMs!)
    j = await stored(state, job.id)
    expect(j.state.owedFromMs).toBeUndefined()
    expect(missedRuns(j, S1 + 2 * HOUR - MIN).map((m) => [m.slotMs, m.reason])).toEqual([
      [S1 + HOUR, "unknown host 'gone'"],
      [S1, "unknown host 'gone'"],
    ])
  })

  it('a frequent routine is not judged slot by slot: it keeps its own cadence and its items', async () => {
    const state = makeState()
    const job = await ops.add(state, { ...triage, schedule: { kind: 'every', everyMs: 5 * MIN, anchorMs: BASE }, wake: { events: ['mail'], threshold: 0 } })
    await ops.bumpWake(state, job.id, 2)
    holding = true
    await tickAt(state, BASE + 5 * MIN + 5)
    const j = await stored(state, job.id)
    expect(j.state.nextRunAtMs).toBe(BASE + 10 * MIN)
    expect(j.state.owedFromMs).toBeUndefined()
    expect(j.state.wakeCount).toBe(2)
  })
})

describe('slots that came due while the server was down (deliverable 4)', () => {
  it('the boot runs once for every one of them, and the sweep tells nothing, even while that run is going', async () => {
    const storePath = path.join(WALNUT_HOME, 'down', 'cron-jobs.json')
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    const first = makeState(storePath)
    const job = await ops.add(first, daily)
    const other = await ops.add(first, { ...daily, name: 'second' })
    await tickAt(first, D1 + 5)
    expect(executed).toHaveLength(2)

    // Down from day 1 09:00 to day 3 10:00: the 08:00 slots of days 2 and 3 came due meanwhile.
    const told: number[] = []
    let seen = 0
    duringRun = async () => {
      const s = sweep(first)
      told.push(await s.pass())
      seen += s.tellTeam.mock.calls.length + s.bell.mock.calls.length
    }
    const up = D1 + 2 * DAY + 2 * HOUR
    const state = await bootAt(storePath, up)
    expect(executed).toHaveLength(4)
    // The sweep ran inside both boot runs (the second routine not yet caught up): nobody was told.
    expect(told).toEqual([0, 0])
    expect(seen).toBe(0)
    for (const id of [job.id, other.id]) {
      const j = await stored(state, id)
      expect(j.state.runLog?.[0]).toMatchObject({ status: 'ok', slotMs: D1 + 2 * DAY, firstSlotMs: D1 + DAY })
      expect(j.state.nextRunAtMs).toBe(D1 + 3 * DAY)
      expect(missedRuns(j, up + HOUR)).toEqual([])
    }
    // It knows it is late and which runs it stands for.
    expect(executed[2].message.startsWith(catchUpNote(D1 + DAY, up, D1 + 2 * DAY))).toBe(true)
    expect(executed[2].ctx).toEqual({ runForMs: D1 + DAY })
    // The start is keyed by its dispatch time, not the slot 26 h back: run-start.ts's 6 h stale
    // rule (a start picked up long after it was made) never fails a catch-up as stale.
    expect(executed[2].runningAtMs).toBe(up)
    duringRun = undefined
    const after = sweep(state)
    expect(await after.pass()).toBe(0)
  })

  it('real density: an hourly routine with a full history, down for days, then a month of runs: nothing is ever missed', async () => {
    const storePath = path.join(WALNUT_HOME, 'dense', 'cron-jobs.json')
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    const first = makeState(storePath)
    const job = await ops.add(first, triage)
    // A full history first: RUN_LOG_MAX hourly runs.
    for (let i = 0; i < RUN_LOG_MAX; i++) await tickAt(first, S1 + i * HOUR + 5)
    expect((await stored(first, job.id)).state.runLog).toHaveLength(RUN_LOG_MAX)

    for (const downHours of [72, 240]) {
      executed = []
      const last = (await stored(first, job.id)).state.nextRunAtMs!
      // Down from just before `last` for `downHours` (240 h is past the 7-day lookback).
      const up = last + downHours * HOUR + 30 * MIN
      const state = await bootAt(storePath, up)
      let j = await stored(state, job.id)
      expect(executed).toHaveLength(1)
      const row = j.state.runLog![0]
      expect(row).toMatchObject({ status: 'ok', slotMs: last + downHours * HOUR })
      // Past the lookback too, the row starts at the first unrun slot: the range covers every one.
      expect(row.firstSlotMs).toBe(last)
      expect(missedRuns(j, up + MIN)).toEqual([])
      const s = sweep(state)
      now.value = up + 2 * MIN
      expect(await s.pass()).toBe(0)

      // Then RUN_LOG_MAX + 5 more hourly runs trim the merged row off the history: still nothing missed.
      for (let i = 1; i <= RUN_LOG_MAX + 5; i++) {
        await tickAt(state, (await stored(state, job.id)).state.nextRunAtMs! + 5)
        j = await stored(state, job.id)
        expect(missedRuns(j, now.value + MIN), `${downHours} h down, run ${i} after`).toEqual([])
      }
      expect(j.state.runLog).toHaveLength(RUN_LOG_MAX)
      expect(j.state.runLog!.some((e) => e.firstSlotMs !== undefined)).toBe(false)
      now.value += 2 * MIN
      expect(await sweep(state).pass()).toBe(0)
    }
  })

  it('a single slot run late by the boot is a catch-up too, and not missed', async () => {
    const storePath = path.join(WALNUT_HOME, 'late', 'cron-jobs.json')
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    const job = await ops.add(makeState(storePath), daily)
    const up = D1 + 3 * HOUR
    const state = await bootAt(storePath, up)
    const j = await stored(state, job.id)
    expect(j.state.runLog?.[0]).toMatchObject({ status: 'ok', slotMs: D1 })
    expect(j.state.runLog?.[0].firstSlotMs).toBeUndefined()
    expect(executed[0].message.startsWith(catchUpNote(D1, up))).toBe(true)
    expect(missedRuns(j, up + HOUR)).toEqual([])
  })

  it('a boot catch-up that really fails is a missed run for each slot, with its error: the notice still goes', async () => {
    const storePath = path.join(WALNUT_HOME, 'fail', 'cron-jobs.json')
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    const job = await ops.add(makeState(storePath), daily)
    answers = [{ status: 'error', error: 'the executor refused' }]
    const up = D1 + DAY + 2 * HOUR
    const state = await bootAt(storePath, up)
    const j = await stored(state, job.id)
    expect(missedRuns(j, up + HOUR).map((m) => [m.slotMs, m.reason])).toEqual([
      [D1 + DAY, 'the executor refused'],
      [D1, 'the executor refused'],
    ])
    const s = sweep(state)
    now.value = up + HOUR
    expect(await s.pass()).toBe(1)
    expect(s.tellTeam).toHaveBeenCalledTimes(1)
  })

  it('a slot a person set aside is never caught up; when every slot was, nothing runs', () => {
    const job = {
      id: 'x', name: 'x', enabled: true, createdAtMs: D1 - 10 * DAY, updatedAtMs: 0, sessionTarget: 'isolated', wakeMode: 'now',
      schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' }, payload: { kind: 'agentTurn', message: '' },
      state: { nextRunAtMs: D1, missedDismissedMs: [D1 + DAY] },
    } as unknown as CronJob
    // Days 1..3 came due; day 2 was set aside: the run stands for days 1 and 3 (the range), never asked to redo day 2 alone.
    expect(runSlots(job, D1 + 2 * DAY + HOUR)).toEqual({ slotMs: D1 + 2 * DAY, firstSlotMs: D1, late: true })
    job.state.missedDismissedMs = [D1, D1 + DAY]
    expect(runSlots(job, D1 + DAY + HOUR)).toBeNull()
  })

  it('every slot set aside: the timer makes no run and moves to the next slot', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    await ops.update(state, job.id, { state: { missedDismissedMs: [D1] } })
    await tickAt(state, D1 + 5)
    const j = await stored(state, job.id)
    expect(executed).toHaveLength(0)
    expect(j.state.runLog ?? []).toEqual([])
    expect(j.state.nextRunAtMs).toBe(D1 + DAY)
    expect(j.state.runningAtMs).toBeUndefined()
  })
})
