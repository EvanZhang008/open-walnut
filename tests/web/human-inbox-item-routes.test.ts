import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { z } from 'zod';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('inbox-item-routes'));
vi.mock('../../src/core/notifications/letter-bridge.js', () => ({ ensureLetterBridge() {}, mirrorLetterReadState: async () => {} }));
import { humanInboxItemsV1Router } from '../../src/web/routes/human-inbox-items-v1.js';
import { sendLetter, getLetter } from '../../src/core/human-inbox/store.js';
import { registerInboxMailSource } from '../../src/core/human-inbox/item-source-registry.js';
import { definePluginOp } from '../../src/ops/registry.js';
import { setSelfApiRoot } from '../../src/lib/self-api-root.js';
import { addTask, updateTask } from '../../src/core/task-manager.js';
let server: Server;
let root: string;
let calls: Record<string, unknown>[] = [];
let cleanupSource: () => void;
let op: { dispose(): unknown };
let id: string;
const endpoint = (suffix: string) => `${root}/api/v1/human-inbox/${id}/items/mail-one/${suffix}`;
async function post(suffix: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(endpoint(suffix), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  cleanupSource = registerInboxMailSource({ resolve: async source => ({ key: `cache:${JSON.stringify([source.account, source.message])}`, source,
    adapter: { legacyTaskId: async () => undefined, writeLegacy: async () => {} } }) });
  op = definePluginOp('fixture-mail', { name: 'mail_mark_read', title: 'Read one fixture', description: 'Isolated flag', input: { account: z.string(), messages: z.array(z.string()), read: z.boolean() },
    tags: { readonly: false, remote: 'deny' }, handler: async args => { calls.push(args); return JSON.stringify({ account: args.account, read: true, changed: 1 }); } });
  const app = express(); app.use(express.json()); app.use('/api/v1', humanInboxItemsV1Router);
  app.use((error: Error, _req: unknown, res: express.Response, _next: unknown) => res.status(500).json({ error: error.message }));
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`; setSelfApiRoot(root);
  id = (await sendLetter({ subject: 'Route summary', type: 'info', markdown: 'Untrusted mail data', sender: { sessionId: 'sender-session', host: 'local' }, items: [{ id: 'mail-one', subject: 'One mail', summary: 'Summary', source: { kind: 'mail', account: 'account-a', message: 'same-id' }, actions: [{ id: 'read-one', kind: 'op', intent: 'mark_read' }, { id: 'find-one', kind: 'op', intent: 'find_task' }, { id: 'ask-one', kind: 'reply_ai', label: 'Explain this email', question: 'Explain this fixture update' }] }] })).id;
});
afterAll(async () => { cleanupSource(); op.dispose(); setSelfApiRoot(null); await new Promise<void>(resolve => server.close(() => resolve())); });
describe('Item API confirmation and source safety', () => {
  it('rejects remote-only execution and forged payload, then marks only the saved pair', async () => {
    const remote = await post('prepare', { actionId: 'read-one' }, { 'x-walnut-origin': 'remote-http' });
    expect(remote.body.restrictions[0].code).toBe('local_only');
    const prepared = await post('prepare', { actionId: 'read-one' });
    expect(prepared.status).toBe(200);
    const plan = prepared.body.plan;
    const payload = { actionId: 'read-one', requestId: 'route-request', planId: plan.id, planVersion: plan.version };
    expect((await post('execute', { ...payload, source: { account: 'other' } })).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await post('execute', payload)).status).toBe(202);
    await vi.waitFor(async () => expect((await fetch(endpoint('execution')).then(r => r.json())).receipts[0].status).toBe('success'));
    expect(calls).toEqual([{ account: 'account-a', messages: ['same-id'], read: true }]);
    await post('execute', payload);
    expect(calls).toHaveLength(1);
    expect((await getLetter(id))!.answered).toBeUndefined();
    expect((await getLetter(id))!.read).toBe(false);
  });
  it('shares exact-pair history across letters and requires confirmation to set read again', async () => {
    const other = await sendLetter({ subject: 'Another snapshot', type: 'review', markdown: 'Snapshot', sender: { sessionId: 'external', host: 'local' }, items: [{ id: 'another-item', subject: 'Same email', summary: 'Snapshot', source: { kind: 'mail', account: 'account-a', message: 'same-id' }, actions: [{ id: 'another-read', kind: 'op', intent: 'mark_read' }] }] });
    const base = `${root}/api/v1/human-inbox/${other.id}/items/another-item`;
    const snapshot = await fetch(`${base}/execution`).then(r => r.json());
    expect(snapshot.receipts).toHaveLength(1); expect(snapshot.receipts[0].status).toBe('success');
    const prepared = await post('prepare', { actionId: 'read-one', markReadAgain: true });
    const plan = prepared.body.plan;
    const request = { actionId: plan.actionId, requestId: 'read-again', planId: plan.id, planVersion: plan.version };
    expect((await post('execute', request)).body.error.code).toBe('confirmation_required');
    expect(calls).toHaveLength(1);
    await post('execute', { ...request, confirmed: true });
    await vi.waitFor(async () => expect((await fetch(endpoint('execution')).then(r => r.json())).receipts.at(-1).status).toBe('success'));
    expect(calls).toHaveLength(2);
    expect((await fetch(`${base}/execution`).then(r => r.json())).receipts).toHaveLength(2);
  });
  it('asks only the origin AI with a stable queue id without answering the whole letter', async () => {
    const { createSessionRecord, updateSessionRecord } = await import('../../src/core/session-tracker.js');
    const { getQueue } = await import('../../src/core/session-message-queue.js');
    await createSessionRecord('sender-session', '', '', '/tmp');
    await updateSessionRecord('sender-session', { pendingPermission: { requestId: 'fixture-permission', toolName: 'Bash', input: {}, description: 'Fixture prompt', timestamp: Date.now() } });
    const prepared = await post('prepare', { actionId: 'ask-one' });
    const plan = prepared.body.plan;
    const request = { actionId: plan.actionId, requestId: 'ask-request', planId: plan.id, planVersion: plan.version };
    await post('execute', request);
    await vi.waitFor(async () => expect((await fetch(endpoint('execution')).then(r => r.json())).receipts.find((r: { intent: string }) => r.intent === 'reply_ai').delivery).toBe('deferred'));
    const queue = await getQueue('sender-session');
    expect(queue).toHaveLength(1); expect(queue[0].message).toContain('Explain this fixture update');
    expect(queue[0].id).toMatch(/^qm-inbox-ai-/);
    await post('execute', request);
    expect(await getQueue('sender-session')).toHaveLength(1);
    expect((await getLetter(id))!.answered).toBeUndefined();
    expect(calls).toHaveLength(2);
  });
  it('returns real paged candidates and rejects completed and stale targets without mutation', async () => {
    const tasks = await Promise.all(Array.from({ length: 3 }, (_, n) => addTask({ title: 'Same title', project: `Project ${n}`, description: `Goal ${n}` })));
    const page = await fetch(endpoint('tasks?query=Same&limit=2')).then(r => r.json());
    expect(page.tasks).toHaveLength(2); expect(page.total).toBe(3); expect(page.hasMore).toBe(true);
    const target = tasks[0].task;
    for (const routeId of [target.id.slice(0, 8), target.title, '#1']) {
      const before = calls.length;
      const invalid = await post('prepare', { actionId: 'find-one', selectedTaskId: routeId, goal: 'Human approved goal' });
      expect(invalid.body.plan).toBeUndefined();
      expect(invalid.status === 400 || invalid.status === 404 || invalid.body.restrictions?.length > 0).toBe(true);
      expect(calls).toHaveLength(before);
    }
    const preview = await fetch(endpoint(`tasks/${target.id}`)).then(r => r.json());
    expect(preview.description).toBe('Goal 0');
    const prepared = await post('prepare', { actionId: 'find-one', selectedTaskId: target.id, goal: 'Human approved goal' });
    expect(prepared.body.plan.ops[0].tool).toBe('task_start');
    await updateTask(target.id, { phase: 'COMPLETE' });
    const plan = prepared.body.plan;
    const result = await post('execute', { actionId: plan.actionId, requestId: 'stale-request', confirmed: true, planId: plan.id, planVersion: plan.version });
    expect(result.status).toBe(409); expect(result.body.error.code).toBe('task_changed');
    const completed = await post('prepare', { actionId: 'find-one', selectedTaskId: target.id, goal: 'Human approved goal' });
    expect(completed.body.restrictions[0].code).toBe('task_completed');
  });
});
