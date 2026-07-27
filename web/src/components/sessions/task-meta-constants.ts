/**
 * Shared task-metadata constants (tier + priority options).
 * Used by TaskQuickActions kebab menu and SessionPathSelector meta footer.
 */

import type { TaskPriority } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import type { QuickStartTaskMeta } from './SessionPathSelector';

/** Quick-start defaults. Lives here (not in SessionPathSelector) so MetaFooter's
 *  "More · N" changed-from-default badge can import it without a runtime import
 *  cycle — both it and the picker share one definition of "default". */
export const DEFAULT_META: QuickStartTaskMeta = {
  starred: true,         // mirrors existing quick-start behavior (task.starred = true)
  needs_attention: false,
  priority: 'none',
  // Satellite, not Focus: a launched session is "in flight", not necessarily
  // what the user is staring at right now — Focus filled up with every session
  // ever started. The last tier the user picked wins over this baseline
  // (readLastPinTier), so this only decides the very first launch.
  pinTier: 'satellite',
  model: undefined,      // Auto — Claude/config default picks the model unless user overrides
  engine: undefined,     // Claude (native) unless the user flips the engine toggle
};

export const TIER_OPTIONS: { value: FocusTier; label: string }[] = [
  { value: 'focus', label: 'Focus' },
  { value: 'satellite', label: 'Satellite' },
  { value: 'wait', label: 'Wait' },
];

/** Last tier picked in the session launcher. `open-walnut-` prefix = mirrored to
 *  the server by ui-prefs-sync, so the choice follows the user across browsers. */
export const LAUNCHER_PIN_TIER_KEY = 'open-walnut-launcher-pin-tier';
/** Stored marker for "explicitly not pinned" — distinct from "never chose",
 *  which must still fall back to the DEFAULT_META tier. */
const PIN_TIER_NONE = 'none';

/** The tier a fresh launcher opens on: last explicit pick, else the default. */
export function readLastPinTier(): FocusTier | undefined {
  try {
    const raw = localStorage.getItem(LAUNCHER_PIN_TIER_KEY);
    if (raw === PIN_TIER_NONE) return undefined;
    if (TIER_OPTIONS.some(t => t.value === raw)) return raw as FocusTier;
  } catch { /* storage disabled — fall through to the default */ }
  return DEFAULT_META.pinTier;
}

/** Remember the tier the user just picked (undefined = deliberately unpinned). */
export function rememberPinTier(tier: FocusTier | undefined): void {
  try { localStorage.setItem(LAUNCHER_PIN_TIER_KEY, tier ?? PIN_TIER_NONE); } catch { /* quota */ }
}

/** Meta a freshly-opened launcher starts from: the defaults with the user's
 *  remembered tier applied. Use this instead of DEFAULT_META wherever a NEW
 *  launch is being seeded (DEFAULT_META stays the static baseline the
 *  changed-from-default badge compares against). */
export function freshLauncherMeta(): QuickStartTaskMeta {
  return { ...DEFAULT_META, pinTier: readLastPinTier() };
}

export const TIER_COLORS: Record<FocusTier, string> = {
  focus: 'var(--accent)',
  satellite: 'var(--fg-muted)',
  wait: '#8e8e93',
};

export const PRIORITY_OPTIONS: { value: TaskPriority; icon: string; label: string }[] = [
  { value: 'immediate', icon: '!!', label: 'Immediate' },
  { value: 'important', icon: '!', label: 'Important' },
  { value: 'backlog', icon: '~', label: 'Backlog' },
  { value: 'none', icon: '--', label: 'None' },
];

/** No PIN_CYCLE: the pin tier is picked directly in the shared PinTierPicker
 *  (three visible buttons), never cycled through by repeated clicks. */
export const PRIORITY_CYCLE: Array<TaskPriority | undefined> = [undefined, 'immediate', 'important', 'backlog'];

export function nextValue<T>(values: T[], current: T): T {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length];
}
