/**
 * Quiet mode, React side: load the server's state once, then follow
 * `quiet:changed`. The model (types, gating, labels) is quiet-model.ts.
 */
import { useEffect, useRef, useState } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { apiPut } from '@/api/client';
import { log } from '@/utils/log';
import { testRunLabel } from '@/api/test-run';
import { NOT_QUIET, normalizeQuiet, type QuietState } from './quiet-model';

export * from './quiet-model';

/** The state the console last heard, for a gate outside React (a system notification). */
let lastQuiet: QuietState = NOT_QUIET;
export function currentQuiet(): QuietState {
  return lastQuiet;
}

/** Load once, then follow `quiet:changed`. */
function loadQuiet(signal: AbortSignal): Promise<QuietState> {
  return fetch('/api/quiet', { signal })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(normalizeQuiet);
}

export function useQuietState(): QuietState {
  const [quiet, setQuiet] = useState<QuietState>(NOT_QUIET);
  // A live event is newer than a GET still in flight: the late GET must not undo it.
  const sawEvent = useRef(false);
  useEffect(() => {
    const ac = new AbortController();
    loadQuiet(ac.signal)
      .then(state => { if (!sawEvent.current) setQuiet(state); })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        log.warn('notifications', 'quiet state load failed', { error: String(err) });
      });
    return () => ac.abort();
  }, []);
  useEvent('quiet:changed', (data) => {
    sawEvent.current = true;
    // A test run's own hold lives only in its copy on the server: the published state lacks it,
    // so the run reads its view again (the user's live holds with its own on top).
    if (testRunLabel()) {
      loadQuiet(new AbortController().signal).then(setQuiet).catch(() => { /* keep the last state */ });
      return;
    }
    setQuiet(normalizeQuiet(data));
  });
  // A test run's toggle publishes no quiet:changed (it stays in the run's copy), so its window
  // takes the toggle's own answer. A real toggle is followed by the event, which wins.
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
  if (testRunLabel()) window.dispatchEvent(new CustomEvent<QuietState>(LOCAL_QUIET_EVENT, { detail: state }));
  return state;
}
