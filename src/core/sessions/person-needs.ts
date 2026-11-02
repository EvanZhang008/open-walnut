/**
 * A person who sets a task to NEED_ACTION asks for it to need them: that is a real ask, whatever
 * its session's last turn said (2026-11-02). Only a real ask reaches Needs you, and a bare
 * NEED_ACTION after a turn asks nothing, so the user's own pick ("Needs you" in a task's status
 * control, the phone's, the CLI from a terminal) would otherwise read "Waiting on nothing".
 *
 * Every request route that writes a phase marks the task when the request names no caller session
 * (`x-walnut-caller-sid`), right after its phase write; a later phase move makes the mark stale by
 * itself (it is older than `phase_changed_at`). A session's, a lead's or Walnut's own move never
 * marks: theirs is an ask only with words of the user's kind (their report).
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';


/** Whether a person set the task's current NEED_ACTION themself. Pure. */
export function personMarkedNeeds(task: Pick<Task, 'phase' | 'phase_changed_at'> & { needs_marked_at?: string | null }): boolean {
  if (task.phase !== 'NEED_ACTION' || !task.needs_marked_at) return false;
  const mark = Date.parse(task.needs_marked_at);
  const moved = Date.parse(task.phase_changed_at ?? '');
  // The mark is written right after its own phase write, so it is never older than that move;
  // any later move (a new turn, its hand-back) is newer than the mark.
  return Number.isFinite(mark) && (!Number.isFinite(moved) || mark >= moved);
}

/** After a request's phase write: mark the tasks a person set to NEED_ACTION. Never throws. */
export async function markPersonNeeds(ids: readonly string[], phase: unknown, callerSid: string | undefined): Promise<void> {
  if (phase !== 'NEED_ACTION' || callerSid || !ids.length) return;
  const { updateTaskRaw } = await import('../task-manager.js');
  const at = new Date().toISOString();
  for (const id of ids) {
    await updateTaskRaw(id, { needs_marked_at: at } as Partial<Task>, {
      emitEvent: true, push: false, source: 'person-needs',
      shouldUpdate: (cur) => cur.phase === 'NEED_ACTION',
    }).catch((err) => log.task.debug('person needs mark skipped', { taskId: id, error: err instanceof Error ? err.message : String(err) }));
  }
}
