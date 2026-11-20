/**
 * Where a vault-relative note path lives now. The single hook for notes that move to new
 * places: every way a caller-given note path becomes a file (note-paths.ts) asks here first,
 * so an old relative path keeps working once an old -> new map exists.
 *
 * Contract: the answer is the FINAL place (a chain of moves is followed to its end), so
 * asking twice changes nothing: movedNotePath(movedNotePath(p)) === movedNotePath(p).
 *
 * Its own module so a test can replace it and prove every resolver follows a move.
 * Today no note has moved: every path is its own place.
 */
export function movedNotePath(rel: string): string {
  return rel
}
