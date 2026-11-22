/**
 * What a host's rows frame (channel.ts `rows`) may do to the leader's rows of that host
 * (session-tracker applyHostChannelBatch, inside its transaction). A rows frame is the host's own
 * rows as of record `at` of its log; the leader applies each one whole. The rule for the rows of
 * that host the frame does NOT name is conservative, because a wrong delete loses the only record
 * of a session (its title, note, task links) while a kept row costs nothing:
 *
 *   stale     a frame taken at or below what the leader already applied of the same log (the
 *             stored position, or the newest frame this process applied for that host) is
 *             skipped whole: it came on a link a newer one replaced, and its rows are older
 *   delete    only a row the host itself names gone (its persisted record of the rows it renamed
 *             away or dropped, gone-rows.ts), and only when the frame's log is the one the leader
 *             already knew for that host
 *   keep      everything else: a start in flight (`keep`), a seed the host has not written yet,
 *             a row the leader deleted itself (leader-drops.ts), a row of a log the leader did not
 *             know (a host whose store was reset or set up again), a row whose drop the host's
 *             bounded record forgot. Such a row that still reads live is marked stopped
 *             (`status_reason: 'orphan_no_pid'`, by `system`): nothing on its host runs it, and nothing
 *             here would ever say so otherwise. A born row of it, later, replaces the mark.
 *
 * Deletion is never the snapshot's own conclusion: only the host's word deletes.
 */
import type { SessionRecord } from '../types.js'

/** The reason a kept, unnamed row is marked stopped with: a row with no process its host holds. */
export const HOST_ROW_MISSING = 'orphan_no_pid' as const

export interface SnapshotPlan {
  /** Rows the host named gone: deleted. */
  remove: string[]
  /** Rows kept, marked stopped: they read live and the host does not have them. */
  orphan: string[]
}

/** Process states that mean nothing runs (the mark is not written again on them). */
const AT_REST: ReadonlySet<string> = new Set(['stopped', 'error'])

export function planSnapshot(o: {
  /** The host's rows here that the frame does not name, that are not kept, and that are the host's (judgedByHost). */
  unnamed: readonly SessionRecord[]
  /** The rows the host says it removed (the frame's `gone`). */
  gone: ReadonlySet<string>
  /** Is the frame's log the one the leader stored a position for? */
  logKnown: boolean
}): SnapshotPlan {
  const remove: string[] = []
  const orphan: string[] = []
  for (const row of o.unnamed) {
    const sid = row.claudeSessionId
    if (o.logKnown && o.gone.has(sid)) { remove.push(sid); continue }
    const status = String(row.process_status ?? '')
    if (!AT_REST.has(status) || row.pid != null) orphan.push(sid)
  }
  return { remove, orphan }
}

/** The row a kept, unnamed host row becomes: stopped, its pid gone, the reason said. */
export function orphanedRow(row: SessionRecord, now: string): SessionRecord {
  return {
    ...row,
    process_status: 'stopped',
    pid: undefined,
    status_reason: HOST_ROW_MISSING,
    status_changed_by: 'system',
    last_status_change: now,
  }
}

/** The newest rows frame this process applied per host (the stored position covers a restart). */
const appliedAt = new Map<string, { logId: string; at: number }>()

/** Is a rows frame of `logId` taken at `at` older than what is applied already (skip it whole)? */
export function snapshotIsStale(hostId: string, logId: string, at: number, stored: { logId: string; seq: number } | null): boolean {
  if (stored && stored.logId === logId && stored.seq >= at) return true
  const last = appliedAt.get(hostId)
  return !!last && last.logId === logId && last.at >= at
}

export function noteSnapshotApplied(hostId: string, logId: string, at: number): void {
  const last = appliedAt.get(hostId)
  if (last && last.logId === logId && last.at >= at) return
  appliedAt.set(hostId, { logId, at })
}

export function _resetRowsSnapshotForTesting(): void {
  appliedAt.clear()
}
