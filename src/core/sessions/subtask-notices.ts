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
 * reply takes: a busy parent gets it mid-turn. A parent that is NOT mid-turn
 * (its turn ended, so its task sits in NEED_ACTION, or its process stopped) is
 * woken only for what it can act on: a worker that `completed` or hit an
 * `error`. `stopped`, `blocked` and `waiting` ride only a turn already running:
 * 2026-10-01, a task that had finished its own work was woken (and billed)
 * every time the daily digest it had once filed ended a trigger turn, and a
 * blocked worker needs the user, not its leader. A stopped session is never
 * woken at all (resolveParentDestination). What it did not hear it reads when
 * it next runs (open_items, task_get, its Board's live chips).
 *
 * Bounded by construction:
 *  - direct parent only; a grandparent hears through its own child;
 *  - a COMPLETE parent, or one that never had a session, gets nothing (the
 *    board shows it), also when it completed inside the coalesce window; the
 *    send source `walnut-notify` never reopens a finished task (phase.ts
 *    REOPENING_SEND_SOURCES). A parent may complete with subtasks still open
 *    (2026-10-04): its asks to them are withdrawn and the notices about them
 *    still queued for it are dropped (quietCompletedParent), and their own
 *    sends to it are refused (session-send-core.ts), so a closed leader stays
 *    closed until someone reopens it (restoreWithdrawnAsks);
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
import { parseWalnutMessage } from '../peers/walnut-message-tag.js';

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
  /** G19: where the child's card sits on its parent's Board (stopped / completed, only when the parent has one). */
  cardLine?: string;
}

/** A stopped / completed notice names the child's card when the parent has a Board (plain text, no wakeup). */
export async function attachCardLine(n: SubtaskNotice): Promise<SubtaskNotice> {
  if (!CARD_KINDS.has(n.kind) || n.cardLine !== undefined) return n;
  const cardLine = await boardCardLine(n.parentTaskId, n.child.id);
  return cardLine ? { ...n, cardLine } : n;
}

/** The kinds whose notice names the child's kanban card. */
const CARD_KINDS: ReadonlySet<SubtaskNoticeKind> = new Set<SubtaskNoticeKind>(['stopped', 'completed']);

/**
 * "Card: Investigating. Update it with board_card_set if the ticket moved or its
 * summary changed." when the parent has a Board; '' otherwise or on any failure.
 */
export async function boardCardLine(parentTaskId: string, childId: string): Promise<string> {
  try {
    const { getBoard, hasBoard } = await import('../boards/board-store.js');
    if (!(await hasBoard(parentTaskId))) return '';
    const { teamSnapshot, teamTags } = await import('../boards/board-team.js');
    const { placeTask } = await import('../boards/board-kanban.js');
    const { effectiveLanes, laneById, placeCard } = await import('../boards/board-lanes.js');
    const [board, snap] = await Promise.all([getBoard(parentTaskId), teamSnapshot(parentTaskId)]);
    const child = snap.byId.get(childId);
    if (!board || !child) return '';
    const lanes = effectiveLanes(board.lanes, teamTags(snap), board.lanes_template).lanes;
    const lane = laneById(lanes, placeCard(board.cards[childId], placeTask(child), lanes).lane);
    return lane ? `Card: ${lane.name}. Update it with board_card_set if the ticket moved or its summary changed.` : '';
  } catch {
    return '';
  }
}

/** The stable queue id of a replaceable notice: one row per child and kind. */
export function noticeQueueId(n: Pick<SubtaskNotice, 'child' | 'kind'>): string | undefined {
  return REPLACEABLE.has(n.kind) ? `sn-${n.child.id}-${n.kind}` : undefined;
}

/** The envelope text of one notice. */
export function buildSubtaskNoticeText(n: SubtaskNotice): string {
  const text = kit.buildSubtaskNotification({
    child: { title: n.child.title, sessionId: n.child.sessionId, taskId: n.child.id },
    kind: n.kind,
    lastMessage: n.lastWords,
    startedBy: n.startedBy,
    error: n.error,
    blockedOn: n.blockedOn,
    waitUntil: n.waitUntil,
    repliedRecently: n.repliedRecently,
  });
  if (!n.cardLine) return text;
  // Inside the envelope, before its closing "Next:" list (the last one: a quote may hold the word).
  const at = text.lastIndexOf('\n\nNext:\n');
  return at === -1 ? text : `${text.slice(0, at)}\n\n${n.cardLine}${text.slice(at)}`;
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

/** `task` names `parentId` as its parent; a stored parent id may be a legacy short prefix. */
export function isSubtaskOf(task: Pick<Task, 'parent_task_id'> | null | undefined, parentId: string): boolean {
  const p = task?.parent_task_id;
  return !!p && parentId.startsWith(p);
}

/** Which of `ids` are tasks that are direct subtasks of `parentId`. */
async function subtasksAmong(parentId: string, ids: Iterable<string>): Promise<Set<string>> {
  const { getTask } = await import('../task-manager.js');
  const out = new Set<string>();
  for (const id of new Set(ids)) {
    const t = await getTask(id).catch(() => null);
    if (t && isSubtaskOf(t, parentId)) out.add(id);
  }
  return out;
}

/**
 * The task ids a queued message is a Walnut notice about, when the message is
 * nothing but Walnut notification envelopes (a subtask notice batch, a request
 * fallback); [] for anything else.
 */
export function noticeSubjects(text: string): string[] {
  const about: string[] = [];
  let rest = text.trim();
  while (rest) {
    const env = parseWalnutMessage(rest);
    if (!env || !rest.startsWith(env.raw) || env.kind !== 'notification' || env.attrs.from !== 'Walnut') return [];
    const task = env.attrs['about-task'];
    if (!task) return [];
    about.push(task);
    rest = rest.slice(env.raw.length).trim();
  }
  return about;
}

/**
 * A task just completed: it hears nothing more from its own direct subtasks
 * until it is reopened. The replies it still waited for from them are
 * withdrawn (a subtask stops seeing them as owed, the sweeper never fires for
 * them, restoreWithdrawnAsks brings them back), and Walnut notices about them
 * still waiting in its sessions' queues are dropped: a boot or reconnect drain
 * would otherwise run a turn in the closed task. Asks to anyone else and every
 * other queued message stay. Never throws.
 */
export async function quietCompletedParent(parentTaskId: string): Promise<{ withdrawn: number; dropped: number }> {
  const none = { withdrawn: 0, dropped: 0 };
  try {
    const { getSessionsForTask } = await import('../session-tracker.js');
    const sids = (await getSessionsForTask(parentTaskId).catch(() => [])).map((s) => s.claudeSessionId);
    if (sids.length === 0) return none;
    const requests = await import('../session-requests.js');
    const queue = await import('../session-message-queue.js');
    const asks = (await Promise.all(sids.map((sid) => requests.pendingRequestsFromSession(sid)))).flat();
    const queued = (await Promise.all(sids.map(async (sid) => (await queue.getQueue(sid))
      .filter((m) => m.status === 'pending')
      .map((m) => ({ sid, id: m.id, about: noticeSubjects(m.message) })))))
      .flat().filter((q) => q.about.length > 0);
    if (asks.length === 0 && queued.length === 0) return none;
    const children = await subtasksAmong(parentTaskId, [
      ...asks.flatMap((r) => (r.toTaskId ? [r.toTaskId] : [])), ...queued.flatMap((q) => q.about),
    ]);
    let withdrawn = 0;
    let dropped = 0;
    for (const r of asks) {
      if (r.toTaskId && children.has(r.toTaskId) && await requests.withdrawRequest(r.id)) withdrawn++;
    }
    for (const q of queued) {
      if (q.about.every((id) => children.has(id)) && await queue.deleteMessage(q.sid, q.id)) dropped++;
    }
    if (withdrawn + dropped > 0) log.session.info('parent completed: its subtasks no longer reach it', { parentTaskId, withdrawn, dropped });
    return { withdrawn, dropped };
  } catch (err) {
    log.session.warn('quieting a completed parent failed', {
      parentTaskId, error: err instanceof Error ? err.message : String(err),
    });
    return none;
  }
}

/**
 * A completed task was reopened: every ask its sessions had withdrawn while it
 * was complete (to its subtasks at completion, to anyone by the fallback) is
 * pending again, so a reply or a fallback notice can reach it. Never throws.
 */
export async function restoreWithdrawnAsks(taskId: string): Promise<number> {
  try {
    const { getSessionsForTask } = await import('../session-tracker.js');
    const requests = await import('../session-requests.js');
    const sids = (await getSessionsForTask(taskId).catch(() => [])).map((s) => s.claudeSessionId);
    let restored = 0;
    for (const sid of sids) {
      for (const r of await requests.requestsFromSession(sid, 'withdrawn')) {
        if (await requests.restoreRequest(r.id)) restored++;
      }
    }
    if (restored > 0) log.session.info('task reopened: its withdrawn asks are pending again', { taskId, restored });
    return restored;
  } catch (err) {
    log.session.warn('restoring withdrawn asks failed', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
    return 0;
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
    n = await attachCardLine(n);
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

/** The edges worth a new turn for a parent whose own turn is over. */
const WAKES_AN_IDLE_PARENT: ReadonlySet<SubtaskNoticeKind> = new Set<SubtaskNoticeKind>(['completed', 'error']);

/** Deliver one parent's buffered notices as one message. */
async function flush(parentSid: string): Promise<void> {
  const slot = pending.get(parentSid);
  pending.delete(parentSid);
  if (!slot) return;
  let notices = coalesce(slot.notices);
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const target = await getSessionByClaudeId(parentSid);
    if (!target || target.archived) return;
    // Completed inside the coalesce window: a COMPLETE parent hears nothing.
    const { getTask } = await import('../task-manager.js');
    const parent = await getTask(notices[0].parentTaskId).catch(() => null);
    if (parent?.phase === 'COMPLETE') {
      log.session.info('subtask notice not sent: the parent completed meanwhile', {
        parentSid, parentTaskId: notices[0].parentTaskId,
        children: notices.map((n) => ({ id: n.child.id, kind: n.kind })),
      });
      return;
    }
    // Not mid-turn: wake it only for an edge it can act on (see the header).
    if (target.process_status !== 'running') {
      const dropped = notices.filter((n) => !WAKES_AN_IDLE_PARENT.has(n.kind));
      notices = notices.filter((n) => WAKES_AN_IDLE_PARENT.has(n.kind));
      if (dropped.length > 0) {
        log.session.info('subtask notice not sent: the parent is not mid-turn', {
          parentSid, parentTaskId: target.taskId, status: target.process_status,
          children: dropped.map((n) => ({ id: n.child.id, kind: n.kind })),
        });
      }
      if (notices.length === 0) return;
    }
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
