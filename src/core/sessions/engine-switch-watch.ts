/**
 * A switch picked while a turn ran waits for that turn's end (engine-switch.ts,
 * the user's rule: "你可以让他等完再去切"). The pick is stored on the task
 * (`engine_switch.state = 'pending'`), so it survives a restart; this module
 * runs it once the old session leaves `running`, after the short settle a
 * background command's follow-up turn needs (team-stop.ts does the same).
 */
import { log } from '../../logging/index.js';

const SETTLE_MS = 3_000;
const SUBSCRIBER = 'engine-switch-turn-end';
/** sessionId → taskId of a switch waiting for that session's turn to end. */
const waiting = new Map<string, string>();
let subscribed = false;

async function subscribe(): Promise<void> {
  if (subscribed) return;
  subscribed = true;
  const { bus, EventNames } = await import('../event-bus.js');
  bus.subscribe(SUBSCRIBER, (event) => {
    const data = event.data as { sessionId?: string; process_status?: string } | undefined;
    const sid = data?.sessionId;
    if (!sid || !waiting.has(sid) || !data?.process_status || data.process_status === 'running') return;
    const taskId = waiting.get(sid)!;
    waiting.delete(sid);
    void runWhenSettled(taskId, sid);
  }, { global: true, interest: [EventNames.SESSION_STATUS_CHANGED] });
}

export function watchPendingSwitch(taskId: string, sessionId: string): void {
  waiting.set(sessionId, taskId);
  void subscribe().then(() => checkSoon(taskId, sessionId, 0)).catch((err: unknown) => log.session.warn('engine switch: watching the turn failed', {
    taskId, sessionId, error: err instanceof Error ? err.message : String(err),
  }));
}

const RECHECK_MS = 5_000;

/**
 * Look once more: the turn may have ended before the subscription was in place, and a
 * session that waits only on a queued message sends no status event when that row
 * clears, so it is polled until it is free.
 */
async function checkSoon(taskId: string, sessionId: string, delayMs: number): Promise<void> {
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs).unref?.());
  if (waiting.get(sessionId) !== taskId) return;
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(sessionId).catch(() => null);
  if (rec?.process_status === 'running') return; // its turn end is an event
  const { sessionBusy } = await import('./engine-switch.js');
  if (rec && await sessionBusy(rec)) { void checkSoon(taskId, sessionId, RECHECK_MS); return; }
  waiting.delete(sessionId);
  await runWhenSettled(taskId, sessionId);
}

async function runWhenSettled(taskId: string, sessionId: string): Promise<void> {
  try {
    await new Promise((r) => setTimeout(r, SETTLE_MS).unref?.());
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(taskId).catch(() => null);
    const pending = task?.engine_switch;
    if (pending?.state !== 'pending' || pending.from_session_id !== sessionId) return;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(sessionId).catch(() => null);
    const { runEngineSwitch, sessionBusy } = await import('./engine-switch.js');
    if (rec && await sessionBusy(rec)) { watchPendingSwitch(taskId, sessionId); return; }
    await runEngineSwitch(taskId, pending);
  } catch (err) {
    log.session.warn('engine switch at turn end failed', { taskId, sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * At startup: a pending switch waits again (or runs, when its turn is over); one a
 * restart cut mid-way is put back to pending, after its old session is restored as
 * the task's session when no new one took over.
 */
export async function resumeEngineSwitches(): Promise<number> {
  const { listTasks, updateTaskRaw } = await import('../task-manager.js');
  const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js');
  let n = 0;
  for (const task of await listTasks()) {
    const sw = task.engine_switch;
    if (!sw || (sw.state !== 'pending' && sw.state !== 'switching')) continue;
    n++;
    if (sw.state === 'switching') {
      const { taskConversation } = await import('./task-session-claim.js');
      const active = await taskConversation(task.id);
      if (active && active.claudeSessionId !== sw.from_session_id) {
        // The new session started (or the earlier one was resumed) before the restart:
        // finish what follows it (each step is idempotent).
        const to = active.claudeSessionId;
        if (sw.resume_session_id === to && sw.resume_message) {
          // Its message may not have been queued yet; the same id collapses onto it when it was.
          const { sendResumeMessage } = await import('./engine-switch-resume.js');
          await sendResumeMessage(task.id, sw, to, sw.resume_message, sw.to.permission_mode).catch((err: unknown) => log.session.warn('engine switch: resending the resume message failed', {
            taskId: task.id, sessionId: to, error: err instanceof Error ? err.message : String(err),
          }));
        }
        await updateSessionRecord(sw.from_session_id, { supersededBy: to }).catch(() => {});
        const { retargetRequestsToSession } = await import('../session-requests.js');
        await retargetRequestsToSession(sw.from_session_id, to).catch(() => 0);
        const { putQueuedRows } = await import('./engine-switch-io.js');
        if (sw.held_rows?.length) await putQueuedRows(to, sw.held_rows as never[]).catch(() => {});
        await updateTaskRaw(task.id, {
          engine_switch: {
            ...sw, state: 'done', message: undefined, display_text: undefined, held_rows: undefined,
            resume_session_id: undefined, resume_message: undefined, session_id: to, ...(sw.resume_session_id === to ? { resumed: true } : {}),
          },
        }, { source: 'engine-switch', emitEvent: true });
        continue;
      }
      const old = await getSessionByClaudeId(sw.from_session_id).catch(() => null);
      if (old?.archived) await updateSessionRecord(old.claudeSessionId, { archived: false, archive_reason: undefined }).catch(() => {});
      if (old) {
        const { linkSession } = await import('../task-manager.js');
        await linkSession(task.id, old.claudeSessionId).catch(() => {});
        const { putQueuedRows } = await import('./engine-switch-io.js');
        if (sw.held_rows?.length) await putQueuedRows(old.claudeSessionId, sw.held_rows as never[]).catch(() => {});
      }
      await updateTaskRaw(task.id, { engine_switch: { ...sw, state: 'pending', held_rows: undefined, resume_session_id: undefined, resume_message: undefined } }, { source: 'engine-switch', emitEvent: true });
    }
    const old = await getSessionByClaudeId(sw.from_session_id).catch(() => null);
    if (old?.process_status === 'running') { watchPendingSwitch(task.id, sw.from_session_id); continue; }
    void runWhenSettled(task.id, sw.from_session_id);
  }
  if (n > 0) log.session.info('engine switches resumed at startup', { count: n });
  return n;
}
