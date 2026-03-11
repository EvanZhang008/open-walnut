/**
 * Focus Bar E2E tests — pin/unpin tasks, unlimited pins, persistence.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;

function apiUrl(path: string) { return `http://localhost:${port}${path}`; }

async function api(method: string, path: string) {
  const r = await fetch(apiUrl(path), { method });
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
});
