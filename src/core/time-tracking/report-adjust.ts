/**
 * Two corrections the time report makes to Walnut lease time, using the Mac's
 * foreground sampler. PURE; report.ts applies them.
 *
 * 1. Overlap (outside wins). A lease runs 60 s past the last click. When the user
 *    moved to another Mac app inside that minute, the tail used to be counted
 *    twice: once as Walnut, once as the other app. The browser now closes the
 *    lease on window blur, and for every record (older ones included) the report
 *    cuts the seconds a non-Walnut app was frontmost. They are `overlapMin`.
 *
 * 2. Reading (inferred). Walnut frontmost with no lease means the user was
 *    looking at Walnut without clicking or typing (moving the pointer, reading).
 *    Those seconds go to the context of the lease that ended last, for at most
 *    READING_CAP_MS after it, and only while Walnut stayed frontmost the whole
 *    time since (a switch to another app, or the sampler's idle cut, ends it).
 *    They are `readingMin`, never mixed into measured minutes.
 *
 * Only browser time on this Mac is touched: the phone's records (`source: ios`)
 * are not seen by the Mac's sampler. A browser whose site the sampler could not
 * read is neither: it may be Walnut, so it never cuts and never credits.
 */

import { BROWSER_BUNDLE_IDS, WALNUT_DESKTOP_BUNDLE_ID } from './outside-view.js'
import type { OutsideRecord } from './outside-store.js'
import { coveredMs, mergeSpans, uncovered } from './calls.js'
import { localDateKey } from './rollup.js'
import type { TimeRecord } from './types.js'

/** Longest a reading stretch is credited after the last lease. */
export const READING_CAP_MS = 15 * 60_000
/** Sampler windows this close are one stretch (samples are ~5 s apart). */
const SAMPLE_JOIN_MS = 10_000

export type Piece = [number, number]

export interface ReadingCredit {
  date: string
  taskId: string
  kind: TimeRecord['kind']
  sessionId?: string
  view?: TimeRecord['view']
  app?: string
  startMs: number
  endMs: number
}

export interface Adjustment {
  /** Pieces of a clipped record's span still counted; a record missing here is counted whole. */
  pieces: Map<TimeRecord, Piece[]>
  /** Clipped milliseconds per record (only records that lost time). */
  overlap: Map<TimeRecord, number>
  reading: ReadingCredit[]
  /** Merged spans a non-Walnut app was frontmost (empty without the sampler). */
  other: Array<[number, number]>
}

function span(rec: { ts: string; durationMs: number }, date: string): Piece | null {
  // A compacted day keeps only bucket totals stamped at UTC midnight (store.ts).
  if (!rec.ts || rec.ts === `${date}T00:00:00.000Z`) return null
  const a = Date.parse(rec.ts)
  return Number.isFinite(a) ? [a, a + rec.durationMs] : null
}

export function isWalnutForeground(rec: OutsideRecord, walnutHosts: ReadonlySet<string>): boolean {
  return rec.bundleId === WALNUT_DESKTOP_BUNDLE_ID || (!!rec.host && walnutHosts.has(rec.host.toLowerCase()))
}

/** Is this a record the Mac's sampler can speak for? Browser lease time with a real span. */
function onThisMac(rec: TimeRecord): boolean {
  return rec.kind !== 'agent' && rec.source !== 'ios' && rec.durationMs > 0
}

export function adjustLeases(
  records: ReadonlyMap<string, readonly TimeRecord[]>,
  outside: ReadonlyMap<string, readonly OutsideRecord[]> | undefined,
  walnutHosts: ReadonlySet<string>,
): Adjustment {
  const out: Adjustment = { pieces: new Map(), overlap: new Map(), reading: [], other: [] }
  if (!outside || outside.size === 0) return out
  const other: Piece[] = []
  const walnutFg: Piece[] = []
  const browsers = new Set(BROWSER_BUNDLE_IDS)
  for (const [date, recs] of outside) {
    for (const r of recs) {
      const s = r.durationMs > 0 ? span(r, date) : null
      if (!s) continue
      if (isWalnutForeground(r, walnutHosts)) walnutFg.push(s)
      else if (!r.host && r.bundleId && browsers.has(r.bundleId)) continue
      else other.push(s)
    }
  }
  const otherMerged = mergeSpans(other)
  out.other = otherMerged
  const fgMerged = mergeSpans(walnutFg, SAMPLE_JOIN_MS)

  // 1. Overlap.
  const leases: Array<{ rec: TimeRecord; date: string; s: Piece }> = []
  for (const [date, recs] of records) {
    for (const rec of recs) {
      if (!onThisMac(rec)) continue
      const s = span(rec, date)
      if (!s) continue
      leases.push({ rec, date, s })
      const cut = coveredMs(s[0], s[1], otherMerged)
      if (cut <= 0) continue
      out.overlap.set(rec, cut)
      out.pieces.set(rec, uncovered(s[0], s[1], otherMerged))
    }
  }
  if (fgMerged.length === 0 || leases.length === 0) return out

  // 2. Reading: Walnut frontmost, no lease, right after one.
  leases.sort((a, b) => a.s[1] - b.s[1])
  const leaseUnion = mergeSpans(leases.map((l) => l.s))
  const ends = leases.map((l) => l.s[1])
  /** The lease that ended last at or before `t` (binary search on end). */
  const lastBefore = (t: number): (typeof leases)[number] | undefined => {
    let lo = 0
    let hi = ends.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (ends[mid]! <= t) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    return found >= 0 ? leases[found] : undefined
  }
  for (const [fa, fb] of fgMerged) {
    for (const [u0, u1] of uncovered(fa, fb, leaseUnion)) {
      const last = lastBefore(u0 + 1)
      if (!last) continue
      const leaseEnd = last.s[1]
      // Walnut must have stayed frontmost since that lease ended.
      if (fa > leaseEnd + SAMPLE_JOIN_MS) continue
      const end = Math.min(u1, leaseEnd + READING_CAP_MS)
      if (end <= u0) continue
      const r = last.rec
      out.reading.push({
        date: localDateKey(new Date(u0)), taskId: r.taskId ?? '', kind: r.kind, startMs: u0, endMs: end,
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        ...(r.view ? { view: r.view } : {}),
        ...(r.app ? { app: r.app } : {}),
      })
    }
  }
  return out
}

/** The counted pieces of a record: its clipped pieces, or its whole span. */
export function countedPieces(adj: Adjustment, rec: TimeRecord, whole: Piece | null): Piece[] {
  return adj.pieces.get(rec) ?? (whole ? [whole] : [])
}
