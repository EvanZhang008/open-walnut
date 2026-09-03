/**
 * Cached STT status hook.
 * Module-level cache shared across all MicButton instances.
 * Refreshes at most every 60s (success) or 10s (error/timeout).
 */

import { useState, useEffect } from 'react';
import { fetchSttStatus, type SttStatus } from '@/api/stt';
import { visibleInterval } from '@/utils/page-visibility';

interface SttStatusState {
  /** An STT engine is configured in settings */
  isConfigured: boolean;
  /** The configured engine is available (binary/model found) */
  isAvailable: boolean;
  /** Human-readable error if not configured or not available */
  error: string | null;
  /** Still loading initial status */
  isLoading: boolean;
}

// Module-level cache — shared by all hook consumers
let cachedStatus: SttStatus | null = null;
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

async function getStatus(): Promise<SttStatus> {
  if (!isStale() && cachedStatus) return cachedStatus;

  // Deduplicate in-flight requests
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetchSttStatus()
    .then((s) => {
      cachedStatus = s;
      cacheTimestamp = Date.now();
      cacheIsError = false;
      fetchPromise = null;
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
      if (cachedStatus?.engine) return cachedStatus;
      const fallback: SttStatus = { engine: null, available: false, error: String(err) };
      cachedStatus = fallback;
      return fallback;
    });

  return fetchPromise;
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
    setLoading(true);
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

  return { isConfigured, isAvailable, error, isLoading: loading };
}
