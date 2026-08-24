/**
 * Per-session letters for the session panel's Inbox tab — envelope list + the
 * unread badge.
 *
 * ONE fetch feeds every panel. The badge has to be honest while the tab is
 * CLOSED (a badge that only appears once you open the tab tells you nothing), so
 * this loads as soon as a session panel mounts — and up to three panels are open
 * at once on the home page, which is exactly why the list lives in a module-level
 * store subscribed through `useSyncExternalStore` instead of a per-component
 * fetch. Cost is one GET of the envelope index per page load, plus one coalesced
 * GET per letter event.
 *
 * The store is deliberately the WHOLE live list, not a per-session slice: the
 * route has no sender filter (the CLOUD_MODE relay would have to grow one for
 * nothing), and a low-volume envelope list is cheaper to fetch once and filter N
 * times than to fetch N times.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { log } from '@/utils/log';
import { runWhenVisible } from '@/utils/page-visibility';
import { listLetters, type LetterEnvelope } from '@/api/human-inbox';
import { useLetterEvents } from '@/hooks/useHumanInbox';
import { useEvent } from '@/hooks/useWebSocket';
import {
  attentionLetterCount, decisionLetterCount, lettersForSession, letterSessionMatch,
  unreadLetterCount,
} from '@/components/inbox/session-letters';

/** Coalesce a burst of letter events (a send plus its bridge update) into one GET. */
const REFRESH_DEBOUNCE_MS = 350;
/** A newly mounted panel reuses a list this fresh instead of re-fetching. */
const STALE_MS = 15_000;

interface Snapshot {
  letters: readonly LetterEnvelope[];
  loaded: boolean;
  error: string | null;
}

let snapshot: Snapshot = { letters: [], loaded: false, error: null };
const subscribers = new Set<() => void>();
let inflight: Promise<void> | null = null;
let lastLoadedAt = 0;
let debounce: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  // Copy the set: a subscriber that unsubscribes while notifying must not
  // mutate the set being walked.
  for (const fn of [...subscribers]) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

function getSnapshot(): Snapshot {
  return snapshot;
}

/** Fetch the live envelope list. Concurrent callers share one request. */
function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const letters = await listLetters();
      snapshot = { letters, loaded: true, error: null };
      lastLoadedAt = Date.now();
    } catch (err) {
      snapshot = { ...snapshot, loaded: true, error: 'Could not load letters' };
      log.warn('inbox', 'session letters load failed', { error: String(err) });
    } finally {
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

/** Refresh now (used after a mutation that changes list membership). */
export function refreshSessionLetters(): void {
  void load();
}

function scheduleRefresh(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => { debounce = null; void load(); }, REFRESH_DEBOUNCE_MS);
}

/** Patch one letter locally so a click feels instant before the route answers. */
export function patchSessionLetter(id: string, patch: Partial<LetterEnvelope>): void {
  if (!snapshot.letters.some(l => l.id === id)) return;
  snapshot = {
    ...snapshot,
    letters: snapshot.letters.map(l => (l.id === id ? { ...l, ...patch } : l)),
  };
  emit();
}

/** Tests only: forget everything the store learned. */
export function resetSessionLettersCache(): void {
  snapshot = { letters: [], loaded: false, error: null };
  lastLoadedAt = 0;
  if (debounce) { clearTimeout(debounce); debounce = null; }
}

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
  const shared = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!sessionId) return;
    if (!snapshot.loaded || Date.now() - lastLoadedAt > STALE_MS) void load();
  }, [sessionId]);

  // Every lane a letter change can arrive on (notification envelopes + the
  // store's own event). Handlers are idempotent refreshes: hearing a change
  // twice is harmless, missing it is not.
  useLetterEvents(useCallback(() => { scheduleRefresh(); }, []));

  // A WS gap loses every event in it, and this list is not polled — so a letter
  // that arrived while the socket was down would leave the chip badge and the tab
  // list wrong until a reload (typical trigger: a server restart or a sleeping
  // laptop). Resync on reconnect, the same convention the rest of the console
  // follows. Hidden tabs defer: every open tab reconnects at once, and the store
  // shares one in-flight GET across all panels anyway.
  useEvent('_ws:reconnected', () => {
    runWhenVisible('session-letters:reconnect', () => { void load(); });
  });

  const letters = useMemo(
    () => lettersForSession(shared.letters, sessionId),
    [shared.letters, sessionId],
  );

  const applyChange = useCallback(async (
    id: string,
    patch: Partial<LetterEnvelope>,
    call: () => Promise<unknown>,
    what: string,
  ) => {
    patchSessionLetter(id, patch);
    try {
      await call();
    } catch (err) {
      log.warn('inbox', 'letter change failed', { letterId: id, what, error: String(err) });
      void load();
    }
  }, []);

  const mergeLetter = useCallback((letter: LetterEnvelope) => {
    patchSessionLetter(letter.id, letter);
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
    refresh: refreshSessionLetters,
    applyChange,
    mergeLetter,
  };
}
