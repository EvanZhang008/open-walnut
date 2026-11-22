/**
 * The deadline rule of the daemon's async file writes (src/providers/file-pool-deadline.ts): a
 * slow disk keeps waiting, a wedged pool goes synchronous once, and a cancel ends it all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { armFilePoolDeadline } from '../../src/providers/file-pool-deadline.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** A stat whose answers the test releases by hand (or never). */
function pool() {
  const pending: Array<() => void> = []
  return {
    stat: vi.fn(() => new Promise<void>((resolve) => { pending.push(resolve) })),
    answer: () => { pending.shift()?.() },
  }
}

describe('armFilePoolDeadline', () => {
  it('does nothing before the deadline', async () => {
    const p = pool()
    const onWedged = vi.fn()
    armFilePoolDeadline({ fsp: p, deadlineMs: 2000, onWedged })
    await vi.advanceTimersByTimeAsync(1999)
    expect(p.stat).not.toHaveBeenCalled()
    expect(onWedged).not.toHaveBeenCalled()
  })

  it('a pool that answers the probe is a slow disk: no sync, the deadline is armed again', async () => {
    const p = pool()
    const onWedged = vi.fn()
    const onSlow = vi.fn()
    armFilePoolDeadline({ fsp: p, deadlineMs: 2000, onWedged, onSlow })
    await vi.advanceTimersByTimeAsync(2000)
    expect(p.stat).toHaveBeenCalledWith('/')
    p.answer()
    await vi.advanceTimersByTimeAsync(600)
    expect(onWedged).not.toHaveBeenCalled()
    expect(onSlow).toHaveBeenCalledWith(2000)
    // Armed again from the answer (t = 2000): the next deadline, at t = 4000, probes again.
    await vi.advanceTimersByTimeAsync(1400)
    expect(p.stat).toHaveBeenCalledTimes(2)
    p.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(onSlow).toHaveBeenLastCalledWith(4000)
    expect(onWedged).not.toHaveBeenCalled()
  })

  it('a pool that does not answer within the probe limit is wedged: onWedged once, never again', async () => {
    const p = pool()
    const onWedged = vi.fn()
    armFilePoolDeadline({ fsp: p, deadlineMs: 2000, onWedged })
    await vi.advanceTimersByTimeAsync(2499)
    expect(onWedged).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onWedged).toHaveBeenCalledTimes(1)
    p.answer() // the late answer changes nothing
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onWedged).toHaveBeenCalledTimes(1)
    expect(p.stat).toHaveBeenCalledTimes(1)
  })

  it('a longer probe limit (a runtime in a server process) waits that long before wedged', async () => {
    const p = pool()
    const onWedged = vi.fn()
    armFilePoolDeadline({ fsp: p, deadlineMs: 2000, probeMs: 5000, onWedged })
    await vi.advanceTimersByTimeAsync(2000 + 4999)
    expect(onWedged).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onWedged).toHaveBeenCalledTimes(1)
  })

  it('a probe that rejects still means the pool is alive', async () => {
    const onWedged = vi.fn()
    armFilePoolDeadline({ fsp: { stat: () => Promise.reject(new Error('EACCES')) }, deadlineMs: 2000, onWedged })
    await vi.advanceTimersByTimeAsync(3000)
    expect(onWedged).not.toHaveBeenCalled()
  })

  it('with no way to ask the pool the probe timer decides (wedged)', async () => {
    const onWedged = vi.fn()
    armFilePoolDeadline({ fsp: {}, deadlineMs: 2000, onWedged })
    await vi.advanceTimersByTimeAsync(2500)
    expect(onWedged).toHaveBeenCalledTimes(1)
  })

  it('cancel before the deadline, or during the probe, never calls back', async () => {
    const p = pool()
    const onWedged = vi.fn()
    const onSlow = vi.fn()
    const cancelEarly = armFilePoolDeadline({ fsp: p, deadlineMs: 2000, onWedged, onSlow })
    cancelEarly()
    await vi.advanceTimersByTimeAsync(5000)
    expect(p.stat).not.toHaveBeenCalled()

    const cancelInProbe = armFilePoolDeadline({ fsp: p, deadlineMs: 2000, onWedged, onSlow })
    await vi.advanceTimersByTimeAsync(2000)
    expect(p.stat).toHaveBeenCalledTimes(1)
    cancelInProbe()
    p.answer()
    await vi.advanceTimersByTimeAsync(5000)
    expect(onWedged).not.toHaveBeenCalled()
    expect(onSlow).not.toHaveBeenCalled()
  })
})
