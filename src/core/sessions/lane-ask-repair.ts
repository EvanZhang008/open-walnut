/**
 * Sessions that answered nothing in their chat, and what they did to its ask.
 *
 * The phone warms a chat's lane the moment the chat opens (its model pill needs
 * a session). When the chat had no live session, that warm mint is a new, empty
 * one. Two paths used to make it an ask's main session: a warm mint joined the
 * chat's ask (fixed in personal-ai-lane.ts), and the boot pass filed any chat
 * with a lane session as an ask, warm ones included. Either way the Mac opened
 * an empty page, and the ask jumped to the top of both lists without a word said.
 *
 * `answeredSegments` is the rule the pass files by; `releaseIdleSegments` undoes
 * what an idle segment did, once, on every pass (idempotent).
 */

import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { ConversationMeta, SessionRecord, Task } from '../types.js';

const SOURCE = 'lane-ask-link';

/**
 * How long after a chat's last message the session that answered it may have
 * started. The phone persists the user's message (which touches the chat)
 * before the lane mints its session (seen on real data: one-exchange chats
 * whose only session started 1 s after the chat's last message). A warm mint
 * comes when the chat is opened again, and never right after a turn: the
 * session that answered it is still alive to reuse (the idle reap is 2 h).
 */
export const ANSWER_SLACK_MS = 10 * 60 * 1000;

/**
 * The segments that can have answered this chat: a fork (its session carries
 * the copied conversation, and its chat records no message until the user
 * writes), and, in a chat with messages, every session started no later than
 * shortly after its last one. A chat with messages but no recorded last message
 * keeps them all (older records).
 */
export function answeredSegments(meta: ConversationMeta, segments: readonly SessionRecord[]): SessionRecord[] {
  const last = Date.parse(meta.lastMessageAt ?? '');
  return segments.filter((s) => {
    if (s.forkedFromSessionId) return true;
    if (!meta.messageCount) return false;
    if (!Number.isFinite(last)) return true;
    const started = Date.parse(s.startedAt ?? '');
    return !Number.isFinite(started) || started <= last + ANSWER_SLACK_MS;
  });
}

/** Delete an ask task, stopping its sessions first (the force path of DELETE /tasks). */
export async function deleteAskTask(taskId: string): Promise<void> {
  const tm = await import('../task-manager.js');
  let result: { task: Task };
  try {
    result = await tm.deleteTask(taskId);
  } catch (err) {
    if (!(err instanceof tm.ActiveSessionError)) throw err;
    const { completeTaskSessions } = await import('../session-tracker.js');
    await completeTaskSessions(err.activeSessionIds);
    for (const sid of err.activeSessionIds) {
      await tm.clearSessionSlot(taskId, sid).catch(() => {});
      await tm.clearSession(taskId, sid).catch(() => {});
    }
    result = await tm.deleteTask(taskId);
  }
  bus.emit(EventNames.TASK_DELETED, { id: result.task.id, task: result.task }, ['web-ui'], { source: SOURCE });
}

/**
 * Take the chat's idle segments back from its ask, when that ask has sessions
 * of its own (one that answered the chat, or a promoted chat's work session):
 * each idle one is unlinked (so the chat's next real message adopts it,
 * adoptLaneSessionForTurn), and the ask's main session and list position go
 * back to before it. An ask whose chat never recorded a message, with nothing
 * but idle sessions, was only ever an empty chat opened once: it is removed and
 * the chat unbound, so the chat is listed under Earlier and a first real
 * message makes a fresh ask. An older chat whose history predates its lane
 * session keeps its ask and that session: its next turn goes there.
 */
export async function releaseIdleSegments(
  agentId: string,
  meta: ConversationMeta,
  idle: readonly SessionRecord[],
): Promise<'none' | 'released' | 'removed'> {
  if (!meta.askTaskId || !idle.length) return 'none';
  const tm = await import('../task-manager.js');
  const task = await tm.getTask(meta.askTaskId).then((t) => (t.id === meta.askTaskId ? t : null)).catch(() => null);
  if (!task) return 'none';
  const held = new Set([task.session_id, ...(task.session_ids ?? [])].filter(Boolean));
  // A session mid-turn may be taking the chat's first real message right now
  // (adopted, the chat not yet touched): never take that one back.
  const ours = idle.filter((s) => (s.taskId === task.id || held.has(s.claudeSessionId))
    && s.process_status !== 'running');
  if (!ours.length) return 'none';
  const idleIds = new Set(ours.map((s) => s.claudeSessionId));
  const remaining = (task.session_ids ?? []).filter((id) => !idleIds.has(id));
  const otherSlots = [task.plan_session_id, task.exec_session_id].some((id) => id && !idleIds.has(id));

  if (!remaining.length && !otherSlots) {
    if (meta.messageCount || !task.walnut_agent) return 'none';
    await deleteAskTask(task.id);
    const { clearConversationAskTask } = await import('../conversations.js');
    await clearConversationAskTask(agentId, meta.id, task.id);
    log.session.info('chat: removed the ask of a chat that never recorded a message', {
      agentId, conversationId: meta.id, taskId: task.id, sessions: [...idleIds],
    });
    return 'removed';
  }

  const { getSessionByClaudeId, linkSessionToTask } = await import('../session-tracker.js');
  for (const s of ours) {
    if (s.taskId === task.id) await linkSessionToTask(s.claudeSessionId, '');
  }
  // The main session goes back to the newest one left, by when it started.
  let primary = task.session_id;
  if (primary && idleIds.has(primary)) {
    const records = await Promise.all(remaining.map(async (id) => ({ id, rec: await getSessionByClaudeId(id).catch(() => null) })));
    const started = (r: { rec: SessionRecord | null }) => Date.parse(r.rec?.startedAt ?? '') || 0;
    primary = records.sort((a, b) => started(b) - started(a))[0]?.id;
  }
  const lastTouch = meta.lastMessageAt || meta.createdAt;
  const { task: updated } = await tm.updateTaskRaw(task.id, (cur) => ({
    session_ids: (cur.session_ids ?? []).filter((id) => !idleIds.has(id)),
    session_id: cur.session_id && idleIds.has(cur.session_id) ? primary : cur.session_id,
    // A link stamps "now" here, and the ask list sorts by it.
    ...(lastTouch ? { last_session_update: lastTouch } : {}),
  }), { source: SOURCE });
  if (updated) bus.emit(EventNames.TASK_UPDATED, { task: updated }, ['web-ui'], { source: SOURCE });
  log.session.info('chat: took empty warm sessions back from its ask', {
    agentId, conversationId: meta.id, taskId: task.id, sessions: [...idleIds], mainSession: primary ?? null,
  });
  return 'released';
}
