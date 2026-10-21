/**
 * Every Personal AI chat is an ask (src/core/sessions/lane-ask-link.ts).
 *
 * Before this, a question asked on the phone (a lane conversation) never showed
 * on the Mac's Ask drawer (ask tasks): two stores, nothing in common. These tests
 * pin the promises the link makes, each the way it could quietly break:
 *   - a chat's first real message makes ONE ask, born like a Mac ask, and the
 *     spawn carries its id; a lane warmed without a message makes none;
 *   - old chats are filed as history (not pinned, their own dates, done unless
 *     recent), a chat promoted to a task before keeps that task, and a second
 *     pass writes nothing;
 *   - an ask the user deleted is never minted again;
 *   - deleting or renaming either side follows on the other.
 *
 * Real task store, real session DB, real conversation index in a temp home. No
 * CLI is spawned: the session runner is a fake that records SESSION_START.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-lane-ask'));

import { WALNUT_HOME, conversationIndexFile } from '../../../src/constants.js';
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js';
import type { SessionStartEvent } from '../../../src/core/event-types.js';
import type { ConversationIndex } from '../../../src/core/types.js';
import {
  createConversation,
  getMainConversationId,
  listConversations,
  deleteConversation,
  renameConversation,
  touchLaneConversation,
} from '../../../src/core/conversations.js';
import {
  createSessionRecord,
  getSessionByClaudeId,
  _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js';
import {
  addTask,
  getTask,
  deleteTask,
  updateTask,
  queryTasks,
  _resetForTesting as _resetTaskManager,
} from '../../../src/core/task-manager.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js';
import { getOrCreateLaneSession, personalAiLaneKey } from '../../../src/core/sessions/personal-ai-lane.js';
import {
  askTaskForLaneMint,
  chatTitleForAsk,
  linkLaneAsks,
  startLaneAskSync,
} from '../../../src/core/sessions/lane-ask-link.js';
import { computeAgentAsks } from '../../../src/web/routes/asks-v1.js';

let started: SessionStartEvent[] = [];

function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_START) started.push(event.data as SessionStartEvent);
  });
}

async function resetAll(): Promise<void> {
  closeSessionDb();
  closeTaskDb();
  _resetSessionTrackerForTesting();
  _resetTaskManager();
  for (let i = 0; i < 3; i++) {
    try { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
}

beforeEach(async () => {
  bus.clear();
  started = [];
  await resetAll();
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  installFakeRunner();
});

afterEach(async () => {
  bus.clear();
  await resetAll();
});

/** A chat as the phone leaves it: an index row with its own dates, and the
 *  messages it recorded (two by default; 0 is a chat opened and never used). */
async function makeChat(
  agentId: string, title: string, dates?: { createdAt: string; lastMessageAt: string }, messages = 2,
) {
  const meta = await createConversation(agentId, title);
  const file = conversationIndexFile(agentId);
  const index = JSON.parse(await fsp.readFile(file, 'utf-8')) as ConversationIndex;
  const row = index.conversations.find((c) => c.id === meta.id)!;
  if (dates) {
    row.createdAt = dates.createdAt;
    row.lastMessageAt = dates.lastMessageAt;
  }
  row.messageCount = messages;
  await fsp.writeFile(file, JSON.stringify(index));
  return { ...meta, ...(dates ?? {}), messageCount: messages };
}

/** A lane session the chat already had (minted before asks existed). */
async function makeLaneSession(
  agentId: string,
  conversationId: string,
  opts: { taskId?: string; archived?: boolean; startedAt?: string; forkedFrom?: string } = {},
) {
  const sid = randomUUID();
  await createSessionRecord(sid, opts.taskId ?? '', '', WALNUT_HOME, {
    title: 'Main AI chat',
    lane: personalAiLaneKey(agentId, conversationId),
    initialProcessStatus: 'idle',
  });
  const { updateSessionRecord } = await import('../../../src/core/session-tracker.js');
  if (opts.archived) await updateSessionRecord(sid, { archived: true, archive_reason: 'test' });
  if (opts.startedAt) await updateSessionRecord(sid, { startedAt: opts.startedAt });
  if (opts.forkedFrom) await updateSessionRecord(sid, { forkedFromSessionId: opts.forkedFrom });
  return sid;
}

async function chatMeta(agentId: string, id: string) {
  return (await listConversations(agentId)).find((c) => c.id === id);
}

/** Let fire-and-forget hooks (title and delete propagation) settle. */
async function settle(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('chatTitleForAsk', () => {
  it('lends real titles and refuses the store defaults and machine banners', () => {
    expect(chatTitleForAsk('Dishwasher drain fault')).toBe('Dishwasher drain fault');
    expect(chatTitleForAsk('New Conversation')).toBeUndefined();
    expect(chatTitleForAsk('Recovered Conversation')).toBeUndefined();
    expect(chatTitleForAsk('[Current: Sun, Jun 7, 2026, 05:26 PM]')).toBeUndefined();
    expect(chatTitleForAsk('   ')).toBeUndefined();
  });
});

describe('a new chat', () => {
  it('becomes ONE ask on its first message, born like a Mac ask, and the spawn names it', async () => {
    const chat = await makeChat('general', 'Dishwasher drain fault');
    const first = await getOrCreateLaneSession('general', chat.id, { firstMessage: 'why does it not drain' });
    expect(first.created).toBe(true);

    const meta = await chatMeta('general', chat.id);
    expect(meta?.askTaskId).toBeTruthy();
    const task = await getTask(meta!.askTaskId!);
    expect(task).toMatchObject({
      title: 'Dishwasher drain fault',
      project: 'Ask Walnut',
      walnut_agent: true,
      pinned: true,
      focus_tier: 'focus',
      cwd: WALNUT_HOME,
    });
    expect(task.agent_id).toBeUndefined();
    // The spawn carries the ask, and so does the record seeded before it: the
    // runner links the slot and moves the phase from there.
    expect(started).toHaveLength(1);
    expect(started[0].taskId).toBe(task.id);
    expect((await getSessionByClaudeId(first.sessionId))?.taskId).toBe(task.id);

    // The next turn reuses the session and makes nothing new.
    await getOrCreateLaneSession('general', chat.id, { firstMessage: 'still not' });
    const asks = (await queryTasks({})).filter((t) => t.walnut_agent);
    expect(asks).toHaveLength(1);
  });

  it('warmed without a message gets no ask; its first real message makes one and links the session', async () => {
    const chat = await makeChat('general', 'New Conversation');
    const warm = await getOrCreateLaneSession('general', chat.id);
    expect(warm.created).toBe(true);
    expect(started[0].taskId).toBe('');
    expect((await chatMeta('general', chat.id))?.askTaskId).toBeUndefined();
    expect((await queryTasks({})).filter((t) => t.walnut_agent)).toHaveLength(0);

    await getOrCreateLaneSession('general', chat.id, { firstMessage: 'hello' });
    const meta = await chatMeta('general', chat.id);
    const task = await getTask(meta!.askTaskId!);
    // No title yet: the ask wears its project's name until the chat gets one.
    expect(task.title).toBe('Ask Walnut');
    expect(task.session_id).toBe(warm.sessionId);
    expect((await getSessionByClaudeId(warm.sessionId))?.taskId).toBe(task.id);
  });

  // Opening a chat on the phone warms its lane (the model pill needs a session).
  // When the chat's last session is archived, that warm mint is a new, empty
  // session: joining the ask then made it the ask's main session, so the Mac
  // opened an empty page and the ask jumped to the top of both lists without a
  // word said (seen live on a chat promoted to a work task).
  it("a warm mint for a chat that already has an ask leaves the ask alone until a real message", async () => {
    const chat = await makeChat('general', 'Dishwasher drain fault');
    const first = await getOrCreateLaneSession('general', chat.id, { firstMessage: 'why does it not drain' });
    const askId = (await chatMeta('general', chat.id))!.askTaskId!;
    const { linkSession } = await import('../../../src/core/task-manager.js');
    await linkSession(askId, first.sessionId);
    const { updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    await updateSessionRecord(first.sessionId, { archived: true, archive_reason: 'test' });
    const before = await getTask(askId);

    started = [];
    const warm = await getOrCreateLaneSession('general', chat.id);
    expect(warm.created).toBe(true);
    expect(warm.sessionId).not.toBe(first.sessionId);
    expect(started[0].taskId).toBe('');
    const after = await getTask(askId);
    expect(after.session_id).toBe(first.sessionId);
    expect(after.session_ids).not.toContain(warm.sessionId);
    expect(after.updated_at).toBe(before.updated_at);

    // The first real message is where the chat moves on. One session per task:
    // the old ask keeps its conversation, and the chat gets a new ask.
    await getOrCreateLaneSession('general', chat.id, { firstMessage: 'it drains now' });
    expect((await getTask(askId)).session_id).toBe(first.sessionId);
    const nextAsk = (await chatMeta('general', chat.id))!.askTaskId!;
    expect(nextAsk).not.toBe(askId);
    expect((await getTask(nextAsk)).session_id).toBe(warm.sessionId);
    expect((await queryTasks({})).filter((t) => t.walnut_agent)).toHaveLength(2);
  });

  it("files another agent's chat under that agent's ask project with its stamp", async () => {
    const chat = await makeChat('mentor', 'Procrastination');
    await getOrCreateLaneSession('mentor', chat.id, { firstMessage: 'help' });
    const task = await getTask((await chatMeta('mentor', chat.id))!.askTaskId!);
    expect(task).toMatchObject({ project: 'Ask Mentor', agent_id: 'mentor', walnut_agent: true });
  });

  it('does not make an ask for a conversation that is not in the index', async () => {
    expect(await askTaskForLaneMint('general', 'conv-nowhere', { create: true })).toBe('');
    expect((await queryTasks({})).filter((t) => t.walnut_agent)).toHaveLength(0);
  });
});

describe("the agent's main conversation", () => {
  // Scheduled jobs and notices run their turns there: as a task it would read
  // "needs you" after each of them, and their tasks would become its subtasks.
  it('is never an ask, by its first message or by the pass', async () => {
    const mainId = await getMainConversationId('general');
    await makeLaneSession('general', mainId);
    const report = await linkLaneAsks({ now: Date.parse('2026-10-10T18:00:00.000Z') });
    expect(report).toMatchObject({ main: 1, created: 0, adopted: 0 });

    await getOrCreateLaneSession('general', mainId, { firstMessage: 'a scheduled job prompt' });
    expect((await chatMeta('general', mainId))?.askTaskId).toBeUndefined();
    expect((await queryTasks({})).filter((t) => t.walnut_agent)).toHaveLength(0);
    expect(await askTaskForLaneMint('general', mainId, { create: true })).toBe('');
  });
});

describe('the pass over chats that already had sessions', () => {
  const NOW = Date.parse('2026-10-10T18:00:00.000Z');

  it('files old chats as history with their own dates, and a second pass writes nothing', async () => {
    const old = await makeChat('general', 'Glycine', {
      createdAt: '2026-10-01T10:00:00.000Z', lastMessageAt: '2026-10-02T11:00:00.000Z',
    });
    const recent = await makeChat('general', 'Dishwasher drain fault', {
      createdAt: '2026-10-10T02:50:00.000Z', lastMessageAt: '2026-10-10T17:30:00.000Z',
    });
    const archivedSid = await makeLaneSession('general', old.id, { archived: true, startedAt: '2026-10-01T10:00:05.000Z' });
    const oldSid = await makeLaneSession('general', old.id, { startedAt: '2026-10-02T10:00:00.000Z' });
    const recentSid = await makeLaneSession('general', recent.id, { startedAt: '2026-10-10T03:00:00.000Z' });
    // A chat with no session at all has no transcript an ask could open.
    const bare = await makeChat('general', 'Cloud only');

    const report = await linkLaneAsks({ now: NOW });
    expect(report).toMatchObject({ created: 2, adopted: 0 });

    const oldTask = await getTask((await chatMeta('general', old.id))!.askTaskId!);
    expect(oldTask).toMatchObject({
      title: 'Glycine', project: 'Ask Walnut', walnut_agent: true, phase: 'COMPLETE',
      created_at: '2026-10-01T10:00:00.000Z', last_session_update: '2026-10-02T11:00:00.000Z',
      session_id: oldSid,
    });
    expect(oldTask.pinned).toBeFalsy();
    // One session per task: the ask holds the chat's current segment; the
    // older (archived) segment stays unlinked, listed as history.
    expect(oldTask.session_ids).toEqual([oldSid]);
    expect(oldTask.legacy_session_ids).toEqual([archivedSid]);
    expect((await getSessionByClaudeId(oldSid))?.taskId).toBe(oldTask.id);
    expect((await getSessionByClaudeId(archivedSid))?.taskId).toBeFalsy();

    const recentTask = await getTask((await chatMeta('general', recent.id))!.askTaskId!);
    expect(recentTask).toMatchObject({ phase: 'NEED_ACTION', session_id: recentSid });
    expect(recentTask.pinned).toBeFalsy();
    expect((await chatMeta('general', bare.id))?.askTaskId).toBeUndefined();

    // The Ask drawer's list: newest activity first, each naming its chat.
    const list = await computeAgentAsks({ agentId: 'general', limit: 200 });
    expect(list.asks.map((a) => a.title)).toEqual(['Dishwasher drain fault', 'Glycine']);
    expect(list.asks[0]).toMatchObject({ conversationId: recent.id, sessionId: recentSid, activityAt: '2026-10-10T17:30:00.000Z' });

    const again = await linkLaneAsks({ now: NOW });
    expect(again).toMatchObject({ created: 0, adopted: 0, linkedSessions: 0 });
    expect((await queryTasks({})).filter((t) => t.walnut_agent)).toHaveLength(2);
  });

  it('keeps the task a chat was promoted to, and only stamps it as an ask', async () => {
    const chat = await makeChat('general', 'Task Prioritization');
    const { task: promoted } = await addTask({ title: 'Daily scheduling', project: 'Planning', source: 'local' });
    await makeLaneSession('general', chat.id, { taskId: promoted.id });

    const report = await linkLaneAsks({ now: NOW });
    expect(report).toMatchObject({ created: 0, adopted: 1 });
    expect((await chatMeta('general', chat.id))?.askTaskId).toBe(promoted.id);
    const after = await getTask(promoted.id);
    expect(after).toMatchObject({ title: 'Daily scheduling', project: 'Planning', walnut_agent: true });
  });

  it('never mints again for a chat whose ask the user deleted', async () => {
    const chat = await makeChat('general', 'Aespa tickets', {
      createdAt: '2026-10-01T10:00:00.000Z', lastMessageAt: '2026-10-01T11:00:00.000Z',
    });
    const sid = await makeLaneSession('general', chat.id, { startedAt: '2026-10-01T10:30:00.000Z' });
    await linkLaneAsks({ now: NOW });
    const taskId = (await chatMeta('general', chat.id))!.askTaskId!;
    // The delete guard refuses a task whose session may be alive; the user's
    // delete stops it first, as this does.
    const { updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    await updateSessionRecord(sid, { process_status: 'stopped' });
    await deleteTask(taskId);

    const report = await linkLaneAsks({ now: NOW });
    expect(report).toMatchObject({ created: 0, dismissed: 1 });
    expect(await askTaskForLaneMint('general', chat.id, { create: true })).toBe('');
    expect((await queryTasks({})).filter((t) => t.walnut_agent)).toHaveLength(0);
  });

  it('a mint racing the pass ends with one ask for the chat', async () => {
    const chat = await makeChat('general', 'Race');
    await makeLaneSession('general', chat.id);
    const [minted] = await Promise.all([
      askTaskForLaneMint('general', chat.id, { create: true }),
      linkLaneAsks({ now: NOW }),
    ]);
    const meta = await chatMeta('general', chat.id);
    expect(meta?.askTaskId).toBe(minted);
    expect((await queryTasks({})).filter((t) => t.walnut_agent).map((t) => t.id)).toEqual([minted]);
  });

  // The phone persists the user's message (touching the chat) just before the
  // lane mints its session, so the session that answered a one-exchange chat
  // starts a second after the chat's last message (seen on real data).
  it('files a chat whose session started just after its last message', async () => {
    const chat = await makeChat('general', 'Frozen dumplings', {
      createdAt: '2026-10-09T10:00:00.000Z', lastMessageAt: '2026-10-09T10:00:00.000Z',
    });
    const sid = await makeLaneSession('general', chat.id, { startedAt: '2026-10-09T10:00:01.000Z' });
    const report = await linkLaneAsks({ now: NOW });
    expect(report).toMatchObject({ created: 1 });
    expect((await getTask((await chatMeta('general', chat.id))!.askTaskId!)).session_id).toBe(sid);
  });

  // A chat opened on the phone and never written in has a lane session (the
  // model pill warmed it) and nothing else. As an ask it was an empty row
  // ("Ask Walnut", the Mac opened an empty page); a dozen of them came from the
  // first pass. A fork is the exception: its session carries the copied chat.
  it('files no ask for a chat that never recorded a message, and removes one an older pass filed', async () => {
    const empty = await makeChat('general', 'New Conversation', undefined, 0);
    const warm = await makeLaneSession('general', empty.id);
    const fork = await makeChat('general', 'Fork of Glycine', undefined, 0);
    await makeLaneSession('general', fork.id, { forkedFrom: randomUUID() });
    expect(await linkLaneAsks({ now: NOW })).toMatchObject({ created: 1, unanswered: 1 });
    expect((await chatMeta('general', empty.id))?.askTaskId).toBeUndefined();
    expect((await chatMeta('general', fork.id))?.askTaskId).toBeTruthy();

    // What the first pass did: the empty chat filed with its warm session.
    const { task: junk } = await addTask({ title: 'Ask Walnut', project: 'Ask Walnut', source: 'local' });
    const { linkSession, updateTaskRaw } = await import('../../../src/core/task-manager.js');
    await updateTaskRaw(junk.id, { walnut_agent: true });
    await linkSession(junk.id, warm);
    const { linkSessionToTask, updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    await linkSessionToTask(warm, junk.id);
    await updateSessionRecord(warm, { process_status: 'stopped' });
    const { setConversationAskTask } = await import('../../../src/core/conversations.js');
    await setConversationAskTask('general', empty.id, junk.id);

    expect(await linkLaneAsks({ now: NOW })).toMatchObject({ removed: 1, created: 0 });
    await expect(getTask(junk.id)).rejects.toThrow();
    const after = await chatMeta('general', empty.id);
    expect(after).toBeTruthy();
    expect(after?.askTaskId).toBeUndefined();
    expect((await getSessionByClaudeId(warm))?.taskId).toBeFalsy();
    expect(await linkLaneAsks({ now: NOW })).toMatchObject({ removed: 0, created: 0 });

    // Unbound, not a tombstone: its first real message makes a fresh ask.
    await getOrCreateLaneSession('general', empty.id, { firstMessage: 'hello' });
    const fresh = (await chatMeta('general', empty.id))?.askTaskId;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(junk.id);
    expect((await getTask(fresh!)).session_id).toBe(warm);
  });

  // Seen live: a chat promoted to a work task long ago was opened on the phone;
  // its warm session became the task's main session (the Mac opened an empty
  // page) and moved the task to the top of both lists.
  // One session per task (src/core/sessions/one-session-per-task.ts): a warm
  // mint can no longer take over an ask that holds a session of its own, and
  // the chat's next real message becomes a new ask instead.
  it('never lets a warm session take over an ask with a session of its own', async () => {
    const chat = await makeChat('general', 'Burndown progress', {
      createdAt: '2026-09-20T10:00:00.000Z', lastMessageAt: '2026-09-23T07:50:00.000Z',
    });
    const { task } = await addTask({ title: 'Pipeline watch', project: 'Planning', source: 'local' });
    const { linkSession } = await import('../../../src/core/task-manager.js');
    const { linkSessionToTask, updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    await makeLaneSession('general', chat.id, { archived: true, startedAt: '2026-09-20T10:00:05.000Z' });
    const work = randomUUID();
    await createSessionRecord(work, task.id, 'Planning', WALNUT_HOME, { title: 'work', initialProcessStatus: 'idle' });
    await updateSessionRecord(work, { startedAt: '2026-09-23T07:00:00.000Z', process_status: 'stopped' });
    await linkSession(task.id, work);
    const { setConversationAskTask } = await import('../../../src/core/conversations.js');
    await setConversationAskTask('general', chat.id, task.id);
    // What the runner did before the fix (link the warm mint as main) is refused now.
    const warm = await makeLaneSession('general', chat.id, { startedAt: '2026-10-11T09:39:04.000Z' });
    await expect(linkSessionToTask(warm, task.id)).rejects.toMatchObject({ code: 'task_has_session' });
    await updateSessionRecord(warm, { process_status: 'stopped' });

    expect(await linkLaneAsks({ now: NOW })).toMatchObject({ released: 0, removed: 0, linkedSessions: 0 });
    const after = await getTask(task.id);
    expect(after.session_id).toBe(work);
    expect(after.session_ids).toEqual([work]);
    expect((await getSessionByClaudeId(warm))?.taskId).toBeFalsy();
    expect((await getSessionByClaudeId(work))?.taskId).toBe(task.id);

    // Talking in the chat again moves it on to a new ask; the old one keeps its work.
    await getOrCreateLaneSession('general', chat.id, { firstMessage: 'any update?' });
    const nextAsk = (await chatMeta('general', chat.id))?.askTaskId;
    expect(nextAsk).toBeTruthy();
    expect(nextAsk).not.toBe(task.id);
    expect((await getTask(nextAsk!)).session_id).toBe(warm);
    expect((await getTask(task.id)).session_id).toBe(work);
  });

  // History older than the chat's lane lives in the chat store, so its only lane
  // session is one opened later. That session is where its next turn goes: the
  // ask keeps it (taking it back would take the chat off the Mac's list).
  it('keeps an older chat whose only lane session came after its history', async () => {
    const chat = await makeChat('general', 'Eye exam notes', {
      createdAt: '2026-08-28T00:00:00.000Z', lastMessageAt: '2026-08-28T01:17:00.000Z',
    }, 12);
    const sid = await makeLaneSession('general', chat.id, { startedAt: '2026-08-28T03:44:00.000Z' });
    expect(await linkLaneAsks({ now: NOW })).toMatchObject({ created: 1 });
    const askId = (await chatMeta('general', chat.id))!.askTaskId!;
    expect((await getTask(askId)).session_id).toBe(sid);
    expect(await linkLaneAsks({ now: NOW })).toMatchObject({ released: 0, removed: 0, created: 0 });
    expect((await getTask(askId)).session_id).toBe(sid);
  });
});

describe('the chat and its ask stay in step', () => {
  async function boundChat(title: string, agentId = 'general') {
    const chat = await makeChat(agentId, title);
    await getOrCreateLaneSession(agentId, chat.id, { firstMessage: 'hi' });
    const taskId = (await chatMeta(agentId, chat.id))!.askTaskId!;
    return { chat, taskId };
  }

  it('deleting the chat deletes its ask', async () => {
    const { chat, taskId } = await boundChat('Delete me');
    await deleteConversation('general', chat.id);
    await settle();
    await expect(getTask(taskId)).rejects.toThrow(/No task found/);
  });

  it("the person's delete of the ask deletes its chat; bookkeeping deletes do not", async () => {
    const stop = startLaneAskSync();
    try {
      const { chat, taskId } = await boundChat('Delete the ask');
      const { task } = await deleteTask(taskId);
      // A merge or a sync plugin's mirrored delete is bookkeeping: the chat stays.
      bus.emit(EventNames.TASK_DELETED, { id: task.id, task }, ['web-ui'], { source: 'merge' });
      await settle();
      expect(await chatMeta('general', chat.id)).toBeDefined();
      // The person's delete (the console's route) takes the chat with it.
      bus.emit(EventNames.TASK_DELETED, { id: task.id, task }, ['web-ui'], { source: 'api' });
      await settle();
      expect(await chatMeta('general', chat.id)).toBeUndefined();
    } finally {
      stop();
    }
  });

  it("an ask still named after its project never names the chat, so the chat's titler still can", async () => {
    const stop = startLaneAskSync();
    try {
      const { chat, taskId } = await boundChat('New Conversation');
      const task = await getTask(taskId);
      expect(task.title).toBe('Ask Walnut');
      // The runner's update when the CLI starts carries the placeholder.
      bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-runner' });
      await settle();
      const meta = await chatMeta('general', chat.id);
      expect(meta?.title).toBe('New Conversation');
      expect(meta?.titleAutoGenerated).toBeFalsy();
      // The chat's first message names it, and the ask follows.
      await touchLaneConversation('general', chat.id, 'Why does the dishwasher not drain');
      await settle();
      expect((await getTask(taskId)).title).toBe('Why does the dishwasher not drain');
    } finally {
      stop();
    }
  });

  it('a chat title arriving after the ask was made names the ask', async () => {
    const { chat, taskId } = await boundChat('New Conversation');
    expect((await getTask(taskId)).title).toBe('Ask Walnut');
    await touchLaneConversation('general', chat.id, 'Dishwasher E24 error');
    await settle();
    expect((await getTask(taskId)).title).toBe('Dishwasher E24 error');
    await renameConversation('general', chat.id, 'Bosch E:24 drain', { auto: true });
    await settle();
    expect((await getTask(taskId)).title).toBe('Bosch E:24 drain');
  });

  it('renaming the ask renames the chat, and an auto title never overrides that name', async () => {
    const stop = startLaneAskSync();
    try {
      const { chat, taskId } = await boundChat('First title');
      const { task } = await updateTask(taskId, { title: 'My own name' });
      bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'test' });
      await settle();
      expect((await chatMeta('general', chat.id))?.title).toBe('My own name');

      await renameConversation('general', chat.id, 'Auto title', { auto: true });
      await settle(300);
      expect((await getTask(taskId)).title).toBe('My own name');
      expect((await chatMeta('general', chat.id))?.title).toBe('My own name');

      // The user renaming the CHAT is the user's word: the ask follows.
      await renameConversation('general', chat.id, 'Renamed on the phone');
      await settle();
      expect((await getTask(taskId)).title).toBe('Renamed on the phone');
    } finally {
      stop();
    }
  });
});
