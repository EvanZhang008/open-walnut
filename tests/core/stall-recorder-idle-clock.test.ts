/**
 * A runtime without an idle clock for its loop (bun: eventLoopUtilization is
 * all zeros) never reads as a loop that did not wait. A stop while the loop
 * waited in poll leaves a backlog that runs as soon as it comes back, and with
 * the wait read as 0 that backlog passed for code holding the loop (holdVerdict,
 * src/core/stall-recorder-hold.ts). Without the clock, every ms the thread did
 * not run in the hold may have been a wait; the thread's own CPU (threadCpuUsage
 * is per thread on bun too) still convicts a real block.
 */
import { describe, it, expect } from 'vitest'
import { performance } from 'node:perf_hooks'
import { holdVerdict } from '../../src/core/stall-recorder.js'
import { captureHold, readTick } from '../../src/core/stall-recorder-hold.js'

describe('holdVerdict without an idle clock', () => {
  // A 3 s stop while the loop sat in poll, then the 400 ms of reads it queued,
  // inside a 3.4 s hold, from a loop that ran 5% of the time before.
  const stopInPoll = {
    lateByMs: 3_200, windowMs: 4_100, mainCpuMs: 420, holdCpuMs: 400, afterHoldCpuMs: 20,
    holdFromMs: -60, holdToMs: 3_340, baseCpuShare: 0.05, baseTurnMs: 30,
    gcMs: 0, majorFaults: 0, invCtxSwitches: 50, volCtxSwitches: 40,
  }

  it('a stop in poll is not code, whether the clock saw the wait or there is no clock', () => {
    expect(holdVerdict({ ...stopInPoll, loopIdleMs: 3_000 })).not.toBe('cpu')
    expect(holdVerdict({ ...stopInPoll, loopIdleSource: 'none' })).not.toBe('cpu')
    // With code on the few samples it got (the backlog itself) too.
    expect(holdVerdict({ ...stopInPoll, loopIdleSource: 'none', codeShare: 0.9, profileSamples: 40 })).not.toBe('cpu')
  })

  it('the same numbers from a clock that saw no wait are code: 0 means 0 only where the clock runs', () => {
    expect(holdVerdict({ ...stopInPoll, loopIdleMs: 0 })).toBe('cpu')
    expect(holdVerdict({ ...stopInPoll, loopIdleMs: 0, codeShare: 0.9, profileSamples: 40 })).toBe('cpu')
  })

  it('a real block still reads cpu: on an idle machine, and stretched by load', () => {
    expect(holdVerdict({
      lateByMs: 1_000, windowMs: 1_900, mainCpuMs: 1_050, holdCpuMs: 1_020, afterHoldCpuMs: 30,
      holdFromMs: -40, holdToMs: 1_010, baseCpuShare: 0.03, baseTurnMs: 20,
      gcMs: 0, majorFaults: 0, invCtxSwitches: 5, volCtxSwitches: 1, loopIdleSource: 'none',
    })).toBe('cpu')
    // The 2026-10-03 hot loop at load 120 (1.35 s of CPU in a 3.5 s hold), 2% before.
    expect(holdVerdict({
      lateByMs: 3_486, windowMs: 4_486, mainCpuMs: 1_353, holdCpuMs: 1_340, afterHoldCpuMs: 13,
      holdFromMs: -30, holdToMs: 3_500, baseCpuShare: 0.02, baseTurnMs: 20,
      gcMs: 0, majorFaults: 0, invCtxSwitches: 6_559, volCtxSwitches: 0, loopIdleSource: 'none',
    })).toBe('cpu')
  })
})

describe('captureHold on this runtime', () => {
  it('marks a hold from a loop without an idle clock, and leaves its idle time out', async () => {
    await new Promise((r) => setTimeout(r, 50))
    const mono = () => Number(process.hrtime.bigint()) / 1e6
    const prev = readTick(mono())
    const end = Date.now() + 30
    while (Date.now() < end) { /* hold the loop */ }
    const ctx = captureHold(prev, 0, mono(), performance.now() - mono())
    // The runtimes' facts, pinned: Node keeps the clock, bun reports zeros.
    const u = performance.eventLoopUtilization()
    const onBun = !!(process.versions as { bun?: string }).bun
    expect(u.idle + u.active > 0).toBe(!onBun)
    if (onBun) {
      expect(ctx.loopIdleSource).toBe('none')
      expect('loopIdleMs' in ctx).toBe(false)
    } else {
      expect(ctx.loopIdleSource).toBeUndefined()
      expect(typeof ctx.loopIdleMs).toBe('number')
    }
  })
})
