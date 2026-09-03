/**
 * Promote a side thread into a real, visible session.
 *
 * A side thread is a taskless hidden fork; promotion is the one transition that
 * makes it ordinary — create the task, point the record at it, and DROP the lane.
 * Losing the lane is what un-hides it: `isListableSession` keys off `lane`, and so
 * do the leak guards (session_list, send targets, frequent dirs, keep-awake, hook
 * dispatch), so a promoted session re-enters all of them for free.
 *
 * The task it creates is exactly what session Fork creates, because a side thread
 * IS a fork: a SIBLING of the parent session's task, grouped with it in the parent
 * task's folder (reusing that folder when it has one). Never a subtask: the two
 * have independent lifecycles, and the shared shape lives in
 * session-controls.createForkSiblingTask.
 *
 * No spawn happens here. The fork's CLI either still runs or cold-`--resume`s on
 * the next send, exactly as any other session does.
 */

import { bus, EventNames } from '../event-bus.js';
import { SessionControlError, createForkSiblingTask } from './session-controls.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';

export interface PromoteSideThreadResult {
  taskId: string;
  /** The parent session's task the new task was filed NEXT TO (fork semantics).
   *  Absent when the parent had no task: then it is a top-level Inbox task. */
  siblingOfTaskId?: string;
  /** Folder holding both tasks (reused or freshly created). Absent when the
   *  grouping call failed or there was no sibling to group with. */
  groupId?: string;
  sessionId: string;
}

export async function promoteSideThread(
  parentSid: string,
  threadId: string,
  opts?: { title?: string },
): Promise<PromoteSideThreadResult> {
  const { getSideQuestion, markThreadPromoted } = await import('../side-questions.js');
  const entry = await getSideQuestion(parentSid, threadId);
  if (!entry?.threadSessionId) throw new SessionControlError('Side thread not found', 404);
  // A second promote would mint a second task and re-point the record at it,
  // orphaning the first — refuse instead (double-click, stale client).
  if (entry.promotedTaskId) {
    throw new SessionControlError('Side thread already promoted', 409, { code: 'already_promoted' });
  }
  const sessionId = entry.threadSessionId;

  const { getSessionByClaudeId, updateSessionRecord, emitSessionStatusChanged } =
    await import('../session-tracker.js');
  const threadRecord = await getSessionByClaudeId(sessionId);
  if (!threadRecord) throw new SessionControlError('Side thread session not found', 404);

  // A thread on a session that is working a task becomes a SIBLING of that task,
  // grouped with it (identical to session Fork); an ad-hoc session's thread has
  // nothing to be a sibling of, so it becomes a top-level Inbox task.
  const parentRecord = await getSessionByClaudeId(parentSid);
  const siblingOfTaskId = parentRecord?.taskId?.trim() || undefined;
  const threadLabel = opts?.title?.trim() || entry.title?.trim() || undefined;

  const { addTask, linkSession, linkSessionSlot } = await import('../task-manager.js');
  let groupId: string | undefined;
  let task: Task;
  if (siblingOfTaskId) {
    const created = await createForkSiblingTask(siblingOfTaskId, {
      // A known label short-circuits the background refine; without one the
      // thread's first question is what gets summarized (same as a fork's message).
      titlePrefix: threadLabel,
      prompt: entry.question,
      description: entry.question,
      source: 'side-thread-promote',
    });
    task = created.task;
    groupId = created.groupId;
  } else {
    ({ task } = await addTask({
      title: threadLabel || entry.question,
      description: entry.question,
      // A person clicked "promote" — same board default as any hand-made task.
      pinned: true,
    }));
  }

  // Stamp BEFORE the record update: the 409 guard above keys off this stamp, so
  // a partial failure below must leave the guard armed — a retry after a failed
  // record write would otherwise mint a SECOND task (the exact outcome the 409
  // refuses). A stamped-but-hidden thread is recoverable; a duplicate task is not.
  const stamped = await markThreadPromoted(parentSid, threadId, task.id);
  if (!stamped) {
    log.session.warn('side thread promote: entry vanished before stamp — promote proceeds, 409 guard is unarmed', {
      parentSid, threadId, taskId: task.id,
    });
  }

  const updated = await updateSessionRecord(sessionId, {
    taskId: task.id,
    project: task.project ?? '',
    // Clearing the lane un-hides the session (see the file header).
    lane: undefined,
    title: task.title,
  });
  // Sync the LIVE instance: the runner echoes its in-memory lane on every turn
  // result, so without this a still-running thread re-hides itself the moment
  // its next answer lands.
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js');
    sessionRunner.syncLane(sessionId, undefined);
  } catch { /* runner unavailable (tests) — the record write above still holds */ }
  // The session was invisible until this write, so nothing else would tell the
  // UI it now exists.
  emitSessionStatusChanged(updated, {}, ['*']);

  // Same two-step link the runner performs when a fork's session starts: the slot
  // drives the task's session badge, `linkSession` fills session_ids.
  try {
    await linkSessionSlot(task.id, sessionId, 'exec');
    const { task: linked } = await linkSession(task.id, sessionId);
    bus.emit(EventNames.TASK_UPDATED, { task: linked }, ['web-ui'], { source: 'side-thread-promote' });
  } catch (err) {
    log.session.warn('side thread promote: task link failed', {
      taskId: task.id, sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }

  log.session.info('side thread: promoted to task', {
    parentSid, threadId, sessionId, taskId: task.id, siblingOfTaskId, groupId,
  });

  return {
    taskId: task.id,
    ...(siblingOfTaskId ? { siblingOfTaskId } : {}),
    ...(groupId ? { groupId } : {}),
    sessionId,
  };
}
