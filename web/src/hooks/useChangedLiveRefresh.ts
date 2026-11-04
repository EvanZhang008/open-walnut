/**
 * Keeps an open Changed tab current while its session works, without a button.
 *
 * It re-reads when:
 *   - the session's git state moved (`session:git-status`: the server re-reads a
 *     watched session's repos after its tool calls, session-git-status.ts),
 *   - the session's turn ended (`session:result`: covers edits outside any repo),
 *   - the window comes back (focus, or the tab shown again) after a while away.
 * Never more often than every `minIntervalMs` (a burst of edits is one re-read,
 * run when the interval is up), and never while the page is hidden: a change
 * seen then is read once the page is shown.
 */
import { useEffect, useRef } from 'react';
import { wsClient } from '@/api/ws';

export const CHANGED_REFRESH_MIN_MS = 10_000;
/** Coming back to the window re-reads only when the last read is this old. */
const ARRIVAL_STALE_MS = 30_000;

export function useChangedLiveRefresh(
  sessionId: string,
  refresh: () => void,
  opts: { minIntervalMs?: number; enabled?: boolean } = {},
): void {
  const { minIntervalMs = CHANGED_REFRESH_MIN_MS, enabled = true } = opts;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled || !sessionId) return;
    // The tab's own first load counts as the first read.
    let lastAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingWhileHidden = false;
    const visible = () => document.visibilityState === 'visible';

    const run = () => {
      timer = null;
      if (!visible()) { pendingWhileHidden = true; return; }
      lastAt = Date.now();
      refreshRef.current();
    };
    const request = () => {
      if (timer) return; // one re-read already scheduled covers this change too
      const wait = Math.max(0, minIntervalMs - (Date.now() - lastAt));
      timer = setTimeout(run, wait);
    };
    const onSessionEvent = (data: unknown) => {
      const sid = (data as { sessionId?: unknown } | null)?.sessionId;
      if (sid === sessionId) request();
    };
    const onArrival = () => {
      if (!visible()) return;
      if (pendingWhileHidden || Date.now() - lastAt >= ARRIVAL_STALE_MS) {
        pendingWhileHidden = false;
        request();
      }
    };

    wsClient.onEvent('session:git-status', onSessionEvent);
    wsClient.onEvent('session:result', onSessionEvent);
    window.addEventListener('focus', onArrival);
    document.addEventListener('visibilitychange', onArrival);
    return () => {
      if (timer) clearTimeout(timer);
      wsClient.offEvent('session:git-status', onSessionEvent);
      wsClient.offEvent('session:result', onSessionEvent);
      window.removeEventListener('focus', onArrival);
      document.removeEventListener('visibilitychange', onArrival);
    };
  }, [sessionId, minIntervalMs, enabled]);
}
