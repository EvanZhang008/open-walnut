/**
 * The stall recorder's hold span on real CPU: with checkpoints placed by hand
 * (a block keeps its own CPU, a stop's catch-up is not the hold's), and with
 * the running recorder's own checkpoints (src/core/stall-recorder-checkpoints.ts:
 * a 100 ms timer and one at the end of every loop iteration). Real CPU burns
 * and real stops of 2 to 3 s: slow tier.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startStallRecorder, stopStallRecorder, _recorderObserverForTest, _cpuCheckpointForTest } from '../../src/core/stall-recorder.js'
import { cpuCheckpoints } from '../../src/core/stall-recorder-checkpoints.js'
import { log } from '../../src/logging/index.js'

describe('the running recorder reads the loop thread\'s CPU every 100 ms, and at the end of every loop iteration', () => {
  let dir: string
  const usage = (process as unknown as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage?.bind(process) ?? (() => process.cpuUsage())
  const cpuMs = (): number => { const u = usage(); return (u.user + u.system) / 1000 }
  const burn = (ms: number): void => { const end = cpuMs() + ms; let x = 0; while (cpuMs() < end) x++; void x }
  const mono = (): number => Number(process.hrtime.bigint()) / 1e6

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-checkpoint-'))
    vi.spyOn(log.web, 'info').mockImplementation(() => {})
    vi.spyOn(log.web, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    await stopStallRecorder()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('so a real block keeps its own CPU, and the work before it that let timers run does not count', async () => {
    await startStallRecorder({ force: true, dir, profile: false, systemContext: false })
    const obs = _recorderObserverForTest()
    obs.tick(mono())
    // 300 ms of CPU in 20 ms slices over at least 300 ms, the loop free between
    // them: the recorder's own timer takes its checkpoints. CPU-bounded, so a
    // loaded machine only makes it take longer.
    const c0 = cpuMs(), w0 = mono()
    while (cpuMs() - c0 < 300 || mono() - w0 < 300) { burn(20); await new Promise((r) => setTimeout(r, 5)) }
    const blockAt = mono()
    burn(400) // one synchronous block: no timer runs in it
    const lateBy = Math.max(1_000, mono() - blockAt)
    const hold = obs.hold(lateBy, blockAt + lateBy) as { mainCpuMs: number; holdCpuMs: number }
    expect(hold.mainCpuMs).toBeGreaterThanOrEqual(700)
    expect(hold.holdCpuMs).toBeGreaterThanOrEqual(400)
    expect(hold.holdCpuMs).toBeLessThan(hold.mainCpuMs - 150)
  })

  it('an idle loop still sleeps: about ten checkpoints a second, and no CPU to speak of', async () => {
    await startStallRecorder({ force: true, dir, profile: false, systemContext: false })
    await new Promise((r) => setTimeout(r, 200))
    const from = mono(), c0 = cpuMs()
    await new Promise((r) => setTimeout(r, 1_000))
    const n = [...cpuCheckpoints()].filter((c) => c.mono >= from).length
    const used = cpuMs() - c0
    // The end-of-iteration checkpoint is unref'd: it never keeps poll from
    // blocking, so it runs only when something else woke the loop. A spinning
    // loop would take one every 5 ms and burn the whole second.
    expect(n).toBeGreaterThanOrEqual(5)
    expect(n).toBeLessThanOrEqual(40)
    expect(used).toBeLessThan(100)
  })

  it('a loop that never sleeps reads the CPU clock at the end of an iteration at most every 5 ms', async () => {
    await startStallRecorder({ force: true, dir, profile: false, systemContext: false })
    await new Promise((r) => setTimeout(r, 50))
    // A setImmediate chain of 50 us pieces: thousands of iterations a second.
    // Without the cap each iteration a millisecond apart takes a checkpoint.
    const from = mono()
    await new Promise<void>((resolve) => {
      const step = (): void => { burn(0.05); if (mono() - from < 600) setImmediate(step); else resolve() }
      setImmediate(step)
    })
    const to = mono()
    const marks = [...cpuCheckpoints()].map((c) => c.mono).filter((m) => m >= from && m <= to)
    const span = to - from
    // One per 5 ms at the end of iterations, one per 100 ms from the timer.
    expect(marks.length).toBeLessThanOrEqual(Math.ceil(span / 5 + span / 100) + 2)
    expect(marks.length).toBeGreaterThanOrEqual(20)
  })

  it('a checkpoint falls between any two runs of a 20 ms timer (the one at the end of every iteration)', async () => {
    await startStallRecorder({ force: true, dir, profile: false, systemContext: false })
    // Each run burns 5 ms of CPU. The 100 ms timer alone would miss most of the
    // gaps; the checkpoint at the end of the loop iteration follows every run,
    // however late the machine runs it.
    const runs: number[] = []
    const t = setInterval(() => { runs.push(mono()); burn(5) }, 20)
    try {
      const end = mono() + 20_000
      while (runs.length < 31) {
        if (mono() > end) throw new Error(`timed out waiting for runs: ${runs.length} of 31`)
        await new Promise((r) => setTimeout(r, 50))
      }
    } finally {
      clearInterval(t)
    }
    const marks = [...cpuCheckpoints()].map((c) => c.mono)
    const pairs = runs.slice(1).map((b, i) => [runs[i], b])
    const missed = pairs.filter(([a, b]) => !marks.some((m) => m > a && m < b))
    expect(pairs.length).toBeGreaterThanOrEqual(30)
    expect(missed).toEqual([])
  }, 30_000)

  it('after a stop, the timers that came due catch up after the hold, not in it (25 timers of 12 ms every 1.5 s)', async () => {
    await startStallRecorder({ force: true, dir, profile: false, systemContext: false })
    const obs = _recorderObserverForTest()
    // When each timer last started: Node re-arms an interval from that moment.
    const lastStart: number[] = []
    let onBurstEnd: (() => void) | null = null
    const timers: NodeJS.Timeout[] = []
    type Hold = { holdCpuMs: number; afterHoldCpuMs: number; holdToMs: number; verdict: string }
    try {
      for (let k = 0; k < 25; k++) {
        timers.push(setInterval(() => {
          lastStart[k] = mono()
          burn(12)
          if (k === 24 && onBurstEnd) { const go = onBurstEnd; onBurstEnd = null; go() }
        }, 1_500))
      }
      // Between two bursts, 700 ms before the next one is due: a probe tick (its
      // deadline 1 s later, after that burst is due), and 300 ms later the thread
      // asleep for 3 s inside a callback (a stop: no CPU, no timer runs, nothing
      // is idle). The burst comes due during the stop, and the checkpoint at the
      // end of that loop iteration runs before it catches up. Every run is checked
      // (round 7 ran this mid-burst and kept the first run in which the
      // recorder's 5 ms timer won the race with the next burst timer: a loaded
      // machine lost it 18 times in 48).
      for (let run = 0; run < 3; run++) {
        const r = await new Promise<{ hold: Hold; aheadMs: number }>((resolve) => {
          onBurstEnd = () => {
            const nextDue = Math.min(...lastStart) + 1_500
            setTimeout(() => {
              const t0 = mono()
              let aheadMs = 0
              obs.tick(t0)
              setTimeout(() => { const now = mono(); resolve({ hold: obs.hold(now - (t0 + 1_000), now) as Hold, aheadMs }) }, 1_000)
              setTimeout(() => {
                aheadMs = nextDue - mono()
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000)
              }, 300)
            }, Math.max(0, nextDue - 700 - mono()))
          }
        })
        expect(r.aheadMs, `run ${run}: the next burst still ahead when the stop began`).toBeGreaterThan(50)
        // Counted to the probe, the catch-up would be the hold's own.
        expect(r.hold.holdCpuMs, `run ${run}`).toBeLessThan(100)
        expect(r.hold.afterHoldCpuMs, `run ${run}`).toBeGreaterThanOrEqual(250)
        expect(r.hold.holdToMs, `run ${run}`).toBeGreaterThanOrEqual(1_500)
        expect(r.hold.verdict, `run ${run}`).not.toBe('cpu')
      }
    } finally {
      for (const t of timers) clearInterval(t)
    }
  }, 60_000)

  it('a stop just before a batch of timers comes due: the batch catches up after the hold', async () => {
    await startStallRecorder({ force: true, dir, profile: false, systemContext: false })
    const obs = _recorderObserverForTest()
    type Hold = { holdCpuMs: number; afterHoldCpuMs: number; verdict: string }
    await new Promise((r) => setTimeout(r, 300))
    // A callback arms 25 timers of 12 ms, due 1 ms on, and then sleeps for 2 s (a
    // stop). The batch is due before the recorder's 100 ms timer runs again, so
    // that timer would come after it, every batch timer back to back; the
    // checkpoint at the end of the iteration comes between the stop and the batch.
    for (let run = 0; run < 3; run++) {
      const hold = await new Promise<Hold>((resolve) => {
        const t0 = mono()
        obs.tick(t0)
        setTimeout(() => { const now = mono(); resolve(obs.hold(now - (t0 + 1_000), now) as Hold) }, 1_000)
        setTimeout(() => {
          for (let k = 0; k < 25; k++) setTimeout(() => burn(12), 1)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000)
        }, 20)
      })
      expect(hold.holdCpuMs, `run ${run}`).toBeLessThan(100)
      expect(hold.afterHoldCpuMs, `run ${run}`).toBeGreaterThanOrEqual(250)
      expect(hold.verdict, `run ${run}`).not.toBe('cpu')
      await new Promise((r) => setTimeout(r, 200))
    }
  }, 30_000)

  it('reads the loop\'s idle time with each checkpoint: a quiet loop waits in poll through the hold', async () => {
    await startStallRecorder({ force: true, dir, profile: false, systemContext: false })
    const obs = _recorderObserverForTest()
    const t0 = mono()
    obs.tick(t0)
    await new Promise((r) => setTimeout(r, 1_150))
    const now = mono()
    // A deadline 100 ms after the tick: the hold runs between two of the
    // recorder's checkpoints, a quiet loop sleeping in poll between them.
    const hold = obs.hold(now - (t0 + 100), now) as { loopIdleMs: number; holdFromMs: number; holdToMs: number }
    expect(hold.holdToMs - hold.holdFromMs).toBeGreaterThan(0)
    expect(hold.loopIdleMs).toBeGreaterThanOrEqual(0.5 * (hold.holdToMs - hold.holdFromMs))
  })
})

describe('a hold runs from the last moment before its deadline the loop ran a timer to the first one after it', () => {
  // Real thread CPU, probe and checkpoint times chosen: off the real clock, so
  // neither load nor timing moves the numbers. The recorder's own clock: the
  // loop thread's CPU, or the process's on a Node without threadCpuUsage (22).
  const usage = (process as unknown as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage?.bind(process) ?? (() => process.cpuUsage())
  const cpuMs = (): number => { const u = usage(); return (u.user + u.system) / 1000 }
  const burn = (ms: number): void => { const end = cpuMs() + ms; let x = 0; while (cpuMs() < end) x++; void x }
  beforeEach(() => _cpuCheckpointForTest('reset'))
  afterEach(() => _cpuCheckpointForTest('reset'))

  it('a block that began before the deadline keeps all of its CPU; the usual work before it does not count', () => {
    const obs = _recorderObserverForTest()
    obs.tick(10_000)
    burn(250) // the loop's usual work, timers still running
    _cpuCheckpointForTest(10_600)
    burn(400) // a block from 10.6 s: the probe due at 11 s fires at 13 s
    _cpuCheckpointForTest(12_990) // the recorder's timer, first once the block ends
    const hold = obs.hold(2_000, 13_000) as { mainCpuMs: number; holdCpuMs: number; afterHoldCpuMs: number; windowMs: number; holdFromMs: number; holdToMs: number }
    expect(hold.windowMs).toBe(3_000)
    expect(hold.mainCpuMs).toBeGreaterThanOrEqual(650)
    expect(hold.holdCpuMs).toBeGreaterThanOrEqual(400)
    expect(hold.holdCpuMs).toBeLessThan(hold.mainCpuMs - 200)
    expect(hold.afterHoldCpuMs).toBeLessThan(50)
    expect([hold.holdFromMs, hold.holdToMs]).toEqual([-400, 1_990])
  })

  it('a busy loop stopped for 3 s: the timers catching up after the stop are not the hold\'s', () => {
    const obs = _recorderObserverForTest()
    obs.tick(20_000)
    burn(300)
    _cpuCheckpointForTest(20_900) // the last timer before the stop
    // Stopped 20.95 to 23.95 s in the middle of a 15 ms piece of work. On the
    // way out the checkpoint at the end of the loop iteration runs first, then
    // 25 timers that came due during the stop, then the probe.
    burn(15)
    _cpuCheckpointForTest(23_955)
    burn(375)
    const hold = obs.hold(2_970, 23_970) as { mainCpuMs: number; holdCpuMs: number; afterHoldCpuMs: number; verdict: string }
    expect(hold.mainCpuMs).toBeGreaterThanOrEqual(690)
    expect(hold.holdCpuMs).toBeGreaterThanOrEqual(15)
    expect(hold.holdCpuMs).toBeLessThan(100)
    expect(hold.afterHoldCpuMs).toBeGreaterThanOrEqual(375)
    expect(hold.verdict).not.toBe('cpu')
  })

  it('a block that starts after the deadline, behind the recorder\'s timer, is still the culprit', () => {
    const obs = _recorderObserverForTest()
    obs.tick(40_000)
    _cpuCheckpointForTest(40_990)
    _cpuCheckpointForTest(41_005) // the loop ran a timer after the deadline
    burn(1_200) // then a block held the probe for 1.2 s
    const hold = obs.hold(1_210, 42_210) as { holdCpuMs: number; afterHoldCpuMs: number; verdict: string }
    expect(hold.holdCpuMs).toBeLessThan(50)
    expect(hold.afterHoldCpuMs).toBeGreaterThanOrEqual(1_200)
    expect(hold.verdict).toBe('cpu')
  })

  it('a pause the loop came back from behind that timer owes its backlog', () => {
    const obs = _recorderObserverForTest()
    obs.tick(44_000)
    _cpuCheckpointForTest(44_990)
    _cpuCheckpointForTest(45_005) // the loop ran a timer after the deadline
    _cpuCheckpointForTest(47_005) // then came back from a 2 s stop through poll
    burn(400) // the timers that came due in the stop, ahead of the probe
    const hold = obs.hold(2_500, 47_500) as { afterHoldPauseMs: number; afterHoldCpuMs: number; verdict: string }
    expect(hold.afterHoldPauseMs).toBe(2_000)
    expect(hold.afterHoldCpuMs).toBeGreaterThanOrEqual(400)
    expect(hold.verdict).not.toBe('cpu')
  })

  it('carries the loop\'s rate and largest turn before the hold', () => {
    const obs = _recorderObserverForTest()
    for (let t = 68_500; t <= 70_900; t += 100) _cpuCheckpointForTest(t)
    obs.tick(70_000)
    _cpuCheckpointForTest(71_005)
    const hold = obs.hold(1_200, 72_200) as { baseCpuShare?: number; baseTurnMs?: number }
    expect(typeof hold.baseCpuShare).toBe('number')
    expect(typeof hold.baseTurnMs).toBe('number')
  })

  it('measures how long the loop waited in poll inside the hold', () => {
    const obs = _recorderObserverForTest()
    obs.tick(50_000)
    _cpuCheckpointForTest(50_900, 1_000)
    _cpuCheckpointForTest(53_950, 4_020) // stopped in poll: 3 s of the loop's idle time
    const hold = obs.hold(2_960, 53_960) as { loopIdleMs: number; holdFromMs: number; holdToMs: number }
    expect(hold.loopIdleMs).toBe(3_020)
    expect([hold.holdFromMs, hold.holdToMs]).toEqual([-100, 2_950])
  })

  it('a hold that begins as the loop comes back from a long wait in poll carries that wait', () => {
    const obs = _recorderObserverForTest()
    _cpuCheckpointForTest(56_990, 1_000)
    _cpuCheckpointForTest(60_000, 4_000) // a 3 s stop in poll ended here
    obs.tick(60_010) // the probe ran right after it
    burn(300) // then the reads that piled up, in one turn
    const hold = obs.hold(1_300, 62_310) as { afterWaitMs: number; holdCpuMs: number; holdFromMs: number }
    expect(hold.afterWaitMs).toBe(3_010)
    expect(hold.holdCpuMs).toBeGreaterThanOrEqual(300)
    expect(hold.holdFromMs).toBe(-1_000)
  })

  it('the loop\'s own checkpoints right after a long wait do not hide it', () => {
    const obs = _recorderObserverForTest()
    _cpuCheckpointForTest(56_990, 1_000)
    _cpuCheckpointForTest(60_000, 4_000) // a 3 s stop in poll ended here (the end of that iteration)
    _cpuCheckpointForTest(60_002, 4_000) // the 100 ms timer, in the next one
    obs.tick(60_010)
    burn(300)
    const hold = obs.hold(1_300, 62_310) as { afterWaitMs: number }
    expect(hold.afterWaitMs).toBe(3_010)
  })

  it('without a checkpoint since the previous probe the whole window counts', () => {
    const obs = _recorderObserverForTest()
    obs.tick(30_000)
    burn(300)
    const hold = obs.hold(2_000, 33_000) as { mainCpuMs: number; holdCpuMs: number; afterHoldCpuMs: number }
    expect(hold.holdCpuMs).toBe(hold.mainCpuMs)
    expect(hold.afterHoldCpuMs).toBe(0)
  })
})
