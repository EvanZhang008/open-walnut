/**
 * A thread that waits on the user buzzes his phone, against a real server (2026-11-04, Walnut VP
 * for the user: "Evan wants no duplicates, not no reminders"; push/thread-push.ts). The lead moves
 * its threads through thread_update and thread_create as a session would; Apple's service is the
 * only stand-in, so what reaches it is what the phone would get. Covered: the push goes out with
 * the node and the thread and no letter is made; staying in needs, answered and pending do not
 * buzz; back into needs buzzes again; a second thread of the absence stays quiet; nothing while he
 * is in the chat.
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

let server: Server;
let root: string;
const LEAD_SID = 'tnp-lead-session';
let leadId = '';
const KIND = { user_kind: 'spending', user_kind_why: 'It buys a paid plan for the team' };

const run = async (name: string, args: Record<string, unknown>) => {
  const out = await executeOp(name, args, { apiBase: root, origin: '__local__', callerMode: 'session', callerSid: LEAD_SID });
  if (!out.ok) throw new Error(out.message);
  return out.result as Record<string, any>;
};
const away = () => updateSessionRecord(LEAD_SID, { chatInputAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() } as never);
const present = () => updateSessionRecord(LEAD_SID, { chatInputAt: new Date().toISOString() } as never);
/** The payloads Apple's service was handed, in order. */
const pushed = () => sendApns.mock.calls.map((c) => (c as unknown as [unknown, Record<string, unknown>])[1]);
/** Let the push (it runs after the write, off the request) finish. */
const settle = () => new Promise((r) => setTimeout(r, 400));
async function asked(text: string): Promise<string> {
  return (await fileThreadMessage(leadId, { text, via: 'chat', at: new Date().toISOString() })).thread.id;
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const lead = (await addTask({ title: 'Walnut VP', project: 'Walnut', source: 'local', org_role: 'lead' } as never)).task;
  leadId = lead.id;
  await createSessionRecord(LEAD_SID, lead.id, 'Walnut');
  // One phone, registered here with no device name (no pairing to judge: paired-rows.ts).
  await updateConfig({ push_tokens: [{ token: 'a'.repeat(64), platform: 'ios' }] } as never);
});
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });
beforeEach(() => { sendApns.mockClear(); });

describe('a thread that waits on him', () => {
  it('buzzes once when it moves into needs, with the node and the thread, and no letter is made', async () => {
    await away();
    const letters = (await listLetters()).letters.length;
    const id = await asked('Should we buy the paid plan?');
    await run('thread_update', { id, title: 'Buy the paid plan?', ask: 'Pick a plan for the team', state: 'needs', ...KIND });
    await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 25 });
    expect(pushed()[0]).toMatchObject({ aps: { alert: { title: 'Buy the paid plan?', body: 'Pick a plan for the team' } }, type: 'org_thread', taskId: leadId, threadId: id });
    expect((await listLetters()).letters.length).toBe(letters);
    // The buzz is recorded on the thread right after the device service took it.
    await vi.waitFor(async () => expect((await readThreads(leadId)).threads.find((t) => t.id === id)?.needsBuzzedAt).toBeTruthy(), { timeout: 5_000, interval: 25 });

    sendApns.mockClear();
    // Still in needs with a new summary, then answered, then pending: no buzz.
    await run('thread_update', { id, reply: 'Still waiting: the team plan or the solo one' });
    await run('thread_update', { id, state: 'answered', reply: 'Bought the team plan' });
    await run('thread_update', { id, state: 'pending' });
    await settle();
    expect(sendApns).not.toHaveBeenCalled();

    // Back into needs: a new entry buzzes again.
    await run('thread_update', { id, state: 'needs', ...KIND });
    await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 25 });
  });

  it('a second thread of the same absence stays quiet: one buzz per absence', async () => {
    await away();
    const id = await asked('Renew the domain?');
    await run('thread_update', { id, state: 'needs', ...KIND });
    await settle();
    expect(sendApns).not.toHaveBeenCalled();
  });

  it('nothing while he is in the node\'s chat, nor for a thread opened answered', async () => {
    await present();
    const id = await asked('Delete the old bucket?');
    await run('thread_update', { id, state: 'needs', user_kind: 'cloud_delete', user_kind_why: 'It deletes a cloud bucket for good' });
    await run('thread_create', { title: 'A mail answered', text: 'The organizer confirmed the date', from: 'mail', state: 'answered' });
    await settle();
    expect(sendApns).not.toHaveBeenCalled();
  });
});
