/**
 * A whole project stops syncing, through the route and the op a person or an agent uses
 * (2026-11-02, the user: "move all from microsoft to local ... using walnut existing tool or
 * process, migrate slowly and check, the old task in the ms should be archived"). Batches of
 * `limit`: each synced task turns local with its content, its remote id released and its copy
 * there archived (finished ones too); a copy that cannot be closed is reported, the task is local
 * anyway; the project turns Local only once nothing in it syncs, and a pull of the service's list
 * of that name then finds the Local row and stays out.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('project-make-local-e2e', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { registry } from '../../src/core/integration-registry.js';
import {
  addTask, ensureProject, getTask, getProjectRecord, listTasks, settleBackgroundPushes, _setSourceForTesting,
} from '../../src/core/task-manager.js';
import { createSpySync, createMockPlugin } from '../core/plugin-test-utils.js';
import { executeOp } from '../../src/ops/index.js';
import type { Task } from '../../src/core/types.js';

const PLUGIN = 'fake-list';
let server: Server;
let root: string;
let sync: ReturnType<typeof createSpySync>;
const ids: Record<string, string> = {};
const GONE = 'r-gone';

async function api(path: string, body: unknown) {
  const res = await fetch(`${root}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as Record<string, any> };
}

/** A task already synced to the list: made local, then given the service and a remote id. */
async function synced(title: string, opts: { phase?: 'COMPLETE'; parent?: string; remote?: string; project?: string } = {}): Promise<string> {
  const { task } = await addTask({ title, project: opts.project ?? 'Errands' } as never);
  await _setSourceForTesting(task.id, PLUGIN, { [PLUGIN]: { id: opts.remote ?? `r-${task.id}`, list_id: 'list-1' } });
  const { updateTaskRaw } = await import('../../src/core/task-manager.js');
  if (opts.parent) await updateTaskRaw(task.id, { parent_task_id: opts.parent } as never);
  if (opts.phase) await updateTaskRaw(task.id, { phase: 'COMPLETE' } as never);
  return task.id;
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  sync = createSpySync();
  // The service no longer has one item (the user deleted it there): closing it fails.
  sync.updatePhase.mockImplementation(async (t: Task) => {
    if ((t.ext as Record<string, { id?: string }> | undefined)?.[PLUGIN]?.id === GONE) throw new Error('404 item not found');
  });
  registry.register(PLUGIN, createMockPlugin({ id: PLUGIN, sync }));
  await ensureProject('Errands', PLUGIN);
  await ensureProject('Other list', PLUGIN);
  for (let i = 0; i < 24; i++) ids[`open${i}`] = await synced(`Errand ${i}`);
  ids.done = await synced('Bought stamps', { phase: 'COMPLETE' });
  ids.parent = await synced('Plan the move');
  ids.child = await synced('Book the van', { parent: ids.parent });
  ids.gone = await synced('Deleted over there', { remote: GONE });
  // A local task the user kept out of the list earlier: its hold means nothing once the project is local.
  ids.kept = (await addTask({ title: 'My own note', project: 'Errands', source: 'local' } as never)).task.id;
  // Another project's synced task is never touched.
  ids.other = await synced('Elsewhere', { project: 'Other list', remote: 'r-other' });
  expect((await getTask(ids.kept)).sync_hold).toMatchObject({ target: PLUGIN, state: 'chosen' });
  await settleBackgroundPushes();
  for (const fn of Object.values(sync)) (fn as { mockClear?: () => void }).mockClear?.();
});

afterAll(async () => {
  await settleBackgroundPushes();
  registry.unregister(PLUGIN);
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('a project stops syncing, a batch at a time', () => {
  it('the first batch turns its tasks local and leaves the project syncing', async () => {
    expect((await getProjectRecord('Errands'))?.source).toBe(PLUGIN);
    const r = await api('/api/v1/projects/Errands/make-local', { limit: 20 });
    expect(r.status).toBe(200);
    expect(r.json.done).toBe(false);
    expect(r.json.remaining).toBeGreaterThan(0);
    expect(r.json.processed.length + r.json.failed.filter((f: { error: string }) => !/local now/.test(f.error)).length).toBeLessThanOrEqual(20);
    expect((await getProjectRecord('Errands'))?.source).toBe(PLUGIN);
    // A parent took its subtask with it; nothing is processed twice.
    const touched = r.json.processed.map((p: { id: string }) => p.id);
    expect(new Set(touched).size).toBe(touched.length);
  });

  it('the next batch finishes: every task local, every copy closed or reported, the project Local', async () => {
    let r = await api('/api/v1/projects/Errands/make-local', { limit: 20 });
    for (let i = 0; !r.json.done && i < 5; i++) r = await api('/api/v1/projects/Errands/make-local', { limit: 20 });
    expect(r.json.done).toBe(true);
    expect(r.json.remaining).toBe(0);
    expect((await getProjectRecord('Errands'))?.source).toBe('local');

    const inProject = await listTasks({ project: 'Errands' });
    expect(inProject.filter((t) => t.source !== 'local').map((t) => t.title)).toEqual([]);
    // Content stays, and no task keeps a hold aimed at the service the project left.
    expect((await getTask(ids.done)).title).toBe('Bought stamps');
    expect((await getTask(ids.done)).phase).toBe('COMPLETE');
    expect(inProject.filter((t) => t.sync_hold?.target === PLUGIN).map((t) => t.title)).toEqual([]);
    expect((await getTask(ids.child)).parent_task_id).toBe(ids.parent);

    // Every copy there was closed, finished ones included; the one deleted there is reported.
    const closed = new Set(sync.updatePhase.mock.calls.filter((c) => c[1] === 'COMPLETE').map((c) => (c[0] as Task).id));
    for (const key of ['open0', 'open23', 'done', 'parent', 'child', 'gone']) expect(closed.has(ids[key])).toBe(true);
    expect(sync.createTask).not.toHaveBeenCalled();
    expect(sync.pushTask).not.toHaveBeenCalled();
  });

  it('reports the copy it could not close, and the task is local all the same', async () => {
    expect((await getTask(ids.gone)).source).toBe('local');
    expect((await getTask(ids.gone)).sync_hold).toBeUndefined();
  });

  it('a pull of the list of that name finds the Local row and stays out', async () => {
    expect((await ensureProject('Errands', PLUGIN)).source).toBe('local');
  });

  it('never touches another project', async () => {
    expect((await getTask(ids.other)).source).toBe(PLUGIN);
    expect((await getProjectRecord('Other list'))?.source).toBe(PLUGIN);
  });

  it('again on a Local project answers done, and the op does the same work', async () => {
    const again = await api('/api/v1/projects/Errands/make-local', {});
    expect(again.json).toMatchObject({ done: true, remaining: 0 });
    const viaOp = await executeOp('project_make_local', { name: 'Other list' }, { apiBase: root, origin: '__local__' } as never);
    expect(viaOp.ok).toBe(true);
    expect((viaOp as { result: Record<string, unknown> }).result).toMatchObject({ done: true });
    expect((await getTask(ids.other)).source).toBe('local');
    expect((await getProjectRecord('Other list'))?.source).toBe('local');
  });

  it('refuses a bad request', async () => {
    expect((await api('/api/v1/projects/Errands/make-local', { limit: 0 })).status).toBe(400);
    expect((await api('/api/v1/projects/Errands/make-local', { outside: 'delete' })).status).toBe(400);
    expect((await api('/api/v1/projects/Nowhere/make-local', {})).status).toBe(404);
  });
});
