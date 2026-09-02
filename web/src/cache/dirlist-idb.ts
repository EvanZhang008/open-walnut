/**
 * Persistent directory-listing cache (IndexedDB) — what makes the session Files
 * tree paint before the network answers.
 *
 * Why it exists: every listing in the tree is a fresh `/api/files/list` round
 * trip, and for a REMOTE session that trip goes over the SSH tunnel to the
 * daemon (~150-250ms measured, multi-second whenever the server is busy). The
 * tree rendered nothing until the first response landed, so reopening a panel
 * you had open two minutes ago showed a bare `Loading…` pane. With this tier the
 * previously expanded tree comes back from disk in a few ms and the fetch becomes
 * a background correction.
 *
 * Contract, same as cache/history-idb.ts and utils/file-drafts.ts: best effort.
 * Every failure (private browsing, quota, corrupt DB, blocked upgrade) resolves
 * to null / no-op, and nothing here may ever throw into a render path.
 *
 * Two rules the callers depend on:
 *  - A cached listing is ALWAYS paintable, however old. There is deliberately no
 *    read-time TTL: the fetch that runs alongside the paint is what corrects the
 *    rows, and hiding a 15-day-old listing would just restore the empty pane this
 *    module exists to remove. Age only drives storage housekeeping.
 *  - Housekeeping never blocks a READ. It is kicked as a floating promise on
 *    first access, because a key-cursor walk over a few thousand records would
 *    otherwise land in front of the very first paint. A WRITE does await it: the
 *    one sweep is also the barrier that keeps two writes to the same key in the
 *    order they were issued (see cache/keyed-idb-store.ts).
 */
import type { DirEntry, DirListResponse } from '@/api/files';
import { createKeyedIdbStore } from './keyed-idb-store';
import { log } from '@/utils/log';

const DB_NAME = 'walnut-dirlist-cache';
const DB_VERSION = 1;
const STORE = 'listings';
/** Records kept at most; oldest (by `updatedAt`) evicted first. */
const MAX_RECORDS = 4000;
/** A listing nobody has looked at in two weeks is not the tree you are reopening. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Listings above this are not written. The instant-paint case is an ordinary
 * source folder; a directory with thousands of entries is a structured-clone bill
 * on every visit for rows the user scrolls past anyway.
 */
const MAX_ENTRIES_PER_RECORD = 5000;

/**
 * One directory listing, as it came back from `fetchDirList`. `entries` is the
 * only field the tree paints from; the rest is kept so a reader can tell what the
 * response actually was (a healed path, a deep-linked file) without a second
 * source of truth.
 */
export interface CachedDirList {
  /** Exec host the directory lives on; null = this machine. */
  host: string | null;
  path: string;
  entries: DirEntry[];
  selectedFile?: string;
  requestedPath?: string;
  resolvedVia?: string;
  updatedAt: number;
}

/**
 * The whole storage surface, injectable so the node test tier (no IndexedDB, and
 * no fake-indexeddb in devDependencies) can exercise the real policy — bulk
 * reads, subtree invalidation, expiry, cap eviction, failure tolerance — against
 * an in-memory stand-in.
 */
export interface DirListAdapter {
  get(key: string): Promise<CachedDirList | null>;
  /** MANY keys in ONE transaction. The restore path asks for up to ~64 dirs and
   *  must not pay 64 round trips; results are positional, null for a miss. */
  getMany(keys: string[]): Promise<Array<CachedDirList | null>>;
  put(key: string, record: CachedDirList): Promise<void>;
  /** Batch delete in one transaction. */
  deleteMany(keys: string[]): Promise<void>;
  /** Primary keys starting with `prefix`, values NOT read. */
  keysWithPrefix(prefix: string): Promise<string[]>;
  /** `{ key, updatedAt }` OLDEST FIRST — housekeeping only, values NOT read. */
  agesOldestFirst(): Promise<Array<{ key: string; updatedAt: number }>>;
  clear(): Promise<void>;
}

/** Host segment of a key. Hostnames never contain a space, so ` ` separates. */
function hostPrefix(host: string | null | undefined): string {
  return `${host ?? 'local'} `;
}

export function dirListKey(host: string | null | undefined, path: string): string {
  return `${hostPrefix(host)}${path}`;
}

// ── Storage ─────────────────────────────────────────────────────────────────

const store = createKeyedIdbStore<CachedDirList>({
  dbName: DB_NAME,
  storeName: STORE,
  version: DB_VERSION,
  maxRecords: MAX_RECORDS,
  maxAgeMs: MAX_AGE_MS,
});

/** Test seam: swap the storage layer (and re-arm the one-shot housekeeping). */
export function setDirListAdapter(next: DirListAdapter | null): void {
  store.setAdapter(next);
}

/** Test seam: await whatever housekeeping a call already kicked. Exists because
 *  the ordering IS the contract — a read must resolve before the sweep, so the
 *  two have to be observable separately. */
export function settleDirListHousekeeping(): Promise<void> {
  return store.settleHousekeep();
}

/**
 * Drop expired records, then evict oldest-first down to the cap. Kicked once per
 * page by the first access; exported so the tests (and any manual maintenance)
 * can force a pass and await it.
 */
export function pruneCachedDirLists(): Promise<void> {
  return store.runHousekeep();
}

// ── Public API ──────────────────────────────────────────────────────────────

function valid(rec: CachedDirList | null | undefined): CachedDirList | null {
  return rec && Array.isArray(rec.entries) ? rec : null;
}

/** The last known listing for one directory. null on miss or any failure. */
export async function getCachedDirList(
  host: string | null | undefined,
  path: string,
): Promise<CachedDirList | null> {
  try {
    // Kicked, never awaited: a cursor walk in front of the first paint is exactly
    // the delay this module exists to remove, and no read depends on the sweep.
    void store.housekeep();
    return valid(await store.get(dirListKey(host, path)));
  } catch {
    return null;
  }
}

/**
 * Many directories in ONE transaction — the panel-reopen path, which needs the
 * root plus every persisted-expanded dir before it can paint. Keyed by the
 * requested path; misses are simply absent.
 */
export async function getCachedDirListsBulk(
  host: string | null | undefined,
  paths: string[],
): Promise<Map<string, CachedDirList>> {
  const out = new Map<string, CachedDirList>();
  try {
    void store.housekeep();
    const unique = [...new Set(paths)];
    if (unique.length === 0) return out;
    const records = await store.getMany(unique.map((p) => dirListKey(host, p)));
    unique.forEach((p, i) => {
      const rec = valid(records[i]);
      if (rec) out.set(p, rec);
    });
    return out;
  } catch {
    return out;
  }
}

/** Write-through after a successful listing fetch. Fire-and-forget by contract. */
export async function setCachedDirList(
  host: string | null | undefined,
  path: string,
  res: DirListResponse,
): Promise<void> {
  try {
    if (!Array.isArray(res.entries)) return;
    if (res.entries.length > MAX_ENTRIES_PER_RECORD) return;
    // A WRITE awaits it: housekeeping is the barrier that keeps two writes to one
    // key in the order they were issued (see keyed-idb-store.ts).
    await store.housekeep();
    await store.put(dirListKey(host, path), {
      host: host ?? null,
      path,
      entries: res.entries,
      ...(res.selectedFile ? { selectedFile: res.selectedFile } : {}),
      ...(res.requestedPath ? { requestedPath: res.requestedPath } : {}),
      ...(res.resolvedVia ? { resolvedVia: res.resolvedVia } : {}),
      updatedAt: Date.now(),
    });
  } catch (err) {
    // Losing the persisted copy only costs a slower next open, but a silent loss
    // is what makes "why is it still showing Loading" unexplainable.
    log.warn('dirlist-idb', 'listing cache write failed (tree falls back to network)', {
      path, host: host ?? null, error: String(err),
    });
  }
}

/** Forget ONE directory's listing. */
export async function deleteCachedDirList(
  host: string | null | undefined,
  path: string,
): Promise<void> {
  try {
    await store.housekeep();
    await store.deleteMany([dirListKey(host, path)]);
  } catch { /* best effort */ }
}

/**
 * Forget a directory AND everything under it.
 *
 * Needed because a renamed or deleted DIRECTORY invalidates far more than its
 * parent's listing: its own record, and every descendant's, still sits in the
 * store pointing at paths that no longer exist. Re-listing the parent (what the
 * mutation path already does) cannot see any of that.
 *
 * Matching is by path SEGMENT, not by string prefix — deleting `/a/b` must not
 * touch `/a/bc/x`. That falls out of asking for the `"<key>/"` range rather than
 * the `"<key>"` one, plus the dir's own exact key.
 */
export async function deleteCachedDirListsUnder(
  host: string | null | undefined,
  prefix: string,
): Promise<void> {
  try {
    const norm = prefix.replace(/\/+$/, '') || '/';
    const base = dirListKey(host, norm);
    // At the filesystem root the separator is already there; appending one more
    // would ask for `//…` and match nothing.
    const descendants = norm === '/' ? base : `${base}/`;
    await store.housekeep();
    const keys = await store.keysWithPrefix(descendants);
    await store.deleteMany([base, ...keys]);
  } catch { /* best effort */ }
}

/** Drop every persisted listing (test/reset hook, and the manual escape hatch). */
export async function clearCachedDirLists(): Promise<void> {
  try {
    await store.clear();
  } catch { /* best effort */ }
}
