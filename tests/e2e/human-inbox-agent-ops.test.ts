/**
 * An agent reads the inbox the way the user does (2026-10-27: Main could not read a letter by id
 * to pass its options on): human_inbox_list, human_inbox_get and human_inbox_mark against a real
 * server. Answering a plugin's letter (an approval of a step outside Walnut) stays the user's.
 *
 * 2026-10-29 (the org reflection): a task answering for the user quotes the user's words, and an
 * answer approving a step that is hard to undo or leaves Walnut needs words that name it (Main had
 * answered "clear everything" as a history rewrite and an npm unpublish); a decision letter
 * nobody needs any more is settled with a reason, and a completed task settles its own; a report
 * letter from a task answering another task's request is refused, since the asker tells the user.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('inbox-agent-ops', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { getLetter, sendLetter } from '../../src/core/human-inbox/store.js';
import { addTask, completeTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { createSessionRequest, settleReplied } from '../../src/core/session-requests.js';
import { executeOp } from '../../src/ops/index.js';
import { handleHumanInboxRelayAction } from '../../src/core/human-inbox/relay.js';

let server: Server;
let root: string;
const run = async (name: string, args: Record<string, unknown>, sid?: string) => {
  const out = await executeOp(name, args, { apiBase: root, origin: '__local__', ...(sid ? { callerMode: 'session' as const, callerSid: sid } : { callerMode: 'human' as const }) });
  if (!out.ok) throw new Error(out.message);
  return out.result as Record<string, any>;
};
const answer = (id: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) => fetch(`${root}/api/v1/human-inbox/${id}/answer`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ actionId: 'yes', ...extra }),
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
    const out = await run('human_inbox_answer', { id: ask.id, action_id: 'wide', note: 'The user said wide in chat', user_words: 'wide is fine' }, 'answering-session');
    expect(out.letter.answered).toMatchObject({ actionId: 'wide', by: { sessionId: 'answering-session', userWords: 'wide is fine' } });
    const got = (await run('human_inbox_get', { id: ask.id })).letter;
    expect(got.read).toBe(false);
    expect(got.thread.at(-1)).toMatchObject({ from: 'human', by: { sessionId: 'answering-session' }, text: 'Wide: The user said wide in chat' });
    // A reply in the user's place, the same way.
    const reply = await run('human_inbox_answer', { id: ask.id, text: 'Also keep the header', user_words: 'keep the header too' }, 'answering-session');
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
    const noWords = await answer(ask.id, { 'x-walnut-caller-sid': 'some-session' });
    expect(noWords.status).toBe(400);
    expect((await noWords.json()).error?.message ?? '').toMatch(/user_words/);
    const bySessionOk = await answer(ask.id, { 'x-walnut-caller-sid': 'some-session' }, { userWords: 'yes, this one' });
    expect(bySessionOk.status).toBeLessThan(300);
    expect((await run('human_inbox_get', { id: ask.id })).letter.answered).toMatchObject({ actionId: 'yes', by: { sessionId: 'some-session' } });
  });

  it('the 10-29 replay: one vague line never approves a history rewrite or an unpublish', async () => {
    const audit = await sendLetter({
      subject: 'Public leak audit: A to H', type: 'action_required', markdown: 'Decide each item',
      actions: [
        { id: 'all_recommended', label: '\u5168\u6309\u63a8\u8350', description: 'A no rewrite, B delete the screenshot, E deprecate' },
        { id: 'reply_each', label: 'I reply item by item' },
      ],
      sender: { sessionId: 's-audit', taskId: 't-audit', host: 'local' },
    });
    const history = await sendLetter({
      subject: '103 commits carry the work email', type: 'action_required', markdown: 'Rewrite?',
      actions: [{ id: 'keep', label: 'Keep as is (recommended)' }, { id: 'rewrite-plan', label: 'Rewrite history, plan first' }],
      sender: { sessionId: 's-hist', taskId: 't-hist', host: 'local' },
    });
    // What Main sent on 10-29: a text reply approving a rewrite, unpublish and deletes, on "clear everything".
    await expect(run('human_inbox_answer', {
      id: audit.id, user_words: 'clear everything about me',
      text: 'Rewrite the history, unpublish the npm versions we can, delete the old deploys.',
    }, 'main-session')).rejects.toThrow(/human-approval-required[\s\S]*rewriting git history[\s\S]*unpublishing[\s\S]*deleting/);
    await expect(run('human_inbox_answer', { id: history.id, action_id: 'rewrite-plan', user_words: 'clear it' }, 'main-session'))
      .rejects.toThrow(/human-approval-required/);
    expect((await getLetter(history.id))!.answered).toBeUndefined();
    expect((await getLetter(audit.id))!.thread).toHaveLength(0);
    // Words that name the step, or the option itself, go through; a plain option needs only the words.
    await run('human_inbox_answer', { id: history.id, action_id: 'keep', user_words: 'no need to rewrite history' }, 'main-session');
    expect((await getLetter(history.id))!.answered).toMatchObject({ actionId: 'keep', by: { userWords: 'no need to rewrite history' } });
    // "All as recommended" does not name the delete and the deprecate the recommendation holds.
    await expect(run('human_inbox_answer', { id: audit.id, action_id: 'all_recommended', user_words: '\u5168\u6309\u63a8\u8350\u5427' }, 'main-session'))
      .rejects.toThrow(/human-approval-required/);
    await run('human_inbox_answer', { id: audit.id, action_id: 'all_recommended', user_words: 'all as recommended: delete the screenshot, deprecate E' }, 'main-session');
    expect((await getLetter(audit.id))!.answered?.actionId).toBe('all_recommended');
    // The relay path a replica uses meets the same rule.
    const third = await sendLetter({
      subject: 'Unpublish 0.6.19?', type: 'action_required', markdown: 'x', actions: [{ id: 'go', label: 'Unpublish it' }],
      sender: { sessionId: 's-3x', taskId: 't-3x', host: 'local' },
    });
    await expect(handleHumanInboxRelayAction('answer', { id: third.id, actionId: 'go', callerSid: 'main-session', userWords: 'ok' })).rejects.toMatchObject({ status: 403 });
    await handleHumanInboxRelayAction('answer', { id: third.id, actionId: 'go', callerSid: 'main-session', userWords: 'yes unpublish 0.6.19' });
    expect((await getLetter(third.id))!.answered?.by?.userWords).toBe('yes unpublish 0.6.19');
  });

  it('a decision letter nobody needs is settled with its reason; a completed task settles its own', async () => {
    const blocked = await sendLetter({
      subject: 'Upload blocked: accept the agreement', type: 'action_required', markdown: 'x', actions: [{ id: 'accepted', label: 'Accepted' }],
      sender: { sessionId: 's-tf', taskId: 't-tf', host: 'local' },
    });
    await expect(run('human_inbox_mark', { id: blocked.id, settled: '  ' }, 's-tf')).rejects.toThrow();
    const out = await run('human_inbox_mark', { id: blocked.id, settled: 'The agreement was accepted; build 140 uploaded' }, 's-tf');
    expect(out.letter).toMatchObject({ archived: true, settled: { reason: 'The agreement was accepted; build 140 uploaded' } });
    const stored = (await getLetter(blocked.id))!;
    expect(stored.archivedReason).toBe('settled');
    expect((await run('human_inbox_list', {})).letters.map((l: { id: string }) => l.id)).not.toContain(blocked.id);

    // Completing the task settles its open decision letter, whoever completes it.
    const task = await addTask({ title: 'Ship build 141' });
    const ask = await sendLetter({
      subject: 'Accept the agreement', type: 'action_required', markdown: 'x', actions: [{ id: 'ok', label: 'Done' }],
      sender: { sessionId: 's-141', taskId: task.task.id, host: 'local' },
    });
    const other = await sendLetter({
      subject: 'Pinned ask', type: 'action_required', markdown: 'x', actions: [{ id: 'ok', label: 'Done' }], pin: true,
      sender: { sessionId: 's-141', taskId: task.task.id, host: 'local' },
    });
    await completeTask(task.task.id);
    let got = await getLetter(ask.id);
    for (let i = 0; i < 100 && !got?.archived; i++) { await new Promise((r) => setTimeout(r, 20)); got = await getLetter(ask.id); }
    expect(got).toMatchObject({ archived: true, archivedReason: 'settled' });
    expect(got!.settled!.reason).toMatch(/Ship build 141.*completed/);
    expect((await getLetter(other.id))!.archived).toBe(false);
  });

  it('a report letter from a task answering another task\'s request is refused, unless the user asked for it', async () => {
    const lead = await addTask({ title: 'Walnut lead' });
    const worker = await addTask({ title: 'Daemon timeout fix', parent_task_id: lead.task.id });
    await createSessionRecord('s-lead', lead.task.id, '', WALNUT_HOME);
    await createSessionRecord('s-worker', worker.task.id, '', WALNUT_HOME);
    const rq = await createSessionRequest({ fromSessionId: 's-lead', toTaskId: worker.task.id, toSessionId: 's-worker', text: 'Fix the timeout. Reply when done' });
    const send = (extra: Record<string, unknown> = {}) => run('human_inbox_send', { subject: 'Fixed and live', type: 'info', markdown: 'Done.', ...extra }, 's-worker');
    await expect(send()).rejects.toThrow(new RegExp(`Walnut lead[\\s\\S]*${rq.id}[\\s\\S]*in_reply_to`));
    // Answered a minute ago: still the asker's news to tell.
    await settleReplied(rq.id);
    await expect(send({ type: 'completion' })).rejects.toThrow(/already went to it/);
    // A decision still goes: the task is blocked on the user.
    expect((await send({ type: 'action_required', actions: [{ id: 'a', label: 'A' }] })).letterId).toBeTruthy();
    // The user asked this task for the report.
    expect((await send({ user_asked: true })).letterId).toBeTruthy();
    // A task nobody asked sends as before.
    const solo = await addTask({ title: 'Daily digest' });
    await createSessionRecord('s-solo', solo.task.id, '', WALNUT_HOME);
    expect((await run('human_inbox_send', { subject: 'Digest', type: 'info', markdown: 'x' }, 's-solo')).letterId).toBeTruthy();
    // A worker's question to its lead never silences the lead; a pinned standing report always goes.
    await createSessionRequest({ fromSessionId: 's-worker', toTaskId: lead.task.id, toSessionId: 's-lead', text: 'Which port?' });
    expect((await run('human_inbox_send', { subject: 'Team report', type: 'review', markdown: 'x' }, 's-lead')).letterId).toBeTruthy();
    await createSessionRequest({ fromSessionId: 's-lead', toTaskId: worker.task.id, toSessionId: 's-worker', text: 'Status? Reply when done' });
    expect((await send({ pin: true })).letterId).toBeTruthy();
    // Another project's lead asking does not speak for this task's work; its own project's lead does.
    const sender = (await addTask({ title: 'Inbox polish', project: 'Walnut' })).task;
    const otherLead = (await addTask({ title: 'Marina lead', project: 'Marina' })).task;
    const ownLead = (await addTask({ title: 'Walnut VP', project: 'Walnut' })).task;
    await updateTaskRaw(otherLead.id, { org_role: 'lead' } as never);
    await updateTaskRaw(ownLead.id, { org_role: 'lead' } as never);
    await createSessionRecord('s-sender', sender.id, 'Walnut', WALNUT_HOME);
    await createSessionRecord('s-marina', otherLead.id, 'Marina', WALNUT_HOME);
    await createSessionRecord('s-vp', ownLead.id, 'Walnut', WALNUT_HOME);
    await createSessionRequest({ fromSessionId: 's-marina', toTaskId: sender.id, toSessionId: 's-sender', text: 'Which port do you use?' });
    expect((await run('human_inbox_send', { subject: 'Polish shipped', type: 'info', markdown: 'x' }, 's-sender')).letterId).toBeTruthy();
    await createSessionRequest({ fromSessionId: 's-vp', toTaskId: sender.id, toSessionId: 's-sender', text: 'Ship it. Reply when done' });
    await expect(run('human_inbox_send', { subject: 'Polish shipped', type: 'info', markdown: 'x' }, 's-sender')).rejects.toThrow(/Walnut VP/);
  });
});
