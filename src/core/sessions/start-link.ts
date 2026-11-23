/**
 * A started session's link to its task (the task's session slots and history), once its id is
 * known: the native start's and the ACP start's, in one place.
 *
 * Only the server that owns the task links: the leader. A host that runs its own sessions never
 * writes a task: its session port's loadStartLink answers links that do nothing (host-port.ts), and
 * the leader links the session from its born row (session-channel/leader-tasks.ts). The host used to answer each link with the task from its
 * copy, and a start right after its task was made, before the copy had the task, logged "failed to
 * link session to task" there (2026-11-23), the line the cluster test reads as a host task write.
 */
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../event-bus.js'
import type { SessionMode } from '../types.js'
import type { SessionPort } from './session-port.js'

/** The native start's link: slot by mode, then the task's session; an archived session only joins the history. */
export async function linkStartedSession(port: SessionPort, taskId: string, sessionId: string, mode: SessionMode | string | undefined): Promise<void> {
  try {
    // Archived guard: do NOT write task session slots for archived sessions. A start is also the
    // resume entry point; re-linking an archived session would point every UI entry at it instead
    // of the live one. The record exists here: the start persists it before sessionReady resolves.
    const { getSessionByClaudeId } = await port.records.loadTracker()
    const { addSessionToHistory, linkSessionSlot, linkSession } = await port.tasks.loadTaskManager()
    const record = await getSessionByClaudeId(sessionId)
    if (record?.archived) {
      await addSessionToHistory(taskId, sessionId).catch((err) => {
        log.session.debug('failed to add archived session to history', { taskId, sessionId, error: err instanceof Error ? err.message : String(err) })
      })
      log.session.warn('skipping task slot link for archived session', { taskId, sessionId, archiveReason: record.archive_reason })
      return
    }
    await linkSessionSlot(taskId, sessionId, mode === 'plan' ? 'plan' : 'exec')
    // The task linkSession answers has session_id set, so the browser's state gets it populated.
    const { task } = await linkSession(taskId, sessionId)
    bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-link' })
  } catch (err) {
    log.session.warn('failed to link session to task', { taskId, error: err instanceof Error ? err.message : String(err) })
  }
}

/** The ACP start's (and re-attach's) link: only what differs from the task as it is; throws for its caller to log. */
export async function linkAcpStartedSession(port: SessionPort, taskId: string | undefined, sessionId: string, mode: SessionMode | undefined): Promise<void> {
  if (!taskId) return
  const { addSessionToHistory, getTask, linkSession, linkSessionSlot } = await port.tasks.loadTaskManager()
  const slot: 'plan' | 'exec' = mode === 'plan' ? 'plan' : 'exec'
  let task = await getTask(taskId)
  let changed = false
  const slotValue = slot === 'plan' ? task.plan_session_id : task.exec_session_id
  if (slotValue !== sessionId) {
    task = (await linkSessionSlot(taskId, sessionId, slot)).task
    changed = true
  } else if (!task.session_ids?.includes(sessionId)) {
    task = (await addSessionToHistory(taskId, sessionId)).task
    changed = true
  }
  if (task.session_id !== sessionId) {
    task = (await linkSession(taskId, sessionId)).task
    changed = true
  }
  if (changed) bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-link' })
}
