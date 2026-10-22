import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { z } from 'zod';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('inbox-item-e2e', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js';
import { registerInboxMailSource } from '../../src/core/human-inbox/item-source-registry.js';
import { definePluginOp } from '../../src/ops/registry.js';
import { getTask, listTasks } from '../../src/core/task-manager.js';
import { executeOp } from '../../src/ops/index.js';
let server: Server;
let root: string;
let daemon: MockDaemon;
let unregister: () => void;
let op: { dispose(): unknown };
let calls = 0;
const providerCalls: { account: string; messages: string[]; read: boolean }[] = [];
const flags = new Map<string, boolean>([[JSON.stringify(['account-a', 'message-0']), false], [JSON.stringify(['account-b', 'message-0']), false]]);
const legacy = new Map<string, string>();
async function api(path: string, body?: unknown) {
  const res = await fetch(`${root}/api/v1${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
beforeAll(async () => {
  daemon = await createMockDaemon();
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`);
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  unregister = registerInboxMailSource({ resolve: async source => ({ source, key: `cache:${JSON.stringify([source.account, source.message])}`,
    adapter: { legacyTaskId: async key => legacy.get(key), writeLegacy: async (key, id) => { legacy.set(key, legacy.get(key) ?? id); } } }) });
  op = definePluginOp('fixture-mail', { name: 'mail_mark_read', title: 'Flag fixture mail', description: 'Test provider only', input: { account: z.string(), messages: z.array(z.string()), read: z.boolean() }, tags: { readonly: false, remote: 'deny' }, handler: async args => { calls++; providerCalls.push(args); for (const message of args.messages) flags.set(JSON.stringify([args.account, message]), args.read); return JSON.stringify({ account: args.account, read: args.read, changed: 1 }); } });
});
afterAll(async () => { unregister(); op.dispose(); sessionRunner.setTestDaemonUrl(undefined); await stopServer(); await daemon.stop(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });
describe('Real isolated Inbox item execution', () => {
  it('POST task create persists one idempotent task and rejects conflicting payloads', async () => {
    const payload = { title: 'Idempotent API task', project: '', description: 'Approved goal', idempotency_key: 'api-fixture-key' };
    const responses = await Promise.all([api('/tasks', payload), api('/tasks', payload)]);
    expect(responses[0].body.task.id).toBe(responses[1].body.task.id);
    expect(responses.filter(r => r.body.reused === true)).toHaveLength(1);
    const conflict = await api('/tasks', { ...payload, description: 'Different approved goal' });
    expect(conflict.status).toBe(409); expect(conflict.body.error.code).toBe('idempotency_conflict');
  });
  it('registry task_create shares the same claim under concurrent calls and conflicts on changed payloads', async () => {
    const payload = { title: 'Registry idempotent task', project: '', description: 'Confirmed registry goal', idempotency_key: 'registry-fixture-key', record_only: true };
    const before = (await listTasks()).length;
    const outcomes = await Promise.all([executeOp('task_create', payload, { apiBase: root, origin: '__local__', callerMode: 'human' }), executeOp('task_create', payload, { apiBase: root, origin: '__local__', callerMode: 'human' })]);
    expect(outcomes.every(outcome => outcome.ok)).toBe(true);
    const ids = outcomes.map(outcome => outcome.ok ? (outcome.result as { id: string }).id : undefined);
    expect(ids[0]).toBeDefined(); expect(ids[0]).toBe(ids[1]);
    expect((await listTasks()).length).toBe(before + 1);
    const conflict = await executeOp('task_create', { ...payload, description: 'Another human goal' }, { apiBase: root, origin: '__local__', callerMode: 'human' });
    expect(conflict.ok).toBe(false);
    expect((await listTasks()).length).toBe(before + 1);
  });
  it('sends thirty typed items, starts only one exact reserved task and keeps independent mail facts', async () => {
    const items = Array.from({ length: 30 }, (_, n) => ({ id: `mail-${n}`, subject: `Fixture update ${n}`, summary: 'Untrusted summary must not enter the instruction', source: { kind: 'mail', account: 'account-a', message: `message-${n}` }, actions: [{ id: `read-${n}`, kind: 'op', intent: 'mark_read' }, { id: `create-${n}`, kind: 'op', intent: 'create_task' }] }));
    const sent = await api('/human-inbox', { subject: 'Mail snapshot', type: 'review', markdown: 'Mailbox snapshot', items });
    expect(sent.status).toBe(201);
    const letterId = sent.body.id;
    const base = `/human-inbox/${letterId}/items/mail-0`;
    const prepare = await api(`${base}/prepare`, { actionId: 'create-0', title: 'Review update', project: '', goal: 'Report the approved status' });
    expect(prepare.status).toBe(200); expect(prepare.body.plan).toBeDefined();
    const plan = prepare.body.plan;
    expect(plan.ops.map((p: { tool: string }) => p.tool)).toEqual(['task_create', 'task_start']);
    const request = { actionId: plan.actionId, requestId: 'e2e-create', confirmed: true, planId: plan.id, planVersion: plan.version };
    vi.stubEnv('WALNUT_SESSION_ID', 'sender-must-not-be-inherited');
    try { expect((await api(`${base}/execute`, request)).status).toBe(202); }
    finally { vi.unstubAllEnvs(); }
    await vi.waitFor(async () => {
      const status = await api(`${base}/execution`);
      expect(status.body.receipts.at(-1).status).toBe('success');
      expect(status.body.receipts.at(-1).execution).toBe('running');
    }, { timeout: 25_000, interval: 100 });
    const task = await getTask(plan.taskId);
    expect(task.last_start?.state).toBe('started'); expect(task.session_ids).toHaveLength(1);
    expect(task.description).toContain('Report the approved status');
    const spawnCalls = daemon.getCommandHistory().filter(command => command.cmd === 'start');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].payload.message).toContain('Report the approved status');
    expect(spawnCalls[0].payload.message).not.toContain('Untrusted summary');
    expect(task.description).not.toContain('Untrusted summary');
    expect(task.parent_task_id).toBeUndefined(); expect(task.group_id).toBeUndefined();
    const originalAttempt = task.last_start?.id;
    await api(`${base}/execute`, request);
    expect((await getTask(plan.taskId)).last_start?.id).toBe(originalAttempt);
    const markPlan = (await api(`${base}/prepare`, { actionId: 'read-0' })).body.plan;
    await api(`${base}/execute`, { actionId: markPlan.actionId, requestId: 'e2e-read', planId: markPlan.id, planVersion: markPlan.version });
    await vi.waitFor(async () => expect((await api(`${base}/execution`)).body.receipts.filter((r: { intent: string; status: string }) => r.intent === 'mark_read')[0].status).toBe('success'));
    expect(calls).toBe(1);
    expect(providerCalls).toEqual([{ account: 'account-a', messages: ['message-0'], read: true }]);
    expect(flags.get(JSON.stringify(['account-a', 'message-0']))).toBe(true);
    expect(flags.get(JSON.stringify(['account-b', 'message-0']))).toBe(false);
    const detail = (await api(`/human-inbox/${letterId}`)).body.letter;
    expect(detail.items).toHaveLength(30); expect(detail.answered).toBeUndefined(); expect(detail.read).toBe(false);
  });
});
