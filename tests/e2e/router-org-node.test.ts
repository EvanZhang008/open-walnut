import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-org'));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { ensureProjectLead } from '../../src/core/org/org-store.js';
import { addTask, getTask } from '../../src/core/task-manager.js';
import * as taskManager from '../../src/core/task-manager.js';
import * as routerAreas from '../../src/core/router/areas.js';
import { OrgError } from '../../src/core/org/org-store.js';
import { buildOrgTree, isHiddenFromTaskLists } from '../../src/core/org/org-tree.js';
import { readRouterAreas } from '../../src/core/router/areas.js';
import { updateRouterNode } from '../../src/core/router/nodes.js';
import { createSessionRecord, getSessionsForTask } from '../../src/core/session-tracker.js';
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
  // An area lists only its routers: the work a router hands items to stays ordinary work (2026-11-14).
  it('refuses an ordinary task, a parent and child pair, or a VP as a member, and marks nothing', async () => {
    const parent = (await addTask({ title: 'Area parent fixture', project: '', source: 'local' })).task;
    const child = (await addTask({ title: 'Area child fixture', project: '', source: 'local', parent_task_id: parent.id })).task;
    const plain = await taskWithFullHistory('Old member fixture');
    const current = await readRouterAreas(WALNUT_HOME);
    const withMembers = (taskIds: string[]) => ({ ...current, areas: [...current.areas,
      { id: 'family', name: 'Family', host: '__local__', taskIds, sources: [] }] });
    for (const taskIds of [[parent.id, child.id], [plain.task.id], [vpIds[0]]]) {
      const response = await putAreas(withMembers(taskIds));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('area_target');
    }
    expect(await readRouterAreas(WALNUT_HOME)).toEqual(current);
    for (const id of [parent.id, child.id, plain.task.id, vpIds[0]]) expect((await getTask(id)).router_area_id).toBeFalsy();
    expect((await getTask(vpIds[0])).org_role).toBe('lead');
    expect((await getSessionsForTask(plain.task.id)).map((one) => one.claudeSessionId)).toEqual([plain.sid]);
  });

  it('keeps the registry as it was when the area keeps only its routers', async () => {
    const current = await readRouterAreas(WALNUT_HOME);
    const response = await putAreas(current);
    expect(response.status).toBe(200);
    expect(await readRouterAreas(WALNUT_HOME)).toEqual(current);
  });
});

describe('the folders a router watches (PATCH /api/v1/org/routers/:id)', () => {
  let routerId = '';
  beforeAll(async () => { routerId = (await (await create('folders', [])).json()).task.id; });
  const area = async () => (await readRouterAreas(WALNUT_HOME)).areas.find((one) => one.id === 'folders')!;

  it('saves the folders on the router\'s area, and an empty list goes back to the default', async () => {
    expect(await area()).not.toHaveProperty('folders');
    const response = await patch(routerId, { folders: ['inbox', ' Receipts ', 'Receipts'] });
    expect(response.status).toBe(200);
    expect((await area()).folders).toEqual(['inbox', 'Receipts']);
    expect((await patch(routerId, { folders: [] })).status).toBe(200);
    expect(await area()).not.toHaveProperty('folders');
  });

  it('refuses a malformed folder list and changes nothing', async () => {
    await patch(routerId, { folders: ['inbox'] });
    const before = await readRouterAreas(WALNUT_HOME);
    for (const folders of ['inbox', [7], [''], ['x'.repeat(201)], ['line\nbreak'], Array.from({ length: 51 }, (_, i) => `F${i}`)]) {
      const response = await patch(routerId, { folders });
      expect(response.status).toBe(400);
    }
    expect(await readRouterAreas(WALNUT_HOME)).toEqual(before);
  });
});

describe('gone routes of the old triage hop', () => {
  it('has no item assignment or rules routes any more', async () => {
    for (const [method, path] of [['POST', '/api/v1/router/assign'], ['GET', '/api/v1/router/rules'], ['POST', '/api/v1/router/rules']]) {
      const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});
