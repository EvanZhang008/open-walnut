/**
 * An answer to a request owes its delivery in the same write as its settle (SessionRequest.outbox),
 * and a server that died before the answer reached the asker's queue delivers it at its next start
 * (src/core/sessions/reply-outbox.ts).
 *
 * Before 2026-11-14 the settle (session-requests.json), the replier's result (tasks.sqlite) and the
 * delivery (the asker's queue) were three writes: a death after the first left the request
 * "replied", so nothing ever told the asker, and the answer was lost. The crash below is the disk
 * as it was when the delivery started: the settled row, and nothing in the queue.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reply-outbox'));

let sessions: Array<Record<string, unknown>> = [];
vi.mock('../../../src/core/session-tracker.js', () => ({
  listSessions: async () => sessions,
  getSessionByClaudeId: async (sid: string) => sessions.find((s) => s.claudeSessionId === sid) ?? null,
  getSessionsForTask: async (taskId: string) => sessions.filter((s) => s.taskId === taskId),
  isEnvironmentSession: () => false,
  isListableSession: (s: { lane?: string }) => !s.lane,
}));

let tasks: Array<{ id: string; title: string; phase?: string }> = [];
vi.mock('../../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => { const t = tasks.find((x) => x.id === id); if (!t) throw new Error(`No task found: ${id}`); return t; },
  listTasks: async () => tasks,
  listTasksByIds: async (ids: string[]) => tasks.filter((t) => ids.includes(t.id)),
}));

const sendMessageToSession = vi.fn();
/** The rows in any session's queue, and the rows that went out as a written line. */
let queued = new Set<string>();
let settledLines = new Map<string, string>();
vi.mock('../../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: (...args: unknown[]) => sendMessageToSession(...args),
  enqueueMessage: vi.fn(),
  getQueue: async () => [],
  findQueuedMessage: async (id: string) => (queued.has(id) ? { id } : null),
}));
vi.mock('../../../src/core/session-queue-lines.js', () => ({
  settledLineUuid: async (id: string) => settledLines.get(id),
}));

import { performSessionSend } from '../../../src/core/sessions/session-send-core.js';
import { OWED_MAX_TRIES, redeliverOwedReplies, replyInFlight } from '../../../src/core/sessions/reply-outbox.js';
import { REQUESTS_FILE, createSessionRequest, getSessionRequest } from '../../../src/core/session-requests.js';

const ASKER = 'sess-asker-1';
const TARGET = 'sess-target-1';
const NOW = new Date().toISOString();
const rec = (claudeSessionId: string, title: string, taskId: string) => ({
  claudeSessionId, title, taskId, project: '', process_status: 'idle', mode: 'default', provider: 'cli',
  startedAt: NOW, lastActiveAt: NOW, messageCount: 0,
});
const ask = () => createSessionRequest({ fromSessionId: ASKER, toSessionId: TARGET, text: 'count the rows' });
/** A pass after the server came back (the result note is checked on its own below). */
const later = { noteReport: async () => {} };

beforeEach(() => {
  fs.rmSync(REQUESTS_FILE, { force: true });
  sessions = [rec(ASKER, 'Asker', 'task-asker'), rec(TARGET, 'Target', 'task-target')];
  tasks = [{ id: 'task-asker', title: 'Asker', phase: 'IN_PROGRESS' }, { id: 'task-target', title: 'Target', phase: 'IN_PROGRESS' }];
  queued = new Set();
  settledLines = new Map();
  sendMessageToSession.mockReset();
  sendMessageToSession.mockImplementation(async (_sid: string, _text: string, opts: { messageId?: string }) => ({ id: opts.messageId ?? 'qm-x' }));
});

describe('an answer owes its delivery in the settle\'s own write', () => {
  it('the settled row carries the delivery it owes, and is cleared once delivered', async () => {
    const rq = await ask();
    let atDelivery: Awaited<ReturnType<typeof getSessionRequest>> = null;
    let sentAs: { text: string; opts: Record<string, unknown> } | undefined;
    sendMessageToSession.mockImplementation(async (_sid: string, text: string, opts: Record<string, unknown>) => {
      atDelivery = await getSessionRequest(rq.id);
      sentAs = { text, opts };
      return { id: opts.messageId };
    });
    const result = await performSessionSend({ text: 'Done: 412 rows moved.', inReplyTo: rq.id, callerSid: TARGET });

    expect(atDelivery!.status).toBe('replied');
    expect(atDelivery!.outbox).toMatchObject({
      to: ASKER, taskId: 'task-asker', busText: 'Done: 412 rows moved.', source: 'peer',
      messageId: sentAs!.opts.messageId, enqueueText: sentAs!.opts.enqueueMessage,
    });
    expect(result.messageId).toBe(sentAs!.opts.messageId);
    expect((await getSessionRequest(rq.id))?.outbox).toBeUndefined();
  });

  it('a delivery that fails in front of the replier owes nothing: the replier sends again', async () => {
    const rq = await ask();
    sendMessageToSession.mockRejectedValue(new Error('queue write failed'));
    await expect(performSessionSend({ text: 'done', inReplyTo: rq.id, callerSid: TARGET })).rejects.toThrow();
    const row = await getSessionRequest(rq.id);
    expect(row?.status).toBe('replied');
    expect(row?.outbox).toBeUndefined();
  });
});

describe('a server that died between the settle and the queue delivers the answer when it is back', () => {
  /** Answers rq, and leaves the request store as the disk held it when the delivery began (the crash). */
  async function answerAndDie(text: string): Promise<{ id: string; messageId: string; enqueueText: string }> {
    const rq = await ask();
    let disk = '';
    let sent: Record<string, unknown> = {};
    sendMessageToSession.mockImplementationOnce(async (_sid: string, _t: string, opts: Record<string, unknown>) => {
      disk = fs.readFileSync(REQUESTS_FILE, 'utf8');
      sent = opts;
      return { id: opts.messageId };
    });
    await performSessionSend({ text, inReplyTo: rq.id, callerSid: TARGET });
    fs.writeFileSync(REQUESTS_FILE, disk);
    sendMessageToSession.mockClear();
    return { id: rq.id, messageId: String(sent.messageId), enqueueText: String(sent.enqueueMessage) };
  }

  it('the owed answer goes to the asker with the same row id and words, then is cleared', async () => {
    const died = await answerAndDie('Done: 412 rows moved.');
    expect((await getSessionRequest(died.id))?.outbox?.messageId).toBe(died.messageId);

    expect(await redeliverOwedReplies(later)).toBe(1);
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    const [sid, busText, opts] = sendMessageToSession.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(sid).toBe(ASKER);
    expect(busText).toBe('Done: 412 rows moved.');
    expect(opts).toMatchObject({ messageId: died.messageId, enqueueMessage: died.enqueueText, source: 'peer', endsWait: true });
    const row = await getSessionRequest(died.id);
    expect(row?.outbox).toBeUndefined();
    expect(row?.status).toBe('replied');
    // A second pass has nothing owed.
    expect(await redeliverOwedReplies(later)).toBe(0);
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['still queued (in any session: a row moves with its session)', (id: string) => { queued.add(id); }],
    ['already gone out as a written line', (id: string) => { settledLines.set(id, 'line-uuid'); }],
  ])('one that reached the queue before the death is not delivered again: %s', async (_how, reached) => {
    const died = await answerAndDie('done');
    reached(died.messageId);
    expect(await redeliverOwedReplies(later)).toBe(0);
    expect(sendMessageToSession).not.toHaveBeenCalled();
    expect((await getSessionRequest(died.id))?.outbox).toBeUndefined();
  });

  it('an answer this server is still delivering is left to its own call', async () => {
    const died = await answerAndDie('done');
    const release = replyInFlight(died.id);
    try {
      expect(await redeliverOwedReplies(later)).toBe(0);
      expect(sendMessageToSession).not.toHaveBeenCalled();
      expect((await getSessionRequest(died.id))?.outbox).toBeDefined();
    } finally { release(); }
    expect(await redeliverOwedReplies(later)).toBe(1);
  });

  it('a replier that sends the answer again after the death delivers it once, as the owed row', async () => {
    const died = await answerAndDie('Done: 412 rows moved.');
    await performSessionSend({ text: 'Done: 412 rows moved.', inReplyTo: died.id, callerSid: TARGET });
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    expect((sendMessageToSession.mock.calls[0][2] as { messageId?: string }).messageId).toBe(died.messageId);
    expect((await getSessionRequest(died.id))?.outbox).toBeUndefined();
    expect(await redeliverOwedReplies(later)).toBe(0);
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
  });

  it('the owed answer goes where the asker reads now, never back to the replier', async () => {
    const died = await answerAndDie('done');
    // The asker carried on in a new session of its task; the old one is no longer live.
    sessions = sessions.map((s) => s.claudeSessionId === ASKER ? { ...s, process_status: 'stopped', archived: true } : s);
    sessions.push(rec('sess-asker-2', 'Asker', 'task-asker'));
    await redeliverOwedReplies(later);
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    expect(sendMessageToSession.mock.calls[0][0]).toBe('sess-asker-2');
  });

  it('the result is noted on the replier\'s task with the answer', async () => {
    const died = await answerAndDie('done');
    const noted: string[] = [];
    await redeliverOwedReplies({ ...later, noteReport: async (req, owed) => { noted.push(`${req.id} ${owed.report?.taskId} ${owed.report?.head.request_id}`); } });
    expect(noted).toEqual([`${died.id} task-target ${died.id}`]);
  });

  it('a delivery that keeps failing is tried again, then given up', async () => {
    const died = await answerAndDie('done');
    sendMessageToSession.mockRejectedValue(new Error('queue write failed'));
    for (let i = 0; i < OWED_MAX_TRIES; i++) await redeliverOwedReplies(later);
    expect(sendMessageToSession).toHaveBeenCalledTimes(OWED_MAX_TRIES);
    expect((await getSessionRequest(died.id))?.outbox?.tries).toBe(OWED_MAX_TRIES);
    await redeliverOwedReplies(later);
    expect(sendMessageToSession).toHaveBeenCalledTimes(OWED_MAX_TRIES);
    expect((await getSessionRequest(died.id))?.outbox).toBeUndefined();
  });

  it('an asker that is gone is dropped, not retried', async () => {
    const died = await answerAndDie('done');
    sessions = sessions.filter((s) => s.claudeSessionId !== ASKER);
    expect(await redeliverOwedReplies(later)).toBe(0);
    expect(sendMessageToSession).not.toHaveBeenCalled();
    expect((await getSessionRequest(died.id))?.outbox).toBeUndefined();
  });

});
