/**
 * The threads that need him, across every node (experiment inbox_needs_threads,
 * GET /api/v1/inbox/needs): ONE list for the page, read by the inbox and the bell alike, so the
 * card list and the number never disagree. Read again when any node's Threads change, a letter
 * moves, a task ends or the socket comes back (several events in a burst make one read), and
 * every READ_EVERY_MS for a snooze that ran out. Not read at all while no one shows it (the
 * experiment off).
 *
 * A card whose node's own list already says it no longer needs him (his answer made it working)
 * leaves the list, its count and the bell at once (noteLeft), and stays out of every later read
 * that still carries that same copy of it for LEFT_HOLD_MS (the server's word wins after that); a
 * newer copy that needs him again shows again at once. A replica keeps no Threads (503): no list,
 * no error, his letters as before.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { wsClient } from '@/api/ws';
import { heldLetterOf } from '@open-walnut/inbox-needs';
import { fetchInboxNeeds, type InboxNeedsThread } from '@/api/inbox-needs';
import { ApiError } from '@/api/api-error';
import { log } from '@/utils/log';

export interface InboxNeedsState {
  /** The most urgent first, as the server ordered them. */
  threads: readonly InboxNeedsThread[];
  /** The letters those threads hold: the inbox lists each once, as its thread. */
  held: ReadonlySet<string>;
  loaded: boolean;
  error: string | null;
}

const EMPTY: InboxNeedsState = { threads: [], held: new Set(), loaded: false, error: null };
const COALESCE_MS = 300;
const READ_EVERY_MS = 2 * 60_000;
const EVENTS = ['org-threads:changed', 'human-inbox:letter', 'human-inbox:answered', 'human-inbox:state', 'task:completed', 'task:deleted', '_ws:reconnected'] as const;

let state: InboxNeedsState = EMPTY;
/** The last read as the server answered it. */
let raw: { threads: readonly InboxNeedsThread[] } | null = null;
/** Thread id -> the copy that left (noteLeft): its updatedAt, and when it left. */
const left = new Map<string, { updatedAt: string; at: number }>();
const LEFT_HOLD_MS = 30_000;

/** The list as shown: the server's read without the copies that left here lately. */
function view(loaded: boolean, error: string | null): InboxNeedsState {
  const now = Date.now();
  const threads = (raw?.threads ?? []).filter((t) => { const l = left.get(t.id); return !l || now - l.at >= LEFT_HOLD_MS || t.updatedAt > l.updatedAt; });
  return { threads, held: new Set(threads.map(heldLetterOf).filter((id): id is string => !!id)), loaded, error };
}
const listeners = new Set<() => void>();
let users = 0;
let seq = 0;
let soon: ReturnType<typeof setTimeout> | null = null;
let every: ReturnType<typeof setInterval> | null = null;

function set(next: InboxNeedsState): void {
  state = next;
  for (const fn of [...listeners]) fn();
}

function read(why: string): void {
  const mine = ++seq;
  fetchInboxNeeds().then((r) => {
    if (mine !== seq) return;
    raw = { threads: r.enabled ? r.threads : [] };
    // A thread the server no longer lists needs no mark.
    for (const id of [...left.keys()]) if (!raw.threads.some((t) => t.id === id)) left.delete(id);
    set(view(true, null));
  }, (err: unknown) => {
    if (mine !== seq) return;
    if (err instanceof ApiError && err.status === 503) { raw = null; set(view(true, null)); return; }
    log.warn('inbox', 'needs threads read failed', { why, error: err instanceof Error ? err.message : String(err) });
    // The last list stands: a failed read never empties the inbox.
    set({ ...state, loaded: true, error: 'The threads that need you could not be read. They come back when the server answers.' });
  });
}

function later(): void {
  if (soon) return;
  soon = setTimeout(() => { soon = null; if (users > 0) read('changed'); }, COALESCE_MS);
}

function start(): void {
  for (const name of EVENTS) wsClient.onEvent(name, later);
  every = setInterval(() => { if (document.visibilityState === 'visible') read('clock'); }, READ_EVERY_MS);
  read('open');
}

function stop(): void {
  for (const name of EVENTS) wsClient.offEvent(name, later);
  if (every) clearInterval(every);
  if (soon) clearTimeout(soon);
  every = soon = null;
  seq++;
  raw = null;
  left.clear();
  set(EMPTY);
}

/** This copy of a thread no longer needs him (its node's list says so): off the list now, and the list reads again. */
export function noteLeft(row: Pick<InboxNeedsThread, 'id' | 'updatedAt'>): void {
  if (users === 0 || left.get(row.id)?.updatedAt === row.updatedAt) return;
  left.set(row.id, { updatedAt: row.updatedAt, at: Date.now() });
  set(view(state.loaded, state.error));
  later();
  // The hold ends by itself: shown again from the last read unless a read took it off meanwhile.
  setTimeout(() => { if (users > 0) set(view(state.loaded, state.error)); }, LEFT_HOLD_MS + 50);
}

/** A card answered here: the list reads again at once (the card itself leaves with its node's Threads). */
export function rereadInboxNeeds(): void { if (users > 0) later(); }

/** Test seam: forget the list (a module store outlives a test's page). */
export function resetInboxNeedsForTest(): void { stop(); users = 0; }

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** The list, read while `enabled` (the experiment on); EMPTY otherwise. */
export function useInboxNeeds(enabled: boolean): InboxNeedsState {
  useEffect(() => {
    if (!enabled) return;
    if (users++ === 0) start();
    return () => { if (--users === 0) stop(); };
  }, [enabled]);
  const s = useSyncExternalStore(subscribe, () => state);
  return enabled ? s : EMPTY;
}
