/**
 * Time on ONE task, or ONE session: what a task's detail, a session header and the
 * Time App's task page read.
 *
 *   GET /api/time/task/:taskId       totals (all / today / 7 days), every day newest
 *                                    first with each session's share, every session
 *   GET /api/time/session/:sessionId the same for one session, across the tasks its
 *                                    time was filed under
 *
 * Mounted under /api/time by routes/time.ts. Both answer from the in-memory per-task
 * index (core/time-tracking/task-index.ts), with the usage ledger filling the days
 * before the agent collector ran (task-backfill.ts), so a request is a map walk
 * plus a bounded title join. Same contract as the rest of the family: fast or DEGRADED,
 * never a pinned connection, and 501 on a cloud replica, which has no store.
 */

import { Router, type Request, type Response } from 'express';
import { CLOUD_MODE } from '../../constants.js';
import { log } from '../../logging/index.js';
import {
  cleanId, deadline, getTaskIndex, hydrate, isHistoryRead, ledgerTaskOverlay, localDateKey, sessionTimeView,
  taskTimeView, type SessionTimeView, type TaskOverlay, type TaskTimeView,
} from '../../core/time-tracking/index.js';

export const taskTimeRouter = Router();

/** Budget for the whole answer (hydrate + title joins). */
const DEADLINE_MS = 2_000;
/** Sessions whose titles one answer looks up singly (the task's own list is one query). */
const MAX_SESSION_LOOKUPS = 40;

export interface TaskTimeResponse extends TaskTimeView {
  /** The task's title, when it still exists. */
  title?: string;
  /** sessionId → title, for every session in this answer that has one. */
  sessionTitles: Record<string, string>;
  /** False while days older than the hydrate window are still being read: totals may still grow. */
  historyComplete: boolean;
  /** True when the answer had to be given before it was complete. */
  degraded?: boolean;
}

export interface SessionTimeResponse extends SessionTimeView {
  title?: string;
  /** taskId → title, for the tasks in `taskIds`. */
  taskTitles: Record<string, string>;
  historyComplete: boolean;
  degraded?: boolean;
}

/** Race `build` against the deadline; the loser keeps running, so its failure is absorbed here. */
async function answer<T>(res: Response, what: string, build: () => Promise<T>, partial: () => T): Promise<void> {
  const bail = deadline(DEADLINE_MS);
  const built = build().catch((err: unknown) => {
    log.web.warn(`time ${what} failed`, { error: err instanceof Error ? err.message : String(err) });
    return partial();
  });
  try {
    res.json(await Promise.race([built, bail.promise.then(partial)]));
  } finally {
    bail.cancel();
  }
}

/** False on a replica (501 sent); the store and the collectors live on the primary only. */
function primaryOnly(res: Response): boolean {
  if (!CLOUD_MODE) return true;
  res.status(501).json({ error: 'not_supported_cloud', message: 'time tracking lives on the primary box only' });
  return false;
}

/** Fills `out` as titles arrive, so an answer cut by the deadline keeps the ones it has. */
async function taskTitles(ids: string[], out: Record<string, string>): Promise<void> {
  const wanted = ids.filter(Boolean);
  if (wanted.length === 0) return;
  try {
    const { listTasksByIds } = await import('../../core/task-manager.js');
    for (const task of await listTasksByIds(wanted)) if (task.id && task.title) out[task.id] = task.title;
  } catch { /* an unnamed row still says how long */ }
}

/** Titles for `sessionIds`: the task's own sessions in one query, the rest (moved, taskless) in parallel. */
async function sessionTitles(taskId: string | null, sessionIds: string[], out: Record<string, string>): Promise<void> {
  if (sessionIds.length === 0) return;
  try {
    const tracker = await import('../../core/session-tracker.js');
    if (taskId) {
      for (const record of await tracker.getSessionsForTask(taskId)) {
        if (record.title) out[record.claudeSessionId] = record.title;
      }
    }
    const missing = sessionIds.filter((sid) => !(sid in out)).slice(0, MAX_SESSION_LOOKUPS);
    await Promise.all(missing.map(async (sid) => {
      const record = await tracker.getSessionByClaudeId(sid).catch(() => null);
      if (record?.title) out[sid] = record.title;
    }));
  } catch { /* titles are a nicety */ }
}

function badId(res: Response, what: string): void {
  res.status(400).json({ error: 'invalid_id', message: `${what} must be 1 to 128 printable characters` });
}

taskTimeRouter.get('/task/:taskId', async (req: Request, res: Response) => {
  if (!primaryOnly(res)) return;
  const taskId = cleanId(req.params.taskId);
  if (!taskId) return badId(res, 'taskId');
  const today = localDateKey(new Date());
  const titles: Record<string, string> = {};
  const sessions: Record<string, string> = {};
  let overlay: TaskOverlay | undefined;
  const respond = (degraded: boolean): TaskTimeResponse => ({
    ...taskTimeView(getTaskIndex(), taskId, today, overlay),
    ...(titles[taskId] ? { title: titles[taskId] } : {}),
    sessionTitles: sessions,
    historyComplete: isHistoryRead(),
    ...(degraded ? { degraded: true } : {}),
  });
  await answer<TaskTimeResponse>(res, 'task', async () => {
    await hydrate();
    overlay = await ledgerTaskOverlay(getTaskIndex(), today);
    const v = taskTimeView(getTaskIndex(), taskId, today, overlay);
    await Promise.all([
      taskTitles([taskId], titles),
      sessionTitles(taskId, v.sessions.map((s) => s.sessionId), sessions),
    ]);
    return respond(false);
  }, () => respond(true));
});

taskTimeRouter.get('/session/:sessionId', async (req: Request, res: Response) => {
  if (!primaryOnly(res)) return;
  const sessionId = cleanId(req.params.sessionId);
  if (!sessionId) return badId(res, 'sessionId');
  const today = localDateKey(new Date());
  const titles: Record<string, string> = {};
  const sessions: Record<string, string> = {};
  let overlay: TaskOverlay | undefined;
  const respond = (degraded: boolean): SessionTimeResponse => ({
    ...sessionTimeView(getTaskIndex(), sessionId, today, overlay),
    ...(sessions[sessionId] ? { title: sessions[sessionId] } : {}),
    taskTitles: titles,
    historyComplete: isHistoryRead(),
    ...(degraded ? { degraded: true } : {}),
  });
  await answer<SessionTimeResponse>(res, 'session', async () => {
    await hydrate();
    overlay = await ledgerTaskOverlay(getTaskIndex(), today);
    const v = sessionTimeView(getTaskIndex(), sessionId, today, overlay);
    await Promise.all([taskTitles(v.taskIds, titles), sessionTitles(null, [sessionId], sessions)]);
    return respond(false);
  }, () => respond(true));
});
