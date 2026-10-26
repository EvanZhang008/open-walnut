/**
 * Whether a session's header offers the Board tab (2026-10-26, the user: "for
 * non leader, please don't show board, confused people").
 *
 * Only a task that leads keeps a Board worth opening: one with open subtasks,
 * or one that already has a Board of its own with something in it (a lead whose
 * subtasks have all finished). Every other task, a worker included, gets no tab;
 * a worker still writes its team's Board with the board_* operations.
 *
 * Facts, in order of freshness: the task store (open subtasks, live over the
 * WS), then the server's answer for the task (GET /tasks/:id/board/owner: `own_board`,
 * and `open_subtasks` for a page that has no task store).
 */

export type BoardTabState = 'shown' | 'hidden' | 'unknown';

export interface BoardOwnerFacts {
  own_board?: boolean;
  open_subtasks?: number;
}

export function boardTabState(input: {
  taskId: string | null | undefined;
  /** Open subtasks in this page's task store; null when the page has no store. */
  storeOpenSubtasks: number | null;
  /** The server's answer for the task; undefined while it is on its way. */
  owner: BoardOwnerFacts | undefined;
}): BoardTabState {
  const { taskId, storeOpenSubtasks, owner } = input;
  if (!taskId) return 'hidden';
  if (storeOpenSubtasks != null && storeOpenSubtasks > 0) return 'shown';
  if (!owner) return 'unknown';
  if (owner.own_board) return 'shown';
  // The store is the live source; the answer's count only stands in when there is none.
  if (storeOpenSubtasks == null && (owner.open_subtasks ?? 0) > 0) return 'shown';
  return 'hidden';
}
