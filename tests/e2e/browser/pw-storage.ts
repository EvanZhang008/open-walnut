/**
 * The storage every page of a Playwright config starts with.
 *
 * A first visit folds every region of a board that holds work (web/src/components/tasks/
 * first-visit-folds.ts) and every status section (section-fold-rule.ts). The fixture boards
 * always hold work, so a page starts as a returning visitor with the folds a first visit kept
 * before: only Parked folded, Watching and Needs you open. A spec about the first visit removes
 * these keys (todo-panel-helpers.ts isolateUiPrefs `newInstall`). Every config whose specs
 * read the task panel uses this one list, so a new fold rule lands in all of them at once.
 */
export interface StoredItem { name: string; value: string }

export const RETURNING_VISITOR_FOLDS: readonly StoredItem[] = [
  { name: 'walnut-todo-collapsed-sections', value: '["wait"]' },
  { name: 'walnut-todo-status-sections', value: '{}' },
]

/** A config's `use.storageState` for `origin`: the returning visitor's folds, plus `extra`. */
export function returningVisitorStorage(origin: string, extra: readonly StoredItem[] = []) {
  return { cookies: [], origins: [{ origin, localStorage: [...extra, ...RETURNING_VISITOR_FOLDS] }] }
}
