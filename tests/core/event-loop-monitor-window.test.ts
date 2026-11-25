/**
 * The histogram stall line names what a window held, also with no section open (2026-11-23: 650
 * of 1,207 stalls on the Mac named nothing): the boot, the sections that ended inside the window,
 * and whether the loop thread ran enough CPU to have held the loop itself (`offCpu`).
 *
 * The libuv histogram and the loop thread's CPU clock are stand-ins here, so a window's worst
 * delay and the CPU the thread used in it are set by the test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fake = vi.hoisted(() => ({ maxNs: 0, loopCpuUs: 0 }))

vi.mock('node:perf_hooks', async (orig) => {
  const real = await orig<typeof import('node:perf_hooks')>()
  return {
    ...real,
    monitorEventLoopDelay: () => ({
      enable() {}, disable() {}, reset() { fake.maxNs = 0 },
      get max() { return fake.maxNs }, get mean() { return fake.maxNs / 10 },
      percentile() { return fake.maxNs },
    }),
  }
})
vi.mock('../../src/core/stall-recorder-hold.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/stall-recorder-hold.js')>()),
  readLoopCpuUs: () => fake.loopCpuUs,
}))

import { markCriticalSection, startEventLoopMonitor, stopEventLoopMonitor, type MonitorClocks } from '../../src/core/event-loop-monitor.js'
import { log } from '../../src/logging/index.js'

let wall = 1_000_000
let mono = 500_000
const clocks: MonitorClocks = { now: () => wall, monoNow: () => mono }
let warnSpy: ReturnType<typeof vi.spyOn>

/** Let `ms` pass on time, one probe second at a time. */
function pass(ms: number): void {
  for (let t = 0; t < ms; t += 1_000) { wall += 1_000; mono += 1_000; vi.advanceTimersByTime(1_000) }
}
const histogramLines = () => warnSpy.mock.calls
  .filter((c) => c[0] === 'event-loop stall detected (histogram)')
  .map((c) => c[1] as Record<string, unknown>)

beforeEach(() => {
  vi.useFakeTimers()
  wall = 1_000_000
  mono = 500_000
  fake.maxNs = 0
  fake.loopCpuUs = 0
  vi.spyOn(log.web, 'info').mockImplementation(() => {})
  warnSpy = vi.spyOn(log.web, 'warn').mockImplementation(() => {})
  startEventLoopMonitor(clocks)
})

afterEach(() => {
  stopEventLoopMonitor()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('histogram stall line', () => {
  it('names the boot when no section is open right after start, and says how long since start', () => {
    pass(4_000)
    fake.maxNs = 400e6
    pass(1_000)
    const [line] = histogramLines()
    expect(line.suspectSection).toBe('boot')
    expect(line.sinceStartS).toBe(5)
  })

  it('lists a section that opened and closed inside the window', () => {
    pass(150_000) // past the boot window
    warnSpy.mockClear()
    const end = markCriticalSection('change-watch')
    wall += 300
    fake.loopCpuUs += 290_000
    end()
    fake.maxNs = 320e6
    pass(5_000)
    const [line] = histogramLines()
    expect(line.suspectSection).toBeNull()
    expect(line.closedSections).toEqual(['change-watch wall=300ms loopCpu=290ms'])
  })

  it('a section that ended before the window is not listed', () => {
    pass(150_000)
    const end = markCriticalSection('usage-collect')
    end()
    pass(10_000)
    warnSpy.mockClear()
    fake.maxNs = 320e6
    pass(5_000)
    expect(histogramLines()[0].closedSections).toBeUndefined()
  })

  it('offCpu: the loop thread ran under half the stall in the window, so its code cannot have held it', () => {
    pass(150_000)
    warnSpy.mockClear()
    fake.loopCpuUs += 40_000 // 40 ms of loop CPU in a window with a 400 ms stall
    fake.maxNs = 400e6
    pass(5_000)
    fake.loopCpuUs += 900_000 // 900 ms in the next one: it could have
    fake.maxNs = 400e6
    pass(5_000)
    const [starved, busy] = histogramLines()
    expect(starved).toMatchObject({ loopCpuMs: 40, offCpu: true })
    expect(busy).toMatchObject({ loopCpuMs: 900, offCpu: false })
  })

  it('section CPU is the loop thread\'s: a section that only waited reads as awaiting', () => {
    pass(150_000)
    warnSpy.mockClear()
    const end = markCriticalSection('change-watch')
    fake.loopCpuUs += 100_000 // 100 ms of loop CPU over 10 s open
    pass(10_000)
    fake.maxNs = 300e6
    pass(5_000)
    end()
    const line = histogramLines().at(-1)!
    expect(line.suspectSection).toBe('change-watch')
    expect(line.sectionAwaiting).toBe(true)
    expect((line.openSections as string[])[0]).toBe('change-watch wall=15000ms loopCpu=100ms')
  })
})
