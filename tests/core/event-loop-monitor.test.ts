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

/**
 * Attribution used to live in a SINGLE slot that also persisted across `await`.
 * Two consequences, both seen in production logs:
 *   - concurrent sections: only the first was recorded, so the other was invisible
 *     (health monitor and git sync are both ~30 s cadence, so they overlap often)
 *   - await-bound ticks: a tick that merely waited on a dead host for 30 s was
 *     reported as an event-loop stall even though the loop was free
 */
describe('event-loop monitor multi-section attribution', () => {
  it('reports EVERY open section, not just the first', () => {
    const endA = markCriticalSection('health-monitor.check')
    const endB = markCriticalSection('git-pull-walnut')
    fireProbe(3_000, 3_000)
    endB()
    endA()

    const warns = warnCalls('event-loop blocked (probe late)')
    expect(warns).toHaveLength(1)
    const open = warns[0].openSections as string[]
    expect(open.join(' ')).toContain('health-monitor.check')
    // The second section used to be entirely invisible.
    expect(open.join(' ')).toContain('git-pull-walnut')
  })

  it('blames the LONGEST-running open section', () => {
    const endOld = markCriticalSection('health-monitor.check')
    wall += 10_000
    mono += 10_000
    const endNew = markCriticalSection('git-pull-walnut')
    fireProbe(3_000, 3_000)
    endNew()
    endOld()

    const warns = warnCalls('event-loop blocked (probe late)')
    expect(warns[0].suspectSection).toBe('health-monitor.check')
  })

  it('flags a wait-dominated section as awaiting, not blocking', () => {
    // Fake clocks advance wall time without burning CPU — exactly the shape of a
    // tick parked on a daemon RPC. cpu/wall stays far below 50%.
    const end = markCriticalSection('health-monitor.check')
    fireProbe(30_000, 30_000)
    end()

    const warns = warnCalls('event-loop blocked (probe late)')
    expect(warns).toHaveLength(1)
    expect(warns[0].sectionAwaiting).toBe(true)
    // wall vs cpu must be legible in the log, which is what makes it discountable.
    expect((warns[0].openSections as string[])[0]).toMatch(/wall=\d+ms cpu=\d+ms/)
  })

  it('reports no section when none is open', () => {
    fireProbe(3_000, 3_000)
    const warns = warnCalls('event-loop blocked (probe late)')
    expect(warns[0].suspectSection).toBeNull()
    expect(warns[0].sectionAwaiting).toBe(false)
  })

  it('an end() for an already-cleared section cannot remove a live one', () => {
    const endA = markCriticalSection('health-monitor.check')
    endA()
    endA() // double-call must be harmless
    const endB = markCriticalSection('git-pull-walnut')
    endA() // stale closure again — must not touch B

    fireProbe(3_000, 3_000)
    endB()

    const warns = warnCalls('event-loop blocked (probe late)')
    expect(warns[0].suspectSection).toBe('git-pull-walnut')
  })
})
