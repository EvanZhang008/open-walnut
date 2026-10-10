/**
 * Every Personal AI chat is an ask.
 *
 * The phone's chat (a lane conversation, personal-ai-lane.ts) and the Mac's Ask
 * drawer (ask tasks, ask-list.ts) used to be two stores with nothing in common:
 * a question asked on the phone never appeared on the Mac, and an ask started on
 * the Mac never appeared on the phone (2026-10-10: 418 chat sessions, 4 with a
 * task). This module gives every chat that has a session ONE ask task, so both
 * lists show it and either surface continues it:
 *
 *   conversation (phone channel) ──askTaskId──▶ ask task ──session_id──▶ lane session
 *                                                   ▲                         │
 *                                                   └──────── taskId ─────────┘
 *
 * The lane binding stays exactly as it was (the chat keeps its lane, its history
 * and its cloud fallback); the task is a second view of the same session, the
 * dual identity promoteLaneConversationToTask introduced for one chat at a time.
 *
 * Three ways in, one rule each:
 *   - a NEW lane session (askTaskForLaneMint, called by resolveLane BEFORE the
 *     spawn): the ask is found or created first and its id rides SESSION_START,
 *     so the runner links the slot and moves the phase like any ask's start.
 *   - a chat that already has sessions (linkLaneAsks, a boot pass): its sessions
 *     are linked after the fact and the live CLI is told (sessionRunner.syncTask).
 *     Old chats are filed as history: not pinned, born when the chat was, done
 *     unless they were used in the last day.
 *   - a chat with no session at all (cloud-only or pre-lane history) gets no ask:
 *     there is no transcript an ask could open. It joins on its next message.
 *
 * The agent's MAIN conversation is never an ask. It is the agent's background
 * channel (scheduled jobs, heartbeats and summary notices run their turns there),
 * so as a task it would read "needs you" after every background turn, and the
 * tasks those turns create would become its subtasks, waking it with their news.
 *
 * The binding is `askTaskId` on the conversation, written once and KEPT after the
 * task is deleted: a chat whose ask the user removed is never given another one.
 * Deleting either side deletes the other; renaming either side renames the other.
 *
 * Primary only. The companion holds copies of both stores and must never mint.
 */

import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js';
import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { ConversationMeta, SessionRecord, Task, TaskPhase } from '../types.js';
import { askProjectFor, resolveAskAgent, type AskAgentRef } from './ask-agent.js';
import { ASK_DEFAULT_TIER } from './ask-launch-plan.js';
import { GENERAL_AGENT_ID } from './ask-list.js';
import { parseLaneKey, personalAiLaneKey } from './personal-ai-lane.js';

/** The event source of this module's own task writes (its listeners skip them). */
const SOURCE = 'lane-ask-link';

/** A chat older than this is filed as done when it becomes an ask. */
const RECENT_CHAT_MS = 24 * 60 * 60 * 1000;

/** Titles the conversation store writes when it has nothing better. */
const STORE_DEFAULT_TITLES = new Set(['New Conversation', 'Recovered Conversation']);

/**
 * The title a chat can lend its ask, or undefined: not one of the store's
 * defaults and not a machine banner ("[Current: Sun, Jun 7…]", which the phone's
 * list already hides as untitled).
 */
export function chatTitleForAsk(title: string | undefined): string | undefined {
  const t = title?.trim() ?? '';
  if (!t || STORE_DEFAULT_TITLES.has(t) || /^\[[^\]]*\]$/.test(t)) return undefined;
  return t;
}

/** Whether the ask still wears its placeholder (its project's name). */
function wearsPlaceholder(task: Task): boolean {
  const title = (task.title ?? '').trim().toLowerCase();
  return !title || (title.startsWith('ask ') && title === (task.project ?? '').trim().toLowerCase());
}

async function taskOrNull(id: string | undefined): Promise<Task | null> {
  if (!id) return null;
  const { getTask } = await import('../task-manager.js');
  try {
    const task = await getTask(id);
    return task.id === id ? task : null;
  } catch {
    return null;
  }
}

async function conversationMeta(agentId: string, conversationId: string): Promise<ConversationMeta | undefined> {
  const { listConversations } = await import('../conversations.js');
  return (await listConversations(agentId)).find((c) => c.id === conversationId);
}

/**
 * The ask this chat already has: its recorded binding, else a task one of its
 * sessions is linked to (a chat promoted to a task before every chat was an
 * ask). 'dismissed' when the recorded ask was deleted.
 */
async function existingAsk(meta: ConversationMeta, segments: readonly SessionRecord[]): Promise<Task | 'dismissed' | null> {
  if (meta.askTaskId) return (await taskOrNull(meta.askTaskId)) ?? 'dismissed';
  for (const seg of [...segments].reverse()) {
    const task = await taskOrNull(seg.taskId);
    if (task) return task;
  }
  return null;
}

/** A task that IS a chat lists with its agent's asks: the stamp, nothing else
 *  (a promoted chat keeps its project, title and tier). */
async function stampAsAsk(task: Task, agent: AskAgentRef): Promise<void> {
  const agentId = agent.id === 'general' ? undefined : agent.id;
  if (task.walnut_agent === true && (task.agent_id || undefined) === agentId) return;
  const { updateTaskRaw } = await import('../task-manager.js');
  const { task: stamped } = await updateTaskRaw(task.id, {
    walnut_agent: true,
    ...(agentId ? { agent_id: agentId } : {}),
  }, { source: SOURCE });
  if (stamped) bus.emit(EventNames.TASK_UPDATED, { task: stamped }, ['web-ui'], { source: SOURCE });
}

/** Point every session of the chat at its ask, and tell the live CLI. */
async function linkSegments(taskId: string, segments: readonly SessionRecord[]): Promise<number> {
  const { linkSessionToTask } = await import('../session-tracker.js');
  let linked = 0;
  for (const seg of segments) {
    if (seg.taskId === taskId) continue;
    // A segment some OTHER live task holds is that task's; never steal it.
    if (seg.taskId && await taskOrNull(seg.taskId)) continue;
    await linkSessionToTask(seg.claudeSessionId, taskId);
    linked++;
  }
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js');
    for (const seg of segments) sessionRunner.syncTask(seg.claudeSessionId, taskId);
  } catch { /* no runner (tests): the records above still hold */ }
  return linked;
}

/** The session an ask's slot holds: the live segment, else the newest. */
function currentSegment(segments: readonly SessionRecord[]): SessionRecord | undefined {
  return [...segments].reverse().find((s) => !s.archived) ?? segments[segments.length - 1];
}

/** Bind the chat; when another linker won, drop our task and use theirs. */
async function bindOrYield(agentId: string, conversationId: string, task: Task): Promise<string | null> {
  const { setConversationAskTask } = await import('../conversations.js');
  const bound = await setConversationAskTask(agentId, conversationId, task.id);
  if (bound && bound !== task.id) await dropDuplicateAsk(task.id);
  return bound;
}

/**
 * Remove an ask that lost the race for its chat. Its slots are cleared first and
 * its sessions are NEVER stopped: the session it names is the chat's live CLI,
 * which now belongs to the winner.
 */
async function dropDuplicateAsk(taskId: string): Promise<void> {
  const tm = await import('../task-manager.js');
  try {
    const task = await tm.getTask(taskId);
    for (const sid of new Set([task.session_id, task.exec_session_id, task.plan_session_id, ...(task.session_ids ?? [])])) {
      if (!sid) continue;
      await tm.clearSessionSlot(taskId, sid).catch(() => {});
      await tm.clearSession(taskId, sid).catch(() => {});
    }
    await tm.updateTaskRaw(taskId, { session_ids: [] }, { source: SOURCE }).catch(() => {});
    const { task: gone } = await tm.deleteTask(taskId);
    bus.emit(EventNames.TASK_DELETED, { id: gone.id, task: gone }, ['web-ui'], { source: SOURCE });
  } catch (err) {
    log.session.warn('chat: dropping a duplicate ask failed', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** One link at a time per chat: a mint and the boot pass must not both create. */
const linking = new Map<string, Promise<string>>();

function serialized(lane: string, fn: () => Promise<string>): Promise<string> {
  const prev = linking.get(lane) ?? Promise.resolve('');
  const next = prev.catch(() => '').then(fn);
  const tail = next.catch(() => '');
  linking.set(lane, tail);
  void tail.then(() => { if (linking.get(lane) === tail) linking.delete(lane); });
  return next;
}

/**
 * The ask a NEW lane session belongs to. Called by resolveLane (and the chat
 * fork) before the spawn, so the id rides SESSION_START and the runner links the
 * slot and moves the phase itself, the same start every ask gets.
 *
 * `create: false` only finds one: a mint that carries no message (the phone's
 * model pill warms a lane the moment a new chat opens) must not file an empty
 * ask; the chat's first real message does (adoptLaneSessionForTurn).
 *
 * '' when the chat has no ask and gets none (a replica, no such conversation, an
 * unknown agent, an ask the user deleted) and on ANY failure: a chat that
 * answers matters more than its row in a list.
 */
export async function askTaskForLaneMint(
  agentId: string,
  conversationId: string,
  opts: { create: boolean },
): Promise<string> {
  if (CLOUD_MODE) return '';
  const lane = personalAiLaneKey(agentId, conversationId);
  return serialized(lane, () => findOrCreateAsk(agentId, conversationId, lane, opts.create));
}

/**
 * A real turn is about to go into a lane session no task holds yet (one warmed
 * without a message, or one that predates asks): the chat gets its ask now and
 * the session joins it, live CLI included. Never throws.
 */
export async function adoptLaneSessionForTurn(agentId: string, conversationId: string, sessionId: string): Promise<void> {
  if (CLOUD_MODE) return;
  const lane = personalAiLaneKey(agentId, conversationId);
  await serialized(lane, async () => {
    const taskId = await findOrCreateAsk(agentId, conversationId, lane, true);
    if (!taskId) return '';
    try {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      const record = await getSessionByClaudeId(sessionId);
      if (!record || record.taskId) return taskId;
      const { linkSession } = await import('../task-manager.js');
      const { task } = await linkSession(taskId, sessionId);
      await linkSegments(taskId, [record]);
      bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: SOURCE });
    } catch (err) {
      log.session.warn('chat: linking its session to its ask failed', {
        agentId, conversationId, sessionId, error: err instanceof Error ? err.message : String(err),
      });
    }
    return taskId;
  });
}

/** The chat's ask, made when `create` and it has none. The caller holds the
 *  chat's serialization; '' on any failure (see askTaskForLaneMint). */
async function findOrCreateAsk(agentId: string, conversationId: string, lane: string, create: boolean): Promise<string> {
  try {
    const meta = await conversationMeta(agentId, conversationId);
    if (!meta || meta.isMain) return '';
    const agent = await resolveAskAgent(agentId);
    if (!agent) return '';
    const { listSessionsByLane } = await import('../session-tracker.js');
    const found = await existingAsk(meta, await listSessionsByLane(lane));
    if (found === 'dismissed') return '';
    if (found) {
      await stampAsAsk(found, agent);
      return (await bindOrYield(agentId, conversationId, found)) ?? '';
    }
    if (!create) return '';
    const project = askProjectFor(agent);
    const { addTask } = await import('../task-manager.js');
    const { task } = await addTask({
      title: chatTitleForAsk(meta.title) ?? project,
      project,
      source: 'local',
      cwd: WALNUT_HOME,
      walnut_agent: true,
      ...(agent.id !== 'general' ? { agent_id: agent.id } : {}),
      // Born where an ask started on the Mac is born (ask-launch-plan.ts).
      pinned: true,
      focus_tier: ASK_DEFAULT_TIER,
    });
    bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: SOURCE });
    const bound = await bindOrYield(agentId, conversationId, task);
    log.session.info('chat became an ask', { agentId, conversationId, taskId: bound });
    return bound ?? '';
  } catch (err) {
    log.session.warn('chat: making its ask failed; the chat runs without one', {
      agentId, conversationId, error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

export interface LaneAskReport {
  chats: number;
  created: number;
  adopted: number;
  linkedSessions: number;
  dismissed: number;
  noSession: number;
  /** The agent's main conversation, which is never an ask. */
  main: number;
}

/** The phase an old chat is filed in: running if it is, needing the user when
 *  it was used in the last day, else done. */
function backfillPhase(meta: ConversationMeta, current: SessionRecord | undefined, now: number): TaskPhase {
  if (current?.process_status === 'running') return 'IN_PROGRESS';
  const last = Date.parse(meta.lastMessageAt ?? '');
  return Number.isFinite(last) && now - last < RECENT_CHAT_MS ? 'NEED_ACTION' : 'COMPLETE';
}

/**
 * Give every chat that has a session its ask, and link sessions an ask is
 * missing. Idempotent: a second pass finds every chat bound and writes nothing.
 * One scan of the session table, one index read per agent, and ONE bulk insert
 * for the new tasks, so a first pass over a hundred chats stays off the event
 * loop's critical path.
 */
export async function linkLaneAsks(opts: { now?: number } = {}): Promise<LaneAskReport> {
  const report: LaneAskReport = { chats: 0, created: 0, adopted: 0, linkedSessions: 0, dismissed: 0, noSession: 0, main: 0 };
  if (CLOUD_MODE) return report;
  const now = opts.now ?? Date.now();
  const { listChatLaneSessions } = await import('../session-tracker.js');
  const byLane = new Map<string, SessionRecord[]>();
  for (const s of await listChatLaneSessions()) {
    if (!s.lane) continue;
    const list = byLane.get(s.lane) ?? [];
    list.push(s);
    byLane.set(s.lane, list);
  }
  const agentIds = new Set<string>();
  for (const lane of byLane.keys()) {
    const ids = parseLaneKey(lane);
    if (ids) agentIds.add(ids.agentId);
  }

  for (const agentId of agentIds) {
    const agent = await resolveAskAgent(agentId).catch(() => undefined);
    if (!agent) continue;
    const { listConversations, setConversationAskTasks } = await import('../conversations.js');
    const metas = await listConversations(agentId);
    const project = askProjectFor(agent);
    const creates: Array<{ meta: ConversationMeta; segments: SessionRecord[]; task: Omit<Task, 'id'> }> = [];
    const bindings = new Map<string, string>();

    for (const meta of metas) {
      if (meta.isMain) { report.main++; continue; }
      const segments = byLane.get(personalAiLaneKey(agentId, meta.id));
      if (!segments?.length) { report.noSession++; continue; }
      report.chats++;
      await serialized(personalAiLaneKey(agentId, meta.id), async () => {
        const found = await existingAsk(meta, segments);
        if (found === 'dismissed') { report.dismissed++; return ''; }
        if (found) {
          await stampAsAsk(found, agent);
          report.linkedSessions += await linkSegments(found.id, segments);
          if (!meta.askTaskId) { bindings.set(meta.id, found.id); report.adopted++; }
          return found.id;
        }
        const current = currentSegment(segments);
        const phase = backfillPhase(meta, current, now);
        const nowIso = new Date(now).toISOString();
        creates.push({
          meta,
          segments,
          task: {
            title: chatTitleForAsk(meta.title) ?? project,
            status: phase === 'COMPLETE' ? 'done' : 'in_progress',
            phase,
            priority: 'none',
            project,
            source: 'local',
            cwd: WALNUT_HOME,
            walnut_agent: true,
            ...(agent.id !== 'general' ? { agent_id: agent.id } : {}),
            session_ids: segments.map((s) => s.claudeSessionId),
            ...(current ? { session_id: current.claudeSessionId } : {}),
            description: '',
            summary: '',
            note: '',
            // Born when the chat was, last touched when it last was: the ask list
            // sorts and prints by these, so a hundred old chats must not all read
            // "just now" at the top.
            created_at: meta.createdAt || nowIso,
            updated_at: nowIso,
            last_session_update: meta.lastMessageAt || meta.createdAt || nowIso,
            ...(phase === 'COMPLETE' ? { completed_at: meta.lastMessageAt || nowIso } : {}),
          } as Omit<Task, 'id'>,
        });
        return '';
      });
    }

    if (creates.length) {
      const tm = await import('../task-manager.js');
      // addTasksBulk writes rows only; the project's registry row comes first.
      await tm.ensureProject(project, 'local', { writer: SOURCE });
      // Rows are matched back by their first session, which belongs to one chat
      // only (addTasksBulk skips a row it refuses, so positions can shift).
      const created = new Map((await tm.addTasksBulk(creates.map((c) => c.task)))
        .map((t) => [t.session_ids?.[0], t] as const));
      const made: Array<{ task: Task; segments: SessionRecord[]; conversationId: string }> = [];
      for (const c of creates) {
        const task = created.get(c.task.session_ids[0]);
        if (!task) continue;
        bindings.set(c.meta.id, task.id);
        made.push({ task, segments: c.segments, conversationId: c.meta.id });
      }
      // Bind BEFORE linking: a chat a mint bound meanwhile keeps the mint's ask,
      // and our copy is dropped without ever touching the chat's sessions.
      const bound = await setConversationAskTasks(agentId, bindings);
      bindings.clear();
      for (const { task, segments, conversationId } of made) {
        if (bound.get(conversationId) !== task.id) { await dropDuplicateAsk(task.id); continue; }
        report.linkedSessions += await linkSegments(task.id, segments);
        bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: SOURCE });
        report.created++;
      }
    }

    if (bindings.size) await setConversationAskTasks(agentId, bindings);
  }

  if (report.created || report.adopted || report.linkedSessions) {
    log.session.info('chats linked to their asks', { ...report });
  }
  return report;
}

/** Delete an ask task, stopping its sessions first (the force path of DELETE /tasks). */
async function deleteAskTask(taskId: string): Promise<void> {
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

/** The phone deleted a chat: its ask goes too. */
export async function conversationDeleted(agentId: string, conversationId: string, askTaskId: string): Promise<void> {
  if (CLOUD_MODE || !(await taskOrNull(askTaskId))) return;
  await deleteAskTask(askTaskId);
  log.session.info('chat deleted, its ask with it', { agentId, conversationId, taskId: askTaskId });
}

/**
 * A chat's title moved. Its ask follows when the user renamed the chat, or when
 * the ask still wears its placeholder or the chat's previous automatic title (an
 * auto-title arriving after the ask was made). An ask whose name the chat had
 * copied (`beforeFromAsk`: the user's rename, or the ask's own titler) keeps it,
 * and the chat is renamed back to it so both lists agree.
 */
export async function conversationTitleChanged(
  agentId: string,
  conversationId: string,
  before: string,
  after: string,
  by: 'user' | 'auto',
  beforeFromAsk = false,
): Promise<void> {
  if (CLOUD_MODE) return;
  const meta = await conversationMeta(agentId, conversationId);
  const task = await taskOrNull(meta?.askTaskId);
  if (!task || task.title === after) return;
  const title = chatTitleForAsk(after);
  if (title && (by === 'user' || wearsPlaceholder(task) || (task.title === before && !beforeFromAsk))) {
    const { updateTask } = await import('../task-manager.js');
    await updateTask(task.id, { title }, { source: SOURCE });
    return;
  }
  // Same rule as the ask → chat sync: a placeholder is never copied back.
  if (wearsPlaceholder(task)) return;
  const { renameConversation } = await import('../conversations.js');
  await renameConversation(agentId, conversationId, task.title, { fromAsk: true });
}

/** The ask's chat, read off its session's lane. */
async function chatOfAsk(task: Task): Promise<{ agentId: string; conversationId: string; meta: ConversationMeta } | null> {
  if (task.walnut_agent !== true) return null;
  // The binding lives on the chat, so read it there: the ask's own agent first
  // (a task's session link can lag its spawn), then the lane of its session.
  const { listConversations } = await import('../conversations.js');
  const agentId = task.agent_id || GENERAL_AGENT_ID;
  const direct = (await listConversations(agentId).catch(() => [])).find((c) => c.askTaskId === task.id);
  if (direct) return { agentId, conversationId: direct.id, meta: direct };
  const sid = task.session_id || task.session_ids?.[task.session_ids.length - 1];
  if (!sid) return null;
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const ids = parseLaneKey((await getSessionByClaudeId(sid).catch(() => null))?.lane);
  if (!ids) return null;
  const meta = await conversationMeta(ids.agentId, ids.conversationId);
  return meta?.askTaskId === task.id ? { ...ids, meta } : null;
}

/**
 * The deletes that are a person's (the console, the phone, the phone through the
 * companion, an agent's task_delete): only those take the chat with them. A merge
 * folding the ask into another task, or a sync plugin mirroring a remote delete,
 * is bookkeeping, and the conversation's history must not go with it.
 */
const CHAT_DELETING_SOURCES: ReadonlySet<string> = new Set(['api', 'api-v1', 'cloud-outbox']);

/** Last title seen per ask, so a session touch (TASK_UPDATED on every send)
 *  costs nothing when the title did not move. */
const seenTitles = new Map<string, string>();

/**
 * Keep the chat in step with its ask: an ask renamed on the Mac renames the chat,
 * and an ask deleted by a person deletes the chat. Returns a stop function.
 */
export function startLaneAskSync(): () => void {
  if (CLOUD_MODE) return () => {};
  bus.subscribe(SOURCE, async (event) => {
    if (event.source === SOURCE) return;
    try {
      if (event.name === EventNames.TASK_UPDATED) {
        const task = (event.data as { task?: Task | null }).task;
        if (!task || task.walnut_agent !== true || seenTitles.get(task.id) === task.title) return;
        seenTitles.set(task.id, task.title);
        if (seenTitles.size > 2000) seenTitles.clear();
        // The project's name is no title: copied into the chat it would mark the
        // chat as titled, and the chat's own titler would never name it.
        if (wearsPlaceholder(task)) return;
        const chat = await chatOfAsk(task);
        if (!chat || chat.meta.title === task.title) return;
        const { renameConversation } = await import('../conversations.js');
        await renameConversation(chat.agentId, chat.conversationId, task.title, { fromAsk: true });
      } else if (event.name === EventNames.TASK_DELETED) {
        const task = (event.data as { task?: Task }).task;
        if (!task) return;
        seenTitles.delete(task.id);
        if (!CHAT_DELETING_SOURCES.has(event.source)) return;
        const chat = await chatOfAsk(task);
        if (!chat) return;
        const { deleteConversation } = await import('../conversations.js');
        await deleteConversation(chat.agentId, chat.conversationId);
        log.session.info('ask deleted, its chat with it', { ...chat, meta: undefined, taskId: task.id });
      }
    } catch (err) {
      log.session.warn('ask → chat sync failed', {
        event: event.name, error: err instanceof Error ? err.message : String(err),
      });
    }
  }, { global: true, interest: [EventNames.TASK_UPDATED, EventNames.TASK_DELETED] });
  return () => bus.unsubscribe(SOURCE);
}
