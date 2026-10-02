/**
 * Pure helpers for the Board's items and its team owner (TaskBoardPane.tsx,
 * useTaskBoard.ts): who keeps the board the pane shows, the bar's words, the
 * local merges of the user's ticks, answers and reminders, and the reminder
 * "due" rule. No React, no DOM: unit-pinned in tests/web/board-items-model.test.ts.
 */
import type { BoardProject, BoardCheck, BoardPayload, BoardReminder, StoreTaskLike } from './board-model';

/** A payload map, or `{}` for anything that is not a plain object (an older server sends none). */
export function recordOf<T>(v: unknown): Record<string, T> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, T> : {};
}

/** The task that keeps the board the pane shows; a payload without an owner (an older server) means the task asked for. */
export function boardOwnerId(payload: Pick<BoardPayload, 'board_task_id'> | null | undefined, taskId: string): string {
  const owner = payload?.board_task_id;
  return typeof owner === 'string' && owner ? owner : taskId;
}

export interface BoardBarTitle {
  text: string;
  /** Set only when the board belongs to another task of the team. */
  tooltip?: string;
  shared: boolean;
}

/** "Board" on the task's own board; "Board · <owner>" on a board the team shares. */
export function boardBarTitle(ownerId: string, taskId: string, ownerTitle?: string | null): BoardBarTitle {
  if (!ownerId || ownerId === taskId) return { text: 'Board', shared: false };
  const name = ownerTitle?.trim() || ownerId;
  return { text: `Board · ${name}`, tooltip: `Shared with your team: ${name} keeps this board`, shared: true };
}

/** The task and its ancestors, nearest first (the board it shows may belong to any of them). */
export function taskLineage(taskId: string, byId: ReadonlyMap<string, StoreTaskLike> | null, max = 16): string[] {
  const out = [taskId];
  let cur = byId?.get(taskId);
  while (cur?.parent_task_id && out.length < max && !out.includes(cur.parent_task_id)) {
    out.push(cur.parent_task_id);
    cur = byId?.get(cur.parent_task_id);
  }
  return out;
}

/** `map` with `id` set to `value` (null removes it); the same object when nothing moves. */
export function setEntry<T>(map: Record<string, T>, id: string, value: T | null): Record<string, T> {
  if (value === null) {
    if (!(id in map)) return map;
    const next = { ...map };
    delete next[id];
    return next;
  }
  return { ...map, [id]: value };
}

/** `PUT …/checks/:id` answers `{ check | null, hash }`; this is the same point in GET's shape. */
export function checkFromRoute(
  res: { check?: { hash?: string; read_at?: string } | null; hash?: string } | null | undefined,
  read: boolean,
  fallbackHash: string,
): BoardCheck {
  const hash = res?.hash || res?.check?.hash || fallbackHash;
  if (!read || !res?.check) return { hash, read: false };
  return res.check.read_at ? { hash, read: true, read_at: res.check.read_at } : { hash, read: true };
}

/** The point's current hash that a 409 `check_changed` carries (top level, or inside `error`). */
export function changedCheckHash(body: unknown): string | null {
  const b = body as { hash?: unknown; error?: { code?: unknown; hash?: unknown } } | null | undefined;
  if (!b || typeof b !== 'object' || b.error?.code !== 'check_changed') return null;
  const hash = typeof b.hash === 'string' ? b.hash : typeof b.error?.hash === 'string' ? b.error.hash : '';
  return hash || null;
}

/** Due: Walnut already told the leader, or its time has come. */
export function reminderDue(r: BoardReminder | null | undefined, now = Date.now()): boolean {
  if (!r) return false;
  if (r.fired_at) return true;
  const at = Date.parse(r.at);
  return Number.isFinite(at) && at <= now;
}

/** Answering a choice or posting in a thread clears its DUE reminder (the server does the same in that write). */
export function dropDueReminder(
  reminders: Record<string, BoardReminder>,
  target: string,
  now = Date.now(),
): Record<string, BoardReminder> {
  return reminderDue(reminders[target], now) ? setEntry(reminders, target, null) : reminders;
}

/** Task ids the projects name: their chips need live refs too. */
export function projectTaskIds(projects: Record<string, BoardProject>): string[] {
  const ids = new Set<string>();
  for (const c of Object.values(projects)) {
    if (Array.isArray(c?.tasks)) for (const t of c.tasks) if (typeof t === 'string' && t) ids.add(t);
  }
  return [...ids];
}
