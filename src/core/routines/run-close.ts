/**
 * A routine run that ended with nothing for the user closes itself (2026-11-02, the user through
 * Main: two finished Inbox Triage runs, "Triage · 13:38" and "Triage · 16:38", sat in Needs you
 * with no letter and no hand-off until Main completed them by hand).
 *
 * The triage bookkeeping (triage/runs.ts) closes a run on its session's `session:result`, but a
 * turn can end without one: the 13:38 run's process died at spawn, came back, and its turn end was
 * seen only by the 30-second snapshot pull, which hands the task back without that event. So the
 * close keys off the task's own status, the one every surface reads: a run task (made by a routine,
 * `routine_start`) standing in NEED_ACTION whose status asks the user nothing (ToRead `result` or
 * `turn` for a triage run, whose asks are its letters) is complete. An ask of its own, an open letter, a prompt or an error keeps it open (its
 * status is then Needs you), and so does a turn that answered a person's message (`answer`: a
 * person took the conversation over). A triage run closes through its own bookkeeping, so its
 * journal line and the routine's card are written as for any other run.
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import type { UserStatus } from '../user-status.js';

/** Whether a routine run's task is done with: ended, nothing asked, nothing answered. Pure. */
export function routineRunToClose(
  task: Pick<Task, 'routine_start' | 'phase' | 'org_role' | 'parent_task_id' | 'plugin_only'>,
  status: Pick<UserStatus, 'state' | 'toRead'>,
  isTriageRun = false,
): boolean {
  if (task.routine_start?.state !== 'started' || task.phase !== 'NEED_ACTION') return false;
  // A run filed under a task is its leader's to check; an org node is never a run.
  if (task.org_role || task.parent_task_id || task.plugin_only) return false;
  if (status.state !== 'waiting') return false;
  // A finished report closes any run. A turn with no report at all closes only a triage run, whose
  // asks are its letters (an open one keeps it Needs you): another routine's turn may have asked in
  // its last words without the report lines.
  return status.toRead === 'result' || (status.toRead === 'turn' && isTriageRun);
}

const closing = new Set<string>();

/** Close one run task. Never throws: a run left open is one more row, not a failure. */
export async function closeRoutineRun(task: Task, status: Pick<UserStatus, 'state' | 'toRead'>): Promise<void> {
  if (closing.has(task.id)) return;
  const { activeTriageRuns, isTriageRunTask } = await import('../triage/runs.js');
  if (!routineRunToClose(task, status, isTriageRunTask(task))) return;
  closing.add(task.id);
  try {
    const triage = isTriageRunTask(task) ? activeTriageRuns() : null;
    if (triage) await triage.settleIdle(task);
    const { getTask, updateTask } = await import('../task-manager.js');
    // A triage run its bookkeeping already settled once in this process (and failed to complete) is closed here.
    if ((await getTask(task.id)).phase !== 'COMPLETE') await updateTask(task.id, { phase: 'COMPLETE' }, { source: 'routine' });
    log.task.info('routine run closed: its turn ended with nothing for the user', {
      taskId: task.id, jobId: task.routine_start?.job_id, triage: !!triage,
    });
  } catch (err) {
    log.task.warn('routine run close failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
  } finally {
    closing.delete(task.id);
  }
}
