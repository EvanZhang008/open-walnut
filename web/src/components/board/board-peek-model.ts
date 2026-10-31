/**
 * What the right column shows for a task chip clicked on a Board
 * (BoardTaskPeek.tsx): the panel's own chat, the task's session, or a card
 * for a task with no session (or one this page's task list does not have).
 *
 * "Own" is the SESSION PANEL's task, not the board's: a worker's Board tab shows
 * its leader's board, and there the leader's chip opens the leader in the peek
 * while the worker's own chip goes back to the worker's chat.
 * Pure: unit-pinned in tests/web/board-peek-model.test.ts.
 */
import type { Task } from '@open-walnut/core';
import { resolveTaskSessionId } from '@/utils/session-status';
import { USER_STATE_LABELS, type UserState } from '@open-walnut/user-status';

export type BoardPeekView =
  | { kind: 'own' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'card'; known: boolean };

export function boardPeekView(targetTaskId: string, ownTaskId: string | undefined, task: Task | null): BoardPeekView {
  if (ownTaskId && targetTaskId === ownTaskId) return { kind: 'own' };
  if (!task) return { kind: 'card', known: false };
  const sessionId = resolveTaskSessionId(task);
  return sessionId ? { kind: 'session', sessionId } : { kind: 'card', known: true };
}

/** The words the Board's own chips use (board-elements.frame.js USER): the one user status
 *  (src/core/user-status.ts), the phase worded the same way for a task not derived yet. */
/** The phase as the frame's chips read it for a task not derived yet (board-elements.frame.js PHASE_USER). */
export const BOARD_PHASE_USER: Record<string, UserState> = {
  TODO: 'waiting', IN_PROGRESS: 'working', NEED_ACTION: 'needs', WAITING: 'waiting', COMPLETE: 'done',
};

export function boardPhaseLabel(task: Pick<Task, 'phase' | 'status' | 'user_status'> | null | undefined): string {
  if (!task) return '';
  if (task.phase === 'COMPLETE' || task.status === 'done') return USER_STATE_LABELS.done;
  if (task.user_status) return USER_STATE_LABELS[task.user_status.state];
  const fallback = task.phase ? BOARD_PHASE_USER[task.phase] : undefined;
  return fallback ? USER_STATE_LABELS[fallback] : (task.phase ?? '');
}

export const PEEK_EXCERPT_CHARS = 280;

/** The card's text: the summary, else the start of the description, as one plain line. */
export function boardPeekExcerpt(task: Pick<Task, 'summary' | 'description'> | null, max = PEEK_EXCERPT_CHARS): string {
  const source = (task?.summary || '').trim() || (task?.description || '').trim();
  const flat = source.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
