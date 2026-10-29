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
  /** The block the session reads; '' when nothing is open and there is no place to state. */
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
  const { isPartial } = await import('../peers/structured-reply.js');
  const subtasks = children.slice(0, opts.max ?? MAX_SUBTASKS).map((t) => ({
    id: t.id, title: t.title, phase: t.phase,
    ...(isPartial(t.result_report) ? { partial: t.result_report!.not_done } : {}),
  }));
  return { subtasks, more: children.length - subtasks.length };
}

/** How far back a finished Partial subtask is still listed. */
const PARTIAL_DONE_DAYS = 7;

/** A task's finished subtasks whose last result was Partial and still unsettled. */
export async function listPartialDoneSubtasks(parentId: string, now = Date.now()): Promise<OpenSubtask[]> {
  const tm = await import('../task-manager.js');
  const { isPartial } = await import('../peers/structured-reply.js');
  const cutoff = now - PARTIAL_DONE_DAYS * 86_400_000;
  return (await tm.getChildTasks(parentId).catch(() => []))
    .filter((t) => t.phase === 'COMPLETE' && isPartial(t.result_report) && Date.parse(t.result_report!.at) >= cutoff)
    .slice(0, MAX_SUBTASKS)
    .map((t) => ({ id: t.id, title: t.title, phase: t.phase, partial: t.result_report!.not_done }));
}

/**
 * The OVERDUE requests of a session, both ways (session-requests.ts: expired, unanswered,
 * still open). One closed another way is left out: a sent one whose target task completed,
 * a received one whose asker's task did.
 */
export async function overdueFor(sid: string, taskId: string, now = Date.now()): Promise<{ out: SessionRequest[]; in: SessionRequest[] }> {
  const requests = await import('../session-requests.js');
  const rows = await requests.overdueOpenRequests(now).catch(() => [] as SessionRequest[]);
  const out = rows.filter((r) => r.fromSessionId === sid);
  const inbound = rows.filter((r) => r.toSessionId === sid || r.toTaskId === taskId);
  if (out.length === 0 && inbound.length === 0) return { out, in: inbound };
  const tm = await import('../task-manager.js');
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const askerTask = new Map<string, string | undefined>();
  for (const r of inbound) {
    if (!askerTask.has(r.fromSessionId)) askerTask.set(r.fromSessionId, (await getSessionByClaudeId(r.fromSessionId).catch(() => undefined))?.taskId);
  }
  const ids = [...new Set([...out.map((r) => r.toTaskId), ...askerTask.values()].filter((id): id is string => !!id))];
  const done = new Set((await tm.listTasksByIds(ids).catch(() => [])).filter((t) => t.phase === 'COMPLETE').map((t) => t.id));
  const newest = (a: SessionRequest, b: SessionRequest) => b.createdAt.localeCompare(a.createdAt);
  return {
    out: out.filter((r) => !r.toTaskId || !done.has(r.toTaskId)).sort(newest).slice(0, MAX_REQUESTS),
    in: inbound.filter((r) => { const t = askerTask.get(r.fromSessionId); return !t || !done.has(t); }).sort(newest).slice(0, MAX_REQUESTS),
  };
}

/** Everything still open for the calling session. Never throws: a reminder is best effort. */
export async function collectOpenItems(
  callerSid: string | undefined,
  now = Date.now(),
  opts: { afterCompaction?: boolean } = {},
): Promise<OpenItems> {
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
      const handedTo = [...new Set((r.carriedBy ?? []).map((c) => c.taskId).filter((id): id is string => !!id))];
      askedOfYou.push({ id: r.id, from: await partyOf(r.fromSessionId), preview: r.preview, createdAt: r.createdAt, ...(handedTo.length ? { handedTo } : {}) });
    }

    const overdue = await overdueFor(sid, task.id, now);
    const overdueIn: OpenAsk[] = [];
    for (const r of overdue.in) overdueIn.push({ id: r.id, from: await partyOf(r.fromSessionId), preview: r.preview, createdAt: r.createdAt });
    const partialDone = await listPartialDoneSubtasks(task.id, now);

    const items: OpenItems = {
      task: { id: task.id, title: task.title },
      subtasks, moreSubtasks, waitingOn, askedOfYou, text: '',
      ...(overdue.out.length ? { overdueOut: overdue.out.map((r) => ({
        id: r.id, to: r.toTaskId ?? (r.toSessionId ? `session ${r.toSessionId.slice(0, 8)}` : 'unknown'), preview: r.preview, createdAt: r.createdAt,
      })) } : {}),
      ...(overdueIn.length ? { overdueIn } : {}),
      ...(partialDone.length ? { partialDone } : {}),
    };
    const board = await (await import('../boards/board-store.js')).getBoard(task.id).catch(() => null);
    if (board) {
      const msgs = Object.values(board.threads).flat();
      items.board = {
        version: board.version, updatedAt: board.updated_at, threads: Object.keys(board.threads).length,
        userMessages: msgs.filter((m) => m.author === 'user').length, marks: Object.keys(board.marks).length,
      };
    }
    // Where the task stands, read back after a compaction (place-notice.ts).
    const { statePlaceAfterCompaction } = await import('./place-notice.js');
    const place = await statePlaceAfterCompaction(caller.record, task);
    if (place) {
      items.place = {
        project: place.project,
        ...(place.folder ? { folder: place.folder } : {}),
        ...(place.leaderId ? { leaderId: place.leaderId } : {}),
        ...(place.leader ? { leader: place.leader } : {}),
      };
    }
    items.text = formatOpenItems(items, now);
    // The summary does not keep the message hints (rich output, reply language,
    // any with an after-compaction trigger). Restated here, server-side only (the
    // formatter is shared with the daemon), so a compaction in the middle of a
    // turn is covered before the next send (hints/hint-send.ts).
    if (opts.afterCompaction) {
      const { stateHintsAfterCompaction } = await import('../hints/hint-send.js');
      const hints = await stateHintsAfterCompaction(caller.record, task);
      if (hints) items.text = [items.text, hints].filter(Boolean).join('\n\n');
      // A lead reads its teams back in full: the summary drops what earlier notes told it (org/team-note.ts).
      if (task.org_role === 'lead' && task.phase !== 'COMPLETE') {
        const { teamSnapshotText } = await import('../org/team-note.js');
        const teams = await teamSnapshotText(task, now);
        if (teams) items.text = [items.text, teams].filter(Boolean).join('\n\n');
      }
      // Its own MEMORY.md read back whole: a summary must not be where it lives (agent-memory.ts).
      const { agentMemoryAfterCompaction } = await import('./agent-memory.js');
      const memory = task.phase !== 'COMPLETE' ? agentMemoryAfterCompaction(task) : '';
      if (memory) items.text = [items.text, memory].filter(Boolean).join('\n\n');
      // Every default-instruction line that changed since spawn: the summary may have dropped the notices.
      const { instructionNoticeFor, noteInstructionNoticeStatedByHook } = await import('./instruction-notice.js');
      await (await import('./user-profile-context.js')).refreshUserProfile();
      const changed = instructionNoticeFor(caller.record, task, { ignoreTold: true });
      if (changed) {
        items.text = [changed, items.text].filter(Boolean).join('\n\n');
        await noteInstructionNoticeStatedByHook(caller.record, task);
      }
    }
    return items;
  } catch {
    return EMPTY;
  }
}

/** The block the session reads. '' when nothing is open, so nothing is injected. */
export function formatOpenItems(items: OpenItemsInput, now = Date.now()): string {
  return openItemsText.format(items, now);
}
