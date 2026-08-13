/**
 * Column-id predicates for the home session strip.
 *
 * A session column is keyed either by a REAL provider session id or by a
 * client-only PLACEHOLDER id from one of two families:
 *   - `pending:<…>` — a launch is in flight (quick-start / fork); the column is
 *     swapped for the real session id once the server answers.
 *   - `draft:<ts>-<seq>` — an empty column the user just opened with "+". Purely
 *     client-side (backend 0 bytes) until the first send, at which point it
 *     morphs into `pending:` and then into the real id.
 *
 * Lives in utils/ (a leaf with no imports) on purpose: `api/`, `stores/` and
 * `hooks/` all need these predicates and must not import from `pages/`.
 */

export const DRAFT_COL_PREFIX = 'draft:';
export const PENDING_COL_PREFIX = 'pending:';

/** An unsent, client-only column opened by "+". */
export function isDraftColumnId(id: string): boolean {
  return id.startsWith(DRAFT_COL_PREFIX);
}

/** A launch-in-flight column awaiting its real session id. */
export function isPendingColumnId(id: string): boolean {
  return id.startsWith(PENDING_COL_PREFIX);
}

/**
 * Either placeholder family — i.e. "this id is NOT a real session id".
 * Use for every "don't persist / don't fetch / don't hydrate this" guard so
 * both families stay in step; a `draft:` id resolves to nothing server-side
 * exactly like a `pending:` one.
 */
export function isPlaceholderColumnId(id: string): boolean {
  return isDraftColumnId(id) || isPendingColumnId(id);
}
