/**
 * The user away from a lead's chat, against a real server (2026-10-31, the user before going to
 * sleep: important updates to the inbox while he is not in the chat, one thread, a morning report).
 * The lead's letters go through human_inbox_send as a session would send them; the bus events say
 * which ones buzz the phone (`quiet` = no push, core/push/letter-push.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('away-inbox-e2e', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { getLetter, listLetters, setLetterState } from '../../src/core/human-inbox/store.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js';
import { executeOp } from '../../src/ops/index.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { prepareHintedSend } from '../../src/core/hints/hint-send.js';
import { scheduledReports, tickReports } from '../../src/core/org/morning-report.js';

let server: Server;
let root: string;
const LEAD_SID = 'away-lead-session';
const WORKER_SID = 'away-worker-session';
let leadId = '';
const events: Array<{ letterId: string; kind: string; quiet?: boolean }> = [];

const run = async (name: string, args: Record<string, unknown>, sid: string) => {
  const out = await executeOp(name, args, { apiBase: root, origin: '__local__', callerMode: 'session', callerSid: sid });
  if (!out.ok) throw new Error(out.message);
  return out.result as Record<string, any>;
};
const typedAgo = (ms: number) => updateSessionRecord(LEAD_SID, { chatInputAt: new Date(Date.now() - ms).toISOString() } as never);
const lastEvent = () => events.at(-1)!;

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  bus.subscribe('away-inbox-test', (e) => {
    if (e.name === EventNames.HUMAN_INBOX_LETTER) events.push(e.data as never);
  }, { global: true, interest: ['human-inbox:'] });
  const lead = (await addTask({ title: 'Walnut lead', project: 'Walnut', source: 'local', org_role: 'lead' } as never)).task;
  leadId = lead.id;
  await createSessionRecord(LEAD_SID, lead.id, 'Walnut');
  const worker = (await addTask({ title: 'A worker', project: 'Walnut', source: 'local', parent_task_id: lead.id } as never)).task;
  await createSessionRecord(WORKER_SID, worker.id, 'Walnut');
});
afterAll(async () => { bus.unsubscribe('away-inbox-test'); await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('a lead the user is away from', () => {
  it('present: a letter is a letter; away: one thread, one buzz until he reads it', async () => {
    await typedAgo(60_000);
    const present = await run('human_inbox_send', { subject: 'Pick a name', type: 'action_required', markdown: 'A or B', actions: [{ id: 'a', label: 'A' }] }, LEAD_SID);
    expect((await getLetter(present.letterId)).awayThread).toBeUndefined();
    expect(lastEvent()).toMatchObject({ letterId: present.letterId, kind: 'new' });
    expect(lastEvent().quiet).toBeUndefined();

    await typedAgo(2 * 60 * 60_000);
    const first = await run('human_inbox_send', { subject: 'Deploy is live', type: 'info', markdown: 'Prod serves **abc**.', text: 'Prod serves abc' }, LEAD_SID);
    expect(first.addedToThread).toBeUndefined();
    expect((await getLetter(first.letterId)).awayThread).toMatchObject({ taskId: leadId });
    expect(lastEvent()).toMatchObject({ letterId: first.letterId, kind: 'new' });
    expect(lastEvent().quiet).toBeUndefined();

    const before = (await listLetters()).letters.length;
    const second = await run('human_inbox_send', { subject: 'Review the plan', type: 'review', markdown: 'See /x/plan.md' }, LEAD_SID);
    expect(second).toMatchObject({ letterId: first.letterId, addedToThread: true });
    expect(second.instruction).toMatch(/joined your letter of this absence/);
    expect((await listLetters()).letters.length).toBe(before);
    const thread = (await getLetter(first.letterId)).thread;
    expect(thread.at(-1)).toMatchObject({ from: 'agent', text: 'Review the plan' });
    expect(thread.at(-1)!.body).toBe('See /x/plan.md');
    expect(lastEvent()).toMatchObject({ letterId: first.letterId, kind: 'reply', quiet: true });

    // He read it: the next turn is news, and buzzes once more.
    await setLetterState(first.letterId, 'read', true);
    await run('human_inbox_send', { subject: 'Tests green', type: 'completion', markdown: '461 passed' }, LEAD_SID);
    expect(lastEvent()).toMatchObject({ letterId: first.letterId, kind: 'reply' });
    expect(lastEvent().quiet).toBeUndefined();

    // A decision is its own letter (its buttons are the one tap), quiet while the thread is unread, named in it.
    const decision = await run('human_inbox_send', { subject: 'Start step one?', type: 'action_required', markdown: 'Two ways', actions: [{ id: 'go', label: 'Go' }, { id: 'later', label: 'Later' }] }, LEAD_SID);
    expect(decision.letterId).not.toBe(first.letterId);
    expect((await getLetter(decision.letterId)).actions?.map((a) => a.id)).toEqual(['go', 'later']);
    const newEvent = events.find((e) => e.letterId === decision.letterId);
    expect(newEvent).toMatchObject({ kind: 'new', quiet: true });
    expect((await getLetter(first.letterId)).thread.at(-1)!.text).toBe('Needs your answer: "Start step one?", in its own letter, where one tap answers it.');

    // A pinned standing report is its own letter, as before.
    const pinned = await run('human_inbox_send', { subject: 'Weekly digest', type: 'info', markdown: 'x', pin: true }, LEAD_SID);
    expect(pinned.letterId).not.toBe(first.letterId);

    // A worker's letter is never threaded: only Main and the leads have an away thread.
    const fromWorker = await run('human_inbox_send', { subject: 'Worker blocked', type: 'action_required', markdown: 'Need a key', actions: [{ id: 'ok', label: 'OK' }] }, WORKER_SID);
    expect((await getLetter(fromWorker.letterId)).awayThread).toBeUndefined();

    // He answered a letter on the phone (a person, not the chat): still away, still one thread.
    await updateSessionRecord(LEAD_SID, { humanInputAt: new Date().toISOString() } as never);
    const still = await run('human_inbox_send', { subject: 'Still going', type: 'info', markdown: 'z' }, LEAD_SID);
    expect(still).toMatchObject({ letterId: first.letterId, addedToThread: true });

        // He comes back and writes in the chat: letters are letters again.
    await typedAgo(0);
    const back = await run('human_inbox_send', { subject: 'One more', type: 'info', markdown: 'y' }, LEAD_SID);
    expect(back.letterId).not.toBe(first.letterId);
    expect((await getLetter(back.letterId)).awayThread).toBeUndefined();
  });

  it('two updates sent at once start one thread, not two letters', async () => {
    // A fresh absence: the earlier threads are put away.
    for (const l of (await listLetters()).letters) await setLetterState(l.id, 'archived', true);
    await typedAgo(2 * 60 * 60_000);
    const [a, b] = await Promise.all([
      run('human_inbox_send', { subject: 'Parallel one', type: 'info', markdown: '1' }, LEAD_SID),
      run('human_inbox_send', { subject: 'Parallel two', type: 'info', markdown: '2' }, LEAD_SID),
    ]);
    expect(a.letterId).toBe(b.letterId);
    expect([a.addedToThread, b.addedToThread].filter(Boolean)).toHaveLength(1);
    expect((await listLetters()).letters.map((l) => l.id)).toEqual([a.letterId]);
  });

  it('the lead hears it is away on the next message, once, and that he is back', async () => {
    await typedAgo(3 * 60 * 60_000);
    const rec = await getSessionByClaudeId(LEAD_SID);
    const away = await prepareHintedSend(LEAD_SID, rec, 'a worker finished', { sentBy: 'agent' });
    expect(away.hints.map((h) => h.kind)).toContain('user-away');
    expect(away.enqueueText).toMatch(/Walnut \(user-away\): the user has not been in this chat since/);
    await away.commit();
    const again = await prepareHintedSend(LEAD_SID, await getSessionByClaudeId(LEAD_SID), 'another note', { sentBy: 'agent' });
    expect(again.hints.map((h) => h.kind)).not.toContain('user-away');
    await again.commit();
    const person = await prepareHintedSend(LEAD_SID, await getSessionByClaudeId(LEAD_SID), 'I am back', { sentBy: 'person' });
    expect(person.enqueueText).toMatch(/the user is back in this chat/);
    // A worker never hears it.
    const worker = await prepareHintedSend(WORKER_SID, await getSessionByClaudeId(WORKER_SID), 'hi', { sentBy: 'agent' });
    expect(worker.hints.map((h) => h.kind)).not.toContain('user-away');
  });

  it('org_report: shown now, scheduled, sent by the clock as the lead\'s letter; refused for a worker', async () => {
    const now = await run('org_report', {}, LEAD_SID);
    expect(now.report.subject).toMatch(/^Report: \d+ Needs you, \d+ Completed/);
    expect(now.report.markdown).toMatch(/## Needs you/);

    const at = await run('org_report', { at: '8h' }, LEAD_SID);
    expect(Date.parse(at.scheduledAt) - Date.now()).toBeGreaterThan(7.9 * 60 * 60_000);
    expect(at.outcome).toMatch(/Scheduled: Walnut sends the report at/);
    expect((await scheduledReports()).map((s) => s.taskId)).toEqual([leadId]);
    // A new time replaces the old one.
    await run('org_report', { at: '9h' }, LEAD_SID);
    expect(await scheduledReports()).toHaveLength(1);

    expect(await tickReports(Date.now())).toBe(0);
    expect(await tickReports(Date.now() + 10 * 60 * 60_000)).toBe(1);
    expect(await scheduledReports()).toEqual([]);
    const sent = (await listLetters()).letters.find((l) => l.subject.startsWith('Report:'));
    expect(sent).toMatchObject({ type: 'info', sender: { sessionId: LEAD_SID, taskId: leadId } });

    const sendNow = await run('org_report', { send: true }, LEAD_SID);
    expect(sendNow.letterId).toMatch(/^lt-/);
    await expect(run('org_report', {}, WORKER_SID)).rejects.toThrow(/not Main or a lead/);
    await expect(run('org_report', { at: 'whenever' }, LEAD_SID)).rejects.toThrow(/HH:MM/);
  });
});
