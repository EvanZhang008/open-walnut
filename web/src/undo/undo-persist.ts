/**
 * The Undos still on screen when the page goes (a reload inside the 5 second window) come back
 * with it, for the time they had left when it went: the reload itself does not use up the
 * window (a slow start would leave nothing to press). A page gone longer than RETURN_WITHIN_MS
 * brings nothing back. Each entry that can be rebuilt from data names a `kind`
 * and its data; the page that comes back hands them to the reviver of that kind
 * (TaskUndoContext.tsx). A held delete is among them: the server holds it meanwhile.
 *
 * sessionStorage, so only this tab's own reload sees them. Pure apart from the storage passed in.
 */
export const UNDO_PERSIST_NAME = 'walnut-undo-pending-v1';
export const RETURN_WITHIN_MS = 30_000;

export interface PersistedUndo {
  kind: string;
  data: unknown;
  key: string;
  title: string;
  body?: string;
  /** What was left of its window when the page went (ms). */
  leftMs: number;
  /** When the page went (epoch ms). */
  savedAt: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** False when they could not be kept (no storage, or it is full): the Undos end with the page. */
export function saveUndos(store: Store | undefined, list: PersistedUndo[]): boolean {
  if (!store) return false;
  try {
    if (list.length) store.setItem(UNDO_PERSIST_NAME, JSON.stringify(list));
    else store.removeItem(UNDO_PERSIST_NAME);
    return true;
  } catch { return false; }
}

/** The least time left that comes back after a reload (less would flash and go). */
export const MIN_REVIVE_LEFT_MS = 500;

/** The saved Undos with at least `minLeftMs` left, from a page gone less than RETURN_WITHIN_MS
 *  ago, the one ending first first; the store is emptied, so a second load (another reload)
 *  does not bring back what was used. */
export function takeUndos(store: Store | undefined, now: number, minLeftMs = MIN_REVIVE_LEFT_MS): PersistedUndo[] {
  let raw: string | null = null;
  try {
    raw = store?.getItem(UNDO_PERSIST_NAME) ?? null;
    store?.removeItem(UNDO_PERSIST_NAME);
  } catch { return []; }
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((u): u is PersistedUndo => !!u && typeof u === 'object'
        && typeof (u as PersistedUndo).kind === 'string' && typeof (u as PersistedUndo).key === 'string'
        && typeof (u as PersistedUndo).title === 'string' && typeof (u as PersistedUndo).leftMs === 'number'
        && typeof (u as PersistedUndo).savedAt === 'number')
      .filter((u) => u.leftMs >= minLeftMs && now - u.savedAt >= 0 && now - u.savedAt < RETURN_WITHIN_MS)
      .sort((a, b) => a.leftMs - b.leftMs);
  } catch { return []; }
}
