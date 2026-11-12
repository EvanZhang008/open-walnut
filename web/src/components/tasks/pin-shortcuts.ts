/**
 * Which pin choices a task menu shows on its first level (2026-11-11, the user: "default only
 * put the focus satellite ... people can choose to add what inside the first level list", then
 * "remove the parked ... just have 2 focus, satellite ... the vt we can still keep as it is from
 * plugin", and "don't need unpin also, another click of the selected one is unpin"). The first
 * level holds one row: the label, the user's shortcuts, then More, where every other tier sits
 * and the user picks the shortcuts. Pure functions only: the menu (PinShortcutChoices.tsx) keeps
 * the list with usePageView('task-menu', 'pin-shortcuts').
 *
 * Unknown ids are KEPT in the stored list and only left out of what is shown: custom and plugin
 * tiers load after the menu first renders, and a tier removed and made again under the same id
 * comes back where it was. Retired ids (Parked's `wait`, a short-lived `unpin`) are dropped on
 * read, so an older stored list reads fine and the next write leaves them out. A list of ids is tiny, so nothing caps it; the row
 * scrolls sideways, so any number of shortcuts keeps the menu one line tall.
 */

import { isRetiredTier } from '@/api/focus';

/** The built-in tiers the first level offers. Parked (`wait`) is not one of them. */
export const FIRST_LEVEL_BUILTIN_TIERS: readonly string[] = ['focus', 'satellite'];

/** Ids the first level never offers and a stored list sheds: every retired tier
 *  (`isRetiredTier`: Parked's `wait`, the older `backlog`), and `unpin`,
 *  the Unpin choice a short-lived build kept in this list. None is ever a custom tier id
 *  (those are `ct_<id>`). */
export const RETIRED_PIN_SHORTCUT_IDS: readonly string[] = ['wait', 'unpin'];
const NOT_ON_FIRST_LEVEL = { has: (id: string): boolean => isRetiredTier(id) || RETIRED_PIN_SHORTCUT_IDS.includes(id) };

/** The first level out of the box: Focus and Satellite. */
export const DEFAULT_PIN_SHORTCUTS: readonly string[] = FIRST_LEVEL_BUILTIN_TIERS;

/** The choices the first level offers: every tier handed in except the retired ids (Parked);
 *  custom and plugin tiers (a Virtual Teammate tier, say) stay as they are given. */
export function firstLevelPinChoices<T extends { value: string }>(choices: readonly T[]): T[] {
  return choices.filter((c) => !NOT_ON_FIRST_LEVEL.has(c.value));
}

/** The stored value's shape: a list of strings (usePageView's `accept`). */
export function isPinShortcutList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** The stored list with empty, repeated (first one kept) and retired ids dropped. A value of
 *  the wrong shape reads as the default. Other unknown ids stay (see the header); they are
 *  never shown, since only known choices are. */
export function normalizePinShortcuts(v: unknown): string[] {
  if (!isPinShortcutList(v)) return [...DEFAULT_PIN_SHORTCUTS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of v) {
    if (!id || seen.has(id) || NOT_ON_FIRST_LEVEL.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Whether `value` is on the first level. */
export function isPinShortcut(stored: unknown, value: string): boolean {
  return normalizePinShortcuts(stored).includes(value);
}

/** The list with `value` added (at the end) or taken off. Unknown ids are left as they are. */
export function togglePinShortcut(stored: unknown, value: string): string[] {
  const list = normalizePinShortcuts(stored);
  return list.includes(value) ? list.filter((id) => id !== value) : [...list, value];
}

/** The known choices on the first level, in the choices' own order (built-ins, then custom
 *  tiers), so the row never reorders as shortcuts are added. */
export function pinShortcutEntries<T extends { value: string }>(stored: unknown, choices: readonly T[]): T[] {
  const on = new Set(normalizePinShortcuts(stored));
  return choices.filter((c) => on.has(c.value));
}

/** The known choices behind More: only those NOT on the row (each choice shows in exactly one
 *  of the two), in the same order. A pinned tier that is hidden from the row is here. */
export function pinMoreEntries<T extends { value: string }>(stored: unknown, choices: readonly T[]): T[] {
  const on = new Set(normalizePinShortcuts(stored));
  return choices.filter((c) => !on.has(c.value));
}
