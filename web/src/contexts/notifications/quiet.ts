/**
 * Quiet mode, React side: load the server's state once, then follow
 * `quiet:changed`. The model (types, gating, labels) is quiet-model.ts.
 */
import { useEffect, useRef, useState } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { apiPut } from '@/api/client';
import { log } from '@/utils/log';
import { NOT_QUIET, normalizeQuiet, type QuietState } from './quiet-model';

export * from './quiet-model';

/** Load once, then follow `quiet:changed`. */
export function useQuietState(): QuietState {
  const [quiet, setQuiet] = useState<QuietState>(NOT_QUIET);
  // A live event is newer than a GET still in flight: the late GET must not undo it.
  const sawEvent = useRef(false);
  useEffect(() => {
    const ac = new AbortController();
    fetch('/api/quiet', { signal: ac.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => { if (!sawEvent.current) setQuiet(normalizeQuiet(data)); })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        log.warn('notifications', 'quiet state load failed', { error: String(err) });
      });
    return () => ac.abort();
  }, []);
  useEvent('quiet:changed', (data) => { sawEvent.current = true; setQuiet(normalizeQuiet(data)); });
  return quiet;
}

/** The human's own toggle (source `user`). Other holds are untouched. */
export async function setUserQuiet(on: boolean, minutes?: number): Promise<QuietState> {
  const body = on ? { on: true, ...(minutes ? { minutes } : {}) } : { on: false };
  return normalizeQuiet(await apiPut<unknown>('/api/quiet', body));
}
