/**
 * The last view of every page: which tab, filter or toggle was picked, so leaving a page and
 * coming back (another page, a reload, the Mac app restarted) shows it as it was left.
 * 2026-11-01, the user: "every time I click out of the Org page and back, it resets. If I was
 * in Threads it puts me back in Task ... Walnut needs to remember what was open last time,
 * permanently, on every page."
 *
 * One place for all of them: a key `open-walnut-view:<page>.<name>` in localStorage, which
 * ui-prefs-sync mirrors to the server's ui-prefs.json (the `open-walnut-` prefix). So a view
 * survives a reload, a restart and cleared browser data; another device takes it on at its
 * next boot (the merge runs once, before the first render, so two open windows never move
 * each other's page).
 *
 * What lives elsewhere, and stays there: a view in the URL (Settings' #section, Memory's
 * ?path, Calendar's ?view) comes back through last-location.ts; the Org page's node and tab
 * through org-place.ts; Home's columns through the layout record. A typed search, a menu,
 * a dialog or a form is a passing thing and starts empty.
 *
 * tests/web/view-memory-guard.test.ts fails when a page holds a view choice only in
 * component state.
 */
import { useCallback, useMemo, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';

export const VIEW_PREFIX = 'open-walnut-view:';
/** A view kept per node or per board holds at most this many, the last written kept. */
export const VIEW_IDS_MAX = 64;

/** The storage key of one page's view choice. */
export function viewKey(page: string, name: string): string {
  return `${VIEW_PREFIX}${page}.${name}`;
}

const listeners = new Map<string, Set<() => void>>();

function subscribeKey(key: string, fn: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => { set!.delete(fn); };
}

function rawOf(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function parse(raw: string | null): unknown {
  if (raw === null) return undefined;
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

/** The ids' views under one key, oldest first, as [id, view] pairs (an object would put an id like "12" first). */
function pairsOf(raw: string | null): Array<[string, unknown]> {
  const v = parse(raw);
  return Array.isArray(v) ? v.filter((p): p is [string, unknown] => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string') : [];
}

/** What the key holds after `id`'s view (or the key's own, id null) is set to `v`. */
export function storedText(cur: string | null, id: string | null, v: unknown): string {
  if (id === null) return JSON.stringify(v);
  // The one just written goes last; the oldest go once there are too many.
  const pairs = pairsOf(cur).filter(([k]) => k !== id);
  pairs.push([id, v]);
  return JSON.stringify(pairs.slice(-VIEW_IDS_MAX));
}

/** The view a key holds (for `id`, or its own), when `accept` takes it. */
export function storedView<T>(raw: string | null, id: string | null, accept: (v: unknown) => v is T): T | undefined {
  const v = id === null ? parse(raw) : pairsOf(raw).find(([k]) => k === id)?.[1];
  return accept(v) ? v : undefined;
}

function useView<T>(key: string, id: string | null, initial: T | (() => T), accept: (v: unknown) => v is T): [T, Dispatch<SetStateAction<T>>] {
  // The stored text is the snapshot: every mount using this key reads one value, and a write
  // from one of them shows in all (two file explorers open on Home, say).
  const raw = useSyncExternalStore(useCallback((fn) => subscribeKey(key, fn), [key]), () => rawOf(key), () => null);
  const pick = (r: string | null): T => {
    const v = storedView(r, id, accept);
    if (v !== undefined) return v;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `initial` and `accept` are fixed per call site
  const value = useMemo(() => pick(raw), [raw, id]);
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    const cur = rawOf(key);
    const prev = pick(cur);
    const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
    const text = storedText(cur, id, v);
    if (text === cur) return;
    try { localStorage.setItem(key, text); } catch { return; /* storage off: it just forgets */ }
    for (const fn of [...(listeners.get(key) ?? [])]) fn();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initial` and `accept` are fixed per call site
  }, [key, id]);
  return [value, set];
}

/**
 * `useState` for a page's view choice, kept under `viewKey(page, name)`. A value that no longer
 * passes `accept` (a tab a later build removed) reads as `initial`. Written in the setter only,
 * so opening a page never writes what it just read.
 */
export function usePageView<T>(page: string, name: string, initial: T | (() => T), accept: (v: unknown) => v is T): [T, Dispatch<SetStateAction<T>>] {
  return useView(viewKey(page, name), null, initial, accept);
}

/**
 * The same, one value per `id` (an Org node, a board's owner), all under one key so a deleted
 * node's view never piles up: the last VIEW_IDS_MAX written are kept.
 */
export function usePageViewOf<T>(page: string, name: string, id: string, initial: T | (() => T), accept: (v: unknown) => v is T): [T, Dispatch<SetStateAction<T>>] {
  return useView(viewKey(page, name), id, initial, accept);
}

export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
