/**
 * One browser, one letter store.
 *
 * A letter is shown by three surfaces at once: the notification rail's Inbox
 * (NotificationPanel), a session panel's Inbox tab (SessionInboxPane) and the
 * reader both of them open (LetterView). They used to run TWO parallel client
 * stores — a private `useState` pair in useHumanInbox and this module singleton —
 * so pinning in the rail did nothing to the session tab: `pinned` has no WS echo
 * at all, and the only thing that ever reconciled the two copies was a debounced
 * full re-GET triggered by some UNRELATED letter event. The pin glyph and the
 * date order stayed wrong until a reload.
 *
 * So the list lives here, once, and every surface reads it through
 * `useSyncExternalStore`. A mutation patches this store first (the click has to
 * feel instant), then calls the route; the route's answer and the WS events only
 * confirm — a failure re-reads rather than leaving a lie on screen.
 *
 * Two lists, not one: the LIVE feed and the ARCHIVED shelf are separate server
 * reads (`GET /api/v1/human-inbox[?archived=1]`), and folding them together would
 * put archived rows into every session tab's list. The archived list is fetched
 * only once a surface asks for it.
 *
 * Cost: one GET of the envelope index per page load, plus one coalesced GET per
 * letter event, shared by every mounted surface.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { listLetters, type LetterEnvelope } from '@/api/human-inbox';
import { log } from '@/utils/log';

/** Coalesce a burst of letter events (a send plus its bridge update) into one GET. */
const REFRESH_DEBOUNCE_MS = 350;
/** A newly mounted surface reuses a list this fresh instead of re-fetching. */
const STALE_MS = 15_000;

export interface LetterStoreSnapshot {
  /** Live (non-archived) letters, server order. */
  letters: readonly LetterEnvelope[];
  /** The archive shelf — empty until a surface asks for it. */
  archived: readonly LetterEnvelope[];
  loaded: boolean;
  archivedLoaded: boolean;
  error: string | null;
}

const EMPTY: LetterStoreSnapshot = {
  letters: [], archived: [], loaded: false, archivedLoaded: false, error: null,
};

let snapshot: LetterStoreSnapshot = EMPTY;
const subscribers = new Set<() => void>();
let inflight: Promise<void> | null = null;
let archivedInflight: Promise<void> | null = null;
let lastLoadedAt = 0;
let lastArchivedAt = 0;
let debounce: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  // Copy the set: a subscriber that unsubscribes while notifying must not
  // mutate the set being walked.
  for (const fn of [...subscribers]) fn();
}

export function subscribeLetters(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

export function getLetterSnapshot(): LetterStoreSnapshot {
  return snapshot;
}

/** Fetch the live envelope list. Concurrent callers share one request. */
export function loadLetters(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const letters = await listLetters();
      snapshot = { ...snapshot, letters, loaded: true, error: null };
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

/** Fetch the archive shelf. Same sharing rule as the live list. */
export function loadArchivedLetters(): Promise<void> {
  if (archivedInflight) return archivedInflight;
  archivedInflight = (async () => {
    try {
      const archived = await listLetters({ archived: true });
      snapshot = { ...snapshot, archived, archivedLoaded: true, error: null };
      lastArchivedAt = Date.now();
    } catch (err) {
      snapshot = { ...snapshot, archivedLoaded: true, error: 'Could not load the inbox' };
      log.warn('inbox', 'archived letters load failed', { error: String(err) });
    } finally {
      archivedInflight = null;
      emit();
    }
  })();
  return archivedInflight;
}

/** Load whichever lists a surface is showing, unless one is fresh enough. */
export function ensureLetters(opts: { archived?: boolean } = {}): void {
  if (!snapshot.loaded || Date.now() - lastLoadedAt > STALE_MS) void loadLetters();
  if (opts.archived && (!snapshot.archivedLoaded || Date.now() - lastArchivedAt > STALE_MS)) {
    void loadArchivedLetters();
  }
}

/** Re-read now (after a mutation that changes which list a letter belongs to). */
export function refreshLetters(): void {
  void loadLetters();
  // Only when the shelf is already on screen somewhere: archiving from a session
  // tab must not pay for a list nobody is looking at.
  if (snapshot.archivedLoaded) void loadArchivedLetters();
}

/** Coalesced refresh — the lane every letter WS event lands on. */
export function scheduleLetterRefresh(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => { debounce = null; refreshLetters(); }, REFRESH_DEBOUNCE_MS);
}

/**
 * Forget how fresh the list is, WITHOUT fetching it.
 *
 * For an event that arrives while nothing is subscribed to the letter list: no surface wants a
 * request right now, but the cached list is now known to be wrong, and `ensureLetters` would
 * otherwise serve it for up to 15 more seconds. That is exactly the window a human takes to open
 * the bell after a letter lands, so the letter they came to read was missing from the list.
 *
 * Cheap on purpose (one number), so a closed-panel handler can call it on every event.
 */
export function markLettersStale(): void {
  lastLoadedAt = 0;
  lastArchivedAt = 0;
}

/**
 * Patch one letter locally so a click feels instant before the route answers.
 *
 * Patches whichever list holds it: a row can be in the live feed or on the
 * archive shelf, and the caller (a pin button, a read toggle) does not know or
 * care which surface it was clicked from.
 */
export function patchLetter(id: string, patch: Partial<LetterEnvelope>): void {
  const patchOne = (list: readonly LetterEnvelope[]): readonly LetterEnvelope[] => (
    list.some(l => l.id === id)
      ? list.map(l => (l.id === id ? { ...l, ...patch } : l))
      : list
  );
  const letters = patchOne(snapshot.letters);
  const archived = patchOne(snapshot.archived);
  if (letters === snapshot.letters && archived === snapshot.archived) return;
  snapshot = { ...snapshot, letters, archived };
  emit();
}

/**
 * Optimistic mutation: patch locally, call the route, re-read on failure so a
 * lie never stays on screen. The ONE write path every surface uses.
 */
export async function applyLetterChange(
  id: string,
  patch: Partial<LetterEnvelope>,
  call: () => Promise<unknown>,
  what: string,
): Promise<void> {
  patchLetter(id, patch);
  try {
    await call();
  } catch (err) {
    log.warn('inbox', 'letter change failed', { letterId: id, what, error: String(err) });
    refreshLetters();
  }
}

/**
 * The shared record for ONE letter, from either shelf. `undefined` = this browser
 * has not indexed it (the lists are still loading, or it was opened by id from a
 * deep link), so the caller keeps whatever record it fetched itself.
 *
 * Entries are replaced, never mutated, so returning the array member straight is
 * a stable snapshot for useSyncExternalStore.
 */
export function useLetterEnvelope(letterId: string | undefined): LetterEnvelope | undefined {
  const read = useCallback(() => {
    if (!letterId) return undefined;
    return snapshot.letters.find(l => l.id === letterId)
      ?? snapshot.archived.find(l => l.id === letterId);
  }, [letterId]);
  return useSyncExternalStore(subscribeLetters, read, read);
}

/** Tests only: forget everything the store learned. */
export function resetLetterStore(): void {
  snapshot = EMPTY;
  lastLoadedAt = 0;
  lastArchivedAt = 0;
  if (debounce) { clearTimeout(debounce); debounce = null; }
  emit();
}
