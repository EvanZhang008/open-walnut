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

/** A chat as the phone leaves it: an index row with its own dates. */
async function makeChat(agentId: string, title: string, dates?: { createdAt: string; lastMessageAt: string }) {
  const meta = await createConversation(agentId, title);
  if (dates) {
    const file = conversationIndexFile(agentId);
    const index = JSON.parse(await fsp.readFile(file, 'utf-8')) as ConversationIndex;
    const row = index.conversations.find((c) => c.id === meta.id)!;
    row.createdAt = dates.createdAt;
    row.lastMessageAt = dates.lastMessageAt;
    await fsp.writeFile(file, JSON.stringify(index));
  }
  return meta;
}

/** A lane session the chat already had (minted before asks existed). */
async function makeLaneSession(agentId: string, conversationId: string, opts: { taskId?: string; archived?: boolean } = {}) {
  const sid = randomUUID();
  await createSessionRecord(sid, opts.taskId ?? '', '', WALNUT_HOME, {
    title: 'Main AI chat',
    lane: personalAiLaneKey(agentId, conversationId),
    initialProcessStatus: 'idle',
  });
  if (opts.archived) {
    const { updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    await updateSessionRecord(sid, { archived: true, archive_reason: 'test' });
  }
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
    const archivedSid = await makeLaneSession('general', old.id, { archived: true });
    const oldSid = await makeLaneSession('general', old.id);
    const recentSid = await makeLaneSession('general', recent.id);
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
    expect(oldTask.session_ids).toEqual([archivedSid, oldSid]);
    for (const sid of [archivedSid, oldSid]) {
      expect((await getSessionByClaudeId(sid))?.taskId).toBe(oldTask.id);
    }

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
    const sid = await makeLaneSession('general', chat.id);
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
