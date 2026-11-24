/**
 * A page of a transcript named by its place: the row it ends before, by that row's message id
 * (`msgId`) and time (`before`). The transcript route's `beforeId`, the windows an older page is
 * read in, and task_history's cuts all name and find that row the same way, here.
 *
 * Why a place and not a time: a row stamped out of time order (a resumed session's copied
 * lines, a compaction summary stamped before its boundary) makes a time point at the wrong
 * place, so pages repeated or skipped rows (2026-11-24, task_history).
 */

/** A message id the route takes as a cursor: an API message id, a line uuid, or one the parser made. */
export const TRANSCRIPT_ROW_ID = /^[A-Za-z0-9_.:-]{1,200}$/

export function isTranscriptRowId(v: unknown): v is string {
  return typeof v === 'string' && TRANSCRIPT_ROW_ID.test(v)
}

/**
 * Where the row named by (`id`, `before`) is in `rows`, -1 when none is. By the id first: a row's
 * time is not always the same on every read (a line with none is stamped when it is parsed, a
 * window that starts inside a message stamps it from the part it holds). Of several rows with the
 * id, the one stamped `before`, else the newest.
 */
export function rowPlace(rows: readonly { msgId?: string; timestamp: string }[], id: string, before: string): number {
  let newest = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].msgId !== id) continue
    if (rows[i].timestamp === before) return i
    if (newest < 0) newest = i
  }
  return newest
}
