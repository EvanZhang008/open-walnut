/**
 * One place per update, against a real server (2026-11-04, the user, after a VP sent each thread
 * result as a letter too while he was away: "Only choose one, put it in thread or inbox ... if it is
 * just a thread just put it there without sending it to inbox"). A lead's or Main's letter about one
 * of its open threads is refused (409 thread_instead, the thread named) through the op, the HTTP
 * route and the cloud relay; what has no open thread, a worker's letter, a pinned one, one he asked
 * for as a letter, the report he asks for (org_report) and Walnut's own letters still go.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('thread-instead-e2e', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { listLetters, sendLetterOnce } from '../../src/core/human-inbox/store.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { executeOp } from '../../src/ops/index.js';
import { fileThreadMessage } from '../../src/core/org/threads-store.js';
import { handleHumanInboxRelayAction } from '../../src/core/human-inbox/relay.js';

let server: Server;
let root: string;
const LEAD_SID = 'ti-lead-session';
const MAIN_SID = 'ti-main-session';
const WORKER_SID = 'ti-worker-session';
let leadId = '';
let mainId = '';
let workerId = '';
let otherId = '';

const run = async (name: string, args: Record<string, unknown>, sid: string) => {
  const out = await executeOp(name, args, { apiBase: root, origin: '__local__', callerMode: 'session', callerSid: sid });
  if (!out.ok) throw new Error(out.message);
  return out.result as Record<string, any>;
};
const post = (path: string, body: Record<string, unknown>, sid: string) => fetch(`${root}/api/v1${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': sid }, body: JSON.stringify(body),
});
const subjects = async () => (await listLetters()).letters.map((l) => l.subject);
const KIND = { user_kind: 'spending', user_kind_why: 'It buys a paid plan for the team' };

/** His message filed as a thread of the node, then the node's own write: the task it went to and its result. */
async function threadOf(nodeId: string, sid: string, text: string, task: string): Promise<string> {
  const filed = await fileThreadMessage(nodeId, { text, via: 'chat', at: new Date().toISOString() });
  await run('thread_update', { id: filed.thread.id, title: text.slice(0, 40), state: 'answered', add_tasks: [task], reply: 'Shipped, video at /x/star.mp4' }, sid);
  return filed.thread.id;
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const lead = (await addTask({ title: 'Walnut VP', project: 'Walnut', source: 'local', org_role: 'lead' } as never)).task;
  leadId = lead.id;
  await createSessionRecord(LEAD_SID, lead.id, 'Walnut');
  const main = (await addTask({ title: 'Main', project: 'Walnut', source: 'local', org_role: 'main' } as never)).task;
  mainId = main.id;
  await createSessionRecord(MAIN_SID, main.id, 'Walnut');
  const worker = (await addTask({ title: 'Slack stars', project: 'Walnut', source: 'local', parent_task_id: lead.id } as never)).task;
  workerId = worker.id;
  await createSessionRecord(WORKER_SID, worker.id, 'Walnut');
  otherId = (await addTask({ title: 'Unrelated work', project: 'Walnut', source: 'local' } as never)).task.id;
});
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('a node\'s letter about one of its open threads', () => {
  it('is refused through the op, the route and the relay, with the thread named; nothing is sent', async () => {
    const thread = await threadOf(leadId, LEAD_SID, 'Star a Slack channel in Walnut', workerId);
    const before = (await listLetters()).letters.length;
    const result = { subject: 'Slack stars shipped (video)', type: 'info', markdown: 'Video: /x/star.mp4', task_refs: [workerId] };
    await expect(run('human_inbox_send', result, LEAD_SID)).rejects.toThrow(new RegExp(`thread_instead[\\s\\S]*${thread}[\\s\\S]*thread_update`));
    const res = await post('/human-inbox', result, LEAD_SID);
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('thread_instead');
    expect(body.error?.message).toContain(thread);
    await expect(handleHumanInboxRelayAction('send', { ...result, callerSid: LEAD_SID })).rejects.toMatchObject({ status: 409, code: 'thread_instead' });
    // A decision on the thread is its needs state, not a letter.
    await expect(run('human_inbox_send', { subject: 'Buy the Slack plan?', type: 'action_required', markdown: 'A or B', actions: [{ id: 'a', label: 'A' }], task_refs: [workerId], ...KIND }, LEAD_SID))
      .rejects.toThrow(/thread_instead[\s\S]*needs/);
    // Naming no task right after it wrote the thread: the same thread.
    await expect(run('human_inbox_send', { subject: 'Done, video attached', type: 'completion', markdown: 'see /x/star.mp4' }, LEAD_SID))
      .rejects.toThrow(new RegExp(`thread_instead[\\s\\S]*just put a result in[\\s\\S]*${thread}`));
    expect((await listLetters()).letters.length).toBe(before);
  });

  it('Main is held to it too', async () => {
    const thread = await threadOf(mainId, MAIN_SID, 'How is the Slack work going', workerId);
    await expect(run('human_inbox_send', { subject: 'Slack: shipped', type: 'info', markdown: 'Live.', task_refs: [workerId] }, MAIN_SID))
      .rejects.toThrow(new RegExp(`thread_instead[\\s\\S]*${thread}`));
    // A thread handed to the VP does not hold the VP's other work: Main's decision naming the VP goes.
    await threadOf(mainId, MAIN_SID, 'Ask the VP about the board', leadId);
    const vpWork = await run('human_inbox_send', { subject: 'The VP needs a paid plan: buy it?', type: 'action_required', markdown: 'A or B', actions: [{ id: 'a', label: 'A' }], task_refs: [leadId], ...KIND }, MAIN_SID);
    expect(vpWork.letterId).toMatch(/^lt-/);
  });
});

describe('what still goes', () => {
  it('a letter about work on none of its threads, a pinned one, one he asked for as a letter', async () => {
    const ok = await run('human_inbox_send', { subject: 'Clean 37 GB of caches on the Mac?', type: 'action_required', markdown: 'Rebuildable only.', actions: [{ id: 'yes', label: 'Yes' }], task_refs: [otherId], ...KIND }, LEAD_SID);
    expect(ok.letterId).toMatch(/^lt-/);
    // A decision naming no task right after a thread write: only its tasks would tie it to a thread.
    await threadOf(leadId, LEAD_SID, 'Rename the board', workerId);
    const loose = await run('human_inbox_send', { subject: 'Renew the domain for a year?', type: 'action_required', markdown: '12 USD.', actions: [{ id: 'yes', label: 'Yes' }], ...KIND }, LEAD_SID);
    expect(loose.letterId).toMatch(/^lt-/);
    const pinned = await run('human_inbox_send', { subject: 'Weekly digest', type: 'info', markdown: 'Digest.', task_refs: [workerId], pin: true }, LEAD_SID);
    expect(pinned.letterId).toMatch(/^lt-/);
    const asked = await run('human_inbox_send', { subject: 'The star video, as you asked by mail', type: 'info', markdown: '/x/star.mp4', task_refs: [workerId], user_asked: true }, LEAD_SID);
    expect(asked.letterId).toMatch(/^lt-/);
  });

  it('a worker\'s own letter, the report he asks for, and Walnut\'s own letters', async () => {
    const worker = await run('human_inbox_send', { subject: 'Slack wants a new token: approve?', type: 'action_required', markdown: 'A or B', actions: [{ id: 'a', label: 'A' }], task_refs: [workerId], user_kind: 'credentials', user_kind_why: 'It is a new sign-in token for Slack' }, WORKER_SID);
    expect(worker.letterId).toMatch(/^lt-/);
    const report = await run('org_report', { send: true }, LEAD_SID);
    expect(report.letterId).toMatch(/^lt-/);
    const system = await sendLetterOnce({
      subject: 'Sign in to clouddev again', type: 'action_required', markdown: 'The login expired.', actions: [{ id: 'ok', label: 'Done' }],
      sender: { sessionId: 'walnut', host: 'local', taskId: leadId }, taskRefs: [workerId],
    } as never);
    expect(system.letter.id).toMatch(/^lt-/);
    expect(await subjects()).toEqual(expect.arrayContaining(['Slack wants a new token: approve?', 'Sign in to clouddev again']));
  });
});
