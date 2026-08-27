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
 * the network path. Nothing here may ever throw into a render path.
 */
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

let dbPromise: Promise<IDBDatabase | null> | undefined;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // Version bump = incompatible shape: drop and recreate.
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        const store = db.createObjectStore(STORE);
        store.createIndex('savedAt', 'savedAt');
      };
      req.onsuccess = () => {
        const db = req.result;
        // A later tab upgrading the schema must not deadlock on this one.
        db.onversionchange = () => { try { db.close(); } catch { /* closing */ } dbPromise = undefined; };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Read one session's persisted history. ~1-5ms; null on any failure/miss. */
export async function idbGetHistory(sid: string): Promise<CachedHistory | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(sid);
      req.onsuccess = () => {
        const v = req.result as PersistedHistory | undefined;
        resolve(v && Array.isArray(v.messages) ? v : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
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
  const db = await openDb();
  if (!db) return;
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
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry, sid);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
    void pruneLru(db);
  } catch (err) {
    // Quota/clone failures are expected occasionally — log once per session.
    log.warn('history-idb', 'persist failed (cache degrades to network)', { sessionId: sid, error: String(err) });
  }
}

let pruning = false;
async function pruneLru(db: IDBDatabase): Promise<void> {
  if (pruning) return;
  pruning = true;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        let excess = countReq.result - MAX_ENTRIES;
        if (excess <= 0) return;
        // Oldest-first walk on the savedAt index; delete until under the cap.
        const cursorReq = store.index('savedAt').openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || excess <= 0) return;
          cursor.delete();
          excess--;
          cursor.continue();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    pruning = false;
  }
}

/** Test/reset hook: drop every persisted entry. */
export async function idbClearHistory(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
