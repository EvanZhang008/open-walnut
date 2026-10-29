/**
 * How long the Mac keeps reply requests (session-requests.ts prune), and how a
 * copy of them tells that retention from a lost store.
 *
 * The Mac keeps every pending request, and settled ones for 7 days, at most
 * MAX_REQUESTS rows (the oldest settled rows go first). A host replica's copy
 * only removes a row when a manifest stops naming it, under the half rule
 * (replication/kind.ts): a manifest that removes most of the copy is refused,
 * because the leader may have lost its store. A copy that missed rounds for a
 * day or two (its server was down) then holds only rows the Mac pruned since,
 * and every round was refused, forever (2026-10-26 to 10-28: 413 of 413 rows
 * on clouddev, about 340 refusals a day). The manifest now carries the
 * leader's window (`requestsWindowOf`) and the copy works out which rows it
 * would remove that this retention explains (`prunedByLeader`). Those go
 * without counting toward the half rule; the rest still do, so a leader that
 * lost its store still cannot empty the copy.
 *
 * No imports with side effects: the requests copy kind loads this on every
 * follower.
 */

/** Most-recent-N cap; settled rows past the cap drop off the tail. */
export const MAX_REQUESTS = 500
/** Settled rows older than this are pruned on write. */
export const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

interface RetainedRow { status: string; createdAt: string; settledAt?: string }

/**
 * What the leader's prune left this round, sent with the requests manifest as
 * `window`: `from` is the creation time of the first settled row it keeps in
 * store order, named only while the store is at its cap (below it, the cap
 * evicted nothing). The cap evicts in store order (session-requests.ts prune
 * drops the earliest settled rows of the array), so that row is where the
 * eviction stopped. Not the oldest createdAt: a row a host's journal appended
 * late can carry an early one, and would pull the window back by days.
 */
export type RequestsWindow = { from: number }

/** The leader's window over its rows (store order), or undefined when the cap evicted nothing. */
export function requestsWindowOf(rows: readonly RetainedRow[]): RequestsWindow | undefined {
  if (rows.length < MAX_REQUESTS) return undefined
  for (const r of rows) {
    if (r.status === 'pending') continue
    const from = Date.parse(r.createdAt)
    if (Number.isFinite(from)) return { from }
  }
  return undefined
}

/** A sync's `window`, or null when it names none (or a malformed one: treated as none). */
export function windowOf(raw: unknown): RequestsWindow | null {
  const from = (raw as { from?: unknown } | null)?.from
  return typeof from === 'number' && Number.isFinite(from) && from > 0 ? { from } : null
}

/**
 * Whether the leader's own retention explains why its manifest no longer names
 * `row` (the copy's row):
 *   - a settled row past the retention on this side's clock (never a leader's
 *     clock ahead of it);
 *   - any row created before the start of a full window, pending ones too: the
 *     Mac never prunes a pending row, so one that is gone there was settled
 *     (a settle this copy missed) and then evicted by the cap.
 * A full window is one whose manifest names at least MAX_REQUESTS rows: a
 * leader that lost its store names far fewer and gets no say over the cap.
 * A pending row is never explained by age alone.
 */
export function prunedByLeader(
  row: RetainedRow, at: { now: number; asOf?: number; window: RequestsWindow | null; entries: number },
): boolean {
  if (at.window && at.entries >= MAX_REQUESTS) {
    const created = Date.parse(row.createdAt)
    if (Number.isFinite(created) && created < at.window.from) return true
  }
  if (row.status === 'pending') return false
  const now = at.asOf && at.asOf > 0 ? Math.min(at.now, at.asOf) : at.now
  const settled = Date.parse(row.settledAt ?? row.createdAt)
  return Number.isFinite(settled) && settled < now - SETTLED_RETENTION_MS
}
