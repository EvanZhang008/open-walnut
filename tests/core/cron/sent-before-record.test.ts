/**
 * A scheduled run whose work already went out (a message stored in a session's queue, a session
 * started) is recorded as having run, even when its record could not be written when the executor
 * returned: the process stopped, slept through the run's timeout, or the executor threw after the
 * send (src/core/cron/sent-run.ts, timer.ts executeJob markSent).
 *
 * 2026-11-21: "Operations VP daily reflection" sent its catch-up message during a short macOS
 * DarkWake, the Mac slept, the server was stopped before the run's record was written, and the
 * restart ran the same slot again: a second copy of the message. The same night "Personal VP daily
 * reflection" sent its message but was recorded "cron: job execution timed out" (the process slept
 * across the run) and then reported as a missed run.
 *
 * A real cron store on disk, two "processes" (two service states over the same store), the real
 * timer and boot catch-up, and a fake clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { onTimer } from '../../../src/core/cron/timer.js'
import { missedRuns } from '../../../src/core/cron/run-log.js'
import { createSessionExecutor, type SessionDelivery } from '../../../src/core/routines/executors/session.js'
import { enqueueMessage, getQueue, resetCache } from '../../../src/core/session-message-queue.js'
import type { CronJob, CronJobCreate, CronServiceState, ExecutorRunContext, ExecutorRunResult } from '../../../src/core/cron/types.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** The slot of the 2026-11-21 incident: 0 20 * * * America/Los_Angeles is 04:00Z. */
const SLOT = Date.UTC(2026, 10, 21, 4, 0, 0)

type Exec = (job: CronJob, message: string, ctx?: ExecutorRunContext) => Promise<ExecutorRunResult>

let dir: string
let counter = 0
let now: { value: number }
let calls: number
let exec: Exec

function makeState(storePath: string, cronEnabled: boolean): CronServiceState {
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
      runExecutor: vi.fn(async (job: CronJob, _ref, message: string, ctx?: ExecutorRunContext) => {
        calls++
        return await exec(job, message, ctx)
      }),
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  }
}

const reflection = (over: Record<string, unknown> = {}): CronJobCreate => ({
  name: 'Operations VP daily reflection', enabled: true, wakeMode: 'now',
  schedule: { kind: 'cron', expr: '0 20 * * *', tz: 'America/Los_Angeles' },
  executor: { type: 'session', config: { target: 'task-vp', prompt: 'reflect', instructions: 'reflect', ...over } },
})

async function stored(state: CronServiceState, id: string): Promise<CronJob> {
  const j = (await ops.list(state, { includeDisabled: true, recompute: false })).find((x) => x.id === id)
  if (!j) throw new Error(`no job ${id}`)
  return j
}

/** A promise and its resolve, to hold an executor at one point. */
function gate<T = void>(): { promise: Promise<T>; open: (v: T) => void } {
  let open!: (v: T) => void
  const promise = new Promise<T>((r) => { open = r })
  return { promise, open }
}

/** Process A: the routine is added before its slot, and the timer runs the slot late (the Mac slept). */
async function firstProcess(): Promise<{ a: CronServiceState; id: string; storePath: string }> {
  const storePath = path.join(dir, `cron-${++counter}.json`)
  const a = makeState(storePath, false)
  now.value = SLOT - HOUR
  const job = await ops.add(a, reflection())
  now.value = SLOT + 3 * HOUR + 33 * MIN
  return { a, id: job.id, storePath }
}

/** Process B: a restart over the store A left, through the real boot catch-up. */
async function restart(storePath: string): Promise<CronServiceState> {
  now.value += 29 * MIN
  const b = makeState(storePath, true)
  await ops.start(b)
  ops.stop(b)
  return b
}

beforeEach(async () => {
  dir = WALNUT_HOME
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  resetCache()
  now = { value: SLOT }
  calls = 0
  exec = async () => ({ status: 'ok', summary: 'sent' })
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('a run that sent before the process stopped', () => {
  it('is recorded at the restart and sends nothing again', async () => {
    const { a, id, storePath } = await firstProcess()
    const sent = gate()
    // The message is stored, then the process is suspended and stopped: the executor never returns.
    exec = async (_job, _message, ctx) => {
      await ctx?.markSent?.({ sessionId: 'sess-vp', summary: 'resumed session vp' })
      sent.open()
      return await new Promise<never>(() => {})
    }
    void onTimer(a)
    await sent.promise
    expect(calls).toBe(1)

    // A second run would send the message again.
    exec = async () => ({ status: 'ok', summary: 'sent again' })
    const b = await restart(storePath)
    expect(calls).toBe(1)
    const job = await stored(b, id)
    expect(job.state.runningAtMs).toBeUndefined()
    expect(job.state.lastStatus).toBe('ok')
    expect(job.state.sentRun).toBeUndefined()
    expect(job.state.runLog).toHaveLength(1)
    expect(job.state.runLog![0]).toMatchObject({ status: 'ok', slotMs: SLOT, sessionId: 'sess-vp' })
    expect(job.state.runLog![0].summary).toContain('before the server stopped')
    expect(job.state.nextRunAtMs).toBe(SLOT + DAY)
    expect(missedRuns(job, now.value)).toEqual([])

    // Its next tick runs nothing either.
    await onTimer(b)
    ops.stop(b)
    expect(calls).toBe(1)
  })

  it('runs again exactly once when it stopped before anything went out', async () => {
    const { a, id, storePath } = await firstProcess()
    const reached = gate()
    exec = async () => {
      reached.open()
      return await new Promise<never>(() => {})
    }
    void onTimer(a)
    await reached.promise

    exec = async (_job, _message, ctx) => {
      await ctx?.markSent?.({ summary: 'sent' })
      return { status: 'ok', summary: 'sent' }
    }
    const b = await restart(storePath)
    expect(calls).toBe(2)
    await onTimer(b)
    ops.stop(b)
    expect(calls).toBe(2)
    const job = await stored(b, id)
    expect(job.state.lastStatus).toBe('ok')
    expect(job.state.runLog).toHaveLength(1)
    expect(job.state.runLog![0]).toMatchObject({ status: 'ok', slotMs: SLOT })
    expect(job.state.nextRunAtMs).toBe(SLOT + DAY)
  })
})

describe('a run that sent and then failed or timed out', () => {
  it('is recorded ok when the executor throws after the send, with the error kept as a note', async () => {
    const { a, id } = await firstProcess()
    exec = async (_job, _message, ctx) => {
      await ctx?.markSent?.({ sessionId: 'sess-vp', summary: 'sent to session vp' })
      throw new Error('socket closed')
    }
    await onTimer(a)
    const job = await stored(a, id)
    expect(job.state.lastStatus).toBe('ok')
    expect(job.state.lastError).toBeUndefined()
    expect(job.state.consecutiveErrors).toBe(0)
    expect(job.state.runLog![0]).toMatchObject({ status: 'ok', slotMs: SLOT, sessionId: 'sess-vp' })
    expect(job.state.runLog![0].error).toBeUndefined()
    expect(job.state.runLog![0].willRetryAtMs).toBeUndefined()
    expect(job.state.runLog![0].summary).toContain('socket closed')
    expect(job.state.nextRunAtMs).toBe(SLOT + DAY)
    expect(missedRuns(job, now.value + HOUR)).toEqual([])
  })

  it('is recorded ok, with no backoff and no missed run, when it timed out after the send', async () => {
    const storePath = path.join(dir, `cron-${++counter}.json`)
    const a = makeState(storePath, false)
    now.value = SLOT - HOUR
    const added = await ops.add(a, reflection({ timeoutSeconds: 1 }))
    now.value = SLOT + 22 * MIN
    exec = async (_job, _message, ctx) => {
      await ctx?.markSent?.({ sessionId: 'sess-pvp', summary: 'sent to session pvp' })
      return await new Promise<never>(() => {})
    }
    await onTimer(a)
    const job = await stored(a, added.id)
    expect(job.state.lastStatus).toBe('ok')
    expect(job.state.consecutiveErrors).toBe(0)
    expect(job.state.runLog![0]).toMatchObject({ status: 'ok', slotMs: SLOT })
    expect(job.state.runLog![0].summary).toContain('timed out')
    expect(job.state.nextRunAtMs).toBe(SLOT + DAY)
    expect(missedRuns(job, now.value + HOUR)).toEqual([])
  })

  it('is corrected to ok when the send lands after the timeout already recorded it failed', async () => {
    // A process that slept across the run wakes with both due at once: the run's timeout and the
    // executor's next step. When the timeout goes first, the send that follows still counts.
    const storePath = path.join(dir, `cron-${++counter}.json`)
    const a = makeState(storePath, false)
    now.value = SLOT - HOUR
    const added = await ops.add(a, reflection({ timeoutSeconds: 1 }))
    now.value = SLOT + 6 * MIN
    let mark: ExecutorRunContext['markSent']
    exec = async (_job, _message, ctx) => {
      mark = ctx?.markSent
      return await new Promise<never>(() => {})
    }
    await onTimer(a)
    expect((await stored(a, added.id)).state.lastStatus).toBe('error')

    now.value = SLOT + 22 * MIN
    await mark!({ sessionId: 'sess-pvp', summary: 'sent to session pvp' })
    const job = await stored(a, added.id)
    expect(job.state.lastStatus).toBe('ok')
    expect(job.state.lastError).toBeUndefined()
    expect(job.state.consecutiveErrors).toBe(0)
    expect(job.state.runLog).toHaveLength(1)
    expect(job.state.runLog![0]).toMatchObject({ status: 'ok', slotMs: SLOT, sessionId: 'sess-pvp' })
    expect(job.state.runLog![0].error).toBeUndefined()
    expect(job.state.runLog![0].summary).toContain('timed out')
    expect(job.state.nextRunAtMs).toBe(SLOT + DAY)
    expect(missedRuns(job, now.value + HOUR)).toEqual([])
  })
})

describe('review round 1', () => {
  /** A one-shot routine at SLOT, added an hour before (deleteAfterRun is its default). */
  async function oneShot(over: Record<string, unknown> = {}): Promise<{ a: CronServiceState; id: string; storePath: string }> {
    const storePath = path.join(dir, `cron-${++counter}.json`)
    const a = makeState(storePath, false)
    now.value = SLOT - HOUR
    const job = await ops.add(a, { ...reflection(over), schedule: { kind: 'at', at: new Date(SLOT).toISOString() } })
    expect(job.deleteAfterRun).toBe(true)
    now.value = SLOT + 2 * MIN
    return { a, id: job.id, storePath }
  }

  it('a one-shot that sent before the process stopped is removed at the restart, as a run that ended ok is', async () => {
    const { a, id, storePath } = await oneShot()
    const sent = gate()
    exec = async (_job, _message, ctx) => {
      await ctx?.markSent?.({ summary: 'sent' })
      sent.open()
      return await new Promise<never>(() => {})
    }
    void onTimer(a)
    await sent.promise
    exec = async () => ({ status: 'ok', summary: 'sent again' })
    const b = await restart(storePath)
    expect(calls).toBe(1)
    const all = await ops.list(b, { includeDisabled: true, recompute: false })
    expect(all.find((j) => j.id === id)).toBeUndefined()
    expect(b.deps.onEvent).toHaveBeenCalledWith(expect.objectContaining({ jobId: id, action: 'removed' }))
  })

  it('a one-shot recorded failed and then sent is removed, as a run that ended ok is', async () => {
    const { a, id } = await oneShot({ timeoutSeconds: 1 })
    let mark: ExecutorRunContext['markSent']
    exec = async (_job, _message, ctx) => {
      mark = ctx?.markSent
      return await new Promise<never>(() => {})
    }
    await onTimer(a)
    expect((await stored(a, id)).state.lastStatus).toBe('error')
    await mark!({ summary: 'sent' })
    const all = await ops.list(a, { includeDisabled: true, recompute: false })
    expect(all.find((j) => j.id === id)).toBeUndefined()
  })

  it('a run still going here is never settled from its own mark, even after a pause cleared its marker', async () => {
    const storePath = path.join(dir, `cron-${++counter}.json`)
    const a = makeState(storePath, false)
    now.value = SLOT - HOUR
    const added = await ops.add(a, reflection())
    now.value = SLOT + MIN
    const marked = gate()
    const finish = gate()
    exec = async (_job, _message, ctx) => {
      await ctx?.markSent?.({ summary: 'sent' })
      marked.open()
      await finish.promise
      return { status: 'ok', summary: 'the real result' }
    }
    const running = ops.run(a, added.id, 'force')
    await marked.promise
    await ops.update(a, added.id, { enabled: false })
    expect((await stored(a, added.id)).state.runningAtMs).toBeUndefined()
    await onTimer(a)
    expect((await stored(a, added.id)).state.runLog ?? []).toHaveLength(0)

    finish.open()
    await running
    const job = await stored(a, added.id)
    expect(job.state.runLog).toHaveLength(1)
    expect(job.state.runLog![0].summary).toBe('the real result')
    expect(job.state.sentRun).toBeUndefined()
  })
})

describe('the message of a scheduled session run', () => {
  /**
   * The real queue behind the delivery, as the default wiring stores it (session-message-queue.ts).
   * `stopAfterStore`: process A stops right after the row is stored, before the run could mark it.
   */
  function queueDelivery(stopAfterStore?: () => void): SessionDelivery {
    return {
      sessionsForTask: async () => [{ claudeSessionId: 'sess-vp', process_status: 'running', lastActiveAt: '2026-11-21T00:00:00Z' }] as any,
      sendToSession: async (sessionId, message, _taskId, opts) => {
        await enqueueMessage(sessionId, message, { ...(opts?.messageId ? { id: opts.messageId } : {}) })
        if (stopAfterStore) {
          stopAfterStore()
          return await new Promise<never>(() => {})
        }
        opts?.onStored?.()
      },
      getTask: async () => ({ id: 'task-vp', phase: 'IN_PROGRESS' }),
      startSession: async () => { throw new Error('no start expected') },
      notify: async () => {},
    }
  }

  it('has one id per routine and slot, so a rerun meets the row still queued', async () => {
    const { a, id, storePath } = await firstProcess()
    const rowStored = gate()
    const stuck = createSessionExecutor({ delivery: queueDelivery(() => rowStored.open()), launchVisibleWaitMs: 0 })
    exec = async (job, message, ctx) => await stuck.run(job, job.executor!, message, ctx)
    void onTimer(a)
    await rowStored.promise
    expect(await getQueue('sess-vp')).toHaveLength(1)

    const fine = createSessionExecutor({ delivery: queueDelivery(), launchVisibleWaitMs: 0 })
    exec = async (job, message, ctx) => await fine.run(job, job.executor!, message, ctx)
    const b = await restart(storePath)
    expect(calls).toBe(2)
    expect(await getQueue('sess-vp')).toHaveLength(1)
    const job = await stored(b, id)
    expect(job.state.runLog![0]).toMatchObject({ status: 'ok', slotMs: SLOT })
  })
})
