/**
 * Which view of a Board the pane shows:
 *
 *   projects  the board's projects, one card each (BoardOverview.tsx); offered
 *             only when the leader defined projects (board_project_set)
 *   cards     the team's kanban (kanban/BoardKanban.tsx)
 *   custom    Page, the page the leader wrote
 *
 * With no pick (or a pick the board cannot show), the default is Projects when
 * the board has projects, else Cards. The last pick is remembered per board
 * OWNER in this browser (a worker and its leader share one board, so they share
 * the pick too); a pick the board cannot show right now is kept, so it comes
 * back once the page or the projects exist. The stored 'overview' of before the
 * kanban named the project board, so it reads as Projects.
 * Pure helpers; unit-pinned in tests/web/board-view-pref.test.ts.
 */

export type BoardView = 'projects' | 'cards' | 'custom';

/** Per owner, local to this browser (not a synced ui-pref: the key has no synced prefix). */
export const BOARD_VIEW_PREFIX = 'walnut:board-view.v1:';

export function parseBoardView(raw: string | null | undefined): BoardView | null {
  if (raw === 'overview') return 'projects';
  return raw === 'projects' || raw === 'cards' || raw === 'custom' ? raw : null;
}

/** The view the board shows when nothing (or nothing it can show) is picked. */
export function defaultBoardView(hasProjects: boolean): BoardView {
  return hasProjects ? 'projects' : 'cards';
}

/** The view on screen: the pick when the board can show it, else the default. */
export function shownBoardView(picked: BoardView | null, hasPage: boolean, hasProjects: boolean): BoardView {
  if (picked === 'custom' && hasPage) return 'custom';
  if (picked === 'projects' && hasProjects) return 'projects';
  if (picked === 'cards') return 'cards';
  return defaultBoardView(hasProjects);
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
