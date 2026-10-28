/**
 * An agent reads the inbox the way the user does (2026-10-27: Main could not read a letter by id
 * to pass its options on): human_inbox_list, human_inbox_get and human_inbox_mark against a real
 * server. Answering a plugin's letter (an approval of a step outside Walnut) stays the user's.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('inbox-agent-ops', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { sendLetter } from '../../src/core/human-inbox/store.js';
import { executeOp } from '../../src/ops/index.js';
import { handleHumanInboxRelayAction } from '../../src/core/human-inbox/relay.js';

let server: Server;
let root: string;
const run = async (name: string, args: Record<string, unknown>, sid?: string) => {
  const out = await executeOp(name, args, { apiBase: root, origin: '__local__', ...(sid ? { callerMode: 'session' as const, callerSid: sid } : { callerMode: 'human' as const }) });
  if (!out.ok) throw new Error(out.message);
  return out.result as Record<string, any>;
};
const answer = (id: string, headers: Record<string, string> = {}) => fetch(`${root}/api/v1/human-inbox/${id}/answer`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ actionId: 'yes' }),
});

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('the inbox, read by an agent', () => {
  it('lists by task, reads one letter as text, and marks it read and archived', async () => {
    const design = await sendLetter({
      subject: 'Three menu designs', type: 'action_required',
      html: '<style>.x{color:red}</style><h2>Pick one</h2><p>Option <b>A</b> keeps the row short.</p><p>Option&nbsp;B &amp; C stack it.</p>',
      actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      sender: { sessionId: 's-main', taskId: 't-main', taskTitle: 'Main agent', host: 'local' },
    });
    const other = await sendLetter({ subject: 'Weekly digest', type: 'info', markdown: 'x'.repeat(30_000), sender: { sessionId: 's-other', taskId: 't-other', host: 'local' }, taskRefs: ['t-main'] });
    await sendLetter({ subject: 'Unrelated', type: 'info', markdown: 'Hi', sender: { sessionId: 's-3', taskId: 't-3', host: 'local' } });

    // By task: the letters it sent and the ones that name it.
    const mine = await run('human_inbox_list', { task_id: 't-main' });
    expect(mine.letters.map((l: { id: string }) => l.id).sort()).toEqual([design.id, other.id].sort());
    expect(mine.letters.find((l: { id: string }) => l.id === design.id)).toMatchObject({ subject: 'Three menu designs', read: false, from: { taskId: 't-main', task: 'Main agent' }, actions: [{ id: 'a' }, { id: 'b' }] });
    expect((await run('human_inbox_list', {})).total).toBe(3);

    // One letter: the document as readable text, no markup or styles; reading it marks nothing.
    const got = (await run('human_inbox_get', { id: design.id })).letter;
    expect(got.document.text).toContain('Option A keeps the row short.');
    expect(got.document.text).toContain('Option B & C stack it.');
    expect(got.document.text).not.toMatch(/<|color:red/);
    // Reading it marked nothing for the user: a later list still has it unread.
    expect((await run('human_inbox_list', { unread: true })).letters.map((l: { id: string }) => l.id)).toContain(design.id);
    // A long one is cut, and says how long it was.
    const long = (await run('human_inbox_get', { id: other.id })).letter;
    expect(long.document).toMatchObject({ truncated: true, chars: 30_000 });
    expect(long.document.text.length).toBeLessThan(20_100);
    await expect(run('human_inbox_get', { id: 'lt-nope-000000' })).rejects.toThrow();

    // Marks, as the user does them.
    const marked = await run('human_inbox_mark', { id: design.id, read: true, pinned: true });
    expect(marked.letter).toMatchObject({ read: true, pinned: true, archived: false });
    expect((await run('human_inbox_list', { unread: true })).letters.map((l: { id: string }) => l.id)).not.toContain(design.id);
    await run('human_inbox_mark', { id: design.id, archived: true });
    expect((await run('human_inbox_list', {})).letters.map((l: { id: string }) => l.id)).not.toContain(design.id);
    expect((await run('human_inbox_list', { archived: true })).letters.map((l: { id: string }) => l.id)).toContain(design.id);
    await expect(run('human_inbox_mark', { id: design.id })).rejects.toThrow(/at least one/);
  });

  it('mail html reads as text: entities, comments, unclosed scripts, quoted ">" and html in a turn\'s text', async () => {
    const mail = await sendLetter({
      subject: 'Digest', type: 'info',
      html: '<!-- tracking --><p title="a > b">It&rsquo;s here&#8217;s &#x2019;ok&#x2019; &mdash; done&hellip;</p><p>Zero&zwnj;width</p><script>var leak = 1',
      sender: { sessionId: 's-mail', taskId: 't-mail', host: 'local' },
    });
    const text = (await run('human_inbox_get', { id: mail.id })).letter.document.text as string;
    expect(text).toMatch(/^It\u2019s here\u2019s \u2019ok\u2019 \u2014 done\u2026\s+Zerowidth$/);
  });

  it('a task answers a session\'s letter for the user, recorded as its answer', async () => {
    const ask = await sendLetter({
      subject: 'Which layout?', type: 'action_required', markdown: 'Pick', actions: [{ id: 'wide', label: 'Wide' }, { id: 'tall', label: 'Tall' }],
      sender: { sessionId: 's-ask2', taskId: 't-ask2', host: 'local' },
    });
    const out = await run('human_inbox_answer', { id: ask.id, action_id: 'wide', note: 'The user said wide in chat' }, 'answering-session');
    expect(out.letter.answered).toMatchObject({ actionId: 'wide', by: { sessionId: 'answering-session' } });
    const got = (await run('human_inbox_get', { id: ask.id })).letter;
    expect(got.read).toBe(false);
    expect(got.thread.at(-1)).toMatchObject({ from: 'human', by: { sessionId: 'answering-session' }, text: 'Wide: The user said wide in chat' });
    // A reply in the user's place, the same way.
    const reply = await run('human_inbox_answer', { id: ask.id, text: 'Also keep the header' }, 'answering-session');
    expect(reply.delivery?.status).toBeDefined();
    expect((await run('human_inbox_get', { id: ask.id })).letter.thread.at(-1)).toMatchObject({ by: { sessionId: 'answering-session' } });
    await expect(run('human_inbox_answer', { id: ask.id }, 'answering-session')).rejects.toThrow(/action_id .*or text/);
  });

  it('a plugin\'s approval letter is answered by the user only; a session\'s letter by anyone', async () => {
    const approval = await sendLetter({
      subject: 'Send this email?', type: 'action_required', markdown: 'To: a friend', actions: [{ id: 'yes', label: 'Send' }],
      sender: { sessionId: 'external', pluginId: 'fixture-mail', host: 'local' },
    });
    const bySession = await answer(approval.id, { 'x-walnut-caller-sid': 'some-session' });
    expect(bySession.status).toBe(403);
    expect((await bySession.json()).error?.code ?? '').toBe('human-approval-required');
    expect((await run('human_inbox_get', { id: approval.id })).letter.answered).toBeUndefined();
    const reply = await fetch(`${root}/api/v1/human-inbox/${approval.id}/human-reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': 'some-session' }, body: JSON.stringify({ text: 'Send it' }),
    });
    expect(reply.status).toBe(403);
    // The op says the same, and so does the primary's relay of a replica's call naming a session.
    await expect(run('human_inbox_answer', { id: approval.id, action_id: 'yes' }, 'some-session')).rejects.toThrow(/human-approval-required/);
    await expect(handleHumanInboxRelayAction('answer', { id: approval.id, actionId: 'yes', callerSid: 'some-session' })).rejects.toMatchObject({ status: 403 });
    await expect(handleHumanInboxRelayAction('human-reply', { id: approval.id, text: 'Send', callerSid: 'some-session' })).rejects.toMatchObject({ status: 403 });
    expect((await run('human_inbox_get', { id: approval.id })).letter.answered).toBeUndefined();
    // The user's own answer goes through, and so does their reply.
    expect((await answer(approval.id)).status).toBeLessThan(300);
    const got = (await run('human_inbox_get', { id: approval.id })).letter;
    expect(got.answered).toMatchObject({ actionId: 'yes' });
    expect(got.answered.by).toBeUndefined();
    const personReply = await fetch(`${root}/api/v1/human-inbox/${approval.id}/human-reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Thanks' }),
    });
    expect(personReply.status).toBeLessThan(300);

    // A session's letter: a session may answer it, as the user may.
    const ask = await sendLetter({
      subject: 'Which one?', type: 'action_required', markdown: 'Pick', actions: [{ id: 'yes', label: 'This one' }],
      sender: { sessionId: 's-ask', taskId: 't-ask', host: 'local' },
    });
    const bySessionOk = await answer(ask.id, { 'x-walnut-caller-sid': 'some-session' });
    expect(bySessionOk.status).toBeLessThan(300);
    expect((await run('human_inbox_get', { id: ask.id })).letter.answered).toMatchObject({ actionId: 'yes', by: { sessionId: 'some-session' } });
  });
});
