/**
 * Whether a session's header offers the Board tab (2026-10-26, the user: "for
 * non leader, please don't show board, confused people"; 2026-11-19: "why show
 * board when its only one guy, only show if it is leader").
 *
 * Only a task that leads now gets the tab: one with open subtasks. A Board the
 * task kept from a team whose work all finished does not count; every other
 * task, a worker included, gets no tab (a worker still writes its team's Board
 * with the board_* operations). The iOS twin is TeamStatusBoard.isLeading.
 *
 * Facts, in order of freshness: the task store (open subtasks, live over the
 * WS), then, for a page that has no task store, the server's answer for the
 * task (GET /tasks/:id/board/owner?tab=1: `open_subtasks`).
 */

export type BoardTabState = 'shown' | 'hidden' | 'unknown';

export interface BoardOwnerFacts {
  /** Still sent by the server for older pages; it no longer decides the tab. */
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
  // The store is the live source; the answer's count only stands in when there is none.
  if (storeOpenSubtasks != null) return storeOpenSubtasks > 0 ? 'shown' : 'hidden';
  if (!owner) return 'unknown';
  return (owner.open_subtasks ?? 0) > 0 ? 'shown' : 'hidden';
}
