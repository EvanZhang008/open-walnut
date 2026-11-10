/**
 * The event-loop health alarm opens a "fix Walnut" task only for stalls
 * Walnut's own work caused; a stall the machine caused (the flight recorder's
 * `starved` or `paging`) is counted apart (2026-11-09: 17 of 18 holds of a
 * second or more read `starved`, and the alarm sent a task to fix Walnut code).
 *
 * Guards: every verdict the recorder can give is classified (read from the
 * source, so a new verdict fails here), every probe-late stall lands in exactly
 * one of the two metrics through the real monitor and the real minute collector,
 * and no alarm that opens a fix task watches a stall metric the machine drives.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CAUSE_OF_VERDICT, STALL_MACHINE_METRIC, STALL_OWN_METRIC, stallCauseOf, stallMetricOf,
} from '../../src/core/stall-cause.js'
import {
  setProbeObserver, startEventLoopMonitor, stopEventLoopMonitor, type MonitorClocks,
} from '../../src/core/event-loop-monitor.js'
import { BUILTIN_ALARMS } from '../../src/core/health-monitor/alarms.js'
import { MinuteCollector } from '../../src/core/health-monitor/collect.js'
import { addObserveTap } from '../../src/core/observability/metrics.js'
import { log } from '../../src/logging/index.js'

const ROOT = path.resolve(__dirname, '../..')

function verdictsInSource(): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/stall-recorder-hold.ts'), 'utf8')
  const m = src.match(/export type HoldVerdict\s*=([^;]+);/)
  if (!m) throw new Error('HoldVerdict union not found in stall-recorder-hold.ts')
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
}

describe('stall cause classification', () => {
  it('classifies every verdict the flight recorder can give', () => {
    expect(Object.keys(CAUSE_OF_VERDICT).sort()).toEqual(verdictsInSource())
  })

  it('counts starved and paging as the machine, the rest as Walnut', () => {
    expect(stallCauseOf({ verdict: 'starved' })).toBe('machine')
    expect(stallCauseOf({ verdict: 'paging' })).toBe('machine')
    expect(stallCauseOf({ verdict: 'cpu' })).toBe('own')
    expect(stallCauseOf({ verdict: 'gc' })).toBe('own')
    expect(stallCauseOf({ verdict: 'off-cpu' })).toBe('own')
  })

  it('counts a stall with no verdict, or one it does not know, as Walnut', () => {
    expect(stallCauseOf(undefined)).toBe('own')
    expect(stallCauseOf({})).toBe('own')
    expect(stallCauseOf({ verdict: 'something-new' })).toBe('own')
    expect(stallCauseOf({ verdict: 'toString' })).toBe('own')
    expect(stallMetricOf(undefined)).toBe(STALL_OWN_METRIC)
  })
})

describe('alarms on event-loop stalls', () => {
  const stallMetrics = BUILTIN_ALARMS.filter((a) => a.metric.startsWith('eventloop.'))

  it('opens a fix task only on the stalls Walnut caused', () => {
    for (const a of stallMetrics) {
      if (a.action.then === 'fix-task' || a.action.autoFix) expect(a.metric, a.id).toBe(STALL_OWN_METRIC)
    }
    expect(BUILTIN_ALARMS.find((a) => a.id === 'eventloop.stall')?.metric).toBe(STALL_OWN_METRIC)
  })

  it('shows the machine\'s stalls on their own alarm, which sends no task', () => {
    const m = BUILTIN_ALARMS.find((a) => a.metric === STALL_MACHINE_METRIC)
    expect(m?.id).toBe('eventloop.starved')
    expect(m?.action.then).toBe('none')
  })
})

describe('probe-late stalls reach the health metric of their cause', () => {
  let wall = 1_000_000
  let mono = 500_000
  const clocks: MonitorClocks = { now: () => wall, monoNow: () => mono }
  let verdict: string | null = null
  const seen: Array<[string, number]> = []
  let untap: () => void = () => {}

  function fireProbe(advanceMs: number): void {
    wall += advanceMs
    mono += advanceMs
    vi.advanceTimersByTime(1_000)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    wall = 1_000_000
    mono = 500_000
    seen.length = 0
    verdict = null
    vi.spyOn(log.web, 'warn').mockImplementation(() => {})
    vi.spyOn(log.web, 'info').mockImplementation(() => {})
    untap = addObserveTap((name, value) => { if (name.startsWith('eventloop.stall')) seen.push([name, value]) })
    setProbeObserver({
      tick: () => {},
      hold: () => (verdict ? { verdict } : undefined),
      reported: () => {},
    })
    startEventLoopMonitor(clocks)
  })

  afterEach(() => {
    stopEventLoopMonitor()
    setProbeObserver(null)
    untap()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('a starved or paging hold counts for the machine, a cpu hold for Walnut, and each lands in the minute row', async () => {
    const collector = new MinuteCollector({ dataDir: '/nonexistent', fdCount: async () => null, memoryPressure: () => null, sshCertExpiring: async () => null, rssBytes: () => 0, statfs: async () => { throw new Error('no disk in this test') } })
    collector.start()
    try {
      verdict = 'starved'
      fireProbe(3_000) // 2 s late
      verdict = 'paging'
      fireProbe(2_200) // 1.2 s late
      verdict = 'cpu'
      fireProbe(2_500) // 1.5 s late
      verdict = null
      fireProbe(1_400) // 400 ms late, no hold context: Walnut's
      fireProbe(1_000) // on time: nothing
      expect(seen).toEqual([
        [STALL_MACHINE_METRIC, 2_000], [STALL_MACHINE_METRIC, 1_200], [STALL_OWN_METRIC, 1_500], [STALL_OWN_METRIC, 400],
      ])
      const { row } = await collector.closeMinute(0)
      expect(row.v[STALL_MACHINE_METRIC]).toBe(2_000)
      expect(row.v[STALL_OWN_METRIC]).toBe(1_500)
    } finally {
      collector.stop()
    }
  })
})
