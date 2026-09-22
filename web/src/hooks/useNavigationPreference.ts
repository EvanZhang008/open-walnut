import { useCallback, useSyncExternalStore } from 'react';
import { useNotifications } from '@/contexts/notifications';

export const APP_SHORTCUTS_KEY = 'open-walnut-app-shortcuts-visible';
export const TASK_SHORTCUTS_KEY = 'walnut-todo-quick-views-visible';
const CHANGE_EVENT = 'walnut:navigation-preference';

export function useNavigationPreference(key: string, fallback = false) {
  const { notify } = useNotifications();
  const read = useCallback(() => {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value === 'true';
    } catch { return fallback; }
  }, [key, fallback]);
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
  const value = useSyncExternalStore(subscribe, read, () => fallback);
  const set = useCallback((next: boolean) => {
    try {
      localStorage.setItem(key, String(next));
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }));
    } catch {
      notify({ kind: 'operation-error', severity: 'error', title: 'Could not save navigation preference', persistent: false, dedupKey: `navigation-preference-error:${key}` });
    }
  }, [key, notify]);
  return [value, set] as const;
}
