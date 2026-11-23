/**
 * A host's turn end the leader may not have acted on (the plan's M3, boot reconcile): the channel
 * applies a batch of a host's records in one transaction and only then says its facts on the bus,
 * where the turn-end handlers move the task's phase (web/server.ts, applySessionPhase). A leader that
 * stops after the commit and before those handlers wrote the phase (a crash, a deploy's restart while
 * the handler waits on its git pull) loses that edge: the host's records are applied, so they never
 * come again, and the task stays In Progress with its session idle.
 *
 * So the same transaction keeps a mark per session of its last turn end that moves a phase
 * (turn-end-edge.ts: the edge, and the leader's time of the commit), and at the leader's boot
 * `reconcileHostTurnEnds` looks at each mark once:
 *
 *   the session's row is gone, no longer this host's, has no task, or runs a turn again   nothing
 *   the task's phase moved at or after the mark (the handler did it, or anyone since)   nothing
 *   else   the same edge through applySessionPhase, the live path's own decision (the main agent,
 *          a retrier's hold, a wait to go back to, a routine's park), and only while the task's
 *          phase is still the one read (shouldApply)
 *
 * and removes it. Only host-judged rows have marks, nothing is said on the bus but what the phase
 * write itself says, and a second boot finds no mark: idempotent and cheap. A phase already reached
 * moves nothing, so no notice fires twice. The table lives in sessions.sqlite (session-db.ts
 * SCHEMA_SQL); an older leader never reads it.
 */
import type { Database as DatabaseType } from '../../lib/sqlite.js'
import { prepared } from '../../lib/sqlite-prepared.js'
import { getDb } from '../session-db.js'
import type { TurnEndEdge } from '../sessions/turn-end-edge.js'

/** One turn end of a batch: its session, the edge it says, its record's place in the host's log. */
export interface HostTurnEnd { sid: string; edge: TurnEndEdge; seq: number }

export interface TurnEndMark { sid: string; hostId: string; edge: TurnEndEdge; at: number }

/** Inside the channel's apply transaction: keep `sid`'s turn end (the newest one stands). */
export function noteTurnEndIn(handle: DatabaseType, hostId: string, sid: string, edge: TurnEndEdge, at: number): void {
  prepared(handle, 'INSERT OR REPLACE INTO session_turn_ends (claude_session_id, host_id, edge, at) VALUES (?, ?, ?, ?)').run(sid, hostId, edge, at)
}

/** Every mark, oldest first. */
export function turnEndMarks(): TurnEndMark[] {
  const handle = getDb()
  if (!handle) return []
  const rows = handle.prepare('SELECT claude_session_id AS sid, host_id AS hostId, edge, at FROM session_turn_ends ORDER BY at, claude_session_id').all() as TurnEndMark[]
  return rows.filter((r) => r.edge === 'session:result' || r.edge === 'session:error')
}

/** The mark `m` is done with: removed unless a newer turn end replaced it meanwhile. */
function clearMark(m: TurnEndMark): void {
  getDb()?.prepare('DELETE FROM session_turn_ends WHERE claude_session_id = ? AND at = ?').run(m.sid, m.at)
}

export interface ReconcileResult { looked: number; applied: string[] }

type Log = (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void

/** The boot pass (see the header). Never throws; one mark that fails never stops the others. */
export async function reconcileHostTurnEnds(o: { log?: Log } = {}): Promise<ReconcileResult> {
  const say: Log = o.log ?? (() => {})
  const marks = turnEndMarks()
  const applied: string[] = []
  if (marks.length === 0) return { looked: 0, applied }
  const [{ getSessionByClaudeId }, { getTask }, { applySessionPhase }, { judgedByHost }] = await Promise.all([
    import('../session-tracker.js'), import('../task-manager.js'), import('../phase.js'), import('../sessions/session-row-owner.js'),
  ])
  for (const m of marks) {
    try {
      const row = await getSessionByClaudeId(m.sid).catch(() => null)
      if (!row || row.host !== m.hostId || !judgedByHost(row) || !row.taskId || row.process_status === 'running') continue
      const task = await getTask(row.taskId).catch(() => null)
      if (!task) continue
      const movedAt = task.phase_changed_at ? Date.parse(task.phase_changed_at) : NaN
      if (Number.isFinite(movedAt) && movedAt >= m.at) continue
      const seen = task.phase_changed_at
      const r = await applySessionPhase(task.id, m.edge, 'host-channel:boot-reconcile', {
        sessionId: m.sid,
        ...(row.process_status === 'stopped' || row.process_status === 'error' ? { processAlive: false } : {}),
        shouldApply: (current) => current.phase_changed_at === seen,
      })
      if (r.changed) applied.push(m.sid)
    } catch (err) {
      say('warn', 'session channel: a turn end the leader may have missed was not reconciled', { sessionId: m.sid, host: m.hostId, error: err instanceof Error ? err.message : String(err) })
    } finally {
      try { clearMark(m) } catch { /* the next boot looks again */ }
    }
  }
  if (applied.length > 0) say('info', 'session channel: task phases a lost turn end left behind were set from the host\'s rows', { count: applied.length, sessionIds: applied.slice(0, 20) })
  return { looked: marks.length, applied }
}
