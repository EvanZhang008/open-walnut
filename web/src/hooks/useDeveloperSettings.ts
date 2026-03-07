import { useSyncExternalStore } from 'react';

const KEY = 'walnut:show_ui_only_triage';

function subscribe(cb: () => void): () => void {
  window.addEventListener('storage', cb);
  // Also listen for custom event so same-tab writes trigger re-render
  window.addEventListener('walnut-dev-settings', cb);
  return () => {
    window.removeEventListener('storage', cb);
    window.removeEventListener('walnut-dev-settings', cb);
  };
}

function getSnapshot(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch { return false; }
}

/** Read the developer setting for showing UI-only triage messages. Reactive to changes. */
export function useShowUiOnlyTriage(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Write the developer setting (triggers reactive update in all hooks). */
export function setShowUiOnlyTriage(value: boolean): void {
  try { localStorage.setItem(KEY, String(value)); } catch { /* private browsing */ }
  window.dispatchEvent(new Event('walnut-dev-settings'));
}
