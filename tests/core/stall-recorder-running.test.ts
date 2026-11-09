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
