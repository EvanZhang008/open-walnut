import { useCallback, useSyncExternalStore } from 'react';

/**
 * The fullscreen review sidebar folded to its bar, as ONE user preference
 * (2026-10-31, the user: the Ask here pane "stays there forever ... a big blank
 * space", give it "a vertical bar" to hide it any time). Open is the default.
 * Shared by every session panel and window, like useThreadMapCollapsed: a module
 * store over localStorage, the `storage` event carries a change to other windows,
 * and a storage that refuses writes keeps the choice for this page's life.
 */
export const REVIEW_SIDEBAR_PREF_KEY = 'walnut:review-sidebar.v1';

const listeners = new Set<() => void>();
let cached: boolean | null = null;

function read(): boolean {
  try {
    return localStorage.getItem(REVIEW_SIDEBAR_PREF_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function snapshot(): boolean {
  if (cached === null) cached = read();
  return cached;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== REVIEW_SIDEBAR_PREF_KEY && e.key !== null) return;
    cached = read();
    fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function setReviewSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(REVIEW_SIDEBAR_PREF_KEY, collapsed ? 'collapsed' : 'open');
  } catch {
    // Private mode / quota: the cached value below still holds.
  }
  cached = collapsed;
  for (const fn of listeners) fn();
}

export function useReviewSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribe, snapshot, () => false);
  const set = useCallback((next: boolean) => setReviewSidebarCollapsed(next), []);
  return [collapsed, set];
}
