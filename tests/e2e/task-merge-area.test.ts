/**
 * POST /api/tasks/:id/merge through a real server: a merge with a router answers 409
 * area_merge_refused and changes nothing; an ordinary merge still answers 200. Since 6b8c2747c
 * (2026-11-14) only a router is area work: what an older build left on the work a router handed
 * items to (an area mark, registry membership, a profile with no router role) merges like any task.
 * The marks and the registry are written the way production stores them (task row, router/areas.json).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('task-merge-area-e2e'));
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { mayShareTaskContext } from '../../src/core/router/context-sharing.js';
import { patchLegacyTask, seedLegacySession } from '../helpers/router-history-fixtures.js';

let server: HttpServer;
let port: number;

async function merge(survivor: string, victims: string[]) {
  const r = await fetch(`http://localhost:${port}/api/tasks/${survivor}/merge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ victim_ids: victims }),
  });
  return { status: r.status, data: await r.json() as Record<string, unknown> };
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

async function writeAreas(taskIds: string[], routers: string[], more: Array<{ id: string; routers: string[] }> = []): Promise<void> {
  const file = path.join(WALNUT_HOME, 'router', 'areas.json');
  const areas = [{ id: 'personal', taskIds, routers }, ...more.map((one) => ({ ...one, taskIds: one.routers }))];
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, items: [],
    routers: areas.flatMap((area) => area.routers.map((taskId) => ({ taskId, areaId: area.id, paused: false }))),
    areas: areas.map((area) => ({ id: area.id, name: area.id, host: '__local__', sources: [], taskIds: area.taskIds })) }));
}

describe('context sharing with the real stores and default readers', () => {
  it('reads both ordinary tasks, ignores an older build\'s area traces, and detects a router profile and two router areas', async () => {
    const a = (await addTask({ title: 'First ordinary desk', project: '', source: 'local' })).task;
    const b = (await addTask({ title: 'Second ordinary desk', project: '', source: 'local' })).task;
    expect(await mayShareTaskContext(a.id, b.id)).toBe(true);
    expect(await mayShareTaskContext(b.id, a.id)).toBe(true);
    expect(await mayShareTaskContext(a.id, 'missing-fixture-task')).toBe(false);
    expect(await mayShareTaskContext('missing-fixture-task', b.id)).toBe(false);
    // Fault injection: a historical profile with an area and no router role, and an older build's
    // area mark. Only a router is scoped now, so both tasks stay ordinary work.
    await seedLegacySession('b7c5e0f1-0000-4000-8000-00000000d001', a.id, '', WALNUT_HOME, { profile: { areaId: 'personal' }, mode: 'dontAsk', initialProcessStatus: 'stopped' });
    patchLegacyTask(b.id, { router_area_id: 'personal' });
    expect(await mayShareTaskContext(a.id, b.id)).toBe(true);
    expect(await mayShareTaskContext(b.id, a.id)).toBe(true);
    // A router session profile scopes its task, in both directions.
    const c = (await addTask({ title: 'Router desk', project: '', source: 'local' })).task;
    const d = (await addTask({ title: 'Second router desk', project: '', source: 'local' })).task;
    await seedLegacySession('b7c5e0f1-0000-4000-8000-00000000d002', c.id, '', WALNUT_HOME, { profile: { areaId: 'personal', areaRole: 'router' }, mode: 'dontAsk', initialProcessStatus: 'stopped' });
    expect(await mayShareTaskContext(c.id, b.id)).toBe(false);
    expect(await mayShareTaskContext(b.id, c.id)).toBe(false);
    expect(await mayShareTaskContext(c.id, undefined)).toBe(false);
    // The same router area on both sides shares.
    await seedLegacySession('b7c5e0f1-0000-4000-8000-00000000d003', d.id, '', WALNUT_HOME, { profile: { areaId: 'personal', areaRole: 'router' }, mode: 'dontAsk', initialProcessStatus: 'stopped' });
    expect(await mayShareTaskContext(c.id, d.id)).toBe(true);
    expect(await mayShareTaskContext(d.id, c.id)).toBe(true);
    // Fault injection: a deliberately conflicting router assignment, so c holds two router areas.
    await writeAreas([], [], [{ id: 'work', routers: [c.id] }]);
    expect(await mayShareTaskContext(c.id, d.id)).toBe(false);
    expect(await mayShareTaskContext(d.id, c.id)).toBe(false);
  });
});

describe('merge route and routers', () => {
  it('refuses a merge of a router with 409 area_merge_refused and merges nothing', async () => {
    const { task: survivor } = await addTask({ title: 'Ordinary survivor', project: '', source: 'local' });
    const { task: victim } = await addTask({ title: 'Router victim', project: '', source: 'local' });
    await updateTaskRaw(victim.id, { org_role: 'router', router_area_id: 'personal' }, { emitEvent: false });
    await writeAreas([victim.id], [victim.id]);

    const r = await merge(survivor.id, [victim.id]);
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({ code: 'area_merge_refused', role: 'victim', task_id: victim.id, merged: 0, refused: [{ id: victim.id, role: 'victim' }] });
    expect(String(r.data.error)).toMatch(/Nothing was merged/);
    expect(r.data.merged_ids).toBeUndefined();
    expect(await getTask(victim.id)).toMatchObject({ org_role: 'router', router_area_id: 'personal' });
    expect((await getTask(survivor.id)).id).toBe(survivor.id);
  });

  it('merges routed work an older build marked into an area like any task', async () => {
    const { task: survivor } = await addTask({ title: 'Ordinary owner', project: '', source: 'local' });
    const { task: victim } = await addTask({ title: 'Legacy routed work', project: '', source: 'local', router_area_id: 'personal' });
    // Listed as an area member beside a router, as an older build stored it.
    const { task: router } = await addTask({ title: 'Personal router', project: '', source: 'local' });
    await updateTaskRaw(router.id, { org_role: 'router', router_area_id: 'personal' }, { emitEvent: false });
    await writeAreas([router.id, victim.id], [router.id]);

    const r = await merge(survivor.id, [victim.id]);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ merged: 1, merged_ids: [victim.id] });
    await expect(getTask(victim.id)).rejects.toThrow(/No task found/);
  });

  it('still merges two ordinary tasks', async () => {
    const { task: survivor } = await addTask({ title: 'Plain survivor', project: '', source: 'local' });
    const { task: victim } = await addTask({ title: 'Plain duplicate', project: '', source: 'local' });
    const r = await merge(survivor.id, [victim.id]);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ merged: 1, merged_ids: [victim.id] });
    await expect(getTask(victim.id)).rejects.toThrow(/No task found/);
  });
});
