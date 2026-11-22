/**
 * A send counts as a send into a live session only when it arrived after the CLI
 * it reached had started.
 *
 * 2026-11-22 the send.delivery alarm (the slowest send into a live session) fired
 * on 87 s, 67 s and 59 s that were waits on a start: the Mac woke on 3 % battery,
 * the Walnut VP's CLI died on its first write, and the messages that came in while
 * its --resume started (routed with no pid) went in through mid-turn and stdin once
 * it was up. The same turn's 208 s resume was then replaced by the next, shorter
 * delivery, so the resume alarm never saw it.
 *
 * This file pins the series rule, the turn keeping its slowest delivery, and the
 * class: every path a delivery can be logged under is judged by the same rule
 * before it reaches a health series.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deliverySeries } from '../../../src/providers/delivery-latency.js'
import { SessionRunner } from '../../../src/providers/claude-code-session.js'
import { __resetSleepLedgerForTest } from '../../../src/lib/sleep-ledger.js'
import { MinuteCollector } from '../../../src/core/health-monitor/collect.js'
import { recordTurn } from '../../../src/core/observability/recorder.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const at = (iso: string) => Date.parse(`2026-11-22T${iso}Z`)

describe('deliverySeries', () => {
  it('a row that arrived while the CLI was starting counts under resume (the 2026-11-22 09:37:50 send)', () => {
    // The VP's CLI died at 09:37:07, its --resume settled at 09:38:57; the send came in at 09:37:50.
    expect(deliverySeries('mid-turn', { enqueuedAtMs: at('09:37:50.555'), startInFlight: false, startSettledAtMs: at('09:38:57.393') })).toBe('resume')
    expect(deliverySeries('stdin', { enqueuedAtMs: at('09:38:40.483'), startInFlight: false, startSettledAtMs: at('09:38:57.393') })).toBe('resume')
  })

  it('a row delivered while a start is still in flight counts under resume', () => {
    expect(deliverySeries('mid-turn', { enqueuedAtMs: at('09:40:00'), startInFlight: true, startSettledAtMs: at('08:00:00') })).toBe('resume')
  })

  it('a row that arrived after the CLI had started stays its write path\'s', () => {
    expect(deliverySeries('mid-turn', { enqueuedAtMs: at('09:40:38.609'), startInFlight: false, startSettledAtMs: at('09:38:57.393') })).toBe('mid-turn')
    expect(deliverySeries('stdin', { enqueuedAtMs: at('09:40:03.628'), startInFlight: false, startSettledAtMs: at('09:38:57.393') })).toBe('stdin')
    // An attached CLI this server never started.
    expect(deliverySeries('stdin', { enqueuedAtMs: at('09:40:03'), startInFlight: false, startSettledAtMs: 0 })).toBe('stdin')
    // An unreadable enqueue time keeps the write path, as before.
    expect(deliverySeries('stdin', { enqueuedAtMs: Number.NaN, startInFlight: false, startSettledAtMs: at('09:38:57') })).toBe('stdin')
  })

  it('a resume stays a resume', () => {
    expect(deliverySeries('resume', { enqueuedAtMs: at('09:40:00'), startInFlight: false, startSettledAtMs: 0 })).toBe('resume')
  })
})

/** A session as logDeliveryLatency reads it. */
function fakeSession(start: { inFlight: boolean; settledAtMs: number }) {
  return {
    host: null as string | null,
    cliStartAtMs: start.settledAtMs ? start.settledAtMs - 90_000 : 0,
    startState: start,
    _lastDeliveryMs: undefined as number | undefined,
    _lastDeliveryPath: undefined as string | undefined,
    _lastDeliveryMachineMs: undefined as number | undefined,
  }
}

const row = (id: string, enqueuedAtMs: number) => ({ id, enqueuedAt: new Date(enqueuedAtMs).toISOString(), message: 'x' })

describe('logDeliveryLatency feeds the turn the series and its slowest delivery', () => {
  const log = (SessionRunner.prototype as unknown as {
    logDeliveryLatency: (sid: string, p: string, msgs: unknown[], s: unknown, known?: unknown) => void
  }).logDeliveryLatency
  const runner = { findByClaudeId: () => undefined }
  let realNow: () => number
  let now = 0
  beforeEach(() => {
    realNow = Date.now
    Date.now = () => now
    __resetSleepLedgerForTest({ now: () => now, monoNow: () => now })
  })
  afterEach(() => {
    Date.now = realNow
    __resetSleepLedgerForTest(null)
  })

  it('a send that waited on the start is the turn\'s resume wait, and the slower resume before it is kept', () => {
    const s = fakeSession({ inFlight: false, settledAtMs: at('09:38:57.393') })
    // The resume itself: 208 s.
    now = at('09:38:57.393')
    log.call(runner, 'sid-vp', 'resume', [row('qm-xakipf', now - 208_537)], s)
    expect(s._lastDeliveryPath).toBe('resume')
    expect(s._lastDeliveryMs).toBe(208_537)
    // The mid-turn line that came in during the start, 87 s: shorter, so the 208 s stays.
    now = at('09:39:21.889')
    log.call(runner, 'sid-vp', 'mid-turn', [row('qm-kwl57s', at('09:37:50.555'))], s)
    expect(s._lastDeliveryMs).toBe(208_537)
    expect(s._lastDeliveryPath).toBe('resume')
  })

  it('a live send alone is the live path\'s, and a slower live send replaces a faster one', () => {
    const s = fakeSession({ inFlight: false, settledAtMs: at('09:38:57.393') })
    now = at('09:40:39.618')
    log.call(runner, 'sid-vp', 'mid-turn', [row('qm-4ovsxf', now - 1_084)], s)
    expect(s).toMatchObject({ _lastDeliveryMs: 1_084, _lastDeliveryPath: 'mid-turn' })
    now += 10_000
    log.call(runner, 'sid-vp', 'stdin', [row('qm-later', now - 4_000)], s)
    expect(s).toMatchObject({ _lastDeliveryMs: 4_000, _lastDeliveryPath: 'stdin' })
  })

  it('a send that arrived during the start alone reads as resume in the health series', () => {
    // 1fd07654's route line: in at 09:37:49 with its start still in flight, written mid-turn at 09:38:56.
    const s = fakeSession({ inFlight: true, settledAtMs: 0 })
    now = at('09:38:56.554')
    log.call(runner, 'sid-route', 'mid-turn', [row('qm-route', at('09:37:49.814'))], s)
    expect(s._lastDeliveryPath).toBe('resume')
    const c = new MinuteCollector({ dataDir: '/nonexistent' })
    c.start()
    try {
      recordTurn({ sessionId: 'sid-route', isError: false, deliveryMs: s._lastDeliveryMs, deliveryPath: s._lastDeliveryPath })
      const maxes = (c as unknown as { maxes: Map<string, number> }).maxes
      expect(maxes.get('send.delivery.live')).toBeUndefined()
      expect(maxes.get('send.delivery.resume')).toBe(66_740)
    } finally {
      c.stop()
    }
  })
})

describe('the class: every logged delivery path is judged by the series rule', () => {
  const src = read('src/providers/claude-code-session.ts')

  it('every path logDeliveryLatency takes is one deliverySeries knows, and its sites name only those', () => {
    const sig = src.match(/private logDeliveryLatency\(sessionId: string, path: ([^,]+),/)
    expect(sig, 'logDeliveryLatency signature moved').not.toBeNull()
    const paths = [...sig![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    // A new path joins DeliverySeries (and the collector's mapping) before it can be logged.
    const series = read('src/providers/delivery-latency.ts').match(/export type DeliverySeries = ([^\n]+)/)
    expect(series).not.toBeNull()
    expect([...series![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()).toEqual(paths)
    for (const call of src.match(/this\.logDeliveryLatency\([^)]*\)/g) ?? []) {
      const p = call.match(/this\.logDeliveryLatency\(sessionId, '([^']+)'/)
      expect(p, `a delivery site passes a literal path: ${call}`).not.toBeNull()
      expect(paths).toContain(p![1])
    }
  })

  it('the turn is told the series, never the raw write path', () => {
    expect(src).toMatch(/const series = deliverySeries\(path, \{/)
    const writes = (src.match(/_lastDeliveryPath = [^\n]+/g) ?? []).filter((w) => !w.endsWith('undefined'))
    expect(writes).toEqual(['_lastDeliveryPath = series'])
  })

  it('a start records when it settled, on success and on failure', () => {
    expect(src).toMatch(/this\._spawnSettled = spawnPromise\.then\(\(\) => \{\}, \(\) => \{\}\)\s*\.finally\(\(\) => \{ this\._spawnSettled = null; this\._startSettledAtMs = Date\.now\(\) \}\)/)
  })
})
