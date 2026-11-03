/**
 * A lead whose project the user put under another VP (setProjectVp) hands over
 * first: its session gets a notice asking it to sum up its work for the lead
 * that takes over. Walnut, not the model, then closes it: when the turn that
 * read the notice ends (the notice's queue row is gone and the session has
 * not started again within a few seconds), and only while the project is
 * still led by someone else. A lead's prompt says it never completes its own
 * task, and a give-back in between must leave it open, so the model is never
 * asked to close itself.
 *
 * In memory: after a server restart a waiting lead simply stays open. It is no
 * longer the project's contact (pickLead prefers the VP), so nothing is lost.
 * The wait is turn-end-wait.ts: a status event or a poll looks. A lead that has not read
 * its notice or ended its turn HANDOVER_CLOSE_MAX_MS after it is kept open and the unread
 * notice withdrawn, never closed mid-turn (lifecycle-waits.ts lists it).
 */
import { log } from '../../logging/index.js';
import { TURN_END_POLL_MS, TurnEndWait } from '../sessions/turn-end-wait.js';
import { pickLead, projectKey } from './org-tree.js';

export interface PendingHandover {
  /** The lead that hands over and is closed afterwards. */
  taskId: string;
  project: string;
  sessionId: string;
  /** The notice's queue row: while it is still queued, the lead has not read it. */
  messageId?: string;
}

/** A turn end another turn follows at once is not the end (self-complete-stop.ts measured 50-100 ms). */
const SETTLE_MS = 3_000;
let settleMs = SETTLE_MS;
export const HANDOVER_CLOSE_MAX_MS = 2 * 60 * 60_000;

/** Test-only: change (or restore, with no argument) the settle window. */
export function __setHandoverSettleMs(ms?: number): void {
  settleMs = ms ?? SETTLE_MS;
}

const waiter = new TurnEndWait<PendingHandover & { at: number }>({
  name: 'org-handover-close',
  limits: { backgroundGraceMs: 10 * 60_000, maxMs: HANDOVER_CLOSE_MAX_MS },
  queue: false,
  get settleMs() { return settleMs; },
  // The turn that reads the notice may not have started yet: only its end counts.
  firstLookMs: TURN_END_POLL_MS,
  asked: async (_sid, wait) => ({ askedAt: wait.at }),
  // Not read yet: the notice still waits in its queue.
  holdsToo: async (sid, wait) => {
    if (!wait.messageId) return false;
    const { isMessageQueued } = await import('../session-message-queue.js');
    return isMessageQueued(sid, wait.messageId);
  },
  act: async (sid, wait, verdict, hold) => {
    if (verdict === 'expire') { await keepOpen(sid, wait, hold); return; }
    await closeIfDone(sid, wait, verdict);
  },
});

/** Test-only: what waits. */
export function __pendingHandovers(): PendingHandover[] {
  return waiter.values().map(([, w]) => { const { at: _at, ...p } = w; return p; });
}

/** `sessionId` reads a handover now, and Walnut closes its task after that turn. */
export function hasPendingHandover(sessionId: string): boolean {
  return waiter.has(sessionId);
}

/** Close `p.taskId` once its session has read the handover and its turn is over. */
export function closeAfterHandover(p: PendingHandover): void {
  waiter.watch(p.sessionId, { ...p, at: Date.now() });
}

/** The project changed again (given back, or moved on): forget its waiting handovers and withdraw unread ones. */
export async function cancelHandovers(project: string, exceptTaskId?: string): Promise<string[]> {
  const key = projectKey(project);
  const dropped: string[] = [];
  for (const [sid, p] of waiter.values()) {
    if (projectKey(p.project) !== key || p.taskId === exceptTaskId) continue;
    waiter.cancel(sid);
    dropped.push(p.taskId);
    if (!p.messageId) continue;
    const { deleteMessage } = await import('../session-message-queue.js');
    const withdrawn = await deleteMessage(sid, p.messageId).catch(() => false);
    log.task.info('org: handover withdrawn', { taskId: p.taskId, project: p.project, sessionId: sid, unread: withdrawn });
  }
  return dropped;
}

/**
 * The wait ran out with the notice unread or the turn still going: the lead is never closed
 * mid-turn or before it summed up. Its unread notice is withdrawn and it stays open, which is
 * harmless (it is no longer the project's contact); the log says why.
 */
async function keepOpen(sid: string, wait: PendingHandover, hold: string): Promise<void> {
  let withdrawn = false;
  if (wait.messageId) {
    const { deleteMessage } = await import('../session-message-queue.js');
    withdrawn = await deleteMessage(sid, wait.messageId).catch(() => false);
  }
  log.task.warn('org: handover lead kept open, its handover did not finish in time', {
    taskId: wait.taskId, project: wait.project, sessionId: sid, hold, noticeWithdrawn: withdrawn, waitedMs: HANDOVER_CLOSE_MAX_MS,
  });
}

async function closeIfDone(sid: string, wait: PendingHandover, verdict: string): Promise<void> {
  try {
    if (verdict !== 'run') log.task.info('org: handover lead closed; its turn ended, background work it left was not waited for', { taskId: wait.taskId, sessionId: sid, verdict });
    const { completeTask, listTasks } = await import('../task-manager.js');
    const tasks = await listTasks();
    const lead = tasks.find((t) => t.id === wait.taskId);
    if (!lead || lead.phase === 'COMPLETE') return;
    const now = pickLead(tasks, wait.project);
    if (!now || now.id === wait.taskId) {
      log.task.info('org: handover lead kept, it leads its project again', { taskId: wait.taskId, project: wait.project });
      return;
    }
    await completeTask(wait.taskId, { source: 'org' });
    log.task.info('org: lead closed after its handover', { taskId: wait.taskId, project: wait.project, sessionId: sid, vpTaskId: now.id });
  } catch (err) {
    log.task.warn('org: lead not closed after its handover', { taskId: wait.taskId, sessionId: sid, error: err instanceof Error ? err.message : String(err) });
  }
}
