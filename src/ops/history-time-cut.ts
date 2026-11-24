/**
 * Cutting a task conversation's rows BY TIME, the one way task_history leaves out older rows (its
 * `limit`, the default an agent reads, a window held to the answer's cap). The route's `before`
 * page is by time too (every session's rows older than it), so a cut that keeps every row at or
 * after a time T and answers `before: T` pages back with nothing lost and nothing read twice.
 *
 * By position is not the same: all:true joins the sessions by when each started, so a session the
 * task switched back to holds the newest rows ahead of a later session's (2026-11-24 review: a cut
 * by position kept the later session's older rows and lost the resumed session's newest).
 *
 * A session header (a system notification row with no time, all:true) is kept when any row of
 * its session is; a row with no time of its own takes the time of the row before it in its session
 * (else the one after it), and a session with no times at all is never cut.
 *
 * One session's rows that carry their message ids (the route's `ids=1`) are cut BY PLACE instead,
 * and the page before is named by the first kept row's time and id (`before`, `beforeId`), which the
 * route cuts at exactly (session-projection.ts BuildTranscriptOptions.beforeId). A time alone cannot
 * name a place when a row is stamped out of time order: 2026-11-24, a reply written with a clock
 * behind made the time cut drop it and point `before` past rows already shown, and every later
 * page asked for the same page again. Real transcripts hold such rows (a resumed session's copied
 * lines, a compaction summary stamped before its boundary).
 */

import { isTranscriptRowId } from '../core/transcript-row-place.js'

type Row = Record<string, unknown>

export const isSessionHeader = (m: Row): boolean => m.role === 'system' && m.kind === 'notification' && !m.timestamp

/** Each row's time for the cut (NaN for a header, and for a row of a session with no times). */
function rowTimes(rows: Row[]): number[] {
  const t = rows.map((r) => (isSessionHeader(r) || typeof r.timestamp !== 'string' ? NaN : Date.parse(r.timestamp)))
  for (const dir of [1, -1]) {
    let near = NaN
    for (let k = 0; k < rows.length; k++) {
      const i = dir === 1 ? k : rows.length - 1 - k
      if (isSessionHeader(rows[i])) near = NaN
      else if (Number.isNaN(t[i])) t[i] = near
      else near = t[i]
    }
  }
  return t
}

export interface TimeCut {
  kept: Row[]
  /** The rows left out (never a header). */
  dropped: Row[]
  /** The time the page before reads up to (exclusive); undefined when nothing was left out. */
  before?: string
  /** With `before`, on a cut by place: the id of the first kept row, which the page before ends at. */
  beforeId?: string
}

/** The rows' message ids when the rows are one session's and every one carries its id, else null. */
function placeIds(rows: Row[]): string[] | null {
  const ids: string[] = []
  for (const r of rows) {
    // An id the route could not take back as a cursor is no id: the rows page by time.
    if (isSessionHeader(r) || !isTranscriptRowId(r.msgId) || typeof r.timestamp !== 'string') return null
    ids.push(r.msgId)
  }
  return ids.length ? ids : null
}

/** Where the message the row at `i` belongs to starts: its rows stay together. */
function messageStart(ids: string[], i: number): number {
  while (i > 0 && ids[i - 1] === ids[i]) i--
  return i
}

/** The rows from `from` on, the page before named by the row there. */
function keepAt(rows: Row[], ids: string[], from: number): TimeCut {
  if (from <= 0) return { kept: rows, dropped: [] }
  return { kept: rows.slice(from), dropped: rows.slice(0, from), before: rows[from].timestamp as string, beforeId: ids[from] }
}

/**
 * The cursor of the page before a page of rows, `before` (and `beforeId` for one session's rows that
 * carry ids): the first row's place, else (all:true joins sessions out of time order) the earliest time.
 */
export function pageStart(rows: Row[]): { before: string; beforeId?: string } | undefined {
  const ids = placeIds(rows)
  if (ids) return { before: rows[0].timestamp as string, beforeId: ids[0] }
  let best: string | undefined
  for (const r of rows) if (typeof r.timestamp === 'string' && (best === undefined || Date.parse(r.timestamp) < Date.parse(best))) best = r.timestamp
  return best === undefined ? undefined : { before: best }
}

/** Which rows are at or after `from`, with the headers of their sessions. */
function keepMask(rows: Row[], t: number[], from: number): boolean[] {
  const keep = rows.map((r, i) => !isSessionHeader(r) && !(t[i] < from))
  for (let i = rows.length - 1, any = false; i >= 0; i--) {
    if (isSessionHeader(rows[i])) { keep[i] = any; any = false } else if (keep[i]) any = true
  }
  return keep
}

/** The rows at or after `from`, with the headers of their sessions. */
function keepFrom(rows: Row[], t: number[], from: number): TimeCut {
  const keep = keepMask(rows, t, from)
  const kept: Row[] = []
  const dropped: Row[] = []
  rows.forEach((r, i) => { if (keep[i]) kept.push(r); else if (!isSessionHeader(r)) dropped.push(r) })
  if (dropped.length === 0) return { kept, dropped }
  // The page before excludes every row at `from`: name it as a row there wrote it.
  const at = rows.find((r, i) => t[i] === from && typeof r.timestamp === 'string' && Date.parse(r.timestamp) === from)
  return { kept, dropped, before: typeof at?.timestamp === 'string' ? at.timestamp : new Date(from).toISOString() }
}

/** The distinct times of the rows, newest first. */
const timesNewestFirst = (t: number[]): number[] => [...new Set(t.filter((x) => !Number.isNaN(x)))].sort((a, b) => b - a)

/** The newest `limit` rows `counts` (the messages a reader sees as text) and every row at or after the oldest of them. */
export function newestCounted(rows: Row[], limit: number, counts: (r: Row) => boolean): TimeCut {
  const ids = placeIds(rows)
  if (ids) {
    let seen = 0
    for (let i = rows.length - 1; i >= 0; i--) {
      if (counts(rows[i]) && ++seen === limit) return keepAt(rows, ids, messageStart(ids, i))
    }
    return { kept: rows, dropped: [] }
  }
  const t = rowTimes(rows)
  const counted = rows.flatMap((r, i) => (counts(r) && !Number.isNaN(t[i]) ? [t[i]] : [])).sort((a, b) => b - a)
  if (counted.length < limit) return { kept: rows, dropped: [] }
  return keepFrom(rows, t, counted[limit - 1])
}

/**
 * The newest rows whose JSON fits `room` characters (each row's size by `size`), whole times at a
 * time; at least the newest time's rows, even when they alone are over.
 */
export function newestFitting(rows: Row[], room: number, size: (r: Row) => number): TimeCut {
  const ids = placeIds(rows)
  if (ids) {
    // Whole messages from the newest back while they fit; the newest message always.
    let from = messageStart(ids, rows.length - 1)
    let used = rows.slice(from).reduce((n, r) => n + size(r), 0)
    while (from > 0) {
      const next = messageStart(ids, from - 1)
      const more = rows.slice(next, from).reduce((n, r) => n + size(r), 0)
      if (used + more > room) break
      used += more
      from = next
    }
    return keepAt(rows, ids, from)
  }
  const t = rowTimes(rows)
  const times = timesNewestFirst(t)
  if (times.length === 0) return { kept: rows, dropped: [] }
  const sizes = rows.map(size)
  let from = times[0]
  for (const next of times.slice(1)) {
    const keep = keepMask(rows, t, next)
    if (sizes.reduce((n, s, i) => (keep[i] ? n + s : n), 0) > room) break
    from = next
  }
  return keepFrom(rows, t, from)
}
