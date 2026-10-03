/**
 * Which view of a Board the pane shows: Walnut's Overview of the team (the
 * default) or the Custom page the leader wrote. The last pick is remembered per
 * board OWNER in this browser (a worker and its leader share one board, so they
 * share the pick too). Custom shows only while there is a page to show; the
 * pick itself is kept, so the page comes back once the leader writes one.
 * Pure helpers; unit-pinned in tests/web/board-overview-model.test.ts.
 */

export type BoardView = 'overview' | 'custom';

/** Per owner, local to this browser (not a synced ui-pref: the key has no synced prefix). */
export const BOARD_VIEW_PREFIX = 'walnut:board-view.v1:';

export function parseBoardView(raw: string | null | undefined): BoardView | null {
  return raw === 'overview' || raw === 'custom' ? raw : null;
}

/** The view on screen: Custom only when the user picked it and a page exists. */
export function shownBoardView(picked: BoardView | null, hasPage: boolean): BoardView {
  return hasPage && picked === 'custom' ? 'custom' : 'overview';
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
