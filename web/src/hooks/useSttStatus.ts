/**
 * Cached STT status hook.
 * Module-level cache shared across all MicButton instances.
 * Refreshes at most every 60s (success) or 10s (error/timeout).
 */

import { useState, useEffect } from 'react';
import { fetchSttStatus, type SttStatus, type QwenSetupStatus } from '@/api/stt';
import { visibleInterval } from '@/utils/page-visibility';

interface SttStatusState {
  /** The engine the status is about (null when none is configured) */
  engine: string | null;
  /** An STT engine is configured in settings */
  isConfigured: boolean;
  /** The configured engine is available (binary/model found) */
  isAvailable: boolean;
  /** Human-readable error if not configured or not available */
  error: string | null;
  /** Still loading initial status */
  isLoading: boolean;
  /** The voice model the server installs for itself */
  setup: QwenSetupStatus | null;
}

// Module-level cache — shared by all hook consumers
let cachedStatus: SttStatus | null = null;
// The last status that named a working engine. Survives invalidation, so a fetch
// that fails right after a settings refresh still answers with what worked.
let lastGoodStatus: SttStatus | null = null;
let cacheTimestamp = 0;
let cacheIsError = false;
let fetchPromise: Promise<SttStatus> | null = null;
const CACHE_TTL_MS = 60_000;
const ERROR_RETRY_MS = 10_000;

function isStale(): boolean {
  if (!cachedStatus) return true;
  const ttl = cacheIsError ? ERROR_RETRY_MS : CACHE_TTL_MS;
  return Date.now() - cacheTimestamp > ttl;
}

/** The cached status read every mic shares (exported for tests). */
export async function getStatus(): Promise<SttStatus> {
  if (!isStale() && cachedStatus) return cachedStatus;

  // Deduplicate in-flight requests
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetchSttStatus()
    .then((s) => {
      cachedStatus = s;
      // A read that names no engine is the user's own "voice off": forget the
      // working one, so a later failed read cannot bring it back.
      if (s.engine && s.available) lastGoodStatus = s;
      else if (!s.engine) lastGoodStatus = null;
      cacheTimestamp = Date.now();
      cacheIsError = false;
      fetchPromise = null;
      announce();
      return s;
    })
    .catch((err) => {
      fetchPromise = null;
      cacheTimestamp = Date.now();
      cacheIsError = true;
      // Stale-while-error: a transient /status fetch failure (browser congestion,
      // 15s timeout) must NOT flip a working engine to "not configured" — that used
      // to disable the mic mid-recording. Keep the last good status; the short
      // error TTL retries soon.
      if (cachedStatus?.engine) { announce(); return cachedStatus; }
      if (lastGoodStatus) {
        cachedStatus = lastGoodStatus;
        announce();
        return lastGoodStatus;
      }
      const fallback: SttStatus = { engine: null, available: false, error: String(err) };
      cachedStatus = fallback;
      announce();
      return fallback;
    });

  return fetchPromise;
}

/**
 * Whether a mic control should treat voice as unavailable. Every mic button
 * decides through here (tests/web/stt-unavailable-ratchet.test.ts): while it is
 * recording or transcribing, nothing the status read says can block it.
 */
export function sttBlocksMic(status: Pick<SttStatusState, 'isLoading' | 'isConfigured' | 'isAvailable'>, busy: boolean): boolean {
  if (busy || status.isLoading) return false;
  return !status.isConfigured || !status.isAvailable;
}

/** Invalidate the cache (e.g. after saving settings). */
export function invalidateSttStatusCache(): void {
  cachedStatus = null;
  cacheTimestamp = 0;
  cacheIsError = false;
}

// Notify all mounted hooks to re-check
let listeners: Array<() => void> = [];
function subscribe(fn: () => void) {
  listeners.push(fn);
  return () => { listeners = listeners.filter(l => l !== fn); };
}

/** Every mounted mic shows the read that just came back: each kept its own copy
 *  until its next re-check, so mics in one view said "Voice input" and "Set up
 *  dictation" at once (2026-11-10, the review column's reply boxes). */
function announce(): void {
  queueMicrotask(() => { for (const fn of [...listeners]) fn(); });
}

/** Invalidate cache and notify all mounted MicButtons to refresh. */
export function refreshSttStatus(): void {
  invalidateSttStatusCache();
  listeners.forEach(fn => fn());
}

export function useSttStatus(): SttStatusState {
  const [status, setStatus] = useState<SttStatus | null>(cachedStatus);
  const [loading, setLoading] = useState(!cachedStatus);

  const doFetch = () => {
    if (!isStale() && cachedStatus) {
      setStatus(cachedStatus);
      setLoading(false);
      return;
    }
    // A stale read shows while it is read again: a mic mounted then would say
    // "Voice input" (loading) beside mics that show the last read.
    if (cachedStatus) setStatus(cachedStatus);
    setLoading(!cachedStatus);
    getStatus().then((s) => {
      setStatus(s);
      setLoading(false);
    });
  };

  useEffect(() => {
    doFetch();

    // Re-fetch when cache is invalidated externally
    const unsub = subscribe(doFetch);

    // Periodic re-check: if error cached, retry after ERROR_RETRY_MS.
    // visibleInterval: an error-state hidden tab must not retry every 10s forever.
    const cancel = visibleInterval(() => {
      if (isStale()) doFetch();
    }, ERROR_RETRY_MS);

    return () => { unsub(); cancel(); };
  }, []);

  const isConfigured = !!status?.engine;
  const isAvailable = !!status?.available;
  const error = !status
    ? null
    : !isConfigured
      ? 'No STT engine configured. Go to Settings → Voice.'
      : !isAvailable
        ? status.error ?? 'STT engine not available'
        : null;

  return { engine: status?.engine ?? null, isConfigured, isAvailable, error, isLoading: loading, setup: status?.setup ?? null };
}
