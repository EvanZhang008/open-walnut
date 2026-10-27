/**
 * When each question was last viewed, kept per session in localStorage so the
 * red "answered, not read" mark survives a reload, a new tab and an app
 * restart (the stack's own copy in sessionStorage is per tab).
 *
 * Keyed by HEAD id. Bounded: the newest MAX_VIEWED_PER_SESSION questions of a
 * session, the newest MAX_VIEWED_SESSIONS sessions (an index key holds each
 * session's last write; the oldest go).
 */

export const VIEWED_PREFIX = 'walnut:thread-viewed.v1:';
export const VIEWED_INDEX_KEY = 'walnut:thread-viewed.v1';
export const MAX_VIEWED_PER_SESSION = 200;
export const MAX_VIEWED_SESSIONS = 60;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): Store | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Only `{ string: finite number }`; anything else reads as nothing. */
export function sanitizeViewed(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (k && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

/** The later time per key, then the newest `max` keys. */
export function mergeViewed(a: Record<string, number>, b: Record<string, number>, max = MAX_VIEWED_PER_SESSION): Record<string, number> {
  const all: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) if (!(k in all) || v > all[k]) all[k] = v;
  const entries = Object.entries(all);
  if (entries.length <= max) return all;
  entries.sort((x, y) => y[1] - x[1]);
  return Object.fromEntries(entries.slice(0, max));
}

function readJson(store: Store, key: string): unknown {
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function readViewed(sessionId: string, store: Store | undefined = defaultStore()): Map<string, number> {
  if (!store || !sessionId) return new Map();
  return new Map(Object.entries(sanitizeViewed(readJson(store, `${VIEWED_PREFIX}${sessionId}`))));
}

/** Merge `entries` into what is stored (another tab may have written since). */
export function writeViewed(sessionId: string, entries: Record<string, number>, store: Store | undefined = defaultStore(), now = Date.now()): void {
  if (!store || !sessionId || Object.keys(entries).length === 0) return;
  try {
    const key = `${VIEWED_PREFIX}${sessionId}`;
    const merged = mergeViewed(sanitizeViewed(readJson(store, key)), entries);
    store.setItem(key, JSON.stringify(merged));
    const index = mergeViewed(sanitizeViewed(readJson(store, VIEWED_INDEX_KEY)), { [sessionId]: now }, Number.MAX_SAFE_INTEGER);
    const sessions = Object.entries(index).sort((x, y) => y[1] - x[1]);
    for (const [sid] of sessions.slice(MAX_VIEWED_SESSIONS)) store.removeItem(`${VIEWED_PREFIX}${sid}`);
    store.setItem(VIEWED_INDEX_KEY, JSON.stringify(Object.fromEntries(sessions.slice(0, MAX_VIEWED_SESSIONS))));
  } catch { /* quota or private mode */ }
}
