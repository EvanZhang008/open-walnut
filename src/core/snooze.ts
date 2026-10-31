/**
 * A snoozed task is not raised to the user until its snooze runs out (2026-10-30, the user, after
 * snoozing a task for two weeks: "if something you look at is already snoozed, don't remind me again,
 * unless you have a particular reason").
 *
 * A snooze is a start date still to come (`Task.start_date`, what the task menu's Start / Snooze
 * until and `task_update start_date` write), the task's own or, when it has none, the nearest
 * ancestor's, as the home panel's Date rule reads it (web task-date-filter.ts isDeferredByStart). A
 * bare date starts at local midnight of that day.
 *
 * While it holds, every path that reminds the user of the task asks here: the derived status
 * (user-status.ts: no Needs you in any count, card, list or Brief ask), the 4-hour re-checks
 * (sessions/needs-recheck.ts, sessions/letter-recheck.ts), the status push to its leader, VP and
 * Main (sessions/status-push.ts), and a new letter about it (human-inbox/letter-ops.ts, which takes
 * one only with a `snooze_reason`). When it runs out, the task reads where its state puts it, and
 * the re-checks count from that moment. tests/core/task-state-ratchet.test.ts fails on a new reminder
 * path that does not ask.
 */
import type { Task } from './types.js';

/** When a start date begins (ms), or NaN. A bare YYYY-MM-DD is local midnight of that day. */
export function startDateMs(start: string | null | undefined): number {
  const v = (start ?? '').trim();
  if (!v) return NaN;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  return Date.parse(v);
}

type Snoozable = Pick<Task, 'id' | 'start_date' | 'parent_task_id'>;

/** The start date in effect: the task's own, else its nearest ancestor's (10 levels at most). */
export function effectiveStartDate(task: Snoozable, byId?: ReadonlyMap<string, Snoozable>): string | undefined {
  let cur: Snoozable | undefined = task;
  for (let hops = 0; cur && hops <= 10; hops++) {
    if (cur.start_date) return cur.start_date;
    cur = cur.parent_task_id ? byId?.get(cur.parent_task_id) : undefined;
  }
  return undefined;
}

/** The start date the task is snoozed until (as set), or null when it is not snoozed now. */
export function snoozedUntil(task: Snoozable, byId?: ReadonlyMap<string, Snoozable>, nowMs = Date.now()): string | null {
  const start = effectiveStartDate(task, byId);
  const at = startDateMs(start);
  return Number.isFinite(at) && at > nowMs ? start! : null;
}

/** When a snooze of the task ran out (ms), or NaN when it has none in the past: a clock that
 *  counts how long something went unchecked starts again from here. */
export function snoozeEndedMs(task: Snoozable, byId?: ReadonlyMap<string, Snoozable>, nowMs = Date.now()): number {
  const at = startDateMs(effectiveStartDate(task, byId));
  return Number.isFinite(at) && at <= nowMs ? at : NaN;
}

/** Shortest `snooze_reason` a letter about a snoozed task takes (the `project_reason` floor). */
export const SNOOZE_REASON_MIN = 10;

