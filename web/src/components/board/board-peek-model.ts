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

/** The words the Board's own chips use (board-elements.frame.js PHASES): the
 *  header names the phase as the chip just clicked did. */
export const BOARD_PHASE_LABELS: Record<string, string> = {
  TODO: 'To do', IN_PROGRESS: 'In progress', NEED_ACTION: 'Needs you', WAITING: 'Waiting', COMPLETE: 'Done',
};

export function boardPhaseLabel(phase: string | undefined): string {
  return phase ? (BOARD_PHASE_LABELS[phase] ?? phase) : '';
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
