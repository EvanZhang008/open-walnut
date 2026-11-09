/**
 * POST /api/tasks/:id/merge through a real server: a merge with incoming-item area work answers
 * 409 area_merge_refused and changes nothing; an ordinary merge still answers 200. The area mark
 * and the registry are written the way production stores them (task row mark, router/areas.json).
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

describe('context sharing with the real stores and default readers', () => {
  it('reads both ordinary tasks, then detects a profile-only area and a conflicting mark', async () => {
    const a = (await addTask({ title: 'First ordinary desk', project: '', source: 'local' })).task;
    const b = (await addTask({ title: 'Second ordinary desk', project: '', source: 'local' })).task;
    expect(await mayShareTaskContext(a.id, b.id)).toBe(true);
    expect(await mayShareTaskContext(b.id, a.id)).toBe(true);
    expect(await mayShareTaskContext(a.id, 'missing-fixture-task')).toBe(false);
    expect(await mayShareTaskContext('missing-fixture-task', b.id)).toBe(false);
    const sid = 'b7c5e0f1-0000-4000-8000-00000000d001';
    // Fault injection: a historical profile-only session (stopped) the write guard now refuses.
    await seedLegacySession(sid, a.id, '', WALNUT_HOME, { profile: { areaId: 'personal' }, mode: 'dontAsk', initialProcessStatus: 'stopped' });
    expect(await mayShareTaskContext(a.id, b.id)).toBe(false);
    expect(await mayShareTaskContext(b.id, a.id)).toBe(false);
    await updateTaskRaw(b.id, { router_area_id: 'personal' }, { emitEvent: false });
    expect(await mayShareTaskContext(a.id, b.id)).toBe(true);
    expect(await mayShareTaskContext(b.id, a.id)).toBe(true);
    // Fault injection: a deliberately conflicting historical mark.
    patchLegacyTask(a.id, { router_area_id: 'work' });
    expect(await mayShareTaskContext(a.id, b.id)).toBe(false);
    expect(await mayShareTaskContext(b.id, a.id)).toBe(false);
  });
});

describe('merge route and incoming-item areas', () => {
  it('refuses a merge of area work with 409 area_merge_refused and merges nothing', async () => {
    const { task: survivor } = await addTask({ title: 'Ordinary survivor', project: '', source: 'local' });
    const { task: victim } = await addTask({ title: 'Area victim', project: '', source: 'local', router_area_id: 'personal' });
    const file = path.join(WALNUT_HOME, 'router', 'areas.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, routers: [], items: [],
      areas: [{ id: 'personal', name: 'Personal', host: '__local__', sources: [], taskIds: [victim.id] }] }));

    const r = await merge(survivor.id, [victim.id]);
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({ code: 'area_merge_refused', role: 'victim', task_id: victim.id, merged: 0, refused: [{ id: victim.id, role: 'victim' }] });
    expect(String(r.data.error)).toMatch(/Nothing was merged/);
    expect(r.data.merged_ids).toBeUndefined();
    expect((await getTask(victim.id)).router_area_id).toBe('personal');
    expect((await getTask(survivor.id)).id).toBe(survivor.id);
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
