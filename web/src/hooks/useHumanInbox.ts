/**
 * Human Inbox state for the notification center — the letter LIST (envelopes).
 *
 * The letter store is canonical for read/pin/archive/answered, so the rail counts
 * and rows read from here, never from the notification feed. The feed's `letter`
 * envelopes are only the live signal that something changed: every letter WS
 * event refreshes the list (coalesced), which is what makes the rail count and
 * the rows update without a page refresh.
 *
 * This hook is a LENS on the one shared store
 * (`components/inbox/letter-store.ts`), not a store of its own. It used to keep a
 * private `useState` pair, which made the rail and a session panel's Inbox tab two
 * independent copies of the same letters: pinning in the rail left the session tab
 * showing "Pin" with no glyph and the old date order, because `pinned` has no WS
 * echo and the only thing that reconciled the copies was a debounced full re-GET
 * fired by some unrelated letter event.
 *
 * Fetching is gated on `enabled` (the panel being open) — the inbox is a panel
 * surface, and a background poll for a feature that may be low-volume would be
 * pure cost. The ARCHIVE shelf is fetched only while it is being shown.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { compareLetters, type LetterEnvelope } from '@/api/human-inbox';
import {
  applyLetterChange, ensureLetters, getLetterSnapshot, markLettersStale, patchLetter, refreshLetters,
  scheduleLetterRefresh, subscribeLetters,
} from '@/components/inbox/letter-store';

/**
 * The letter id a wire record refers to, or `undefined` when the record is not
 * a letter envelope at all. Mirrors letterIdOf in the notification model
 * (dedupKey fallback for records written before `letterId` existed).
 */
function letterIdFromNotification(data: unknown): string | null | undefined {
  const r = data as { kind?: string; letterId?: string; dedupKey?: string } | undefined;
  if (!r || r.kind !== 'letter') return undefined;
  if (r.letterId) return r.letterId;
  if (typeof r.dedupKey === 'string' && r.dedupKey.startsWith('letter:')) {
    return r.dedupKey.slice('letter:'.length) || null;
  }
  return null;
}

/**
 * Subscribe to "a letter arrived or changed" from every lane that can carry it:
 * the notification envelope broadcasts (kind 'letter') and the store's own
 * `human-inbox:letter` event when the server forwards it. Handlers are
 * idempotent refreshes, so hearing the same change twice is harmless — missing
 * it is not.
 */
export function useLetterEvents(onLetter: (letterId: string | null) => void): void {
  const cb = useRef(onLetter);
  cb.current = onLetter;

  const fromNotification = useCallback((data: unknown) => {
    const id = letterIdFromNotification(data);
    if (id !== undefined) cb.current(id);
  }, []);

  useEvent('notification:new', fromNotification);
  useEvent('notification:updated', fromNotification);
  useEvent('human-inbox:letter', (data) => {
    const r = data as { letterId?: string } | undefined;
    cb.current(r?.letterId ?? null);
  });
}

export interface HumanInboxState {
  /** The CURRENT view (archived or live), sorted pinned-first then newest. */
  letters: LetterEnvelope[];
  /**
   * The live (non-archived) letters, whichever view is on screen — what the rail
   * badge and Needs Action must count. Same array as `letters` in the live view.
   */
  liveLetters: LetterEnvelope[];
  /** Every letter this browser knows about, live shelf and archive alike: the
   *  reader needs an envelope for a row that has just left the current view. */
  byId: Map<string, LetterEnvelope>;
  loaded: boolean;
  error: string | null;
  refresh: () => void;
  /**
   * Apply a state change: patch the shared store first (every surface must feel
   * it instantly), then call the route; a failure logs and re-reads from the
   * server rather than leaving a lie on screen.
   */
  applyChange: (
    id: string,
    patch: Partial<LetterEnvelope>,
    call: () => Promise<unknown>,
    what: string,
  ) => Promise<void>;
  /** Merge a fresher record (e.g. the reader's own GET) into the list. */
  mergeLetter: (letter: LetterEnvelope) => void;
}

export function useHumanInbox(
  { enabled, archived }: { enabled: boolean; archived: boolean },
): HumanInboxState {
  const shared = useSyncExternalStore(subscribeLetters, getLetterSnapshot, getLetterSnapshot);

  useEffect(() => {
    if (!enabled) return;
    ensureLetters({ archived });
  }, [enabled, archived]);

  // Live updates while the panel is open. Closed panel = no REFRESH from here: the list reloads on
  // the next open anyway, and the bell badge already moved (the feed envelope arrived over the same
  // event). A session panel's own subscription keeps the store fresh when it is the one on screen.
  //
  // It does mark the list STALE, which is a different thing and costs no request. `ensureLetters`
  // serves a cached list for 15s, and reaching for the bell after a notification takes about that
  // long, so the letter the event was about was routinely missing from the list it opened. Marking
  // it stale is what makes the next open a real read.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useLetterEvents(useCallback(() => {
    if (!enabledRef.current) { markLettersStale(); return; }
    scheduleLetterRefresh();
  }, []));

  const liveSorted = useMemo(
    () => [...shared.letters].sort(compareLetters),
    [shared.letters],
  );
  const archivedSorted = useMemo(
    () => [...shared.archived].sort(compareLetters),
    [shared.archived],
  );
  const letters = archived ? archivedSorted : liveSorted;

  // Both shelves, so the reader can still render the header for a letter the
  // current view no longer lists (just archived, or opened from the All feed).
  const byId = useMemo(() => {
    const map = new Map<string, LetterEnvelope>();
    for (const l of archivedSorted) map.set(l.id, l);
    for (const l of liveSorted) map.set(l.id, l);
    return map;
  }, [liveSorted, archivedSorted]);

  const applyChange = useCallback(applyLetterChange, []);

  const mergeLetter = useCallback((letter: LetterEnvelope) => {
    patchLetter(letter.id, letter);
  }, []);

  return {
    letters,
    liveLetters: liveSorted,
    byId,
    // The Archived view waits on ITS read: reporting the live list's `loaded`
    // would render "Nothing archived" while the shelf was still in flight.
    loaded: archived ? shared.archivedLoaded : shared.loaded,
    error: shared.error,
    refresh: refreshLetters,
    applyChange,
    mergeLetter,
  };
}
