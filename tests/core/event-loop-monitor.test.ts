import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startEventLoopMonitor,
  stopEventLoopMonitor,
  markCriticalSection,
  type MonitorClocks,
} from '../../src/core/event-loop-monitor.js'
import { log } from '../../src/logging/index.js'

// Injectable clock pair: wall jumps across simulated system sleep, mono does not.
let wall = 1_000_000
let mono = 500_000
const clocks: MonitorClocks = { now: () => wall, monoNow: () => mono }

let infoSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

/** Advance the injected clocks, then fire the pending 1s probe timeout. */
function fireProbe(wallAdvanceMs: number, monoAdvanceMs: number): void {
  wall += wallAdvanceMs
  mono += monoAdvanceMs
  vi.advanceTimersByTime(1_000)
}

function warnCalls(message: string): Array<Record<string, unknown>> {
  return warnSpy.mock.calls
    .filter((c) => c[0] === message)
    .map((c) => (c[1] ?? {}) as Record<string, unknown>)
}

function infoCalls(message: string): Array<Record<string, unknown>> {
  return infoSpy.mock.calls
    .filter((c) => c[0] === message)
    .map((c) => (c[1] ?? {}) as Record<string, unknown>)
}

beforeEach(() => {
  vi.useFakeTimers()
  wall = 1_000_000
  mono = 500_000
  infoSpy = vi.spyOn(log.web, 'info').mockImplementation(() => {})
  warnSpy = vi.spyOn(log.web, 'warn').mockImplementation(() => {})
  startEventLoopMonitor(clocks)
})

afterEach(() => {
  stopEventLoopMonitor()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('event-loop monitor probe', () => {
  it('reports a real block (mono delta large) as a warn, exactly as before', () => {
    fireProbe(3_000, 3_000) // loop genuinely blocked for ~2s past the 1s cadence

    const warns = warnCalls('event-loop blocked (probe late)')
    expect(warns).toHaveLength(1)
    expect(warns[0].lateByMs).toBe(2_000)
    expect(infoCalls('system sleep detected (not an event-loop block)')).toHaveLength(0)
  })

  it('reports system sleep (wall >> mono) as ONE info, never a warn', () => {
    // Simulates the 2026-07-16T16:31:09 incident: lateByMs=305699 was macOS sleep.
    fireProbe(306_000, 1_000)

    expect(warnCalls('event-loop blocked (probe late)')).toHaveLength(0)
    const infos = infoCalls('system sleep detected (not an event-loop block)')
    expect(infos).toHaveLength(1)
    expect(infos[0].sleptMs).toBe(305_000)
  })

  it('does not treat a small wall/mono skew as sleep', () => {
    fireProbe(1_050, 1_000) // 50ms skew — normal clock jitter, on-time probe
    expect(warnCalls('event-loop blocked (probe late)')).toHaveLength(0)
    expect(infoCalls('system sleep detected (not an event-loop block)')).toHaveLength(0)
  })

  it('attributes a real block to the marked critical section', () => {
    const end = markCriticalSection('health-monitor.check')
    fireProbe(3_000, 3_000)
    end()

    const warns = warnCalls('event-loop blocked (probe late)')
    expect(warns).toHaveLength(1)
    expect(warns[0].suspectSection).toBe('health-monitor.check')
  })

  it('clears critical-section attribution across sleep — the spanning tick is not blamed', () => {
    // A health-monitor tick is in flight when the machine sleeps.
    const end = markCriticalSection('health-monitor.check')
    fireProbe(306_000, 1_000) // sleep detected → attribution must be cleared

    // A subsequent REAL block must not be pinned on the sleep-spanning section.
    fireProbe(3_000, 3_000)
    end() // stale end() from the sleep-spanning tick — must be a no-op by now

    const warns = warnCalls('event-loop blocked (probe late)')
    expect(warns).toHaveLength(1)
    expect(warns[0].suspectSection).toBeNull()
  })

  it('a stale end() from a sleep-spanning section cannot clear a NEW section', () => {
    const staleEnd = markCriticalSection('health-monitor.check')
    fireProbe(306_000, 1_000) // sleep clears attribution, invalidates staleEnd

    const endNew = markCriticalSection('git-pull-walnut')
    staleEnd() // must NOT clear git-pull-walnut

    fireProbe(3_000, 3_000)
    endNew()

    const warns = warnCalls('event-loop blocked (probe late)')
    expect(warns).toHaveLength(1)
    expect(warns[0].suspectSection).toBe('git-pull-walnut')
  })
})
