import { useSyncExternalStore } from 'react';

/**
 * All UI Only message categories that can be individually toggled.
 * Each maps to a localStorage key: `walnut:show_ui_only_{category}`.
 */
export const UI_ONLY_CATEGORIES = [
  { key: 'triage', label: 'Triage results', description: 'Session triage analysis notifications' },
  { key: 'session', label: 'Session results', description: 'Completed session output summaries' },
  { key: 'session-error', label: 'Session errors', description: 'Session error notifications' },
  { key: 'subagent', label: 'Subagent results', description: 'Embedded subagent result notifications' },
  { key: 'heartbeat', label: 'Heartbeat', description: 'Periodic health check results' },
  { key: 'agent-error', label: 'Agent errors', description: 'Agent and cron error notifications' },
] as const;

export type UiOnlyCategory = typeof UI_ONLY_CATEGORIES[number]['key'];

const KEY_PREFIX = 'walnut:show_ui_only_';

// Legacy key for backwards compatibility
const LEGACY_KEY = 'walnut:show_ui_only_triage';

function subscribe(cb: () => void): () => void {
  window.addEventListener('storage', cb);
  window.addEventListener('walnut-dev-settings', cb);
  return () => {
    window.removeEventListener('storage', cb);
    window.removeEventListener('walnut-dev-settings', cb);
  };
}

function getSnapshotForCategory(category: UiOnlyCategory): boolean {
  try {
    // For triage, also check legacy key
    if (category === 'triage') {
      const modern = localStorage.getItem(`${KEY_PREFIX}${category}`);
      if (modern !== null) return modern === 'true';
      return localStorage.getItem(LEGACY_KEY) === 'true';
    }
    return localStorage.getItem(`${KEY_PREFIX}${category}`) === 'true';
  } catch { return false; }
}

/** Read the developer setting for a specific UI Only category. Reactive to changes. */
export function useShowUiOnlyCategory(category: UiOnlyCategory): boolean {
  return useSyncExternalStore(subscribe, () => getSnapshotForCategory(category));
}

// Cached snapshot for useUiOnlySettings — avoids creating new objects on every call
let _cachedSettings: Record<UiOnlyCategory, boolean> | null = null;
let _cachedKey = '';

function getUiOnlySettingsSnapshot(): Record<UiOnlyCategory, boolean> {
  // Build a cache key from all settings values
  const key = UI_ONLY_CATEGORIES.map(c => getSnapshotForCategory(c.key) ? '1' : '0').join('');
  if (_cachedSettings && _cachedKey === key) return _cachedSettings;
  const result = {} as Record<UiOnlyCategory, boolean>;
  for (const cat of UI_ONLY_CATEGORIES) {
    result[cat.key] = getSnapshotForCategory(cat.key);
  }
  _cachedSettings = result;
  _cachedKey = key;
  return result;
}

/** Read all UI Only category settings as a map. Reactive to changes. */
export function useUiOnlySettings(): Record<UiOnlyCategory, boolean> {
  return useSyncExternalStore(subscribe, getUiOnlySettingsSnapshot);
}

/** Write a specific UI Only category setting (triggers reactive update in all hooks). */
export function setShowUiOnlyCategory(category: UiOnlyCategory, value: boolean): void {
  try {
    localStorage.setItem(`${KEY_PREFIX}${category}`, String(value));
    // Keep legacy key in sync for triage
    if (category === 'triage') {
      localStorage.setItem(LEGACY_KEY, String(value));
    }
  } catch { /* private browsing */ }
  window.dispatchEvent(new Event('walnut-dev-settings'));
}

// ── Legacy API (backwards compat) ──

/** @deprecated Use useShowUiOnlyCategory('triage') instead */
export function useShowUiOnlyTriage(): boolean {
  return useShowUiOnlyCategory('triage');
}

/** @deprecated Use setShowUiOnlyCategory('triage', value) instead */
export function setShowUiOnlyTriage(value: boolean): void {
  setShowUiOnlyCategory('triage', value);
}

/**
 * Check if a message should be hidden based on current UI Only settings.
 * Returns true if the message should be HIDDEN.
 *
 * Only hides messages with `notification: true` — agent turn responses
 * (which lack the notification flag) are always shown.
 */
export function shouldHideUiOnlyMessage(source?: string, notification?: boolean): boolean {
  if (!notification) return false;
  const category = source as UiOnlyCategory | undefined;
  if (!category) return false;
  const isKnown = UI_ONLY_CATEGORIES.some(c => c.key === category);
  if (!isKnown) return false;
  return !getSnapshotForCategory(category);
}
