/**
 * Focus Bar E2E tests — pin/unpin tasks, unlimited pins, reorder, persistence.
 * Pin state stored on task-level fields (pinned + pin_order).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;

function apiUrl(path: string) { return `http://localhost:${port}${path}`; }

async function api(method: string, path: string, body?: unknown) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(apiUrl(path), opts);
  return { status: r.status, data: await r.json() };
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

describe('Focus Bar API', () => {
  let taskIds: string[] = [];

  it('GET /api/focus/tasks returns empty list initially', async () => {
    const r = await api('GET', '/api/focus/tasks');
    expect(r.status).toBe(200);
    expect(r.data.pinned_tasks).toEqual([]);
  });

  it('create 4 tasks for testing', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await fetch(apiUrl('/api/tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `Focus Test ${i}`, priority: 'none', category: 'Test', project: 'Test' }),
      });
      expect(r.status).toBe(201);
      const data = await r.json();
      taskIds.push(data.task.id);
    }
    expect(taskIds).toHaveLength(4);
  });

  it('POST /api/focus/tasks/:id pins a task', async () => {
    const r = await api('POST', `/api/focus/tasks/${taskIds[0]}`);
    expect(r.status).toBe(200);
    expect(r.data.pinned_tasks).toContain(taskIds[0]);
    expect(r.data.pinned_tasks).toHaveLength(1);
  });

  it('pinning same task again is a no-op', async () => {
    const r = await api('POST', `/api/focus/tasks/${taskIds[0]}`);
    expect(r.status).toBe(200);
    expect(r.data.pinned_tasks).toHaveLength(1);
  });

  it('can pin unlimited tasks', async () => {
    await api('POST', `/api/focus/tasks/${taskIds[1]}`);
    await api('POST', `/api/focus/tasks/${taskIds[2]}`);
    const r = await api('POST', `/api/focus/tasks/${taskIds[3]}`);
    expect(r.status).toBe(200);
    expect(r.data.pinned_tasks).toHaveLength(4);
  });

  it('newly pinned task surfaces at the top of the list', async () => {
    // Pins so far (in order): taskIds[0], [1], [2], [3]. Each new pin goes to the
    // front, so the most recently pinned (taskIds[3]) must be first.
    const r = await api('GET', '/api/focus/tasks');
    expect(r.data.pinned_tasks[0]).toBe(taskIds[3]);
    expect(r.data.pinned_tasks[r.data.pinned_tasks.length - 1]).toBe(taskIds[0]);
  });

  it('DELETE /api/focus/tasks/:id unpins a task', async () => {
    const r = await api('DELETE', `/api/focus/tasks/${taskIds[0]}`);
    expect(r.status).toBe(200);

    const r2 = await api('GET', '/api/focus/tasks');
    expect(r2.data.pinned_tasks).not.toContain(taskIds[0]);
    expect(r2.data.pinned_tasks).toHaveLength(3);
  });

  it('pinned tasks persist across GET calls', async () => {
    const r = await api('GET', '/api/focus/tasks');
    expect(r.status).toBe(200);
    expect(r.data.pinned_tasks).toHaveLength(3);
    expect(r.data.pinned_tasks).toContain(taskIds[1]);
    expect(r.data.pinned_tasks).toContain(taskIds[2]);
    expect(r.data.pinned_tasks).toContain(taskIds[3]);
  });

  it('deleting nonexistent task from focus is a no-op', async () => {
    const r = await api('DELETE', '/api/focus/tasks/nonexistent-id');
    expect(r.status).toBe(200);
  });

  it('PUT /api/focus/reorder changes pin order', async () => {
    // Currently pinned: [taskIds[1], taskIds[2], taskIds[3]]
    const reversed = [taskIds[3], taskIds[2], taskIds[1]];
    const r = await api('PUT', '/api/focus/reorder', { task_ids: reversed });
    expect(r.status).toBe(200);
    expect(r.data.pinned_tasks).toEqual(reversed);

    // Verify persistence
    const r2 = await api('GET', '/api/focus/tasks');
    expect(r2.data.pinned_tasks).toEqual(reversed);
  });

  it('reorder with invalid body returns 400', async () => {
    const r = await api('PUT', '/api/focus/reorder', { task_ids: 'not-an-array' });
    expect(r.status).toBe(400);
  });

  // Regression: reorder must return the FULL tier snapshot (focus/satellite/wait),
  // not just pinned_tasks. The client's applyFocusData() treats a missing tier array
  // as empty and wipes every task's focus_tier to satellite — which made Focus tasks
  // silently vanish after a quick-add reorder (they only reappeared on refetch).
  it('reorder returns the full tier split and preserves focus_tier', async () => {
    // Put taskIds[1] in the Focus tier, taskIds[3] in Wait.
    await api('PUT', `/api/focus/tasks/${taskIds[1]}/tier`, { tier: 'focus' });
    await api('PUT', `/api/focus/tasks/${taskIds[3]}/tier`, { tier: 'wait' });

    const order = [taskIds[3], taskIds[2], taskIds[1]];
    const r = await api('PUT', '/api/focus/reorder', { task_ids: order });
    expect(r.status).toBe(200);
    // Response carries all four arrays, not just pinned_tasks.
    expect(r.data.pinned_tasks).toEqual(order);
    expect(r.data.focus_tasks).toContain(taskIds[1]);
    expect(r.data.wait_tasks).toContain(taskIds[3]);
    // The reorder left tiers untouched — a GET agrees.
    const g = await api('GET', '/api/focus/tasks');
    expect(g.data.focus_tasks).toContain(taskIds[1]);
    expect(g.data.wait_tasks).toContain(taskIds[3]);
    // Restore satellite defaults for the tests that follow.
    await api('PUT', `/api/focus/tasks/${taskIds[1]}/tier`, { tier: 'satellite' });
    await api('PUT', `/api/focus/tasks/${taskIds[3]}/tier`, { tier: 'satellite' });
  });

  it('pin state stored on task objects', async () => {
    // Fetch a pinned task and verify the pinned field
    const r = await fetch(apiUrl(`/api/tasks/${taskIds[3]}`));
    const data = await r.json();
    expect(data.task.pinned).toBe(true);
    expect(typeof data.task.pin_order).toBe('number');
  });

  // ── Tier management (the API path exercised during drag-and-drop) ──

  it('PUT /api/focus/tasks/:id/tier sets focus tier', async () => {
    const r = await api('PUT', `/api/focus/tasks/${taskIds[1]}/tier`, { tier: 'focus' });
    expect(r.status).toBe(200);
    expect(r.data.focus_tasks).toContain(taskIds[1]);
    expect(r.data.satellite_tasks).not.toContain(taskIds[1]);
  });

  it('PUT /api/focus/tasks/:id/tier moves to wait tier', async () => {
    const r = await api('PUT', `/api/focus/tasks/${taskIds[1]}/tier`, { tier: 'wait' });
    expect(r.status).toBe(200);
    expect(r.data.wait_tasks).toContain(taskIds[1]);
    expect(r.data.focus_tasks).not.toContain(taskIds[1]);
  });

  it('PUT /api/focus/tasks/:id/tier moves to backlog tier', async () => {
    const r = await api('PUT', `/api/focus/tasks/${taskIds[1]}/tier`, { tier: 'backlog' });
    expect(r.status).toBe(200);
    expect(r.data.backlog_tasks).toContain(taskIds[1]);
    expect(r.data.satellite_tasks).not.toContain(taskIds[1]);
    expect(r.data.wait_tasks).not.toContain(taskIds[1]);
  });

  it('PUT /api/focus/tasks/:id/tier moves to satellite tier', async () => {
    const r = await api('PUT', `/api/focus/tasks/${taskIds[1]}/tier`, { tier: 'satellite' });
    expect(r.status).toBe(200);
    expect(r.data.satellite_tasks).toContain(taskIds[1]);
    expect(r.data.backlog_tasks).not.toContain(taskIds[1]);
    expect(r.data.wait_tasks).not.toContain(taskIds[1]);
    expect(r.data.focus_tasks).not.toContain(taskIds[1]);
  });

  it('the retired "next" tier is now rejected', async () => {
    const r = await api('PUT', `/api/focus/tasks/${taskIds[1]}/tier`, { tier: 'next' });
    expect(r.status).toBe(400);
  });

  it('tier change persists across GET', async () => {
    await api('PUT', `/api/focus/tasks/${taskIds[2]}/tier`, { tier: 'focus' });
    const r = await api('GET', '/api/focus/tasks');
    expect(r.data.focus_tasks).toContain(taskIds[2]);
  });

  it('set-tier on non-pinned task returns 400', async () => {
    const r = await api('PUT', `/api/focus/tasks/${taskIds[0]}/tier`, { tier: 'focus' });
    expect(r.status).toBe(400);
  });

  it('set-tier with invalid tier returns 400', async () => {
    const r = await api('PUT', `/api/focus/tasks/${taskIds[1]}/tier`, { tier: 'invalid' });
    expect(r.status).toBe(400);
  });

  it('rapid tier toggling does not corrupt state (simulates drag oscillation)', async () => {
    // This test simulates the oscillation pattern that caused React #185:
    // rapidly toggling a task between focus and satellite tiers.
    const id = taskIds[3];
    for (let i = 0; i < 10; i++) {
      await api('PUT', `/api/focus/tasks/${id}/tier`, { tier: i % 2 === 0 ? 'focus' : 'satellite' });
    }
    // Final state should be 'satellite' (last iteration i=9, 9%2=1 → 'satellite')
    const r = await api('GET', '/api/focus/tasks');
    expect(r.data.satellite_tasks).toContain(id);
    expect(r.data.focus_tasks).not.toContain(id);
    // All pinned tasks should still be present
    expect(r.data.pinned_tasks).toHaveLength(3);
  });
});
