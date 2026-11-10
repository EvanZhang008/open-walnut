/**
 * How long a delivered batch waited to reach its CLI: the number behind
 * `message delivered {deliveryMs}` and the send.delivery health alarms.
 *
 * Two waits are not the delivery path's (2026-11-10: 22 of 37 deliveries over
 * 15 s in two days were the first, three of the longest the second):
 *
 *  - A line written earlier. A resend after a restart or an unanswered send
 *    (dedupe) that the daemon answers with the line's fate wrote nothing now:
 *    the line went in at its first write, which was measured then. Measuring
 *    it again from the row's enqueue time read 43 ms as 403 s. When the daemon
 *    says when it wrote the line (`writtenAt`), that is the wait; else the wait
 *    is unknown and nothing is counted.
 *  - Time this machine slept (sleep-ledger.ts).
 */

import { sleptBetween as realSleptBetween } from '../lib/sleep-ledger.js'

export interface DeliveredRow { id: string; enqueuedAt: string }

/** What the daemon said instead of writing the line (onFate). */
export interface KnownLineFate { fate: string; writtenAt?: number }

export interface DeliveryLatency {
  /** The longest awake wait among the rows, absent when no row's wait is known. */
  deliveryMs?: number
  /** That row. */
  messageId?: string
  /** Its wait on the wall clock, when sleep took part of it. */
  wallMs?: number
  /** The sleep left out of it. */
  sleptMs?: number
  /** The line was written before this delivery. */
  writtenEarlier?: true
}

export function deliveryLatency(
  rows: DeliveredRow[],
  now: number,
  known?: KnownLineFate,
  sleptBetween: (from: number, to: number) => number = realSleptBetween,
): DeliveryLatency {
  const writtenEarlier = known !== undefined
  // A known fate with no write time: when the line went in is not known.
  const end = writtenEarlier ? (typeof known!.writtenAt === 'number' && Number.isFinite(known!.writtenAt) ? known!.writtenAt : null) : now
  if (end === null) return { writtenEarlier: true }
  let best: DeliveryLatency | null = null
  for (const r of rows) {
    const enq = Date.parse(r.enqueuedAt)
    if (Number.isNaN(enq)) continue
    // The host's clock wrote `writtenAt`: a little skew must not read as a negative wait.
    const wall = Math.max(0, end - enq)
    const slept = wall > 0 ? sleptBetween(enq, Math.max(enq, end)) : 0
    const ms = Math.max(0, wall - slept)
    if (!best || ms >= best.deliveryMs!) {
      best = { deliveryMs: ms, messageId: r.id, ...(slept > 0 ? { wallMs: wall, sleptMs: Math.round(slept) } : {}) }
    }
  }
  if (!best) return writtenEarlier ? { writtenEarlier: true } : { deliveryMs: 0 }
  return writtenEarlier ? { ...best, writtenEarlier: true } : best
}
