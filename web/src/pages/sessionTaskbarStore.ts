// The one taskbar of the app (2026-11-08, the user: "org view shoud also have this minimze
// button adn bar, this should be global"). Its lists live here, outside any page, so the bar
// the app shell draws on every page and every session panel's Minimize share them. The rules
// of what goes where are pages/sessionTaskbar.ts; this file only holds, persists and shares.
//
// Writers: Home's strip (applyStripChange, after each change of its columns) and a Minimize
// from any panel (utils/taskbar-minimize.ts, heard here), the bar's own x, drag and open.

import { useSyncExternalStore } from 'react';
import { readLayoutField, writeLayoutField } from '@/utils/layout-record';
import { onMinimizeToTaskbar } from '@/utils/taskbar-minimize';
import {
  minimizeOffStrip, moveChip, removeChip, restoreTaskbar, taskbarAfterStripChange, type TaskbarLists,
} from './sessionTaskbar';
import type { SessionSlot } from './sessionColumns';

let lists: TaskbarLists | null = null;
const listeners = new Set<() => void>();

function current(): TaskbarLists {
  if (!lists) {
    lists = restoreTaskbar(readLayoutField('homeMinimized'), readLayoutField('homeRecent'), readLayoutField('homeTaskbar'));
    persist(lists);
  }
  return lists;
}

/** Writes the fields that changed from `prev` (all of them with none), so a window changing its
 *  Recent never writes back its stale chips over another window's Minimize. */
function persist(next: TaskbarLists, prev?: TaskbarLists): void {
  // The chips' field is always written, an empty list included: its presence says the old
  // mixed field was already read into Recent (restoreTaskbar). The old field itself is left as
  // it was, so an older release on the same data still opens with its own bar.
  if (!prev || next.chips !== prev.chips) writeLayoutField('homeMinimized', next.chips);
  if (!prev || next.recent !== prev.recent) writeLayoutField('homeRecent', next.recent.length > 0 ? next.recent : null);
}

function set(update: (prev: TaskbarLists) => TaskbarLists): void {
  const prev = current();
  const next = update(prev);
  if (next === prev) return;
  lists = next;
  persist(next, prev);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The bar's lists, live. */
export function useTaskbarLists(): TaskbarLists {
  return useSyncExternalStore(subscribe, current, current);
}

/** Home's strip went from `before` to `after`; `minimized` are the ids its Minimize took off. */
export function applyStripChange(before: readonly SessionSlot[], after: readonly SessionSlot[], minimized: ReadonlySet<string>): void {
  set(prev => taskbarAfterStripChange(prev, before, after, minimized));
}

export function closeChip(sessionId: string): void {
  set(prev => (prev.chips.includes(sessionId) ? { ...prev, chips: removeChip(prev.chips, sessionId) } : prev));
}

export function closeRecent(sessionId: string): void {
  set(prev => (prev.recent.includes(sessionId) ? { ...prev, recent: removeChip(prev.recent, sessionId) } : prev));
}

export function moveTaskbarChip(sessionId: string, toIndex: number): void {
  set(prev => {
    const chips = moveChip(prev.chips, sessionId, toIndex);
    return chips === prev.chips ? prev : { ...prev, chips };
  });
}

/** A session opened from the bar on a page that is not Home's strip: it leaves the bar. */
export function takeFromTaskbar(sessionId: string): void {
  set(prev => (prev.chips.includes(sessionId) || prev.recent.includes(sessionId)
    ? { chips: removeChip(prev.chips, sessionId), recent: removeChip(prev.recent, sessionId) }
    : prev));
}

// A Minimize on any panel: the session joins the chips. Home hears the same request and takes
// the column off its strip when it shows one (its strip change then finds the chip already there).
if (typeof window !== 'undefined') onMinimizeToTaskbar((sessionId) => set(prev => minimizeOffStrip(prev, sessionId)));

/** Tests only: forget the lists, to read them from storage again. */
export function resetTaskbarStoreForTests(): void {
  lists = null;
  for (const l of listeners) l();
}
