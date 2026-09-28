/**
 * Stop ONE background task of a session: a background agent, shell command or
 * workflow the CLI runs outside the turn. The turn and the session's other tasks
 * keep going. Shared by the web route (POST /api/v1/sessions/:id/background-tasks
 * /:taskId/stop) and the cloud relay (`background-task.stop`), so a replica's
 * button reaches the same code on the primary.
 *
 * The CLI owns the task registry, so this is its `stop_task` control request
 * (ClaudeCodeSession.stopBackgroundTask), sent only for an id this session's own
 * ledger lists: task ids are unique per CLI process, not across sessions.
 */

import { SessionControlError } from './session-controls.js';
import { log } from '../../logging/index.js';

/** CLI task ids are short tokens; anything else never names a task. */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface BackgroundTaskStopResult {
  sessionId: string;
  taskId: string;
  /** False when the task had already ended (nothing was sent to the CLI). */
  stopped: boolean;
  /** The ledger status when the request arrived. */
  status: string;
}

export async function stopSessionBackgroundTask(sessionId: string, rawTaskId: unknown): Promise<BackgroundTaskStopResult> {
  if (typeof rawTaskId !== 'string' || !TASK_ID_RE.test(rawTaskId)) {
    throw new SessionControlError('taskId must be a background task id', 400);
  }
  const taskId = rawTaskId;
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  if (!(await getSessionByClaudeId(sessionId))) throw new SessionControlError('session not found', 404);

  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  const live = await sessionRunner.getOrAttachLiveSession(sessionId).catch(() => undefined);
  if (!live) {
    throw new SessionControlError('The session is not running, so none of its background tasks is either', 409);
  }
  try {
    const { stopped, status } = await live.stopBackgroundTask(taskId);
    log.session.info('background task stop', { sessionId, backgroundTaskId: taskId, stopped, status });
    return { sessionId, taskId, stopped, status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('No background task')) throw new SessionControlError(message, 404);
    log.session.warn('background task stop failed', { sessionId, backgroundTaskId: taskId, error: message });
    throw new SessionControlError(`The CLI did not stop the task: ${message}`, 409);
  }
}
