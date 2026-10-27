/**
 * Where an html-app island's state lives between one build of its frame and the next.
 *
 * One record per island: what its page wrote to `localStorage` (island-runtime.ts)
 * and the last result it offered the AI, with whether the user sent or dismissed it.
 * Two layers:
 *
 *  · a map in this window, for an island outside a session and for a browser whose
 *    storage is off or full;
 *  · the draft store (utils/drafts.ts) under `draft:island:<sessionId>:<message>:<hash>`,
 *    so it survives a reload and an app restart, and reaches the Mac app and every
 *    other browser of this Walnut through the draft mirror (the phone keeps its own).
 *    A draft is the right home: it is the user's unfinished work on something on the
 *    page, kept until they clear it.
 *
 * The island is named by its session, its message and the hash of its own html, never
 * by a React key: the same quiz is the same island while it streams, after the stream
 * is absorbed into history, and after a reload; the same quiz asked for again in a
 * new reply starts fresh.
 *
 * The page may write on every frame, so writes are coalesced here too (one storage
 * write per island per WRITE_COALESCE_MS, flushed when the frame goes away and when
 * the window is hidden or left), and the store is bounded: at most ISLAND_STATE_MAX
 * per island and MAX_ISLANDS islands, the least recently written going first, so
 * islands can never fill the storage every other draft needs.
 */
import { draftHash, draftKey, readDraftJson, writeDraftJson } from '@/utils/drafts';
import { ISLAND_STATE_MAX, type IslandItems } from './island-runtime';

export interface IslandResult {
  text: string;
  /** The user pressed Send and the session accepted it. */
  sent: boolean;
  /** The user dismissed this text: the same text offered again stays hidden. */
  dismissed?: boolean;
}

export interface IslandRecord {
  items: IslandItems;
  result?: IslandResult;
  /** Last write (ms), for eviction. */
  at?: number;
}

/** Islands kept per browser; the least recently written go first. */
export const MAX_ISLANDS = 100;
const WRITE_COALESCE_MS = 250;
const PREFIX = 'draft:island:';

const memory = new Map<string, IslandRecord>();
const pending = new Map<string, IslandItems>();
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * The record's name: per session (and message, when known) when there is a session,
 * this window only when not.
 */
export function islandStoreKey(html: string, sessionId?: string | null, messageScope?: string | null): string {
  const hash = draftHash(html);
  if (!sessionId) return `island-mem:${hash}`;
  return draftKey('island', sessionId, messageScope ? draftHash(messageScope) : '-', hash);
}

function persistent(key: string): boolean {
  return key.startsWith(PREFIX);
}

function valid(rec: unknown): rec is IslandRecord {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as IslandRecord;
  return !!r.items && typeof r.items === 'object' && !Array.isArray(r.items);
}

function stored(key: string): IslandRecord | undefined {
  if (persistent(key)) {
    const rec = readDraftJson<IslandRecord>(key);
    if (valid(rec)) return rec;
  }
  return memory.get(key);
}

/**
 * The draft is read first, because another window may have moved it; the map answers
 * when it has nothing (storage off or full, or a key with no session). A write still
 * waiting to be stored wins over both.
 */
export function readIsland(key: string): IslandRecord {
  const rec = stored(key) ?? { items: {} };
  const items = pending.get(key);
  return items ? { ...rec, items } : rec;
}

/** Drop the least recently written islands past MAX_ISLANDS (this browser's drafts). */
function evict(keep: string): void {
  let keys: string[];
  try {
    keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
  } catch { return; }
  if (keys.length <= MAX_ISLANDS) return;
  const aged = keys
    .filter((k) => k !== keep)
    .map((k) => ({ k, at: readDraftJson<IslandRecord>(k)?.at ?? 0 }))
    .sort((a, b) => a.at - b.at);
  for (const { k } of aged.slice(0, keys.length - MAX_ISLANDS)) {
    writeDraftJson(k, undefined);
    memory.delete(k);
  }
}

function write(key: string, rec: IslandRecord): void {
  const next = { ...rec, at: Date.now() };
  memory.set(key, next);
  if (!persistent(key)) return;
  const empty = Object.keys(next.items).length === 0 && !next.result;
  // An empty record removes the draft: a page that cleared its storage is a page
  // with nothing to keep.
  writeDraftJson(key, empty ? undefined : next);
  if (!empty) evict(key);
}

/** Store every write still waiting (the frame went away, the window is leaving). */
export function flushIslands(only?: string): void {
  for (const [key, items] of [...pending]) {
    if (only && key !== only) continue;
    pending.delete(key);
    write(key, { ...(stored(key) ?? { items: {} }), items });
  }
  if (pending.size === 0 && timer) { clearTimeout(timer); timer = null; }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flushIslands());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushIslands();
  });
}

/** Keep what the page wrote. A store past the cap is refused (the page keeps running). */
export function saveIslandItems(key: string, items: IslandItems): boolean {
  if (JSON.stringify(items).length > ISLAND_STATE_MAX) return false;
  pending.set(key, items);
  if (!timer) timer = setTimeout(() => { timer = null; flushIslands(); }, WRITE_COALESCE_MS);
  return true;
}

/**
 * The page offered a result. The same text it already offered keeps its sent and
 * dismissed marks, so a page that reports again on load does not ask the user to send
 * it twice, nor bring back what they dismissed.
 */
export function offerIslandResult(key: string, text: string): IslandResult {
  const rec = readIsland(key);
  const result = rec.result && rec.result.text === text ? rec.result : { text, sent: false };
  if (result !== rec.result) write(key, { ...rec, result });
  return result;
}

export function markIslandResultSent(key: string, text: string): void {
  const rec = readIsland(key);
  if (rec.result?.text !== text) return;
  write(key, { ...rec, result: { ...rec.result, sent: true } });
}

export function dismissIslandResult(key: string): void {
  const rec = readIsland(key);
  if (!rec.result) return;
  write(key, { ...rec, result: { ...rec.result, dismissed: true } });
}

/** Tests only. */
export function resetIslandMemory(): void {
  memory.clear();
  pending.clear();
  if (timer) { clearTimeout(timer); timer = null; }
}
