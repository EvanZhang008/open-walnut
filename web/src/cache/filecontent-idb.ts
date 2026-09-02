/**
 * Persistent file-CONTENT cache (IndexedDB) — what makes re-opening a file in the
 * Files panel paint immediately instead of after a round trip.
 *
 * Why it exists: the tree already paints from `cache/dirlist-idb`, but clicking a
 * row still blanked the pane and waited for `/api/file-content` to ship the whole
 * file as JSON. For a REMOTE session that body crosses the SSH tunnel every single
 * time, even when the file has not changed since the last look. Measured on the
 * live server: a listing is ~40-150 ms over the tunnel and a file body is the same
 * trip plus the bytes, on every open, forever.
 *
 * The pair that makes this safe is the server's ETag. A record here is only ever
 * PAINTED, never trusted: the open that paints it also sends
 * `If-None-Match: "<contentHash>"`, and the server answers 304 (the bytes you have
 * are current) or 200 with the new ones. So a stale record costs one repaint, not
 * a wrong file. That is why only COMPLETE text reads are stored — a truncated or
 * binary payload has no `contentHash`, so it has no validator and could never be
 * confirmed.
 *
 * Contract, same as cache/dirlist-idb.ts and utils/file-drafts.ts: best effort.
 * Every failure (private browsing, quota, corrupt DB, blocked upgrade) resolves to
 * null / no-op, and nothing here may ever throw into a render path.
 */
import type { FileContentResponse } from '@/api/files';
import { createKeyedIdbStore, type KeyedIdbAdapter } from './keyed-idb-store';
import { log } from '@/utils/log';

const DB_NAME = 'walnut-filecontent-cache';
const DB_VERSION = 1;
const STORE = 'contents';
/**
 * Records kept at most; oldest (by `updatedAt`) evicted first. Lower than the
 * listing cache's cap on purpose: a record here carries a whole file, so the cap
 * and the size limit below are what bound this store's disk footprint.
 */
const MAX_RECORDS = 150;
/** A file nobody has opened in a week is not the one you are re-opening. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Files above this are not stored. The instant-paint case is a source file or a
 * design doc; a 500 KB payload is a structured-clone bill on every visit, and the
 * conditional fetch still saves the transfer for it via the server's ETag.
 */
export const MAX_CACHED_CONTENT_BYTES = 256 * 1024;

/**
 * One file's bytes as the server last served them, with the validator that lets
 * the next open confirm them in one conditional request.
 */
export interface CachedFileContent {
  /** Exec host the file lives on; null = this machine. */
  host: string | null;
  path: string;
  content: string;
  size: number;
  extension: string;
  /** The server's ETag for these exact bytes. Always present: see `storable`. */
  contentHash: string;
  updatedAt: number;
}

export type FileContentAdapter = KeyedIdbAdapter<CachedFileContent>;

/** Host segment of a key. Hostnames never contain a space, so ` ` separates. */
function hostPrefix(host: string | null | undefined): string {
  return `${host ?? 'local'} `;
}

export function fileContentKey(host: string | null | undefined, path: string): string {
  return `${hostPrefix(host)}${path}`;
}

const store = createKeyedIdbStore<CachedFileContent>({
  dbName: DB_NAME,
  storeName: STORE,
  version: DB_VERSION,
  maxRecords: MAX_RECORDS,
  maxAgeMs: MAX_AGE_MS,
});

/** Test seam: swap the storage layer (and re-arm the one-shot housekeeping). */
export function setFileContentAdapter(next: FileContentAdapter | null): void {
  store.setAdapter(next);
}

/** Test seam: await whatever housekeeping a call already kicked. */
export function settleFileContentHousekeeping(): Promise<void> {
  return store.settleHousekeep();
}

/** Drop expired records, then evict oldest-first down to the cap. */
export function pruneCachedFileContents(): Promise<void> {
  return store.runHousekeep();
}

function valid(rec: CachedFileContent | null | undefined): CachedFileContent | null {
  return rec && typeof rec.content === 'string' && typeof rec.contentHash === 'string' && rec.contentHash
    ? rec
    : null;
}

/**
 * Is this payload one we may cache? Only a COMPLETE text read qualifies: the
 * `contentHash` is both the paint's validator and the editor's optimistic lock,
 * and a payload without one (truncated, binary, error) can never be confirmed.
 */
export function storable(payload: FileContentResponse): boolean {
  return !!payload.contentHash
    && typeof payload.content === 'string'
    && !payload.truncated
    && !payload.binary
    && !payload.error
    && payload.content.length <= MAX_CACHED_CONTENT_BYTES;
}

/**
 * The last known bytes of one file, however old — age is deliberately not a read
 * filter. The conditional fetch running alongside the paint is what corrects them,
 * and hiding a day-old record would just restore the blank pane this module exists
 * to remove.
 */
export async function getCachedFileContent(
  host: string | null | undefined,
  path: string,
): Promise<CachedFileContent | null> {
  try {
    // Kicked, never awaited: a cursor walk in front of the first paint is exactly
    // the delay this module exists to remove, and no read depends on the sweep.
    void store.housekeep();
    return valid(await store.get(fileContentKey(host, path)));
  } catch {
    return null;
  }
}

/**
 * Write-through for bytes we KNOW are on disk — a read the server just served, or
 * a write it just accepted. Fire-and-forget by contract.
 */
export async function setCachedFileContent(
  host: string | null | undefined,
  path: string,
  payload: FileContentResponse,
): Promise<void> {
  try {
    if (!storable(payload)) return;
    // A WRITE awaits it: housekeeping is the barrier that keeps two writes to one
    // key in the order they were issued (see keyed-idb-store.ts).
    await store.housekeep();
    await store.put(fileContentKey(host, path), {
      host: host ?? null,
      path,
      content: payload.content as string,
      size: payload.size,
      extension: payload.extension,
      contentHash: payload.contentHash as string,
      updatedAt: Date.now(),
    });
  } catch (err) {
    // Losing the persisted copy only costs a slower next open, but a silent loss
    // is what makes "why did this open blank again" unexplainable.
    log.warn('filecontent-idb', 'content cache write failed (open falls back to network)', {
      path, host: host ?? null, error: String(err),
    });
  }
}

/** Forget ONE file's bytes (it was deleted, or its bytes are now unknown). */
export async function deleteCachedFileContent(
  host: string | null | undefined,
  path: string,
): Promise<void> {
  try {
    await store.housekeep();
    await store.deleteMany([fileContentKey(host, path)]);
  } catch { /* best effort */ }
}

/**
 * Forget a path AND everything under it — a renamed or deleted DIRECTORY
 * invalidates every file cached beneath it, which re-listing the parent cannot
 * see. Matching is by path SEGMENT, not string prefix, so dropping `/a/b` leaves
 * `/a/bc/x` alone: that falls out of asking for the `"<key>/"` range plus the
 * path's own exact key.
 */
export async function deleteCachedFileContentsUnder(
  host: string | null | undefined,
  prefix: string,
): Promise<void> {
  try {
    const norm = prefix.replace(/\/+$/, '') || '/';
    const base = fileContentKey(host, norm);
    // At the filesystem root the separator is already there; appending one more
    // would ask for `//…` and match nothing.
    const descendants = norm === '/' ? base : `${base}/`;
    await store.housekeep();
    const keys = await store.keysWithPrefix(descendants);
    await store.deleteMany([base, ...keys]);
  } catch { /* best effort */ }
}

/** Drop every cached file (test/reset hook, and the manual escape hatch). */
export async function clearCachedFileContents(): Promise<void> {
  try {
    await store.clear();
  } catch { /* best effort */ }
}
