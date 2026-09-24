import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchBacklinks } from '@/api/notes-v2';
import type { BacklinkResult } from '@/api/notes-v2';
import { useEvent } from '@/hooks/useWebSocket';

/** Collapse a burst of saves (autosave fires every ~500ms of typing) into one refetch. */
const REFRESH_DEBOUNCE_MS = 1200;

/**
 * Opening a note mounts this hook twice in quick succession: the outgoing panel
 * sees the new path before it unmounts, then the panel remounts once the
 * content has loaded. Both asked the server. A result younger than this is
 * handed to the second caller instead; an in-flight request is shared.
 */
const REUSE_WINDOW_MS = 2000;
const recent = new Map<string, { at: number; promise: Promise<BacklinkResult[]> }>();

function loadBacklinks(notePath: string, fresh: boolean): Promise<BacklinkResult[]> {
  const hit = recent.get(notePath);
  if (!fresh && hit && Date.now() - hit.at < REUSE_WINDOW_MS) return hit.promise;
  const promise = fetchBacklinks(notePath);
  recent.set(notePath, { at: Date.now(), promise });
  promise.catch(() => { if (recent.get(notePath)?.promise === promise) recent.delete(notePath); });
  return promise;
}

export function useBacklinks(notePath: string | null) {
  const [backlinks, setBacklinks] = useState<BacklinkResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set right before a refresh bumps `version`, consumed by the effect run it
  // causes: only THAT run bypasses the reuse window. A path change on an
  // instance that refreshed earlier is an ordinary open and shares the request.
  const refreshPendingRef = useRef(false);

  useEffect(() => {
    if (!notePath) {
      setBacklinks([]);
      return;
    }

    setLoading(true);
    let cancelled = false;

    // A refresh must bypass the reuse window: it exists because the answer changed.
    const fresh = refreshPendingRef.current;
    refreshPendingRef.current = false;
    loadBacklinks(notePath, fresh)
      .then((data) => { if (!cancelled) setBacklinks(data); })
      .catch(() => { if (!cancelled) setBacklinks([]); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [notePath, version]);

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      refreshPendingRef.current = true;
      setVersion((n) => n + 1);
    }, REFRESH_DEBOUNCE_MS);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  /**
   * A note was written ANYWHERE in the vault — which is exactly when this note's
   * inbound links can change (a link added to it, or removed). The list used to
   * be fetched once per `notePath` and then stayed frozen for the whole mount, so
   * a link written in the very next breath never showed up. Debounced, because
   * the editor autosaves every ~500ms of typing and the index reconciles behind
   * that; the refetch is one small indexed query.
   */
  useEvent('notes:updated', () => {
    if (!notePath) return;
    scheduleRefresh();
  });

  return { backlinks, loading };
}
