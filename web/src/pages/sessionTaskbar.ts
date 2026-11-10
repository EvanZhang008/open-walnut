// Pure rules for Home's taskbar: the sessions the user has open but not shown.
//
// The bar has two parts (2026-11-07, the user: "leftmust be eplixt concisou", and a
// pushed-out session "can be part of recnetly open task on the mos tirght of the botom
// line"). LEFT, the chips: only sessions the user minimized himself (the Minimize
// button or its "..." menu item). RIGHT end, Recent: the last few real sessions that
// left the strip any other way (a close with ×, a sixth open evicting the oldest
// column, a lower panel count). The strip stays the one place that decides what is
// shown; the bar only watches it. A session that comes back onto the strip leaves
// both lists, and no id is ever in both.

import type { SessionSlot } from './sessionColumns';
import { isPlaceholderColumnId } from '@/utils/column-ids';
import type { Task } from '@open-walnut/core';
import { shownState } from '@open-walnut/user-status';
import { taskUserState } from '@/utils/session-status';

/** A column id that names a real session (not a draft, a launch or a workspace on its way). */
export function isRealSessionColumn(id: string): boolean {
  return !!id && !isPlaceholderColumnId(id);
}

/** How many sessions Recent keeps; the oldest drops off past it. */
export const RECENT_MAX = 12;

/** How many of them the bar shows as pills; the rest are in its "N more" menu (2026-11-09,
 *  the user: "max shoudl be 2 and a drop down that has more"). */
export const RECENT_SHOWN = 2;

/** Where a session that leaves the strip without a Minimize goes (2026-11-10, the user: "if we
 *  should have "recnet" side also have a setting to contorl, liek before all the redne tor
 *  minized will all go to below, have 2 otpions"): 'recent', the Recent end of the bar (a close,
 *  a column pushed out), or 'chips', a chip like a minimized one, as before Recent existed. */
export type TaskbarLeaving = 'recent' | 'chips';

export interface TaskbarSettings {
  /** No bar while it would hold only Recent (2026-11-10, the user: "this bar, if only has the
   *  recent don;t sow", then "add a setting for this"). Default on. */
  hideRecentOnly: boolean;
  leaving: TaskbarLeaving;
}

export const DEFAULT_TASKBAR_SETTINGS: TaskbarSettings = { hideRecentOnly: true, leaving: 'recent' };

/** The settings from config's `ui` values (or a stored copy), each falling back to its default. */
export function taskbarSettingsOf(v: { hideRecentOnly?: unknown; leaving?: unknown } | null | undefined): TaskbarSettings {
  return {
    hideRecentOnly: v?.hideRecentOnly !== false,
    leaving: v?.leaving === 'chips' ? 'chips' : 'recent',
  };
}

/** What the bar draws. Recent only with `leaving: 'recent'` (with 'chips' nothing goes there, and
 *  what an earlier choice left there waits unseen); the bar at all only with a chip, or with
 *  Recent while hideRecentOnly is off. */
export function taskbarView(lists: { chips: readonly string[]; recent: readonly string[] }, settings: TaskbarSettings): { shown: boolean; recent: boolean } {
  const recent = settings.leaving === 'recent' && lists.recent.length > 0;
  return { shown: lists.chips.length > 0 || (recent && !settings.hideRecentOnly), recent };
}

export interface TaskbarLists {
  /** Minimized by the user, in the order they joined (drag to reorder). */
  chips: string[];
  /** Left the strip some other way, newest first. */
  recent: string[];
}

/**
 * The bar after the strip went from `before` to `after`. `minimized` holds the ids the
 * user minimized in that change: only those become chips. Every other real session that
 * left goes to the front of Recent. A column whose id changed in place (a draft becoming
 * its session, plan -> exec) is a swap, not a session leaving: the swapped slot names the
 * id it replaced (SessionSlot.from). With `leaving: 'chips'` every real session that left
 * becomes a chip, as before Recent existed. Returns `lists` itself when nothing changed.
 */
export function taskbarAfterStripChange(
  lists: TaskbarLists,
  before: readonly SessionSlot[],
  after: readonly SessionSlot[],
  minimized: ReadonlySet<string>,
  leaving: TaskbarLeaving = 'recent',
): TaskbarLists {
  const shown = new Set(after.map(c => c.id));
  // Only a slot this change wrote can name a swap; an older one's `from` is history.
  const swappedAway = new Set(after.filter(c => c.from && !before.includes(c)).map(c => c.from!));
  const chips = lists.chips.filter(id => !shown.has(id));
  let recent = lists.recent.filter(id => !shown.has(id));
  for (const slot of before) {
    if (shown.has(slot.id) || !isRealSessionColumn(slot.id) || swappedAway.has(slot.id)) continue;
    if (minimized.has(slot.id) || leaving === 'chips') {
      if (!chips.includes(slot.id)) chips.push(slot.id);
      recent = recent.filter(id => id !== slot.id);
    } else if (!chips.includes(slot.id)) {
      recent = [slot.id, ...recent.filter(id => id !== slot.id)];
    }
  }
  recent = recent.slice(0, RECENT_MAX);
  if (sameList(chips, lists.chips) && sameList(recent, lists.recent)) return lists;
  return { chips, recent };
}

/** Put `id` on the chips from outside Home's strip (Minimize on another page's panel). */
export function minimizeOffStrip(lists: TaskbarLists, id: string): TaskbarLists {
  if (!isRealSessionColumn(id) || lists.chips.includes(id)) return lists;
  return { chips: [...lists.chips, id], recent: lists.recent.filter(r => r !== id) };
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The list without `id` (a chip's ×, or a Recent pill's ×). */
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

/**
 * The bar as stored. `minimized` is the chips' own field, written (an empty list included)
 * since chips became Minimize-only; before that, the one `legacy` field mixed sessions the
 * user minimized with ones a full strip pushed out, and nothing tells them apart. So until
 * the chips' field exists, none of those is a chip: they go to Recent, newest first.
 */
export function restoreTaskbar(minimized: unknown, recent: unknown, legacy: unknown): TaskbarLists {
  if (Array.isArray(minimized)) {
    const chips = parseChips(minimized);
    return { chips, recent: parseRecent(recent, chips) };
  }
  const old = parseChips(legacy).reverse();
  return { chips: [], recent: parseRecent([...parseChips(recent), ...old], []) };
}

/** Stored Recent from any shape, without the chips, at most RECENT_MAX. */
export function parseRecent(value: unknown, chips: readonly string[]): string[] {
  return parseChips(value).filter(id => !chips.includes(id)).slice(0, RECENT_MAX);
}

/** A chip's dot, in the colors every task pill wears: red Needs you, green Working, blue Done, grey
 *  only for a wait or a snooze (2026-11-09, the user: "we neve ruse the grey acutally if itis read
 *  it is read, we use red means it is ready, green is working ... grey might means it is wait liek
 *  wait staus, or snoozed"). */
export type ChipState = 'needs' | 'working' | 'waiting' | 'done';

/** The task's one user status (To read drawn as Needs you), a prompt waiting on the user as Needs
 *  you, a running turn as Working (`running` pulses the dot). A session with no task reads its
 *  process alone, an error as Needs you. Having seen a session never greys it. */
export function chipStateOf(
  task: Pick<Task, 'phase' | 'status' | 'user_status'> | undefined,
  status: { process_status?: string | null; pendingPermissionTool?: string | null } | null | undefined,
): { state: ChipState; running: boolean } {
  const running = status?.process_status === 'running';
  const user = task ? shownState(taskUserState(task)) : status?.process_status === 'error' ? 'needs' : null;
  const state: ChipState = status?.pendingPermissionTool || user === 'needs' ? 'needs'
    : running || user === 'working' ? 'working'
      : user === 'done' ? 'done' : 'waiting';
  return { state, running };
}
