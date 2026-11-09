import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-org'));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { ensureProjectLead } from '../../src/core/org/org-store.js';
import { addTask, getTask, listTasks, updateTaskRaw } from '../../src/core/task-manager.js';
import * as taskManager from '../../src/core/task-manager.js';
import * as routerAreas from '../../src/core/router/areas.js';
import { OrgError } from '../../src/core/org/org-store.js';
import { buildOrgTree, isHiddenFromTaskLists } from '../../src/core/org/org-tree.js';
import { readRouterAreas, updateRouterAreas } from '../../src/core/router/areas.js';
import { updateRouterNode } from '../../src/core/router/nodes.js';
import { createSessionRecord, getSessionsForTask } from '../../src/core/session-tracker.js';
import { registerRouterSource } from '../../src/core/router/source-registry.js';
import { routeItem, routerNewWorkId, routerNewWorkMarker, type RouteItemInput, type RouterDeliveryDeps } from '../../src/core/router/service.js';
import { RouterStore, routerKey } from '../../src/core/router/store.js';
import type { RouterItem, RouterRoute, RouterSource } from '../../src/core/router/types.js';
import { taskIdForKey } from '../../src/core/task-create-idempotency.js';
import { routerTaskDbPath } from '../../src/core/router/data-version.js';
import { seedTaskStore, taskStoreVersion } from '../helpers/router-task-store.js';

// Fixture accounts only: no real mailbox is read or changed by these tests.
const MAILBOX = { kind: 'mail', account: 'router-fixture@example.com' };
const OTHER_MAILBOX = { kind: 'mail', account: 'other-fixture@example.com' };

let base = '';
let vpIds: string[] = [];
beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vpIds = await Promise.all(['Garden', 'Workshop'].map(async (name) => (await ensureProjectLead(name)).id));
});
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

async function create(area: string, links: string[], extra: Record<string, unknown> = {}) {
  return fetch(`${base}/api/v1/org/routers`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${area} router`, area_id: area, area_name: area, host: '__local__', links, sources: [], ...extra }) });
}
async function patch(id: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/v1/org/routers/${encodeURIComponent(id)}`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function putAreas(body: unknown) {
  return fetch(`${base}/api/v1/router/areas`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function snapshot(id: string) {
  const task = await getTask(id);
  return { areas: await readRouterAreas(WALNUT_HOME), name: task.org_name, links: task.router_links, paused: task.router_paused };
}

describe('an independent router beside the VPs', () => {
  it('has zero VP links, no leader, no project and never becomes a VP or board task', async () => {
    const response = await create('personal', []);
    expect(response.status).toBe(201);
    const { task } = await response.json();
    const stored = await getTask(task.id);
    expect(stored).toMatchObject({ org_role: 'router', router_area_id: 'personal', router_links: [], router_paused: true, project: '' });
    expect(stored.parent_task_id).toBeFalsy();
    expect(isHiddenFromTaskLists(stored)).toBe(true);
    expect(buildOrgTree([stored]).projects).toEqual([]);
    expect((await readRouterAreas(WALNUT_HOME)).routers).toContainEqual({ taskId: stored.id, areaId: 'personal', paused: true });
  });

  it('links many VPs without taking ownership or granting their data', async () => {
    const response = await create('work', vpIds);
    expect(response.status).toBe(201);
    const { task } = await response.json();
    expect((await getTask(task.id)).router_links).toEqual(vpIds);
    const area = (await readRouterAreas(WALNUT_HOME)).areas.find((one) => one.id === 'work')!;
    expect(area.taskIds).toEqual([task.id]);
    for (const id of vpIds) expect((await getTask(id)).org_role).toBe('lead');
  });

  it('returns the same router on a repeated setup and refuses one that would reconfigure it', async () => {
    const first = await create('personal', []);
    const second = await create('personal', []);
    expect(second.status).toBe(200);
    const id = (await first.json()).task.id;
    expect((await second.json()).task.id).toBe(id);
    const before = await snapshot(id);
    const relinked = await create('personal', vpIds);
    expect(relinked.status).toBe(409);
    expect((await relinked.json()).error.code).toBe('router_setup_differs');
    expect(await snapshot(id)).toEqual(before);
  });

  it('stamps a store an earlier build left at 13 when a repeated setup reuses the router', async () => {
    const first = await create('reuse-stamp', []);
    expect(first.status).toBe(201);
    const id = (await first.json()).task.id;
    // An older build ran on this data after the setup: the store reads 13 while the areas file still names the router.
    seedTaskStore(WALNUT_HOME, 13);
    expect(taskStoreVersion(routerTaskDbPath(WALNUT_HOME))).toBe(13);
    const again = await create('reuse-stamp', []);
    expect(again.status).toBe(200);
    expect((await again.json()).task.id).toBe(id);
    expect(taskStoreVersion(routerTaskDbPath(WALNUT_HOME))).toBe(14);
  });

  it('keeps an area\'s sources when setup repeats with none, and refuses different ones', async () => {
    const made = await create('mailbox', [], { sources: [MAILBOX] });
    expect(made.status).toBe(201);
    const id = (await made.json()).task.id;
    const again = await create('mailbox', [], { sources: [] });
    expect(again.status).toBe(200);
    expect((await again.json()).task.id).toBe(id);
    const area = () => readRouterAreas(WALNUT_HOME).then((file) => file.areas.find((one) => one.id === 'mailbox')!);
    expect((await area()).sources).toEqual([MAILBOX]);
    const before = await readRouterAreas(WALNUT_HOME);
    const other = await create('mailbox', [], { sources: [OTHER_MAILBOX] });
    expect(other.status).toBe(409);
    expect((await other.json()).error.code).toBe('router_area_changed');
    const moved = await create('mailbox', [], { host: 'elsewhere' });
    expect(moved.status).toBe(409);
    expect(await readRouterAreas(WALNUT_HOME)).toEqual(before);
  });

  it('refuses a nonexistent VP link before any node or area is created', async () => {
    const response = await create('bad-links', ['missing-vp']);
    expect(response.status).toBe(400);
    expect((await readRouterAreas(WALNUT_HOME)).areas.some((one) => one.id === 'bad-links')).toBe(false);
    await expect(getTask(taskIdForKey('router-area:bad-links'))).rejects.toThrow();
  });

  it('refuses to convert a VP or a subtask, leaving both stores as they were', async () => {
    const before = await readRouterAreas(WALNUT_HOME);
    const vp = await create('vp-convert', [], { task_id: vpIds[0] });
    expect(vp.status).toBe(409);
    expect((await getTask(vpIds[0])).org_role).toBe('lead');
    const parent = (await addTask({ title: 'Parent fixture', project: '', source: 'local' })).task;
    const child = (await addTask({ title: 'Child fixture', project: '', source: 'local', parent_task_id: parent.id })).task;
    const sub = await create('sub-convert', [], { task_id: child.id });
    expect(sub.status).toBe(409);
    expect((await getTask(child.id)).org_role).toBeFalsy();
    expect(await readRouterAreas(WALNUT_HOME)).toEqual(before);
  });

  it('refuses to convert a task with an earlier full-tool conversation, keeping it and both stores as they were', async () => {
    const plain = await taskWithFullHistory('Old conversation fixture');
    const before = await readRouterAreas(WALNUT_HOME);
    const response = await create('history-convert', [], { task_id: plain.task.id });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe('router_history_not_isolated');
    expect(body.error.message).toContain(plain.sid);
    expect(body.error.message).toMatch(/fresh task/);
    expect(await readRouterAreas(WALNUT_HOME)).toEqual(before);
    const stored = await getTask(plain.task.id);
    expect(stored.org_role).toBeFalsy();
    expect(stored.router_area_id).toBeFalsy();
    expect((await getSessionsForTask(plain.task.id)).map((one) => one.claudeSessionId)).toEqual([plain.sid]);
  });

  it('rejects conversion when an ordinary session registers after the last preflight', async () => {
    const fresh = (await addTask({ title: 'Registration race fixture', project: '', source: 'local' })).task;
    const before = await readRouterAreas(WALNUT_HOME);
    const sid = randomUUID();
    const write = taskManager.updateTaskRaw;
    let injected = false;
    const spy = vi.spyOn(taskManager, 'updateTaskRaw').mockImplementation(async (...args) => {
      if (!injected && args[0] === fresh.id && typeof args[1] !== 'function' && args[1].org_role === 'router') {
        injected = true;
        await createSessionRecord(sid, fresh.id, '', undefined, { initialProcessStatus: 'stopped' });
      }
      return write(...args);
    });
    try {
      const response = await create('registration-race', [], { task_id: fresh.id });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('router_history_not_isolated');
      expect((await getTask(fresh.id)).router_area_id).toBeFalsy();
      expect((await getTask(fresh.id)).org_role).toBeFalsy();
      expect(await readRouterAreas(WALNUT_HOME)).toEqual(before);
      expect((await getSessionsForTask(fresh.id)).map((record) => record.claudeSessionId)).toEqual([sid]);
    } finally { spy.mockRestore(); }
  });

  it('keeps an interrupted setup closed to ordinary sessions and completes it on the same-task retry', async () => {
    const before = await readRouterAreas(WALNUT_HOME);
    const id = taskIdForKey('router-area:interrupted-setup');
    const spy = vi.spyOn(routerAreas, 'updateRouterAreas').mockImplementationOnce(async () => {
      expect(await getTask(id)).toMatchObject({ org_role: 'router', router_area_id: 'interrupted-setup', router_paused: true });
      await expect(createSessionRecord(randomUUID(), id, '', undefined, { initialProcessStatus: 'stopped' }))
        .rejects.toMatchObject({ code: 'router_history_not_isolated', status: 409 });
      throw new OrgError('router_configuration_changed', 409, 'Fixture configuration conflict');
    });
    try {
      const failed = await create('interrupted-setup', []);
      expect(failed.status).toBe(409);
      expect((await failed.json()).error.code).toBe('router_configuration_changed');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await readRouterAreas(WALNUT_HOME)).toEqual(before);
      expect(await getSessionsForTask(id)).toEqual([]);
    } finally { spy.mockRestore(); }
    const retried = await create('interrupted-setup', []);
    expect(retried.status).toBe(201);
    expect((await retried.json()).task.id).toBe(id);
    const again = await create('interrupted-setup', []);
    expect(again.status).toBe(200);
    expect((await again.json()).task.id).toBe(id);
    const after = await readRouterAreas(WALNUT_HOME);
    expect(after.routers.filter((router) => router.taskId === id)).toEqual([{ taskId: id, areaId: 'interrupted-setup', paused: true }]);
    expect(after.areas.find((area) => area.id === 'interrupted-setup')?.taskIds).toEqual([id]);
  });

  it('converts an existing task that has no conversation at all', async () => {
    const fresh = (await addTask({ title: 'Fresh convert fixture', project: '', source: 'local' })).task;
    const response = await create('empty-convert', [], { task_id: fresh.id });
    expect(response.status).toBe(201);
    expect(await getTask(fresh.id)).toMatchObject({ org_role: 'router', router_area_id: 'empty-convert' });
    expect((await readRouterAreas(WALNUT_HOME)).routers).toContainEqual({ taskId: fresh.id, areaId: 'empty-convert', paused: true });
  });
});

/** An ordinary task holding one conversation started with the default (full-tool) profile. */
async function taskWithFullHistory(title: string): Promise<{ task: Awaited<ReturnType<typeof addTask>>['task']; sid: string }> {
  const task = (await addTask({ title, project: '', source: 'local' })).task;
  const sid = randomUUID();
  await createSessionRecord(sid, task.id, '', undefined, { title, initialProcessStatus: 'stopped' });
  return { task, sid };
}

describe('editing a router', () => {
  let routerId = '';
  beforeAll(async () => { routerId = (await (await create('editing', [])).json()).task.id; });

  it('sets zero or many VP links and a new name', async () => {
    let response = await patch(routerId, { links: vpIds, name: 'Desk router' });
    expect(response.status).toBe(200);
    expect(await getTask(routerId)).toMatchObject({ router_links: vpIds, org_name: 'Desk router', org_role: 'router' });
    response = await patch(routerId, { links: [] });
    expect(response.status).toBe(200);
    expect((await getTask(routerId)).router_links).toEqual([]);
    for (const id of vpIds) expect((await getTask(id)).org_role).toBe('lead');
  });

  it('refuses an invalid link and changes nothing', async () => {
    const before = await snapshot(routerId);
    const response = await patch(routerId, { links: [vpIds[0], 'missing-vp'], paused: false });
    expect(response.status).toBe(400);
    expect(await snapshot(routerId)).toEqual(before);
  });

  it('pauses and resumes only its own assignment, moving nothing and starting nothing', async () => {
    const before = await readRouterAreas(WALNUT_HOME);
    const resumed = await patch(routerId, { paused: false });
    expect(resumed.status).toBe(200);
    let after = await readRouterAreas(WALNUT_HOME);
    expect(after.routers.find((one) => one.taskId === routerId)?.paused).toBe(false);
    expect(after.areas).toEqual(before.areas);
    expect(after.items).toEqual(before.items);
    expect(after.routers.filter((one) => one.taskId !== routerId)).toEqual(before.routers.filter((one) => one.taskId !== routerId));
    let task = await getTask(routerId);
    expect(task.router_paused).toBe(false);
    expect(task.session_ids ?? []).toEqual([]);
    expect(task.session_id).toBeFalsy();

    const paused = await patch(routerId, { paused: true });
    expect(paused.status).toBe(200);
    after = await readRouterAreas(WALNUT_HOME);
    expect(after).toEqual(before);
    task = await getTask(routerId);
    expect(task.router_paused).toBe(true);
    expect(task.session_ids ?? []).toEqual([]);
  });

  it('refuses a conditional pause writer after another caller changed the router', async () => {
    await patch(routerId, { paused: false });
    const before = await snapshot(routerId);
    await expect(updateRouterNode(routerId, { paused: true }, { expectedPaused: true }))
      .rejects.toMatchObject({ code: 'router_task_changed', status: 409 });
    expect(await snapshot(routerId)).toEqual(before);
    await updateRouterNode(routerId, { paused: true }, { expectedPaused: false });
    expect((await getTask(routerId)).router_paused).toBe(true);
  });

  it('does not convert or edit a different task returned by a missing exact-id prefix lookup', async () => {
    const missing = `prefix-${randomUUID()}`;
    const full = `${missing}-other`;
    await addTask({ title: 'Prefix neighbor fixture', project: '', source: 'local', explicitId: full });
    const before = await readRouterAreas(WALNUT_HOME);
    const converted = await create('prefix-lookup', [], { task_id: missing });
    expect(converted.status).toBe(404);
    expect((await converted.json()).error.code).toBe('router_task_missing');
    const edited = await patch(routerId.slice(0, -1), { name: 'Unintended change' });
    expect(edited.status).toBe(404);
    expect((await edited.json()).error.code).toBe('router_not_found');
    expect(await readRouterAreas(WALNUT_HOME)).toEqual(before);
    expect((await getTask(full)).org_role).toBeFalsy();
  });

  it('refuses tasks that are not routers, unknown ids and fixed fields', async () => {
    const vpBefore = await getTask(vpIds[0]);
    const vp = await patch(vpIds[0], { name: 'Not a router' });
    expect(vp.status).toBe(409);
    expect((await vp.json()).error.code).toBe('not_router');
    expect((await getTask(vpIds[0])).org_name).toBe(vpBefore.org_name);
    const plain = (await addTask({ title: 'Plain fixture', project: '', source: 'local' })).task;
    expect((await patch(plain.id, { paused: false })).status).toBe(409);
    expect((await getTask(plain.id)).org_role).toBeFalsy();
    expect((await patch('no-such-task', { paused: false })).status).toBe(404);
    expect((await patch(routerId, { area_id: 'work' })).status).toBe(400);
    expect((await patch(routerId, {})).status).toBe(400);
  });
});

describe('area membership', () => {
  it('marks each member with its area and keeps a subtask in its parent\'s area', async () => {
    const parent = (await addTask({ title: 'Area parent fixture', project: '', source: 'local' })).task;
    const child = (await addTask({ title: 'Area child fixture', project: '', source: 'local', parent_task_id: parent.id })).task;
    const current = await readRouterAreas(WALNUT_HOME);
    const split = { ...current, areas: [...current.areas,
      { id: 'family', name: 'Family', host: '__local__', taskIds: [parent.id], sources: [] },
      { id: 'side', name: 'Side', host: '__local__', taskIds: [child.id], sources: [] }] };
    expect((await putAreas(split)).status).toBe(400);
    expect(await readRouterAreas(WALNUT_HOME)).toEqual(current);

    const together = { ...current, areas: [...current.areas,
      { id: 'family', name: 'Family', host: '__local__', taskIds: [parent.id, child.id], sources: [] }] };
    expect((await putAreas(together)).status).toBe(200);
    for (const id of [parent.id, child.id]) {
      const task = await getTask(id);
      expect(task.router_area_id).toBe('family');
      expect(task.org_role).toBeFalsy();
    }
  });

  it('refuses a new member with an earlier full-tool conversation or a VP, before any marker is written', async () => {
    const old = await taskWithFullHistory('Old member fixture');
    const empty = (await addTask({ title: 'Empty member fixture', project: '', source: 'local' })).task;
    const current = await readRouterAreas(WALNUT_HOME);
    const withMembers = (taskIds: string[]) => ({ ...current, areas: [...current.areas,
      { id: 'history-area', name: 'History', host: '__local__', taskIds, sources: [] }] });

    const refused = await putAreas(withMembers([empty.id, old.task.id]));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe('router_history_not_isolated');
    const vp = await putAreas(withMembers([vpIds[0]]));
    expect(vp.status).toBe(409);
    expect((await vp.json()).error.code).toBe('area_task_role');
    expect(await readRouterAreas(WALNUT_HOME)).toEqual(current);
    for (const id of [empty.id, old.task.id, vpIds[0]]) expect((await getTask(id)).router_area_id).toBeFalsy();
    expect((await getTask(vpIds[0])).org_role).toBe('lead');
    expect((await getSessionsForTask(old.task.id)).map((one) => one.claudeSessionId)).toEqual([old.sid]);

    // A new task with no conversation joins.
    const accepted = await putAreas(withMembers([empty.id]));
    expect(accepted.status).toBe(200);
    expect((await getTask(empty.id)).router_area_id).toBe('history-area');
  });
});

describe('confirming one exact item\'s area (POST /api/v1/router/assign)', () => {
  // Fixture accounts and message ids only; no mail provider or account exists on this server.
  const DESK = 'assign-desk@marina.example.invalid';
  // A mail item is confirmed at one exact delivery version (what the email reader shows); chats carry none.
  const item = (message: string, account = DESK, kind: 'mail' | 'slack' | 'wechat' = 'mail') =>
    (kind === 'mail' ? { kind, account, message, version: `fixture-delivery:${message}` } : { kind, account, message });
  const FIRST = item('INBOX:assign:1');
  const SECOND = item('INBOX:assign:2');
  const lookups = { resolve: vi.fn(), read: vi.fn() };
  const disposers: Array<() => void> = [];

  async function assign(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${base}/api/v1/router/assign`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  }
  async function areasNow() {
    const response = await fetch(`${base}/api/v1/router/areas`);
    expect(response.status).toBe(200);
    return response.json();
  }
  const sameItem = (a: { kind: string; account: string; message: string }, b: typeof a) =>
    a.kind === b.kind && a.account === b.account && a.message === b.message;

  beforeAll(async () => {
    expect((await create('assign-personal', [])).status).toBe(201);
    expect((await create('assign-work', [])).status).toBe(201);
    for (const kind of ['mail', 'slack', 'wechat'] as const) {
      disposers.push(registerRouterSource(kind, {
        resolve: async (source) => { lookups.resolve(source); return { source, key: JSON.stringify([source.kind, source.account, source.message]), sender: 'Fixture sender', subject: 'Fixture item' }; },
        read: async (source) => { lookups.read(source); throw new Error('no read expected'); },
      }));
    }
  });
  afterAll(() => { for (const dispose of disposers.splice(0)) dispose(); });
  afterEach(() => {
    expect(lookups.read).not.toHaveBeenCalled();
    lookups.resolve.mockClear();
  });

  it('refuses an unknown area and writes nothing', async () => {
    const before = await areasNow();
    const response = await assign({ source: FIRST, area_id: 'no-such-area' });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('area_missing');
    expect(await areasNow()).toEqual(before);
  });

  it('refuses a malformed source or a missing area and writes nothing', async () => {
    const before = await areasNow();
    for (const body of [
      { source: { kind: 'mail', account: DESK }, area_id: 'assign-personal' },
      { source: { kind: 'fax', account: DESK, message: 'm' }, area_id: 'assign-personal' },
      { source: { kind: 'mail', account: '  ', message: 'm' }, area_id: 'assign-personal' },
      { source: FIRST },
    ]) {
      const response = await assign(body);
      expect(response.status).toBe(400);
    }
    expect(await areasNow()).toEqual(before);
  });

  it('refuses a mail item with no delivery version before any lookup, and writes nothing', async () => {
    const before = await areasNow();
    const unversioned = { kind: FIRST.kind, account: FIRST.account, message: FIRST.message };
    const response = await assign({ source: unversioned, area_id: 'assign-personal' });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('source_version_required');
    expect(lookups.resolve).not.toHaveBeenCalled();
    expect(await areasNow()).toEqual(before);
  });

  it('refuses any session caller, whoever it claims to be, and writes nothing', async () => {
    const before = await areasNow();
    for (const headers of [{ 'x-walnut-caller-sid': randomUUID() }, { 'x-walnut-caller-sid': 'external' }, { 'x-walnut-caller-kind': 'automation' }]) {
      const response = await assign({ source: FIRST, area_id: 'assign-personal' }, headers);
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('area_forbidden');
    }
    expect(await areasNow()).toEqual(before);
  });

  it('lets the user confirm one exact item: one assignment, and the account added to the area once', async () => {
    const before = await areasNow();
    const response = await assign({ source: FIRST, area_id: 'assign-personal' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ areaId: 'assign-personal', assigned: true });

    const after = await areasNow();
    expect(after.items).toEqual([...before.items, { source: FIRST, areaId: 'assign-personal', canonicalKey: JSON.stringify([FIRST.kind, FIRST.account, FIRST.message]) }]);
    expect(after.routers).toEqual(before.routers);
    const area = after.areas.find((one: { id: string }) => one.id === 'assign-personal');
    expect(area.sources).toEqual([{ kind: 'mail', account: DESK }]);
    expect(after.areas.filter((one: { id: string }) => one.id !== 'assign-personal'))
      .toEqual(before.areas.filter((one: { id: string }) => one.id !== 'assign-personal'));
  });

  it('does not confirm the account\'s other mail: a sibling message stays unassigned', async () => {
    const file = await areasNow();
    expect(file.items.some((one: { source: typeof SECOND }) => sameItem(one.source, SECOND))).toBe(false);
    const response = await fetch(`${base}/api/v1/router/context?${new URLSearchParams(SECOND)}`);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('area_unassigned');
    // The same message id under another account or kind is another item, unassigned too.
    for (const other of [item(FIRST.message, 'Assign-desk@marina.example.invalid'), item(FIRST.message, DESK, 'slack')]) {
      const lookalike = await fetch(`${base}/api/v1/router/context?${new URLSearchParams(other)}`);
      expect(lookalike.status).toBe(409);
    }
  });

  it('is a no-op when the same item is confirmed for the same area again', async () => {
    const before = await areasNow();
    const response = await assign({ source: FIRST, area_id: 'assign-personal' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ areaId: 'assign-personal', assigned: true });
    const after = await areasNow();
    expect(after).toEqual(before);
    expect(after.items.filter((one: { source: typeof FIRST }) => sameItem(one.source, FIRST))).toHaveLength(1);
  });

  it('refuses moving a confirmed item to another area, leaving the registry as it was', async () => {
    const before = await areasNow();
    const response = await assign({ source: FIRST, area_id: 'assign-work' });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('area_reassignment');
    expect(await areasNow()).toEqual(before);
  });

  it('confirms a second exact item of the same account without adding the account again', async () => {
    const before = await areasNow();
    const response = await assign({ source: SECOND, area_id: 'assign-personal' });
    expect(response.status).toBe(200);
    const after = await areasNow();
    expect(after.items).toEqual([...before.items, { source: SECOND, areaId: 'assign-personal', canonicalKey: JSON.stringify([SECOND.kind, SECOND.account, SECOND.message]) }]);
    expect(after.areas.find((one: { id: string }) => one.id === 'assign-personal').sources).toEqual([{ kind: 'mail', account: DESK }]);
  });

  // Swaps the wechat adapter for one test, then puts back a copy of the fixture above.
  async function withWechatResolve(resolve: (source: RouterSource) => Promise<RouterItem>, run: () => Promise<void>) {
    registerRouterSource('wechat', { resolve: async (source) => { lookups.resolve(source); return resolve(source); } });
    try { await run(); } finally {
      disposers.push(registerRouterSource('wechat', {
        resolve: async (source) => { lookups.resolve(source); return { source, key: JSON.stringify([source.kind, source.account, source.message]), sender: 'Fixture sender', subject: 'Fixture item' }; },
        read: async (source) => { lookups.read(source); throw new Error('no read expected'); },
      }));
    }
  }

  it('assigns nothing when the source metadata gives another identity, no usable key, or no cached row', async () => {
    const chat = item('wx:assign:bad', 'wx-desk', 'wechat');
    const fixture = (source: RouterSource, key: string): RouterItem => ({ source, key, sender: 'Fixture sender', subject: 'Fixture item' });
    const cases: Array<(source: RouterSource) => Promise<RouterItem>> = [
      async (source) => fixture({ ...source, message: 'wx:assign:other' }, 'k'),
      async (source) => fixture(source, ''),
      async (source) => fixture(source, 'key\nwith-newline'),
      async (source) => fixture(source, 'k'.repeat(2049)),
      async () => { throw Object.assign(new Error('The exact item is not in the cache.'), { code: 'source_missing' }); },
    ];
    for (const resolve of cases) {
      const before = await areasNow();
      await withWechatResolve(resolve, async () => {
        const response = await assign({ source: chat, area_id: 'assign-personal' });
        expect(response.status).toBe(503);
        expect((await response.json()).error.code).toBe('source_unavailable');
      });
      expect(await areasNow()).toEqual(before);
    }
  });

  it('keeps a confirmed item\'s assignment when its cached row is gone, without adding a key or reading it', async () => {
    const chat = item('wx:assign:kept', 'wx-desk', 'wechat');
    expect((await assign({ source: chat, area_id: 'assign-personal' })).status).toBe(200);
    const before = await areasNow();
    const gone = async (): Promise<RouterItem> => { throw Object.assign(new Error('The exact item is not in the cache.'), { code: 'source_missing' }); };
    await withWechatResolve(gone, async () => {
      const again = await assign({ source: chat, area_id: 'assign-personal' });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ areaId: 'assign-personal', assigned: true });
      const moved = await assign({ source: chat, area_id: 'assign-work' });
      expect(moved.status).toBe(409);
      expect((await moved.json()).error.code).toBe('area_reassignment');
    });
    expect(await areasNow()).toEqual(before);
  });
});

describe('new work a route makes, against the real task store and areas file', () => {
  // Fixture account and message ids only. Delivery is a fake that refuses or accepts: no session
  // is started, so nothing is spawned.
  const DESK = 'newwork-desk@marina.example.invalid';
  // Each mail item is assigned and routed at its exact delivery version.
  const item = (message: string): RouterSource => ({ kind: 'mail', account: DESK, message, version: `fixture-delivery:${message}` });
  const ledgers: RouterStore[] = [];
  const resolve = async (source: RouterSource): Promise<RouterItem> =>
    ({ source: { ...source }, key: routerKey(source), sender: 'pat@marina-desk.example.invalid', subject: 'Dock schedule' });
  const decision = (source: RouterSource, extra: Partial<RouteItemInput> = {}): RouteItemInput => ({
    source, newTaskTitle: 'Dock follow-up', reason: 'No open work owns dock requests',
    text: 'Please confirm the dock slot for Thursday.', ...extra,
  });
  const listed = async (id: string) => (await readRouterAreas(WALNUT_HOME)).areas
    .find((one) => one.id === 'newwork')!.taskIds.filter((one) => one === id);

  let disposeSource: () => void;
  beforeAll(async () => {
    disposeSource = registerRouterSource('mail', { resolve });
    const created = await create('newwork', []);
    expect(created.status).toBe(201);
    const routerId = ((await created.json()) as { task: { id: string } }).task.id;
    await updateTaskRaw(routerId, { router_paused: false }, { source: 'test', emitEvent: false });
    await updateRouterAreas(WALNUT_HOME, (file) => ({ ...file, routers: file.routers.map((one) => one.taskId === routerId ? { ...one, paused: false } : one) }));
    for (const message of ['INBOX:newwork:1', 'INBOX:newwork:2']) {
      const response = await fetch(`${base}/api/v1/router/assign`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: item(message), area_id: 'newwork' }) });
      expect(response.status).toBe(200);
    }
  });
  afterAll(async () => { disposeSource(); for (const ledger of ledgers.splice(0)) await ledger.dispose().catch(() => undefined); });

  function deps(send: RouterDeliveryDeps['send']): RouterDeliveryDeps {
    const store = new RouterStore(WALNUT_HOME, 'newwork');
    ledgers.push(store);
    return { store, resolve, send };
  }

  it('births one marked task in the area, lists it once, and reuses it on a repeat and a retry', async () => {
    const source = item('INBOX:newwork:1');
    const id = await routerNewWorkId('newwork', routerKey(source));
    const send = vi.fn(async (_route: RouterRoute, _text: string): Promise<unknown> => {
      throw Object.assign(new Error('queue is full'), { code: 'queue_full' });
    });
    const d = deps(send);
    const first = await routeItem(decision(source), d);
    expect(first.route).toMatchObject({ status: 'failed', taskId: id, error: 'queue is full' });

    const born = await getTask(id);
    expect(born).toMatchObject({ title: 'Dock follow-up', project: '', source: 'local', router_area_id: 'newwork',
      created_by_op: routerNewWorkMarker('newwork', id) });
    expect(born.phase).not.toBe('COMPLETE');
    expect(born.org_role).toBeFalsy();
    expect(born.parent_task_id).toBeFalsy();
    expect(born.session_ids ?? []).toEqual([]);
    expect(born.session_id).toBeFalsy();
    expect(await listed(id)).toEqual([id]);

    // A plain repeat returns the row and makes nothing.
    const count = (await listTasks()).length;
    expect(await routeItem(decision(source, { newTaskTitle: 'Another title' }), d)).toMatchObject({ fresh: false, route: { status: 'failed' } });
    expect(send).toHaveBeenCalledTimes(1);

    // The retry reaches the same task: no second task, no second membership, the first title kept.
    send.mockResolvedValueOnce({ ok: true });
    const again = await routeItem(decision(source, { retry: true, newTaskTitle: 'Another title' }), d);
    expect(again.route).toMatchObject({ status: 'routed', taskId: id, messageId: first.route.messageId });
    expect(send).toHaveBeenCalledTimes(2);
    expect((await listTasks()).length).toBe(count);
    expect((await getTask(id)).title).toBe('Dock follow-up');
    expect(await listed(id)).toEqual([id]);
  });

  it('never adopts a task that holds the id without the router\'s birth mark', async () => {
    const source = item('INBOX:newwork:2');
    const id = await routerNewWorkId('newwork', routerKey(source));
    await addTask({ title: 'Lookalike fixture', project: '', source: 'local', router_area_id: 'newwork', explicitId: id });
    const send = vi.fn(async (_route: RouterRoute, _text: string): Promise<unknown> => ({ ok: true }));
    const result = await routeItem(decision(source), deps(send));
    expect(result.route).toMatchObject({ status: 'failed', taskId: id });
    expect(send).not.toHaveBeenCalled();
    expect(await listed(id)).toEqual([]);
    expect((await getTask(id)).title).toBe('Lookalike fixture');
  });
});
