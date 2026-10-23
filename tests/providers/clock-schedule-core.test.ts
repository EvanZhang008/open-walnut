/**
 * The one copy of the schedule math the server and both daemon twins run
 * (src/providers/clock-schedule-core.ts, clock-routine-v1). The server ran croner
 * alone before, so the core is held to croner: random patterns, zones and times,
 * the daylight saving changes of several zones, and every schedule kind.
 */
import { describe, expect, it } from 'vitest'
import { Cron } from 'croner'
import { createClockSchedule } from '../../src/providers/clock-schedule-core.js'
import { computeNextRunAtMs } from '../../src/core/cron/schedule.js'

const core = createClockSchedule()

function cronerNext(expr: string, tz: string, now: number): number | undefined | 'throw' {
  let c: Cron
  try { c = new Cron(expr, { timezone: tz }) } catch { return 'throw' }
  const n = c.nextRun(new Date(now - 1))
  if (!n) return undefined
  const ms = n.getTime()
  return Number.isFinite(ms) && ms >= now ? ms : undefined
}

const iso = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : ms)

describe('cron: the same answers as croner', () => {
  it('agrees on random patterns, zones and times', () => {
    let seed = 20261023
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]
    const zones = ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Shanghai', 'Asia/Kolkata', 'Australia/Sydney', 'Australia/Lord_Howe', 'Pacific/Chatham', 'America/Sao_Paulo']
    const field = (min: number, max: number, names?: string[]): string => {
      const r = rnd()
      const any = () => min + Math.floor(rnd() * (max - min + 1))
      if (r < 0.3) return '*'
      if (r < 0.45) return `*/${1 + Math.floor(rnd() * (max - min + 1))}`
      if (r < 0.6) { const a = any(); return `${a}-${a + Math.floor(rnd() * (max - a + 1))}` }
      if (r < 0.7) { const a = any(); return `${a}-${a + Math.floor(rnd() * (max - a + 1))}/${1 + Math.floor(rnd() * 5)}` }
      if (r < 0.8) return [any(), any(), any()].join(',')
      if (r < 0.85 && names) return pick(names)
      if (r < 0.9) return '?'
      return String(any())
    }
    const start = Date.UTC(2024, 0, 1)
    const mismatches: string[] = []
    let compared = 0
    for (let i = 0; i < 3000; i++) {
      let dom = field(1, 31)
      if (rnd() < 0.05) dom = 'L'
      const parts = [field(0, 59), field(0, 23), dom, field(1, 12, ['JAN', 'feb', 'Mar-Jun', 'OCT,DEC']), field(0, 7, ['MON-FRI', 'sun', 'SAT,SUN', 'TUE'])]
      if (rnd() < 0.3) parts.unshift(field(0, 59))
      const expr = rnd() < 0.03 ? pick(['@daily', '@hourly', '@weekly', '@monthly', '@yearly', '@midnight', '@annually']) : parts.join(' ')
      const tz = pick(zones)
      const now = start + Math.floor(rnd() * 3 * 365 * 86_400_000) + (rnd() < 0.3 ? 0 : Math.floor(rnd() * 1000))
      const a = cronerNext(expr, tz, now)
      const b = core.nextRunAtMs({ kind: 'cron', expr, tz }, now)
      // The core may only decline a pattern croner refuses too.
      if (b === null) { if (a !== 'throw') mismatches.push(`declined ${expr} ${tz}`); continue }
      if (a === 'throw') { mismatches.push(`croner refused ${expr} ${tz}, core said ${iso(b)}`); continue }
      compared++
      if (a !== b) mismatches.push(`${expr} ${tz} at ${iso(now)}: croner ${iso(a)} core ${iso(b)}`)
    }
    expect(mismatches.slice(0, 10)).toEqual([])
    expect(compared).toBeGreaterThan(2500)
  })

  it('agrees around daylight saving changes, both ways, in several zones', () => {
    const transitions: Array<[string, string]> = [
      ['America/Los_Angeles', '2026-03-08T10:00:00Z'], ['America/Los_Angeles', '2026-11-01T09:00:00Z'],
      ['Europe/London', '2026-03-29T01:00:00Z'], ['Europe/London', '2026-10-25T01:00:00Z'],
      ['Australia/Sydney', '2026-04-04T16:00:00Z'], ['Australia/Lord_Howe', '2026-04-04T15:00:00Z'],
      ['Pacific/Chatham', '2026-04-04T14:00:00Z'],
    ]
    const exprs = ['30 2 * * *', '30 1 * * *', '0 2 * * *', '*/15 * * * *', '*/7 1-3 * * *', '45 1,2,3 * * *', '0 30 1 * * *', '59 1 * * *']
    const mismatches: string[] = []
    for (const [tz, at] of transitions) {
      const center = Date.parse(at)
      for (const expr of exprs) {
        for (let off = -3 * 3_600_000; off <= 3 * 3_600_000; off += 17 * 60_000 + 13_000) {
          const now = center + off
          const a = cronerNext(expr, tz, now)
          const b = core.nextRunAtMs({ kind: 'cron', expr, tz }, now)
          if (a !== b) mismatches.push(`${expr} ${tz} at ${iso(now)}: croner ${iso(a as number)} core ${iso(b)}`)
        }
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([])
  })

  it('a time the clock skips moves forward by the gap; a time it repeats is the earlier one', () => {
    // 2026-03-08: Los Angeles jumps 02:00 -> 03:00, so 02:30 that day is 03:30 PDT.
    expect(iso(core.nextRunAtMs({ kind: 'cron', expr: '30 2 * * *', tz: 'America/Los_Angeles' }, Date.parse('2026-03-08T08:00:00Z'))))
      .toBe('2026-03-08T10:30:00.000Z')
    // 2026-11-01: 01:30 happens twice; the first (PDT, 08:30Z) is the slot.
    expect(iso(core.nextRunAtMs({ kind: 'cron', expr: '30 1 * * *', tz: 'America/Los_Angeles' }, Date.parse('2026-11-01T07:00:00Z'))))
      .toBe('2026-11-01T08:30:00.000Z')
  })

  it('afterRun always moves forward, also through a repeated hour', () => {
    const tz = 'America/Los_Angeles'
    for (const expr of ['30 1 * * *', '*/15 * * * *', '0 * * * *', '*/20 * * * * *']) {
      let t = Date.parse('2026-11-01T06:00:00Z')
      const end = t + 6 * 3_600_000
      while (t < end) {
        const next = core.afterRun({ kind: 'cron', expr, tz }, t)
        expect(next, `${expr} after ${iso(t)}`).toBeGreaterThan(t)
        t = next!
      }
    }
    // The run in the first 01:30 is followed by the next day's, not by the repeat.
    expect(iso(core.afterRun({ kind: 'cron', expr: '30 1 * * *', tz }, Date.parse('2026-11-01T08:30:00Z'))))
      .toBe('2026-11-02T09:30:00.000Z')
  })

  it('takes the zone of the schedule, else the default, and refuses an unknown one', () => {
    const now = Date.parse('2026-01-15T12:00:00Z')
    expect(iso(core.nextRunAtMs({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Tokyo' }, now))).toBe('2026-01-16T00:00:00.000Z')
    expect(iso(core.nextRunAtMs({ kind: 'cron', expr: '0 9 * * *' }, now, 'Europe/Berlin'))).toBe('2026-01-16T08:00:00.000Z')
    expect(core.nextRunAtMs({ kind: 'cron', expr: '0 9 * * *', tz: 'Mars/Olympus' }, now)).toBeNull()
    expect(core.supports({ kind: 'cron', expr: '0 9 * * *', tz: 'Mars/Olympus' })).toBe(false)
  })

  it('declines what only croner reads, so such a routine keeps its clock on the server', () => {
    for (const expr of ['0 9 * * 1#2', '0 9 * * 5L', '0 9 LW * *', '0 9 15W * *', '0 0 9 * * * 2027', '0 9 * * +1']) {
      expect(core.supports({ kind: 'cron', expr, tz: 'UTC' }), expr).toBe(false)
    }
    expect(core.supports({ kind: 'cron', expr: '0 9 L * *', tz: 'UTC' })).toBe(true)
    expect(core.supports({ kind: 'cron', expr: '@weekly', tz: 'UTC' })).toBe(true)
  })
})

describe('every and at', () => {
  it('every: slots on the anchor grid, the first one strictly after a run', () => {
    const anchor = Date.UTC(2026, 0, 1)
    const hour = 3_600_000
    expect(core.nextRunAtMs({ kind: 'every', everyMs: hour, anchorMs: anchor }, anchor - 5)).toBe(anchor)
    expect(core.nextRunAtMs({ kind: 'every', everyMs: hour, anchorMs: anchor }, anchor)).toBe(anchor + hour)
    expect(core.nextRunAtMs({ kind: 'every', everyMs: hour, anchorMs: anchor }, anchor + 90 * 60_000)).toBe(anchor + 2 * hour)
    expect(core.afterRun({ kind: 'every', everyMs: hour, anchorMs: anchor }, anchor + 2 * hour)).toBe(anchor + 3 * hour)
    // A run long after its slot (a catch-up) is followed by the next slot after it, never by the ones it stood for.
    expect(core.afterRun({ kind: 'every', everyMs: hour, anchorMs: anchor }, anchor + 5 * hour + 7)).toBe(anchor + 6 * hour)
  })

  it('at: one slot, nothing after it', () => {
    const at = '2026-05-01T10:00:00.000Z'
    expect(core.nextRunAtMs({ kind: 'at', at }, Date.parse(at) - 1)).toBe(Date.parse(at))
    expect(core.nextRunAtMs({ kind: 'at', at }, Date.parse(at))).toBeUndefined()
    expect(core.afterRun({ kind: 'at', at }, Date.parse(at))).toBeUndefined()
    expect(core.supports({ kind: 'at', at: 'not a date' })).toBe(false)
  })
})

describe('the server reads the same core', () => {
  it('computeNextRunAtMs answers from the core, and from croner for a pattern the core declines', () => {
    const now = Date.parse('2026-01-15T12:00:00Z')
    expect(computeNextRunAtMs({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }, now)).toBe(Date.UTC(2026, 0, 16, 9))
    // The second Monday of February 2026 is the 9th.
    expect(iso(computeNextRunAtMs({ kind: 'cron', expr: '0 9 * * 1#2', tz: 'UTC' }, Date.parse('2026-02-01T00:00:00Z'))))
      .toBe('2026-02-09T09:00:00.000Z')
  })
})
