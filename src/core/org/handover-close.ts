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
 */
import { bus, EventNames } from '../event-bus.js';
import type { SessionStatusChangedEvent } from '../event-types.js';
import { log } from '../../logging/index.js';
import { pickLead, projectKey } from './org-tree.js';

export interface PendingHandover {
  /** The lead that hands over and is closed afterwards. */
  taskId: string;
  project: string;
  sessionId: string;
  /** The notice's queue row: while it is still queued, the lead has not read it. */
  messageId?: string;
}

const pending = new Map<string, PendingHandover>();
const SUBSCRIBER = 'org-handover-close';
/** A turn end another turn follows at once is not the end (self-complete-stop.ts measured 50-100 ms). */
const SETTLE_MS = 3_000;
let settleMs = SETTLE_MS;

/** Test-only: change (or restore, with no argument) the settle window. */
export function __setHandoverSettleMs(ms?: number): void {
  settleMs = ms ?? SETTLE_MS;
}

/** Test-only: what waits. */
export function __pendingHandovers(): PendingHandover[] {
  return [...pending.values()];
}

/** `sessionId` reads a handover now, and Walnut closes its task after that turn. */
export function hasPendingHandover(sessionId: string): boolean {
  return pending.has(sessionId);
}

/** Close `p.taskId` once its session has read the handover and its turn is over. */
export function closeAfterHandover(p: PendingHandover): void {
  pending.set(p.sessionId, p);
  // Idempotent: the bus keys subscribers by name.
  bus.subscribe(SUBSCRIBER, (event) => {
    const status = event.data as Partial<SessionStatusChangedEvent> | undefined;
    const sid = status?.sessionId;
    const wait = sid ? pending.get(sid) : undefined;
    if (!sid || !wait || !status.process_status || status.process_status === 'running') return;
    void closeIfDone(sid, wait);
  }, { global: true, interest: [EventNames.SESSION_STATUS_CHANGED] });
}

/** The project changed again (given back, or moved on): forget its waiting handovers and withdraw unread ones. */
export async function cancelHandovers(project: string, exceptTaskId?: string): Promise<string[]> {
  const key = projectKey(project);
  const dropped: string[] = [];
  for (const [sid, p] of pending) {
    if (projectKey(p.project) !== key || p.taskId === exceptTaskId) continue;
    pending.delete(sid);
    dropped.push(p.taskId);
    if (!p.messageId) continue;
    const { deleteMessage } = await import('../session-message-queue.js');
    const withdrawn = await deleteMessage(sid, p.messageId).catch(() => false);
    log.task.info('org: handover withdrawn', { taskId: p.taskId, project: p.project, sessionId: sid, unread: withdrawn });
  }
  return dropped;
}

async function closeIfDone(sid: string, wait: PendingHandover): Promise<void> {
  try {
    const { isMessageQueued } = await import('../session-message-queue.js');
    if (wait.messageId && await isMessageQueued(sid, wait.messageId)) return; // not read yet
    await new Promise((r) => setTimeout(r, settleMs));
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    if ((await getSessionByClaudeId(sid))?.process_status === 'running') return; // its follow-up turn: wait for that end
    if (pending.get(sid) !== wait) return; // cancelled or replaced meanwhile
    pending.delete(sid);
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
