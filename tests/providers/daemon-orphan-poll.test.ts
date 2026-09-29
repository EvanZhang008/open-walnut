/**
 * L1.4 daemon-orphan-poll — 1s adopted-session watchdog.
 *
 * Validates P3.2:
 *   - Sets interval at 1000ms
 *   - Skips tick if session missing or state!='running'
 *   - kill(pid,0) ESRCH → reapSession('orphan-poll-dead')
 *   - start_time mismatch → reapSession('pid-recycled'), found by the 30s re-check
 *   - startTime null → only alive check, no recycle check
 *   - Timer cleared after reap
 *   - Idempotent: two startOrphanPoll calls → one timer
 *   - Auto-cleanup when session removed from map
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildDeps,
  makeTestSession,
  createDaemonCore,
  killWithDead,
} from '../helpers/daemon-core-fixtures.js'

describe('L1.4 daemon-orphan-poll: 1s watchdog', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>

  beforeEach(async () => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (ctx) await ctx.cleanup()
  })

  // O1 — first call sets 1000ms interval
  it('startOrphanPoll sets interval at 1000ms; no tick before elapsed', async () => {
    ctx = await buildDeps()
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 100 }))

    core.startOrphanPoll('sid')

    // 500ms in — no tick yet
    vi.advanceTimersByTime(500)
    expect(ctx.spies.killFn).not.toHaveBeenCalled()

    // Pass 1001ms total — one tick
    vi.advanceTimersByTime(501)
    expect(ctx.spies.killFn).toHaveBeenCalledTimes(1)
  })

  // O2 — state!=running skips tick
  it('tick skipped if session.state is not running', async () => {
    ctx = await buildDeps()
    const core = createDaemonCore(ctx.deps)
    const session = makeTestSession({ pid: 101, state: 'running' })
    ctx.sessions.set('sid', session)

    core.startOrphanPoll('sid')

    // Flip to dead AFTER timer is set
    session.state = 'dead'

    vi.advanceTimersByTime(1001)

    expect(ctx.spies.killFn).not.toHaveBeenCalled()
    // Timer was cleared during the tick self-clean branch
    expect(ctx.spies.clearIntervalFn).toHaveBeenCalled()
  })

  // O3 — session removed from Map triggers self-clean
  it('tick after session removed from Map clears its own timer', async () => {
    ctx = await buildDeps()
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 102 }))
    core.startOrphanPoll('sid')

    ctx.sessions.delete('sid')

    vi.advanceTimersByTime(1001)
    // killFn is NOT called because `s` is undefined → returns early
    expect(ctx.spies.killFn).not.toHaveBeenCalled()
  })

  // O4 — ESRCH → reapSession('orphan-poll-dead')
  it('ESRCH during poll → reapSession(reason=orphan-poll-dead)', async () => {
    ctx = await buildDeps({ killImpl: killWithDead(new Set([103])) })
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 103 }))
    core.startOrphanPoll('sid')

    vi.advanceTimersByTime(1001)

    expect(ctx.sessions.get('sid')!.state).toBe('dead')
    expect(ctx.sessions.get('sid')!.exitReason).toBe('orphan-poll-dead')
  })

  // O5 — start_time mismatch → pid-recycled
  it('start_time mismatch → reapSession(reason=pid-recycled)', async () => {
    ctx = await buildDeps({
      killImpl: () => {},  // alive
      readStartTimeImpl: () => 'NEW',
    })
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 104, startTime: 'ORIGINAL' }))
    core.startOrphanPoll('sid')

    // The 1s tick only probes liveness; the start time is re-read every 30s.
    await vi.advanceTimersByTimeAsync(1001)
    expect(ctx.spies.readStartTimeFn).not.toHaveBeenCalled()
    expect(ctx.sessions.get('sid')!.state).toBe('running')

    await vi.advanceTimersByTimeAsync(29_000)

    expect(ctx.sessions.get('sid')!.state).toBe('dead')
    expect(ctx.sessions.get('sid')!.exitReason).toBe('pid-recycled')
  })

  // O6 — startTime null → only alive check (no recycle)
  it('startTime=null → only alive check, recycle probe is skipped', async () => {
    ctx = await buildDeps({
      killImpl: () => {},
      readStartTimeImpl: () => 'ANYTHING',  // would mismatch if checked
    })
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 105, startTime: null }))
    core.startOrphanPoll('sid')

    vi.advanceTimersByTime(1001)

    expect(ctx.sessions.get('sid')!.state).toBe('running')
    // readStartTime not invoked when startTime is null
    expect(ctx.spies.readStartTimeFn).not.toHaveBeenCalled()
  })

  // O7 — after reap, timer cleared; next tick doesn't execute
  it('after reap the timer is cleared and no further ticks run', async () => {
    ctx = await buildDeps({ killImpl: killWithDead(new Set([106])) })
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 106 }))
    core.startOrphanPoll('sid')

    vi.advanceTimersByTime(1001)
    const callsAfterFirstTick = ctx.spies.killFn.mock.calls.length

    vi.advanceTimersByTime(2000)
    expect(ctx.spies.killFn.mock.calls.length).toBe(callsAfterFirstTick)
  })

  // O8 — idempotent startOrphanPoll
  it('calling startOrphanPoll twice on same sid installs only one timer', async () => {
    ctx = await buildDeps()
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 107 }))

    core.startOrphanPoll('sid')
    core.startOrphanPoll('sid')

    expect(ctx.spies.setIntervalFn).toHaveBeenCalledTimes(1)
  })
})
