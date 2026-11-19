/**
 * How a task names its session once a start links it, in ONE place: the Mac's own link
 * (task-manager.ts linkSessionSlot / linkSession, which the start and the drain's adoption
 * call: offline-merge/apply-session.ts linkAdopted) and a host replica's reader fold of a
 * session it started alone while the Mac is away (offline-merge/task-row-fold.ts
 * foldAwayStart), so the follower shows the fields the Mac will write.
 *
 * One session per task (sessions/one-session-per-task.ts): every task-side field names the
 * same session. The legacy plan/exec slots stay as mirrors of it for readers that still look
 * there (the frozen API, the phone).
 */

/** The task fields a link writes (a subset of Task, so a plain row takes it too). */
export interface SessionLinkFields {
  session_id?: string
  session_ids?: string[]
  plan_session_id?: string
  exec_session_id?: string
}

/** Point every task-side field at `sessionId`; with a slot, that slot names it too. Mutates `task`. */
export function pointTaskAtSession(task: SessionLinkFields, sessionId: string, slot?: 'plan' | 'exec'): void {
  task.session_id = sessionId
  task.session_ids = [sessionId]
  if (task.plan_session_id && task.plan_session_id !== sessionId) task.plan_session_id = undefined
  if (task.exec_session_id && task.exec_session_id !== sessionId) task.exec_session_id = undefined
  if (slot === 'plan') task.plan_session_id = sessionId
  else if (slot === 'exec') task.exec_session_id = sessionId
}

/** The slot a session takes by its mode, as the Mac links a start and an adoption. */
export function slotOfMode(mode: unknown): 'plan' | 'exec' {
  return mode === 'plan' ? 'plan' : 'exec'
}
