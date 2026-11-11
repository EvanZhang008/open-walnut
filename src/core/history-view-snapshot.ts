/**
 * The last conversation view the history route served for a REMOTE session, kept so the next open
 * paints at once (2026-11-08, the user: "open asap, if need load more load later").
 *
 * A remote session's first paint (the history route's `source=streams` phase) has no local
 * transcript to read, so it served only the disk cache (history-disk-cache.ts). That cache holds
 * whole parses, never a windowed one, so a long session (over the 4 MB cold window, or over the
 * reader's byte ceiling) never had one: every open showed "Loading remote session..." until the
 * host answered, 4.4 to 5.7 s on a link that drops large transfers.
 *
 * This is a separate store on purpose: it holds the tail the route last SERVED (fork prefix joined,
 * rewind cut applied, images rewritten), so it is a picture for the first paint only. The stale
 * fallbacks and the mtime fast path read history-disk-cache.ts and must never adopt a partial view.
 * It never seeds a cursor: the first paint carries none, and the full fetch that follows replaces it.
 *
 * Files: <HISTORY_CACHE_DIR>/views/<sessionId>.json, stamped with HISTORY_CACHE_SCHEMA (a parse shape
 * change drops them like the disk cache), coalesced writes, bounded by count and age.
 *
 * Two writers since 2026-11-11: the history route (what it served, `origin` absent) and the
 * session's daemon (`origin: 'ready'`, its ready view, history-ready-view.ts), which also carries
 * `readyKey`, the key the daemon gave that view. Beside each view a small `<sessionId>.meta` holds
 * `{savedAt, readyKey?, contentAt?}`, so the background refresher compares keys without reading
 * whole views. An older Walnut reads the same `.json` files (the new fields are optional and it
 * ignores them) and never touches the `.meta` files.
 *
 * Older content never replaces newer. Every writer says when the read behind its view began
 * (`contentAt`, this server's clock, from beginHistoryViewRead): the view holds at least what the
 * transcript held then. A save whose read began before the kept view's did is dropped, so a host's
 * answer that arrives late (a slow link, a background build) never puts back a picture the history
 * route already moved past, and the refresher knows which turns a kept view already covers.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_CACHE_DIR } from '../constants.js';
import { log } from '../logging/index.js';
import { HISTORY_CACHE_SCHEMA } from './history-disk-cache.js';
import type { SessionHistoryMessage } from './session-history.js';

export interface HistoryViewSnapshot {
  messages: SessionHistoryMessage[];
  /** The served payload's `total` (its own count space, a window's length when `windowed`). */
  total: number;
  windowed?: boolean;
  forkedFromSessionId?: string;
  /** Index into `messages`. */
  forkBoundaryIndex?: number;
  initialUserText?: string;
  finishedAgentIds?: string[];
  /** The daemon's key for this view (history-ready-core.ts readyViewKey); only on a ready view. */
  readyKey?: string;
  /** Who wrote it: absent = the history route, 'ready' = the session's daemon. */
  origin?: 'ready';
  /** When the read behind it began (ms, this server's clock); absent on a view an older Walnut wrote. */
  contentAt?: number;
  savedAt: string;
}

/** What the `.meta` beside a view says: when it was written, when its read began, its ready key. */
export interface HistoryViewMeta {
  savedAt: string;
  readyKey?: string;
  contentAt?: number;
}

/** Taken before a read whose result may be saved: a rewind meanwhile, or a newer save, drops it. */
export interface HistoryViewRead {
  generation: number;
  /** When the read began (ms). */
  at: number;
}

/** The most rows a view keeps: the client asks for 400 or ten turns, whichever is more. */
export const VIEW_MAX_MESSAGES = 1200;
const MEMORY_MAX = 40;
const WRITE_COALESCE_MS = 2_000;
export const VIEW_MAX_FILES = 600;
export const VIEW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** A view written as JSON past this is not kept: its first paint would cost what it saves. */
export const VIEW_MAX_BYTES = 8 * 1024 * 1024;

const memory = new Map<string, HistoryViewSnapshot>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** Bumped by every delete: a read that began before a rewind must not save the rows it cut. */
const generations = new Map<string, number>();
/** One file write per session at a time. */
const writing = new Map<string, Promise<void>>();
let lastPruneAt = 0;
let tmpSeq = 0;

/** The session's rewind generation (bumped by every delete). */
export function historyViewGeneration(sessionId: string): number {
  return generations.get(sessionId) ?? 0;
}

/** Capture before the read whose result will be saved; pass it to saveHistoryView. */
export function beginHistoryViewRead(sessionId: string, now = Date.now()): HistoryViewRead {
  return { generation: historyViewGeneration(sessionId), at: now };
}

/** The kept view's read began after this one's: this one holds older content. */
export const olderThanKept = (keptAt: number | undefined, at: number): boolean => keptAt !== undefined && keptAt > at;

function remember(sessionId: string, view: HistoryViewSnapshot): void {
  memory.delete(sessionId);
  memory.set(sessionId, view);
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string);
}

function viewsDir(): string { return path.join(HISTORY_CACHE_DIR, 'views'); }
function viewPath(sessionId: string): string { return path.join(viewsDir(), `${sessionId}.json`); }
function metaPath(sessionId: string): string { return path.join(viewsDir(), `${sessionId}.meta`); }

/**
 * Keep `view` as the session's first paint, unless a rewind moved the generation since `read` or
 * the kept view comes from a later read. Only the newest `VIEW_MAX_MESSAGES` rows are kept.
 * Returns whether it was taken (the disk copy is checked again when it is written).
 */
export function saveHistoryView(sessionId: string, view: Omit<HistoryViewSnapshot, 'savedAt' | 'contentAt'>, read: HistoryViewRead): boolean {
  if (view.messages.length === 0 || read.generation !== historyViewGeneration(sessionId)) return false;
  if (olderThanKept(memory.get(sessionId)?.contentAt, read.at)) return false;
  const drop = Math.max(0, view.messages.length - VIEW_MAX_MESSAGES);
  const boundary = view.forkBoundaryIndex != null && view.forkBoundaryIndex >= drop ? view.forkBoundaryIndex - drop : undefined;
  const kept: HistoryViewSnapshot = {
    messages: drop > 0 ? view.messages.slice(drop) : view.messages,
    total: view.total,
    ...(view.windowed ? { windowed: true } : {}),
    ...(view.forkedFromSessionId ? { forkedFromSessionId: view.forkedFromSessionId } : {}),
    ...(boundary != null ? { forkBoundaryIndex: boundary } : {}),
    ...(view.initialUserText ? { initialUserText: view.initialUserText } : {}),
    ...(view.finishedAgentIds?.length ? { finishedAgentIds: view.finishedAgentIds } : {}),
    ...(view.origin === 'ready' && view.readyKey ? { readyKey: view.readyKey, origin: 'ready' as const } : {}),
    contentAt: read.at,
    savedAt: new Date().toISOString(),
  };
  remember(sessionId, kept);
  if (pending.has(sessionId)) return true;
  const timer = setTimeout(() => {
    pending.delete(sessionId);
    const prev = writing.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => flush(sessionId)).finally(() => { if (writing.get(sessionId) === next) writing.delete(sessionId); });
    writing.set(sessionId, next);
  }, WRITE_COALESCE_MS);
  timer.unref?.();
  pending.set(sessionId, timer);
  return true;
}

/** The `.meta` on disk, whatever memory holds. */
async function readMetaFile(sessionId: string): Promise<HistoryViewMeta | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(metaPath(sessionId), 'utf-8')) as Partial<HistoryViewMeta>;
    if (typeof parsed?.savedAt !== 'string') return null;
    return {
      savedAt: parsed.savedAt,
      ...(typeof parsed.readyKey === 'string' ? { readyKey: parsed.readyKey } : {}),
      ...(typeof parsed.contentAt === 'number' && Number.isFinite(parsed.contentAt) ? { contentAt: parsed.contentAt } : {}),
    };
  } catch {
    return null;
  }
}

const metaOf = (view: HistoryViewSnapshot): HistoryViewMeta => ({
  savedAt: view.savedAt,
  ...(view.readyKey ? { readyKey: view.readyKey } : {}),
  ...(view.contentAt !== undefined ? { contentAt: view.contentAt } : {}),
});

async function flush(sessionId: string): Promise<void> {
  const view = memory.get(sessionId);
  if (!view) return;
  const generation = historyViewGeneration(sessionId);
  const tmp = `${viewPath(sessionId)}.${process.pid}.${++tmpSeq}.tmp`;
  // Memory may have lost the newer view (evicted, a restart): the disk copy decides then.
  const onDisk = view.contentAt !== undefined ? await readMetaFile(sessionId) : null;
  if (onDisk && olderThanKept(onDisk.contentAt, view.contentAt!)) {
    if (memory.get(sessionId) === view) memory.delete(sessionId);
    return;
  }
  try {
    const payload = JSON.stringify({ schema: HISTORY_CACHE_SCHEMA, ...view });
    if (payload.length > VIEW_MAX_BYTES) {
      memory.delete(sessionId);
      log.session.debug('history view too large to keep', { sessionId, bytes: payload.length });
      return;
    }
    await fsp.mkdir(viewsDir(), { recursive: true });
    await fsp.writeFile(tmp, payload, 'utf-8');
    // A rewind while this was written: its delete already ran, so this must not bring the rows back.
    if (generation !== historyViewGeneration(sessionId)) { await fsp.unlink(tmp).catch(() => {}); return; }
    await fsp.rename(tmp, viewPath(sessionId));
    // The meta follows its view: a route view clears a ready key the daemon gave an older one.
    await fsp.writeFile(metaPath(sessionId), JSON.stringify(metaOf(view)), 'utf-8').catch(() => {});
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    log.session.debug('history view write failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
  if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) { lastPruneAt = Date.now(); void pruneHistoryViews(); }
}

/** The session's kept view: memory, else disk; null when none or written by another parse shape. */
export async function readHistoryView(sessionId: string): Promise<HistoryViewSnapshot | null> {
  const hot = memory.get(sessionId);
  if (hot) return hot;
  try {
    const parsed = JSON.parse(await fsp.readFile(viewPath(sessionId), 'utf-8'));
    if (parsed?.schema !== HISTORY_CACHE_SCHEMA || !Array.isArray(parsed.messages) || parsed.messages.length === 0) return null;
    const { schema: _schema, ...view } = parsed as HistoryViewSnapshot & { schema: number };
    if (typeof view.total !== 'number') return null;
    remember(sessionId, view);
    return view;
  } catch {
    return null;
  }
}

/**
 * When the session's view was written and its ready key, without reading the view: memory, else
 * the `.meta` beside it. null when there is no view, or only one an older Walnut wrote (no meta).
 */
export async function readHistoryViewMeta(sessionId: string): Promise<HistoryViewMeta | null> {
  const hot = memory.get(sessionId);
  if (hot) return metaOf(hot);
  const meta = await readMetaFile(sessionId);
  if (!meta) return null;
  // A meta whose view is gone (pruned, deleted at a rewind) describes nothing.
  try { await fsp.access(viewPath(sessionId)); } catch { return null; }
  return meta;
}

/** Forget the session's view: its parse became wrong without new bytes (a rewind). */
export async function deleteHistoryView(sessionId: string): Promise<void> {
  generations.set(sessionId, historyViewGeneration(sessionId) + 1);
  memory.delete(sessionId);
  const timer = pending.get(sessionId);
  if (timer) { clearTimeout(timer); pending.delete(sessionId); }
  try { await fsp.unlink(viewPath(sessionId)); } catch { /* already gone */ }
  try { await fsp.unlink(metaPath(sessionId)); } catch { /* already gone */ }
}

/** Drop views older than `maxAgeMs`, then the oldest past `maxFiles`. Never throws. */
export async function pruneHistoryViews(opts: { maxAgeMs?: number; maxFiles?: number; now?: number } = {}): Promise<number> {
  const maxAgeMs = opts.maxAgeMs ?? VIEW_MAX_AGE_MS;
  const maxFiles = opts.maxFiles ?? VIEW_MAX_FILES;
  const now = opts.now ?? Date.now();
  let removed = 0;
  try {
    const entries: Array<{ file: string; mtimeMs: number }> = [];
    for (const name of await fsp.readdir(viewsDir())) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
      const file = path.join(viewsDir(), name);
      try { entries.push({ file, mtimeMs: (await fsp.stat(file)).mtimeMs }); } catch { /* vanished */ }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const [i, e] of entries.entries()) {
      if (i < maxFiles && now - e.mtimeMs <= maxAgeMs) continue;
      try { await fsp.unlink(e.file); removed++; } catch { /* vanished */ }
      if (e.file.endsWith('.json')) await fsp.unlink(e.file.slice(0, -'.json'.length) + '.meta').catch(() => {});
    }
    // A meta left without its view (an older Walnut pruned the view) goes too.
    for (const name of await fsp.readdir(viewsDir())) {
      if (!name.endsWith('.meta')) continue;
      const view = path.join(viewsDir(), name.slice(0, -'.meta'.length) + '.json');
      try { await fsp.access(view); } catch { await fsp.unlink(path.join(viewsDir(), name)).catch(() => {}); }
    }
  } catch { /* no dir yet */ }
  return removed;
}

/** Tests: drop memory and pending writes. */
export function _resetHistoryViewsForTesting(): void {
  memory.clear();
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  generations.clear();
  writing.clear();
  lastPruneAt = 0;
}

/** Tests: write every pending view now. */
export async function flushHistoryViewsForTesting(): Promise<void> {
  const ids = [...pending.keys()];
  for (const id of ids) { clearTimeout(pending.get(id)!); pending.delete(id); await flush(id); }
}
