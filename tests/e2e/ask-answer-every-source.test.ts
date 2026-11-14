/**
 * task_send answers_ask settles every kind of ask the user's Needs you shows (2026-11-13, Main:
 * one answers_ask answers or withdraws any ask the Brief lists): an org node's question folded into
 * its chat, a Board choice, a decision letter, and a prompt open in a session. Statuses come from
 * the server's own sync on real facts (a report, a Board, a letter, a session's pending prompt).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ask-answer-every-source'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { getLetter, sendLetter } from '../../src/core/human-inbox/store.js';
import { getBoard, setBoardHtml } from '../../src/core/boards/board-store.js';
import type { Task } from '../../src/core/types.js';

const LEAD_SID = 'eeeeeeee-1111-4bbb-8ccc-dddddddddddd';
let base = '';
let lead: Task;
let n = 0;

async function statusOf(id: string, ok: (t: Task) => boolean, timeoutMs = 30_000): Promise<Task> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const t = await getTask(id);
    if (t.user_status && ok(t)) return t;
    if (Date.now() > until) throw new Error(`no matching user_status for ${id}: ${JSON.stringify(t.user_status ?? null)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function worker(title: string): Promise<Task> {
  const t = (await addTask({ title: `${title} ${++n}`, project: 'Orchid' })).task;
  await updateTask(t.id, { parent_task_id: lead.id, phase: 'NEED_ACTION' });
  return t;
}

async function answer(id: string, text: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': LEAD_SID },
    body: JSON.stringify({ to: id, title: 'Decided for the user', text, answers_ask: true, expect_reply: false, ...extra }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  const server = await startServer({ port: 0, dev: true });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  lead = (await addTask({ title: 'Orchid team lead', project: 'Orchid' })).task;
  await createSessionRecord(LEAD_SID, lead.id, 'Orchid', WALNUT_HOME);
  await updateSessionRecord(LEAD_SID, { process_status: 'idle' } as never);
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('answers_ask settles any ask the Needs you shows', () => {
  it('an org node\'s question in its chat', async () => {
    const node = await worker('Orchid sub-lead');
    await updateTaskRaw(node.id, { org_role: 'lead' } as never, { source: 'test' });
    const ask = 'Should the beta go to the staging site first?';
    await updateTaskRaw(node.id, { status_report: { state: 'needs', ask, at: new Date().toISOString() } } as never, { emitEvent: true, source: 'test' });
    const shown = await statusOf(node.id, (t) => t.user_status!.state === 'waiting' && t.user_status!.kind === 'you');
    expect(shown.user_status).toMatchObject({ chatAsk: ask });
    expect(shown.user_status!.waitingOn).toContain('its question to you is in its chat');
    const r = await answer(node.id, 'Yes, staging first.');
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect((await getTask(node.id)).ask_answered).toMatchObject({ ask, by: lead.id });
    expect((await statusOf(node.id, (t) => t.user_status!.kind === 'task')).user_status).toMatchObject({ state: 'waiting', kind: 'task', answeredFor: { ask } });
  });

  it('a Board choice: the words pick its option by name, on the Board', async () => {
    const t = await worker('Has a Board choice');
    await setBoardHtml(lead.id, `<html><body><walnut-choice id="host" title="Which host?" options="mac:Mac,cloud:Cloud" task="${t.id}"></walnut-choice></body></html>`, { by: `task:${lead.id}` });
    await statusOf(t.id, (x) => x.user_status!.state === 'needs' && x.user_status!.source === 'choice');
    const r = await answer(t.id, 'Cloud');
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ delivery: 'settled', settled: { via: 'board_choice', board: lead.id, choice: 'host' } });
    expect((await getBoard(lead.id))?.choices?.host).toMatchObject({ option: 'cloud' });
    await statusOf(t.id, (x) => !(x.user_status!.state === 'needs' && x.user_status!.source === 'choice'));
  });

  it('a decision letter: answered in the inbox, only on the user\'s words', async () => {
    const t = await worker('Asks by letter');
    await createSessionRecord(`sess-letter-${n}`, t.id, 'Orchid');
    await updateSessionRecord(`sess-letter-${n}`, { process_status: 'idle' });
    const letter = await sendLetter({
      subject: 'Pick a layout', type: 'action_required', markdown: 'A or B?',
      actions: [{ id: 'a', label: 'Layout A' }, { id: 'b', label: 'Layout B' }],
      sender: { sessionId: `sess-letter-${n}`, taskId: t.id },
    } as never);
    await statusOf(t.id, (x) => x.user_status!.state === 'needs' && x.user_status!.source === 'letter');
    const bare = await answer(t.id, 'Layout B');
    expect(bare.status, JSON.stringify(bare.body)).toBe(409);
    expect(JSON.stringify(bare.body)).toContain('user_words');
    const ok = await answer(t.id, 'Layout B', { user_words: 'take layout B' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    expect(ok.body).toMatchObject({ delivery: 'settled', settled: { via: 'letter', letterId: letter.id } });
    expect((await getLetter(letter.id))?.answered).toBeTruthy();
    await statusOf(t.id, (x) => x.user_status!.source !== 'letter');
  });

  it('a letter is answered only by one of its options, named in the answer', async () => {
    const t = await worker('Asks by open letter');
    await createSessionRecord(`sess-open-${n}`, t.id, 'Orchid');
    await updateSessionRecord(`sess-open-${n}`, { process_status: 'idle' });
    const withOptions = await sendLetter({
      subject: 'Pick a colour', type: 'action_required', markdown: 'Red or blue?',
      actions: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }],
      sender: { sessionId: `sess-open-${n}`, taskId: t.id },
    } as never);
    await statusOf(t.id, (x) => x.user_status!.state === 'needs' && x.user_status!.source === 'letter');
    const free = await answer(t.id, 'Something greenish', { user_words: 'use a green one' });
    expect(free.status, JSON.stringify(free.body)).toBe(409);
    expect((free.body.error as { message: string }).message).toContain('"Red", "Blue"');
    expect((await getLetter(withOptions.id))?.answered).toBeFalsy();
    const named = await answer(t.id, 'Blue', { user_words: 'blue please' });
    expect(named.status, JSON.stringify(named.body)).toBe(202);
    expect((await getLetter(withOptions.id))?.answered).toMatchObject({ actionId: 'blue' });
    await statusOf(t.id, (x) => x.user_status!.source !== 'letter');
  });

  it('a withdrawn letter is settled, and the task is told by message', async () => {
    const t = await worker('Letter to withdraw');
    await createSessionRecord(`sess-wd-${n}`, t.id, 'Orchid');
    await updateSessionRecord(`sess-wd-${n}`, { process_status: 'idle' });
    const letter = await sendLetter({
      subject: 'Pick a mascot', type: 'action_required', markdown: 'Cat or dog?',
      actions: [{ id: 'cat', label: 'Cat' }, { id: 'dog', label: 'Dog' }],
      sender: { sessionId: `sess-wd-${n}`, taskId: t.id },
    } as never);
    await statusOf(t.id, (x) => x.user_status!.state === 'needs' && x.user_status!.source === 'letter');
    const r = await answer(t.id, 'The mascot is dropped from the launch.', { withdraw_ask: true, user_words: 'drop the mascot question' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ settled: { via: 'letter', letterId: letter.id, settled: true, tell: true }, withdrawn: true });
    expect(['queued', 'recorded']).toContain(r.body.delivery);
    expect((await getLetter(letter.id))?.archived).toBe(true);
  });

  it('a prompt whose session is gone says why, and nothing is recorded', async () => {
    const t = await worker('Asks in a prompt');
    const sid = `sess-prompt-${n}`;
    await createSessionRecord(sid, t.id, 'Orchid');
    await updateSessionRecord(sid, { process_status: 'idle', pendingPermission: {
      requestId: 'req-1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which region?' }] }, receivedAt: new Date().toISOString(),
    } } as never);
    await statusOf(t.id, (x) => x.user_status!.state === 'needs' && x.user_status!.source === 'prompt');
    const r = await answer(t.id, 'us-west-2');
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain('could not be answered');
    expect((await getTask(t.id)).ask_answered).toBeUndefined();
  });

  it('a withdrawn Board choice is answered as withdrawn, on the user\'s words', async () => {
    const t = await worker('Choice to withdraw');
    await setBoardHtml(lead.id, `<html><body><walnut-choice id="host2" title="Which host?" options="mac:Mac,cloud:Cloud" task="${t.id}"></walnut-choice></body></html>`, { by: `task:${lead.id}` });
    await statusOf(t.id, (x) => x.user_status!.state === 'needs' && x.user_status!.source === 'choice');
    const r = await answer(t.id, 'Not needed any more.', { withdraw_ask: true, user_words: 'drop the host question' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ delivery: 'settled', withdrawn: true });
    expect((await getBoard(lead.id))?.choices?.host2?.text).toContain('Withdrawn by');
  });
});
