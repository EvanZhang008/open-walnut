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
 * Writes are fire-and-forget (async, non-blocking). Reads are synchronous-style
 * (awaited) but fast (local disk). A missing, corrupt or out-of-date file returns
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
 */
const HISTORY_CACHE_SCHEMA = 2;

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
  const payload = JSON.stringify({
    schema: HISTORY_CACHE_SCHEMA,
    messages,
    cachedAt: new Date().toISOString(),
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
    // Orphan finished-agent ids (see session-history.ts getOrphanFinishedAgentIds):
    // proof that lives OUTSIDE the messages array, so it must be persisted
    // explicitly or a post-restart disk-cache hit silently drops it.
    ...(finishedAgentIds && finishedAgentIds.length > 0 ? { finishedAgentIds: [...finishedAgentIds] } : {}),
  });
  ensureDir()
    .then(() => fsp.writeFile(cachePath(sessionId), payload, 'utf-8'))
    .catch((err) => {
      log.session.debug('history disk cache write failed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * Delete a session's disk cache entry. Used when the cached parse became WRONG
 * without the source file changing (in-place rewind: same bytes + mtime, new
 * meaning) — the mtime fast-path would otherwise serve it forever.
 */
export async function deleteHistoryCache(sessionId: string): Promise<void> {
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
