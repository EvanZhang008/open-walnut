import { useSyncExternalStore } from 'react';

/**
 * All UI Only message categories that can be individually toggled.
 * Each maps to a localStorage key: `open-walnut:show_ui_only_{category}`.
 */
export const UI_ONLY_CATEGORIES = [
  { key: 'triage', label: 'Triage results', description: 'Session triage analysis notifications', defaultOn: false },
  { key: 'session', label: 'Session results', description: 'Completed session output summaries', defaultOn: false },
  { key: 'subagent', label: 'Subagent results', description: 'Embedded subagent result notifications', defaultOn: false },
  { key: 'heartbeat', label: 'Heartbeat "all clear"', description: 'Routine check-ins when nothing needs attention (issues always shown)', defaultOn: false },
] as const;

export type UiOnlyCategory = typeof UI_ONLY_CATEGORIES[number]['key'];

const KEY_PREFIX = 'open-walnut:show_ui_only_';

function subscribe(cb: () => void): () => void {
  window.addEventListener('storage', cb);
  window.addEventListener('open-walnut-dev-settings', cb);
  return () => {
    window.removeEventListener('storage', cb);
    window.removeEventListener('open-walnut-dev-settings', cb);
  };
}

function getSnapshotForCategory(category: UiOnlyCategory): boolean {
  const catDef = UI_ONLY_CATEGORIES.find(c => c.key === category);
  const defaultVal = catDef?.defaultOn ?? false;
  try {
    const stored = localStorage.getItem(`${KEY_PREFIX}${category}`);
    if (stored !== null) return stored === 'true';
    return defaultVal;
  } catch { return defaultVal; }
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
  } catch { /* private browsing */ }
  window.dispatchEvent(new Event('open-walnut-dev-settings'));
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

/** True when the user has EXPLICITLY set a category toggle (vs. sitting on the default). */
function hasExplicitOverride(category: UiOnlyCategory): boolean {
  try {
    return localStorage.getItem(`${KEY_PREFIX}${category}`) !== null;
  } catch { return false; }
}

/**
 * Check if a message should be hidden based on current UI Only settings.
 * Returns true if the message should be HIDDEN.
 *
 * Only hides messages with `notification: true` — agent turn responses
 * (which lack the notification flag) are always shown.
 *
 * `content` is optional and only consulted for the lane carve-out below; every
 * existing caller may keep passing (source, notification).
 */
export function shouldHideUiOnlyMessage(source?: string, notification?: boolean, content?: unknown): boolean {
  // Errors are never hidden. They used to be dropped here on the claim that they
  // had "a dedicated durable notification surface" — no such surface existed, so
  // a total outage looked identical to a short reply (2026-07-26: 18h of
  // all-turns-failing went unnoticed). They now render as a collapsed row
  // (see mergeAdjacentErrors) AND fire a toast for auth failures.
  if (source === 'agent-error' || source === 'session-error') return false;
  if (!notification) return false;
  const category = source as UiOnlyCategory | undefined;
  if (!category) return false;
  const isKnown = UI_ONLY_CATEGORIES.some(c => c.key === category);
  if (!isKnown) return false;
  // Personal AI LANE notices are visible by default. On the lane engine the turn runs
  // in a `claude` session, so this session-ref breadcrumb is the ONLY thing the
  // chat timeline ever gets for that turn — hidden by the `session` category's
  // defaultOn:false, the user saw literally nothing after sending a message. A
  // ref notice therefore ignores the DEFAULT, but still honors an EXPLICIT
  // opt-out (a user who turned the session category off means it).
  // Scoped to entries carrying a '<session-ref' tag so ordinary "Session Result"
  // summaries (from external coding sessions) stay hidden by default as before.
  if (category === 'session'
      && typeof content === 'string' && content.includes('<session-ref')
      && !hasExplicitOverride('session')) {
    return false;
  }
  return !getSnapshotForCategory(category);
}
