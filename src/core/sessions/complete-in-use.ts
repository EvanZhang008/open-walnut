/**
 * A session completing ANOTHER task: refused while that task is still in use (2026-10-28, the
 * multi-agent tracking deep dive, case 1: a lead's transfer was refused, so it filed a new task
 * by hand and completed the one the user had open in a terminal; the in-use check lived only in
 * task_transfer). The same facts as a transfer's source (transfer/source-in-use.ts): a person
 * wrote in it this week, its session was open in a terminal this week, it holds an org role, or has an armed trigger; or its work is unfinished (unfinishedWork). `force` with a reason lets it through: the reason
 * is logged and kept with the completion.
 *
 * A task completing itself, and a person completing anything, are never checked.
 */
import { log } from '../../logging/index.js';
import type { InUseReason } from '../transfer/source-in-use.js';
import type { Task } from '../types.js';
import type { StructuredReply } from '../peers/structured-reply.js';

/** Why a task is not to be closed by another session: in use, or its work is unfinished. */
export interface CompleteBlock { code: InUseReason['code'] | 'unfinished_result' | 'unanswered_requests' | 'turn_running'; text: string }

export type CompleteAdmission =
  | { ok: true; callerTaskId?: string }
  | { ok: false; message: string; reasons: CompleteBlock[] };

/**
 * Its work is unfinished (2026-10-28, the Grok Bot study, borrow point b): its last result left
 * things not done that nobody settled, someone still waits on its answer, or a turn of it runs
 * right now. A completion that brings its own `not_done` (or result) is the closer's verdict on
 * the result, so a Partial from before does not block it.
 */
export async function unfinishedWork(task: Task, fields?: StructuredReply | null, callerSid?: string): Promise<CompleteBlock[]> {
  const out: CompleteBlock[] = [];
  const { isPartial } = await import('../peers/structured-reply.js');
  if (!fields && isPartial(task.result_report)) {
    out.push({ code: 'unfinished_result', text: `its last result left ${task.result_report!.not_done!.length} item(s) not done (${task.result_report!.not_done!.join('; ').slice(0, 200)}): take them up or settle them with task_not_done_settle, or pass not_done yourself` });
  }
  try {
    const { pendingRequestsForTarget } = await import('../session-requests.js');
    // The closer's own asks are its to drop: only someone else's wait keeps the task open.
    const asked = (await pendingRequestsForTarget({ taskId: task.id, ...(task.session_id ? { sessionId: task.session_id } : {}) }))
      .filter((r) => r.fromSessionId !== callerSid);
    if (asked.length) out.push({ code: 'unanswered_requests', text: `${asked.length} request(s) to it are still unanswered (${asked.slice(0, 3).map((r) => r.id).join(', ')})` });
  } catch { /* unknown: not a reason */ }
  try {
    if (task.session_id) {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      const rec = await getSessionByClaudeId(task.session_id);
      if (rec?.process_status === 'running') out.push({ code: 'turn_running', text: 'its session is running a turn right now' });
    }
  } catch { /* unknown: not a reason */ }
  return out;
}

const REASON_MIN = 10;

export async function admitCompleteOfOther(
  taskRef: string,
  callerSid: string | undefined,
  opts: { force?: boolean; reason?: string; fields?: StructuredReply | null } = {},
): Promise<CompleteAdmission> {
  if (!callerSid) return { ok: true };
  try {
    const { resolveCaller } = await import('./session-send-core.js');
    const caller = await resolveCaller(callerSid).catch(() => null);
    if (caller?.kind !== 'session' || !caller.record.taskId) return { ok: true };
    const callerTaskId = caller.record.taskId;
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(taskRef).catch(() => null);
    // Its own task, or one already closed: nothing to protect (completeTask answers the rest).
    if (!task || task.id === callerTaskId || task.phase === 'COMPLETE') return { ok: true, callerTaskId };
    const { sourceInUse } = await import('../transfer/source-in-use.js');
    // Open subtasks never block a completion (2026-10-04, the user: a leader with a recurring
    // worker could not be closed at all); they keep running and the response lists them.
    const inUse = (await sourceInUse(task, callerSid)).filter((r) => r.code !== 'open_subtasks');
    const reasons: CompleteBlock[] = [...inUse, ...await unfinishedWork(task, opts.fields, callerSid)];
    if (reasons.length === 0) return { ok: true, callerTaskId };
    const reason = (opts.reason ?? '').trim();
    if (opts.force === true && reason.length >= REASON_MIN) {
      log.session.info('task completed while in use: forced by a session', { taskId: task.id, callerTaskId, reasons: reasons.map((r) => r.code), reason });
      return { ok: true, callerTaskId };
    }
    const why = reasons.map((r) => r.text).join('; ');
    return {
      ok: false,
      reasons,
      message: `"${task.title}" (${task.id}) is still in use or unfinished: ${why}. Leave it open (tell its session or the user what you found instead). `
        + `If it must be closed anyway, call task_complete again with force:true and a reason (${REASON_MIN}+ characters) saying who asked for it and why.`,
    };
  } catch (err) {
    // A check that cannot run never blocks a completion.
    log.session.warn('complete in-use check failed', { taskRef, error: err instanceof Error ? err.message : String(err) });
    return { ok: true };
  }
}
