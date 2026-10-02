/**
 * Subtask notices: a parent task's session hears about its direct subtasks by
 * their STATE, not by who talked to them.
 *
 * Before this, a parent heard from a child only while it held a pending
 * expect_reply request to it (session-request-watch). The request is settled by
 * the child's first reply, so a child that kept working, was driven by the
 * human, got blocked on a prompt, or completed a day later told the parent
 * nothing; on 2026-09-30 a parent lost a subtask that way and treated the work
 * as nobody's. The lead/worker model this follows: every worker turn end while
 * the task is open, every completion and every failure reaches the lead, and
 * the lead never polls.
 *
 * One notice per edge of the child (core/session-hooks/builtins.ts decides the
 * kind): `completed`, `error`, `stopped` (turn ended, task still open),
 * `blocked` (a permission prompt or question the user must answer), `waiting`
 * (the child parked itself). The notice is a `kind="notification"` envelope
 * (envelope-kit.ts buildSubtaskNotification) delivered through the same path a
 * reply takes: a busy parent gets it mid-turn, an idle or stopped one is woken.
 *
 * Bounded by construction:
 *  - direct parent only; a grandparent hears through its own child;
 *  - a COMPLETE parent, or one that never had a session, gets nothing (the
 *    board shows it); the send source `walnut-notify` never
 *    reopens a finished task (phase.ts REOPENING_SEND_SOURCES);
 *  - the child hears nothing back, so there is no loop;
 *  - edges for one parent within COALESCE_MS go out as ONE message of several
 *    envelopes (the web card renders each), and while the parent is busy a
 *    newer `stopped` / `blocked` / `waiting` notice for the same child replaces
 *    the pending one instead of stacking (a stable queue id per child and kind).
 */

import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import type { NoticeLastMessage } from '../session-requests.js';
import type { SubtaskNoticeKind, TurnStarter } from '../peers/envelope-kit.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';

const kit = createEnvelopeKit();

export type { SubtaskNoticeKind, TurnStarter };

/** Edges for one parent inside this window go out as one message. */
export const COALESCE_MS = 3_000;
/** A child that answered its parent this recently is not reported "stopped" (the reply was the update). */
export const RECENT_REPLY_MS = 10 * 60_000;
/** The bus source: a Walnut notice, never a human or a peer (phase.ts keeps it from reopening a task). */
export const NOTICE_SOURCE = 'walnut-notify';

/** The kinds a newer notice for the same child replaces while the older one still waits in the queue. */
const REPLACEABLE: ReadonlySet<SubtaskNoticeKind> = new Set(['stopped', 'blocked', 'waiting']);

export interface SubtaskNotice {
  parentTaskId: string;
  child: Pick<Task, 'id' | 'title'> & { sessionId?: string };
  kind: SubtaskNoticeKind;
  lastWords?: NoticeLastMessage;
  startedBy?: TurnStarter;
  error?: string;
  blockedOn?: string;
  waitUntil?: string;
  repliedRecently?: boolean;
}

/** The stable queue id of a replaceable notice: one row per child and kind. */
export function noticeQueueId(n: Pick<SubtaskNotice, 'child' | 'kind'>): string | undefined {
  return REPLACEABLE.has(n.kind) ? `sn-${n.child.id}-${n.kind}` : undefined;
}

/** The envelope text of one notice. */
export function buildSubtaskNoticeText(n: SubtaskNotice): string {
  return kit.buildSubtaskNotification({
    child: { title: n.child.title, sessionId: n.child.sessionId, taskId: n.child.id },
    kind: n.kind,
    lastMessage: n.lastWords,
    startedBy: n.startedBy,
    error: n.error,
    blockedOn: n.blockedOn,
    waitUntil: n.waitUntil,
    repliedRecently: n.repliedRecently,
  });
}

/**
 * Where a parent task hears: its LIVE session (running or idle), else nowhere.
 * A stopped session is never woken for a status notice (2026-10-01: a one-off
 * task that had filed a daily digest trigger was resumed, and billed, every
 * time the digest's turn ended, with nothing to do about it); the parent reads
 * its workers' state from `open_items` and `task_get` when it next runs, and a
 * reply it is actually waiting for still arrives through the request fallback
 * (session-request-watch), which has its own routing. A COMPLETE parent hears
 * nothing (a deleted one has no row to look up).
 */
export async function resolveParentDestination(parent: Task): Promise<SessionRecord | null> {
  if (parent.phase === 'COMPLETE') return null;
  const { getSessionsForTask, isListableSession } = await import('../session-tracker.js');
  const { addressable, bestFirst, isLive } = await import('./reply-routing.js');
  const rows = (await getSessionsForTask(parent.id)).filter((s) => addressable(s, isListableSession) && isLive(s));
  return rows.sort(bestFirst)[0] ?? null;
}

/** Whether a parent task can hear at all (the hook asks before it pays for a transcript read). */
export async function parentCanHear(parentTaskId: string): Promise<boolean> {
  try {
    const { getTask } = await import('../task-manager.js');
    const parent = await getTask(parentTaskId).catch(() => null);
    return !!parent && (await resolveParentDestination(parent)) !== null;
  } catch {
    return false;
  }
}

/** Only the newest notice per child and kind survives a batch. */
export function coalesce(batch: SubtaskNotice[]): SubtaskNotice[] {
  const latest = new Map<string, SubtaskNotice>();
  for (const n of batch) latest.set(`${n.child.id}/${n.kind}`, n);
  return [...latest.values()];
}

interface Pending { notices: SubtaskNotice[]; timer: ReturnType<typeof setTimeout> }
const pending = new Map<string, Pending>();

/**
 * Queue a notice for the parent. Never throws: a notice is best effort, and the
 * child's edge must not fail because its parent could not be told.
 */
export async function queueSubtaskNotice(n: SubtaskNotice): Promise<void> {
  try {
    const { getTask } = await import('../task-manager.js');
    const parent = await getTask(n.parentTaskId).catch(() => null);
    if (!parent) return;
    const dest = await resolveParentDestination(parent);
    if (!dest) {
      log.session.info('subtask notice skipped: parent cannot hear', {
        parentTaskId: n.parentTaskId, childTaskId: n.child.id, kind: n.kind, parentPhase: parent.phase,
      });
      return;
    }
    const sid = dest.claudeSessionId;
    const slot = pending.get(sid);
    if (slot) {
      slot.notices.push(n);
      clearTimeout(slot.timer);
      slot.timer = setTimeout(() => void flush(sid), COALESCE_MS);
      slot.timer.unref?.();
      return;
    }
    const timer = setTimeout(() => void flush(sid), COALESCE_MS);
    timer.unref?.();
    pending.set(sid, { notices: [n], timer });
  } catch (err) {
    log.session.warn('subtask notice failed', {
      parentTaskId: n.parentTaskId, childTaskId: n.child.id, kind: n.kind, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Deliver one parent's buffered notices as one message. */
async function flush(parentSid: string): Promise<void> {
  const slot = pending.get(parentSid);
  pending.delete(parentSid);
  if (!slot) return;
  const notices = coalesce(slot.notices);
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const target = await getSessionByClaudeId(parentSid);
    if (!target || target.archived) return;
    const text = notices.map(buildSubtaskNoticeText).join('\n\n');
    let stableId = notices.length === 1 ? noticeQueueId(notices[0]) : undefined;
    if (stableId) {
      const { getQueue, editMessage } = await import('../session-message-queue.js');
      const row = (await getQueue(parentSid)).find((m) => m.id === stableId);
      if (row?.status === 'pending') {
        // Still waiting in the queue: the newer notice replaces it, and the row's
        // own dispatch (already emitted) delivers the new text.
        if (await editMessage(parentSid, stableId, text)) {
          log.session.info('subtask notice replaced a pending one', { parentSid, messageId: stableId, kind: notices[0].kind });
          return;
        }
      }
      // In flight under that id: enqueueMessage would dedupe the new text away, so
      // this one rides a fresh row.
      if (row) stableId = undefined;
    }
    const { deliverToSession } = await import('./session-send-core.js');
    const { delivery, messageId } = await deliverToSession(target, {
      busText: text, enqueueText: text, source: NOTICE_SOURCE, taskId: target.taskId,
      ...(stableId ? { messageId: stableId } : {}),
    });
    log.session.info('subtask notice delivered', {
      parentSid, parentTaskId: target.taskId, delivery, messageId,
      children: notices.map((n) => ({ id: n.child.id, kind: n.kind })),
    });
  } catch (err) {
    log.session.warn('subtask notice delivery failed', {
      parentSid, children: notices.map((n) => ({ id: n.child.id, kind: n.kind })),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test seam: deliver everything buffered now. */
export async function flushSubtaskNotices(): Promise<void> {
  const sids = [...pending.keys()];
  for (const sid of sids) {
    const slot = pending.get(sid);
    if (slot) clearTimeout(slot.timer);
    await flush(sid);
  }
}
