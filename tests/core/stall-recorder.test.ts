/**
 * Stall flight recorder (src/core/stall-recorder.ts): the verdict, the env
 * switches, which profile window a stall lands in, retention, and the probe
 * wiring that hands a late tick to the recorder. The profiler is a stand-in
 * here; tests/core/stall-recorder-profile.test.ts drives the real inspector.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  holdVerdict,
  stallRecorderEnabled,
  startStallRecorder,
  stopStallRecorder,
  _stallRecorderStats,
  _rotateNowForTest,
  _recorderObserverForTest,
  type ProfilerDriver,
} from '../../src/core/stall-recorder.js'
import {
  setProbeObserver,
  startEventLoopMonitor,
  stopEventLoopMonitor,
  type ProbeObserver,
  type StallReport,
  type MonitorClocks,
} from '../../src/core/event-loop-monitor.js'
import { log } from '../../src/logging/index.js'

describe('holdVerdict', () => {
  const base = { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 0, gcMs: 0, majorFaults: 0, invCtxSwitches: 0 }
  it.each([
    ['cpu: the loop thread ran through the hold', { mainCpuMs: 3_800 }, 'cpu'],
    ['gc: most of the hold was collection', { mainCpuMs: 3_800, gcMs: 2_000 }, 'gc'],
    // A synchronous loop the machine also slowed is still code holding the loop:
    // the counters alone used to call these `starved`, read as "not Walnut code".
    ['cpu: a busy loop preempted a lot (measured shape, 1.6 s of 3.6 s, 10k switches)', { windowMs: 3_590, mainCpuMs: 1_592, invCtxSwitches: 10_110 }, 'cpu'],
    ['cpu: a measured hot loop at load 120 (1.35 s of 4.5 s, 6559 involuntary, 0 voluntary)', { lateByMs: 3_486, windowMs: 4_486, mainCpuMs: 1_353, procCpuMs: 1_355, invCtxSwitches: 6_559, volCtxSwitches: 0, gcMs: 76 }, 'cpu'],
    ['cpu: the profile shows code on the thread although the counters look starved', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 150, invCtxSwitches: 900, volCtxSwitches: 0, codeShare: 0.9, profileSamples: 120 }, 'cpu'],
    ['starved: the profile shows the thread idle, so the counters stand', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 150, invCtxSwitches: 900, volCtxSwitches: 0, codeShare: 0.05, profileSamples: 120 }, 'starved'],
    ['starved: too few samples to outrank the counters', { lateByMs: 3_000, windowMs: 4_000, mainCpuMs: 150, invCtxSwitches: 900, volCtxSwitches: 0, codeShare: 1, profileSamples: 2 }, 'starved'],
    ['paging: barely ran, many hard faults', { mainCpuMs: 200, majorFaults: 500 }, 'paging'],
    ['off-cpu: barely ran, no faults, few switches (a blocking call)', { mainCpuMs: 20, invCtxSwitches: 3 }, 'off-cpu'],
    ['starved at 5% share: preempted, never waited (measured task-list shape, 110 ms CPU, 700 involuntary, 1 voluntary)', { lateByMs: 1_200, windowMs: 2_200, mainCpuMs: 110, invCtxSwitches: 700, volCtxSwitches: 1 }, 'starved'],
    ['off-cpu at 5% share: it waited on its own (voluntary switches dominate)', { mainCpuMs: 200, invCtxSwitches: 300, volCtxSwitches: 400 }, 'off-cpu'],
    ['starved at 0% share: runnable, never scheduled (measured isolated 7.5 s freeze: 5 ms CPU in 8.5 s, 148 involuntary, 1 voluntary)', { lateByMs: 7_483, windowMs: 8_483, mainCpuMs: 5, procCpuMs: 6, invCtxSwitches: 148, volCtxSwitches: 1 }, 'starved'],
    ['off-cpu: the switches belong to a busy worker thread, not the waiting loop', { mainCpuMs: 20, procCpuMs: 3_000, invCtxSwitches: 400, volCtxSwitches: 2 }, 'off-cpu'],
  ])('%s', (_name, over, verdict) => {
    expect(holdVerdict({ ...base, ...over })).toBe(verdict)
  })
})

describe('stallRecorderEnabled', () => {
  it('is on by default outside the test runner and off inside it', () => {
    expect(stallRecorderEnabled({})).toBe(true)
    expect(stallRecorderEnabled({ VITEST: 'true' })).toBe(false)
  })
  it('honours the kill switch and the explicit opt-in', () => {
    expect(stallRecorderEnabled({ WALNUT_STALL_RECORDER: '0' })).toBe(false)
    expect(stallRecorderEnabled({ VITEST: 'true', WALNUT_STALL_RECORDER: '1' })).toBe(true)
  })
  it('does not start in the test runner unless forced', async () => {
    expect(await startStallRecorder()).toBe(false)
    expect(_stallRecorderStats().running).toBe(false)
  })
})

/**
 * A profiler stand-in: each end returns a tiny profile named after the window
 * it closes (window1 is the first one begun), and it records how many titled
 * profiles were open at once.
 */
function fakeProfiler() {
  const open: string[] = []
  const begun: string[] = []
  const calls: string[] = []
  let minOpenAtEnd = Infinity
  const driver: ProfilerDriver = {
    begin: async (title) => { calls.push('begin'); open.push(title); begun.push(title) },
    end: async (title) => {
      calls.push('end')
      minOpenAtEnd = Math.min(minOpenAtEnd, open.length)
      const i = open.indexOf(title)
      if (i < 0) throw new Error(`not open: ${title}`)
      open.splice(i, 1)
      const n = begun.indexOf(title) + 1
      return { nodes: [{ id: 1, callFrame: { functionName: `window${n}`, url: '', lineNumber: 0, columnNumber: 0 }, children: [] }], startTime: 0, endTime: 1, samples: [1], timeDeltas: [1] }
    },
    close: async () => { calls.push('close') },
  }
  return { driver, calls, open, minOpenAtEnd: () => minOpenAtEnd }
}

describe('profile windows', () => {
  let dir: string
  const mono = () => Number(process.hrtime.bigint()) / 1e6
  const report = (dueOffsetMs: number, lateByMs = 3_000): StallReport => {
    const due = mono() + dueOffsetMs
    return { lateByMs, holdStartMono: due - 1_000, dueMono: due, holdEndMono: due + lateByMs, wallNow: Date.now(), suspectSection: null }
  }

  let fp: ReturnType<typeof fakeProfiler>
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-rec-'))
    vi.spyOn(log.web, 'warn').mockImplementation(() => {})
    vi.spyOn(log.web, 'info').mockImplementation(() => {})
    fp = fakeProfiler()
    await startStallRecorder({ force: true, dir, windowMs: 3_600_000, postStallMs: 3_600_000, profileMinMs: 1_000, profiler: fp.driver, systemContext: false })
  })

  it('rotates make-before-break: the next window begins before the old one ends', async () => {
    await _rotateNowForTest()
    await _rotateNowForTest()
    expect(fp.calls).toEqual(['begin', 'begin', 'end', 'begin', 'end'])
    // At every end another window was already open, so the profiler never idled.
    expect(fp.minOpenAtEnd()).toBe(2)
    expect(fp.open).toHaveLength(1)
    await stopStallRecorder()
    expect(fp.open).toHaveLength(0)
    expect(fp.calls.slice(-1)).toEqual(['close'])
  })

  afterEach(async () => {
    await stopStallRecorder()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // A record is complete once its .json is in place (the recorder writes the
  // profile first and renames each file in whole), so wait on the .json.
  const profilesWithMeta = () => {
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : []
    return names.filter((f) => f.endsWith('.cpuprofile') && names.includes(f.replace(/\.cpuprofile$/, '.json')))
  }
  const waitForFiles = async (n: number) => {
    for (let i = 0; i < 250; i++) {
      const files = profilesWithMeta()
      if (files.length >= n) return files
      await new Promise((r) => setTimeout(r, 20))
    }
    return profilesWithMeta()
  }

  it('writes nothing when no stall fell inside the window', async () => {
    await _rotateNowForTest()
    await _rotateNowForTest()
    expect(_stallRecorderStats().rotations).toBe(2)
    expect(_stallRecorderStats().previousHeld).toBe(true)
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([])
  })

  it('keeps the CURRENT window for a stall whose due time is after the last rotation', async () => {
    observerOf().reported(report(0))
    await _rotateNowForTest()
    const files = await waitForFiles(1)
    expect(files).toHaveLength(1)
    const meta = JSON.parse(fs.readFileSync(path.join(dir, files[0].replace(/\.cpuprofile$/, '.json')), 'utf8'))
    expect(meta.stalls).toHaveLength(1)
    expect(meta.stalls[0].lateByMs).toBe(3_000)
    const prof = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))
    expect(prof.nodes[0].callFrame.functionName).toBe('window1')
  })

  it('keeps the PREVIOUS window when the rotation ran after the due time (both timers fired at the hold end)', async () => {
    const r = report(-50) // due 50 ms ago, so before the rotation below
    await _rotateNowForTest() // window1 ends now, held as previous
    observerOf().reported(r)
    const files = await waitForFiles(1)
    expect(files).toHaveLength(1)
    const prof = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))
    expect(prof.nodes[0].callFrame.functionName).toBe('window1')
    expect(_stallRecorderStats().previousHeld).toBe(false)
  })

  it('ignores stalls under the profile threshold', async () => {
    observerOf().reported(report(0, 400))
    await _rotateNowForTest()
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([])
  })

  it('prunes to the newest files on each write', async () => {
    fs.mkdirSync(dir, { recursive: true })
    const old = Date.now() / 1000 - 60
    for (let i = 0; i < 45; i++) {
      for (const ext of ['cpuprofile', 'json']) {
        const f = path.join(dir, `stall-old-${i}.${ext}`)
        fs.writeFileSync(f, '{}')
        fs.utimesSync(f, old + i, old + i)
      }
    }
    observerOf().reported(report(0))
    await _rotateNowForTest()
    // Pruning unlinks one file at a time: wait for both kinds to settle.
    const settled = () => {
      const names = fs.readdirSync(dir)
      return names.filter((f) => f.endsWith('.cpuprofile')).length <= 40 && names.filter((f) => f.endsWith('.json')).length <= 40
    }
    for (let i = 0; i < 250 && !settled(); i++) await new Promise((r) => setTimeout(r, 20))
    const left = fs.readdirSync(dir)
    expect(left.filter((f) => f.endsWith('.cpuprofile'))).toHaveLength(40)
    expect(left.filter((f) => f.endsWith('.json'))).toHaveLength(40)
    // The oldest went first; the new one stayed.
    expect(left).not.toContain('stall-old-0.cpuprofile')
    expect(left.some((f) => !f.startsWith('stall-old-'))).toBe(true)
  })
})

/** The observer the running recorder installed on the probe. */
const observerOf = (): ProbeObserver => _recorderObserverForTest()

describe('the flight record verdict weighs the kept profile', () => {
  let dir: string
  const warns: Array<[string, Record<string, unknown>]> = []
  const mono = () => Number(process.hrtime.bigint()) / 1e6

  /** A kept profile with one frame on top for a minute of 20 ms samples from the window start. */
  const profileOf = (functionName: string): ProfilerDriver => ({
    begin: async () => {},
    end: async () => {
      const samples: number[] = []
      const timeDeltas: number[] = []
      for (let i = 0; i < 3_000; i++) { samples.push(2); timeDeltas.push(20_000) }
      return {
        nodes: [
          { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 }, children: [2] },
          { id: 2, callFrame: { functionName, url: 'file:///repo/dist/core/rank.js', lineNumber: 9, columnNumber: 0 } },
        ],
        // Profile time 0 = the window start (offsetUs is calibrated from it).
        startTime: 0, endTime: 60_000_000, samples, timeDeltas,
      }
    },
    close: async () => {},
  })

  // Counters only, these read `starved`: 150 ms of thread CPU in a 4 s window,
  // preempted 900 times, never waiting on its own.
  const starvedHold = {
    windowMs: 4_000, mainCpuMs: 150, mainSysMs: 5, mainCpuSource: 'thread', procCpuMs: 150, majorFaults: 0, minorFaults: 3,
    invCtxSwitches: 900, volCtxSwitches: 0, gcMs: 0, gcCount: 0, gcMaxMs: 0, gcMajor: 0, rssMb: 300, heapUsedMb: 80,
    heapTotalMb: 120, externalMb: 5, arrayBuffersMb: 1, load1: 200, cores: 14, freeMemMb: 500, verdict: 'starved',
  }

  async function record(driver: ProfilerDriver): Promise<Record<string, unknown>> {
    await startStallRecorder({ force: true, dir, windowMs: 3_600_000, postStallMs: 3_600_000, profileMinMs: 1_000, profiler: driver, systemContext: false })
    const due = mono()
    const r: StallReport = {
      lateByMs: 3_000, holdStartMono: due - 1_000, dueMono: due, holdEndMono: due + 3_000, wallNow: Date.now(),
      suspectSection: null, hold: { ...starvedHold },
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
    const rec = await record(profileOf('rankEveryRow'))
    const hold = rec.hold as Record<string, unknown>
    expect(hold.verdict).toBe('cpu')
    expect(hold.loadStretched).toBe(true)
    const seen = rec.profileHold as { codeShare: number; top: { frame: string }[] }
    expect(seen.codeShare).toBe(1)
    expect(seen.top[0].frame).toBe('rankEveryRow /repo/dist/core/rank.js:10')
    // The meta beside the profile carries the same final verdict.
    const metaFile = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!
    expect(JSON.parse(fs.readFileSync(path.join(dir, metaFile), 'utf8')).stalls[0].hold.verdict).toBe('cpu')
  })

  it('stays starved when the profile shows the thread parked', async () => {
    const rec = await record(profileOf('(idle)'))
    expect((rec.hold as Record<string, unknown>).verdict).toBe('starved')
    expect((rec.hold as Record<string, unknown>).loadStretched).toBeUndefined()
    expect((rec.profileHold as { idleShare: number }).idleShare).toBe(1)
  })
})

describe('probe wiring', () => {
  let wall = 1_000_000
  let mono = 500_000
  const clocks: MonitorClocks = { now: () => wall, monoNow: () => mono }
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    wall = 1_000_000
    mono = 500_000
    vi.spyOn(log.web, 'info').mockImplementation(() => {})
    warnSpy = vi.spyOn(log.web, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    setProbeObserver(null)
    stopEventLoopMonitor()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('ticks every probe, asks for hold context on a late one, and reports the hold window', () => {
    const ticks: number[] = []
    const reports: StallReport[] = []
    setProbeObserver({
      tick: (m) => { ticks.push(m) },
      hold: (late) => ({ verdict: 'cpu', lateSeen: late }),
      reported: (r) => { reports.push(r) },
    })
    startEventLoopMonitor(clocks)
    wall += 1_000; mono += 1_000; vi.advanceTimersByTime(1_000) // on time
    wall += 3_000; mono += 3_000; vi.advanceTimersByTime(1_000) // 2 s late
    expect(ticks).toEqual([501_000, 504_000])
    const warn = warnSpy.mock.calls.find((c) => c[0] === 'event-loop blocked (probe late)')
    expect((warn?.[1] as Record<string, unknown>).hold).toEqual({ verdict: 'cpu', lateSeen: 2_000 })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ lateByMs: 2_000, holdStartMono: 501_000, dueMono: 502_000, holdEndMono: 504_000 })
  })

  it('reports nothing for a system sleep (wall jumps, mono does not)', () => {
    const reports: StallReport[] = []
    setProbeObserver({ tick: () => {}, hold: () => undefined, reported: (r) => { reports.push(r) } })
    startEventLoopMonitor(clocks)
    wall += 306_000; mono += 1_000; vi.advanceTimersByTime(1_000)
    expect(reports).toHaveLength(0)
  })

  it('a throwing observer never breaks the probe', () => {
    setProbeObserver({ tick: () => { throw new Error('x') }, hold: () => { throw new Error('y') }, reported: () => { throw new Error('z') } })
    startEventLoopMonitor(clocks)
    wall += 3_000; mono += 3_000
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow()
    expect(warnSpy.mock.calls.some((c) => c[0] === 'event-loop blocked (probe late)')).toBe(true)
  })
})
