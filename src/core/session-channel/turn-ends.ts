/**
 * A host's turn end the leader may not have acted on (the plan's M3, boot reconcile): the channel
 * applies a batch of a host's records in one transaction and only then says its facts on the bus,
 * where the turn-end handlers move the task's phase (web/server.ts, applySessionPhase). A leader that
 * stops after the commit and before those handlers wrote the phase (a crash, a deploy's restart while
 * the handler waits on its git pull) loses that edge: the host's records are applied, so they never
 * come again, and the task stays In Progress with its session idle.
 *
 * So the same transaction keeps a mark per session of its last turn end that moves a phase
 * (turn-end-edge.ts: the edge, and the leader's time of the commit), and the leader's turn-end
 * handler removes it once it returned, whatever it decided (held for a retrier, a quiet turn, the
 * main agent, applied: clearingTurnEndMarks), so a mark that stands means only "the handler never
 * ran to its end".
 * A newer turn end of the same session in a later batch replaces its mark, or removes it when it
 * moves no phase (a retrier took it). After the leader's boot, once a host's link has applied what
 * that host's log held at its hello (channel.ts onCaughtUp: the host's rows here are current, so a
 * turn the host ran while this leader was down reads as it is), `reconcileHostTurnEnds` looks at each
 * of that host's marks made before this process started, and at each later catch-up at the marks
 * standing well past the wait for a stand-down's turn end said again (leader-boot.ts; a marked end a
 * host never said again, which leader-apply.ts said at its deadline unless the leader stopped first):
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
 *
 * It replays the phase only. The live session:error path also clears the task's session slot and
 * raises the error card; a lost error edge set here leaves the slot pointing at the failed session
 * and no card (the session's own page still shows its error, and the next start takes the slot).
 */
import type { Database as DatabaseType } from '../../lib/sqlite.js'
import { prepared } from '../../lib/sqlite-prepared.js'
import { getDb } from '../session-db.js'
import type { TurnEndEdge } from '../sessions/turn-end-edge.js'

/**
 * One turn end of a batch: its session, the edge it says (null: it moves no phase, a retrier took it
 * or the work goes on, so it only supersedes an older mark), its record's place in the host's log.
 */
export interface HostTurnEnd { sid: string; edge: TurnEndEdge | null; seq: number }

export interface TurnEndMark { sid: string; hostId: string; edge: TurnEndEdge; at: number }

/** The last mark's `at` this process wrote: each new one is later, so a mark is named by its `at` alone. */
let lastMarkAt = 0

/**
 * Inside the channel's apply transaction: keep `sid`'s turn end (the newest one stands; one with no
 * edge only removes the older). Its `at` is the commit's time, made later than every mark before it
 * here, so a handler's clear (by the exact `at` it saw) never takes a newer mark of the same millisecond.
 */
export function noteTurnEndIn(handle: DatabaseType, hostId: string, sid: string, edge: TurnEndEdge | null, at: number): void {
  if (edge === null) { prepared(handle, 'DELETE FROM session_turn_ends WHERE claude_session_id = ?').run(sid); return }
  const unique = Math.max(at, lastMarkAt + 1)
  lastMarkAt = unique
  prepared(handle, 'INSERT OR REPLACE INTO session_turn_ends (claude_session_id, host_id, edge, at) VALUES (?, ?, ?, ?)').run(sid, hostId, edge, unique)
}

/** Every mark (or `hostId`'s, made before `before`), oldest first. */
export function turnEndMarks(o: { hostId?: string; before?: number } = {}): TurnEndMark[] {
  const handle = getDb()
  if (!handle) return []
  const rows = handle.prepare('SELECT claude_session_id AS sid, host_id AS hostId, edge, at FROM session_turn_ends ORDER BY at, claude_session_id').all() as TurnEndMark[]
  return rows.filter((r) => (r.edge === 'session:result' || r.edge === 'session:error')
    && (o.hostId === undefined || r.hostId === o.hostId) && (o.before === undefined || r.at < o.before))
}

/** `sid`'s mark now: its `at`, or null when it has none. */
export function turnEndMarkAt(sid: string): number | null {
  const row = getDb()?.prepare('SELECT at FROM session_turn_ends WHERE claude_session_id = ?').get(sid) as { at?: number } | undefined
  return typeof row?.at === 'number' ? row.at : null
}

/** The leader's handler of `sid`'s turn end ran: the mark it began with (its exact `at`) goes, never a newer one. */
export function clearTurnEndMark(sid: string, at: number): void {
  getDb()?.prepare('DELETE FROM session_turn_ends WHERE claude_session_id = ? AND at = ?').run(sid, at)
}

/**
 * The leader's turn-end handler (web/server.ts), wrapped: after it returned for a host's
 * session:result or session:error, whatever it decided, the mark the session had when it began goes
 * (the mark was committed before the fact was said, so before the handler began; a newer turn end's
 * mark, always later, stays). A handler that threw may not have written the phase: its mark stays,
 * and the next boot looks at it. Every other event goes straight to the handler.
 */
export function clearingTurnEndMarks<E extends { name: string; data: unknown; source?: string }>(handler: (event: E) => Promise<void> | void): (event: E) => Promise<void> | void {
  return (event: E) => {
    if ((event.name !== 'session:result' && event.name !== 'session:error') || event.source !== 'host-channel') return handler(event)
    const sid = (event.data as { sessionId?: unknown } | null)?.sessionId
    let markAt: number | null = null
    if (typeof sid === 'string' && sid) { try { markAt = turnEndMarkAt(sid) } catch { /* no mark known: nothing to clear */ } }
    return (async () => {
      await handler(event)
      if (markAt !== null) { try { clearTurnEndMark(sid as string, markAt) } catch { /* the boot looks at it again */ } }
    })()
  }
}

/** The mark `m` is done with: removed unless a newer turn end replaced it meanwhile. */
function clearMark(m: TurnEndMark): void {
  getDb()?.prepare('DELETE FROM session_turn_ends WHERE claude_session_id = ? AND at = ?').run(m.sid, m.at)
}

export interface ReconcileResult { looked: number; applied: string[] }

type Log = (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void

/**
 * The boot pass (see the header), for `hostId`'s marks made before `before` (this process's start)
 * when named. Never throws; one mark that fails never stops the others.
 */
export async function reconcileHostTurnEnds(o: { log?: Log; hostId?: string; before?: number } = {}): Promise<ReconcileResult> {
  const say: Log = o.log ?? (() => {})
  const marks = turnEndMarks({ ...(o.hostId !== undefined ? { hostId: o.hostId } : {}), ...(o.before !== undefined ? { before: o.before } : {}) })
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
