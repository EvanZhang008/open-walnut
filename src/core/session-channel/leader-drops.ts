/**
 * A leader's delete of a session its host runs and judges (docs/plan/one-service-every-host.md,
 * phase 2, the plan's F: "the leader starts a delete; the host drops its own row and that
 * session's records").
 *
 * The sessions copy cannot carry it: a host keeps its own rows when the copy no longer names them
 * (replication/kinds/sessions.ts keptBy), since "absent from the copy" is also what a host sees
 * for a row the leader has not heard of yet, and the copy goes to every replica, so a marker row in
 * it would land as a session on an older one. So the delete is a command of its own, to that host
 * only, kept until the host says it is done:
 *
 *   leader   deleteSessionRecords removes its row and, in the same transaction, writes a mark
 *            here (sid, host). While the mark stands, the host's channel writes no row of that
 *            session again and re-emits none of its facts.
 *   command  POST /host-api/sessions/drop {sids}, sent at once when the host is linked, and again
 *            for every mark of that host each time its channel links (a host that was offline does
 *            it then).
 *   host     deletes its own row (its port's deleteSessionRecords), and its fact log keeps one
 *            `drop` record for the session (compaction removes its earlier records); a host with
 *            no such row any more answers with the `drop` record too.
 *   ack      the `drop` record, applied by the leader's channel, clears the mark. A host never
 *            deletes a row the leader still has: its own `drop` without a mark here changes
 *            nothing on the leader.
 *
 * The table lives in sessions.sqlite (session-db.ts SCHEMA_SQL): it moves with the leader's data.
 */
import type { Database as DatabaseType } from '../../lib/sqlite.js'
import { getDb } from '../session-db.js'
import { prepared } from '../../lib/sqlite-prepared.js'

/** Inside the delete's transaction: `sid` was `hostId`'s row and the leader deleted it. */
export function noteLeaderDrop(handle: DatabaseType, sid: string, hostId: string, at = Date.now()): void {
  handle.prepare('INSERT OR REPLACE INTO session_leader_drops (claude_session_id, host_id, at) VALUES (?, ?, ?)').run(sid, hostId, at)
}

/** Did the leader delete `sid` (a mark its host has not answered yet)? */
export function leaderDroppedIn(handle: DatabaseType, sid: string): boolean {
  return prepared(handle, 'SELECT 1 FROM session_leader_drops WHERE claude_session_id = ?', 'pluck').get(sid) !== undefined
}

/** Inside the channel's apply transaction: the host dropped these, the marks go. */
export function clearLeaderDrops(handle: DatabaseType, hostId: string, sids: readonly string[]): void {
  const del = handle.prepare('DELETE FROM session_leader_drops WHERE claude_session_id = ? AND host_id = ?')
  for (const sid of sids) del.run(sid, hostId)
}

/** The deletes `hostId` has not answered yet, oldest first. */
export function leaderDropsOf(hostId: string): string[] {
  const handle = getDb()
  if (!handle || !hostId) return []
  return handle.prepare('SELECT claude_session_id FROM session_leader_drops WHERE host_id = ? ORDER BY at, claude_session_id').pluck().all(hostId) as string[]
}

/** The host of each mark among `sids` (a delete that just happened). */
export function leaderDropHosts(sids: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const handle = getDb()
  if (!handle) return out
  const sel = handle.prepare('SELECT host_id FROM session_leader_drops WHERE claude_session_id = ?').pluck()
  for (const sid of sids) {
    const host = sel.get(sid) as string | undefined
    if (!host) continue
    const list = out.get(host) ?? []
    list.push(sid)
    out.set(host, list)
  }
  return out
}
