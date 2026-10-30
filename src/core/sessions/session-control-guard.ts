/**
 * Which session another session may stop or restart (task_stop / task_restart,
 * through POST /sessions/:id/terminate and /restart). Humans send no caller id
 * and are never refused here: the panel's Stop and Restart stay theirs.
 *
 * A session may stop or restart any session a person may, its own lead's and
 * Main's included (2026-10-27, the user: "all human action can be done by agent
 * also"). The one it may not act on is its own: the stop would cut the very
 * tool call that asked, mid-turn, and a restart would replace the process
 * running it (it completes its task or ends its turn instead). Reads the local
 * stores only, and fails open when a record is missing (a replica's partial
 * copy): the brake is against a session's own mistake, not an access check.
 *
 * The answer also names who asked (the caller's session and task), so the
 * route records a session's stop or restart of another session.
 */
import { isSupersededSession } from './engine-switch-marker.js';

export type SessionControlRefusal = { code: 'own_session'; message: string };
export type SessionControlActor = { callerSid: string; callerTaskId: string | null; targetTaskId: string | null };

export async function sessionControlCheck(
  callerSid: string | undefined, targetSid: string, action: 'stop' | 'restart',
): Promise<{ refusal: SessionControlRefusal | null; actor: SessionControlActor | null }> {
  const caller = (callerSid ?? '').trim();
  if (!caller) return { refusal: null, actor: null };
  const own: SessionControlRefusal = {
    code: 'own_session',
    message: action === 'stop'
      ? 'A session cannot stop itself: complete your task (task_complete) or end your turn instead'
      : 'A session cannot restart itself: ask your lead or the user to restart it',
  };
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const [callerRec, targetRec] = caller === targetSid ? [undefined, undefined] : await Promise.all([
    getSessionByClaudeId(caller).catch(() => undefined),
    getSessionByClaudeId(targetSid).catch(() => undefined),
  ]);
  const actor: SessionControlActor = { callerSid: caller, callerTaskId: callerRec?.taskId ?? null, targetTaskId: targetRec?.taskId ?? null };
  if (caller === targetSid) return { refusal: own, actor };
  if (callerRec && targetRec && callerRec.claudeSessionId === targetRec.claudeSessionId) return { refusal: own, actor };
  // A session an engine switch replaced is still its task: it never stops or restarts the task's new session.
  if (isSupersededSession(callerRec) && callerRec?.taskId && callerRec.taskId === targetRec?.taskId) return { refusal: own, actor };
  return { refusal: null, actor };
}
