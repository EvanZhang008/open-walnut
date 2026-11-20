/**
 * Where a vault-relative note path lives now. The single hook for notes that move to new
 * places: every way a caller-given note path becomes a file (note-paths.ts) asks here first,
 * so an old relative path keeps working once an old -> new map exists.
 *
 * Contract: the answer is the FINAL place (a chain of moves is followed to its end), so
 * asking twice changes nothing: movedNotePath(movedNotePath(p)) === movedNotePath(p).
 *
 * The map is the one tree's (src/core/artifacts/unify/): set at boot once the notes live in
 * it, absent before. A path already in the tree's terms (its first folder is one of the tree's
 * own: projects/, notes/, skills/, memory/, drawings/) is its own place; an old one maps through
 * the record's exact entries, then its folder rules. An old folder named like one of the tree's
 * own got an exact entry for each of its files when the move ran (layout.ts planVault).
 */
import { movedPath, type MoveMap } from '../artifacts/unify/map.js'

let moves: MoveMap | null = null
let before: Map<string, string> | null = null

/**
 * The tree's map, set at boot (null: the notes are where they always were), and the vault files
 * the move made ([path before, path now]), for the way back to a file's old path.
 */
export function setNoteMoves(map: MoveMap | null, pairs?: ReadonlyArray<readonly [string, string]>): void {
  moves = map
  before = map && pairs ? new Map(pairs.map(([was, now]) => [now.toLowerCase(), was])) : null
}

/**
 * Where a file of the tree was before the move (itself when it was made since, or with no tree).
 * A choice among same-named files (an embed's picture) is made in these terms, so the move never
 * changes which one a note shows.
 */
export const notePathBefore = (rel: string): string => before?.get(rel.replace(/^\/+/, '').toLowerCase()) ?? rel

/** The map this process runs on, for a client that resolves links itself (the notes list). */
export const noteMoves = (): MoveMap | null => moves

export const movedNotePath = (rel: string): string => movedPath(rel, moves)
