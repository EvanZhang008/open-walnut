/**
 * Which holds a project-level change may clear (2026-11-21, the lead: a project made local only
 * stops syncing to the outside service; it never lifts a task's own `private` or `chosen` hold,
 * which also keeps the task off every host's copies, replication/host-private.ts).
 *
 * A hold is the task's own (any state: the user's words or the model found it private, the
 * model could not judge it, a person or an agent chose Local, the model is judging it) unless a
 * project-level step made it only to stop a sync: those carry `via: 'project'` (a project being
 * made local stamps its tasks, a task moved into another service's project is held for a Sync
 * choice). Only such a hold goes when its project stops syncing, or when the task moves to a
 * project that syncs nowhere. Every project-level path asks `projectOwnsHold`; none tests a
 * state. tests/core/private-tasks/hold-owner.test.ts walks SYNC_HOLD_STATES against each path.
 */
import type { SyncHold } from '../types.js';

/** The reasons such holds carried before `via` existed (a batch in progress across an upgrade). */
const LEGACY_PROJECT_REASONS = ['Moved here', 'Its project stopped syncing to '] as const;

/** Whether a project-level change owns this hold, so its project going local may clear it. */
export function projectOwnsHold(hold: Pick<SyncHold, 'via' | 'reason'> | undefined | null): boolean {
  if (!hold) return false;
  if (hold.via === 'project') return true;
  const reason = hold.reason ?? '';
  return LEGACY_PROJECT_REASONS.some((p) => reason.startsWith(p));
}

/**
 * The reason a subtask's hold carries when it went local with its parent (task-manager.ts makeTaskLocal):
 * written for a project made local, for a person's or an agent's Local, and for a stopped push alike,
 * so the reason alone never says a project made it.
 */
export const PARENT_MADE_LOCAL_REASON = 'Its parent task was made local';

/**
 * projectOwnsHold for a task whose parent the caller can read: also a subtask's hold made before
 * `via` existed in the same step as its parent's (the same time and service) when the project owns the
 * parent's (a project made local in batches that span an upgrade: its parents are cleared, so are they).
 */
export function projectOwnsTaskHold(
  task: { sync_hold?: SyncHold | null; parent_task_id?: string | null },
  parentOf: (id: string) => { sync_hold?: SyncHold | null } | undefined,
): boolean {
  const hold = task.sync_hold;
  if (projectOwnsHold(hold)) return true;
  if (!hold || hold.via !== undefined || hold.reason !== PARENT_MADE_LOCAL_REASON || !task.parent_task_id) return false;
  const parent = parentOf(task.parent_task_id)?.sync_hold;
  return !!parent && parent.at === hold.at && parent.target === hold.target && projectOwnsHold(parent);
}

/** The hold a task keeps once its project syncs nowhere: its own, or none when the project made it. */
export function holdWhenProjectLocal<H extends SyncHold>(hold: H): H | null {
  return projectOwnsHold(hold) ? null : hold;
}
