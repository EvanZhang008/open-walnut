/**
 * Phone behavior of the home task rows, kept out of TodoPanel.tsx (which only
 * wires these in; spec 4.2 / 4.7 Home):
 *
 * - The phase circle is a picture on a phone (C57). One tap on it used to
 *   complete the task, and completing stops its session with no undo; the
 *   circle sits right under the thumb. `phonePhaseAttrs()` takes it out of the
 *   focus order and the accessibility tree; phone-pages.css drops its pointer
 *   events, so a tap on it is a tap on the row (opens the row).
 * - A title tap always opens (C59): the session when the row has one, else the
 *   task detail. Renaming lives in task detail; the old "second tap on a
 *   focused row edits the title" raised the keyboard after every Back.
 * - The home list holds its order under the thumb (useStableOrder) and the
 *   collapsed parent rows read the whole task list (needs-you.ts) through
 *   `usePhoneHomeList`, one call in TodoPanel.
 */
import { useLayoutEffect, useSyncExternalStore } from 'react';
import type { Task } from '@open-walnut/core';
import { isPhoneLayout, usePhoneLayout } from '@/hooks/usePhoneLayout';
import { useStableOrder } from './useStableOrder';

export { isPhoneLayout };

export interface PhonePhaseAttrs { 'aria-hidden'?: true; tabIndex?: number }

/** Spread onto the row's phase circle button. */
export function phonePhaseAttrs(phone: boolean = isPhoneLayout()): PhonePhaseAttrs {
  return phone ? { 'aria-hidden': true, tabIndex: -1 } : {};
}

/**
 * The focus options a row tap passes on. Desktop: never the detail (the info
 * button opens it). Phone: a row with no session opens its task detail,
 * because there is nothing else to open.
 */
export function phoneRowFocusOpts(sessionId: string | null | undefined, phone: boolean = isPhoneLayout()): { openDetail: boolean } {
  return { openDetail: phone && !sessionId };
}

/**
 * A phone opens a row as a layer over the list (N2-01), so the tap is not a
 * locate: the list under the layer must not unfold a project, switch tabs or
 * scroll, or Back lands somewhere else and the next tap opens another task.
 * Only an explicit Locate, a new task and a tier quick-add still move it.
 */
export function phoneOpenKeepsList(scope: 'all' | 'pinned' | 'locate' | 'created' | undefined, phone: boolean = isPhoneLayout()): boolean {
  return phone && (scope === undefined || scope === 'all');
}

/** A title tap on a phone opens the row, never the inline editor. */
export function phoneTitleTapOpens(isFocused: boolean, phone: boolean = isPhoneLayout()): boolean {
  return !isFocused || phone;
}

// The whole task list, for rows that need more than their own task (needs-you).
let homeTasks: readonly Task[] = [];
let homeTasksById: ReadonlyMap<string, Task> = new Map();
const listeners = new Set<() => void>();
function publishHomeTasks(tasks: readonly Task[]): void {
  if (tasks === homeTasks) return;
  homeTasks = tasks;
  homeTasksById = new Map(tasks.map((t) => [t.id, t]));
  for (const l of [...listeners]) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
/** The title of the home task that owns `sid`, for a session whose own record is gone (N29). */
export function taskTitleForSession(sid: string | null | undefined, tasks: Iterable<Task>): string | null {
  if (!sid) return null;
  for (const t of tasks) {
    if (t.session_id === sid || t.session_ids?.includes(sid)) return t.title || null;
  }
  return null;
}

/** Subscribes only while `enabled`, and re-renders only when the title changes. */
export function useHomeTaskTitleForSession(sid: string | null | undefined, enabled: boolean): string | null {
  return useSyncExternalStore(
    enabled ? subscribe : noSubscribe,
    () => (enabled ? taskTitleForSession(sid, homeTasks) : null),
    () => null,
  );
}
const noSubscribe = () => () => {};

const EMPTY: ReadonlyMap<string, Task> = new Map();
export function useHomeTasksById(): ReadonlyMap<string, Task> {
  return useSyncExternalStore(subscribe, () => homeTasksById, () => EMPTY);
}

const taskKey = (t: Task) => t.id;

/** The home list's scroll box: the stacked view's one scroller, else the list. */
export function homeListScroller(): HTMLElement | null {
  // Any home view: a single-tier tab scrolls this box too on a phone (R3-03).
  return document.querySelector<HTMLElement>('.todo-panel .home-navigation-scroll')
    ?? document.querySelector<HTMLElement>('.todo-panel .todo-panel-list');
}

/**
 * TodoPanel's one call: the sorted rows with their order held under the thumb
 * on a phone, and the full list published for the parent rows.
 */
export function usePhoneHomeList(sorted: Task[], allTasks: readonly Task[]): Task[] {
  const phone = usePhoneLayout();
  useLayoutEffect(() => { if (phone) publishHomeTasks(allTasks); }, [phone, allTasks]);
  return useStableOrder(sorted, taskKey, { enabled: phone, getScroller: homeListScroller });
}
