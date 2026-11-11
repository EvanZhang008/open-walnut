/**
 * Every wait the health monitor alarms on is the code path's own wait: not the
 * machine's sleep, and not a line written earlier measured again.
 *
 * 2026-11-10 the send.delivery alarm fired on 467 s, of which 421 s were the Mac
 * asleep with its lid closed, and over two days 22 of its 37 "slow" deliveries
 * were resends the daemon answered with the line's fate: a 43 ms delivery read
 * 403 s after a restart. The guard lists every alarm measured in milliseconds
 * with the code that keeps it awake-only, so a new one fails here until it says
 * how it leaves sleep out; and every delivery site must hand over what the
 * daemon said about the line.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_ALARMS } from '../../../src/core/health-monitor/alarms.js'
import { deliveryLatency, type Interval } from '../../../src/providers/delivery-latency.js'
import { __resetSleepLedgerForTest, noteSleepSinceLastLook, sleptBetween, SLEEP_GAP_MS } from '../../../src/lib/sleep-ledger.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Each millisecond alarm's metric, the file that measures it, and the words there that leave sleep out. */
const AWAKE_ONLY: Record<string, { file: string; marker: RegExp; why: string }> = {
  // Both stall metrics are observed only in the probe's report(), which a probe
  // that spans a sleep (wall vs monotonic gap, kern.waketime) never reaches.
  'eventloop.stall.own': {
    file: 'src/core/event-loop-monitor.ts',
    marker: /probe lateness dropped/,
    why: 'the probe drops a lateness that spans a sleep before it reports and counts the stall',
  },
  'eventloop.stall.machine': {
    file: 'src/core/event-loop-monitor.ts',
    marker: /probe lateness dropped/,
    why: 'the same probe report as eventloop.stall.own',
  },
  'send.delivery.live': {
    file: 'src/providers/claude-code-session.ts',
    marker: /const waits: OutOfPathWaits = \{ \.\.\.REAL_WAITS, linkDown: [^\n]+\n\s*const lat = deliveryLatency\(msgs, now, known, waits\)/,
    why: 'deliveryLatency leaves out sleep and the host link\'s downtime, and counts a line written earlier by its own write',
  },
  'send.delivery.resume': {
    file: 'src/providers/claude-code-session.ts',
    marker: /const waits: OutOfPathWaits = \{ \.\.\.REAL_WAITS, linkDown: [^\n]+\n\s*const lat = deliveryLatency\(msgs, now, known, waits\)/,
    why: 'the same delivery log as the live paths',
  },
  'send.delivery.resume.machine': {
    file: 'src/providers/claude-code-session.ts',
    marker: /resumeMachineShare\(\{[^}]*deliveryMs: lat\.deliveryMs/,
    why: 'the machine share is cut from the same awake, link-up wait',
  },
}

describe('millisecond health alarms leave sleep out', () => {
  const msAlarms = BUILTIN_ALARMS.filter((a) => a.unit === 'ms')

  it('every millisecond alarm is listed with the code that keeps it awake-only', () => {
    expect(msAlarms.length).toBeGreaterThan(0)
    for (const a of msAlarms) {
      const entry = AWAKE_ONLY[a.metric]
      expect(entry, `alarm ${a.id} (${a.metric}) measures milliseconds: say how it leaves sleep out in AWAKE_ONLY`).toBeDefined()
      expect(read(entry.file), `${entry.file} no longer holds what keeps ${a.metric} awake-only (${entry.why})`).toMatch(entry.marker)
    }
    for (const metric of Object.keys(AWAKE_ONLY)) {
      expect(msAlarms.some((a) => a.metric === metric), `AWAKE_ONLY lists ${metric}, which no alarm reads`).toBe(true)
    }
  })

  it('every delivery log site hands over the fate the daemon reported', () => {
    const src = read('src/providers/claude-code-session.ts')
    const calls = src.match(/this\.logDeliveryLatency\([^)]*\)/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const c of calls) expect(c, `a delivery site must pass the line's known fate: ${c}`).toMatch(/,\s*known\)$/)
  })

  it('one delivery reports into one turn only', () => {
    const src = read('src/providers/claude-code-session.ts')
    const writes = src.match(/_lastDeliveryMs = [^\n]+/g) ?? []
    expect(writes.sort()).toEqual(['_lastDeliveryMs = lat.deliveryMs', '_lastDeliveryMs = undefined'])
    expect(src).toMatch(/deliveryMs: this\._lastDeliveryMs,[\s\S]{0,1200}?this\._lastDeliveryMs = undefined/)
    // Only the per-turn wide event observes the delivery metric.
    const observers = ['src/core/observability/recorder.ts']
    for (const rel of observers) expect(read(rel)).toMatch(/observe\('session\.delivery'/)
  })
})

describe('sleep ledger', () => {
  let wall = 0
  let mono = 0
  const fake = { now: () => wall, monoNow: () => mono }
  const start = (at: number) => { wall = at; mono = 1_000; __resetSleepLedgerForTest(fake) }
  const awake = (ms: number) => { wall += ms; mono += ms; noteSleepSinceLastLook() }
  const asleep = (ms: number) => { wall += ms }
  afterEach(() => __resetSleepLedgerForTest(null))

  it('records a sleep and leaves the awake time in', () => {
    start(1_000_000)
    awake(1_000)
    const sentAt = wall
    awake(1_000)
    asleep(421_000)
    awake(1_000) // the first look after the wake
    awake(30_000)
    expect(sleptBetween(sentAt, wall)).toBe(421_000)
    expect(wall - sentAt - sleptBetween(sentAt, wall)).toBe(32_000)
  })

  it('counts only the part of a sleep inside the window', () => {
    start(0)
    awake(1_000)
    asleep(100_000)
    awake(1_000) // recorded as [2_000, 102_000], ending at the look
    expect(sleptBetween(52_000, 200_000)).toBe(50_000)
    expect(sleptBetween(0, 10_000)).toBe(8_000)
    expect(sleptBetween(150_000, 200_000)).toBe(0)
  })

  it('a gap under the threshold, or a clock that counts sleep, records nothing', () => {
    start(0)
    awake(1_000)
    asleep(SLEEP_GAP_MS)
    awake(1_000)
    expect(sleptBetween(0, wall)).toBe(0)
    // Node on Apple Silicon: the monotonic clock advanced through the sleep too.
    wall += 300_000; mono += 300_000
    noteSleepSinceLastLook()
    expect(sleptBetween(0, wall)).toBe(0)
  })

  it('sees a sleep a reader asks about before the next probe looks', () => {
    start(0)
    awake(1_000)
    asleep(60_000)
    wall += 200; mono += 200
    expect(sleptBetween(0, wall)).toBe(60_000)
  })
})

describe('deliveryLatency', () => {
  const T = Date.parse('2026-11-10T02:32:14.256Z')
  const row = (id: string, at: number) => ({ id, enqueuedAt: new Date(at).toISOString() })
  const noSleep = { slept: (): Interval[] => [] }
  const span = (s: number, e: number) => (from: number, to: number): Interval[] =>
    Math.min(to, e) > Math.max(from, s) ? [{ start: Math.max(from, s), end: Math.min(to, e) }] : []

  it('a fresh write counts from the oldest row to now', () => {
    expect(deliveryLatency([row('a', T), row('b', T + 500)], T + 2_000, undefined, noSleep))
      .toEqual({ deliveryMs: 2_000, messageId: 'a' })
  })

  it('leaves out the time the machine slept (the 2026-11-10 02:32 send)', () => {
    const slept = { slept: span(T + 7_000, T + 428_000) }
    expect(deliveryLatency([row('qm-a2pt3m', T)], T + 467_151, undefined, slept))
      .toEqual({ deliveryMs: 46_151, messageId: 'qm-a2pt3m', wallMs: 467_151, sleptMs: 421_000 })
  })

  it('a resend the daemon answered with no write time counts nothing (the 2026-11-09 21:11 restart)', () => {
    const r = row('qm-2pp3qc', Date.parse('2026-11-09T21:05:16.541Z'))
    expect(deliveryLatency([r], Date.parse('2026-11-09T21:11:59.819Z'), { fate: 'ran' }, noSleep)).toEqual({ writtenEarlier: true })
    expect(deliveryLatency([r], Date.parse('2026-11-09T21:12:31.232Z'), { fate: 'waiting' }, noSleep)).toEqual({ writtenEarlier: true })
  })

  it('a resend the daemon answered with its write time counts that write', () => {
    expect(deliveryLatency([row('a', T)], T + 103_000, { fate: 'waiting', writtenAt: T + 108 }, noSleep))
      .toEqual({ deliveryMs: 108, messageId: 'a', writtenEarlier: true })
    // The host's clock a little behind this one: never a negative wait.
    expect(deliveryLatency([row('a', T)], T + 103_000, { fate: 'waiting', writtenAt: T - 40 }, noSleep).deliveryMs).toBe(0)
  })

  it('leaves out the time the host link was down (the 2026-11-11 17:26 clouddev sends)', () => {
    // Link down 17:25:30 to 17:28:00, the send at 17:26:35, delivered at 17:28:05.
    const t0 = Date.parse('2026-11-11T17:26:35.140Z')
    const waits = { slept: () => [], linkDown: span(Date.parse('2026-11-11T17:25:30.796Z'), Date.parse('2026-11-11T17:28:00.325Z')) }
    expect(deliveryLatency([row('qm-host-c1d4', t0)], Date.parse('2026-11-11T17:28:05.131Z'), undefined, waits))
      .toEqual({ deliveryMs: 4_806, messageId: 'qm-host-c1d4', wallMs: 89_991, linkDownMs: 85_185 })
  })

  it('sleep and a down link that overlap are left out once', () => {
    const waits = { slept: span(T + 10_000, T + 60_000), linkDown: span(T + 20_000, T + 80_000) }
    expect(deliveryLatency([row('a', T)], T + 100_000, undefined, waits))
      .toEqual({ deliveryMs: 30_000, messageId: 'a', wallMs: 100_000, sleptMs: 50_000, linkDownMs: 20_000 })
  })

  it('a row with no readable enqueue time reads zero, as before', () => {
    expect(deliveryLatency([{ id: 'x', enqueuedAt: 'nope' }], T, undefined, noSleep)).toEqual({ deliveryMs: 0 })
  })
})
