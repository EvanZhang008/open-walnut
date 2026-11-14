/**
 * A receiving task's own processing tools, router_item and router_work, on a real server.
 *
 * Everything here lives in this file's own mocked WALNUT_HOME: the areas file, the router ledgers
 * (real RouterStore SQLite, written with claim/settle exactly as a router's hand-off writes them),
 * the tasks and the session records. The source adapter is a fake for the `slack` kind (no
 * built-in plugin registers that kind, so nothing can race this registration) that returns canary
 * bodies; no model is spawned (every session record is stopped and nothing here starts one), and
 * no request reaches :3456.
 */
import { randomUUID } from 'node:crypto';
import { approvalDigest } from '../../src/core/approvals/digest.js';
import type { ApprovalRecord } from '../../src/core/approvals/types.js';
import type { HandoffDeps, HandoffSnapshot } from '../../src/core/router/handoff-approval.js';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
import { patchLegacyTask, seedLegacySession } from '../helpers/router-history-fixtures.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-processing'));

import { WALNUT_HOME } from '../../src/constants.js';
import { claimHandoffApproval, requestHandoffApproval } from '../../src/core/router/handoff-approval.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { updateRouterAreas } from '../../src/core/router/areas.js';
import { ROUTER_WORK_OPS } from '../../src/core/router/gateway-policy.js';
import { routerAreaProfile, type RouterAreaRole } from '../../src/core/router/session-policy.js';
import { registerRouterSource, RouterSourceError, type RouterItemContent } from '../../src/core/router/source-registry.js';
import { routerKey } from '../../src/core/router/store.js';
import { disposeRouterStores, routerStore } from '../../src/core/router/runtime.js';
import type { RouterItem, RouterSource } from '../../src/core/router/types.js';

const PERSONAL_ACCOUNT = 'desk@marina.example.invalid';
const WORK_ACCOUNT = 'workshop@marina.example.invalid';
const at = (account: string, message: string): RouterSource => ({ kind: 'slack', account, message });

// One item per ledger state the receiver may meet.
const P_MINE = at(PERSONAL_ACCOUNT, 'C1:1001');       // routed to receiver A
const P_ROUTING = at(PERSONAL_ACCOUNT, 'C1:1002');    // claimed for A, delivery outcome not known yet
const P_SIBLING = at(PERSONAL_ACCOUNT, 'C1:1003');    // routed to receiver B, same area
const P_FAILED = at(PERSONAL_ACCOUNT, 'C1:1004');     // claimed for A, delivery refused
const P_NOT_ROUTED = at(PERSONAL_ACCOUNT, 'C1:1005'); // decided to go nowhere
const P_NO_ROW = at(PERSONAL_ACCOUNT, 'C1:1006');     // assigned to the area, never routed
const P_UNKNOWN = at(PERSONAL_ACCOUNT, 'C1:1099');    // in no area at all
const W_ITEM = at(WORK_ACCOUNT, 'C2:2001');           // routed to the work area's receiver
const P_DONE = at(PERSONAL_ACCOUNT, 'C1:1007');       // routed to receiver C, which completes itself
const P_UNMARKED = at(PERSONAL_ACCOUNT, 'C1:1008');   // routed to receiver D, whose task carries no area marker
const P_APPROVED = at(PERSONAL_ACCOUNT, 'C1:1010');
const P_APPROVED_FAILED = at(PERSONAL_ACCOUNT, 'C1:1011');
// Two cached sources of one canonical item: the original was routed to A, the alias bound to its receipt.
const P_ORIGINAL = at(PERSONAL_ACCOUNT, 'C1:1020');
const P_ALIAS = at(PERSONAL_ACCOUNT, 'C1:1021');
// The same pair whose original then leaves the cache.
const P_GONE_ORIGINAL = at(PERSONAL_ACCOUNT, 'C1:1022');
const P_GONE_ALIAS = at(PERSONAL_ACCOUNT, 'C1:1023');
const canonicalOf = new Map([[P_ALIAS.message, P_ORIGINAL], [P_GONE_ALIAS.message, P_GONE_ORIGINAL]]);
const missing = new Set<string>();

const canary = (source: RouterSource) => `BODY_CANARY_${source.message.replace(':', '_')}`;
const itemOf = (source: RouterSource): RouterItem => ({
  source, key: routerKey(canonicalOf.get(source.message) ?? source), sender: 'pat@marina.example.invalid', subject: `SUBJECT_${canary(source)}`,
});
const resolve = vi.fn(async (source: RouterSource) => itemOf(source));
const read = vi.fn(async (source: RouterSource): Promise<RouterItemContent> => {
  if (missing.has(source.message)) throw new RouterSourceError('source_missing', 'The item is not in the cache.');
  return {
    item: itemOf(source), body: { text: canary(source) }, bodyAvailable: true,
    attachments: [{ filename: 'notes.txt', mimeType: 'text/plain', bytes: 12 }], attachmentsAvailable: false,
  };
});

let base = '';
let stopSource = () => {};
const ids = { personalRouter: '', receiverA: '', receiverB: '', receiverC: '', receiverD: '', workRouter: '', workReceiver: '' };
const sids = {
  router: randomUUID(), receiverA: randomUUID(), receiverB: randomUUID(), receiverC: randomUUID(), receiverD: randomUUID(),
  workReceiver: randomUUID(),
};

async function call(method: string, path: string, sid?: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(sid ? { 'x-walnut-caller-sid': sid } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const itemPath = (source: RouterSource) => `/api/v1/router/item?${new URLSearchParams({ ...source })}`;
const work = (sid: string | undefined, body: unknown) => call('POST', '/api/v1/router/work', sid, body);
/** The v1 routes answer `{error:{code}}`, the scope middleware `{code}`. */
function codeOf(json: { code?: string; error?: unknown }): string | undefined {
  return typeof json.error === 'object' && json.error ? (json.error as { code?: string }).code : json.code;
}

/**
 * The persisted markers a confirmed area gives its tasks (what PUT /router/areas and router setup
 * write), set directly so no router node is created and nothing is woken.
 */
async function mark(taskId: string, areaId: string, router = false) {
  await updateTaskRaw(taskId, router
    ? { org_role: 'router', router_area_id: areaId, router_paused: false }
    : { router_area_id: areaId }, { source: 'router-areas', emitEvent: false });
}

async function seedSession(sid: string, taskId: string, areaId: string, areaRole: RouterAreaRole) {
  await createSessionRecord(sid, taskId, '', WALNUT_HOME, { profile: routerAreaProfile(areaId, areaRole), mode: 'dontAsk' });
  await updateSessionRecord(sid, { process_status: 'stopped' });
}

/** A router's hand-off as the ledger records it: claim for a task, then the delivery's outcome. */
async function handOff(areaId: string, source: RouterSource, taskId: string, outcome: 'routed' | 'failed' | 'pending') {
  const claim = await routerStore(areaId).claim(itemOf(source), {
    status: 'routing', taskId, reason: 'Fixture hand-off', byTaskId: areaId === 'personal' ? ids.personalRouter : ids.workRouter,
  });
  expect(claim.fresh).toBe(true);
  if (outcome === 'pending') return;
  const settled = await routerStore(areaId).settle(claim.route.key, claim.route.messageId!, {
    status: outcome, ...(outcome === 'failed' ? { error: 'Refused by the fixture' } : {}),
  });
  expect(settled.settled).toBe(true);
}

async function approveFrozenItem(source: RouterSource): Promise<void> {
  const snapshot: HandoffSnapshot = {
    areaId: 'personal', source, canonicalKey: routerKey(source), targetTaskId: ids.workReceiver,
    targetScope: 'work', byTaskId: ids.personalRouter, brief: 'Check the dock invoice.', reason: 'One approved work item.',
    content: { item: itemOf(source), body: { text: 'FROZEN_APPROVED_CANARY' }, bodyAvailable: true,
      attachments: [], attachmentsAvailable: false },
  };
  let record: ApprovalRecord | undefined;
  const deps: HandoffDeps = {
    home: WALNUT_HOME, activeKeyCount: async () => 0, livePendingIds: async () => new Set(),
    createApproval: async (input) => {
      const id = `apr-${randomUUID()}`;
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 600_000).toISOString();
      record = { id, what: input.what, detail: input.detail, mode: input.mode, guard: input.guard,
        requester: input.requester, createdAt, expiresAt, status: 'pending', waitTokenHash: 'fixture',
        digest: approvalDigest({ id, mode: input.mode, createdAt, expiresAt, host: input.requester.host,
          taskId: input.requester.taskId, what: input.what, detail: input.detail }) };
      const { waitTokenHash: _hidden, ...view } = record;
      return { approval: view, waitToken: 'fixture-token' };
    },
    getApproval: async () => record,
    waitApproval: async () => {
      record!.consumedAt = new Date().toISOString();
      return { approval: record!, used: true };
    },
    cancelApproval: async () => undefined,
  };
  const ticket = await requestHandoffApproval(snapshot, {}, deps);
  record!.status = 'approved';
  record!.answer = { decision: 'approve', at: new Date().toISOString(), mode: 'tap', device: { name: 'Fixture', kind: 'iphone' } };
  const { content: _content, ...identity } = snapshot;
  expect((await claimHandoffApproval(ticket.approvalId, identity, deps)).status).toBe('claimed');
}

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ids.personalRouter = (await addTask({ title: 'Personal router', project: 'Garden' })).task.id;
  ids.receiverA = (await addTask({ title: 'Receiver A desk invoices', project: 'Garden' })).task.id;
  ids.receiverB = (await addTask({ title: 'Receiver B desk rota', project: 'Garden' })).task.id;
  ids.receiverC = (await addTask({ title: 'Receiver C closes itself', project: 'Garden' })).task.id;
  ids.receiverD = (await addTask({ title: 'Receiver D unmarked', project: 'Garden' })).task.id;
  ids.workRouter = (await addTask({ title: 'Work router', project: 'Workshop' })).task.id;
  ids.workReceiver = (await addTask({ title: 'Work receiver', project: 'Workshop' })).task.id;
  await updateRouterAreas(WALNUT_HOME, () => ({
    version: 1,
    areas: [
      { id: 'personal', name: 'Personal', host: '__local__', taskIds: [ids.personalRouter, ids.receiverA, ids.receiverB, ids.receiverC, ids.receiverD],
        sources: [{ kind: 'slack', account: PERSONAL_ACCOUNT }] },
      { id: 'work', name: 'Work', host: '__local__', taskIds: [ids.workRouter, ids.workReceiver],
        sources: [{ kind: 'slack', account: WORK_ACCOUNT }] },
    ],
    routers: [
      { taskId: ids.personalRouter, areaId: 'personal', paused: false },
      { taskId: ids.workRouter, areaId: 'work', paused: false },
    ],
    items: [P_MINE, P_ROUTING, P_SIBLING, P_FAILED, P_NOT_ROUTED, P_NO_ROW, P_DONE, P_UNMARKED, P_APPROVED, P_APPROVED_FAILED,
      P_ORIGINAL, P_ALIAS, P_GONE_ORIGINAL, P_GONE_ALIAS].map((source) => ({ source, areaId: 'personal' }))
      .concat([{ source: W_ITEM, areaId: 'work' }]),
  }));
  await mark(ids.personalRouter, 'personal', true);
  await mark(ids.workRouter, 'work', true);
  // Receiver D stays unmarked on purpose: the registry alone must not let it read or write.
  for (const id of [ids.receiverA, ids.receiverB, ids.receiverC]) await mark(id, 'personal');
  await mark(ids.workReceiver, 'work');
  await seedSession(sids.router, ids.personalRouter, 'personal', 'router');
  await seedSession(sids.receiverC, ids.receiverC, 'personal', 'work');
  // Fault injection: an area session on an unmarked task, which the write guard now refuses,
  // stands for history from before it; the registry alone must still grant it nothing.
  await seedLegacySession(sids.receiverD, ids.receiverD, '', WALNUT_HOME, { profile: routerAreaProfile('personal', 'work'), mode: 'dontAsk', initialProcessStatus: 'stopped' });
  await seedSession(sids.receiverA, ids.receiverA, 'personal', 'work');
  await seedSession(sids.receiverB, ids.receiverB, 'personal', 'work');
  await seedSession(sids.workReceiver, ids.workReceiver, 'work', 'work');

  await handOff('personal', P_MINE, ids.receiverA, 'routed');
  await handOff('personal', P_ROUTING, ids.receiverA, 'pending');
  await handOff('personal', P_SIBLING, ids.receiverB, 'routed');
  await handOff('personal', P_FAILED, ids.receiverA, 'failed');
  await routerStore('personal').claim(itemOf(P_NOT_ROUTED), { status: 'not_routed', reason: 'No action needed' });
  await handOff('work', W_ITEM, ids.workReceiver, 'routed');
  await handOff('personal', P_DONE, ids.receiverC, 'routed');
  await handOff('personal', P_UNMARKED, ids.receiverD, 'routed');
  await handOff('personal', P_APPROVED, ids.workReceiver, 'routed');
  await handOff('personal', P_APPROVED_FAILED, ids.workReceiver, 'failed');
  await approveFrozenItem(P_APPROVED);
  await approveFrozenItem(P_APPROVED_FAILED);
  for (const [original, alias] of [[P_ORIGINAL, P_ALIAS], [P_GONE_ORIGINAL, P_GONE_ALIAS]]) {
    await handOff('personal', original, ids.receiverA, 'routed');
    expect((await routerStore('personal').bindSource(alias, routerKey(original))).bound).toBe(true);
  }

  stopSource = registerRouterSource('slack', { resolve, read });
});

afterAll(async () => {
  try {
    stopSource();
    await disposeRouterStores();
    await stopServer();
  } finally {
    // Only this file's own mocked home: the areas file, ledgers, tasks and session records.
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  }
});

beforeEach(() => { resolve.mockClear(); read.mockClear(); });

describe('router_item: a receiver reads only what was handed to it', () => {
  it('refuses a body response if its receiving task changes area while the source is read', async () => {
    read.mockImplementationOnce(async (source) => {
      // Fault injection: a scope change mid-read that the write guard now refuses.
      patchLegacyTask(ids.receiverA, { router_area_id: 'work' });
      return { item: itemOf(source), body: { text: 'RACE_BODY_CANARY' }, bodyAvailable: true, attachments: [], attachmentsAvailable: false };
    });
    try {
      const response = await call('GET', itemPath(P_MINE), sids.receiverA);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('RACE_BODY_CANARY');
    } finally { patchLegacyTask(ids.receiverA, { router_area_id: 'personal' }); }
  });

  it('reads its own routed item, with the route and the trust line, and nothing else', async () => {
    const response = await call('GET', itemPath(P_MINE), sids.receiverA);
    expect(response.status).toBe(200);
    const text = await response.text();
    const json = JSON.parse(text);
    expect(json).toMatchObject({
      item: { source: P_MINE, key: routerKey(P_MINE) },
      body: { text: canary(P_MINE) },
      bodyAvailable: true,
      attachments: [{ filename: 'notes.txt', mimeType: 'text/plain', bytes: 12 }],
      attachmentsAvailable: false,
      route: { areaId: 'personal', taskId: ids.receiverA, status: 'routed' },
    });
    expect(json.trust).toMatch(/never authorization/);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(P_MINE);
    for (const other of [P_SIBLING, W_ITEM, P_ROUTING]) expect(text).not.toContain(canary(other));
    expect(text).not.toContain(ids.receiverB);
    expect(text).not.toContain('Receiver B');
  });

  it('reads an item claimed for it whose delivery is still in flight', async () => {
    const response = await call('GET', itemPath(P_ROUTING), sids.receiverA);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ body: { text: canary(P_ROUTING) }, route: { status: 'routing', taskId: ids.receiverA } });
  });

  it('refuses a sibling\'s item in the same area before the content reader runs', async () => {
    const response = await call('GET', itemPath(P_SIBLING), sids.receiverA);
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(codeOf(JSON.parse(text))).toBe('area_forbidden');
    expect(text).not.toContain(canary(P_SIBLING));
    expect(read).not.toHaveBeenCalled();
  });

  for (const [name, source] of [['a refused delivery', P_FAILED], ['a not-routed item', P_NOT_ROUTED], ['an item never routed', P_NO_ROW]] as const) {
    it(`refuses ${name} of its own area before the content reader runs`, async () => {
      const response = await call('GET', itemPath(source), sids.receiverA);
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(codeOf(JSON.parse(text))).toBe('area_forbidden');
      expect(text).not.toContain(canary(source));
      expect(read).not.toHaveBeenCalled();
    });
  }

  for (const [name, source] of [['another area\'s item', W_ITEM], ['an item in no area', P_UNKNOWN]] as const) {
    it(`refuses ${name} before any source lookup`, async () => {
      const response = await call('GET', itemPath(source), sids.receiverA);
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(codeOf(JSON.parse(text))).toBe('cross_area');
      expect(text).not.toContain(canary(source));
      expect(resolve).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });
  }

  it('lets the other area\'s receiver read only its own item', async () => {
    const own = await call('GET', itemPath(W_ITEM), sids.workReceiver);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ body: { text: canary(W_ITEM) }, route: { areaId: 'work', taskId: ids.workReceiver } });
    read.mockClear();
    const personal = await call('GET', itemPath(P_MINE), sids.workReceiver);
    expect(personal.status).toBe(403);
    expect(await personal.text()).not.toContain(canary(P_MINE));
    expect(read).not.toHaveBeenCalled();
  });

  it('reads only a consumed cross-area frozen item, without reading its source adapter', async () => {
    const response = await call('GET', itemPath(P_APPROVED), sids.workReceiver);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ body: { text: 'FROZEN_APPROVED_CANARY' },
      route: { areaId: 'personal', taskId: ids.workReceiver, status: 'routed' } });
    expect(resolve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    const sibling = await call('GET', itemPath(P_APPROVED), sids.receiverB);
    expect(sibling.status).toBe(403);
    expect(await sibling.text()).not.toContain('FROZEN_APPROVED_CANARY');
    const failed = await call('GET', itemPath(P_APPROVED_FAILED), sids.workReceiver);
    expect(failed.status).toBe(403);
    expect(await failed.text()).not.toContain('FROZEN_APPROVED_CANARY');
    const another = await call('GET', itemPath(P_MINE), sids.workReceiver);
    expect(another.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it('an alias of a routed item finds its receipt but always reads the original source\'s body', async () => {
    const receipt = await routerStore('personal').getSource(P_ALIAS);
    expect(receipt).toMatchObject({ key: routerKey(P_ORIGINAL), source: P_ORIGINAL, taskId: ids.receiverA, status: 'routed' });
    for (let i = 0; i < 2; i++) {
      const response = await call('GET', itemPath(P_ALIAS), sids.receiverA);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        body: { text: canary(P_ORIGINAL) }, route: { key: routerKey(P_ORIGINAL), source: P_ORIGINAL, taskId: ids.receiverA },
      });
      expect(text).not.toContain(canary(P_ALIAS));
    }
    expect(read).toHaveBeenCalledTimes(2);
    for (const [source] of read.mock.calls) expect(source).toEqual(P_ORIGINAL);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('an alias whose original left the cache answers 503 and never falls back to the alias\'s body', async () => {
    missing.add(P_GONE_ORIGINAL.message);
    try {
      const response = await call('GET', itemPath(P_GONE_ALIAS), sids.receiverA);
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(codeOf(JSON.parse(text))).toBe('source_unavailable');
      expect(text).not.toContain(canary(P_GONE_ALIAS));
      expect(text).not.toContain(canary(P_GONE_ORIGINAL));
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(P_GONE_ORIGINAL);
      expect(read).not.toHaveBeenCalledWith(P_GONE_ALIAS);
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      missing.delete(P_GONE_ORIGINAL.message);
    }
  });

  it('refuses a caller with no scoped session before any lookup', async () => {
    for (const sid of [undefined, 'external', randomUUID()]) {
      const response = await call('GET', itemPath(P_MINE), sid);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(canary(P_MINE));
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('roles stay apart', () => {
  it('a router session may neither read an item nor record work', async () => {
    const noteBefore = (await getTask(ids.personalRouter)).note ?? '';
    const item = await call('GET', itemPath(P_MINE), sids.router);
    expect(item.status).toBe(403);
    expect(codeOf(await item.json())).toBe('area_forbidden');
    const saved = await work(sids.router, { note: 'ROUTER_NOTE_CANARY' });
    expect(saved.status).toBe(403);
    expect(codeOf(await saved.json())).toBe('area_forbidden');
    expect(resolve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect((await getTask(ids.personalRouter)).note ?? '').toBe(noteBefore);
  });

  it('a receiving session may not route, and the ledger stays as it was', async () => {
    const response = await call('POST', '/api/v1/router/route', sids.receiverA, {
      source: P_NO_ROW, task_id: ids.receiverA, reason: 'Taking it myself',
    });
    expect(response.status).toBe(403);
    expect(codeOf(await response.json())).toBe('area_forbidden');
    expect(await routerStore('personal').get(routerKey(P_NO_ROW))).toBeUndefined();
    const context = await call('GET', `/api/v1/router/context?${new URLSearchParams({ ...P_MINE })}`, sids.receiverA);
    expect(context.status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('the work role carries exactly the two processing tools', () => {
    expect([...ROUTER_WORK_OPS].sort()).toEqual(['router_item', 'router_work']);
    expect(routerAreaProfile('personal', 'work').allowedTools).toEqual(['mcp__walnut__router_item', 'mcp__walnut__router_work']);
    expect(routerAreaProfile('personal', 'router').allowedTools).toEqual(['mcp__walnut__router_context', 'mcp__walnut__router_route']);
  });
});

describe('router_work: a receiver records its own findings', () => {
  it('saves the note on its own task only, and reports that nothing went outside', async () => {
    const others = await Promise.all([ids.receiverB, ids.personalRouter, ids.workReceiver].map(async (id) => (await getTask(id)).note ?? ''));
    const response = await work(sids.receiverA, { note: 'NOTE_CANARY_A invoice checked against the order' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: ids.receiverA, saved: true, outwardAction: false });
    expect((await getTask(ids.receiverA)).note).toContain('NOTE_CANARY_A invoice checked against the order');
    const after = await Promise.all([ids.receiverB, ids.personalRouter, ids.workReceiver].map(async (id) => (await getTask(id)).note ?? ''));
    expect(after).toEqual(others);
  });

  const invalid: Array<[string, Record<string, unknown>, number, string]> = [
    ['an empty note', { note: '   ' }, 400, 'note_required'],
    ['a note over the limit', { note: 'x'.repeat(20001) }, 400, 'note_required'],
    ['a phase it may not set', { note: 'INVALID_CANARY_PHASE', phase: 'WAITING' }, 400, 'bad_phase'],
    ['a needs with no ask', { note: 'INVALID_CANARY_NO_ASK', phase: 'NEED_ACTION' }, 400, 'bad_request'],
    ['a needs with no user kind', { note: 'INVALID_CANARY_NO_KIND', phase: 'NEED_ACTION', ask: 'Approve paying the invoice?' }, 409, 'user_kind'],
    ['a needs with a short why', {
      note: 'INVALID_CANARY_SHORT_WHY', phase: 'NEED_ACTION', ask: 'Approve paying the invoice?', user_kind: 'spending', user_kind_why: 'pay',
    }, 409, 'user_kind'],
  ];
  for (const [name, body, status, code] of invalid) {
    it(`refuses ${name} before appending the note or moving the phase`, async () => {
      const before = await getTask(ids.receiverA);
      const response = await work(sids.receiverA, body);
      expect(response.status).toBe(status);
      expect(codeOf(await response.json())).toBe(code);
      const after = await getTask(ids.receiverA);
      expect(after.note).toBe(before.note);
      expect(after.phase).toBe(before.phase);
      expect(after.note ?? '').not.toContain('INVALID_CANARY');
    });
  }

  it('puts a concrete ask of the user\'s own kind on the user, with the note saved once', async () => {
    const response = await work(sids.receiverA, {
      note: 'NOTE_CANARY_NEEDS the invoice is 40 over the order',
      phase: 'NEED_ACTION',
      ask: 'Approve paying the invoice that is 40 over the order?',
      user_kind: 'spending',
      user_kind_why: 'Paying the invoice spends the user\'s money.',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: ids.receiverA, saved: true, phase: 'NEED_ACTION', outwardAction: false });
    const task = await getTask(ids.receiverA);
    expect(task.phase).toBe('NEED_ACTION');
    expect(task.note?.split('NOTE_CANARY_NEEDS').length).toBe(2);
  });

  it('a receiver of another area records on its own task, never on area A\'s', async () => {
    const before = (await getTask(ids.receiverA)).note;
    const response = await work(sids.workReceiver, { note: 'NOTE_CANARY_WORK rota checked' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ taskId: ids.workReceiver });
    expect((await getTask(ids.receiverA)).note).toBe(before);
    expect((await getTask(ids.workReceiver)).note).toContain('NOTE_CANARY_WORK');
  });

  it('a session with no scoped work role cannot record work', async () => {
    const before = (await getTask(ids.receiverA)).note;
    for (const sid of [undefined, 'external', randomUUID()]) {
      const response = await work(sid, { note: 'OUTSIDE_CANARY' });
      expect(response.status).toBe(403);
    }
    expect((await getTask(ids.receiverA)).note).toBe(before);
  });
});

describe('persisted markers and completion', () => {
  it('a receiver whose task carries no area marker can neither read nor record, even with its route', async () => {
    const before = await getTask(ids.receiverD);
    const item = await call('GET', itemPath(P_UNMARKED), sids.receiverD);
    expect(item.status).toBe(403);
    expect(await item.text()).not.toContain(canary(P_UNMARKED));
    const saved = await work(sids.receiverD, { note: 'UNMARKED_CANARY' });
    expect(saved.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect((await getTask(ids.receiverD)).note).toBe(before.note);
  });

  it('a repeated save of the same findings appends them once', async () => {
    const note = 'NOTE_CANARY_REPEAT rota confirmed for Friday';
    const first = await work(sids.receiverC, { note });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ taskId: ids.receiverC, saved: true, outwardAction: false });
    const again = await work(sids.receiverC, { note });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ taskId: ids.receiverC, saved: true, repeated: true, outwardAction: false });
    expect((await getTask(ids.receiverC)).note?.split(note).length).toBe(2);
  });

  it('completes its own task with the note in the same write, and is closed to reads and writes after', async () => {
    const others = await Promise.all([ids.receiverA, ids.receiverB].map(async (id) => (await getTask(id)).phase));
    const response = await work(sids.receiverC, { note: 'NOTE_CANARY_DONE nothing left to do', phase: 'COMPLETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: ids.receiverC, saved: true, phase: 'COMPLETE', outwardAction: false });
    const done = await getTask(ids.receiverC);
    expect(done.phase).toBe('COMPLETE');
    expect(done.completed_at).toBeTruthy();
    expect(done.note).toContain('NOTE_CANARY_DONE');
    expect(await Promise.all([ids.receiverA, ids.receiverB].map(async (id) => (await getTask(id)).phase))).toEqual(others);

    read.mockClear();
    const item = await call('GET', itemPath(P_DONE), sids.receiverC);
    expect(item.status).toBe(409);
    expect(codeOf(await item.json())).toBe('target_complete');
    expect(read).not.toHaveBeenCalled();
    const later = await work(sids.receiverC, { note: 'NOTE_CANARY_AFTER_DONE' });
    expect(later.status).toBe(409);
    expect(codeOf(await later.json())).toBe('target_complete');
    expect((await getTask(ids.receiverC)).note).toBe(done.note);
  });
});

describe('a receiver has no outward path', () => {
  // Paths are built lazily: task ids exist only once beforeAll has run.
  const outward: Array<[string, string, () => string, unknown]> = [
    ['POST', 'tasks/send', () => '/api/v1/tasks/send', { to: ids.receiverB, text: 'OUTWARD_CANARY' }],
    ['POST', 'human-inbox', () => '/api/v1/human-inbox', { title: 'OUTWARD_CANARY', body: 'OUTWARD_CANARY' }],
    ['POST', 'mail drafts', () => '/api/plugins/mail/drafts', { accountId: PERSONAL_ACCOUNT, to: ['pat@marina.example.invalid'], subject: 'OUTWARD_CANARY' }],
    ['POST', 'mail draft send', () => '/api/plugins/mail/drafts/fixture-draft/send', {}],
    ['POST', 'task create', () => '/api/v1/tasks', { title: 'OUTWARD_CANARY' }],
    ['GET', 'task list', () => '/api/v1/tasks', undefined],
    ['GET', 'a sibling task', () => `/api/v1/tasks/${ids.receiverB}`, undefined],
    ['PUT', 'router areas', () => '/api/v1/router/areas', { version: 1, areas: [], routers: [], items: [] }],
  ];
  for (const [method, name, path, body] of outward) {
    it(`denies ${method} ${name}`, async () => {
      const response = await call(method, path(), sids.receiverA, body);
      expect(response.status).toBe(403);
      expect(codeOf(await response.json())).toBe('area_forbidden');
    });
  }

  it('made nothing on the way: no task carries a receiver\'s refused text', async () => {
    const tasks = await (await call('GET', '/api/v1/tasks')).text();
    expect(tasks).not.toContain('OUTWARD_CANARY');
  });
});
