/**
 * A routine trigger check (quiet, healthy, nothing to tell) waits up to ROUTINE_WRITE_DELAY_MS
 * for its write, so the checks of that span share one write (src/core/cron/trigger-apply.ts
 * persistRoutineCheck). 2026-11-23: every check rewrote cron-state.json (1 MB), 238 writes in the
 * 100 s after a restart, one of the largest sources of the server's garbage. Anything else a check
 * records (an error, a notice, a disable) still writes at once, and nothing waiting is lost to a
 * reload of the files or written over another writer's change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import * as ops from '../../../src/core/cron/ops.js'
import { applyTriggerChecked, flushRoutineChecks, ROUTINE_WRITE_DELAY_MS } from '../../../src/core/cron/trigger-apply.js'
import { cronStatePath, ensureLoaded } from '../../../src/core/cron/store.js'
import { locked } from '../../../src/core/cron/timer.js'
import type { CronServiceState } from '../../../src/core/cron/types.js'
import type { TriggerCheckedEvent } from '../../../src/providers/trigger-check-core.js'
import { _resetJsonIoForTesting, jsonIoTop } from '../../../src/core/observability/json-io.js'

const MIN = 60_000
const now = { value: Date.UTC(2026, 10, 23, 11, 0, 0) }

function makeState(): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  return {
    deps: {
      nowMs: () => now.value, log, storePath: path.join(WALNUT_HOME, 'cron-routine-write.json'), cronEnabled: false,
      broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn(), runIsolatedAgentJob: vi.fn(), runExecutor: vi.fn(),
      onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  } as unknown as CronServiceState
}

function checked(id: string, extra: Partial<TriggerCheckedEvent> = {}): TriggerCheckedEvent {
  now.value += 5 * MIN
  return { type: 'trigger.checked', id, atMs: now.value, outcome: 'quiet', durationMs: 120, nextRunAtMs: now.value + 5 * MIN, consecutiveErrors: 0, ...extra } as TriggerCheckedEvent
}

async function trigger(state: CronServiceState) {
  return await ops.add(state, {
    name: 'New mail', enabled: true, wakeMode: 'now', schedule: { kind: 'every', everyMs: 5 * MIN },
    executor: { type: 'session', config: { target: 't-owner', prompt: 'p' } },
    check: { run: 'true', host: '__local__' },
  } as any)
}

const stateWrites = (state: CronServiceState) => jsonIoTop(50).find((r) => r.file === cronStatePath(state.deps.storePath))?.writes ?? 0
async function onDisk(state: CronServiceState, id: string) {
  return (JSON.parse(await fs.readFile(cronStatePath(state.deps.storePath), 'utf-8')) as { states: Record<string, { lastCheck?: { atMs: number; outcome: string }; consecutiveErrors?: number }> }).states[id]
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetJsonIoForTesting()
})

describe('routine trigger checks share one write', () => {
  it('five quiet checks: no write until the delay, then one with the last of them', async () => {
    const state = makeState()
    const job = await trigger(state)
    _resetJsonIoForTesting()
    let last = 0
    for (let i = 0; i < 5; i++) { const e = checked(job.id); last = e.atMs; await applyTriggerChecked(state, e) }
    expect(stateWrites(state)).toBe(0)
    expect(state.routineWriteTimer).toBeDefined()
    expect(ROUTINE_WRITE_DELAY_MS).toBeLessThanOrEqual(30_000)
    // A reader in this process sees every check at once.
    const [listed] = await ops.list(state, { includeDisabled: true })
    expect(listed!.state.lastCheck?.atMs).toBe(last)
    await flushRoutineChecks(state)
    expect(stateWrites(state)).toBe(1)
    expect((await onDisk(state, job.id))?.lastCheck?.atMs).toBe(last)
    expect(state.routineWriteTimer).toBeUndefined()
  })

  it('an error check writes at once, and carries the quiet ones before it', async () => {
    const state = makeState()
    const job = await trigger(state)
    await applyTriggerChecked(state, checked(job.id))
    _resetJsonIoForTesting()
    const err = checked(job.id, { outcome: 'error', error: 'boom' })
    await applyTriggerChecked(state, err)
    expect(stateWrites(state)).toBe(1)
    expect(state.routineWriteDue).toBe(false)
    expect((await onDisk(state, job.id))?.lastCheck).toMatchObject({ atMs: err.atMs, outcome: 'error' })
    // The quiet check after an error is the recovery: it writes at once too.
    _resetJsonIoForTesting()
    await applyTriggerChecked(state, checked(job.id))
    expect(stateWrites(state)).toBe(1)
  })

  it('a reload that reads the files writes what waits first', async () => {
    const state = makeState()
    const job = await trigger(state)
    const e = checked(job.id)
    await applyTriggerChecked(state, e)
    expect(state.routineWriteDue).toBe(true)
    state.disk!.readAt = 0 // past CRON_REREAD_MAX_MS: the next forced reload reads the files
    await locked(state, async () => { await ensureLoaded(state, { forceReload: true }) })
    expect((await onDisk(state, job.id))?.lastCheck?.atMs).toBe(e.atMs)
    const [listed] = await ops.list(state, { includeDisabled: true })
    expect(listed!.state.lastCheck?.atMs).toBe(e.atMs)
  })

  it('another writer\'s change wins over what waits, never the other way', async () => {
    const state = makeState()
    const job = await trigger(state)
    await applyTriggerChecked(state, checked(job.id))
    const file = cronStatePath(state.deps.storePath)
    const theirs = JSON.parse(await fs.readFile(file, 'utf-8'))
    theirs.states[job.id].consecutiveErrors = 0
    theirs.states[job.id].lastCheck = { atMs: 42, outcome: 'quiet' }
    await fs.writeFile(file, JSON.stringify(theirs) + '\n')
    await locked(state, async () => { await ensureLoaded(state, { forceReload: true }) })
    expect((await onDisk(state, job.id))?.lastCheck?.atMs).toBe(42)
    expect(state.routineWriteDue).toBe(false)
    await flushRoutineChecks(state)
    expect((await onDisk(state, job.id))?.lastCheck?.atMs).toBe(42)
  })

  it('the delayed write itself never goes over another writer\'s change (git-sync, another process)', async () => {
    const state = makeState()
    const job = await trigger(state)
    await applyTriggerChecked(state, checked(job.id))
    const jobsFile = state.deps.storePath
    const theirs = JSON.parse(await fs.readFile(jobsFile, 'utf-8'))
    theirs.jobs[0].name = 'Renamed on the other machine'
    await fs.writeFile(jobsFile, JSON.stringify(theirs, null, 2) + '\n')
    await flushRoutineChecks(state)
    expect(JSON.parse(await fs.readFile(jobsFile, 'utf-8')).jobs[0].name).toBe('Renamed on the other machine')
    expect(state.routineWriteDue).toBe(false)
  })

  it('after stop a routine check writes at once', async () => {
    const state = makeState()
    const job = await trigger(state)
    await ops.stop(state)
    _resetJsonIoForTesting()
    await applyTriggerChecked(state, checked(job.id))
    expect(stateWrites(state)).toBe(1)
    expect(state.routineWriteTimer).toBeUndefined()
  })

  it('an op that throws drops what waits with it', async () => {
    const state = makeState()
    const job = await trigger(state)
    await applyTriggerChecked(state, checked(job.id))
    await expect(locked(state, async () => { throw new Error('mid-op') })).rejects.toThrow('mid-op')
    expect(state.routineWriteDue).toBe(false)
    _resetJsonIoForTesting()
    await flushRoutineChecks(state)
    expect(stateWrites(state)).toBe(0)
  })

  it('stop writes what waits', async () => {
    const state = makeState()
    const job = await trigger(state)
    const e = checked(job.id)
    await applyTriggerChecked(state, e)
    await ops.stop(state)
    expect((await onDisk(state, job.id))?.lastCheck?.atMs).toBe(e.atMs)
  })
})
