/**
 * router_route's cross-area handoff, through the real HTTP entry (POST /api/v1/router/route).
 *
 * A real server on port 0 over this file's own mocked WALNUT_HOME: areas file, router ledgers,
 * handoff receipts, tasks and session records are real. Faked at their module boundaries only:
 * the approvals store (in memory, so nothing is pushed to a device), the session send and the
 * receiver start (so no CLI is spawned), and the `slack` source adapter (exact-source cache).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateInput, WaitResult } from '../../src/core/approvals/store.js';
import type { ApprovalRecord, ApprovalView } from '../../src/core/approvals/types.js';
import type { SessionSendInput } from '../../src/core/sessions/session-send-core.js';
import type { SessionStartParams } from '../../src/core/sessions/task-start.js';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-handoff-route'));

const fake = vi.hoisted(() => ({
  records: new Map<string, ApprovalRecord & { token: string }>(),
  create: vi.fn<(input: CreateInput) => Promise<{ approval: ApprovalView; waitToken: string }>>(),
  get: vi.fn<(id: string) => Promise<ApprovalRecord | undefined>>(),
  wait: vi.fn<(id: string, token: string | undefined, waitMs: number) => Promise<WaitResult>>(),
  list: vi.fn<(opts?: { status?: 'pending' | 'all' }) => Promise<ApprovalView[]>>(),
  cancel: vi.fn<(id: string, reason: string) => Promise<unknown>>(),
  send: vi.fn<(input: SessionSendInput) => Promise<unknown>>(),
  start: vi.fn<(params: SessionStartParams) => Promise<unknown>>(),
}));

vi.mock('../../src/core/approvals/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/approvals/store.js')>()),
  createApproval: (input: CreateInput) => fake.create(input),
  getApproval: (id: string) => fake.get(id),
  waitApproval: (id: string, token: string | undefined, waitMs: number) => fake.wait(id, token, waitMs),
  listApprovals: (opts?: { status?: 'pending' | 'all' }) => fake.list(opts),
  cancelInternal: (id: string, reason: string) => fake.cancel(id, reason),
}));
vi.mock('../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/sessions/session-send-core.js')>()),
  performSessionSend: (input: SessionSendInput) => fake.send(input),
}));
vi.mock('../../src/core/sessions/task-start.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/sessions/task-start.js')>()),
  startSessionForTask: (params: SessionStartParams) => fake.start(params),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord, listSessions, updateSessionRecord } from '../../src/core/session-tracker.js';
import { updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js';
import { routerAreaProfile, type RouterAreaRole } from '../../src/core/router/session-policy.js';
import { registerRouterSource, RouterSourceError, type RouterItemContent } from '../../src/core/router/source-registry.js';
import { routerKey } from '../../src/core/router/store.js';
import { disposeRouterStores, routerStore } from '../../src/core/router/runtime.js';
import { isRouterDelivery } from '../../src/core/router/delivery-scope.js';
import { approvalDigest } from '../../src/core/approvals/digest.js';
import type { Task } from '../../src/core/types.js';
import type { RouterItem, RouterSource } from '../../src/core/router/types.js';

const PERSONAL = 'desk@marina.example.invalid';
const WORK = 'workshop@marina.example.invalid';
const at = (account: string, message: string): RouterSource => ({ kind: 'slack', account, message });

const P_SAME = at(PERSONAL, 'C1:3001');
const P_FROZEN = at(PERSONAL, 'C1:3002');
const P_NOBODY = at(PERSONAL, 'C1:3003');
const P_DENY = at(PERSONAL, 'C1:3004');
const P_EXPIRE = at(PERSONAL, 'C1:3005');
const P_OWNER = at(PERSONAL, 'C1:3006');
const P_PERSON = at(PERSONAL, 'C1:3007');
const P_RACE = at(PERSONAL, 'C1:3008');
const P_CHANGED = at(PERSONAL, 'C1:3009');
const P_MISS = at(PERSONAL, 'C1:3010');
const P_FULL = at(PERSONAL, 'C1:3011');
const P_RETRY = at(PERSONAL, 'C1:3012');
const P_UNCERTAIN = at(PERSONAL, 'C1:3013');
const P_UNASSIGNED = at(PERSONAL, 'C1:3999');
const W_ITEM = at(WORK, 'C2:4001');
const ASSIGNED_PERSONAL = [P_SAME, P_FROZEN, P_NOBODY, P_DENY, P_EXPIRE, P_OWNER, P_PERSON, P_RACE, P_CHANGED, P_MISS, P_FULL, P_RETRY, P_UNCERTAIN];

const canary = (source: RouterSource) => `BODY_CANARY_${source.message.replace(':', '_')}`;
const bodies = new Map<string, string | null>();
const missing = new Set<string>();
const itemOf = (source: RouterSource): RouterItem => ({
  source, key: routerKey(source), sender: 'pat@marina.example.invalid', subject: `SUBJECT_${source.message.replace(':', '_')}`,
});
const resolve = vi.fn(async (source: RouterSource) => {
  if (missing.has(source.message)) throw new RouterSourceError('source_missing', 'The item is not in the cache.');
  return itemOf(source);
});
const read = vi.fn(async (source: RouterSource): Promise<RouterItemContent> => {
  if (missing.has(source.message)) throw new RouterSourceError('source_missing', 'The item is not in the cache.');
  const body = bodies.has(source.message) ? bodies.get(source.message)! : canary(source);
  return {
    item: itemOf(source), body: body === null ? null : { text: body }, bodyAvailable: body !== null,
    attachments: [{ filename: 'rota.pdf', mimeType: 'application/pdf', bytes: 2048 }], attachmentsAvailable: false,
  };
});

// In-memory approvals: the fields handoff-approval.ts binds to, nothing pushed.
fake.create.mockImplementation(async (input) => {
  const id = `apr-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (input.timeoutMs ?? 600_000)).toISOString();
  const token = `wait-token-${randomUUID()}`;
  const rec: ApprovalRecord & { token: string } = {
    id, what: input.what, ...(input.detail ? { detail: input.detail } : {}), mode: input.mode,
    ...(input.guard ? { guard: input.guard } : {}), ...(input.testRun ? { testRun: input.testRun } : {}),
    requester: input.requester, createdAt, expiresAt, status: 'pending', waitTokenHash: 'fixture', token,
    digest: approvalDigest({ id, mode: input.mode, createdAt, expiresAt, host: input.requester.host,
      taskId: input.requester.taskId, what: input.what, detail: input.detail }),
  };
  fake.records.set(id, rec);
  return { approval: view(rec), waitToken: token };
});
fake.get.mockImplementation(async (id) => {
  const rec = fake.records.get(id);
  if (!rec) return undefined;
  const { token: _t, ...out } = structuredClone(rec);
  return out;
});
fake.wait.mockImplementation(async (id, token) => {
  const rec = fake.records.get(id)!;
  if (token !== rec.token || rec.status === 'pending' || rec.consumedAt) return { approval: view(rec), used: false };
  rec.consumedAt = new Date().toISOString();
  return { approval: view(rec), used: true };
});
fake.list.mockImplementation(async (opts) => [...fake.records.values()]
  .filter((rec) => opts?.status === 'all' || rec.status === 'pending').map(view));
fake.cancel.mockImplementation(async (id) => { const rec = fake.records.get(id); if (rec) rec.status = 'canceled'; });

const sends: Array<{ input: SessionSendInput; inScope: boolean }> = [];
fake.send.mockImplementation(async (input) => {
  sends.push({ input, inScope: isRouterDelivery(String(input.to), input.messageId) });
  return { delivered: true };
});
const startedSids: string[] = [];
fake.start.mockImplementation(async (params) => {
  const sid = randomUUID();
  await createSessionRecord(sid, params.taskIdPrefix, '', WALNUT_HOME, { mode: 'bypass', initialProcessStatus: 'stopped' });
  startedSids.push(sid);
  return { taskId: params.taskIdPrefix, title: 'Started', sessionId: sid, started: true };
});

function view(rec: ApprovalRecord & { token?: string }): ApprovalView {
  const { waitTokenHash: _h, token: _t, ...out } = structuredClone(rec);
  return out;
}
function answer(id: string, status: 'approved' | 'denied' | 'expired') {
  const rec = fake.records.get(id)!;
  rec.status = status;
  if (status !== 'expired') {
    rec.answer = { decision: status === 'approved' ? 'approve' : 'deny', at: new Date().toISOString(), mode: 'tap', device: { name: 'Test phone', kind: 'iphone' } };
  }
}

let base = '';
let stopSource = () => {};
const ids = { router: '', routerB: '', receiverA: '', workRouter: '', workReceiver: '', vp: '', notebook: '' };
const sids = { router: randomUUID(), routerB: randomUUID(), receiverA: randomUUID(), workRouter: randomUUID(), workReceiver: randomUUID(), notebook: randomUUID() };

async function post(sid: string | undefined, body: unknown): Promise<Response> {
  return fetch(`${base}/api/v1/router/route`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) }, body: JSON.stringify(body),
  });
}
function codeOf(json: { code?: string; error?: unknown }): string | undefined {
  return typeof json.error === 'object' && json.error ? (json.error as { code?: string }).code : json.code;
}
const handoff = (source: RouterSource, extra: Record<string, unknown> = {}) => ({
  source, task_id: ids.workReceiver, text: `Brief for ${source.message}: check the dock invoice.`, reason: 'The invoice belongs to the workshop.', ...extra,
});
async function ask(source: RouterSource, extra: Record<string, unknown> = {}, sid: string | undefined = sids.router): Promise<string> {
  const response = await post(sid, handoff(source, extra));
  expect(response.status).toBe(200);
  const json = await response.json();
  expect(json).toMatchObject({ status: 'needs_approval', approval: { status: 'pending' } });
  return json.approval.approvalId as string;
}
async function noLedger(source: RouterSource) {
  expect(await routerStore('personal').getSource(source)).toBeUndefined();
  expect(await routerStore('personal').get(routerKey(source))).toBeUndefined();
}

async function seedSession(sid: string, taskId: string, areaId?: string, role?: RouterAreaRole) {
  await createSessionRecord(sid, taskId, '', WALNUT_HOME, areaId ? { profile: routerAreaProfile(areaId, role), mode: 'dontAsk' } : { mode: 'bypass' });
  await updateSessionRecord(sid, { process_status: 'stopped' });
}
async function mark(taskId: string, patch: Record<string, unknown>) {
  await updateTaskRaw(taskId, patch as Partial<Task>, { source: 'router-areas', emitEvent: false });
}
function areas(active: 'A' | 'B'): RouterAreasFile {
  return {
    version: 1,
    areas: [
      { id: 'personal', name: 'Personal', host: '__local__', taskIds: [ids.router, ids.routerB, ids.receiverA], sources: [{ kind: 'slack', account: PERSONAL }] },
      { id: 'work', name: 'Work', host: '__local__', taskIds: [ids.workRouter, ids.workReceiver], sources: [{ kind: 'slack', account: WORK }] },
    ],
    routers: [
      { taskId: ids.router, areaId: 'personal', paused: active !== 'A' },
      { taskId: ids.routerB, areaId: 'personal', paused: active !== 'B' },
      { taskId: ids.workRouter, areaId: 'work', paused: false },
    ],
    items: [...ASSIGNED_PERSONAL.map((source) => ({ source, areaId: 'personal' })), { source: W_ITEM, areaId: 'work' }],
  };
}

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ids.router = (await addTask({ title: 'Personal router', project: 'Garden' })).task.id;
  ids.routerB = (await addTask({ title: 'Personal router B', project: 'Garden' })).task.id;
  ids.receiverA = (await addTask({ title: 'Desk rota', project: 'Garden' })).task.id;
  ids.workRouter = (await addTask({ title: 'Work router', project: 'Workshop' })).task.id;
  ids.workReceiver = (await addTask({ title: 'Dock invoices', project: 'Workshop' })).task.id;
  ids.vp = (await addTask({ title: 'Operations VP', project: 'Harbourside' })).task.id;
  ids.notebook = (await addTask({ title: 'Notebook', project: 'Harbourside' })).task.id;
  await updateRouterAreas(WALNUT_HOME, () => areas('A'));
  await mark(ids.router, { org_role: 'router', router_area_id: 'personal', router_paused: false });
  await mark(ids.routerB, { org_role: 'router', router_area_id: 'personal', router_paused: true });
  await mark(ids.workRouter, { org_role: 'router', router_area_id: 'work', router_paused: false });
  await mark(ids.receiverA, { router_area_id: 'personal' });
  await mark(ids.workReceiver, { router_area_id: 'work' });
  // An older VP in no area: no area mark, full tools, and no session until a handoff starts one.
  await mark(ids.vp, { org_role: 'lead', org_name: 'Operations VP' });
  await seedSession(sids.router, ids.router, 'personal', 'router');
  await seedSession(sids.routerB, ids.routerB, 'personal', 'router');
  await seedSession(sids.workRouter, ids.workRouter, 'work', 'router');
  await seedSession(sids.receiverA, ids.receiverA, 'personal', 'work');
  await seedSession(sids.workReceiver, ids.workReceiver, 'work', 'work');
  await seedSession(sids.notebook, ids.notebook);
  stopSource = registerRouterSource('slack', { resolve, read });
});

afterAll(async () => {
  try {
    stopSource();
    await disposeRouterStores();
    await stopServer();
  } finally {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  }
});

beforeEach(() => {
  resolve.mockClear(); read.mockClear();
  fake.create.mockClear(); fake.wait.mockClear(); fake.send.mockClear(); fake.start.mockClear();
  sends.length = 0;
});

describe('a cross-area target waits for the person', () => {
  it('pending: one person-guarded ask, no ledger row, no send, and no body in the answer', async () => {
    const response = await post(sids.router, handoff(P_FROZEN));
    expect(response.status).toBe(200);
    const text = await response.text();
    const json = JSON.parse(text);
    expect(json).toMatchObject({ status: 'needs_approval', approval: { status: 'pending' } });
    expect(text).not.toContain(canary(P_FROZEN));
    expect(fake.create).toHaveBeenCalledTimes(1);
    const input = fake.create.mock.calls[0][0];
    expect(input).toMatchObject({ guard: 'person', mode: 'tap', requester: { host: '__local__', taskId: ids.router } });
    expect(input.requester.sessionId).toBeUndefined();
    expect(input.testRun).toBeUndefined();
    // The person reads the cached body; the router does not get it back.
    expect(input.detail).toContain(canary(P_FROZEN));
    expect(read).toHaveBeenCalledWith(P_FROZEN);
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.wait).not.toHaveBeenCalled();
    await noLedger(P_FROZEN);

    const context = await fetch(`${base}/api/v1/router/context?${new URLSearchParams({ ...P_FROZEN })}`, { headers: { 'x-walnut-caller-sid': sids.router } });
    expect(context.status).toBe(200);
    const contextText = await context.text();
    expect(JSON.parse(contextText).handoffs).toEqual([expect.objectContaining({
      approvalId: json.approval.approvalId, targetTaskId: ids.workReceiver, targetScope: 'work', status: 'pending',
    })]);
    expect(contextText).not.toContain(fake.records.get(json.approval.approvalId)!.token);
  });

  it('an item with no cached body still asks, and says so to the person', async () => {
    bodies.set(P_NOBODY.message, null);
    const id = await ask(P_NOBODY, { task_id: ids.vp });
    expect(fake.records.get(id)!.detail).toContain('(No cached body.)');
    expect(fake.records.get(id)!.detail).toContain('an older task in no area');
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();
    await noLedger(P_NOBODY);
  });

  it('a caller with no session id (the person) also gets only a pending ask', async () => {
    const response = await post(undefined, handoff(P_PERSON));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({ status: 'needs_approval', approval: { status: 'pending' } });
    expect(fake.create.mock.calls[0][0].requester.taskId).toBe(ids.router);
    const early = await post(undefined, handoff(P_PERSON, { approval_id: json.approval.approvalId }));
    expect(early.status).toBe(200);
    expect(await early.json()).toMatchObject({ status: 'needs_approval', approval: { approvalId: json.approval.approvalId, status: 'pending' } });
    expect(fake.wait).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
    await noLedger(P_PERSON);
  });

  it('two concurrent asks for the same handoff make one approval', async () => {
    const [a, b] = await Promise.all([post(sids.router, handoff(P_RACE)), post(sids.router, handoff(P_RACE))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [ja, jb] = [await a.json(), await b.json()];
    expect(ja.approval.approvalId).toBe(jb.approval.approvalId);
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(fake.send).not.toHaveBeenCalled();
    await noLedger(P_RACE);
  });
});

describe('a no, or no answer, delivers nothing', () => {
  it('denied: refused, nothing used or sent, and asking again does not ask the person again', async () => {
    const id = await ask(P_DENY);
    answer(id, 'denied');
    fake.create.mockClear();
    const response = await post(sids.router, handoff(P_DENY, { approval_id: id }));
    expect(response.status).toBe(403);
    expect(codeOf(await response.json())).toBe('denied');
    const again = await post(sids.router, handoff(P_DENY));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: 'needs_approval', approval: { approvalId: id, status: 'denied' } });
    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.wait).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
    await noLedger(P_DENY);
  });

  it('expired: refused, nothing used or sent; a later ask is a new one', async () => {
    const id = await ask(P_EXPIRE);
    answer(id, 'expired');
    const response = await post(sids.router, handoff(P_EXPIRE, { approval_id: id }));
    expect(response.status).toBe(409);
    expect(codeOf(await response.json())).toBe('expired');
    expect(fake.wait).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
    await noLedger(P_EXPIRE);
    const fresh = await ask(P_EXPIRE);
    expect(fresh).not.toBe(id);
  });
});

describe('a yes delivers the frozen item once', () => {
  it('sends the body frozen at the ask after the cache changed, to the isolated receiver, once', async () => {
    // The ask was made in the first test; find it by its context row.
    const [{ approvalId }] = (await (await fetch(`${base}/api/v1/router/context?${new URLSearchParams({ ...P_FROZEN })}`,
      { headers: { 'x-walnut-caller-sid': sids.router } })).json()).handoffs;
    bodies.set(P_FROZEN.message, 'CHANGED_BODY_CANARY_C1_3002');
    answer(approvalId, 'approved');
    read.mockClear();

    const response = await post(sids.router, handoff(P_FROZEN, { approval_id: approvalId }));
    expect(response.status).toBe(202);
    const json = await response.json();
    expect(json).toMatchObject({ status: 'receipt', fresh: true,
      route: { status: 'routed', taskId: ids.workReceiver, byTaskId: ids.router, areaId: 'personal', target: { id: ids.workReceiver } } });
    expect(read).not.toHaveBeenCalled();
    expect(fake.wait).toHaveBeenCalledTimes(1);
    expect(fake.records.get(approvalId)!.consumedAt).toBeTruthy();
    expect(sends).toHaveLength(1);
    const [{ input, inScope }] = sends;
    expect(inScope).toBe(true);
    expect(input).toMatchObject({ to: sids.workReceiver, title: 'One incoming item approved for this handoff',
      messageId: json.route.messageId, expectReply: false, source: 'api-agent' });
    expect(input.callerSid).toBeUndefined();
    expect(input.text).toContain(canary(P_FROZEN));
    expect(input.text).not.toContain('CHANGED_BODY_CANARY');
    expect(input.text).toContain(`Brief for ${P_FROZEN.message}: check the dock invoice.`);
    expect(fake.start).not.toHaveBeenCalled();
    expect(await routerStore('personal').getSource(P_FROZEN)).toMatchObject({ status: 'routed', taskId: ids.workReceiver });

    // A repeat reads the exact source's receipt first; nothing is resolved, used or sent again.
    resolve.mockClear();
    for (const body of [handoff(P_FROZEN, { approval_id: approvalId }), handoff(P_FROZEN)]) {
      const again = await post(sids.router, body);
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ fresh: false, route: { status: 'routed', taskId: ids.workReceiver, messageId: json.route.messageId } });
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(sends).toHaveLength(1);
    expect(fake.wait).toHaveBeenCalledTimes(1);
    expect(fake.create).not.toHaveBeenCalled();

    // The receiver reads the frozen copy, not the changed cache.
    const item = await fetch(`${base}/api/v1/router/item?${new URLSearchParams({ ...P_FROZEN })}`, { headers: { 'x-walnut-caller-sid': sids.workReceiver } });
    expect(item.status).toBe(200);
    const itemText = await item.text();
    expect(itemText).toContain(canary(P_FROZEN));
    expect(itemText).not.toContain('CHANGED_BODY_CANARY');
  });

  it('an unscoped legacy VP with no session gets one started in its own scope, and the no-body copy', async () => {
    const [{ approvalId }] = (await (await fetch(`${base}/api/v1/router/context?${new URLSearchParams({ ...P_NOBODY })}`,
      { headers: { 'x-walnut-caller-sid': sids.router } })).json()).handoffs;
    answer(approvalId, 'approved');
    const response = await post(sids.router, handoff(P_NOBODY, { task_id: ids.vp, approval_id: approvalId }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'receipt', fresh: true, route: { status: 'routed', taskId: ids.vp, target: { kind: 'vp' } } });
    expect(fake.start).toHaveBeenCalledTimes(1);
    const params = fake.start.mock.calls[0][0];
    expect(params).toMatchObject({ taskIdPrefix: ids.vp, source: 'api-agent', idle: true, awaitStart: true, expectReply: false });
    expect(params.callerSid).toBeUndefined();
    expect(sends).toHaveLength(1);
    expect(sends[0].input.to).toBe(startedSids.at(-1));
    expect(sends[0].inScope).toBe(true);
    expect(sends[0].input.text).toContain('(No cached body.)');
  });

  it('two concurrent uses of one yes deliver exactly once', async () => {
    const [{ approvalId }] = (await (await fetch(`${base}/api/v1/router/context?${new URLSearchParams({ ...P_RACE })}`,
      { headers: { 'x-walnut-caller-sid': sids.router } })).json()).handoffs;
    answer(approvalId, 'approved');
    const responses = await Promise.all([1, 2].map(() => post(sids.router, handoff(P_RACE, { approval_id: approvalId }))));
    const results = await Promise.all(responses.map(async (r) => ({ status: r.status, json: await r.json() })));
    // The winner delivers (202); the loser reads its receipt, early (200) or from inside the handoff (200 or 202).
    const winner = results.find((r) => r.json.fresh === true)!;
    const loser = results.find((r) => r.json.fresh === false)!;
    expect(winner).toMatchObject({ status: 202, json: { status: 'receipt', route: { status: 'routed' } } });
    expect([200, 202]).toContain(loser.status);
    expect(loser.json.route).toMatchObject({ taskId: ids.workReceiver, messageId: winner.json.route.messageId });
    expect(sends).toHaveLength(1);
    expect(fake.wait).toHaveBeenCalledTimes(1);
    expect(await routerStore('personal').getSource(P_RACE)).toMatchObject({ status: 'routed', taskId: ids.workReceiver });
  });
});

describe('an approval is bound to its asker and its exact handoff', () => {
  it('another router of the same area cannot use the first router\'s yes', async () => {
    const id = await ask(P_OWNER);
    answer(id, 'approved');
    await updateRouterAreas(WALNUT_HOME, () => areas('B'));
    await mark(ids.router, { router_paused: true });
    await mark(ids.routerB, { router_paused: false });
    try {
      const response = await post(sids.routerB, handoff(P_OWNER, { approval_id: id }));
      expect(response.status).toBe(403);
      expect(codeOf(await response.json())).toBe('not_owner');
      expect(fake.wait).not.toHaveBeenCalled();
      expect(fake.records.get(id)!.consumedAt).toBeUndefined();
      expect(fake.send).not.toHaveBeenCalled();
      await noLedger(P_OWNER);
    } finally {
      await updateRouterAreas(WALNUT_HOME, () => areas('A'));
      await mark(ids.routerB, { router_paused: true });
      await mark(ids.router, { router_paused: false });
    }
  });

  it('malformed or mismatched uses change nothing; the exact one still delivers once', async () => {
    const id = await ask(P_CHANGED);
    answer(id, 'approved');
    fake.create.mockClear();
    const refusals: Array<[string, Record<string, unknown>, number, string]> = [
      ['a non-string id', { approval_id: 42 }, 400, 'bad_approval'],
      ['an empty id', { approval_id: '  ' }, 400, 'bad_approval'],
      ['an over-long id', { approval_id: 'a'.repeat(201) }, 400, 'bad_approval'],
      ['no target', { approval_id: id, task_id: undefined }, 400, 'bad_handoff'],
      ['a not-routed decision', { approval_id: id, task_id: undefined, not_routed: true }, 400, 'bad_handoff'],
      ['a delivery retry without a failed receipt', { approval_id: id, retry: true }, 409, 'retry_not_safe'],
      ['new work', { approval_id: id, new_task_title: 'Fresh work' }, 400, 'bad_handoff'],
      ['no brief', { approval_id: id, text: '' }, 400, 'bad_handoff'],
      ['another target', { approval_id: id, task_id: ids.vp }, 409, 'handoff_changed'],
      ['another brief', { approval_id: id, text: 'A different brief.' }, 409, 'handoff_changed'],
      ['another reason', { approval_id: id, reason: 'Another reason.' }, 409, 'handoff_changed'],
      ['a same-area target', { approval_id: id, task_id: ids.receiverA }, 409, 'same_area'],
      ['an unknown approval', { approval_id: 'apr-not-asked' }, 404, 'not_found'],
    ];
    // Each refusal meets an approved item with no receipt, so no earlier receipt can answer for it.
    for (const [name, extra, status, code] of refusals) {
      await noLedger(P_CHANGED);
      const response = await post(sids.router, handoff(P_CHANGED, extra));
      expect(response.status, name).toBe(status);
      expect(codeOf(await response.json()), name).toBe(code);
    }
    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.wait).not.toHaveBeenCalled();
    expect(fake.records.get(id)!.consumedAt).toBeUndefined();
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();
    await noLedger(P_CHANGED);

    const exact = await post(sids.router, handoff(P_CHANGED, { approval_id: id }));
    expect(exact.status).toBe(202);
    expect(await exact.json()).toMatchObject({ status: 'receipt', fresh: true, route: { status: 'routed', taskId: ids.workReceiver } });
    expect(sends).toHaveLength(1);
    expect(sends[0].input.to).toBe(sids.workReceiver);
  });
});

describe('access is checked before any target or source lookup', () => {
  it('a full-tool session outside any area is refused before its target is looked up', async () => {
    for (const body of [
      { source: P_FULL, task_id: 'task-that-does-not-exist', text: 'Brief.', reason: 'Taking it.' },
      handoff(P_FULL, { approval_id: 'apr-not-asked' }),
      handoff(P_FULL),
    ]) {
      const response = await post(sids.notebook, body);
      expect(response.status).toBe(403);
      expect(codeOf(await response.json())).toBe('area_forbidden');
    }
    for (const sid of ['external', randomUUID()]) {
      const response = await post(sid, handoff(P_FULL));
      expect(response.status).toBe(403);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
    await noLedger(P_FULL);
  });

  it('a sibling message of the same account with no confirmed area is refused before the adapter', async () => {
    for (const sid of [sids.router, undefined]) {
      const response = await post(sid, handoff(P_UNASSIGNED));
      expect(response.status).toBe(409);
      expect(codeOf(await response.json())).toBe('area_unassigned');
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(fake.create).not.toHaveBeenCalled();
    await noLedger(P_UNASSIGNED);
  });

  it('another area\'s router cannot hand on this area\'s item, and its own item is not read for it', async () => {
    const response = await post(sids.workRouter, handoff(P_FULL));
    expect(response.status).toBe(403);
    expect(codeOf(await response.json())).toBe('area_forbidden');
    const crossed = await post(sids.router, handoff(W_ITEM));
    expect(crossed.status).toBe(403);
    expect(codeOf(await crossed.json())).toBe('area_forbidden');
    expect(resolve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(fake.create).not.toHaveBeenCalled();
    expect(await routerStore('work').getSource(W_ITEM)).toBeUndefined();
  });

  it('retries an explicitly refused handoff once with the same frozen body and message id, never asking or using approval again', async () => {
    const approvalId = await ask(P_RETRY);
    answer(approvalId, 'approved');
    fake.send.mockRejectedValueOnce(Object.assign(new Error('Queue is full'), { code: 'queue_full' }));
    const rejected = await post(sids.router, handoff(P_RETRY, { approval_id: approvalId }));
    expect(rejected.status).toBe(200);
    const first = await rejected.json();
    expect(first.route.status).toBe('failed');
    expect(fake.records.get(approvalId)!.consumedAt).toBeTruthy();
    bodies.set(P_RETRY.message, 'CHANGED_BODY_MUST_NOT_BE_RETRIED');
    fake.send.mockClear(); fake.wait.mockClear(); fake.create.mockClear();
    const retried = await post(sids.router, handoff(P_RETRY, { retry: true, approval_id: approvalId }));
    expect(retried.status).toBe(202);
    expect(await retried.json()).toMatchObject({ route: { status: 'routed', messageId: first.route.messageId } });
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.send.mock.calls[0][0].text).toContain(canary(P_RETRY));
    expect(fake.send.mock.calls[0][0].text).not.toContain('CHANGED_BODY_MUST_NOT_BE_RETRIED');
    expect(fake.wait).not.toHaveBeenCalled();
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('never retries a handoff whose send outcome was unknown', async () => {
    const approvalId = await ask(P_UNCERTAIN);
    answer(approvalId, 'approved');
    fake.send.mockRejectedValueOnce(new Error('Transport lost the answer'));
    const first = await post(sids.router, handoff(P_UNCERTAIN, { approval_id: approvalId }));
    expect(first.status).toBe(200);
    expect((await first.json()).route.status).toBe('unknown');
    fake.send.mockClear(); fake.wait.mockClear(); fake.create.mockClear();
    const retried = await post(sids.router, handoff(P_UNCERTAIN, { retry: true, approval_id: approvalId }));
    expect(retried.status).toBe(409);
    expect(codeOf(await retried.json())).toBe('retry_not_safe');
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.wait).not.toHaveBeenCalled();
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('a cache miss answers 503 source_unavailable and uses, asks, records and sends nothing', async () => {
    const id = await ask(P_MISS);
    answer(id, 'approved');
    fake.create.mockClear();
    missing.add(P_MISS.message);
    for (const [name, body] of [
      ['the approved use', handoff(P_MISS, { approval_id: id })],
      ['a new ask', handoff(P_MISS)],
      ['same-area work', { source: P_MISS, task_id: ids.receiverA, text: 'Please check the desk rota.', reason: 'The rota is this desk\'s work.' }],
    ] as const) {
      const response = await post(sids.router, body);
      expect(response.status, name).toBe(503);
      const text = await response.text();
      expect(codeOf(JSON.parse(text)), name).toBe('source_unavailable');
      expect(text).not.toContain(canary(P_MISS));
      await noLedger(P_MISS);
    }
    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.wait).not.toHaveBeenCalled();
    expect(fake.records.get(id)!.consumedAt).toBeUndefined();
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();
  });
});

describe('routing inside the area is unchanged', () => {
  it('same-area work routes directly, with no approval', async () => {
    const response = await post(sids.router, {
      source: P_SAME, task_id: ids.receiverA, text: 'Please check the desk rota.', reason: 'The rota is this desk\'s work.',
    });
    expect(response.status).toBe(202);
    const json = await response.json();
    expect(json).toMatchObject({ fresh: true, route: { status: 'routed', taskId: ids.receiverA, areaId: 'personal' } });
    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.wait).not.toHaveBeenCalled();
    expect(sends).toHaveLength(1);
    expect(sends[0].inScope).toBe(true);
    expect(sends[0].input).toMatchObject({ to: sids.receiverA, title: 'An incoming item is routed to you', messageId: json.route.messageId });
    expect(sends[0].input.text).toContain('Please check the desk rota.');
  });
});

describe('nothing was spawned', () => {
  it('every session record is one this file seeded or the fake start made', async () => {
    const known = new Set([...Object.values(sids), ...startedSids]);
    const records = await listSessions();
    for (const record of records) expect(known.has(record.claudeSessionId), record.claudeSessionId).toBe(true);
    expect(startedSids).toHaveLength(1);
  });
});
