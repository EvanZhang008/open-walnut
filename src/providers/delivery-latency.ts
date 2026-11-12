/**
 * How long a delivered batch waited to reach its CLI: the number behind
 * `message delivered {deliveryMs}` and the send.delivery health alarms.
 *
 * Waits that are not the delivery path's are left out or counted apart
 * (2026-11-10: 22 of 37 deliveries over 15 s in two days were the first, three
 * of the longest the second; 2026-11-11, the send.resume alarm: the third and
 * fourth):
 *
 *  - A line written earlier. A resend after a restart or an unanswered send
 *    (dedupe) that the daemon answers with the line's fate wrote nothing now:
 *    the line went in at its first write, which was measured then. Measuring
 *    it again from the row's enqueue time read 43 ms as 403 s. When the daemon
 *    says when it wrote the line (`writtenAt`), that is the wait; else the wait
 *    is unknown and nothing is counted.
 *  - Time this machine slept (sleep-ledger.ts).
 *  - Time the session's host link was down (host-link-ledger.ts): the rows wait
 *    for the host, which the host link's own alarm and banner report.
 *  - Time the row was held where no delivery could take it (its `heldSpans`,
 *    core/queue-held-spans.ts): parked while its task moved to another host,
 *    for a running turn's end, for start recovery or a Retry, or out of any
 *    queue during a move. 2026-11-12: a message held 1 h 55 min while a move to
 *    clouddev was cut short by four deploys read 6,926 s "slow to wake".
 *  - A resumed CLI's start on this machine while it was short of memory
 *    (resumeMachineShare): the process waited on paging, which no Walnut code
 *    path can make faster. It is counted under the machine's own
 *    metric, as the event loop's starved stalls are (stall-cause.ts).
 */

import { sleepIntervals } from '../lib/sleep-ledger.js'

export interface DeliveredRow { id: string; enqueuedAt: string; heldSpans?: Interval[] }

/** What the daemon said instead of writing the line (onFate). */
export interface KnownLineFate { fate: string; writtenAt?: number }

export interface Interval { start: number; end: number }

/** The parts of a wait that are not the delivery path's, each clipped to `[from, to]`. */
export interface OutOfPathWaits {
  slept: (from: number, to: number) => Interval[]
  linkDown?: (from: number, to: number) => Interval[]
}

export const REAL_WAITS: OutOfPathWaits = { slept: sleepIntervals }

export interface DeliveryLatency {
  /** The longest wait among the rows that was the delivery path's, absent when no row's wait is known. */
  deliveryMs?: number
  /** That row. */
  messageId?: string
  /** Its wait on the wall clock, when sleep or a down link took part of it. */
  wallMs?: number
  /** The sleep left out of it. */
  sleptMs?: number
  /** The host link's downtime left out of it (none of it asleep). */
  linkDownMs?: number
  /** The row's time held out of delivery left out of it (none of it asleep or link down). */
  heldMs?: number
  /** The line was written before this delivery. */
  writtenEarlier?: true
}

/** Milliseconds of `[from, to]` that were not the delivery path's (sleep and a down link, counted once). */
export function outOfPathBetween(waits: OutOfPathWaits, from: number, to: number): number {
  if (!(to > from)) return 0
  return Math.min(to - from, unionMs([...waits.slept(from, to), ...(waits.linkDown ? waits.linkDown(from, to) : [])]))
}

/** The well-formed parts of `list` inside `[from, to]`. */
function clip(list: Interval[] | undefined, from: number, to: number): Interval[] {
  const out: Interval[] = []
  for (const i of Array.isArray(list) ? list : []) {
    const a = Math.max(from, Number(i?.start))
    const b = Math.min(to, Number(i?.end))
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) out.push({ start: a, end: b })
  }
  return out
}

/** Length of the union of the intervals. */
function unionMs(list: Interval[]): number {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)
  let total = 0
  let curS = -Infinity
  let curE = -Infinity
  for (const i of sorted) {
    if (i.start > curE) {
      if (curE > curS) total += curE - curS
      curS = i.start
      curE = i.end
    } else if (i.end > curE) curE = i.end
  }
  if (curE > curS) total += curE - curS
  return total
}

export function deliveryLatency(
  rows: DeliveredRow[],
  now: number,
  known?: KnownLineFate,
  waits: OutOfPathWaits = REAL_WAITS,
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
    const to = Math.max(enq, end)
    const sleep = wall > 0 ? waits.slept(enq, to) : []
    const down = wall > 0 && waits.linkDown ? waits.linkDown(enq, to) : []
    const held = wall > 0 ? clip(r.heldSpans, enq, to) : []
    const slept = Math.min(wall, unionMs(sleep))
    // Sleep, a down link and a hold overlap (a Mac asleep drops its links, a move waits for
    // its host): the union is left out once.
    const sleptOrDown = Math.min(wall, unionMs([...sleep, ...down]))
    const out = Math.min(wall, unionMs([...sleep, ...down, ...held]))
    const linkDown = sleptOrDown - slept
    const heldOut = out - sleptOrDown
    const ms = Math.max(0, wall - out)
    if (!best || ms >= best.deliveryMs!) {
      best = {
        deliveryMs: ms,
        messageId: r.id,
        ...(out > 0 ? { wallMs: wall } : {}),
        ...(slept > 0 ? { sleptMs: Math.round(slept) } : {}),
        ...(linkDown > 0 ? { linkDownMs: Math.round(linkDown) } : {}),
        ...(heldOut > 0 ? { heldMs: Math.round(heldOut) } : {}),
      }
    }
  }
  if (!best) return writtenEarlier ? { writtenEarlier: true } : { deliveryMs: 0 }
  return writtenEarlier ? { ...best, writtenEarlier: true } : best
}

/**
 * The part of a resume's wait that was its CLI starting on a machine short of
 * memory: from the spawn to the delivery (less sleep and a down link), when the
 * session runs on this machine, the CLI's start is most of the wait, and the
 * kernel's memory pressure read warn or critical while it started
 * (memory-pressure.ts: the level behind the stall recorder's `paging`, and what
 * the 2026-11-11 slow starts lined up with: warn from 18:09 to 18:19, normal
 * before and after). The load average is no sign of it here: endpoint agents
 * keep this Mac's load at 40 to 200 with a third of its CPU idle
 * (tests/scripts/load-gate-free-cpu-ratchet.test.ts). Zero otherwise: a remote
 * host's memory is not known here, and a wait Walnut spent before the spawn (its
 * queue, its pre-spawn steps) stays the resume path's.
 */
export function resumeMachineShare(input: {
  /** The session runs on this machine (no host, or `__local__`). */
  local: boolean
  /** When the CLI start went to the host (ms), 0 when unknown. */
  spawnedAtMs: number
  /** When the oldest row of the batch was enqueued (ms): a spawn before it is another wait's. */
  enqueuedAtMs: number
  /** Sleep and link downtime between the spawn and now (outOfPathBetween). */
  outOfPathSinceSpawnMs: number
  now: number
  /** The delivery's own wait (deliveryLatency). */
  deliveryMs: number
  /** Memory pressure read warn or critical since the spawn (memoryPressureSeenSince). */
  pressuredSinceSpawn: boolean
}): number {
  const { local, spawnedAtMs, enqueuedAtMs, outOfPathSinceSpawnMs, now, deliveryMs, pressuredSinceSpawn } = input
  if (!local || !pressuredSinceSpawn || !(spawnedAtMs > 0) || !(deliveryMs > 0)) return 0
  if (!(spawnedAtMs >= enqueuedAtMs)) return 0
  const cliStart = Math.min(deliveryMs, Math.max(0, now - spawnedAtMs - outOfPathSinceSpawnMs))
  return cliStart * 2 >= deliveryMs ? Math.round(cliStart) : 0
}
