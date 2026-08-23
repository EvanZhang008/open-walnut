/**
 * Human Inbox state for the notification center — the letter LIST (envelopes).
 *
 * The letter store is canonical for read/pin/archive/answered, so the rail
 * counts and rows read from here, never from the notification feed. The feed's
 * `letter` envelopes are only the live signal that something changed: every
 * letter WS event refreshes this list (coalesced), which is what makes the rail
 * count and the rows update without a page refresh.
 *
 * Fetching is gated on `enabled` (the panel being open) — the inbox is a panel
 * surface, and a background poll for a feature that may be low-volume would be
 * pure cost.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { compareLetters, listLetters, type LetterEnvelope } from '@/api/human-inbox';

/** Coalesce a burst of letter events (a send + its bridge update) into one GET. */
const REFRESH_DEBOUNCE_MS = 350;

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
  byId: Map<string, LetterEnvelope>;
  loaded: boolean;
  error: string | null;
  refresh: () => void;
  /**
   * Apply a state change: patch locally first (the panel must feel instant),
   * then call the route; a failure logs and resyncs from the server rather than
   * leaving a lie on screen.
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
  const [letters, setLetters] = useState<LetterEnvelope[]>([]);
  const [live, setLive] = useState<LetterEnvelope[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stale-response guard: an archived-filter flip or a burst of refreshes can
  // land out of order, and the older answer must never overwrite the newer one.
  const reqSeq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const load = useCallback(async (wantArchived: boolean) => {
    const seq = ++reqSeq.current;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    try {
      // The Archived view still needs the LIVE list: the rail badge and Needs
      // Action count letters that are NOT archived, so feeding them the archive
      // read "0 unread" and dropped every unanswered decision while it was open.
      const [list, liveList] = await Promise.all([
        listLetters({ archived: wantArchived, signal: ac.signal }),
        wantArchived ? listLetters({ signal: ac.signal }) : Promise.resolve(null),
      ]);
      if (seq !== reqSeq.current) return;
      setLetters(list);
      setLive(liveList ?? list);
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (seq !== reqSeq.current) return;
      setError('Could not load the inbox');
      log.warn('inbox', 'letter list load failed', { archived: String(wantArchived), error: String(err) });
    } finally {
      if (seq === reqSeq.current) setLoaded(true);
    }
  }, []);

  const refresh = useCallback(() => { void load(archived); }, [load, archived]);

  useEffect(() => {
    if (!enabled) return;
    void load(archived);
    return () => { abort.current?.abort(); };
  }, [enabled, archived, load]);

  // Live updates while the panel is open. Closed panel = no fetch: it will load
  // fresh on the next open anyway, and the bell badge already moved (the feed
  // envelope arrived over the same event).
  useLetterEvents(useCallback(() => {
    if (!enabledRef.current) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      debounce.current = null;
      void load(archived);
    }, REFRESH_DEBOUNCE_MS);
  }, [load, archived]));

  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); }, []);

  const applyChange = useCallback(async (
    id: string,
    patch: Partial<LetterEnvelope>,
    call: () => Promise<unknown>,
    what: string,
  ) => {
    const patchOne = (l: LetterEnvelope) => (l.id === id ? { ...l, ...patch } : l);
    setLetters(prev => prev.map(patchOne));
    setLive(prev => prev.map(patchOne));
    try {
      await call();
    } catch (err) {
      log.warn('inbox', 'letter change failed', { letterId: id, what, error: String(err) });
      void load(archived);
    }
  }, [load, archived]);

  const mergeLetter = useCallback((letter: LetterEnvelope) => {
    const merge = (prev: LetterEnvelope[]) => (prev.some(l => l.id === letter.id)
      ? prev.map(l => (l.id === letter.id ? { ...l, ...letter } : l))
      : prev);
    setLetters(merge);
    setLive(merge);
  }, []);

  const sorted = useMemo(() => [...letters].sort(compareLetters), [letters]);
  const liveSorted = useMemo(
    () => (live === letters ? sorted : [...live].sort(compareLetters)),
    [live, letters, sorted],
  );
  const byId = useMemo(() => new Map(sorted.map(l => [l.id, l])), [sorted]);

  return { letters: sorted, liveLetters: liveSorted, byId, loaded, error, refresh, applyChange, mergeLetter };
}
