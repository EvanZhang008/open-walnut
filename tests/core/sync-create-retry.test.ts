/**
 * Step 1 of a plugin's sync tick: creating the remote twin of a task that has none.
 *
 * The live symptom this covers: a title the external tracker permanently refuses was
 * retried every 32s forever, two warn lines a minute, and the person who owned the task
 * was never told. So the assertions are about restraint and about being heard once: the
 * batch is capped, a failure sits out the next tick, and the third consecutive refusal
 * produces exactly ONE error (which the log-error bridge turns into ONE notification
 * card, retired when the create finally lands).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SyncRetrySchedule } from '../../src/core/sync-retry-schedule.js'
import {
  retryUnsyncedCreates,
  createRecoveryKey,
  CREATE_ATTEMPTS_BEFORE_NOTICE,
  CREATE_REFUSED_MESSAGE,
  MAX_CREATE_RETRIES_PER_CYCLE,
  type UnsyncedCreateTask,
} from '../../src/core/sync-create-retry.js'

// The bridge + humanizer are only read (never installed), but they resolve the data home
// at import time, so point it at a throwaway directory first.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sync-create-retry-'))
process.env.OPEN_WALNUT_HOME = testHome
const { recoveryKeyOf, dedupFingerprintForTest } =
  await import('../../src/core/notifications/log-error-bridge.js')
const { humanizeErrorNotification } = await import('../../src/core/notifications/humanize.js')

afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true })
})

const PLUGIN = 'tracker'
const REFUSAL = 'tasks must be in English, CJK characters detected in title'
const MIN = 60_000

interface TestTask extends UnsyncedCreateTask {
  id: string
  title: string
  ext?: Record<string, unknown>
}

const task = (id: string, title = `Task ${id}`): TestTask => ({ id, title })

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** One tick over the same candidate list, with whatever the plugin does to a create. */
function tick(
  schedule: SyncRetrySchedule,
  unsynced: TestTask[],
  createTask: (t: TestTask) => Promise<Record<string, unknown> | null>,
  log = makeLog(),
  publishRecovery?: (keys: string[]) => void,
) {
  return retryUnsyncedCreates<TestTask>({
    pluginId: PLUGIN,
    unsynced,
    schedule,
    createTask,
    log,
    ...(publishRecovery ? { publishRecovery } : {}),
  })
}

describe('retryUnsyncedCreates', () => {
  beforeEach(() => {
    // The schedule reads Date.now(); own the clock so backoff is exact, not slept through.
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a never-tried task on the first tick and returns its ext patch', async () => {
    const schedule = new SyncRetrySchedule()
    const created = vi.fn(async () => ({ [PLUGIN]: { id: 'remote-1' } }))
    const rows = [{ ...task('t1'), ext: { other: { keep: true } } }]

    const result = await tick(schedule, rows, created)

    expect(created).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 })
    // Existing ext survives the merge; the caller commits this in one bulk write.
    expect(result.extUpdates).toEqual([
      { id: 't1', patch: { ext: { other: { keep: true }, [PLUGIN]: { id: 'remote-1' } } } },
    ])
    expect(schedule.attemptsOf('t1')).toBe(0)
  })

  it('does not retry a failed create on the very next tick, and does after the backoff', async () => {
    const schedule = new SyncRetrySchedule({ baseMs: MIN })
    const refuse = vi.fn(async () => { throw new Error(REFUSAL) })
    const rows = [task('t1')]

    const first = await tick(schedule, rows, refuse)
    expect(first).toMatchObject({ attempted: 1, failed: 1 })

    // Next tick, ~30s later: the task is still unsynced, but it is not tried again.
    vi.setSystemTime(30_000)
    const second = await tick(schedule, rows, refuse)
    expect(second).toMatchObject({ attempted: 0, succeeded: 0, failed: 0 })
    expect(refuse).toHaveBeenCalledTimes(1)

    // Once the wait has elapsed it comes back.
    vi.setSystemTime(MIN)
    const third = await tick(schedule, rows, refuse)
    expect(third).toMatchObject({ attempted: 1, failed: 1 })
    expect(refuse).toHaveBeenCalledTimes(2)
  })

  it('caps the batch and hands the slots to the tasks behind the failures', async () => {
    const schedule = new SyncRetrySchedule({ baseMs: MIN })
    const seen: string[] = []
    const refuse = vi.fn(async (t: TestTask) => { seen.push(t.id); throw new Error(REFUSAL) })
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => task(id))

    const first = await tick(schedule, rows, refuse)
    expect(first.attempted).toBe(MAX_CREATE_RETRIES_PER_CYCLE)
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e'])

    seen.length = 0
    vi.setSystemTime(30_000)
    const second = await tick(schedule, rows, refuse)
    expect(second.attempted).toBe(2)
    expect(seen).toEqual(['f', 'g'])
  })

  it('emits exactly one actionable error on the third consecutive refusal', async () => {
    const schedule = new SyncRetrySchedule({ baseMs: 1 })
    const log = makeLog()
    const refuse = async () => { throw new Error(REFUSAL) }
    const rows = [task('t1', 'Add CJK title')]

    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(i * 10)
      await tick(schedule, rows, refuse, log)
    }

    // Every attempt still leaves a warn for forensics; only one reaches the human.
    expect(log.warn).toHaveBeenCalledTimes(4)
    expect(log.error).toHaveBeenCalledTimes(1)
    const [message, meta] = log.error.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe(CREATE_REFUSED_MESSAGE)
    expect(meta).toMatchObject({
      pluginId: PLUGIN,
      taskId: 't1',
      title: 'Add CJK title',
      error: REFUSAL,
      attempts: CREATE_ATTEMPTS_BEFORE_NOTICE,
    })
  })

  it('a success clears the streak and retires the card; a later streak can notify again', async () => {
    const schedule = new SyncRetrySchedule({ baseMs: 1 })
    const log = makeLog()
    const recovered: string[][] = []
    const publish = (keys: string[]) => { recovered.push(keys) }
    const refuse = async () => { throw new Error(REFUSAL) }
    const rows = [task('t1')]

    for (let i = 0; i < CREATE_ATTEMPTS_BEFORE_NOTICE; i++) {
      vi.setSystemTime(i * 10)
      await tick(schedule, rows, refuse, log, publish)
    }
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(recovered).toEqual([])

    vi.setSystemTime(100)
    const ok = await tick(schedule, rows, async () => ({ [PLUGIN]: { id: 'remote-1' } }), log, publish)
    expect(ok).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 })
    expect(schedule.attemptsOf('t1')).toBe(0)
    // The card leaves the Errors rail the moment the create lands.
    expect(recovered).toEqual([[createRecoveryKey(PLUGIN, 't1')]])

    // A fresh streak is a fresh problem: it is allowed to speak up once more.
    for (let i = 0; i < CREATE_ATTEMPTS_BEFORE_NOTICE; i++) {
      vi.setSystemTime(200 + i * 10)
      await tick(schedule, rows, refuse, log, publish)
    }
    expect(log.error).toHaveBeenCalledTimes(2)
  })

  it('retires the card when the create landed by another route (the user fixed the title)', async () => {
    const schedule = new SyncRetrySchedule({ baseMs: 1 })
    const log = makeLog()
    const recovered: string[][] = []
    const publish = (keys: string[]) => { recovered.push(keys) }
    const rows = [task('t1')]

    for (let i = 0; i < CREATE_ATTEMPTS_BEFORE_NOTICE; i++) {
      vi.setSystemTime(i * 10)
      await tick(schedule, rows, async () => { throw new Error(REFUSAL) }, log, publish)
    }
    expect(log.error).toHaveBeenCalledTimes(1)

    // The edit path created the twin, so the task is no longer unsynced and this loop
    // never sees a success of its own.
    vi.setSystemTime(100)
    const after = await tick(schedule, [], async () => ({ [PLUGIN]: { id: 'r' } }), log, publish)
    expect(after).toMatchObject({ attempted: 0 })
    expect(recovered).toEqual([[createRecoveryKey(PLUGIN, 't1')]])
    expect(schedule.attemptsOf('t1')).toBe(0)

    // And only once: the entry is gone, so the next tick has nothing to retire.
    vi.setSystemTime(200)
    await tick(schedule, [], async () => ({ [PLUGIN]: { id: 'r' } }), log, publish)
    expect(recovered).toHaveLength(1)
  })

  it('says nothing about a task that leaves the queue before any card was published', async () => {
    const schedule = new SyncRetrySchedule({ baseMs: 1 })
    const publish = vi.fn()
    const rows = [task('t1')]
    await tick(schedule, rows, async () => { throw new Error(REFUSAL) }, makeLog(), publish)
    vi.setSystemTime(50)
    await tick(schedule, [], async () => ({ [PLUGIN]: { id: 'r' } }), makeLog(), publish)
    expect(publish).not.toHaveBeenCalled()
  })

  it('does not touch the notification store for a create that never failed', async () => {
    const schedule = new SyncRetrySchedule()
    const publish = vi.fn()
    await tick(schedule, [task('t1')], async () => ({ [PLUGIN]: { id: 'remote-1' } }), makeLog(), publish)
    expect(publish).not.toHaveBeenCalled()
  })

  it('backs a "no remote task" answer off too, without calling it an error', async () => {
    const schedule = new SyncRetrySchedule({ baseMs: MIN })
    const log = makeLog()
    const declined = vi.fn(async () => null)
    const rows = [task('t1')]

    const first = await tick(schedule, rows, declined, log)
    expect(first).toMatchObject({ attempted: 1, succeeded: 0, failed: 0 })
    expect(first.extUpdates).toEqual([])
    expect(schedule.attemptsOf('t1')).toBe(1)

    // A plugin declining to mirror a task is a decision, not a fault: no card, and it
    // still stops being retried every tick.
    vi.setSystemTime(30_000)
    expect((await tick(schedule, rows, declined, log)).attempted).toBe(0)
    expect(declined).toHaveBeenCalledTimes(1)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('yields to the caller between batches of creates', async () => {
    const schedule = new SyncRetrySchedule()
    const yields = vi.fn(async () => {})
    await retryUnsyncedCreates<TestTask>({
      pluginId: PLUGIN,
      unsynced: ['a', 'b', 'c', 'd'].map((id) => task(id)),
      schedule,
      createTask: async () => ({ [PLUGIN]: { id: 'r' } }),
      log: makeLog(),
      onYield: yields,
      yieldEvery: 2,
      limit: 4,
    })
    // Before the 3rd create only: the yield is a checkpoint every N, not per item.
    expect(yields).toHaveBeenCalledTimes(1)
  })
})

describe('the error a refused create raises, as the notification centre sees it', () => {
  /** The error the third consecutive refusal logs, captured once. */
  async function refusalError(taskId: string, title: string) {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const schedule = new SyncRetrySchedule({ baseMs: 1 })
      const log = makeLog()
      const rows = [task(taskId, title)]
      for (let i = 0; i < CREATE_ATTEMPTS_BEFORE_NOTICE; i++) {
        vi.setSystemTime(i * 10)
        await tick(schedule, rows, async () => { throw new Error(REFUSAL) }, log)
      }
      const [message, meta] = log.error.mock.calls[0] as [string, Record<string, unknown>]
      return { subsystem: 'web', message, meta }
    } finally {
      vi.useRealTimers()
    }
  }

  it('is one card per task, not one per attempt', async () => {
    const first = await refusalError('t1', 'Add CJK title')
    const again = await refusalError('t1', 'Add CJK title')
    const other = await refusalError('t2', 'Another refused title')
    // Fixed message + stable meta: the same task folds into the same card, a different
    // task gets its own. This is why the message text carries no interpolation.
    expect(dedupFingerprintForTest(again)).toBe(dedupFingerprintForTest(first))
    expect(dedupFingerprintForTest(other)).not.toBe(dedupFingerprintForTest(first))
  })

  it('belongs to that ONE create, so a healthy sync tick cannot retire it', async () => {
    const payload = await refusalError('t1', 'Add CJK title')
    expect(recoveryKeyOf(payload)).toBe(createRecoveryKey(PLUGIN, 't1'))
    expect(recoveryKeyOf(payload)).not.toBe(`plugin:${PLUGIN}`)
  })

  it('reads as a sentence a person can act on', async () => {
    const payload = await refusalError('t1', 'Add CJK title')
    const human = humanizeErrorNotification({
      title: payload.message,
      subsystem: payload.subsystem,
      recoveryKey: recoveryKeyOf(payload),
      meta: payload.meta,
    })
    expect(human.title).toBe('Sync: the tracker keeps refusing to create a task')
    // The tracker's own refusal, ended as a sentence by the humanizer.
    expect(human.message).toBe(`${REFUSAL}.`)
    // Grouped under the plugin, next to the rest of that plugin's failures.
    expect(human.category).toBe('Tracker')
  })
})
