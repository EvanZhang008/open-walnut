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
 * Each tab shows its own view (2026-11-02, a practice plugin open in two tabs on one problem:
 * a file picked in one tab switched the other, whose editor remounted under the user's typing).
 * localStorage is one for every tab of the browser, and the view used to be read from it on
 * every render, so any re-render (a clock ticking once a second) took another tab's latest
 * write. Now a tab reads a view from storage when it starts showing it (no mount of it on screen
 * in this tab yet: the page loads, a page, a panel or a plugin mounts again; for a view kept per
 * id, the first mount of that id), and from then on only its own writes change it. So the view
 * another tab left is the one this tab shows the next time it opens that view afresh, never in
 * the middle of using it. Typed text is no view: it lives in the draft store (utils/drafts.ts).
 *
 * tests/web/view-memory-guard.test.ts fails when a page holds a view choice only in
 * component state; tests/web/view-memory-tabs.test.ts pins the one-tab rule.
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

/** What a write storage refused (quota, storage off) holds instead, for this load. */
const unstored = new Map<string, string>();

function rawOf(key: string): string | null {
  const held = unstored.get(key);
  if (held !== undefined) return held;
  try { return localStorage.getItem(key); } catch { return null; }
}

/** This tab's text of each key on screen now: read from storage when the first mount of it subscribes, gone when the last one leaves. */
const live = new Map<string, string | null>();
/** How many mounts show each id of a key (null: the key's own view). */
const shownIds = new Map<string, Map<string | null, number>>();

/** The text this tab shows for `key`: its own while the key is on screen, else what storage holds. */
export function shownText(key: string): string | null {
  return live.has(key) ? live.get(key)! : rawOf(key);
}

/**
 * What a mount of `key` showing `id` reads at render: the tab's text, with `id`'s view as storage
 * holds it when no mount of this tab shows that id yet, so a new mount's first render is already
 * what its subscription settles on (no flash of an older view).
 */
export function snapshotOf(key: string, id: string | null): string | null {
  if (!live.has(key)) return rawOf(key);
  const mine = live.get(key) ?? null;
  if (id !== null && !shownIds.get(key)?.get(id)) return adoptId(mine, rawOf(key), id);
  return mine;
}

/** `mine` with `id`'s view as storage holds it now (the id no mount of this tab shows yet). */
function adoptId(mine: string | null, stored: string | null, id: string): string | null {
  const theirs = pairsOf(stored).find(([k]) => k === id);
  const own = pairsOf(mine).find(([k]) => k === id);
  if (JSON.stringify(theirs?.[1]) === JSON.stringify(own?.[1])) return mine;
  if (theirs) return storedText(mine, id, theirs[1]);
  return JSON.stringify(pairsOf(mine).filter(([k]) => k !== id));
}

/**
 * A mount starts showing `key` (its view of `id`, or the key's own when null). The first mount of
 * the key takes what storage holds now; the first mount of an id takes that id's view from storage.
 * Returns its leave.
 */
export function showKey(key: string, id: string | null, fn: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  let ids = shownIds.get(key);
  if (!ids) shownIds.set(key, (ids = new Map()));
  let adopted = false;
  if (set.size === 0) live.set(key, rawOf(key));
  else if (id !== null && !ids.get(id)) {
    const cur = live.get(key) ?? null;
    const next = adoptId(cur, rawOf(key), id);
    if (next !== cur) { live.set(key, next); adopted = true; }
  }
  ids.set(id, (ids.get(id) ?? 0) + 1);
  set.add(fn);
  // The other mounts of the key read the new text (their own ids' views are as they were).
  if (adopted) for (const other of [...set]) if (other !== fn) other();
  return () => {
    set!.delete(fn);
    const n = (ids!.get(id) ?? 1) - 1;
    if (n > 0) ids!.set(id, n); else ids!.delete(id);
    if (set!.size === 0) { live.delete(key); shownIds.delete(key); }
  };
}

/**
 * Sets `id`'s view (or the key's own, id null) to `v` in this tab and in storage, and tells this
 * tab's mounts. This tab's text changes only where it wrote: another tab's newer views of other
 * ids stay out of it (they are kept in storage, merged under this write). A pick of what this tab
 * shows already still goes to storage when another tab left something else there, so the user's
 * last pick is the one kept. True when this tab's view changed.
 */
export function writeView(key: string, id: string | null, v: unknown): boolean {
  const cur = shownText(key);
  const text = storedText(cur, id, v);
  const raw = rawOf(key);
  const stored = id === null ? text : storedText(raw, id, v);
  const changed = text !== cur;
  if (!changed && stored === raw) return false;
  if (changed && live.has(key)) live.set(key, text);
  // Storage off or full: the choice still holds for this load, it is just not kept.
  try { localStorage.setItem(key, stored); unstored.delete(key); } catch { unstored.set(key, stored); }
  if (changed) for (const fn of [...(listeners.get(key) ?? [])]) fn();
  return changed;
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
  // Every mount of this key in this tab shows one text, and a write from one of them shows in all
  // (two file explorers open on Home, say); another tab's write never does (see the header).
  const raw = useSyncExternalStore(useCallback((fn) => showKey(key, id, fn), [key, id]), () => snapshotOf(key, id), () => null);
  const pick = (r: string | null): T => {
    const v = storedView(r, id, accept);
    if (v !== undefined) return v;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `initial` and `accept` are fixed per call site
  const value = useMemo(() => pick(raw), [raw, id]);
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    const prev = pick(shownText(key));
    const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
    // An updater that hands back what it read changes nothing (React's rule too): no write.
    if (typeof next === 'function' && Object.is(v, prev)) return;
    writeView(key, id, v);
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
