/**
 * The hand-overs whose answer this leader has not had yet, on disk (docs/plan/one-service-every-host.md,
 * phase 2): a start or a resume it handed to a host (providers/host-handover.ts), from the hand until
 * the host's yes, its first row of the session, or the session being the leader's again.
 *
 *   written  when the hand-over begins, before anything can send to the host for it
 *   cleared  by the host's answer, by the leader taking the session back, and, in the same
 *            transaction as the host's row of it, by the session channel (session-tracker.ts
 *            applyHostChannelBatch): a host that wrote the row has the session, whatever answer got lost
 *   read     at boot (rearmHandOvers): a leader that stopped in the window checks them again
 *
 * One table of its own, in sessions.sqlite (session-db.ts SCHEMA_SQL), so it moves with the leader's
 * data. An older version never reads it, and keeps working on the rows it marked.
 */
import type { Database as DatabaseType } from '../../lib/sqlite.js'
import { getDb } from '../session-db.js'
import { prepared } from '../../lib/sqlite-prepared.js'
import { oneDaemonNow } from './revoked-hosts.js'

export type HandOverKind = 'start' | 'resume'

export interface HandOverMark { sid: string; host: string; kind: HandOverKind; since: number }

/** A hand-over of `sid` to `host` began. False: no database to keep it in (it is kept in memory only). */
export function writeHandOverMark(m: HandOverMark): boolean {
  const handle = getDb()
  if (!handle) return false
  prepared(handle, 'INSERT OR REPLACE INTO session_host_handovers (claude_session_id, host_id, kind, since) VALUES (?, ?, ?, ?)').run(m.sid, m.host, m.kind, m.since)
  return true
}

/** The hand-over of `sid` ended (answered, taken back). */
export function clearHandOverMark(sid: string): void {
  const handle = getDb()
  if (!handle) return
  prepared(handle, 'DELETE FROM session_host_handovers WHERE claude_session_id = ?').run(sid)
}

/**
 * Inside the channel's apply transaction: `hostId` wrote its row of `sid`. True when a mark of it
 * went: a mark under any name of that host's machine (revoked-hosts.ts oneDaemonNow). One mark per
 * session (claude_session_id is the table's key), so the delete by sid takes only that mark.
 */
export function clearHandOverMarkIn(handle: DatabaseType, sid: string, hostId: string): boolean {
  const on = prepared(handle, 'SELECT host_id FROM session_host_handovers WHERE claude_session_id = ?', 'pluck').get(sid) as string | undefined
  if (on === undefined || !oneDaemonNow(on, hostId)) return false
  return prepared(handle, 'DELETE FROM session_host_handovers WHERE claude_session_id = ?').run(sid).changes > 0
}

/** Is the mark of `sid` still on disk? (Null: no database to ask.) */
export function handOverMarkStands(sid: string): boolean | null {
  const handle = getDb()
  if (!handle) return null
  return prepared(handle, 'SELECT 1 FROM session_host_handovers WHERE claude_session_id = ?', 'pluck').get(sid) !== undefined
}

/** Every mark on disk, oldest first; null while no database is open (asked again later). */
export function handOverMarks(): HandOverMark[] | null {
  const handle = getDb()
  if (!handle) return null
  const rows = prepared(handle, 'SELECT claude_session_id AS sid, host_id AS host, kind, since FROM session_host_handovers ORDER BY since, claude_session_id').all() as Array<{ sid: string; host: string; kind: string; since: number }>
  return rows.map((r) => ({ sid: r.sid, host: r.host, kind: r.kind === 'resume' ? 'resume' : 'start', since: Number(r.since) || 0 }))
}
