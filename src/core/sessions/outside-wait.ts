/**
 * A task parks as WAITING only for a wait outside Walnut and the user (2026-10-30, the user: "why
 * does it always start to put it into wait ... try to avoid until u are actually wait something
 * like pipeline flowing, slack, or cr approval"). A worker that had delivered its draft
 * reported "waiting, other: the meeting notes and the deadline", which is the
 * user's to give; its report moved it to WAITING with a day's clock and it left his list.
 *
 * Waiting on the user's input, review or decision is Needs you (NEED_ACTION), always. A wait is
 * outside when the session names one (another task, its lead, the machine, or an outside thing: a
 * pipeline, a build, a deploy, a CR or PR review, a Slack or mail reply), or when the task has
 * something armed for one: a trigger of its own that does not watch the user's ask or letter, a
 * request it sent that is still unanswered, a subtask at work. Every path that parks a task asks
 * here (report-phase.ts, the session PATCH in api-v1.ts, trigger-api.ts, the trigger-held waits
 * in phase.ts and task-wait-resume.ts); tests/core/park-gate-ratchet.test.ts fails on a new one.
 */
import type { Task } from '../types.js';
import { OUTSIDE_WAIT_KINDS, waitWordsNameUser, type StatusReport } from '../user-status.js';

export { OUTSIDE_WAIT_KINDS, waitWordsNameUser };

/** Whether a waiting report names an outside wait in its own words. Pure. A lead wait needs a lead. */
export function reportNamesOutsideWait(
  report: Pick<StatusReport, 'state' | 'waiting_kind' | 'waiting_on'>, task: Pick<Task, 'parent_task_id'>,
): boolean {
  if (report.state !== 'waiting' || !report.waiting_kind || !OUTSIDE_WAIT_KINDS.has(report.waiting_kind)) return false;
  if (report.waiting_kind === 'lead' && !task.parent_task_id) return false;
  return !waitWordsNameUser(report.waiting_on, true);
}

/** What makes a task's wait outside the user, as facts Walnut holds. */
export interface OutsideWaitEvidence {
  kind: 'trigger' | 'request' | 'subtask' | 'lead';
  /** One plain line for the log and an outcome. */
  detail: string;
}

/**
 * The first fact that shows the task waits on something other than the user, or null. Never
 * throws: a fact that cannot be read counts as absent, so the task stays on the user's list.
 * `callerTaskId`: the task whose session asks to park it (a lead parking its worker is a wait
 * on that lead). `sessionIds`: the sessions whose sent requests count (default: the task's).
 */
export async function outsideWaitEvidence(
  task: Pick<Task, 'id' | 'parent_task_id' | 'session_id'>,
  opts: { callerTaskId?: string; sessionIds?: readonly string[]; parentTaskId?: string } = {},
): Promise<OutsideWaitEvidence | null> {
  const parent = opts.parentTaskId ?? task.parent_task_id;
  if (opts.callerTaskId && opts.callerTaskId !== task.id && opts.callerTaskId === parent) {
    return { kind: 'lead', detail: 'its lead parked it' };
  }
  try {
    const { triggersWatching } = await import('../task-wait-until.js');
    const armed = (await triggersWatching(task.id)).find((t) => t.state === 'armed' && !t.watchesUser);
    if (armed) return { kind: 'trigger', detail: `trigger ${armed.name ?? armed.id} is armed` };
  } catch { /* absent */ }
  try {
    const sids = [...new Set([...(opts.sessionIds ?? []), task.session_id].filter((s): s is string => !!s))];
    if (sids.length) {
      const { pendingRequestsFromSession } = await import('../session-requests.js');
      // Pending only: an overdue one is listed to the asker as such, and would hold a park forever.
      for (const sid of sids) {
        const open = await pendingRequestsFromSession(sid);
        if (open.length) return { kind: 'request', detail: `request ${open[0].id} is unanswered` };
      }
    }
  } catch { /* absent */ }
  try {
    // A subtask at work, not one that is itself on the user or not started: a lead nearly always
    // has open subtasks, and those alone say nothing about what it waits on.
    const { getChildTasks } = await import('../task-manager.js');
    const busy = (await getChildTasks(task.id)).find((t) => t.phase === 'IN_PROGRESS' || t.phase === 'WAITING');
    if (busy) return { kind: 'subtask', detail: `subtask ${busy.id} is ${busy.phase === 'WAITING' ? 'waiting' : 'at work'}` };
  } catch { /* absent */ }
  return null;
}

/** The refusal a session's park without an outside wait gets (409 `wait_on_user`). */
export const WAIT_ON_USER_MESSAGE =
  'Nothing outside Walnut and the user is armed for this task (no trigger of its own, no unanswered request, '
  + 'no subtask at work), so WAITING would take it off the user\'s list while it may need them. When the next move '
  + 'is the user\'s (their input, review or decision), set phase=NEED_ACTION. When you wait on an outside thing '
  + '(a pipeline, a build, a deploy, a CR or PR review, a Slack or mail reply, another task), arm a trigger on it '
  + '(trigger_create parks the task), or pass waiting_on naming it, with a short wait_until.';

/** Shortest `waiting_on` that names a wait (the `project_reason` floor). */
export const WAITING_ON_MIN = 10;

/**
 * Whether a session caller's write of phase=WAITING on `taskId` may go through (PATCH /tasks/:id,
 * task_update and task_update_bulk). People (no caller) are never checked, nor a task already
 * WAITING (a new clock) or the main agent's (its park is not applied, main-stays-active.ts).
 */
export async function admitSessionPark(
  taskId: string, callerSid: string | undefined, waitingOn: unknown,
  /** The parent the same write sets (an adopt and a park in one PATCH). */
  parentTaskId?: string,
): Promise<{ ok: true; evidence?: OutsideWaitEvidence | 'named' } | { ok: false; code: 'wait_on_user'; message: string }> {
  const sid = (callerSid ?? '').trim();
  if (!sid) return { ok: true };
  const { resolveCaller } = await import('./session-send-core.js');
  const caller = await resolveCaller(sid).catch(() => null);
  if (caller?.kind !== 'session') return { ok: true };
  const { getTask } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  if (!task || task.phase === 'WAITING' || task.phase === 'COMPLETE') return { ok: true };
  const { isMainAgentTask } = await import('../org/main-stays-active.js');
  if (isMainAgentTask(task)) return { ok: true };
  const words = typeof waitingOn === 'string' ? waitingOn.trim() : '';
  if (words && waitWordsNameUser(words)) return { ok: false, code: 'wait_on_user', message: `waiting_on names the user: that is phase=NEED_ACTION, not WAITING. ${WAIT_ON_USER_MESSAGE}` };
  const evidence = await outsideWaitEvidence(task, {
    ...(caller.record.taskId ? { callerTaskId: caller.record.taskId } : {}),
    ...(caller.record.taskId === task.id ? { sessionIds: [caller.record.claudeSessionId] } : {}),
    ...(parentTaskId ? { parentTaskId } : {}),
  });
  if (evidence) return { ok: true, evidence };
  if (words.length >= WAITING_ON_MIN) return { ok: true, evidence: 'named' };
  return { ok: false, code: 'wait_on_user', message: WAIT_ON_USER_MESSAGE };
}

/** The caller session a request names (`x-walnut-caller-sid`), or undefined for a person. */
export function callerSidOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers['x-walnut-caller-sid'];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
}

/**
 * A batch phase write to WAITING from a session (POST /tasks/batch/phase): the ids it may park,
 * and the refused ones as batch failures. Every other caller keeps every id.
 */
export async function splitSessionParks(
  ids: readonly string[], phase: string, callerSid: string | undefined,
): Promise<{ ids: string[]; refused: { id: string; ok: false; error: string }[] }> {
  if (phase !== 'WAITING' || !callerSid) return { ids: [...ids], refused: [] };
  const out: string[] = [];
  const refused: { id: string; ok: false; error: string }[] = [];
  for (const id of ids) {
    const admit = await admitSessionPark(id, callerSid, undefined);
    if (admit.ok) out.push(id); else refused.push({ id, ok: false, error: `${admit.code}: ${admit.message}` });
  }
  return { ids: out, refused };
}
