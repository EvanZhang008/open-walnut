/**
 * The view on screen for an owner's Board (Projects, Cards or Page) and the
 * pick that changes and remembers it (board-view-pref.ts).
 */
import { useCallback, useState } from 'react';
import { log } from '@/utils/log';
import { readBoardView, shownBoardView, writeBoardView, type BoardView } from './board-view-pref';

/** `window.localStorage`, or null where reading it throws (a sandboxed or private context). */
function viewStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

export function useBoardView(
  ownerId: string, hasPage: boolean, hasProjects: boolean,
): { view: BoardView; picked: BoardView | null; pick: (v: BoardView) => void } {
  const [state, setState] = useState<{ owner: string; view: BoardView | null }>(() => ({
    owner: ownerId, view: readBoardView(viewStorage(), ownerId),
  }));
  // Another owner's pick is not this one's: read it in the same render the owner changes.
  const picked = state.owner === ownerId ? state.view : readBoardView(viewStorage(), ownerId);
  const pick = useCallback((view: BoardView) => {
    writeBoardView(viewStorage(), ownerId, view);
    setState({ owner: ownerId, view });
    log.info('board', 'board view picked', { taskId: ownerId, view });
  }, [ownerId]);
  return { view: shownBoardView(picked, hasPage, hasProjects), picked, pick };
}
