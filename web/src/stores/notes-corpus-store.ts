/**
 * Vault-wide corpora the notes editor wants on every open: the flat note list
 * (wiki-link autocomplete; ~290 KB for a real vault) and the tag counts (#tag
 * autocomplete). Both are properties of the VAULT, not of the note being opened,
 * yet the editor shell used to refetch both on every note switch, and twice per
 * switch (once when the doc key changed, once when the panel remounted with the
 * loaded content). On a 1,900-note vault that was ~600 KB of JSON per click,
 * competing for the browser's six connections with the content fetch the user
 * was actually waiting on.
 *
 * Here each corpus is fetched once per page lifetime and then kept current from
 * the server's own change signals: `notes:tree-changed` (a note appeared, moved
 * or vanished) refreshes the list; `notes:updated` (a note was saved, so its
 * title or tags may have changed) refreshes both, debounced past the server's
 * index reconcile. A WebSocket reconnect refreshes both, since events were
 * missed while it was down. Readers always see the last good value while a
 * refresh is in flight (stale-while-revalidate); nothing ever blocks on it.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { wsClient } from '@/api/ws';
import { fetchNotesList, fetchTags, type NoteListItem, type TagCount } from '@/api/notes-v2';

/** A save's index reconcile lands ~300 ms after the `notes:updated` event; wait it out, and coalesce autosave bursts. */
const UPDATED_REFRESH_DEBOUNCE_MS = 1500;

class Corpus<T> {
  private value: T | null = null;
  private inflight: Promise<T> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly load: (opts?: { priority?: 'low' }) => Promise<T>) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  get = (): T | null => this.value;

  /** Fetch once; later calls return the cached value without a request. */
  ensure(opts?: { priority?: 'low' }): Promise<T> {
    if (this.value) return Promise.resolve(this.value);
    return this.refetch(opts);
  }

  /** Re-fetch now (single-flight), keeping the old value visible until the new one lands. */
  refetch(opts?: { priority?: 'low' }): Promise<T> {
    if (this.inflight) return this.inflight;
    this.inflight = this.load(opts)
      .then((v) => {
        this.value = v;
        this.notify();
        return v;
      })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Refresh a little later, coalescing a burst of change events into one request. */
  scheduleRefresh(delayMs: number): void {
    if (!this.value && !this.inflight) return; // nobody has asked yet; the first reader fetches fresh
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refetch({ priority: 'low' }).catch(() => {});
    }, delayMs);
  }

  /** Test hook: forget everything. */
  reset(): void {
    this.value = null;
    this.inflight = null;
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

export const notesListCorpus = new Corpus<NoteListItem[]>((opts) => fetchNotesList(opts));
export const noteTagsCorpus = new Corpus<TagCount[]>((opts) => fetchTags(opts));

let wired = false;
/** Subscribe the corpora to the server's change signals. Idempotent; runs on first use. */
export function wireNotesCorpusEvents(): void {
  if (wired) return;
  wired = true;
  wsClient.onEvent('notes:tree-changed', () => {
    notesListCorpus.scheduleRefresh(UPDATED_REFRESH_DEBOUNCE_MS);
  });
  wsClient.onEvent('notes:updated', () => {
    notesListCorpus.scheduleRefresh(UPDATED_REFRESH_DEBOUNCE_MS);
    noteTagsCorpus.scheduleRefresh(UPDATED_REFRESH_DEBOUNCE_MS);
  });
  let wasConnected = wsClient.state === 'connected';
  wsClient.onConnectionChange((state) => {
    const connected = state === 'connected';
    if (connected && !wasConnected) {
      // Events were missed while the socket was down: refresh what someone holds.
      notesListCorpus.scheduleRefresh(0);
      noteTagsCorpus.scheduleRefresh(0);
    }
    wasConnected = connected;
  });
}

const EMPTY_NOTES: NoteListItem[] = [];
const EMPTY_TAGS: TagCount[] = [];

/** The vault's note list, cached for the page lifetime. `enabled` false = never fetch. */
export function useNotesListCorpus(enabled: boolean): NoteListItem[] {
  const value = useSyncExternalStore(notesListCorpus.subscribe, notesListCorpus.get, notesListCorpus.get);
  useEffect(() => {
    if (!enabled) return;
    wireNotesCorpusEvents();
    void notesListCorpus.ensure().catch(() => {});
  }, [enabled]);
  return value ?? EMPTY_NOTES;
}

/** The vault's tag counts, cached for the page lifetime. `enabled` false = never fetch. */
export function useNoteTagsCorpus(enabled: boolean): TagCount[] {
  const value = useSyncExternalStore(noteTagsCorpus.subscribe, noteTagsCorpus.get, noteTagsCorpus.get);
  useEffect(() => {
    if (!enabled) return;
    wireNotesCorpusEvents();
    void noteTagsCorpus.ensure().catch(() => {});
  }, [enabled]);
  return value ?? EMPTY_TAGS;
}

/**
 * Warm both corpora while the user is elsewhere (low priority: waits for a free
 * connection). The first note the user opens then has its autocomplete corpora
 * already in memory.
 */
export function prefetchNotesCorpora(): void {
  wireNotesCorpusEvents();
  void notesListCorpus.ensure({ priority: 'low' }).catch(() => {});
  void noteTagsCorpus.ensure({ priority: 'low' }).catch(() => {});
}
