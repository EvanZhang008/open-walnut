/**
 * Quiet mode, React side: load the server's state once, then follow
 * `quiet:changed`. The model (types, gating, labels) is quiet-model.ts.
 */
import { useEffect, useRef, useState } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { apiPut } from '@/api/client';
import { log } from '@/utils/log';
import { testRunLabel } from '@/api/test-run';
import { UNKNOWN_QUIET, normalizeQuiet, type QuietState } from './quiet-model';

export * from './quiet-model';

/** The state the console last heard, for a gate outside React (a system notification). */
let lastQuiet: QuietState = UNKNOWN_QUIET;
export function currentQuiet(): QuietState {
  return lastQuiet;
}

const quietListeners = new Set<(state: QuietState) => void>();
/** Hear every state the console settles on (outside React: the system notice exit). */
export function onQuietState(fn: (state: QuietState) => void): () => void {
  quietListeners.add(fn);
  return () => { quietListeners.delete(fn); };
}

/** Load once, then follow `quiet:changed`. */
function loadQuiet(signal: AbortSignal): Promise<QuietState> {
  // Bounded: an answer that never comes must not keep the state unknown (and notices held).
  const timeout = AbortSignal.timeout?.(10_000);
  const both = timeout && 'any' in AbortSignal ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([signal, timeout]) : signal;
  return fetch('/api/quiet', { signal: both })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(normalizeQuiet);
}

export function useQuietState(): QuietState {
  const [quiet, setQuiet] = useState<QuietState>(UNKNOWN_QUIET);
  // A live event is newer than a GET still in flight: the late GET must not undo it.
  const sawEvent = useRef(false);
  // Read again on every reconnect: the server may have restarted under the page.
  const [epoch, setEpoch] = useState(0);
  useEvent('_ws:reconnected', () => { sawEvent.current = false; setEpoch(e => e + 1); });
  useEffect(() => {
    const ac = new AbortController();
    loadQuiet(ac.signal)
      .then(state => { if (!sawEvent.current) setQuiet(state); })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        log.warn('notifications', 'quiet state load failed', { error: String(err) });
        // Known as best it can be: an unreadable state must not hold notices back for good.
        setQuiet(prev => (prev.unknown ? { ...prev, unknown: false } : prev));
      });
    return () => ac.abort();
  }, [epoch]);
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
  useEffect(() => {
    for (const fn of quietListeners) {
      try { fn(quiet); } catch (err) { log.warn('notifications', 'quiet listener failed', { error: String(err) }); }
    }
  }, [quiet]);
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
