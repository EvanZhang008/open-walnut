/**
 * The stall flight record (src/core/stall-recorder.ts) weighs the kept CPU
 * profile: what it saw of the hold itself (`profileHold`) can make a hold
 * `cpu` the counters alone would not, time the sampler missed counts as
 * nothing, and the part after the hold gets its own view (`profileAfter`).
 * The profiler is a stand-in that lays samples out against the hold.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  startStallRecorder,
  stopStallRecorder,
  _rotateNowForTest,
  _recorderObserverForTest,
  type ProfilerDriver,
} from '../../src/core/stall-recorder.js'
import type { ProbeObserver, StallReport } from '../../src/core/event-loop-monitor.js'
import { log } from '../../src/logging/index.js'

/** The observer the running recorder installed on the probe. */
const observerOf = (): ProbeObserver => _recorderObserverForTest()

describe('the flight record verdict weighs the kept profile', () => {
  let dir: string
  const warns: Array<[string, Record<string, unknown>]> = []
  const mono = () => Number(process.hrtime.bigint()) / 1e6

  const NODES = [
    { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 }, children: [2, 3, 4, 5] },
    { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: 0, columnNumber: 0 } },
    { id: 3, callFrame: { functionName: 'rankEveryRow', url: 'file:///repo/dist/core/rank.js', lineNumber: 9, columnNumber: 0 } },
    { id: 4, callFrame: { functionName: 'spawn', url: '', lineNumber: 0, columnNumber: 0 } },
    { id: 5, callFrame: { functionName: 'nextTick', url: 'node:internal/process/task_queues', lineNumber: 111, columnNumber: 0 } },
  ]
  const IDLE = 2, CODE = 3, SPAWN = 4, TICK = 5
  type Sample = [atMs: number, node: number]
  let holdStartMono = 0

  /**
   * A kept profile laid out against the hold: `timeline` gets the hold start in
   * profile ms (profile time 0 = the window's begin, the same clock the
   * recorder calibrates from) and returns [ms, node] samples in order.
   */
  const shaped = (timeline: (holdMs: number) => Sample[]): ProfilerDriver => {
    const began = new Map<string, number>()
    return {
      begin: async (title) => { began.set(title, mono()) },
      end: async (title) => {
        const list = timeline(holdStartMono - began.get(title)!)
        const samples: number[] = []
        const timeDeltas: number[] = []
        let last = 0
        for (const [atMs, node] of list) {
          const atUs = Math.max(last, Math.round(atMs * 1000))
          samples.push(node); timeDeltas.push(atUs - last); last = atUs
        }
        return { nodes: NODES, startTime: 0, endTime: last, samples, timeDeltas }
      },
      close: async () => {},
    }
  }
  /** One sample every 20 ms over [fromMs, toMs). */
  const every20 = (fromMs: number, toMs: number, node: (atMs: number) => number): Sample[] => {
    const out: Sample[] = []
    for (let t = Math.max(0, fromMs); t < toMs; t += 20) out.push([t, node(t)])
    return out
  }
  const steady = (node: number) => shaped((h) => every20(h - 1_000, h + 30_000, () => node))

  // Counters only, these read `starved`: 400 ms of thread CPU in a 4 s window,
  // preempted 900 times, never waiting on its own. 400 ms is a stall's worth of
  // CPU but not a quarter of the hold, so only the profile can say `cpu`.
  const starvedHold = {
    windowMs: 4_000, mainCpuMs: 400, mainSysMs: 5, mainCpuSource: 'thread', procCpuMs: 400, majorFaults: 0, minorFaults: 3,
    invCtxSwitches: 900, volCtxSwitches: 0, gcMs: 0, gcCount: 0, gcMaxMs: 0, gcMajor: 0, rssMb: 300, heapUsedMb: 80,
    heapTotalMb: 120, externalMb: 5, arrayBuffersMb: 1, load1: 200, cores: 14, freeMemMb: 500, verdict: 'starved',
  }

  async function record(driver: ProfilerDriver, over: Record<string, unknown> = {}, lateByMs = 3_000): Promise<Record<string, unknown>> {
    await startStallRecorder({ force: true, dir, windowMs: 3_600_000, postStallMs: 3_600_000, profileMinMs: 1_000, profiler: driver, systemContext: false })
    // The hold starts a second into the window, so the profile covers it whole.
    const due = mono() + 2_000
    holdStartMono = due - 1_000
    const r: StallReport = {
      lateByMs, holdStartMono, dueMono: due, holdEndMono: due + lateByMs, wallNow: Date.now(),
      suspectSection: null, hold: { ...starvedHold, windowMs: lateByMs + 1_000, ...over },
    } as StallReport
    observerOf().reported(r)
    await _rotateNowForTest()
    for (let i = 0; i < 250 && !warns.some(([m]) => m === 'event-loop stall flight record'); i++) await new Promise((res) => setTimeout(res, 20))
    return warns.find(([m]) => m === 'event-loop stall flight record')![1]
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-verdict-'))
    warns.length = 0
    vi.spyOn(log.web, 'warn').mockImplementation((msg: string, data?: Record<string, unknown>) => { warns.push([msg, data ?? {}]) })
    vi.spyOn(log.web, 'info').mockImplementation(() => {})
  })

  afterEach(async () => {
    await stopStallRecorder()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a hold the counters call starved is cpu when the profile shows code on the thread', async () => {
    const rec = await record(steady(CODE))
    const hold = rec.hold as Record<string, unknown>
    expect(hold.verdict).toBe('cpu')
    expect(hold.loadStretched).toBe(true)
    const seen = rec.profileHold as { codeShare: number; coverage: number; top: { frame: string }[] }
    expect(seen.codeShare).toBe(1)
    expect(seen.coverage).toBe(1)
    expect(seen.top[0].frame).toBe('rankEveryRow /repo/dist/core/rank.js:10')
    // The meta beside the profile carries the same final verdict.
    const metaFile = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!
    expect(JSON.parse(fs.readFileSync(path.join(dir, metaFile), 'utf8')).stalls[0].hold.verdict).toBe('cpu')
  })

  it('stays starved when the profile shows the thread parked', async () => {
    const rec = await record(steady(IDLE))
    expect((rec.hold as Record<string, unknown>).verdict).toBe('starved')
    expect((rec.hold as Record<string, unknown>).loadStretched).toBeUndefined()
    expect((rec.profileHold as { idleShare: number }).idleShare).toBe(1)
  })

  it('stays starved when code is sampled all along but the thread ran less than one stall threshold', async () => {
    // A thread preempted inside a short callback: 150 ms of CPU in the hold.
    const rec = await record(steady(CODE), { mainCpuMs: 150, procCpuMs: 150 })
    expect((rec.profileHold as { codeShare: number }).codeShare).toBe(1)
    expect((rec.hold as Record<string, unknown>).verdict).toBe('starved')
  })

  it('a process the machine starved stays starved: the sampler starved too, and its gaps are not code (real load)', async () => {
    // Measured 2026-10-03: 48 ms of thread CPU in a 5.4 s hold, 13 samples
    // where about 270 were due, read as 68% code because each gap went to the
    // frame sampled before it (a spawn, a nextTick).
    const frames = [SPAWN, TICK, IDLE, SPAWN, SPAWN, IDLE, TICK, SPAWN, IDLE, SPAWN, TICK, IDLE, SPAWN]
    const rec = await record(shaped((h) => [
      // Parked before the hold, and 40 ms clear of it, so no sample from
      // before reaches in: the 13 are the hold's own.
      ...every20(h - 1_000, h - 40, () => IDLE),
      ...frames.map((node, k): Sample => [h + 20 + k * 416, node]),
      ...every20(h + 5_430, h + 30_000, () => IDLE),
    ]), { mainCpuMs: 48, mainSysMs: 3, procCpuMs: 49, invCtxSwitches: 455, minorFaults: 1, gcMs: 2, load1: 39 }, 4_409)
    const seen = rec.profileHold as { samples: number; codeShare: number; coverage: number }
    expect(seen.samples).toBe(13)
    // What it saw was code (9 of 13), but it saw a tenth of the hold, and the
    // thread ran 48 ms: less than one stall threshold of CPU.
    expect(seen.coverage).toBeLessThanOrEqual(0.15)
    expect(seen.codeShare).toBeGreaterThan(0.5)
    expect((rec.hold as Record<string, unknown>).verdict).toBe('starved')
    expect((rec.hold as Record<string, unknown>).loadStretched).toBeUndefined()
  })

  it('weighs each sample by the configured sampling interval, not by the profile\'s own median gap', async () => {
    // A sampler that catches up in bursts: ten samples 0.1 ms apart every
    // 100 ms. Each burst's last sample stands for two configured intervals
    // (40 ms at the default 20 ms); the median gap (0.1 ms) would credit it with
    // 0.2 ms and call the hold almost unsampled.
    const bursts = shaped((h) => {
      const out: Sample[] = []
      for (let t = Math.max(0, h - 1_000); t < h + 30_000; t += 100) for (let i = 0; i < 10; i++) out.push([t + i * 0.1, CODE])
      return out
    })
    const seen = (await record(bursts)).profileHold as { coverage: number; codeShare: number }
    expect(seen.codeShare).toBe(1)
    expect(seen.coverage).toBeGreaterThan(0.3)
    expect(seen.coverage).toBeLessThan(0.5)
  })

  it('weighs only the samples inside the hold itself, not the busy second before it or the catch-up after it', async () => {
    // A loop busy until 100 ms before the deadline, quiet in poll from there,
    // stopped 300 ms after the deadline, then 500 ms of timers catching up
    // before the probe. Over the whole probe window that is 78% code; the hold
    // itself (10 ms before the deadline to the recorder's timer at +2.4 s) was idle.
    const rec = await record(shaped((h) => [
      ...every20(h - 1_000, h + 900, () => CODE),
      ...every20(h + 900, h + 1_300, () => IDLE),
      ...every20(h + 3_500, h + 4_000, () => CODE),
      ...every20(h + 4_000, h + 30_000, () => IDLE),
    ]), { mainCpuMs: 400, holdCpuMs: 300, afterHoldCpuMs: 100, holdFromMs: -10, holdToMs: 2_400 })
    const seen = rec.profileHold as { codeShare: number; idleShare: number; samples: number }
    expect(seen.codeShare).toBe(0)
    expect(seen.idleShare).toBe(1)
    expect(seen.samples).toBeGreaterThanOrEqual(15)
    expect((rec.hold as Record<string, unknown>).verdict).toBe('starved')
    // 100 ms after the hold is no catch-up worth a view of its own.
    expect(rec.profileAfter).toBeUndefined()
  })

  it('a block after the hold gets the profile\'s view of that part (profileAfter), and past the stop\'s backlog it is cpu', async () => {
    // The gate's waketimer shape: a timer that came due in a 3 s stop ran a
    // 600 ms block after the recorder's checkpoint at the end of the stop's
    // iteration. The hold is the stop (nothing sampled), the block the part after it.
    const rec = await record(shaped((h) => [
      ...every20(h - 1_000, h + 400, () => IDLE),
      ...every20(h + 3_540, h + 4_140, () => CODE),
      ...every20(h + 4_140, h + 30_000, () => IDLE),
    ]), {
      mainCpuMs: 620, holdCpuMs: 0, afterHoldCpuMs: 600, loopIdleMs: 3_100, holdFromMs: -600, holdToMs: 2_540,
      afterWaitMs: 0, baseCpuShare: 0.04, invCtxSwitches: 3_000,
    }, 3_140)
    expect(rec.profileHold).toBeUndefined()
    const after = rec.profileAfter as { codeShare: number; coverage: number; top: { frame: string }[] }
    expect(after.codeShare).toBe(1)
    expect(after.coverage).toBe(1)
    expect(after.top[0].frame).toBe('rankEveryRow /repo/dist/core/rank.js:10')
    const hold = rec.hold as Record<string, unknown>
    expect(hold.verdict).toBe('cpu')
    expect(hold.loadStretched).toBe(true)
    const metaFile = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!
    const meta = JSON.parse(fs.readFileSync(path.join(dir, metaFile), 'utf8')).stalls[0]
    expect(meta.profileAfter.codeShare).toBe(1)
    expect(meta.profileHold).toBeNull()
  })

  it('a 3 s SIGSTOP stays starved although the last sample before it was code', async () => {
    // Measured 2026-10-03: 291 ms of thread CPU in a 4.1 s hold; the process
    // (sampler included) stopped for 3 s right after a code sample, and the old
    // math gave that sample the 3 s: 84% code, `cpu`.
    const rec = await record(shaped((h) => [
      // A loop that works a third of the time, up to the stop.
      ...every20(h - 1_000, h + 1_001, (t) => (Math.round((t - h) / 20) % 3 === 2 ? CODE : IDLE)),
      ...every20(h + 4_100, h + 30_000, () => IDLE),
    ]), { mainCpuMs: 291, mainSysMs: 6, procCpuMs: 293, invCtxSwitches: 510, gcMs: 2 }, 3_126)
    const seen = rec.profileHold as { codeShare: number; coverage: number; top: { frame: string }[] }
    // A third of what was sampled is code; the 3 s after the last sample are
    // not sampled time at all.
    expect(seen.coverage).toBeLessThan(0.3)
    expect(seen.codeShare).toBeLessThan(0.4)
    expect(seen.top[0].frame).toBe('rankEveryRow /repo/dist/core/rank.js:10')
    expect((rec.hold as Record<string, unknown>).verdict).toBe('starved')
  })

  it('weighs a full collection by its own time inside the hold (gcMajorMs), not by the window context', async () => {
    await startStallRecorder({ force: true, dir, windowMs: 3_600_000, postStallMs: 3_600_000, profileMinMs: 1, profiler: steady(IDLE), systemContext: false })
    const v8 = await import('node:v8')
    const vm = await import('node:vm')
    v8.setFlagsFromString('--expose-gc')
    const gc = vm.runInNewContext('gc') as () => void
    // A live heap a full collection takes some ms to mark.
    const heap = Array.from({ length: 1_000_000 }, (_, i) => ({ i, s: `acme-${i}` }))
    await new Promise((res) => setTimeout(res, 200))
    const from = mono()
    gc()
    const to = mono()
    await new Promise((res) => setTimeout(res, 100))
    // The hold is the collection; the context the probe captured says the
    // window had no full collection time, and the record weighs the hold's own.
    holdStartMono = from - 5
    const r = {
      lateByMs: Math.round(to - from) + 10, holdStartMono, dueMono: from, holdEndMono: to + 5, wallNow: Date.now(),
      suspectSection: null, hold: { ...starvedHold, windowMs: 2_000, gcMajorMs: 0 },
    } as StallReport
    observerOf().reported(r)
    await _rotateNowForTest()
    for (let i = 0; i < 250 && !warns.some(([m]) => m === 'event-loop stall flight record'); i++) await new Promise((res) => setTimeout(res, 20))
    const hold = warns.find(([m]) => m === 'event-loop stall flight record')![1].hold as Record<string, number>
    expect(heap.length).toBe(1_000_000)
    expect(hold.gcMajor).toBeGreaterThanOrEqual(1)
    expect(hold.gcMajorMs).toBeGreaterThan(0)
    expect(hold.gcMajorMs).toBeLessThanOrEqual(hold.gcMs)
  })
})
