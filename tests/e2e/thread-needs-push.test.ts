/**
 * A thread that waits on the user buzzes his phone, against a real server (2026-11-04, Walnut VP
 * for the user: "Evan wants no duplicates, not no reminders"; push/thread-push.ts). Each case has
 * its own lead, whose session moves its threads through thread_update and thread_create; Apple's
 * service is the only stand-in, so what reaches it is what the phone would get. Every move into
 * needs logs one `thread push` line, which the cases wait on instead of a sleep. Covered: the push
 * goes out with the node and the thread and no letter is made; staying in needs, answered and
 * pending do not buzz; back into needs buzzes again; a second thread of the absence stays quiet;
 * nothing while he is in the chat; a thread opened answered never buzzes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('thread-needs-push-e2e', { IS_EPHEMERAL: true }));
const sendApns = vi.hoisted(() => vi.fn(async (targets: unknown[]) => ({ attempted: true, sent: targets.length, failed: 0, deadTokens: [] as string[] })));
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns,
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test' })),
}));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { listLetters } from '../../src/core/human-inbox/store.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { updateConfig } from '../../src/core/config-manager.js';
import { executeOp } from '../../src/ops/index.js';
import { fileThreadMessage, readThreads } from '../../src/core/org/threads-store.js';
import { log } from '../../src/logging/index.js';

let server: Server;
let root: string;
const KIND = { user_kind: 'spending', user_kind_why: 'It buys a paid plan for the team' };
/** Every `thread push` line: one per move into needs (push/thread-push.ts). */
const lines: Array<{ threadId?: string; sent?: number; reason?: string }> = [];

interface Lead { id: string; sid: string }
let n = 0;
async function newLead(): Promise<Lead> {
  const lead = (await addTask({ title: `VP ${++n}`, project: `Proj${n}`, source: 'local', org_role: 'lead' } as never)).task;
  const sid = `tnp-lead-${n}`;
  await createSessionRecord(sid, lead.id, `Proj${n}`);
  return { id: lead.id, sid };
}
const run = async (lead: Lead, name: string, args: Record<string, unknown>) => {
  const out = await executeOp(name, args, { apiBase: root, origin: '__local__', callerMode: 'session', callerSid: lead.sid });
  if (!out.ok) throw new Error(out.message);
  return out.result as Record<string, any>;
};
const away = (lead: Lead) => updateSessionRecord(lead.sid, { chatInputAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() } as never);
const present = (lead: Lead) => updateSessionRecord(lead.sid, { chatInputAt: new Date().toISOString() } as never);
/** The payloads Apple's service was handed, in order. */
const pushed = () => sendApns.mock.calls.map((c) => (c as unknown as [unknown, Record<string, unknown>])[1]);
/** Wait for this thread's `count`th push line, then return it. */
async function pushLine(threadId: string, count = 1) {
  await vi.waitFor(() => expect(lines.filter((l) => l.threadId === threadId).length).toBeGreaterThanOrEqual(count), { timeout: 5_000, interval: 25 });
  return lines.filter((l) => l.threadId === threadId)[count - 1];
}
const buzzMark = (lead: Lead, id: string) => vi.waitFor(async () => expect((await readThreads(lead.id)).threads.find((t) => t.id === id)?.needsBuzzedAt).toBeTruthy(), { timeout: 5_000, interval: 25 });
async function asked(lead: Lead, text: string): Promise<string> {
  return (await fileThreadMessage(lead.id, { text, via: 'chat', at: new Date().toISOString() })).thread.id;
}

beforeAll(async () => {
  for (const level of ['info', 'warn', 'error'] as const) {
    const orig = log.notif[level].bind(log.notif);
    vi.spyOn(log.notif, level).mockImplementation(((msg: string, fields?: Record<string, unknown>) => {
      if (msg === 'thread push') lines.push(fields as never);
      return orig(msg, fields as never);
    }) as never);
  }
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // One phone, registered here with no device name (no pairing to judge: paired-rows.ts).
  await updateConfig({ push_tokens: [{ token: 'a'.repeat(64), platform: 'ios' }] } as never);
});
afterAll(async () => { vi.restoreAllMocks(); await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });
beforeEach(() => { sendApns.mockClear(); });

describe('a thread that waits on him', () => {
  it('buzzes once when it moves into needs, with the node and the thread, and no letter is made; again only on a new entry', async () => {
    const lead = await newLead();
    await away(lead);
    const letters = (await listLetters()).letters.length;
    const id = await asked(lead, 'Should we buy the paid plan?');
    await run(lead, 'thread_update', { id, title: 'Buy the paid plan?', ask: 'Pick a plan for the team', state: 'needs', ...KIND });
    expect(await pushLine(id)).toMatchObject({ sent: 1 });
    expect(sendApns).toHaveBeenCalledTimes(1);
    expect(pushed()[0]).toMatchObject({ aps: { alert: { title: 'Buy the paid plan?', body: 'Pick a plan for the team' } }, type: 'org_thread', taskId: lead.id, threadId: id });
    expect((await listLetters()).letters.length).toBe(letters);
    await buzzMark(lead, id);

    // Still in needs with a new summary, then answered, then pending: no new line, no buzz.
    await run(lead, 'thread_update', { id, reply: 'Still waiting: the team plan or the solo one' });
    await run(lead, 'thread_update', { id, state: 'answered', reply: 'Bought the team plan' });
    await run(lead, 'thread_update', { id, state: 'pending' });
    // Back into needs: a new entry buzzes again. Its line is the second: nothing came in between.
    await run(lead, 'thread_update', { id, state: 'needs', ...KIND });
    expect(await pushLine(id, 2)).toMatchObject({ sent: 1 });
    expect(lines.filter((l) => l.threadId === id)).toHaveLength(2);
    expect(sendApns).toHaveBeenCalledTimes(2);
  });

  it('a second thread of the same absence stays quiet: one buzz per absence', async () => {
    const lead = await newLead();
    await away(lead);
    const first = await asked(lead, 'Buy the plan?');
    await run(lead, 'thread_update', { id: first, state: 'needs', ...KIND });
    expect(await pushLine(first)).toMatchObject({ sent: 1 });
    await buzzMark(lead, first);
    const second = await asked(lead, 'Renew the domain?');
    await run(lead, 'thread_update', { id: second, state: 'needs', ...KIND });
    expect(await pushLine(second)).toMatchObject({ sent: 0, reason: expect.stringMatching(/another thread/) });
    expect(sendApns).toHaveBeenCalledTimes(1);
  });

  it('nothing while he is in the node\'s chat', async () => {
    const lead = await newLead();
    await present(lead);
    const id = await asked(lead, 'Delete the old bucket?');
    await run(lead, 'thread_update', { id, state: 'needs', user_kind: 'cloud_delete', user_kind_why: 'It deletes a cloud bucket for good' });
    expect(await pushLine(id)).toMatchObject({ sent: 0, reason: expect.stringMatching(/in the node's chat/) });
    expect(sendApns).not.toHaveBeenCalled();
  });

  it('a thread the node opens answered never buzzes; one it opens waiting on him does', async () => {
    const lead = await newLead();
    await away(lead);
    const answered = await run(lead, 'thread_create', { title: 'A mail answered', text: 'The organizer confirmed the date', from: 'mail', state: 'answered' });
    const waiting = await run(lead, 'thread_create', { title: 'Answer the organizer', text: 'A mail asks for a date', from: 'mail', ...KIND });
    const waitingId = waiting.thread?.id ?? waiting.id;
    expect(await pushLine(waitingId)).toMatchObject({ sent: 1 });
    expect(lines.some((l) => l.threadId === (answered.thread?.id ?? answered.id))).toBe(false);
    expect(sendApns).toHaveBeenCalledTimes(1);
  });
});
