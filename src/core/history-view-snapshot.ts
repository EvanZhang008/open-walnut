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
  savedAt: string;
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

/** Capture before the read whose result will be saved; pass it to saveHistoryView. */
export function historyViewGeneration(sessionId: string): number {
  return generations.get(sessionId) ?? 0;
}

function remember(sessionId: string, view: HistoryViewSnapshot): void {
  memory.delete(sessionId);
  memory.set(sessionId, view);
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string);
}

function viewsDir(): string { return path.join(HISTORY_CACHE_DIR, 'views'); }
function viewPath(sessionId: string): string { return path.join(viewsDir(), `${sessionId}.json`); }

/** Keep `view` as the session's first paint. Only the newest `VIEW_MAX_MESSAGES` rows are kept. */
export function saveHistoryView(sessionId: string, view: Omit<HistoryViewSnapshot, 'savedAt'>, generation: number): void {
  if (view.messages.length === 0 || generation !== historyViewGeneration(sessionId)) return;
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
    savedAt: new Date().toISOString(),
  };
  remember(sessionId, kept);
  if (pending.has(sessionId)) return;
  const timer = setTimeout(() => {
    pending.delete(sessionId);
    const prev = writing.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => flush(sessionId)).finally(() => { if (writing.get(sessionId) === next) writing.delete(sessionId); });
    writing.set(sessionId, next);
  }, WRITE_COALESCE_MS);
  timer.unref?.();
  pending.set(sessionId, timer);
}

async function flush(sessionId: string): Promise<void> {
  const view = memory.get(sessionId);
  if (!view) return;
  const generation = historyViewGeneration(sessionId);
  const tmp = `${viewPath(sessionId)}.${process.pid}.${++tmpSeq}.tmp`;
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

/** Forget the session's view: its parse became wrong without new bytes (a rewind). */
export async function deleteHistoryView(sessionId: string): Promise<void> {
  generations.set(sessionId, historyViewGeneration(sessionId) + 1);
  memory.delete(sessionId);
  const timer = pending.get(sessionId);
  if (timer) { clearTimeout(timer); pending.delete(sessionId); }
  try { await fsp.unlink(viewPath(sessionId)); } catch { /* already gone */ }
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
