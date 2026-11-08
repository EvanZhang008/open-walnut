/**
 * Which task panel regions (Pinned, its tiers, Recent, the Tasks list) a first visit folds.
 * 2026-11-06, the user: on a first open everything is folded so nobody is overloaded. That is
 * for a board that already holds work: on an empty one (a new install) there is nothing to
 * overload, and folding Pinned hid the first task the person made (2026-11-08: Start Task on
 * a fresh install filed it under a folded Pinned, and the panel showed nothing). So the fold
 * is decided once the first load is in: work on the board folds every region, an empty
 * board folds none (Parked, once folded there, is retired: its tasks draw in Satellite).
 * Either way the choice is stored then, so it is the first visit only once and the person's
 * chevron clicks win after it.
 */

/** The regions folded while the first load is still on its way, so a board with work never flashes open. */
export function firstVisitFoldAll(customTierIds: readonly string[]): Set<string> {
  return new Set(['pinned', 'focus', 'satellite', 'tasks', 'recent', ...customTierIds]);
}

/** The first visit's folds, once the board's first load is in. */
export function firstVisitFolds(boardTaskCount: number, customTierIds: readonly string[]): Set<string> {
  return boardTaskCount > 0 ? firstVisitFoldAll(customTierIds) : new Set();
}
