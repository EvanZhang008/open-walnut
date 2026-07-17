/**
 * Persistent disk cache for session history.
 *
 * Stores the last-good parsed history per session so that after an app restart
 * (in-memory cache gone) or when a remote JSONL is temporarily unavailable,
 * we can still show the user their conversation instead of "No history found".
 *
 * Files: ~/.open-walnut/cache/history/<sessionId>.json
 * Format: { messages: SessionHistoryMessage[], cachedAt: ISO string }
 *
 * Writes are fire-and-forget (async, non-blocking). Reads are synchronous-style
 * (awaited) but fast (local disk). A missing or corrupt file returns null.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_CACHE_DIR } from '../constants.js';
import { log } from '../logging/index.js';
import type { SessionHistoryMessage } from './session-history.js';

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
 */
export function writeHistoryCache(sessionId: string, messages: SessionHistoryMessage[]): void {
  if (messages.length === 0) return;
  const payload = JSON.stringify({ messages, cachedAt: new Date().toISOString() });
  ensureDir()
    .then(() => fsp.writeFile(cachePath(sessionId), payload, 'utf-8'))
    .catch((err) => {
      log.session.debug('history disk cache write failed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * Read cached history from disk. Returns null if no cache or on error.
 */
export async function readHistoryCache(sessionId: string): Promise<{ messages: SessionHistoryMessage[]; cachedAt: string } | null> {
  try {
    const raw = await fsp.readFile(cachePath(sessionId), 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
      return { messages: parsed.messages, cachedAt: parsed.cachedAt ?? 'unknown' };
    }
  } catch {
    // File doesn't exist or is corrupt — no cache available
  }
  return null;
}
