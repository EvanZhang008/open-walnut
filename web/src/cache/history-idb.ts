/**
 * Persistent session-history cache (IndexedDB) — the reload-surviving tier
 * under session-cache's in-memory LRU.
 *
 * Why it exists: the in-memory cache dies with the page, so EVERY reload paid
 * the full server round trip before the first message painted — ~140-300ms for
 * a local session, 1-3s for a remote one (daemon stat over SSH), p90 4s+ under
 * load. With this tier, any session the user has ever viewed renders from disk
 * in a few ms and the network fetch becomes a background re-verify.
 *
 * Best-effort by contract: every failure (private browsing, quota, corrupted
 * DB, blocked upgrade) resolves to null / no-op and the caller falls back to
 * the network path. Nothing here may ever throw into a render path. The DB
 * scaffold is shared with the other browser caches (cache/keyed-idb-store.ts);
 * only the policy below is this module's own.
 */
import { createKeyedIdbStore } from './keyed-idb-store';
import type { CachedHistory } from './session-cache';
import { log } from '@/utils/log';

const DB_NAME = 'walnut-history-cache';
// Bump to wipe incompatible payloads: entries are adopted verbatim as parsed
// history, so a message-shape change needs a clean slate, not a migration.
const DB_VERSION = 1;
const STORE = 'history';
const MAX_ENTRIES = 40;
// Persist at most the lazy-load tail contract (HISTORY_TAIL_LIMIT = 400). A
// "Load earlier" full fetch can put a 3000+-message whale into the in-memory
// cache; cloning that into IndexedDB on every turn is main-thread jank for
// content the open path would slice away anyway.
const MAX_PERSISTED_MESSAGES = 400;

type PersistedHistory = CachedHistory & { savedAt: number };

// Keys are bare session ids (one namespace, no host dimension), and the cap is
// a COUNT with no age rule: a session you viewed a year ago is still the fastest
// honest answer for that session, it just loses its slot to 40 newer ones.
const store = createKeyedIdbStore<PersistedHistory>({
  dbName: DB_NAME,
  storeName: STORE,
  version: DB_VERSION,
  timeField: 'savedAt',
  maxRecords: MAX_ENTRIES,
});

/** Read one session's persisted history. ~1-5ms; null on any failure/miss. */
export async function idbGetHistory(sid: string): Promise<CachedHistory | null> {
  try {
    const v = await store.get(sid);
    return v && Array.isArray(v.messages) ? v : null;
  } catch {
    return null;
  }
}

// Trailing debounce per session: delta merges can write several times per
// second mid-conversation; one structured-clone put per settle window is
// plenty for a cache whose only job is surviving the NEXT reload.
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 800;

/** Fire-and-forget write-through. Debounced; tail-sliced to the open contract. */
export function idbSetHistory(sid: string, data: CachedHistory): void {
  const existing = pendingWrites.get(sid);
  if (existing) clearTimeout(existing);
  pendingWrites.set(sid, setTimeout(() => {
    pendingWrites.delete(sid);
    void writeNow(sid, data);
  }, DEBOUNCE_MS));
}

async function writeNow(sid: string, data: CachedHistory): Promise<void> {
  let entry: PersistedHistory = { ...data, savedAt: Date.now() };
  if (entry.messages.length > MAX_PERSISTED_MESSAGES) {
    const dropped = entry.messages.length - MAX_PERSISTED_MESSAGES;
    // Slicing the head keeps the cursor space consistent: msgCount is the FULL
    // count, so baseOffset grows by exactly what we dropped and the reopened
    // view shows "Load earlier" — the same shape a server ?tail= payload has.
    const fb = entry.forkBoundaryIndex;
    entry = {
      ...entry,
      messages: entry.messages.slice(dropped),
      baseOffset: (entry.baseOffset ?? 0) + dropped,
      forkBoundaryIndex: fb !== undefined && fb - dropped >= 0 ? fb - dropped : undefined,
    };
  }
  try {
    await store.put(sid, entry);
    // Forced, not the once-per-page sweep: the cap has to hold for a page that
    // visits a hundred sessions, so every write checks it.
    void store.runHousekeep();
  } catch (err) {
    // Quota/clone failures are expected occasionally — log once per session.
    log.warn('history-idb', 'persist failed (cache degrades to network)', { sessionId: sid, error: String(err) });
  }
}

/** Drop ONE session's persisted history. Used after an in-place rewind, whose
 *  truncated transcript must not be shadowed by the pre-rewind cache on the
 *  next mount. A pending debounced write for the same sid is cancelled first,
 *  or it would re-persist the stale entry after the delete. */
export async function idbDeleteHistory(sid: string): Promise<void> {
  const pending = pendingWrites.get(sid);
  if (pending) { clearTimeout(pending); pendingWrites.delete(sid); }
  try {
    await store.delete(sid);
  } catch { /* best effort */ }
}

/** Test/reset hook: drop every persisted entry. */
export async function idbClearHistory(): Promise<void> {
  try {
    await store.clear();
  } catch { /* best effort */ }
}
