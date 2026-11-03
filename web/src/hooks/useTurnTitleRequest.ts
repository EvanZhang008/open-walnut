import { useEffect } from 'react';
import { requestTurnTitles } from '@/api/sessions';
import { log } from '@/utils/log';

/** Asks for one session are at least this far apart. */
const MIN_GAP_MS = 15_000;
/** Rows settle for a moment after a load or a turn end before the ask goes. */
const SETTLE_MS = 1_500;

/** Per session, across remounts: the untitled set last asked about, when, and
 *  whether the server said it will not name this session's sections. */
const asked = new Map<string, { sig: string; at: number; off: boolean }>();

/**
 * The client's trigger of the outline sections' naming
 * (src/core/sessions/turn-titles.ts): when the conversation on screen shows
 * sections still on their fallback label, ask the server once for that set.
 * A set already asked about is never asked again (a title that failed stays on
 * its fallback), and a server that cannot name them is not asked again.
 */
export function useTurnTitleRequest(sessionId: string, untitledIds: readonly string[]): void {
  const sig = untitledIds.join('\n');
  useEffect(() => {
    if (!sig || !sessionId) return undefined;
    const prev = asked.get(sessionId);
    if (prev?.off || prev?.sig === sig) return undefined;
    const wait = Math.max(SETTLE_MS, (prev ? prev.at + MIN_GAP_MS : 0) - Date.now());
    const timer = setTimeout(() => {
      asked.set(sessionId, { sig, at: Date.now(), off: false });
      requestTurnTitles(sessionId).then((r) => {
        log.info('session', 'outline sections: naming asked', { sessionId, queued: r.queued, reason: r.reason, untitled: untitledIds.length });
        if (!r.queued) asked.set(sessionId, { sig, at: Date.now(), off: true });
      }).catch((err: unknown) => {
        log.warn('session', 'outline sections: naming ask failed', { sessionId, error: String(err) });
      });
    }, wait);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the set is `sig`
  }, [sessionId, sig]);
}

/** Test-only: forget every ask. */
export function __resetTurnTitleRequestsForTesting(): void {
  asked.clear();
}
