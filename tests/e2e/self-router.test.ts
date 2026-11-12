/**
 * Listing a task that routes by itself among the routers (src/core/router/self-router.ts,
 * PUT/DELETE /api/v1/org/routers/self/:id) writes only its mark: its session record, its phase and
 * its project stay as they were, and the CEO, a VP or an area router is refused.
 */
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-self-router'));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { ensureProjectLead } from '../../src/core/org/org-store.js';
import { addTask, getTask } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js';

let base = '';
let vpId = '';
beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vpId = (await ensureProjectLead('Marina')).id;
});
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: await res.json() as Record<string, any> };
};

describe('a task that routes by itself', () => {
  it('is listed with its VP links and changes nothing of its work', async () => {
    const { task } = await addTask({ title: 'Dock pipeline watch', project: 'Marina', source: 'local' });
    const sid = '7b0c9a1e-0000-4000-8000-00000000d222';
    await createSessionRecord(sid, task.id, 'Marina', WALNUT_HOME, { title: 'watch', initialProcessStatus: 'idle' });
    const before = { task: await getTask(task.id), session: await getSessionByClaudeId(sid) };

    const put = await call('PUT', `/api/v1/org/routers/self/${task.id}`, { links: [vpId], name: 'Dock watch' });
    expect(put.status).toBe(200);
    expect(put.json.task.self_router).toMatchObject({ links: [vpId], name: 'Dock watch', by: 'human' });

    const after = { task: await getTask(task.id), session: await getSessionByClaudeId(sid) };
    expect(after.task.phase).toBe(before.task.phase);
    expect(after.task.project).toBe('Marina');
    expect(after.task.org_role).toBeUndefined();
    expect(after.session?.process_status).toBe(before.session?.process_status);
    expect(after.session?.profile).toEqual(before.session?.profile);

    const org = await call('GET', '/api/v1/org');
    const routers = (org.json.routers ?? org.json.tree?.routers ?? []) as Array<{ id: string; self?: boolean; name?: string; links: string[] }>;
    expect(routers.find((r) => r.id === task.id)).toMatchObject({ self: true, name: 'Dock watch', links: [vpId] });

    const del = await call('DELETE', `/api/v1/org/routers/self/${task.id}`);
    expect(del.status).toBe(200);
    expect(del.json.task.self_router ?? null).toBeNull();
    expect((await getTask(task.id)).phase).toBe(before.task.phase);
  });

  it('refuses the CEO or a VP, a missing task, and a link that is no open VP', async () => {
    expect((await call('PUT', `/api/v1/org/routers/self/${vpId}`, { links: [] })).status).toBe(409);
    expect((await call('PUT', '/api/v1/org/routers/self/no-such-task', { links: [] })).status).toBe(404);
    const { task } = await addTask({ title: 'Another loop', project: 'Marina', source: 'local' });
    expect((await call('PUT', `/api/v1/org/routers/self/${task.id}`, { links: [task.id] })).status).toBe(400);
    expect((await call('PUT', `/api/v1/org/routers/self/${task.id}`, {})).status).toBe(400);
  });
});
