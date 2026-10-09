/**
 * Persistent disk cache for session history.
 *
 * Stores the last-good parsed history per session so that after an app restart
 * (in-memory cache gone) or when a remote JSONL is temporarily unavailable,
 * we can still show the user their conversation instead of "No history found".
 *
 * Files: ~/.open-walnut/cache/history/<sessionId>.json
 * Format: { schema: number, messages: SessionHistoryMessage[], cachedAt: ISO string }
 *
 * Writes are fire-and-forget and coalesced per session (see WRITE_COALESCE_MS).
 * Reads are awaited but fast (local disk). A missing, corrupt or out-of-date file returns
 * null, and the caller re-parses (see HISTORY_CACHE_SCHEMA — this file outlives
 * every deploy, so a shape change here is a shape change to data already on disk).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_CACHE_DIR } from '../constants.js';
import { log } from '../logging/index.js';
import type { SessionHistoryMessage } from './session-history.js';

/**
 * Shape version of the cached parse. A file stamped with anything else is DROPPED
 * on read, so the next read re-parses the JSONL and rewrites it.
 *
 * BUMP THIS whenever the shape or the MEANING of any `SessionHistoryMessage` /
 * `SessionHistoryTool` field changes. Not just when a field is added or removed: a
 * field that becomes load-bearing counts, because an old entry omits it and every
 * reader downstream reads that omission as a fact about the session.
 *
 * Why it exists (2026-09-12, p1 on device): the mtime fast-path serves a cached
 * parse for as long as the JSONL is untouched, which for a stopped session is
 * forever. `resultChars` (absent = "this result is whole") had just become the
 * evidence a tool row's full-text read trusts, so every session parsed before that
 * change kept answering "complete" with a 5,000-character prefix of a 17,781-
 * character result: 18 of 54 real rows across 5 sessions. Version 1 is therefore
 * "written before `resultChars` was load-bearing", i.e. any file with no stamp.
 *
 * 3 (2026-10-08): `sourceUuid` on a mid-turn `queue-…` user row. Without it a
 * question sent while a turn ran has no anchor, number or title, and an idle
 * session kept serving its version-2 parse after the deploy that added it.
 */
const HISTORY_CACHE_SCHEMA = 3;

let dirEnsured = false;

async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  try {
    await fsp.mkdir(HISTORY_CACHE_DIR, { recursive: true });
    dirEnsured = true;
  } catch { /* race-safe — mkdir recursive is idempotent */ }
}

function cachePath(sessionId: string): string {
  return path.join(HISTORY_CACHE_DIR, `${sessionId}.json`);
}

/**
 * Persist session history to disk (fire-and-forget).
 * Only caches sessions with >0 messages.
 *
 * `mtimeMs` is the source JSONL's mtime at parse time. It lets the main read
 * path validate the disk entry with one cheap stat after a server restart
 * (in-memory cache cold) instead of re-fetching the whole JSONL. Absent for
 * writes from paths that had no stat (stream fallbacks) — those entries still
 * serve the offline/stale fallbacks, just not the mtime fast-path.
 */
export function writeHistoryCache(
  sessionId: string,
  messages: SessionHistoryMessage[],
  mtimeMs?: number,
  finishedAgentIds?: readonly string[],
): void {
  if (messages.length === 0) return;
  const queued = pendingWrites.get(sessionId);
  if (queued) {
    queued.messages = messages;
    queued.mtimeMs = mtimeMs;
    queued.finishedAgentIds = finishedAgentIds;
    return;
  }
  const timer = setTimeout(() => flushWrite(sessionId), WRITE_COALESCE_MS);
  timer.unref?.();
  pendingWrites.set(sessionId, { messages, mtimeMs, finishedAgentIds, timer });
}

/**
 * Writes are coalesced per session: the payload is one JSON.stringify of the
 * WHOLE parsed history (megabytes for a long session) on the event loop, and
 * the incremental read path asked for one after every turn of every tracked
 * session, so a busy board serialized the same histories many times a minute.
 * Only the newest arguments within the window are written.
 */
const WRITE_COALESCE_MS = 2_000;

interface PendingWrite {
  messages: SessionHistoryMessage[];
  mtimeMs: number | undefined;
  finishedAgentIds: readonly string[] | undefined;
  timer: ReturnType<typeof setTimeout>;
}

const pendingWrites = new Map<string, PendingWrite>();

function flushWrite(sessionId: string): void {
  const entry = pendingWrites.get(sessionId);
  pendingWrites.delete(sessionId);
  if (!entry) return;
  const payload = JSON.stringify({
    schema: HISTORY_CACHE_SCHEMA,
    messages: entry.messages,
    cachedAt: new Date().toISOString(),
    ...(entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}),
    // Orphan finished-agent ids (see session-history.ts getOrphanFinishedAgentIds):
    // proof that lives OUTSIDE the messages array, so it must be persisted
    // explicitly or a post-restart disk-cache hit silently drops it.
    ...(entry.finishedAgentIds && entry.finishedAgentIds.length > 0 ? { finishedAgentIds: [...entry.finishedAgentIds] } : {}),
  });
  ensureDir()
    .then(() => fsp.writeFile(cachePath(sessionId), payload, 'utf-8'))
    .catch((err) => {
      log.session.debug('history disk cache write failed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    });
}

/** Write every queued entry now (tests, and a shutdown that wants the cache complete). */
export function flushHistoryCacheWrites(): void {
  for (const [sessionId, entry] of [...pendingWrites]) {
    clearTimeout(entry.timer);
    flushWrite(sessionId);
  }
}

/**
 * Delete a session's disk cache entry. Used when the cached parse became WRONG
 * without the source file changing (in-place rewind: same bytes + mtime, new
 * meaning) — the mtime fast-path would otherwise serve it forever.
 */
export async function deleteHistoryCache(sessionId: string): Promise<void> {
  const queued = pendingWrites.get(sessionId);
  if (queued) {
    clearTimeout(queued.timer);
    pendingWrites.delete(sessionId);
  }
  try {
    await fsp.unlink(cachePath(sessionId));
  } catch { /* missing file = already gone */ }
}

/**
 * Read cached history from disk. Returns null if no cache, on error, or when the
 * entry was written by a different shape of this code (see HISTORY_CACHE_SCHEMA) —
 * every caller already treats null as "no cache" and re-parses.
 */
export async function readHistoryCache(sessionId: string): Promise<{ messages: SessionHistoryMessage[]; cachedAt: string; mtimeMs?: number; finishedAgentIds?: string[] } | null> {
  // A write still in its coalescing window is the newest entry there is.
  const queued = pendingWrites.get(sessionId);
  if (queued) {
    return {
      messages: queued.messages,
      cachedAt: new Date().toISOString(),
      ...(queued.mtimeMs !== undefined ? { mtimeMs: queued.mtimeMs } : {}),
      ...(queued.finishedAgentIds && queued.finishedAgentIds.length > 0 ? { finishedAgentIds: [...queued.finishedAgentIds] } : {}),
    };
  }
  try {
    const raw = await fsp.readFile(cachePath(sessionId), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== HISTORY_CACHE_SCHEMA) {
      // Not an error: an entry from before this version. Dropping it is the whole
      // mechanism — the re-parse that follows overwrites the file with today's shape.
      log.session.debug('history disk cache dropped — wrong schema', {
        sessionId, found: parsed?.schema ?? 1, expected: HISTORY_CACHE_SCHEMA,
      });
      return null;
    }
    if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
      return {
        messages: parsed.messages,
        cachedAt: parsed.cachedAt ?? 'unknown',
        ...(typeof parsed.mtimeMs === 'number' ? { mtimeMs: parsed.mtimeMs } : {}),
        ...(Array.isArray(parsed.finishedAgentIds) && parsed.finishedAgentIds.length > 0
          ? { finishedAgentIds: parsed.finishedAgentIds.filter((x: unknown): x is string => typeof x === 'string') }
          : {}),
      };
    }
  } catch {
    // File doesn't exist or is corrupt — no cache available
  }
  return null;
}

/** An entry nobody read or wrote for this long is dead weight: its JSONL is the truth. */
export const HISTORY_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Total bytes the cache dir may hold; oldest entries go first past this. */
export const HISTORY_CACHE_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Bound the cache directory. It had no eviction at all: one file per session
 * ever opened, forever. On 2026-10-02 the live dir held 4,299 files and 1.8 GB
 * (1.6 GB of it untouched for over a week) on a disk at 97%, which is the disk
 * watermark's "writes paused" condition — a cache helping to cause the outage
 * it exists to soften. Two rules, age then size, both on the file's own mtime
 * (a read does not touch it; a re-parse rewrites it, which is the refresh):
 * drop entries older than `maxAgeMs`, then the oldest until the total fits
 * `maxBytes`. Async throughout; never throws (a failed prune is a debug line).
 */
export async function pruneHistoryCache(opts: {
  maxAgeMs?: number;
  maxBytes?: number;
  now?: number;
} = {}): Promise<{ removed: number; freedBytes: number; remainingBytes: number }> {
  const maxAgeMs = opts.maxAgeMs ?? HISTORY_CACHE_MAX_AGE_MS;
  const maxBytes = opts.maxBytes ?? HISTORY_CACHE_MAX_BYTES;
  const now = opts.now ?? Date.now();
  let removed = 0;
  let freedBytes = 0;
  let remainingBytes = 0;
  try {
    const names = await fsp.readdir(HISTORY_CACHE_DIR);
    const entries: Array<{ file: string; mtimeMs: number; size: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(HISTORY_CACHE_DIR, name);
      try {
        const st = await fsp.stat(file);
        if (st.isFile()) entries.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* vanished between readdir and stat */ }
    }
    // A write still coalescing is live whatever its file's age says.
    const live = new Set([...pendingWrites.keys()].map(cachePath));
    const victims = new Set<string>();
    for (const e of entries) {
      if (!live.has(e.file) && now - e.mtimeMs > maxAgeMs) victims.add(e.file);
    }
    let total = entries.filter((e) => !victims.has(e.file)).reduce((n, e) => n + e.size, 0);
    for (const e of [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= maxBytes) break;
      if (victims.has(e.file) || live.has(e.file)) continue;
      victims.add(e.file);
      total -= e.size;
    }
    for (const e of entries) {
      if (!victims.has(e.file)) continue;
      try {
        await fsp.unlink(e.file);
        removed++;
        freedBytes += e.size;
      } catch { /* already gone */ }
    }
    remainingBytes = total;
    if (removed > 0) {
      log.session.info('history disk cache pruned', { removed, freedBytes, remainingBytes, maxAgeMs, maxBytes });
    }
  } catch (err) {
    log.session.debug('history disk cache prune skipped', { error: err instanceof Error ? err.message : String(err) });
  }
  return { removed, freedBytes, remainingBytes };
}
