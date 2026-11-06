// Pure rules for Home's taskbar: the sessions the user has open but not shown.
//
// A session the user opened is in exactly one of three places: a column on the
// strip (sessionColumns), a chip on the taskbar, or the background (neither).
// The strip stays the one place that decides what is shown; the taskbar only
// watches it. A real session that leaves the strip becomes a chip unless the
// user closed it (×), whatever took it off: Minimize, a sixth open evicting the
// oldest column, a lower panel count. A session that comes back onto the strip
// leaves the taskbar, so no id is ever in both.

import type { SessionSlot } from './sessionColumns';
import { isPlaceholderColumnId } from '@/utils/column-ids';

/** A column id that names a real session (not a draft, a launch or a workspace on its way). */
export function isRealSessionColumn(id: string): boolean {
  return !!id && !isPlaceholderColumnId(id);
}

/**
 * The chips after the strip went from `before` to `after`. `closed` holds the ids the
 * user closed in that change: those go to the background, never to a chip. A column
 * whose id changed in place (a draft becoming its session, plan -> exec) is a swap,
 * not a session leaving: the swapped slot names the id it replaced (SessionSlot.from). Chips keep
 * the order they joined in; a new one goes at the end. Returns `chips` itself when
 * nothing changed.
 */
export function chipsAfterStripChange(
  chips: readonly string[],
  before: readonly SessionSlot[],
  after: readonly SessionSlot[],
  closed: ReadonlySet<string>,
): string[] {
  const shown = new Set(after.map(c => c.id));
  // Only a slot this change wrote can name a swap; an older one's `from` is history.
  const swappedAway = new Set(after.filter(c => c.from && !before.includes(c)).map(c => c.from!));
  const next = chips.filter(id => !shown.has(id));
  for (const slot of before) {
    if (shown.has(slot.id) || !isRealSessionColumn(slot.id) || closed.has(slot.id)) continue;
    if (swappedAway.has(slot.id)) continue;
    if (!next.includes(slot.id)) next.push(slot.id);
  }
  return next.length === chips.length && next.every((id, i) => id === chips[i]) ? (chips as string[]) : next;
}

/** The chips without `id` (its × closes it to the background). */
export function removeChip(chips: readonly string[], id: string): string[] {
  return chips.includes(id) ? chips.filter(c => c !== id) : (chips as string[]);
}

/** Move chip `id` to `toIndex` (a drag on the taskbar). Out-of-range indexes clamp. */
export function moveChip(chips: readonly string[], id: string, toIndex: number): string[] {
  const from = chips.indexOf(id);
  if (from < 0) return chips as string[];
  const rest = chips.filter(c => c !== id);
  const at = Math.max(0, Math.min(rest.length, toIndex));
  if (at === from) return chips as string[];
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Stored chips from any shape: a string[] of real session ids, deduplicated. */
export function parseChips(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && isRealSessionColumn(v) && !out.includes(v)) out.push(v);
  }
  return out;
}
