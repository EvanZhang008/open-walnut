/**
 * Which session another session may stop or restart (task_stop / task_restart,
 * through POST /sessions/:id/terminate and /restart). Humans send no caller id
 * and are never refused here: the panel's Stop and Restart stay theirs.
 *
 * A session may not act on:
 *   - itself: the stop would cut the very tool call that asked, mid-turn, and a
 *     restart would replace the process running it (it completes its task or
 *     ends its turn instead);
 *   - a task above it in its own chain (its lead, its lead's lead): a worker
 *     manages its team, not the one that runs it;
 *   - Main: the user's own conversation partner, stopped only by the user.
 * Reads the local stores only, and fails open when a record is missing (a
 * replica's partial copy): the brake is against a session's own mistake, not
 * an access check.
 */

export type SessionControlRefusal = { code: 'own_session' | 'own_lead' | 'main_session'; message: string };

export async function sessionControlRefusal(
  callerSid: string | undefined, targetSid: string, action: 'stop' | 'restart',
): Promise<SessionControlRefusal | null> {
  const caller = (callerSid ?? '').trim();
  if (!caller) return null;
  const own: SessionControlRefusal = {
    code: 'own_session',
    message: action === 'stop'
      ? 'A session cannot stop itself: complete your task (task_complete) or end your turn instead'
      : 'A session cannot restart itself: ask your lead or the user to restart it',
  };
  if (caller === targetSid) return own;
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const [callerRec, targetRec] = await Promise.all([
    getSessionByClaudeId(caller).catch(() => undefined),
    getSessionByClaudeId(targetSid).catch(() => undefined),
  ]);
  if (callerRec && targetRec && callerRec.claudeSessionId === targetRec.claudeSessionId) return own;
  if (!targetRec?.taskId) return null;
  const { listTasksByIds } = await import('../task-manager.js');
  const target = (await listTasksByIds([targetRec.taskId]).catch(() => []))[0];
  if (target?.org_role === 'main') {
    return { code: 'main_session', message: `Main's session is the user's to ${action}; tell the user (or Main) instead` };
  }
  if (!callerRec?.taskId || callerRec.taskId === targetRec.taskId) return null;
  const { hasAncestor } = await import('./subtask-limits.js');
  if (await hasAncestor(callerRec.taskId, targetRec.taskId).catch(() => false)) {
    return { code: 'own_lead', message: `A session cannot ${action} the session of a task it works for (its lead); ask the user` };
  }
  return null;
}
