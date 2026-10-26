import { useCallback, useSyncExternalStore } from 'react';

/**
 * The question map folded to its rail, as ONE user preference. Folded is the
 * default (2026-10-23, the user: the questions panel "shouldn't pop up unless
 * user click"); the map's "Keep open" stores `open`. ONE preference,
 * shared by every session panel and window. A module store over localStorage:
 * every open panel re-renders on a change in this tab, the `storage` event
 * carries it to other windows. The value is cached (a snapshot is read on every
 * render); a storage that refuses writes keeps the choice for this page's life.
 */
export const THREAD_MAP_PREF_KEY = 'walnut:thread-map.v1';

const listeners = new Set<() => void>();
let cached: boolean | null = null;

function read(): boolean {
  try {
    return localStorage.getItem(THREAD_MAP_PREF_KEY) !== 'open';
  } catch {
    return true;
  }
}

function snapshot(): boolean {
  if (cached === null) cached = read();
  return cached;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THREAD_MAP_PREF_KEY && e.key !== null) return;
    cached = read();
    fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function setThreadMapCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(THREAD_MAP_PREF_KEY, collapsed ? 'collapsed' : 'open');
  } catch {
    // Private mode / quota: the cached value below still holds.
  }
  cached = collapsed;
  for (const fn of listeners) fn();
}

export function useThreadMapCollapsed(): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribe, snapshot, () => true);
  const set = useCallback((next: boolean) => setThreadMapCollapsed(next), []);
  return [collapsed, set];
}
