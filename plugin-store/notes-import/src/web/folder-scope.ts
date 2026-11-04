/** What an import folder follows: everything, or the top-level pages its runs were made from. */
import type { PublicState } from './store'

export type FolderScope = { all: true } | { all: false; rootIds: string[] }

/**
 * Every finished run into `folder` counts: one run of everything makes the folder follow
 * everything; otherwise it follows every page any run took. Null: nothing imported there yet.
 */
export function folderScope(history: PublicState['history'], folder: string): FolderScope | null {
  const runs = history.filter((run) => run.folder === folder && run.phase === 'done')
  if (!runs.length) return null
  if (runs.some((run) => !run.rootIds?.length)) return { all: true }
  return { all: false, rootIds: [...new Set(runs.flatMap((run) => run.rootIds ?? []))] }
}

/** The ids to send for a scope: none means everything. */
export function scopeIds(scope: FolderScope | null): string[] {
  return scope && !scope.all ? scope.rootIds : []
}
