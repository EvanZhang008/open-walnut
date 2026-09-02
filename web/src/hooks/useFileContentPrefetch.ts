/**
 * Hover prefetch for the Files tree — the FIRST open of a file is instant too.
 *
 * `cache/filecontent-idb` makes re-opening a file instant, but the first open of
 * one still waits for a round trip (over the SSH tunnel, for a remote session).
 * The pointer resting on a row is the cheapest possible signal that the row is
 * about to be clicked, and it arrives a few hundred milliseconds early — enough
 * for the read to be finished before the click lands.
 *
 * Everything here is bounded, because speculative I/O over a tunnel is exactly
 * the kind of thing that turns into a storm:
 *   - a dwell delay, so scrolling the pointer across forty rows prefetches none
 *     of them;
 *   - one request in flight at a time, and the queue is only ever the LAST row
 *     hovered (an older hover is no longer a prediction of anything);
 *   - files the pane renders from raw bytes are skipped entirely — they never go
 *     through this endpoint, so a prefetch would read a whole video for nothing;
 *   - a size ceiling, using the size the listing already reported when it has one;
 *   - one attempt per path per panel, so a pointer moving back and forth costs
 *     nothing after the first.
 *
 * `track` is deliberately NOT sent: hovering a row is not opening a file, and a
 * history "Opened" entry for a file the user only passed over would be a lie in
 * the timeline.
 */
import { useCallback, useEffect, useRef } from 'react';
import { fetchFileContentConditional } from '@/api/files';
import {
  getCachedFileContent, setCachedFileContent, storable, MAX_CACHED_CONTENT_BYTES,
} from '@/cache/filecontent-idb';
import { rawKind } from '@/utils/file-kind';

/** Pointer dwell before a hover counts as intent. Long enough to survive a
 *  sweep across the tree, short enough to still beat the click. */
export const PREFETCH_DWELL_MS = 140;
/** Paths attempted per panel, so the "attempted" set cannot grow without bound. */
export const PREFETCH_MEMORY = 400;

export interface FileContentPrefetch {
  /** The pointer is resting on a file row. */
  hover: (path: string, size?: number) => void;
  /** The pointer left the row (or the tree) — drop a not-yet-fired intent. */
  cancel: () => void;
}

/**
 * `enabled: false` turns every call into a no-op — used to stay quiet while the
 * panel is hidden or a host is known to be unreachable.
 */
export function useFileContentPrefetch(
  host: string | undefined,
  enabled = true,
): FileContentPrefetch {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const attemptedRef = useRef(new Set<string>());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const hostRef = useRef(host);

  // A different host is a different filesystem: what was already attempted there
  // says nothing here.
  useEffect(() => {
    if (hostRef.current !== host) {
      hostRef.current = host;
      attemptedRef.current = new Set();
    }
  }, [host]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const run = useCallback(async (path: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const cached = await getCachedFileContent(host, path);
      const res = await fetchFileContentConditional(path, host, {
        ...(cached ? { ifNoneMatch: cached.contentHash } : {}),
      });
      // 304 → what we have is current, nothing to store. 200 → store it if it is
      // the kind of payload a paint could ever use.
      if (!res.notModified && res.payload && storable(res.payload)) {
        await setCachedFileContent(host, path, res.payload);
      }
    } catch {
      // A prefetch is a guess. A failed guess must be silent — the click that
      // follows does the real read and reports any real error itself.
    } finally {
      inFlightRef.current = false;
    }
  }, [host]);

  const hover = useCallback((path: string, size?: number) => {
    if (!enabledRef.current) return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    // Nothing to fetch for these: the pane renders them straight from the raw
    // bytes URL and never calls this endpoint.
    if (rawKind(path)) return;
    // `size` is only known for local listings (the daemon's fs.ls returns just
    // name+type), so an unknown size is not a reason to skip: the server's own
    // read caps what it will serve, and storable() drops anything too big.
    if (size != null && size > MAX_CACHED_CONTENT_BYTES) return;
    if (attemptedRef.current.has(path)) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!enabledRef.current || attemptedRef.current.has(path)) return;
      if (attemptedRef.current.size >= PREFETCH_MEMORY) attemptedRef.current.clear();
      attemptedRef.current.add(path);
      void run(path);
    }, PREFETCH_DWELL_MS);
  }, [run]);

  const cancel = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  return { hover, cancel };
}
