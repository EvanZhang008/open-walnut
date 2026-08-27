/**
 * In-memory session index powering the composer's "@" session picker.
 *
 * The picker must filter with ZERO per-keystroke latency, so the candidate set
 * lives in the browser: one light fetch (/api/sessions/mention-index — id,
 * title, host, status, lastActiveAt only; no live-status/hostname enrichment)
 * cached module-wide with a short TTL. Live process status is merged at render
 * time from the WS-fed sessionStatusStore, so the dots stay fresh without
 * refetching.
 */

import { apiGet } from '@/api/client';
import type { SessionMentionCandidate } from '@/components/chat/session-mention';
import { sessionStatusStore } from '@/stores/session-status-store';
import { log } from '@/utils/log';

const TTL_MS = 30_000;

let list: SessionMentionCandidate[] = [];
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Synchronous snapshot — this is what makes the palette 0ms. */
export function getSessionMentionIndex(): SessionMentionCandidate[] {
  return list;
}

export function subscribeSessionMentionIndex(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Refresh the index if stale (TTL) or missing. Concurrent callers share one
 * request. Failures keep the previous snapshot — a stale list beats an empty
 * palette.
 */
export function ensureSessionMentionIndex(): Promise<void> {
  if (inflight) return inflight;
  if (Date.now() - fetchedAt < TTL_MS && list.length > 0) return Promise.resolve();
  inflight = apiGet<{ sessions: SessionMentionCandidate[] }>('/api/sessions/mention-index')
    .then((res) => {
      list = res.sessions ?? [];
      fetchedAt = Date.now();
      notify();
    })
    .catch((err) => {
      log.warn('session-mention', 'index fetch failed (keeping previous snapshot)', {
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Live status wins over the fetched snapshot's status (WS is fresher). */
export function liveStatusFor(candidate: SessionMentionCandidate): string {
  return sessionStatusStore.getStatus(candidate.id)?.process_status ?? candidate.status;
}

/** Test-only reset. */
export function __resetSessionMentionIndex(): void {
  list = [];
  fetchedAt = 0;
  inflight = null;
}
