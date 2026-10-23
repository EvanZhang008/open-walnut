/**
 * The server's next-run math answers exactly as it did before the schedule core
 * existed (src/core/cron/schedule.ts: clock-schedule-core first, croner for what
 * that core does not take). The reference below is the croner-only function the
 * server ran before, kept verbatim.
 *
 * A seeded, smaller run of the review's equivalence probe (12M comparisons, no
 * difference): every daylight saving window of 2026 and 2027 in the zones that
 * have odd ones, dense around the changes, plus random instants; real-world,
 * field-by-field and random patterns; the `every` and `at` edge cases; and the
 * malformed schedules, where both throw the same error or answer the same.
 */
import { describe, it, expect } from 'vitest'
import { Cron } from 'croner'
import { computeNextRunAtMs } from '../../../src/core/cron/schedule.js'

type S = Record<string, unknown>

/** The server's function before clock-routine-v1, croner alone. */
function before(schedule: S, nowMs: number): number | undefined {
  if (schedule.kind === 'at') {
    const atMs = new Date(schedule.at as string).getTime()
    if (!Number.isFinite(atMs)) return undefined
    return atMs > nowMs ? atMs : undefined
  }
  if (schedule.kind === 'every') {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs as number))
    const anchor = Math.max(0, Math.floor((schedule.anchorMs as number | undefined) ?? nowMs))
    if (nowMs < anchor) return anchor
    const elapsed = nowMs - anchor
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs))
    return anchor + steps * everyMs
  }
  const expr = (schedule.expr as string).trim()
  if (!expr) return undefined
  const tz = typeof schedule.tz === 'string' ? schedule.tz.trim() : ''
  const cron = new Cron(expr, { timezone: tz || Intl.DateTimeFormat().resolvedOptions().timeZone })
  const next = cron.nextRun(new Date(nowMs - 1))
  if (!next) return undefined
  const nextMs = next.getTime()
  return Number.isFinite(nextMs) && nextMs >= nowMs ? nextMs : undefined
}

function outcome(fn: (s: S, n: number) => number | undefined, s: S, n: number): string {
  try {
    const v = fn(s, n)
    return v === undefined ? 'undef' : String(v)
  } catch (e) {
    return `throw:${(e as Error).constructor.name}`
  }
}

let seed = 12345
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]

const T = (s: string) => Date.parse(s)
const ZONES = ['America/Los_Angeles', 'Asia/Shanghai', 'UTC', 'Europe/London', 'Australia/Lord_Howe', 'America/Santiago',
  'America/Havana', 'Asia/Kathmandu', 'Pacific/Chatham', 'Antarctica/Troll', 'America/St_Johns', 'Africa/Casablanca', undefined]
const WINDOWS: Array<[number, number]> = [
  [T('2026-03-07T00:00:00Z'), T('2026-03-10T00:00:00Z')], [T('2026-10-31T00:00:00Z'), T('2026-11-03T00:00:00Z')],
  [T('2027-03-13T00:00:00Z'), T('2027-03-16T00:00:00Z')], [T('2027-11-06T00:00:00Z'), T('2027-11-09T00:00:00Z')],
  [T('2026-03-28T00:00:00Z'), T('2026-03-30T00:00:00Z')], [T('2026-10-24T00:00:00Z'), T('2026-10-26T00:00:00Z')],
  [T('2026-04-03T12:00:00Z'), T('2026-04-06T00:00:00Z')], [T('2026-09-05T12:00:00Z'), T('2026-09-08T00:00:00Z')],
  [T('2026-10-03T12:00:00Z'), T('2026-10-05T00:00:00Z')],
]
const instants: number[] = []
for (const [a, b] of WINDOWS) for (let t = a; t < b; t += 97 * 60_000) instants.push(t, t + 1, t - 1, t + 59_999)
for (let i = 0; i < 100; i++) instants.push(T('2026-01-01T00:00:00Z') + Math.floor(rnd() * 3 * 365 * 86_400_000))
for (let h = 0; h < 48; h++) instants.push(T('2026-11-01T00:00:00Z') + h * 1_800_000, T('2027-03-14T00:00:00Z') + h * 1_800_000)

const MIN = ['0', '30', '*/15', '0-59/7', '5,35', '*', '59', '1-59/2']
const HR = ['*', '0', '1', '2', '3', '23', '1-3', '*/2', '2,3', '*/3']
const DOM = ['*', '1', '15', '31', 'L', '1-7', '*/2', '29', '?', 'L,15']
const MON = ['*', '1', '2', '3', '11', 'mar-nov', '*/3', 'FEB,AUG', 'oct-dec']
const DOW = ['*', '0', '7', '1-5', 'sun', 'mon-fri', '?', 'sat,sun', '*/2', '5-7']
const SEC = ['0', '30', '*/20', '59']

const patterns = new Set<string>([
  '0 9 * * *', '*/30 * * * *', '30 2 * * *', '0 2 * * *', '30 1 * * *', '59 1 * * *', '0 0 L * *', '0 0 29 2 *',
  '0 0 31 2 *', '@daily', '@hourly', '@weekly', '@monthly', '@yearly', '0 0 * * 7', '0 12 1 1 0', '*/5 * * * * *',
  '0 */2 * * * *', '15,45 2 * * *', '0 0 L * 5', '0 0 1 * 1#2', '0 0 * * 5L', '0 0 15W * *', '0 0 LW * *', '0 0 1 1 * 2027',
  '0 0 * * +1', '1/5 * * * *', '0 9 * * MON#1', '59 23 31 12 *', '0 30 2 * * *', '0 2 8 3 *', '0 1 1 11 *',
  '0 24 * * *', '60 * * * *', '* * 32 * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '* * * *', '* * * * * * * *', '', '   ',
  '0 0 5-1 * *', '*/0 * * * *', '*/61 * * * *', '0 0 * * */8', '@reboot', '@every 5m',
])
for (const m of MIN) for (const h of HR) patterns.add(`${m} ${h} * * *`)
for (const d of DOM) for (const w of DOW) patterns.add(`0 3 ${d} * ${w}`)
for (let i = 0; i < 150; i++) {
  const six = rnd() < 0.15
  patterns.add(`${six ? `${pick(SEC)} ` : ''}${pick(MIN)} ${pick(HR)} ${pick(DOM)} ${pick(MON)} ${pick(DOW)}`)
}

describe('the server’s next run is unchanged by the shared schedule core', () => {
  it('cron: every pattern, zone and instant answers as croner alone did', () => {
    const diffs: string[] = []
    let checked = 0
    for (const expr of patterns) {
      for (const tz of ZONES) {
        const s: S = tz === undefined ? { kind: 'cron', expr } : { kind: 'cron', expr, tz }
        for (let i = 0; i < 6; i++) {
          const n = pick(instants)
          const a = outcome(before, s, n)
          const b = outcome(computeNextRunAtMs as (s: S, n: number) => number | undefined, s, n)
          checked++
          if (a !== b && diffs.length < 20) diffs.push(`${JSON.stringify(expr)} tz=${tz} now=${new Date(n).toISOString()} before=${a} now=${b}`)
        }
      }
    }
    expect(checked).toBeGreaterThan(20_000)
    expect(diffs).toEqual([])
  })

  it('every and at: the edge cases answer the same', () => {
    const diffs: string[] = []
    const cases: S[] = []
    for (const everyMs of [1, 1000, 60_000, 3_600_000, 86_400_000, 1.5, 0, -5, Number.NaN]) {
      for (const anchorMs of [undefined, 0, 1771566234110, 4e12, -1]) cases.push({ kind: 'every', everyMs, anchorMs })
    }
    for (const at of ['2026-10-16T00:30:00.000Z', '2027-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'garbage', '2026-11-01T01:30:00', '']) cases.push({ kind: 'at', at })
    for (const s of cases) {
      for (const n of instants.slice(0, 120)) {
        const a = outcome(before, s, n)
        const b = outcome(computeNextRunAtMs as (s: S, n: number) => number | undefined, s, n)
        if (a !== b && diffs.length < 20) diffs.push(`${JSON.stringify(s)} now=${n} before=${a} now=${b}`)
      }
    }
    expect(diffs).toEqual([])
  })

  it('malformed schedules: the same error or the same answer, but for two that now have no run', () => {
    const n = 1792705126685
    const now = (s: S) => outcome(computeNextRunAtMs as (s: S, n: number) => number | undefined, s, n)
    // A number for an expr, a zone that does not exist, a blank zone (the server's zone).
    for (const s of [{ kind: 'cron', expr: 5 }, { kind: 'cron', expr: '0 9 * * *', tz: 'Not/AZone' }, { kind: 'cron', expr: '0 9 * * *', tz: '  ' }]) {
      expect(now(s), JSON.stringify(s)).toBe(outcome(before, s, n))
    }
    // The two differences, both stored shapes no create or edit accepts (normalize.ts):
    // a cron with no expr threw (and a throw inside a recompute fails the whole
    // list), and a kind nobody knows was run as a cron by accident. Both have no
    // next run now.
    expect([outcome(before, { kind: 'cron' }, n), now({ kind: 'cron' })]).toEqual(['throw:TypeError', 'undef'])
    expect([outcome(before, { kind: 'bogus', expr: '* * * * *' }, n), now({ kind: 'bogus', expr: '* * * * *' })]).toEqual(['1792705140000', 'undef'])
  })
})
