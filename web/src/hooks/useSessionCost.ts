/**
 * The session's cost as the picker shows it (SessionCostStore): the last known number in the
 * first frame, brought current by a read while the picker is open, and warmed before it opens
 * by the session panel's pill.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { fetchSessionCost } from '@/api/session-cost';
import { SessionCostStore, type SessionCostSnapshot } from '@/stores/session-cost-store';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';

function browserStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export const sessionCostStore = new SessionCostStore({
  fetch: (sessionId, signal) => fetchSessionCost(sessionId, signal).catch((err: unknown) => {
    if (!signal.aborted) log.warn('session-cost', 'cost fetch failed', { sessionId, error: String(err) });
    throw err;
  }),
}, browserStorage());

const PENDING_RETRIES = 20;
const PENDING_RETRY_MS = 2_000;
/** A pill that mounts again soon after a read does not read again. */
const WARM_AGAIN_MS = 30_000;
/** After a turn ends, wait for its last lines before reading the cost again. */
const TURN_END_DEBOUNCE_MS = 5_000;
const NONE: SessionCostSnapshot = { cost: null, error: null };
interface Bindings { subscribe: (listener: () => void) => () => void; getSnapshot: () => SessionCostSnapshot }
const NO_SESSION: Bindings = { subscribe: () => () => {}, getSnapshot: () => NONE };
/** One stable subscribe/getSnapshot pair per session, held by no render. */
const bindings = new Map<string, Bindings>();
const BINDINGS_MAX = 200;
function bindingsOf(sessionId: string | null): Bindings {
  if (!sessionId) return NO_SESSION;
  let b = bindings.get(sessionId);
  if (!b) {
    b = { subscribe: (listener) => sessionCostStore.subscribe(sessionId, listener), getSnapshot: () => sessionCostStore.getSnapshot(sessionId) };
    bindings.set(sessionId, b);
    // Kept like the store's own views: a dropped pair is made again on the next render.
    if (bindings.size > BINDINGS_MAX) bindings.delete(bindings.keys().next().value as string);
  }
  return b;
}
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** The session's cost, read while mounted (the picker's Cost toggle and its fold share one
 *  read); `null` reads nothing. A long first read answers `pending`: asked again until it lands. */
export function useSessionCost(sessionId: string | null): SessionCostSnapshot {
  const { subscribe, getSnapshot } = bindingsOf(sessionId);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A closed picker gives its slot back at once (the low-priority lane holds two requests),
    // unless the pill's warm-up still waits on the same read.
    const abort = new AbortController();
    const load = (attempt: number) => {
      void sessionCostStore.refresh(sessionId, abort.signal).then((c) => {
        if (cancelled || !c) return;
        if (c.status === 'pending' && attempt < PENDING_RETRIES) timer = setTimeout(() => load(attempt + 1), PENDING_RETRY_MS);
      });
    };
    load(0);
    return () => { cancelled = true; clearTimeout(timer); abort.abort(); };
  }, [sessionId]);
  return snapshot;
}

/**
 * Warm the session's cost before the picker opens: when the pill mounts and when its tab is shown
 * (not again within WARM_AGAIN_MS of a read), and a few seconds after each of the session's turns
 * ends, only while the page is visible. Warm-ups queue one at a time across the page and are
 * dropped when the pill leaves. `null` warms nothing (a draft with no session yet).
 */
export function useSessionCostPrefetch(sessionId: string | null): void {
  const live = useRef<{ signal: AbortSignal; timer?: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const abort = new AbortController();
    const state: { signal: AbortSignal; timer?: ReturnType<typeof setTimeout> } = { signal: abort.signal };
    live.current = state;
    const warm = () => {
      if (!visible() || Date.now() - sessionCostStore.readAt(sessionId) < WARM_AGAIN_MS) return;
      sessionCostStore.prefetch(sessionId, abort.signal);
    };
    warm();
    // A tab hidden through turns is brought current when shown again (the guard keeps it to one read).
    document.addEventListener('visibilitychange', warm);
    return () => {
      document.removeEventListener('visibilitychange', warm);
      clearTimeout(state.timer);
      abort.abort();
      if (live.current === state) live.current = null;
    };
  }, [sessionId]);
  useEvent('session:result', (event) => {
    const state = live.current;
    if (!sessionId || !state || (event as { sessionId?: string } | null)?.sessionId !== sessionId) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (visible()) sessionCostStore.prefetch(sessionId, state.signal);
    }, TURN_END_DEBOUNCE_MS);
  });
}
