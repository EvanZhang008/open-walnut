/**
 * One sender, one letter per question, against a real server (2026-11-02 org review: a lead sent
 * one decision letter three times in 47 seconds and another twice, two of them one second apart,
 * then posted one thread reply twice). human_inbox_send refuses a session's repeat of a subject
 * inside the window (409 duplicate_letter), sends at once included; a letter asking what the
 * sender's open decision letter asks goes out with that letter named; human_inbox_reply refuses
 * the sender's latest reply posted again (409 duplicate_reply). External senders, plugins and
 * Walnut's own folds into a thread are never refused.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('inbox-duplicate-letter', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { agentReply, getLetter, listLetters, sendLetter, setLetterState, withdrawLetter } from '../../src/core/human-inbox/store.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { executeOp } from '../../src/ops/index.js';
import { handleHumanInboxRelayAction } from '../../src/core/human-inbox/relay.js';
import { DUPLICATE_WINDOW_MS } from '../../src/core/human-inbox/duplicate-letter.js';

// Test data shaped like the review's subjects: "Scanner CVE: delete 6 idle resource groups?",
// "Alex cannot open Sam's promotion doc, grant access?" and a rewording of the second.
const DELETE = 'Scanner CVE\uff1a\u5220\u6389 6 \u7ec4\u95f2\u7f6e\u8d44\u6e90\u5417\uff1f';
const ACCESS = 'Alex \u6253\u4e0d\u5f00 Sam \u7684\u664b\u5347\u6587\u6863\uff0c\u8981\u7ed9\u4ed6\u5f00\u6743\u9650\u5417\uff1f';
const ACCESS_REWORDED = '要给 Alex 开 Sam 晋升文档的权限吗？';

let server: Server;
let root: string;
const run = async (name: string, args: Record<string, unknown>, sid?: string) => {
  const out = await executeOp(name, args, { apiBase: root, origin: '__local__', ...(sid ? { callerMode: 'session' as const, callerSid: sid } : { callerMode: 'human' as const }) });
  if (!out.ok) throw new Error(out.message);
  return out.result as Record<string, any>;
};
const post = (path: string, body: Record<string, unknown>, sid?: string) => fetch(`${root}/api/v1${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) }, body: JSON.stringify(body),
});
const decision = (subject: string, extra: Record<string, unknown> = {}) => ({
  subject, type: 'action_required', markdown: 'Details in the task.', actions: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
  // A decision letter names which of the user's kinds it is (org/user-kind.ts).
  user_kind: 'cloud_delete', user_kind_why: 'It deletes cloud resources for good', ...extra,
});
const fromTask = async (taskId: string) => (await listLetters()).letters.filter((l) => l.sender.taskId === taskId);

/** A worker task with a live session record: what a session's send is stamped from. */
async function sessionTask(title: string): Promise<{ taskId: string; sid: string }> {
  const task = (await addTask({ title })).task;
  const sid = `s-${task.id}`;
  await createSessionRecord(sid, task.id, '', WALNUT_HOME);
  return { taskId: task.id, sid };
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('duplicate letters from one sender', () => {
  it('the same subject again is refused with the first letter named; another subject goes', async () => {
    const { taskId, sid } = await sessionTask('Resource cleanup');
    const first = await run('human_inbox_send', decision(DELETE), sid);
    expect(first.letterId).toMatch(/^lt-/);
    expect(first.openAsk).toBeUndefined();
    // Trailing punctuation and case do not make it a new question.
    await expect(run('human_inbox_send', decision(`${DELETE.slice(0, -1)} `), sid)).rejects.toThrow(new RegExp(`duplicate_letter[\\s\\S]*${first.letterId}[\\s\\S]*human_inbox_reply`));
    const res = await post('/human-inbox', decision(DELETE), sid);
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('duplicate_letter');
    expect(body.error?.message).toContain(first.letterId);
    // The cloud relay meets the same rule.
    await expect(handleHumanInboxRelayAction('send', { ...decision(DELETE), callerSid: sid })).rejects.toMatchObject({ status: 409, code: 'duplicate_letter' });
    expect(await run('human_inbox_send', decision(ACCESS), sid)).toMatchObject({ letterId: expect.stringMatching(/^lt-/) });
    expect((await fromTask(taskId)).map((l) => l.subject).sort()).toEqual([ACCESS, DELETE].sort());
  });

  it('a letter its sender withdrew may be sent again at once', async () => {
    const { sid } = await sessionTask('Withdraw and resend');
    const first = await run('human_inbox_send', decision(DELETE), sid);
    await withdrawLetter(first.letterId, { note: 'The numbers in it were wrong.' });
    expect(await run('human_inbox_send', decision(DELETE), sid)).toMatchObject({ letterId: expect.stringMatching(/^lt-/) });
  });

    it('sends at once: exactly one letter is stored', async () => {
    const { taskId, sid } = await sessionTask('Doc access');
    const all = await Promise.all([0, 1, 2].map(() => post('/human-inbox', decision(ACCESS), sid)));
    expect(all.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect((await fromTask(taskId)).length).toBe(1);
  });

  it('another sender, an external caller or a plugin may send the same subject', async () => {
    const a = await sessionTask('Cleanup A');
    const b = await sessionTask('Cleanup B');
    await run('human_inbox_send', decision(DELETE), a.sid);
    await run('human_inbox_send', decision(DELETE), b.sid);
    // No caller session: the honest external sender, never judged as one sender.
    expect((await post('/human-inbox', decision('Rotate the shared key?'))).status).toBe(201);
    expect((await post('/human-inbox', decision('Rotate the shared key?'))).status).toBe(201);
    const plugin = { sessionId: 'external', host: 'local', pluginId: 'fixture-mail' };
    await sendLetter({ ...decision('Send this email?'), sender: plugin } as never);
    await sendLetter({ ...decision('Send this email?'), sender: plugin } as never);
    expect((await listLetters()).letters.filter((l) => l.subject === 'Send this email?').length).toBe(2);
  });

  it('past the window it goes, naming the open decision letter that asks the same', async () => {
    const { taskId, sid } = await sessionTask('Old ask');
    const sender = { sessionId: sid, taskId, host: 'local' };
    const old = await sendLetter({ ...decision(DELETE), sender } as never, { createdAt: Date.now() - DUPLICATE_WINDOW_MS - 60_000 });
    const again = await run('human_inbox_send', decision(DELETE), sid);
    expect(again.letterId).not.toBe(old.id);
    expect(again.openAsk).toMatchObject({ letterId: old.id, subject: DELETE });
    expect(again.instruction).toContain(old.id);
    expect(again.instruction).toMatch(/human_inbox_reply[\s\S]*settle/);
    // A rewording of an open ask is named too, through the route and the relay alike.
    const access = await sendLetter({ ...decision(ACCESS), sender } as never, { createdAt: Date.now() - 2 * 60 * 60_000 });
    const reworded = await post('/human-inbox', decision(ACCESS_REWORDED), sid);
    expect(reworded.status).toBe(201);
    const rewordedBody = await reworded.json() as { id: string; openAsk?: { letterId?: string } };
    expect(rewordedBody.openAsk?.letterId).toBe(access.id);
    // The closest open ask is named: now the reworded letter itself.
    const relayed = await handleHumanInboxRelayAction('send', { subject: `${ACCESS_REWORDED} (2)`, type: 'info', markdown: 'x', callerSid: sid });
    expect((relayed as { openAsk?: { letterId?: string } }).openAsk?.letterId).toBe(rewordedBody.id);
    // Once the user answered it, nothing is named.
    const done = await sessionTask('Answered ask');
    const answered = await sendLetter({ ...decision('Ship the beta tonight?'), sender: { sessionId: done.sid, taskId: done.taskId, host: 'local' } } as never, { createdAt: Date.now() - DUPLICATE_WINDOW_MS - 60_000 });
    expect((await post(`/human-inbox/${answered.id}/answer`, { actionId: 'yes' })).status).toBeLessThan(300);
    expect((await run('human_inbox_send', decision('Ship the beta tonight?'), done.sid)).openAsk).toBeUndefined();
  });

  it('resend_reason sends it again on purpose; a short one does not count', async () => {
    const { taskId, sid } = await sessionTask('Resend');
    await run('human_inbox_send', decision(DELETE), sid);
    await expect(run('human_inbox_send', decision(DELETE, { resend_reason: 'again' }), sid)).rejects.toThrow(/duplicate_letter/);
    const resent = await run('human_inbox_send', decision(DELETE, { resend_reason: 'The first one named the wrong account' }), sid);
    expect(resent.letterId).toMatch(/^lt-/);
    const stored = (await getLetter(resent.letterId))! as unknown as Record<string, unknown>;
    expect(stored.resend_reason).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('wrong account');
    expect((await fromTask(taskId)).length).toBe(2);
  });

  it('the same thread reply twice is refused; a new one goes; Walnut\'s own turns are never judged', async () => {
    const { sid } = await sessionTask('Reply twice');
    const { letterId } = await run('human_inbox_send', decision('Free the build cache?'), sid);
    const text = 'Freed 40 GB. The cache rebuilds on the next run.';
    await run('human_inbox_reply', { letter: letterId, text }, sid);
    await expect(run('human_inbox_reply', { letter: letterId, text: `${text} ` }, sid)).rejects.toThrow(/duplicate_reply/);
    const res = await post(`/human-inbox/${letterId}/reply`, { text }, sid);
    expect(res.status).toBe(409);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe('duplicate_reply');
    await expect(handleHumanInboxRelayAction('reply', { id: letterId, text })).rejects.toMatchObject({ status: 409, code: 'duplicate_reply' });
    await run('human_inbox_reply', { letter: letterId, text: 'One more thing: the old logs went too.' }, sid);
    // An internal caller (an away fold, a plugin's reply) opts out of the check.
    await agentReply(letterId, { text: 'Same line' });
    await agentReply(letterId, { text: 'Same line' });
    const thread = (await getLetter(letterId))!.thread.map((t) => t.text);
    expect(thread.filter((t) => t === text).length).toBe(1);
    expect(thread.filter((t) => t === 'Same line').length).toBe(2);
    await setLetterState(letterId, 'archived', true);
  });
});
