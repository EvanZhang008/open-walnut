/**
 * What is still open for a session's task: its unfinished subtasks and the
 * reply requests still pending in either direction.
 *
 * The session reads this back right after its context is compacted. A
 * compaction summary is the model's own writing, and it can leave out a subtask
 * that is still running: on 2026-09-30 a parent session lost a subtask it had
 * filed two compactions earlier (the subtask was waiting on a review, its one
 * request already answered), then treated that work as nobody's. Walnut holds
 * the truth, so the CLI's own SessionStart hook (matcher `compact`, registered
 * at spawn by src/providers/compact-open-items-hook.ts) asks for it after every
 * compaction and the answer lands in the model's context, with no extra turn.
 *
 * Only what is unfinished, and only a few lines: a finished subtask needs no
 * reminder, and `task_get` / `task_list` have the rest. A task's Board counts
 * as open too (one line: version, threads, the user's messages, marks): a
 * summary that forgot the board leaves the user reading a stale page.
 */

import type { SessionRequest } from '../session-requests.js';
import { createOpenItemsText, type OpenAsk, type OpenItemsInput, type OpenSubtask } from './open-items-text.js';

export type { OpenAsk, OpenBoard, OpenSubtask, OpenWait } from './open-items-text.js';

const MAX_SUBTASKS = 20;
const MAX_REQUESTS = 10;

export interface OpenItems extends OpenItemsInput {
  /** The block the session reads; '' when nothing is open. */
  text: string;
}

const EMPTY: OpenItems = { subtasks: [], moreSubtasks: 0, waitingOn: [], askedOfYou: [], text: '' };

/** One wording for the server and for a host answering from its copy. */
const openItemsText = createOpenItemsText();

/** The task a session works for, or the session id when it has none. */
async function partyOf(sessionId: string): Promise<string> {
  const { resolveCaller } = await import('./session-send-core.js');
  const caller = await resolveCaller(sessionId).catch(() => null);
  return caller?.kind === 'session' && caller.record.taskId ? caller.record.taskId : `session ${sessionId.slice(0, 8)}`;
}

/**
 * A task's unfinished direct subtasks, most recently touched first, at most
 * `max` of them (`more` counts the rest). Also what a session's `task_create`
 * result lists, so a session filing more work sees the team it already leads.
 */
export async function listOpenSubtasks(
  parentId: string, opts: { exclude?: string; max?: number } = {},
): Promise<{ subtasks: OpenSubtask[]; more: number }> {
  const tm = await import('../task-manager.js');
  const children = (await tm.getChildTasks(parentId).catch(() => []))
    .filter((t) => t.phase !== 'COMPLETE' && t.id !== opts.exclude)
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  const subtasks = children.slice(0, opts.max ?? MAX_SUBTASKS).map((t) => ({ id: t.id, title: t.title, phase: t.phase }));
  return { subtasks, more: children.length - subtasks.length };
}

/** Everything still open for the calling session. Never throws: a reminder is best effort. */
export async function collectOpenItems(callerSid: string | undefined, now = Date.now()): Promise<OpenItems> {
  const sid = (callerSid ?? '').trim();
  if (!sid) return EMPTY;
  const { CLOUD_MODE } = await import('../../constants.js');
  if (CLOUD_MODE) return EMPTY;
  try {
    const { resolveCaller } = await import('./session-send-core.js');
    const caller = await resolveCaller(sid).catch(() => null);
    if (caller?.kind !== 'session' || !caller.record.taskId) return EMPTY;
    const tm = await import('../task-manager.js');
    const task = await tm.getTask(caller.record.taskId).catch(() => undefined);
    if (!task) return EMPTY;

    const { subtasks, more: moreSubtasks } = await listOpenSubtasks(task.id);

    const requests = await import('../session-requests.js');
    const sent = (await requests.pendingRequestsFromSession(sid).catch(() => [] as SessionRequest[])).slice(0, MAX_REQUESTS);
    const received = (await requests.pendingRequestsForTarget({ sessionId: sid, taskId: task.id }).catch(() => [] as SessionRequest[]))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_REQUESTS);
    const waitingOn = sent.map((r) => ({
      id: r.id, to: r.toTaskId ?? (r.toSessionId ? `session ${r.toSessionId.slice(0, 8)}` : 'unknown'),
      preview: r.preview, createdAt: r.createdAt,
    }));
    const askedOfYou: OpenAsk[] = [];
    for (const r of received) {
      askedOfYou.push({ id: r.id, from: await partyOf(r.fromSessionId), preview: r.preview, createdAt: r.createdAt });
    }

    const items: OpenItems = {
      task: { id: task.id, title: task.title },
      subtasks, moreSubtasks, waitingOn, askedOfYou, text: '',
    };
    const board = await (await import('../boards/board-store.js')).getBoard(task.id).catch(() => null);
    if (board) {
      const msgs = Object.values(board.threads).flat();
      items.board = {
        version: board.version, updatedAt: board.updated_at, threads: Object.keys(board.threads).length,
        userMessages: msgs.filter((m) => m.author === 'user').length, marks: Object.keys(board.marks).length,
      };
    }
    items.text = formatOpenItems(items, now);
    return items;
  } catch {
    return EMPTY;
  }
}

/** The block the session reads. '' when nothing is open, so nothing is injected. */
export function formatOpenItems(items: OpenItemsInput, now = Date.now()): string {
  return openItemsText.format(items, now);
}
