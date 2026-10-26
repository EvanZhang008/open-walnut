/**
 * Which view of a Board the pane shows:
 *
 *   status    every task of the team by the one user status (BoardStatusView.tsx),
 *             the default (2026-10-25)
 *   cards     the team's kanban (kanban/BoardKanban.tsx)
 *   custom    Page, the page the leader wrote
 *
 * With no pick (or a pick the board cannot show), the default is Status. The last
 * pick is remembered per board OWNER in this browser (a worker and its leader share
 * one board, so they share the pick too); a Page pick on a board with no page is
 * kept, so it comes back once the page exists. The retired Projects view (and the
 * 'overview' of before it) reads as Status.
 * Pure helpers; unit-pinned in tests/web/board-view-pref.test.ts.
 */

export type BoardView = 'status' | 'cards' | 'custom';

/** Per owner, local to this browser (not a synced ui-pref: the key has no synced prefix). */
export const BOARD_VIEW_PREFIX = 'walnut:board-view.v1:';

export function parseBoardView(raw: string | null | undefined): BoardView | null {
  if (raw === 'overview' || raw === 'projects') return 'status';
  return raw === 'status' || raw === 'cards' || raw === 'custom' ? raw : null;
}

/** The view the board shows when nothing (or nothing it can show) is picked. */
export const DEFAULT_BOARD_VIEW: BoardView = 'status';

/** The view on screen: the pick when the board can show it, else the default. */
export function shownBoardView(picked: BoardView | null, hasPage: boolean): BoardView {
  if (picked === 'custom' && hasPage) return 'custom';
  if (picked === 'cards') return 'cards';
  return DEFAULT_BOARD_VIEW;
}

type ReadStore = Pick<Storage, 'getItem'>;
type WriteStore = Pick<Storage, 'setItem'>;

export function readBoardView(storage: ReadStore | null | undefined, ownerId: string): BoardView | null {
  if (!storage || !ownerId) return null;
  try { return parseBoardView(storage.getItem(BOARD_VIEW_PREFIX + ownerId)); } catch { return null; }
}

export function writeBoardView(storage: WriteStore | null | undefined, ownerId: string, view: BoardView): void {
  if (!storage || !ownerId) return;
  try { storage.setItem(BOARD_VIEW_PREFIX + ownerId, view); } catch { /* storage full or blocked: the pick lasts this session */ }
}
