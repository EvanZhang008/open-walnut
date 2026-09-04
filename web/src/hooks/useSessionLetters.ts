/**
 * Per-session letters for the session panel's Inbox tab — envelope list + the
 * unread badge.
 *
 * The list itself is NOT here: it lives in the one shared letter store
 * (`components/inbox/letter-store.ts`), which the notification rail reads through
 * `useHumanInbox` and this hook reads through the same subscription. This file is
 * only the per-session LENS plus the badge derivations.
 *
 * The badge has to be honest while the tab is CLOSED (a badge that only appears
 * once you open the tab tells you nothing), so this loads as soon as a session
 * panel mounts — and up to three panels are open at once on the home page, which
 * is exactly why the list is a module store subscribed through
 * `useSyncExternalStore` instead of a per-component fetch.
 *
 * The store is deliberately the WHOLE live list, not a per-session slice: the
 * route has no sender filter (the CLOUD_MODE relay would have to grow one for
 * nothing), and a low-volume envelope list is cheaper to fetch once and filter N
 * times than to fetch N times.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { runWhenVisible } from '@/utils/page-visibility';
import type { LetterEnvelope } from '@/api/human-inbox';
import { useLetterEvents } from '@/hooks/useHumanInbox';
import { useEvent } from '@/hooks/useWebSocket';
import {
  applyLetterChange, ensureLetters, getLetterSnapshot, loadLetters, patchLetter,
  refreshLetters, scheduleLetterRefresh, subscribeLetters,
} from '@/components/inbox/letter-store';
import {
  attentionLetterCount, decisionLetterCount, lettersForSession, letterSessionMatch,
  unreadLetterCount,
} from '@/components/inbox/session-letters';

export interface SessionLettersState {
  /** This session's live letters, pinned first then newest. */
  letters: LetterEnvelope[];
  loaded: boolean;
  error: string | null;
  unreadCount: number;
  decisionCount: number;
  /** Badge count: unread OR waiting on a decision, each letter once. */
  attentionCount: number;
  /**
   * Does a letter id belong to this session? `null` = the live index doesn't
   * know it (still loading, or archived), which is not a refusal.
   */
  ownsLetter: (letterId: string) => boolean | null;
  refresh: () => void;
  /**
   * Optimistic mutation: patch locally, call the route, resync on failure so a
   * lie never stays on screen.
   */
  applyChange: (
    id: string,
    patch: Partial<LetterEnvelope>,
    call: () => Promise<unknown>,
    what: string,
  ) => Promise<void>;
  /** Merge a fresher record (the reader's own GET) into the shared list. */
  mergeLetter: (letter: LetterEnvelope) => void;
}

export function useSessionLetters(sessionId: string): SessionLettersState {
  const shared = useSyncExternalStore(subscribeLetters, getLetterSnapshot, getLetterSnapshot);

  useEffect(() => {
    if (!sessionId) return;
    ensureLetters();
  }, [sessionId]);

  // Every lane a letter change can arrive on (notification envelopes + the
  // store's own event). Handlers are idempotent refreshes: hearing a change
  // twice is harmless, missing it is not. The debounce lives in the store, so
  // three mounted panels plus the rail still make ONE GET per burst.
  useLetterEvents(useCallback(() => { scheduleLetterRefresh(); }, []));

  // A WS gap loses every event in it, and this list is not polled — so a letter
  // that arrived while the socket was down would leave the chip badge and the tab
  // list wrong until a reload (typical trigger: a server restart or a sleeping
  // laptop). Resync on reconnect, the same convention the rest of the console
  // follows. Hidden tabs defer: every open tab reconnects at once, and the store
  // shares one in-flight GET across all panels anyway.
  useEvent('_ws:reconnected', () => {
    runWhenVisible('session-letters:reconnect', () => { void loadLetters(); });
  });

  const letters = useMemo(
    () => lettersForSession(shared.letters, sessionId),
    [shared.letters, sessionId],
  );

  const applyChange = useCallback(applyLetterChange, []);

  const mergeLetter = useCallback((letter: LetterEnvelope) => {
    patchLetter(letter.id, letter);
  }, []);

  // Asked against the WHOLE shared list, not this session's slice: an archived
  // letter is absent from the slice yet still legitimately this session's.
  const ownsLetter = useCallback((letterId: string): boolean | null => {
    const verdict = letterSessionMatch(shared.letters, letterId, sessionId);
    return verdict === 'unknown' ? null : verdict === 'match';
  }, [shared.letters, sessionId]);

  return {
    letters,
    loaded: shared.loaded,
    error: shared.error,
    unreadCount: unreadLetterCount(letters),
    decisionCount: decisionLetterCount(letters),
    attentionCount: attentionLetterCount(letters),
    ownsLetter,
    refresh: refreshLetters,
    applyChange,
    mergeLetter,
  };
}
