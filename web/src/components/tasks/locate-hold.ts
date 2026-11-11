/**
 * A locate keeps its task on screen after it ran (TodoPanel's focus effect).
 *
 * A locate (Find on Home, a task link, a dock card) opened the place the task was drawn in at that
 * moment, once. A task often moves right after: an ask's turn ends and its status goes from Working
 * to Needs you to Waiting a second later, so it left the open section for the folded Waiting one and
 * the panel showed no selected row at all (2026-11-02, mail-ask-drawer S4-11). The same happened to a
 * task that arrived late, changed tier, or left its folder.
 *
 * So a locate asked from outside the task panel now HOLDS: while the task stays the focused one and
 * the person does not touch the panel, every change of where it is drawn runs the locate again, which
 * opens its new place and scrolls to it. A click, a key, a wheel or a touch in the panel ends the
 * hold: from then on the person steers, and their own folds stay as they leave them. A page-load
 * restore never holds, so a fold the person saved is kept on a reload.
 *
 * Pure helpers here; the wiring is in TodoPanel.
 */
import type { Task } from '@open-walnut/core';

/** A focus asked this soon after a gesture in the panel came from the panel itself (a row click). */
export const PANEL_GESTURE_MS = 1_500;

export interface LocateHold {
  /** The task the locate showed. */
  id: string;
  /** Where it was drawn when the hold last showed it (`locatePlaceSig`). */
  sig: string;
}

/** True when the locate came from a gesture inside the task panel (it needs no hold: the row was in view). */
export function fromPanelGesture(now: number, lastGestureAt: number): boolean {
  return lastGestureAt > 0 && now - lastGestureAt >= 0 && now - lastGestureAt < PANEL_GESTURE_MS;
}

export interface PlaceFacts {
  /** The tier it is pinned in (null: not pinned). */
  tier: string | null;
  /** The board's own predicate says the list draws it (no focus override). */
  passes: boolean;
  /** Held in its old place through a completion or parking grace. */
  held: boolean;
}

/**
 * Everything that decides WHERE the panel draws a task, as one string. Any change means its place may
 * have moved, so a held locate runs again. Built from the task and the board's predicate only, never
 * from the drawn rows: a focus override puts the located row into a section, and a key read from the
 * drawn rows would change because of the locate itself.
 */
export function locatePlaceSig(task: Task, facts: PlaceFacts): string {
  const us = task.user_status;
  return JSON.stringify([
    // The kind too: Flat draws a task nobody started under Not started, out of Waiting.
    task.phase, task.status, us?.state ?? null, us?.kind ?? null, us?.snoozed ? 1 : 0, task.start_date ?? null,
    (task as { watched_at?: string | null }).watched_at ? 1 : 0,
    (task as { background_at?: string | null }).background_at ? 1 : 0,
    task.project || '', task.group_id ?? null, task.parent_task_id ?? null,
    facts.tier, facts.passes ? 1 : 0, facts.held ? 1 : 0,
  ]);
}

/** The task's ancestors, nearest first (a cycle or a chain past `cap` stops the walk). */
export function ancestorChain(taskId: string, parentOf: (id: string) => string | undefined, cap = 10): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([taskId]);
  for (let cur = parentOf(taskId); cur !== undefined && !seen.has(cur) && chain.length < cap; cur = parentOf(cur)) {
    chain.push(cur);
    seen.add(cur);
  }
  return chain;
}

/**
 * Every folder a fold could hide the task under: its own folder, its ancestors' folders (a subtask
 * carries no folder of its own and hides with its parent's), and each one's folders above it.
 */
export function foldersHolding(
  taskIds: readonly string[],
  groupOf: (id: string) => string | undefined,
  folderAncestorsOf: (gid: string) => readonly string[],
): string[] {
  const out = new Set<string>();
  for (const id of taskIds) {
    const gid = groupOf(id);
    if (!gid) continue;
    out.add(gid);
    for (const a of folderAncestorsOf(gid)) out.add(a);
  }
  return [...out];
}
