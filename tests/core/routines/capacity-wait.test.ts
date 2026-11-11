import { describe, it, expect, vi } from 'vitest'
import type { RunStartDeps } from '../../../src/core/routines/run-start-deps.js'
import { RoutineRunStarter, _runStartWatchesForTesting } from '../../../src/core/routines/run-start.js'
import type { RoutineStart, Task } from '../../../src/core/types.js'

const now = Date.parse('2026-11-11T18:52:00Z')
const input = { job: { id: 'triage-routine', name: 'Triage' }, runAtMs: now,
  launch: { message: 'Read the original batch.', cwd: '/work/triage', source: 'routine' } }

function fixture() {
  let clock = now
  const task = { id: 'waiting-run', title: 'Triage', phase: 'TODO', start_queue: { wait_for_slot: true, routine: input.launch } } as Task
  const write = vi.fn(async () => {})
  const failure = vi.fn(async () => {})
  const deps: RunStartDeps = {
    now: () => clock, sleep: async ms => { clock += Math.max(1, ms) },
    mintSessionId: async () => 'queued-run-session',
    launch: vi.fn(async (_launch, opts) => {
      task.routine_start = opts.record
      return { task, queued: true }
    }),
    getSession: async () => null, sessionsForTask: async () => [], getTask: async () => task,
    writeStart: write, failSession: failure, hostServing: async () => true,
    cancelStart: async () => 'cancelled', onSessionError: () => () => {},
    recordFailure: vi.fn(async () => {}), recordStartedOnRetry: async () => {}, handBack: vi.fn(async () => {}),
  }
  const starter = new RoutineRunStarter(deps, { inlineWaitMs: 10, attemptDeadlineMs: 20,
    retryDelayMs: 1, hostWaitMs: 0, staleAfterMs: 10, pollMs: 1 })
  return { task, deps, starter, failure, write }
}

describe('capacity waits do not become failed spawn attempts', () => {
  it('returns an explicit wait without a session delivery or deadline watch', async () => {
    const f = fixture()
    const result = await f.starter.start(input)
    expect(result).toMatchObject({ task: { id: 'waiting-run' }, confirmed: false, queued: true })
    expect(result.sessionId).toBeUndefined()
    expect(_runStartWatchesForTesting().has('waiting-run')).toBe(false)
    expect(f.task.routine_start).toMatchObject({ job_id: 'triage-routine', state: 'starting', launch: input.launch })
    // The record is persisted together with the queue, never after a drain could begin.
    expect(f.deps.launch).toHaveBeenCalledWith(input.launch, expect.objectContaining({ record: expect.objectContaining({ state: 'starting' }) }))
    expect(f.write).not.toHaveBeenCalled()
    expect(f.failure).not.toHaveBeenCalled()
  })

  it('simultaneous delivery of one dispatched round makes only one wait', async () => {
    const f = fixture()
    const results = await Promise.all([f.starter.start(input), f.starter.start(input), f.starter.start(input)])
    expect(f.deps.launch).toHaveBeenCalledTimes(1)
    expect(results.every(r => r.queued && r.task.id === 'waiting-run')).toBe(true)
  })

  it('a failed spawn retry can wait for capacity without losing its second attempt', async () => {
    const f = fixture()
    f.deps.launch = vi.fn(async (_launch, opts) => {
      f.task.routine_start = opts.record
      if (opts.record?.attempt === 2) return { task: f.task, queued: true }
      return { task: f.task }
    })
    f.deps.getSession = async () => ({ process_status: 'error', status_reason: 'api_error' }) as never
    const result = await f.starter.start({ ...input, runAtMs: now + 1 })
    expect(result.queued).toBeUndefined()
    for (const promise of _runStartWatchesForTesting().values()) await promise
    expect(f.deps.launch).toHaveBeenCalledTimes(2)
    expect(f.task.routine_start?.attempt).toBe(2)
    expect(f.task.routine_start?.state).toBe('starting')
    expect(f.deps.handBack).not.toHaveBeenCalled()
  })

  it('a lost capacity claim cannot overwrite the start that won it', async () => {
    const f = fixture()
    f.deps.failClaimedStart = vi.fn(async () => false)
    const expected = { job_id: input.job.id, job_name: input.job.name, run_at: new Date(now).toISOString(),
      attempt: 1, attempt_at: new Date(now).toISOString(), state: 'starting' } as RoutineStart
    await f.starter.failCapacity(f.task.id, 'A competing replay lost.', expected)
    expect(f.deps.failClaimedStart).toHaveBeenCalledWith(f.task.id, expected, 'A competing replay lost.')
    expect(f.write).not.toHaveBeenCalled()
    expect(f.failure).not.toHaveBeenCalled()
  })

  it('a terminal run cannot be replayed as a successful pending dispatch', async () => {
    const f = fixture()
    await f.starter.start(input)
    f.task.routine_start = { ...f.task.routine_start!, state: 'failed', error: 'The run was cancelled.' }
    f.deps.findRun = async () => f.task
    await expect(f.starter.start(input)).rejects.toThrow('The run was cancelled.')
    expect(f.deps.launch).toHaveBeenCalledTimes(1)
  })

  it('a persisted run is returned without another launch after the process flight is gone', async () => {
    const f = fixture()
    await f.starter.start(input)
    f.deps.findRun = async () => f.task
    expect((await f.starter.start(input)).queued).toBe(true)
    expect(f.deps.launch).toHaveBeenCalledTimes(1)
  })
})
