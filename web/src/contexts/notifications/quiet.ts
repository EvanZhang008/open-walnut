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

/** The state the console last heard, for a gate outside React (a system notification). */
let lastQuiet: QuietState = NOT_QUIET;
export function currentQuiet(): QuietState {
  return lastQuiet;
}

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
  // This window's own toggle answers with the state it made. Usually a quiet:changed follows, but
  // a test run's toggle stays in its own copy on the server and publishes nothing.
  useEffect(() => {
    const onLocal = (e: Event) => { sawEvent.current = true; setQuiet((e as CustomEvent<QuietState>).detail); };
    window.addEventListener(LOCAL_QUIET_EVENT, onLocal);
    return () => window.removeEventListener(LOCAL_QUIET_EVENT, onLocal);
  }, []);
  lastQuiet = quiet;
  return quiet;
}

const LOCAL_QUIET_EVENT = 'walnut:quiet-set';

/** The human's own toggle (source `user`). Other holds are untouched. */
export async function setUserQuiet(on: boolean, minutes?: number): Promise<QuietState> {
  const body = on ? { on: true, ...(minutes ? { minutes } : {}) } : { on: false };
  const state = normalizeQuiet(await apiPut<unknown>('/api/quiet', body));
  window.dispatchEvent(new CustomEvent<QuietState>(LOCAL_QUIET_EVENT, { detail: state }));
  return state;
}
