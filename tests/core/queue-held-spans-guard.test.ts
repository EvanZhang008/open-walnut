/**
 * A queued row's time held where no delivery could take it is recorded on the row,
 * so its delivery wait leaves it out (src/core/queue-held-spans.ts).
 *
 * 2026-11-12, the send.resume health alarm at 6,926 s: a message parked under
 * MOVE_HELD_REASON from 15:12 to 17:07 while its task's move to clouddev was cut
 * short by four deploys and then failed; the resume that delivered it took one
 * second. The guard enumerates every place in src/ that takes a row out of
 * `parked` (it drops `parkedAt`) and fails when a new one does it by hand, so a
 * new hold path cannot bring the inflated wait back.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { addHeldSpan, closeTaken, HELD_SPANS_MAX, leaveParked, leftParked, parkRow, stampTaken } from '../../src/core/queue-held-spans.js'
import { AFTER_TURN_REASON, START_RECOVERY_HELD_REASON, STOP_PARKED_REASON } from '../../src/core/relay-fates.js'
import { deliveryLatency, type Interval } from '../../src/providers/delivery-latency.js'
import type { QueuedMessage } from '../../src/core/session-queue-store.js'

const ROOT = path.resolve(__dirname, '../..')

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) srcFiles(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Places that drop a row's park fields without recording the time held. */
const UNPARK_BY_HAND = [/delete\s+[\w.]+\.parkedAt\b/, /\{\s*parkedAt:\s*_\w*/]
/** Places that (re)park a row by hand: a row parked again would lose its earlier hold. */
const PARK_BY_HAND = /\.parkedAt\s*=(?!=)/

/** Files allowed to drop `parkedAt` by hand, and why. */
const ALLOWED: Record<string, string> = {
  'src/core/queue-held-spans.ts': 'the helper itself',
  'src/core/sessions/queue-after-turn.ts': 'presentAfterTurn shows a held row as pending in a copy for a reader; the row stays parked',
}

describe('every way a queued row leaves parked records its held time', () => {
  it('no file in src/ drops parkedAt by hand', () => {
    const found: string[] = []
    for (const f of srcFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/')
      if (ALLOWED[rel]) continue
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => { if (UNPARK_BY_HAND.some((re) => re.test(l))) found.push(`${rel}:${i + 1}: ${l.trim()}`) })
    }
    expect(found, 'a row leaving parked must go through leaveParked/leftParked (src/core/queue-held-spans.ts), or its held time reads as a slow delivery').toEqual([])
  })

  it('no file in src/ parks a row by hand', () => {
    const found: string[] = []
    for (const f of srcFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/')
      if (rel === 'src/core/queue-held-spans.ts') continue
      fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (PARK_BY_HAND.test(l)) found.push(`${rel}:${i + 1}: ${l.trim()}`) })
    }
    expect(found, 'a park must go through parkRow (src/core/queue-held-spans.ts), so a row parked again keeps its earlier hold').toEqual([])
  })

  it('each allowed file still does what it is allowed for', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      expect(UNPARK_BY_HAND.some((re) => re.test(src)), `${rel} no longer drops parkedAt: remove it from ALLOWED`).toBe(true)
    }
  })

  it('a move stamps the rows it takes out of a queue and closes them when it puts them back', () => {
    const io = fs.readFileSync(path.join(ROOT, 'src/core/sessions/engine-switch-io.ts'), 'utf8')
    expect(io).toMatch(/export async function takeQueuedRows[\s\S]{0,600}?stampTaken\(r, now\)/)
    expect(io).toMatch(/export async function putQueuedRows[\s\S]{0,1400}?closeTaken\(r, now\)/)
    expect(io).toMatch(/export function releaseMoveHeld[\s\S]{0,300}?leftParked\(r\)/)
  })
})

describe('held spans', () => {
  const T = Date.parse('2026-11-12T15:12:11.430Z')
  const row = (over: Partial<QueuedMessage> = {}): QueuedMessage => ({
    id: 'qm-host-8466', sessionId: 's', message: 'm', status: 'parked', enqueuedAt: new Date(T).toISOString(), ...over,
  })

  it('leaveParked records the parked time and drops the park fields', () => {
    const r = row({ parkedAt: new Date(T).toISOString(), parkedReason: 'Held while its task moves to another host' })
    leaveParked(r, T + 60_000)
    expect(r).not.toHaveProperty('parkedAt')
    expect(r).not.toHaveProperty('parkedReason')
    expect(r.heldSpans).toEqual([{ start: T, end: T + 60_000 }])
  })

  it('leftParked leaves the original alone; a row with no readable parkedAt records nothing', () => {
    const r = row({ parkedAt: new Date(T).toISOString(), parkedReason: 'x' })
    const copy = leftParked(r, T + 5)
    expect(r.parkedAt).toBeDefined()
    expect(copy.heldSpans).toEqual([{ start: T, end: T + 5 }])
    expect(leftParked(row({ parkedAt: 'nope' }), T).heldSpans).toBeUndefined()
  })

  it('a row out of the queue for a move records that time when it is put back', () => {
    const r = row({ status: 'pending' })
    stampTaken(r, T)
    stampTaken(r, T + 100) // a second take keeps the first time
    const back = closeTaken(r, T + 30_000)
    expect(back).not.toHaveProperty('takenAt')
    expect(back.heldSpans).toEqual([{ start: T, end: T + 30_000 }])
    expect(closeTaken(row({ status: 'pending' }), T)).not.toHaveProperty('heldSpans')
  })

  it('a row parked again keeps its earlier hold (after-turn, then a Stop, then Retry)', () => {
    const r = row({ status: 'pending' })
    parkRow(r, AFTER_TURN_REASON, new Date(T).toISOString())
    parkRow(r, STOP_PARKED_REASON, new Date(T + 20 * 60_000).toISOString())
    leaveParked(r, T + 21 * 60_000)
    expect(r.status).toBe('parked') // leaveParked drops the park fields; the caller sets the status
    expect(r.heldSpans).toEqual([{ start: T, end: T + 20 * 60_000 }, { start: T + 20 * 60_000, end: T + 21 * 60_000 }])
  })

  it('a start-recovery hold stays the resume path\'s own wait', () => {
    const r = row({ status: 'pending' })
    parkRow(r, START_RECOVERY_HELD_REASON, new Date(T).toISOString())
    leaveParked(r, T + 60_000)
    expect(r.heldSpans).toBeUndefined()
    // Given up and dead-lettered, then retried: only the dead letter's wait is left out.
    parkRow(r, START_RECOVERY_HELD_REASON, new Date(T).toISOString())
    parkRow(r, 'gave up', new Date(T + 60_000).toISOString())
    leaveParked(r, T + 90_000)
    expect(r.heldSpans).toEqual([{ start: T + 60_000, end: T + 90_000 }])
  })

  it('keeps the newest spans only', () => {
    const r = row()
    for (let i = 0; i < HELD_SPANS_MAX + 4; i++) addHeldSpan(r, T + i * 10, T + i * 10 + 5)
    expect(r.heldSpans).toHaveLength(HELD_SPANS_MAX)
    expect(r.heldSpans!.at(-1)).toEqual({ start: T + (HELD_SPANS_MAX + 3) * 10, end: T + (HELD_SPANS_MAX + 3) * 10 + 5 })
  })
})

describe('deliveryLatency leaves held time out', () => {
  const noSleep = { slept: (): Interval[] => [] }
  const span = (s: number, e: number) => (from: number, to: number): Interval[] =>
    Math.min(to, e) > Math.max(from, s) ? [{ start: Math.max(from, s), end: Math.min(to, e) }] : []

  it('the 2026-11-12 move-held message reads its one-second resume', () => {
    // Enqueued 15:12:11.430 and parked for the move; the move failed at 17:07:43.454 and
    // released it; the resume delivered it at 17:07:44.582. The link was down for its last 6.971 s.
    const enq = Date.parse('2026-11-12T15:12:11.430Z')
    const released = Date.parse('2026-11-12T17:07:43.454Z')
    const now = Date.parse('2026-11-12T17:07:44.582Z')
    const r = row({ parkedAt: new Date(enq).toISOString(), parkedReason: 'Held while its task moves to another host' })
    leaveParked(r, released)
    const waits = { slept: () => [], linkDown: span(now - 6_971 - 1_128, now - 1_128) }
    const lat = deliveryLatency([r], now, undefined, waits)
    expect(lat.deliveryMs).toBe(1_128)
    expect(lat.wallMs).toBe(now - enq)
    expect(lat.linkDownMs).toBe(6_971)
    expect(lat.heldMs).toBe(released - enq - 6_971)
  })

  it('a hold that overlaps sleep is left out once', () => {
    const T = 1_000_000
    const r = { id: 'a', enqueuedAt: new Date(T).toISOString(), heldSpans: [{ start: T + 10_000, end: T + 70_000 }] }
    expect(deliveryLatency([r], T + 100_000, undefined, { slept: span(T + 50_000, T + 80_000) }))
      .toEqual({ deliveryMs: 30_000, messageId: 'a', wallMs: 100_000, sleptMs: 30_000, heldMs: 40_000 })
  })

  it('a span outside the wait, or a malformed one, changes nothing', () => {
    const T = 1_000_000
    const r = { id: 'a', enqueuedAt: new Date(T).toISOString(), heldSpans: [{ start: T - 50_000, end: T - 1 }, { start: Number.NaN, end: T + 5 } as Interval] }
    expect(deliveryLatency([r], T + 2_000, undefined, noSleep)).toEqual({ deliveryMs: 2_000, messageId: 'a' })
  })

  function row(over: Partial<QueuedMessage>): QueuedMessage {
    return { id: 'qm-host-846601154b7e', sessionId: 's', message: 'm', status: 'parked', enqueuedAt: '2026-11-12T15:12:11.430Z', ...over }
  }
})
