import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchBacklinks } from '@/api/notes-v2';
import type { BacklinkResult } from '@/api/notes-v2';
import { useEvent } from '@/hooks/useWebSocket';

/** Collapse a burst of saves (autosave fires every ~500ms of typing) into one refetch. */
const REFRESH_DEBOUNCE_MS = 1200;

export function useBacklinks(notePath: string | null) {
  const [backlinks, setBacklinks] = useState<BacklinkResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!notePath) {
      setBacklinks([]);
      return;
    }

    setLoading(true);
    let cancelled = false;

    fetchBacklinks(notePath)
      .then((data) => { if (!cancelled) setBacklinks(data); })
      .catch(() => { if (!cancelled) setBacklinks([]); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [notePath, version]);

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
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
