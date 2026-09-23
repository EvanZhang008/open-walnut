import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useNotifications } from '@/contexts/notifications';

export const TASK_SHORTCUTS_KEY = 'walnut-todo-quick-views-visible';
/** Tab bar customization: the tabs the user took off it, and whether a tab with nothing in it hides. */
export const TAB_BAR_HIDDEN_TABS_KEY = 'walnut-todo-tab-bar-hidden-tabs';
export const TAB_BAR_HIDE_EMPTY_KEY = 'walnut-todo-tab-bar-hide-empty';
const CHANGE_EVENT = 'walnut:navigation-preference';

/** One localStorage key as a live string, shared by every component that reads it. */
function useStoredValue(key: string) {
  const { notify } = useNotifications();
  const read = useCallback(() => {
    try { return localStorage.getItem(key); } catch { return null; }
  }, [key]);
  const subscribe = useCallback((listener: () => void) => {
    const changed = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== key && event.key !== null) return;
      if (event instanceof CustomEvent && event.detail !== key) return;
      listener();
    };
    window.addEventListener('storage', changed);
    window.addEventListener(CHANGE_EVENT, changed);
    return () => {
      window.removeEventListener('storage', changed);
      window.removeEventListener(CHANGE_EVENT, changed);
    };
  }, [key]);
  const value = useSyncExternalStore(subscribe, read, () => null);
  const write = useCallback((next: string) => {
    try {
      localStorage.setItem(key, next);
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }));
    } catch {
      notify({ kind: 'operation-error', severity: 'error', title: 'Could not save navigation preference', persistent: false, dedupKey: `navigation-preference-error:${key}` });
    }
  }, [key, notify]);
  return [value, write] as const;
}

export function useNavigationPreference(key: string, fallback = false) {
  const [raw, write] = useStoredValue(key);
  const value = raw === null ? fallback : raw === 'true';
  const set = useCallback((next: boolean) => write(String(next)), [write]);
  return [value, set] as const;
}

/** A stored list of ids (JSON array). Parsed once per change, so the array is stable between renders. */
export function useNavigationList(key: string) {
  const [raw, write] = useStoredValue(key);
  const value = useMemo(() => {
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch { return []; }
  }, [raw]);
  const set = useCallback((next: string[]) => write(JSON.stringify(next)), [write]);
  return [value, set] as const;
}
