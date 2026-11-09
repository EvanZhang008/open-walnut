/**
 * A routine's run history and the runs it missed (src/core/cron/run-log.ts, timer.ts).
 *
 * 2026-11-08: the daily org reflection (08:00 Pacific) made no task. Its run started, failed 48 s
 * later because the Mac had no room to start a session, and the error backoff put the next run on
 * the next day's slot; state kept only the last run, which the next morning replaced, and the error
 * was in no log. These pin: every run leaves a row, a start that broke is tried again inside its
 * slot, a slot that ended with no good run is a missed run (and one nobody ran at all too), a
 * catch-up names its slot, and nothing is called missed that was not expected (paused, before the
 * history began, a frequent routine).
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
import {
  appendRun, catchUpNote, missedRuns, routineOwnerTaskId, runEntry, runFailed, judgesSlots,
  MISSED_GRACE_MS, NO_RUN_REASON, RUN_LOG_MAX, SLOT_RETRIES,
} from '../../../src/core/cron/run-log.js'
import { applyClockRun } from '../../../src/core/cron/clock-fire.js'
import { scheduleNextRunAtMs } from '../../../src/core/cron/jobs.js'
import { catchUpTitle } from '../../../src/core/routines/executors/claude-code.js'
import { runEntryFailed } from '../../../web/src/utils/routine-runs.js'
import type { CronJob, CronJobCreate, CronServiceState, RoutineRunEntry } from '../../../src/core/cron/types.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
// 2026-11-08 07:00 UTC; the routine runs daily at 08:00 UTC.
const BASE = Date.UTC(2026, 10, 8, 7, 0, 0)
const SLOT1 = Date.UTC(2026, 10, 8, 8, 0, 0)
const NO_ROOM = 'Not started: this Mac had no room for 1 minute (4 of 4 starts running).'

let dir: string
let counter = 0
let now: { value: number }
/** What the executor answers next, run by run; ok once the list is empty. */
let answers: Array<{ status: 'ok' | 'error'; error?: string; retryable?: boolean }>
let runs: number[]

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
      runExecutor: vi.fn(async () => {
        runs.push(now.value)
        // The 2026-11-08 run took 48 s before it gave up.
        now.value += 48_000
        const a = answers.shift() ?? { status: 'ok' as const }
        return a.status === 'ok' ? { status: 'ok' as const, summary: 'Started Claude Code session for task t1' } : { status: 'error' as const, error: a.error, ...(a.retryable ? { retryable: true } : {}) }
      }),
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  }
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

/** Tick the timer at `at` (it runs whatever is due then). */
async function tickAt(state: CronServiceState, at: number): Promise<void> {
  now.value = at
  await onTimer(state)
}

beforeEach(async () => {
  dir = WALNUT_HOME
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  now = { value: BASE }
  answers = []
  runs = []
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('every run leaves a row', () => {
  it('a good run of a claude-code routine: its slot, its time, what it said', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    await tickAt(state, SLOT1 + 5)
    const j = await stored(state, job.id)
    expect(j.state.runLog).toEqual([expect.objectContaining({ atMs: SLOT1 + 5, slotMs: SLOT1, status: 'ok', durationMs: 48_000, summary: 'Started Claude Code session for task t1' })])
    expect(j.state.runLogSinceMs).toBe(BASE)
    expect(missedRuns(j, SLOT1 + 2 * HOUR)).toEqual([])
  })

  it('the history is bounded, and identical skips in a row are one row', () => {
    let log: RoutineRunEntry[] | undefined
    for (let i = 0; i < RUN_LOG_MAX + 5; i++) log = appendRun(log, runEntry({ atMs: i, durationMs: 1, status: 'ok' }))
    expect(log).toHaveLength(RUN_LOG_MAX)
    expect(log![0].atMs).toBe(RUN_LOG_MAX + 4)
    let skips: RoutineRunEntry[] | undefined
    const next = (s: number) => s + 1
    for (let i = 0; i < 4; i++) skips = appendRun(skips, runEntry({ atMs: 100 + i, slotMs: 100 + i, durationMs: 0, status: 'skipped', summary: 'no new items' }), next)
    expect(skips).toEqual([expect.objectContaining({ atMs: 103, repeats: 4, firstAtMs: 100, firstSlotMs: 100, slotMs: 103 })])
  })
})

describe('the 2026-11-08 morning: a start with no room on the Mac', () => {
  it('is tried again inside its slot, not a day later, and reads as one slot that ran', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    answers = [{ status: 'error', error: NO_ROOM, retryable: true }]
    await tickAt(state, SLOT1 + 5)
    let j = await stored(state, job.id)
    const failedAt = SLOT1 + 5 + 48_000
    // Before: max(30 s backoff, next slot) = the next day.
    expect(j.state.nextRunAtMs).toBe(failedAt + 30_000)
    expect(j.state.retrySlotMs).toBe(SLOT1)
    expect(j.state.runLog?.[0]).toMatchObject({ status: 'error', error: NO_ROOM, slotMs: SLOT1, willRetryAtMs: failedAt + 30_000 })
    // Its error is in the log, which it never was.
    expect((state.deps.log.warn as ReturnType<typeof vi.fn>).mock.calls.some(([msg, data]) => msg === 'routine run failed' && data?.error === NO_ROOM)).toBe(true)
    // A retry still to come: not missed, even past the grace.
    expect(missedRuns(j, failedAt + 20_000 + MISSED_GRACE_MS)).toEqual([])

    await tickAt(state, failedAt + 30_000)
    j = await stored(state, job.id)
    expect(runs).toHaveLength(2)
    expect(j.state.runLog?.[0]).toMatchObject({ status: 'ok', slotMs: SLOT1, attempt: 2 })
    expect(j.state.retrySlotMs).toBeUndefined()
    expect(j.state.nextRunAtMs).toBe(SLOT1 + DAY)
    expect(missedRuns(j, SLOT1 + 3 * HOUR)).toEqual([])
  })

  it('gives the slot up after its tries, and then the slot is a missed run with the error', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    answers = Array.from({ length: SLOT_RETRIES + 1 }, () => ({ status: 'error' as const, error: NO_ROOM, retryable: true }))
    await tickAt(state, SLOT1 + 5)
    for (let i = 0; i < SLOT_RETRIES; i++) {
      const j = await stored(state, job.id)
      await tickAt(state, j.state.nextRunAtMs!)
    }
    const j = await stored(state, job.id)
    expect(runs).toHaveLength(SLOT_RETRIES + 1)
    expect(j.state.nextRunAtMs).toBe(SLOT1 + DAY)
    expect(j.state.retrySlotMs).toBeUndefined()
    expect(j.state.runLog?.[0]).toMatchObject({ attempt: SLOT_RETRIES + 1, status: 'error' })
    expect(j.state.runLog?.[0].willRetryAtMs).toBeUndefined()
    expect(missedRuns(j, SLOT1 + 2 * HOUR)).toEqual([{ slotMs: SLOT1, reason: NO_ROOM, failedAtMs: j.state.runLog![0].atMs }])
  })

  it('counts its tries per slot: yesterday’s failures leave today its own tries', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    answers = Array.from({ length: SLOT_RETRIES + 2 }, () => ({ status: 'error' as const, error: NO_ROOM, retryable: true }))
    await tickAt(state, SLOT1 + 5)
    for (let i = 0; i < SLOT_RETRIES; i++) await tickAt(state, (await stored(state, job.id)).state.nextRunAtMs!)
    // The next day's first try fails too: it still gets a try again in its slot.
    await tickAt(state, SLOT1 + DAY + 5)
    const j = await stored(state, job.id)
    expect(j.state.retrySlotMs).toBe(SLOT1 + DAY)
    expect(j.state.nextRunAtMs).toBe(SLOT1 + DAY + 5 + 48_000 + 30_000)
  })

  it('a routine more frequent than hourly keeps the plain backoff: its next slot is soon anyway', async () => {
    const state = makeState()
    const job = await ops.add(state, { ...daily, name: 'often', schedule: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' } })
    answers = [{ status: 'error', error: NO_ROOM, retryable: true }]
    await tickAt(state, SLOT1 + 5)
    const j = await stored(state, job.id)
    expect(j.state.retrySlotMs).toBeUndefined()
    expect(j.state.nextRunAtMs).toBe(SLOT1 + 5 * MIN)
  })

  it('a refusal (not a break) is not tried again: the slot is missed with its reason', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    answers = [{ status: 'error', error: "unknown host 'gone'" }]
    await tickAt(state, SLOT1 + 5)
    const j = await stored(state, job.id)
    expect(j.state.nextRunAtMs).toBe(SLOT1 + DAY)
    expect(missedRuns(j, SLOT1 + HOUR)).toEqual([expect.objectContaining({ slotMs: SLOT1, reason: "unknown host 'gone'" })])
    // Inside the grace a slot is not judged yet.
    expect(missedRuns(j, SLOT1 + MISSED_GRACE_MS - 1)).toEqual([])
  })
})

describe('a slot nothing ran for', () => {
  it('is a missed run: the timer made one late run for the oldest slot, and the next day had none', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    await tickAt(state, SLOT1 + 5)
    // The server is down from day 2 07:00 to day 3 09:00: one late run, for day 2's slot.
    await tickAt(state, SLOT1 + 2 * DAY + HOUR)
    const j = await stored(state, job.id)
    expect(j.state.runLog?.[0]).toMatchObject({ slotMs: SLOT1 + DAY, status: 'ok' })
    expect(missedRuns(j, SLOT1 + 2 * DAY + 2 * HOUR)).toEqual([{ slotMs: SLOT1 + 2 * DAY, reason: NO_RUN_REASON }])
  })

  it('a catch-up run for it covers it, and its row names the slot', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    answers = [{ status: 'error', error: "unknown host 'gone'" }]
    await tickAt(state, SLOT1 + 5)
    now.value = SLOT1 + 3 * HOUR
    await ops.run(state, job.id, 'force', { catchUpMs: SLOT1 })
    const j = await stored(state, job.id)
    expect(j.state.runLog?.[0]).toMatchObject({ manual: true, catchUpMs: SLOT1, status: 'ok' })
    expect(j.state.runLog?.[0].slotMs).toBeUndefined()
    expect(missedRuns(j, SLOT1 + 4 * HOUR)).toEqual([])
    // A Run now that names no slot does not cover one far from it.
  })

  it('Dismiss sets it aside', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    answers = [{ status: 'error', error: 'boom' }]
    await tickAt(state, SLOT1 + 5)
    expect(missedRuns(await stored(state, job.id), SLOT1 + HOUR)).toHaveLength(1)
    await ops.markMissed(state, job.id, { dismiss: [SLOT1] })
    expect(missedRuns(await stored(state, job.id), SLOT1 + HOUR)).toEqual([])
  })
})

describe('nothing is called missed that was not expected', () => {
  it('a slot it was paused through', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    await tickAt(state, SLOT1 + 5)
    await ops.toggle(state, job.id)
    now.value = SLOT1 + DAY + 3 * HOUR
    await ops.toggle(state, job.id)
    expect(missedRuns(await stored(state, job.id), SLOT1 + DAY + 4 * HOUR)).toEqual([])
  })

  it('a slot from before its history began, or before it was made', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    const j = await stored(state, job.id)
    // A routine from before this Walnut kept a history (no runLogSinceMs): nothing is judged.
    const legacy: CronJob = { ...j, state: { ...j.state, runLogSinceMs: undefined } }
    expect(missedRuns(legacy, SLOT1 + 5 * DAY)).toEqual([])
    const older: CronJob = { ...j, createdAtMs: SLOT1 - 10 * DAY, state: { ...j.state, expectFromMs: undefined, runLogSinceMs: SLOT1 + DAY + 1 } }
    expect(missedRuns(older, SLOT1 + 2 * DAY + HOUR).map((m) => m.slotMs)).toEqual([SLOT1 + 2 * DAY])
  })

  it('a routine more frequent than hourly, and a trigger, are not judged slot by slot', async () => {
    const state = makeState()
    const every = await ops.add(state, { ...daily, name: 'often', schedule: { kind: 'every', everyMs: 5 * MIN } })
    expect(judgesSlots(await stored(state, every.id), now.value)).toBe(false)
    const j = await stored(state, (await ops.add(state, daily)).id)
    expect(judgesSlots({ ...j, check: { run: "true", host: "__local__" } } as CronJob, now.value)).toBe(false)
  })

  it('a run of skips in a row stands for every slot it covered', () => {
    const job = {
      id: 'x', name: 'x', enabled: true, createdAtMs: SLOT1 - DAY, updatedAtMs: 0, sessionTarget: 'isolated', wakeMode: 'now',
      schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' }, payload: { kind: 'agentTurn', message: '' },
      state: { runLogSinceMs: SLOT1 - 1, runLog: [{ atMs: SLOT1 + 2 * DAY, slotMs: SLOT1 + 2 * DAY, status: 'skipped', durationMs: 0, summary: 'no new items', repeats: 3, firstAtMs: SLOT1, firstSlotMs: SLOT1 }] },
    } as unknown as CronJob
    expect(missedRuns(job, SLOT1 + 2 * DAY + 2 * HOUR)).toEqual([])
  })
})

describe('who hears about it, and the web twin', () => {
  it('the owner is the routine’s own owner, else a session routine’s target', () => {
    expect(routineOwnerTaskId({ ownerTaskId: 'owner-1', executor: { type: 'session', config: { target: 't' } } } as CronJob)).toBe('owner-1')
    expect(routineOwnerTaskId({ executor: { type: 'session', config: { target: ' t2 ' } } } as CronJob)).toBe('t2')
    expect(routineOwnerTaskId({ executor: { type: 'claude-code', config: {} } } as CronJob)).toBeUndefined()
  })

  it('the web reads a failed row the way the server does', () => {
    const rows: Array<Pick<RoutineRunEntry, 'status' | 'error'>> = [
      { status: 'ok' }, { status: 'error' }, { status: 'error', error: 'x' }, { status: 'skipped' }, { status: 'skipped', error: 'waits for room' },
    ]
    for (const r of rows) expect(runEntryFailed(r)).toBe(runFailed(r))
  })
})

// 2026-11-09 review of this change (seven confirmed findings), one guard each.
const hourly = (state: Partial<CronJob['state']>): CronJob => ({
  id: 'h', name: 'h', enabled: true, createdAtMs: SLOT1 - 30 * DAY, updatedAtMs: 0, sessionTarget: 'isolated', wakeMode: 'now',
  schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' }, payload: { kind: 'agentTurn', message: '' }, state: state as CronJob['state'],
} as CronJob)

describe('review findings', () => {
  it('1: rows trimmed off a full history are not runs that never happened', () => {
    let log: RoutineRunEntry[] | undefined
    for (let i = 0; i < RUN_LOG_MAX + 10; i++) log = appendRun(log, runEntry({ atMs: SLOT1 + i * HOUR + 5, slotMs: SLOT1 + i * HOUR, durationMs: 1, status: 'ok' }))
    const job = hourly({ runLogSinceMs: SLOT1 - HOUR, expectFromMs: SLOT1 - HOUR, runLog: log })
    expect(missedRuns(job, SLOT1 + (RUN_LOG_MAX + 10) * HOUR)).toEqual([])
  })

  it('2: the newest slots of a long window are judged, not cut off', () => {
    const since = SLOT1 - 7 * DAY + HOUR
    const last = SLOT1 - HOUR
    const job = hourly({
      runLogSinceMs: since, expectFromMs: since,
      runLog: [{ atMs: last + 5, slotMs: last, status: 'error', durationMs: 1, error: 'boom' }],
      missedDismissedMs: Array.from({ length: 150 }, (_, i) => since + i * HOUR).filter((s) => s !== last),
    })
    expect(missedRuns(job, SLOT1 + 10 * MIN)[0]).toMatchObject({ slotMs: last, reason: 'boom' })
  })

  it('3: identical skips merge only on the very next slot, so a day nothing ran for between them stays missed', () => {
    const daySkip = (slot: number) => runEntry({ atMs: slot + 5, slotMs: slot, durationMs: 0, status: 'skipped', summary: 'no new items' })
    const job = { ...hourly({}), schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' } } as CronJob
    const next = (s: number) => scheduleNextRunAtMs(job, s + 1)
    const log = appendRun(appendRun(undefined, daySkip(SLOT1), next), daySkip(SLOT1 + 2 * DAY), next)
    expect(log).toHaveLength(2)
    job.state = { runLogSinceMs: SLOT1 - 1, expectFromMs: SLOT1 - 1, runLog: log }
    expect(missedRuns(job, SLOT1 + 2 * DAY + HOUR)).toEqual([{ slotMs: SLOT1 + DAY, reason: NO_RUN_REASON }])
  })

  it('4: a routine made and never run reports the slots it missed', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    const j = await stored(state, job.id)
    expect(j.state.runLogSinceMs).toBe(BASE)
    expect(missedRuns(j, SLOT1 + DAY + HOUR).map((m) => m.slotMs)).toEqual([SLOT1 + DAY, SLOT1])
  })

  it('5: a host clock delivering two days at once covers both days', () => {
    const job = { ...hourly({ runLogSinceMs: SLOT1 - 1, expectFromMs: SLOT1 - 1 }), schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' } } as CronJob
    applyClockRun(job, { status: 'ok', startedAt: SLOT1 + DAY + 5, endedAt: SLOT1 + DAY + 50, retry: false, tenure: 'current', slotsMs: [SLOT1, SLOT1 + DAY] })
    expect(job.state.runLog?.[0]).toMatchObject({ slotMs: SLOT1 + DAY, alsoSlotsMs: [SLOT1] })
    expect(missedRuns(job, SLOT1 + DAY + 2 * HOUR)).toEqual([])
  })

  it('6: a start failure learned later finds its row by the run’s task, whatever time the row carries', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    await ops.update(state, job.id, { state: { runLog: [{ atMs: SLOT1 - DAY, slotMs: SLOT1 - DAY, status: 'ok', durationMs: 1, summary: 'Starting Claude Code session for task t-late (/x)' }] } })
    await ops.recordRunStartFailure(state, job.id, { runAtMs: SLOT1 + 5, error: 'the session never started', ref: 't-late' })
    expect((await stored(state, job.id)).state.runLog?.[0]).toMatchObject({ status: 'error', error: 'the session never started' })
  })

  it('7: a catch-up run tells its executor which run it stands for, and its task title says so', async () => {
    const state = makeState()
    const job = await ops.add(state, daily)
    answers = [{ status: 'error', error: 'boom' }]
    await tickAt(state, SLOT1 + 5)
    now.value = SLOT1 + 3 * HOUR
    await ops.run(state, job.id, 'force', { catchUpMs: SLOT1 })
    const calls = (state.deps.runExecutor as ReturnType<typeof vi.fn>).mock.calls
    const [, , message, ctx] = calls[calls.length - 1]
    expect(message.startsWith(catchUpNote(SLOT1, SLOT1 + 3 * HOUR))).toBe(true)
    expect(message).toContain('2026-11-08T08:00:00.000Z')
    expect(message.endsWith('Reflect.')).toBe(true)
    expect(ctx).toEqual({ runForMs: SLOT1 })
    expect(catchUpTitle('Org reflection', new Date(2026, 10, 8, 8, 0).getTime())).toBe('Org reflection (catch-up for 2026-11-08 08:00)')
    expect(catchUpTitle('Org reflection', undefined)).toBe('Org reflection')
  })
})
