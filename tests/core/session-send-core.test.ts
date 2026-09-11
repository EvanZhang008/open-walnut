/**
 * Unit pins for the one send entry point (core/sessions/session-send-core.ts).
 *
 * Three behaviors carry real blast radius, so each has its own group below:
 *
 *  1. Target resolution is a LADDER (exact id → task handle → id prefix → title
 *     substring) whose whole point is that an ambiguous handle is refused rather
 *     than guessed. A confident wrong answer here delivers someone's message to
 *     the wrong CLI, so every rung asserts both the hit and the refusal shape.
 *  2. Who is speaking decides whether the text is WRAPPED and throttled. The
 *     human's own words go through verbatim; a session's (or an unidentified
 *     process's) words ride in a `<walnut-message kind="peer-note">` envelope,
 *     whose body escaping is what stops text from forging "your user says…"
 *     inside another session's stdin.
 *  3. The expect_reply / in_reply_to loop settles the ledger row BEFORE it
 *     delivers anything, and only the request's target may close it.
 *
 * Collaborators are mocked at their module seams (session registry, task
 * lookup, durable queue); the request ledger is the REAL one against a temp
 * WALNUT_HOME, so the settle-then-deliver order can be observed on disk.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-send-core'));

const listSessions = vi.fn();
const getSessionByClaudeId = vi.fn();
const getSessionsForTask = vi.fn();
vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: (...args: unknown[]) => listSessions(...args),
  getSessionByClaudeId: (...args: unknown[]) => getSessionByClaudeId(...args),
  getSessionsForTask: (...args: unknown[]) => getSessionsForTask(...args),
  isEnvironmentSession: (s: { type?: string }) => s.type === 'triage' || s.type === 'hook' || s.type === 'cron',
  // Reply routing (reply-routing.ts) filters candidate destinations with this.
  isListableSession: (s: { lane?: string; type?: string }) =>
    !s.lane && s.type !== 'triage' && s.type !== 'hook' && s.type !== 'cron',
}));

const getTask = vi.fn();
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: (...args: unknown[]) => getTask(...args),
}));

const sendMessageToSession = vi.fn();
const enqueueMessage = vi.fn();
const getQueue = vi.fn();
vi.mock('../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: (...args: unknown[]) => sendMessageToSession(...args),
  enqueueMessage: (...args: unknown[]) => enqueueMessage(...args),
  getQueue: (...args: unknown[]) => getQueue(...args),
}));

import {
  SendError,
  performSessionSend,
  resolveCaller,
  resolveSendTarget,
} from '../../src/core/sessions/session-send-core.js';
import { PEER_PENDING_CAP } from '../../src/core/peers/peer-throttle.js';
import { parseWalnutMessage } from '../../src/core/peers/walnut-message-tag.js';
import { REQUESTS_FILE, getSessionRequest, settleNotified } from '../../src/core/session-requests.js';
import type { SessionRecord } from '../../src/core/types.js';

const NOW = new Date().toISOString();

function rec(claudeSessionId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId,
    taskId: '',
    project: '',
    process_status: 'idle',
    mode: 'default',
    provider: 'cli',
    startedAt: NOW,
    lastActiveAt: NOW,
    messageCount: 0,
    ...overrides,
  } as SessionRecord;
}

/** The in-memory session registry every mocked tracker call reads. */
let sessions: SessionRecord[] = [];
/** Tasks the stand-in getTask can resolve (same contract as the real one). */
let tasks: Array<{ id: string; title: string }> = [];

/** Grabs the (sid, busText, opts) of the Nth sendMessageToSession call. */
function dispatched(n = 0): { sid: string; busText: string; opts: Record<string, unknown> } {
  const [sid, busText, opts] = sendMessageToSession.mock.calls[n] as [string, string, Record<string, unknown>];
  return { sid, busText, opts: opts ?? {} };
}

/** What the CLI actually reads: the enqueue text, or the bus text when equal. */
function deliveredText(n = 0): string {
  const { busText, opts } = dispatched(n);
  return (opts.enqueueMessage as string | undefined) ?? busText;
}

async function expectSendError(
  p: Promise<unknown>,
  code: string,
  statusCode?: number,
): Promise<SendError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected SendError(${code})`).toBeInstanceOf(SendError);
  const sendErr = err as SendError;
  expect(sendErr.code).toBe(code);
  if (statusCode !== undefined) expect(sendErr.statusCode).toBe(statusCode);
  return sendErr;
}

beforeEach(() => {
  fs.rmSync(REQUESTS_FILE, { force: true });
  sessions = [];
  tasks = [];
  listSessions.mockReset();
  getSessionByClaudeId.mockReset();
  getSessionsForTask.mockReset();
  getTask.mockReset();
  sendMessageToSession.mockReset();
  enqueueMessage.mockReset();
  getQueue.mockReset();

  listSessions.mockImplementation(async () => sessions);
  getSessionByClaudeId.mockImplementation(async (sid: string) =>
    sessions.find((s) => s.claudeSessionId === sid) ?? null);
  getSessionsForTask.mockImplementation(async (taskId: string) =>
    sessions.filter((s) => s.taskId === taskId));
  // Same contract as the real getTask: exact id, else unique prefix, else throw.
  getTask.mockImplementation(async (handle: string) => {
    const hits = tasks.filter((t) => t.id === handle || t.id.startsWith(handle));
    if (hits.length === 0) throw new Error(`No task found: ${handle}`);
    if (hits.length > 1 && !tasks.some((t) => t.id === handle)) {
      throw new Error(`Ambiguous ID prefix "${handle}" matches ${hits.length} tasks`);
    }
    return hits.find((t) => t.id === handle) ?? hits[0];
  });
  sendMessageToSession.mockResolvedValue({ id: 'qm-dispatched' });
  enqueueMessage.mockResolvedValue({ id: 'qm-parked' });
  getQueue.mockResolvedValue([]);
});

describe('resolveSendTarget — the handle ladder', () => {
  it('takes an exact session id first', async () => {
    sessions = [rec('sess-aaaa-1111'), rec('sess-bbbb-2222')];

    const resolved = await resolveSendTarget('sess-aaaa-1111');
    expect(resolved.session.claudeSessionId).toBe('sess-aaaa-1111');
    expect(resolved.taskId).toBeUndefined();
    // An exact id never consults the task store.
    expect(getTask).not.toHaveBeenCalled();
  });

  it('accepts a unique session-id prefix of at least 4 characters', async () => {
    sessions = [rec('sess-aaaa-1111'), rec('other-bbbb-2222')];

    const resolved = await resolveSendTarget('sess');
    expect(resolved.session.claudeSessionId).toBe('sess-aaaa-1111');
  });

  it('refuses an ambiguous prefix instead of picking one', async () => {
    sessions = [
      rec('sess-aaaa-1111', { title: 'Alpha', host: 'devbox' }),
      rec('sess-bbbb-2222', { title: 'Beta' }),
    ];

    const err = await expectSendError(resolveSendTarget('sess'), 'ambiguous_target', 400);
    const candidates = err.detail?.candidates as Array<{ shortId: string; title: string | null; host: string }>;
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.shortId)).toEqual(['sess-aaa', 'sess-bbb']);
    // A record with no host is labeled 'local', not left blank.
    expect(candidates[1].host).toBe('local');
  });

  it('resolves a task handle to its live session and carries the task id', async () => {
    tasks = [{ id: 'task-1234abcd', title: 'Run the migration' }];
    sessions = [
      rec('sess-task-1', { taskId: 'task-1234abcd', lastActiveAt: '2026-08-01T00:00:00Z' }),
      rec('sess-task-2', { taskId: 'task-1234abcd', lastActiveAt: '2026-08-20T00:00:00Z' }),
    ];

    const resolved = await resolveSendTarget('task-1234abcd');
    // Two live rows for one task → the most recently active wins.
    expect(resolved.session.claudeSessionId).toBe('sess-task-2');
    expect(resolved.taskId).toBe('task-1234abcd');
  });

  it('409s a task that exists but has no live session, naming the task', async () => {
    tasks = [{ id: 'task-1234abcd', title: 'Run the migration' }];
    sessions = [rec('sess-unrelated', { taskId: 'task-other' })];

    const err = await expectSendError(resolveSendTarget('task-1234abcd'), 'task_has_no_session', 409);
    expect(err.detail).toEqual({ taskId: 'task-1234abcd' });
    expect(err.message).toContain('session_start');
  });

  it('treats an archived session as no session for a task handle', async () => {
    tasks = [{ id: 'task-1234abcd', title: 'Run the migration' }];
    sessions = [rec('sess-task-1', { taskId: 'task-1234abcd', archived: true })];

    await expectSendError(resolveSendTarget('task-1234abcd'), 'task_has_no_session', 409);
  });

  it('propagates an ambiguous task prefix as ambiguous_target', async () => {
    tasks = [{ id: 'task-1111', title: 'One' }, { id: 'task-2222', title: 'Two' }];

    const err = await expectSendError(resolveSendTarget('task-'), 'ambiguous_target', 400);
    expect(err.message).toContain('Ambiguous ID prefix');
  });

  it('accepts a unique case-insensitive title substring', async () => {
    sessions = [
      rec('sess-aaaa-1111', { title: 'Migration Worker' }),
      rec('sess-bbbb-2222', { title: 'Docs cleanup' }),
    ];

    const resolved = await resolveSendTarget('migration');
    expect(resolved.session.claudeSessionId).toBe('sess-aaaa-1111');
  });

  it('refuses an ambiguous title substring', async () => {
    sessions = [
      rec('sess-aaaa-1111', { title: 'Migration worker A' }),
      rec('sess-bbbb-2222', { title: 'Migration worker B' }),
    ];

    const err = await expectSendError(resolveSendTarget('migration'), 'ambiguous_target', 400);
    expect((err.detail?.candidates as unknown[])).toHaveLength(2);
  });

  it('404s a handle that matches nothing', async () => {
    sessions = [rec('sess-aaaa-1111', { title: 'Migration worker' })];

    const err = await expectSendError(resolveSendTarget('nothing-like-this'), 'unknown_target', 404);
    expect(err.message).toContain('nothing-like-this');
  });
});

describe('resolveSendTarget: the printed `Title [8hex]` handle', () => {
  const SID = '9f3a2c1d-4b7e-4c1a-9d2e-0f1a2b3c4d5e';

  beforeEach(() => {
    sessions = [
      rec(SID, { title: 'Fix auth fixture' }),
      rec('bbbb1111-2222-3333', { title: 'Docs cleanup' }),
    ];
  });

  it('accepts the handle exactly as an envelope printed it', async () => {
    const resolved = await resolveSendTarget('Fix auth fixture [9f3a2c1d]');
    expect(resolved.session.claudeSessionId).toBe(SID);
  });

  it('accepts a bare bracketed prefix, and tolerates trailing spaces', async () => {
    expect((await resolveSendTarget('[9f3a2c1d]')).session.claudeSessionId).toBe(SID);
    expect((await resolveSendTarget('[9f3a]')).session.claudeSessionId).toBe(SID);
    expect((await resolveSendTarget('Fix auth fixture [9f3a]   ')).session.claudeSessionId).toBe(SID);
  });

  it('never consults tasks or titles for a bracketed handle', async () => {
    tasks = [{ id: '9f3a2c1d', title: 'A task whose id looks like the hex' }];

    const resolved = await resolveSendTarget('Fix auth fixture [9f3a2c1d]');
    expect(resolved.session.claudeSessionId).toBe(SID);
    // The bracketed hex IS a session id, so the task store is never asked and
    // the printed title never becomes a substring search of its own.
    expect(resolved.taskId).toBeUndefined();
    expect(getTask).not.toHaveBeenCalled();
  });

  it('refuses a bracketed prefix that matches two sessions', async () => {
    sessions.push(rec('9f3a2c1d-9999-8888', { title: 'Other session, same prefix' }));

    const err = await expectSendError(
      resolveSendTarget('Fix auth fixture [9f3a]'), 'ambiguous_target', 400);
    expect((err.detail?.candidates as unknown[])).toHaveLength(2);
  });

  it('404s a bracketed handle nothing matches', async () => {
    await expectSendError(resolveSendTarget('Gone session [deadbeef]'), 'unknown_target', 404);
  });

  it('falls through to the title ladder when a bracketed hex WORD names no session', async () => {
    sessions = [rec('cccc1111-2222', { title: 'css [fade] transitions' })];
    // "fade" is all hex letters, but no session id starts with it: the brackets
    // belong to the title, so a title match must still win over a hard 404.
    const resolved = await resolveSendTarget('css [fade]');
    expect(resolved.session.claudeSessionId).toBe('cccc1111-2222');
  });

  it('accepts a printed handle for a provider-issued (non-hex) session id', async () => {
    sessions = [rec('sess-tar-provider-issued', { title: 'ACP session' })];
    const resolved = await resolveSendTarget('ACP session [sess-tar]');
    expect(resolved.session.claudeSessionId).toBe('sess-tar-provider-issued');
  });

  it('leaves a title that merely CONTAINS brackets to the title ladder', async () => {
    sessions = [rec('cccc1111-2222', { title: 'Report [draft] cleanup' })];
    // Not a handle: the bracket content is not hex at the end of the string.
    const resolved = await resolveSendTarget('report [draft]');
    expect(resolved.session.claudeSessionId).toBe('cccc1111-2222');
  });
});

describe('resolveCaller', () => {
  it('classifies no sid as the human, a tracked sid as that session, anything else as external', async () => {
    sessions = [rec('sess-caller-1', { title: 'Caller' })];

    expect(await resolveCaller(undefined)).toEqual({ kind: 'human' });
    expect(await resolveCaller('   ')).toEqual({ kind: 'human' });

    const asSession = await resolveCaller('sess-caller-1');
    expect(asSession.kind).toBe('session');
    expect(asSession.kind === 'session' && asSession.record.title).toBe('Caller');

    expect(await resolveCaller('external')).toEqual({ kind: 'external' });
    expect(await resolveCaller('sess-not-tracked')).toEqual({ kind: 'external' });
  });
});

describe('performSessionSend — who is speaking decides the envelope', () => {
  it('delivers the human own words BARE and untouched by the throttle', async () => {
    sessions = [rec('sess-target-1', { title: 'Target' })];

    const result = await performSessionSend({ to: 'sess-target-1', text: '  do the thing  ' });

    expect(result).toEqual({
      delivery: 'queued',
      targetSessionId: 'sess-target-1',
      targetTitle: 'Target',
      // The resolved target in the shape `to` accepts back.
      target: { handle: 'Target [sess-tar]', sessionId: 'sess-target-1' },
      messageId: 'qm-dispatched',
    });
    const { sid, busText, opts } = dispatched();
    expect(sid).toBe('sess-target-1');
    expect(busText).toBe('do the thing');
    expect(opts.source).toBe('cli');
    // No separate enqueue text = nothing was wrapped around the human words.
    expect(opts.enqueueMessage).toBeUndefined();
    // The human path never consults the peer queue-depth cap.
    expect(getQueue).not.toHaveBeenCalled();
  });

  it('wraps a session caller words and names the sender from its own record', async () => {
    sessions = [
      rec('sess-caller-1', { title: 'Migration worker', host: 'devbox', taskId: 'task-11' }),
      rec('sess-target-1', { title: 'Target', taskId: 'task-77' }),
    ];

    const result = await performSessionSend({
      to: 'sess-target-1', text: 'rows are migrated', callerSid: 'sess-caller-1', expectReply: false,
    });

    expect(result.targetTaskId).toBe('task-77');
    expect(result.target).toEqual({
      handle: 'Target [sess-tar]', sessionId: 'sess-target-1', taskId: 'task-77',
    });
    const { busText, opts } = dispatched();
    // The bus still carries the raw text; only the CLI-bound copy is wrapped.
    expect(busText).toBe('rows are migrated');
    expect(opts.source).toBe('peer');
    const parsed = parseWalnutMessage(opts.enqueueMessage as string)!;
    expect(parsed.kind).toBe('peer-note');
    expect(parsed.attrs.from).toBe('Migration worker [sess-cal]');
    expect(parsed.attrs['from-session']).toBe('sess-caller-1');
    expect(parsed.attrs['from-task']).toBe('task-11');
    expect(parsed.attrs.host).toBe('devbox');
    expect(parsed.body).toBe('rows are migrated');
  });

  it('labels an anonymous caller by its transport host, and says unknown without one', async () => {
    sessions = [rec('sess-target-1', { title: 'Target' })];

    await performSessionSend({
      to: 'sess-target-1', text: 'from a script', callerSid: 'external', callerHost: 'devbox',
    });
    const withHost = parseWalnutMessage(deliveredText(0))!;
    expect(withHost.attrs).toMatchObject({
      from: 'unidentified process', host: 'devbox', anonymous: 'true',
    });
    // No tracked session behind it, so no id is printed for one.
    expect(withHost.attrs['from-session']).toBeUndefined();

    await performSessionSend({
      to: 'sess-target-1', text: 'from another script', callerSid: 'external',
    });
    expect(parseWalnutMessage(deliveredText(1))!.attrs.host).toBe('unknown');
  });

  it('refuses a send that resolves to the calling session itself', async () => {
    sessions = [rec('sess-caller-1', { title: 'Caller' })];

    await expectSendError(
      performSessionSend({ to: 'sess-caller-1', text: 'talking to myself', callerSid: 'sess-caller-1' }),
      'self_send', 400,
    );
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it('refuses an archived target', async () => {
    sessions = [rec('sess-target-1', { title: 'Target', archived: true })];

    const err = await expectSendError(
      performSessionSend({ to: 'sess-target-1', text: 'hello' }), 'target_archived', 409);
    expect(err.message).toContain('sess-tar');
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it('refuses a peer send when the target queue is already at the cap', async () => {
    sessions = [
      rec('sess-caller-2', { title: 'Caller' }),
      rec('sess-target-1', { title: 'Target' }),
    ];
    getQueue.mockResolvedValue(new Array(PEER_PENDING_CAP).fill({ id: 'qm-x' }));

    const err = await expectSendError(
      performSessionSend({ to: 'sess-target-1', text: 'one more', callerSid: 'sess-caller-2' }),
      'queue_full', 429,
    );
    expect(err.message).toContain(String(PEER_PENDING_CAP));
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it('refuses a throttled peer send and says how long to wait', async () => {
    sessions = [
      rec('sess-caller-3', { title: 'Caller' }),
      rec('sess-target-1', { title: 'Target' }),
    ];

    await performSessionSend({ to: 'sess-target-1', text: 'identical note', callerSid: 'sess-caller-3' });
    // Same sender + same target + same text inside the dup window.
    const err = await expectSendError(
      performSessionSend({ to: 'sess-target-1', text: 'identical note', callerSid: 'sess-caller-3' }),
      'throttled', 429,
    );
    expect(err.detail?.retryAfterMs).toBeTypeOf('number');
    expect(err.detail?.retryAfterMs as number).toBeGreaterThan(0);
    expect(err.message).toContain('do not retry in a loop');
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
  });
});

describe('performSessionSend — expect_reply', () => {
  it('rejects expect_reply from the human: there is no session to route an answer to', async () => {
    sessions = [rec('sess-target-1', { title: 'Target' })];

    const err = await expectSendError(
      performSessionSend({ to: 'sess-target-1', text: 'answer me', expectReply: true }),
      'bad_request', 400,
    );
    expect(err.message).toContain('expect_reply needs a session caller');
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  // The default flipped ON 2026-09-01: a session that asks another session
  // something almost always wants the answer, and every forgotten flag used to
  // drop it silently. These three pin the tri-state so the default can't
  // regress to opt-in, and so it can't start 400-ing the human's own CLI.
  it('DEFAULTS to registering a request when a session caller omits the flag', async () => {
    sessions = [
      rec('sess-caller-4', { title: 'Asker', host: 'devbox' }),
      rec('sess-target-1', { title: 'Target', taskId: 'task-77' }),
    ];

    const result = await performSessionSend({
      to: 'sess-target-1', text: 'no flag passed', callerSid: 'sess-caller-4',
    });

    expect(result.requestId).toMatch(/^rq-[a-f0-9]{12}$/);
    await expect(getSessionRequest(result.requestId!)).resolves.toMatchObject({
      status: 'pending', fromSessionId: 'sess-caller-4', toSessionId: 'sess-target-1',
    });
    expect(deliveredText()).toContain(`request="${result.requestId}"`);
    expect(deliveredText()).toContain(`Reply when done: walnut tools call session_send `
      + `'{"in_reply_to":"${result.requestId}","text":"<your result summary>"}'`);
  });

  it('the DEFAULT degrades to no request for the human — it must not 400 like an explicit true does', async () => {
    sessions = [rec('sess-target-1', { title: 'Target' })];

    // Same call as the explicit-true case above, minus the flag. That one is a
    // 400; this one must succeed silently, or every UI/CLI-launched send breaks.
    const result = await performSessionSend({ to: 'sess-target-1', text: 'just deliver it' });

    expect(result.requestId).toBeUndefined();
    expect(result.delivery).toBe('queued');
    // No request → no trailer at all, and the human's text stays bare.
    expect(deliveredText()).toBe('just deliver it');
  });

  it('expect_reply: false opts a session caller out of the default', async () => {
    sessions = [
      rec('sess-caller-4', { title: 'Asker', host: 'devbox' }),
      rec('sess-target-1', { title: 'Target', taskId: 'task-77' }),
    ];

    const result = await performSessionSend({
      to: 'sess-target-1', text: 'fire and forget', callerSid: 'sess-caller-4', expectReply: false,
    });

    expect(result.requestId).toBeUndefined();
    const text = deliveredText();
    expect(text).not.toContain('request=');
    expect(text).not.toContain('Reply when done');
  });

  it('registers a pending row, stamps the request in the tag, and adds ONE trailer line', async () => {
    sessions = [
      rec('sess-caller-4', { title: 'Asker', host: 'devbox' }),
      rec('sess-target-1', { title: 'Target', taskId: 'task-77' }),
    ];

    const result = await performSessionSend({
      to: 'sess-target-1', text: 'count the rows', callerSid: 'sess-caller-4', expectReply: true,
    });

    expect(result.requestId).toMatch(/^rq-[a-f0-9]{12}$/);
    const row = await getSessionRequest(result.requestId!);
    expect(row).toMatchObject({
      status: 'pending',
      fromSessionId: 'sess-caller-4',
      toSessionId: 'sess-target-1',
      toTaskId: 'task-77',
      preview: 'count the rows',
    });

    const text = deliveredText();
    const parsed = parseWalnutMessage(text)!;
    expect(parsed.attrs.request).toBe(result.requestId);
    expect(parsed.body).toBe('count the rows');
    // Walnut speaks the trailer, so it sits OUTSIDE the envelope: exactly one
    // newline after the closing tag, then exactly one line and nothing more.
    expect(text).toBe(`${parsed.raw}\n`
      + `Reply when done: walnut tools call session_send `
      + `'{"in_reply_to":"${result.requestId}","text":"<your result summary>"}'`);
  });
});

describe('performSessionSend — in_reply_to', () => {
  const ASKER = 'sess-asker-1';
  const TARGET = 'sess-target-1';

  async function armRequest(overrides: { toTaskId?: string } = {}) {
    const { createSessionRequest } = await import('../../src/core/session-requests.js');
    return createSessionRequest({
      fromSessionId: ASKER,
      toSessionId: TARGET,
      text: 'count the rows',
      ...overrides,
    });
  }

  beforeEach(() => {
    sessions = [
      rec(ASKER, { title: 'Asker', taskId: 'task-asker' }),
      rec(TARGET, { title: 'Target', host: 'devbox', taskId: 'task-target' }),
      rec('sess-bystander', { title: 'Bystander', taskId: 'task-bystander' }),
    ];
  });

  it('404s an unknown request id', async () => {
    await expectSendError(
      performSessionSend({ text: 'done', inReplyTo: 'rq-000000000000', callerSid: TARGET }),
      'unknown_request', 404,
    );
  });

  it('403s a session that was not the request target', async () => {
    const rq = await armRequest();

    await expectSendError(
      performSessionSend({ text: 'done', inReplyTo: rq.id, callerSid: 'sess-bystander' }),
      'not_request_target', 403,
    );
    // The row is untouched, so the real target can still answer.
    expect((await getSessionRequest(rq.id))?.status).toBe('pending');
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });

  it('403s a non-session caller (the human does not answer another session request)', async () => {
    const rq = await armRequest();

    await expectSendError(
      performSessionSend({ text: 'done', inReplyTo: rq.id }), 'not_request_target', 403);
    expect((await getSessionRequest(rq.id))?.status).toBe('pending');
  });

  it('settles the row BEFORE delivering, then routes the answer to the asker', async () => {
    const rq = await armRequest();
    let statusAtDelivery: string | undefined;
    sendMessageToSession.mockImplementation(async () => {
      statusAtDelivery = (await getSessionRequest(rq.id))?.status;
      return { id: 'qm-reply' };
    });

    const result = await performSessionSend({
      text: 'Done: 412 rows moved.', inReplyTo: rq.id, callerSid: TARGET,
    });

    // The status flip must not wait on delivery embellishment.
    expect(statusAtDelivery).toBe('replied');
    expect(result).toMatchObject({
      delivery: 'queued',
      targetSessionId: ASKER,
      targetTitle: 'Asker',
      targetTaskId: 'task-asker',
      // The reply's "target" is the asker it routed back to.
      target: { handle: 'Asker [sess-ask]', sessionId: ASKER, taskId: 'task-asker' },
      repliedTo: rq.id,
    });

    const { sid, busText, opts } = dispatched();
    expect(sid).toBe(ASKER);
    expect(busText).toBe('Done: 412 rows moved.');
    const parsed = parseWalnutMessage(opts.enqueueMessage as string)!;
    expect(parsed.kind).toBe('reply');
    expect(parsed.attrs.request).toBe(rq.id);
    expect(parsed.attrs.from).toBe('Target [sess-tar]');
    expect(parsed.attrs['from-session']).toBe(TARGET);
    expect(parsed.attrs['from-task']).toBe('task-target');
    expect(parsed.attrs.host).toBe('devbox');
    expect(parsed.attrs.asked).toBe('count the rows');
    expect(parsed.body).toBe('Done: 412 rows moved.');
    // A reply is the answer: it never carries a trailer of its own.
    expect(opts.enqueueMessage).toBe(parsed.raw);
  });

  it('accepts the target task id as proof of targeting when the session id differs', async () => {
    const rq = await armRequest({ toTaskId: 'task-target' });
    // A resumed session gets a NEW claude session id but keeps the task.
    sessions = sessions.map((s) => s.claudeSessionId === TARGET
      ? rec('sess-target-resumed', { title: 'Target', taskId: 'task-target' }) : s);

    const result = await performSessionSend({
      text: 'done', inReplyTo: rq.id, callerSid: 'sess-target-resumed',
    });
    expect(result.repliedTo).toBe(rq.id);
  });

  it('still delivers a late reply after the asker was already notified', async () => {
    const rq = await armRequest();
    await settleNotified(rq.id, 'timeout');

    const result = await performSessionSend({
      text: 'sorry, late: 412 rows', inReplyTo: rq.id, callerSid: TARGET,
    });

    expect(result.repliedTo).toBe(rq.id);
    expect(sendMessageToSession).toHaveBeenCalledTimes(1);
    // The earlier settle stands — a late answer does not rewrite history.
    const row = await getSessionRequest(rq.id);
    expect(row?.status).toBe('expired');
    expect(row?.outcome).toBe('timeout');
  });

  it('410s when the asking session is gone', async () => {
    const rq = await armRequest();
    sessions = sessions.filter((s) => s.claudeSessionId !== ASKER);

    const err = await expectSendError(
      performSessionSend({ text: 'done', inReplyTo: rq.id, callerSid: TARGET }),
      'origin_session_gone', 410,
    );
    expect(err.message).toContain('sess-ask');
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });
});

/**
 * A reply is addressed to the ASKER, and the asker is a train of thought, not one
 * process. 2026-09-11: the human forked the asking session, kept working in the
 * fork, and the answer was filed six minutes later in the idle original nobody was
 * reading. The ladder lives in reply-routing.ts (unit-pinned in
 * tests/core/reply-routing.test.ts); these cases pin that performReply USES it and
 * reports where the answer really went.
 */
describe('performSessionSend — in_reply_to routes to the requester’s CURRENT session', () => {
  const ASKER = 'sess-asker-1';
  const TARGET = 'sess-target-1';

  async function armRequest() {
    const { createSessionRequest } = await import('../../src/core/session-requests.js');
    return createSessionRequest({ fromSessionId: ASKER, toSessionId: TARGET, text: 'count the rows' });
  }

  beforeEach(() => {
    sessions = [
      rec(ASKER, { title: 'Asker', taskId: 'task-asker' }),
      rec(TARGET, { title: 'Target', host: 'devbox', taskId: 'task-target' }),
    ];
  });

  it('lands in the newer session when the requester TASK moved on', async () => {
    const rq = await armRequest();
    sessions = [
      rec(ASKER, { title: 'Asker', taskId: 'task-asker', process_status: 'stopped', lastActiveAt: '2026-09-11T02:29:00.000Z' }),
      rec('sess-asker-2', { title: 'Asker restarted', taskId: 'task-asker', lastActiveAt: '2026-09-11T02:35:00.000Z' }),
      rec(TARGET, { title: 'Target', taskId: 'task-target' }),
    ];

    const result = await performSessionSend({ text: 'done', inReplyTo: rq.id, callerSid: TARGET });

    expect(dispatched().sid).toBe('sess-asker-2');
    expect(result.targetSessionId).toBe('sess-asker-2');
    expect(result.target.handle).toBe('Asker restarted [sess-ask]');
  });

  it('lands in a LIVE fork of the asker even though the fork has its own task', async () => {
    const rq = await armRequest();
    sessions = [
      rec(ASKER, { title: 'Asker', taskId: 'task-asker', process_status: 'stopped' }),
      rec('sess-fork-1', {
        title: 'Fork of Asker', taskId: 'task-fork', forkedFromSessionId: ASKER,
        lastActiveAt: '2026-09-11T02:36:00.000Z',
      }),
      rec(TARGET, { title: 'Target', taskId: 'task-target' }),
    ];

    const result = await performSessionSend({ text: 'done', inReplyTo: rq.id, callerSid: TARGET });

    expect(dispatched().sid).toBe('sess-fork-1');
    expect(result.targetSessionId).toBe('sess-fork-1');
    // The envelope still names the request, so the fork can tie it to the ask.
    expect(parseWalnutMessage(dispatched().opts.enqueueMessage as string)!.attrs.request).toBe(rq.id);
  });

  it('leaves the common case alone: a live asker still gets its own answer', async () => {
    const rq = await armRequest();
    // A fork exists, but the asker is alive — nothing may be re-routed.
    sessions.push(rec('sess-fork-1', { title: 'Fork of Asker', taskId: 'task-fork', forkedFromSessionId: ASKER }));

    const result = await performSessionSend({ text: 'done', inReplyTo: rq.id, callerSid: TARGET });

    expect(dispatched().sid).toBe(ASKER);
    expect(result.targetSessionId).toBe(ASKER);
  });

  it('never routes the answer back into the replying session', async () => {
    const rq = await armRequest();
    // Pathological lineage: the replier is itself a fork of the (dead) asker.
    sessions = [
      rec(ASKER, { title: 'Asker', taskId: 'task-asker', archived: true }),
      rec(TARGET, { title: 'Target', taskId: 'task-target', forkedFromSessionId: ASKER }),
    ];

    await expectSendError(
      performSessionSend({ text: 'done', inReplyTo: rq.id, callerSid: TARGET }),
      'origin_session_gone', 410,
    );
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });
});

describe('performSessionSend — input validation', () => {
  it('requires non-empty text and a target', async () => {
    sessions = [rec('sess-target-1', { title: 'Target' })];

    await expectSendError(performSessionSend({ to: 'sess-target-1', text: '   ' }), 'bad_request', 400);
    await expectSendError(performSessionSend({ text: 'no target' }), 'bad_request', 400);
    expect(sendMessageToSession).not.toHaveBeenCalled();
  });
});
