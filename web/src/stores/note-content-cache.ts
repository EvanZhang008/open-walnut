/**
 * Recently seen note bytes, kept for the page lifetime so a click on a note
 * the browser already holds paints at once, with no request in the way.
 *
 * Two feeds fill it: every load or save the notes editor makes, and a hover
 * prefetch from the sidebar tree (a pointer resting on a row for a moment is
 * the best predictor of the next click). Every server change signal for a note
 * (`notes:updated`) drops its entry unless the event carries the hash we hold.
 * A shape change (`notes:tree-changed`) drops nothing: an open editor never
 * trusts an entry blindly, it paints from it and revalidates against the disk
 * in the background (useNoteContent), and a path that no longer exists comes
 * back as a 404 there and is dropped then. Clearing on shape changes cost every
 * cached note each time anything in the vault was created or removed.
 */
import { wsClient } from '@/api/ws';
import { fetchNoteContent, type CorpusFetchOptions } from '@/api/notes-v2';

export interface CachedNote {
  content: string;
  updatedAt: string;
  contentHash: string;
  /** When the entry was stored (LRU order). */
  at: number;
}

/** Notes kept. A page rarely has more open tabs; hover prefetch churns the tail. */
const MAX_ENTRIES = 40;
/** Total bytes kept (a vault has 300 KB notes; forty of them is too much to hold). */
const MAX_BYTES = 6 * 1024 * 1024;
/** A pointer must rest this long on a row before its note is fetched. */
const HOVER_DEBOUNCE_MS = 70;

const entries = new Map<string, CachedNote>();
let totalBytes = 0;
const inflight = new Map<string, Promise<CachedNote>>();
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

function evictIfNeeded(): void {
  while (entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of entries) {
      if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    }
    if (oldestKey == null) break;
    const gone = entries.get(oldestKey)!;
    totalBytes -= gone.content.length;
    entries.delete(oldestKey);
  }
}

export function getCachedNote(notePath: string): CachedNote | undefined {
  const hit = entries.get(notePath);
  if (hit) hit.at = Date.now(); // touch: LRU
  return hit;
}

/** Read without touching LRU order (safe to call while rendering). */
export function peekCachedNote(notePath: string): CachedNote | undefined {
  return entries.get(notePath);
}

export function putCachedNote(notePath: string, note: Omit<CachedNote, 'at'>): void {
  const prev = entries.get(notePath);
  if (prev) totalBytes -= prev.content.length;
  entries.set(notePath, { ...note, at: Date.now() });
  totalBytes += note.content.length;
  evictIfNeeded();
}

export function dropCachedNote(notePath: string): void {
  const prev = entries.get(notePath);
  if (!prev) return;
  totalBytes -= prev.content.length;
  entries.delete(notePath);
}

export function clearNoteContentCache(): void {
  entries.clear();
  totalBytes = 0;
}

/**
 * Load a note from the server into the cache, single-flight per path: the
 * editor's own load and a hover prefetch for the same note share one request
 * (a Playwright click, like a real one, hovers the row first). Rejects the way
 * `fetchNoteContent` does (404 for a missing note), so callers keep their
 * error handling.
 */
export function loadNoteIntoCache(notePath: string, opts?: CorpusFetchOptions): Promise<CachedNote> {
  const pending = inflight.get(notePath);
  if (pending) return pending;
  const p = fetchNoteContent(notePath, opts)
    .then(({ content, updatedAt, contentHash }) => {
      const entry: CachedNote = { content, updatedAt, contentHash, at: Date.now() };
      putCachedNote(notePath, entry);
      return entry;
    })
    .finally(() => { inflight.delete(notePath); });
  inflight.set(notePath, p);
  return p;
}

/**
 * Fetch a note into the cache ahead of a click. Low priority: a prefetch must
 * never take a connection from something the user is waiting on. Resolves to
 * the entry, or null when the note does not exist / the request failed.
 */
export function prefetchNoteContent(notePath: string): Promise<CachedNote | null> {
  const hit = entries.get(notePath);
  if (hit) return Promise.resolve(hit);
  return loadNoteIntoCache(notePath, { priority: 'low' }).catch(() => null);
}

/**
 * Sidebar hover: fetch after the pointer has rested a moment. Moving across
 * rows cancels the previous candidate, so a sweep costs at most one request.
 */
export function prefetchNoteOnHover(notePath: string): void {
  if (hoverTimer) clearTimeout(hoverTimer);
  if (entries.has(notePath) || inflight.has(notePath)) return;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    void prefetchNoteContent(notePath);
  }, HOVER_DEBOUNCE_MS);
}

export function cancelHoverPrefetch(): void {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
}

let wired = false;
/** Keep the cache honest against server change signals. Idempotent. */
export function wireNoteContentCacheEvents(): void {
  if (wired) return;
  wired = true;
  wsClient.onEvent('notes:updated', (data) => {
    const d = data as { source?: string; contentHash?: string } | null;
    if (!d || typeof d.source !== 'string' || !d.source.startsWith('notes/')) return;
    const notePath = d.source.slice('notes/'.length) + '.md';
    const held = entries.get(notePath);
    if (held && d.contentHash && held.contentHash === d.contentHash) return; // our own bytes
    dropCachedNote(notePath);
  });
}

/** Test hook. */
export function noteContentCacheStats(): { entries: number; bytes: number } {
  return { entries: entries.size, bytes: totalBytes };
}
