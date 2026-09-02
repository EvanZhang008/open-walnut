/**
 * createKeyedIdbStore — the one IndexedDB scaffold behind Walnut's browser-side
 * caches (unsaved file drafts, directory listings, session history).
 *
 * The three of them had copied the same ~120 lines three times: open with
 * delete-and-recreate on upgrade, a timestamp index walked by KEY cursor,
 * string primary keys, a prefix range, and oldest-first expire-then-cap
 * housekeeping. Copies drift, and the drift was the bug: one module awaited
 * housekeeping before a write while another kicked it and moved on, so a write
 * parked behind a slow sweep could land AFTER a delete that was issued later and
 * resurrect the record the delete removed. There is one policy here now, and the
 * differences that remain are arguments to this factory instead of forks of it.
 *
 * Contract inherited by every caller: BEST EFFORT. Every failure (private
 * browsing, quota, corrupt DB, blocked upgrade, a store that isn't there)
 * resolves to null / [] / no-op. Nothing here may reject into a render path.
 */

/**
 * The storage surface, injectable so the node test tier (no IndexedDB, and no
 * fake-indexeddb in devDependencies) can exercise the real policy against an
 * in-memory stand-in.
 *
 * Everything optional is EMULATED when absent, so an injected adapter only has to
 * implement what its own module uses — which is what lets each cache keep its
 * existing adapter type (and its tests) unchanged. One caller stores single keys
 * and never batches, another only ever batches; each gets the other for free.
 */
export interface KeyedIdbAdapter<T> {
  get(key: string): Promise<T | null>;
  put(key: string, record: T): Promise<void>;
  /** Primary keys starting with `prefix`, values NOT read. */
  keysWithPrefix(prefix: string): Promise<string[]>;
  /** `{ key, updatedAt }` OLDEST FIRST — housekeeping only, values NOT read. */
  agesOldestFirst(): Promise<Array<{ key: string; updatedAt: number }>>;
  /** MANY keys in ONE transaction; results positional, null for a miss. */
  getMany?(keys: string[]): Promise<Array<T | null>>;
  /** One of `delete` / `deleteMany` is enough: each is emulated from the other. */
  delete?(key: string): Promise<void>;
  deleteMany?(keys: string[]): Promise<void>;
  clear?(): Promise<void>;
}

export interface KeyedIdbStoreOptions {
  dbName: string;
  storeName: string;
  /**
   * Record field holding the write time, and the name of the index over it.
   * Key cursors on that index give (time, primaryKey) WITHOUT deserializing the
   * payload — housekeeping must never pull thousands of records into memory to
   * decide which few to drop.
   */
  timeField?: string;
  /** Records kept at most; oldest by `timeField` evicted first. */
  maxRecords: number;
  /** Omit for a cap-only store: no age ever expires a record. */
  maxAgeMs?: number;
  /** Bump to wipe incompatible payloads — the upgrade DROPS the store. */
  version?: number;
}

export interface KeyedIdbStore<T> {
  get(key: string): Promise<T | null>;
  getMany(keys: string[]): Promise<Array<T | null>>;
  put(key: string, record: T): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  keysWithPrefix(prefix: string): Promise<string[]>;
  clear(): Promise<void>;
  /**
   * Housekeeping, at most once per page. AWAIT this before a write: it is the
   * ordering barrier that keeps two writes to the same key in the order they
   * were issued (see the header). A read may kick it with `void` instead —
   * nothing about a read depends on the sweep having run, and a cursor walk in
   * front of the first paint is the delay these caches exist to remove.
   */
  housekeep(): Promise<void>;
  /** Force a sweep NOW (a per-write cap, or a manual/maintenance prune). */
  runHousekeep(): Promise<void>;
  /** Test seam: await whatever sweep is in flight, without starting one. */
  settleHousekeep(): Promise<void>;
  /** Test seam: swap the storage layer and re-arm the once-per-page sweep. */
  setAdapter(next: KeyedIdbAdapter<T> | null): void;
}

/** Upper bound for a prefix range: IDB compares strings by UTF-16 code unit,
 *  and no path segment starts above U+FFFF (astral chars begin at a surrogate). */
const AFTER_ANY_KEY = '\uffff';

export function createKeyedIdbStore<T>(opts: KeyedIdbStoreOptions): KeyedIdbStore<T> {
  const { dbName, storeName, maxRecords } = opts;
  const timeField = opts.timeField ?? 'updatedAt';
  const version = opts.version ?? 1;

  let dbPromise: Promise<IDBDatabase | null> | undefined;

  function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') { resolve(null); return; }
        const req = indexedDB.open(dbName, version);
        req.onupgradeneeded = () => {
          const db = req.result;
          // Version bump = incompatible shape: drop and recreate, never migrate.
          if (db.objectStoreNames.contains(storeName)) db.deleteObjectStore(storeName);
          db.createObjectStore(storeName).createIndex(timeField, timeField);
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

  /** Run `body` in one transaction and resolve with `fallback` on any failure —
   *  including a synchronous throw from `db.transaction` (a store that a failed
   *  upgrade never created), which is the one path a handler can't catch.
   *
   *  `done` hands back the value to resolve with. A collecting body calls it once
   *  with the array it is about to fill: resolution waits for `oncomplete`, so the
   *  rows pushed by later request callbacks are all in it by then. */
  function tx<R>(
    mode: IDBTransactionMode,
    fallback: R,
    body: (store: IDBObjectStore, done: (value: R) => void) => void,
  ): Promise<R> {
    return openDb().then((db) => {
      if (!db) return fallback;
      return new Promise<R>((resolve) => {
        let out = fallback;
        try {
          const t = db.transaction(storeName, mode);
          body(t.objectStore(storeName), (value) => { out = value; });
          t.oncomplete = () => resolve(out);
          t.onerror = () => resolve(out);
          t.onabort = () => resolve(out);
        } catch { resolve(fallback); }
      });
    });
  }

  const idbAdapter: KeyedIdbAdapter<T> = {
    get(key) {
      return tx<T | null>('readonly', null, (store, done) => {
        const req = store.get(key);
        req.onsuccess = () => done((req.result as T | undefined) ?? null);
      });
    },
    getMany(keys) {
      if (keys.length === 0) return Promise.resolve([]);
      // ONE readonly transaction, N gets inside it: the bulk read exists so the
      // panel-reopen path doesn't pay one round trip per directory.
      return tx<Array<T | null>>('readonly', keys.map(() => null), (store, done) => {
        const out: Array<T | null> = keys.map(() => null);
        done(out);
        keys.forEach((key, i) => {
          const req = store.get(key);
          req.onsuccess = () => { out[i] = (req.result as T | undefined) ?? null; };
        });
      });
    },
    put(key, record) {
      return tx('readwrite', undefined, (store) => { store.put(record, key); });
    },
    delete(key) {
      return tx('readwrite', undefined, (store) => { store.delete(key); });
    },
    deleteMany(keys) {
      if (keys.length === 0) return Promise.resolve();
      return tx('readwrite', undefined, (store) => { for (const k of keys) store.delete(k); });
    },
    keysWithPrefix(prefix) {
      return tx<string[]>('readonly', [], (store, done) => {
        const req = store.getAllKeys(IDBKeyRange.bound(prefix, prefix + AFTER_ANY_KEY));
        req.onsuccess = () => done((req.result as IDBValidKey[]).map(String));
      });
    },
    agesOldestFirst() {
      return tx<Array<{ key: string; updatedAt: number }>>('readonly', [], (store, done) => {
        const out: Array<{ key: string; updatedAt: number }> = [];
        done(out);
        const cursorReq = store.index(timeField).openKeyCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          out.push({ key: String(cursor.primaryKey), updatedAt: Number(cursor.key) });
          cursor.continue();
        };
      });
    },
    clear() {
      return tx('readwrite', undefined, (store) => { store.clear(); });
    },
  };

  let injected: KeyedIdbAdapter<T> | null = null;
  const adapter = (): KeyedIdbAdapter<T> => injected ?? idbAdapter;

  async function deleteOne(key: string): Promise<void> {
    const a = adapter();
    if (a.delete) { await a.delete(key); return; }
    await a.deleteMany?.([key]);
  }

  async function deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const a = adapter();
    if (a.deleteMany) { await a.deleteMany(keys); return; }
    // No batch on this adapter: sequential, so the caller still gets "all gone"
    // when it resolves.
    for (const k of keys) await deleteOne(k);
  }

  /** Expire, then evict oldest-first to the cap — one oldest-first pass covers
   *  both rules. `maxAgeMs` absent = nothing ever expires by age. */
  async function sweep(): Promise<void> {
    try {
      const ages = await adapter().agesOldestFirst();
      const cutoff = opts.maxAgeMs === undefined ? -Infinity : Date.now() - opts.maxAgeMs;
      let live = ages.length;
      const victims: string[] = [];
      for (const { key, updatedAt } of ages) {
        if (updatedAt >= cutoff && live <= maxRecords) break;
        victims.push(key);
        live--;
      }
      await deleteMany(victims);
    } catch { /* best effort */ }
  }

  let once: Promise<void> | undefined;
  let inFlight: Promise<void> | undefined;

  function runHousekeep(): Promise<void> {
    if (!inFlight) inFlight = sweep().finally(() => { inFlight = undefined; });
    return inFlight;
  }

  return {
    get(key) {
      return adapter().get(key);
    },
    async getMany(keys) {
      if (keys.length === 0) return [];
      const a = adapter();
      if (a.getMany) return a.getMany(keys);
      return Promise.all(keys.map((k) => a.get(k)));
    },
    put(key, record) {
      return adapter().put(key, record);
    },
    delete: deleteOne,
    deleteMany,
    keysWithPrefix(prefix) {
      return adapter().keysWithPrefix(prefix);
    },
    async clear() {
      const a = adapter();
      if (a.clear) { await a.clear(); return; }
      await deleteMany(await a.keysWithPrefix(''));
    },
    housekeep() {
      if (!once) once = runHousekeep();
      return once;
    },
    runHousekeep,
    settleHousekeep() {
      return once ?? inFlight ?? Promise.resolve();
    },
    setAdapter(next) {
      injected = next;
      once = undefined;
    },
  };
}
