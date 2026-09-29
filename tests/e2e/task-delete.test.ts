/**
 * E2E tests for task deletion with active-session guard.
 *
 * Starts a real server on a random port, tests:
 * 1. Deleting a task with no active sessions → 204
 * 2. Deleting a task with active sessions → 409 + error message
 * 3. Clearing sessions then deleting → 204
 * 4. WebSocket broadcasts task:deleted event on success
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { linkSession, linkSessionSlot, clearSessionSlot } from '../../src/core/task-manager.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';

/** The delete guard blocks only on a session that may still be running. */
async function seedSession(sid: string, taskId: string, status: 'running' | 'idle' | 'stopped' = 'running'): Promise<void> {
  await createSessionRecord(sid, taskId, '', undefined, { initialProcessStatus: status });
}

let server: HttpServer;
let port: number;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

function wsUrl(): string {
  return `ws://localhost:${port}/ws`;
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForWsMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function createTask(title: string): Promise<{ id: string; title: string }> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, category: 'test' }),
  });
  const body = await res.json() as { task: { id: string; title: string } };
  return body.task;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('Task deletion — no active sessions', () => {
  it('DELETE returns 204 and removes the task', async () => {
    const task = await createTask('Delete me freely');

    const deleteRes = await fetch(apiUrl(`/api/tasks/${task.id}`), { method: 'DELETE' });
    expect(deleteRes.status).toBe(204);

    // Verify it's gone
    const listRes = await fetch(apiUrl('/api/tasks'));
    const listBody = await listRes.json() as { tasks: Array<{ id: string }> };
    expect(listBody.tasks.find((t) => t.id === task.id)).toBeUndefined();
  });

  it('broadcasts task:deleted event via WebSocket', async () => {
    const task = await createTask('WS delete event');
    const ws = await connectWs();

    try {
      const msgPromise = waitForWsMessage(ws);
      await fetch(apiUrl(`/api/tasks/${task.id}`), { method: 'DELETE' });
      const msg = await msgPromise;

      expect(msg.name).toBe('task:deleted');
      expect((msg.data as { id: string }).id).toBe(task.id);
    } finally {
      ws.close();
    }
  });
});

describe('Task deletion — blocked by active sessions', () => {
  it('DELETE returns 409 when task has one active session', async () => {
    const task = await createTask('Has active session');
    await seedSession('sess-block-1', task.id);
    await linkSessionSlot(task.id, 'sess-block-1', 'exec');

    const deleteRes = await fetch(apiUrl(`/api/tasks/${task.id}`), { method: 'DELETE' });
    expect(deleteRes.status).toBe(409);

    const body = await deleteRes.json() as { error: string; active_session_ids: string[] };
    expect(body.error).toMatch(/active sessions/);
    expect(body.active_session_ids).toContain('sess-block-1');

    // Verify task still exists
    const listRes = await fetch(apiUrl('/api/tasks'));
    const listBody = await listRes.json() as { tasks: Array<{ id: string }> };
    expect(listBody.tasks.find((t) => t.id === task.id)).toBeDefined();
  });

  it('DELETE returns 409 with multiple active session IDs', async () => {
    const task = await createTask('Has many sessions');
    // Use both slots (plan + exec) to have 2 active sessions
    await seedSession('sess-multi-1', task.id, 'idle');
    await seedSession('sess-multi-2', task.id);
    await linkSessionSlot(task.id, 'sess-multi-1', 'plan');
    await linkSessionSlot(task.id, 'sess-multi-2', 'exec');

    const deleteRes = await fetch(apiUrl(`/api/tasks/${task.id}`), { method: 'DELETE' });
    expect(deleteRes.status).toBe(409);

    const body = await deleteRes.json() as { error: string; active_session_ids: string[] };
    expect(body.active_session_ids).toHaveLength(2);
    expect(body.active_session_ids).toContain('sess-multi-1');
    expect(body.active_session_ids).toContain('sess-multi-2');
  });

  it('allows deletion after clearing all active sessions', async () => {
    const task = await createTask('Clear then delete');
    await seedSession('sess-clear-1', task.id);
    await seedSession('sess-clear-2', task.id);
    await linkSessionSlot(task.id, 'sess-clear-1', 'plan');
    await linkSessionSlot(task.id, 'sess-clear-2', 'exec');

    // Should fail first
    const failRes = await fetch(apiUrl(`/api/tasks/${task.id}`), { method: 'DELETE' });
    expect(failRes.status).toBe(409);

    // Clear all active sessions
    await clearSessionSlot(task.id);

    // Now should succeed
    const okRes = await fetch(apiUrl(`/api/tasks/${task.id}`), { method: 'DELETE' });
    expect(okRes.status).toBe(204);

    // Verify gone
    const listRes = await fetch(apiUrl('/api/tasks'));
    const listBody = await listRes.json() as { tasks: Array<{ id: string }> };
    expect(listBody.tasks.find((t) => t.id === task.id)).toBeUndefined();
  });

  // Regression (2026-08-12): force-delete released only the plan/exec slots, so a
  // task whose PRIMARY slot (session_id) was set re-threw ActiveSessionError on
  // the retry and the route answered 500. Both delete routes must clear it.
  for (const route of ['/api/tasks', '/api/v1/tasks']) {
    it(`DELETE ${route}/:id?force=true deletes a task holding a primary session`, async () => {
      const task = await createTask(`Force delete via ${route}`);
      const sid = `sess-force-${route.replace(/\W+/g, '-')}`;
      await seedSession(sid, task.id);
      await linkSessionSlot(task.id, sid, 'exec');
      await linkSession(task.id, sid);

      // Running: a plain delete is refused, force stops the session and deletes.
      const refused = await fetch(apiUrl(`${route}/${task.id}`), { method: 'DELETE' });
      expect(refused.status).toBe(409);
      const res = await fetch(apiUrl(`${route}/${task.id}?force=true`), { method: 'DELETE' });
      expect(res.status).toBe(204);

      const listRes = await fetch(apiUrl('/api/tasks'));
      const listBody = await listRes.json() as { tasks: Array<{ id: string }> };
      expect(listBody.tasks.find((t) => t.id === task.id)).toBeUndefined();
    });

    // A task keeps session_id after its session ends; a plain delete (the calendar's
    // delete sends no force) must still succeed once the session has stopped.
    it(`DELETE ${route}/:id without force deletes a task whose session has stopped`, async () => {
      const task = await createTask(`Stopped session via ${route}`);
      const sid = `sess-stopped-${route.replace(/\W+/g, '-')}`;
      await seedSession(sid, task.id, 'stopped');
      await linkSession(task.id, sid);

      const res = await fetch(apiUrl(`${route}/${task.id}`), { method: 'DELETE' });
      expect(res.status).toBe(204);
    });
  }
});

describe('Task deletion — error cases', () => {
  it('returns 404 for non-existent task ID', async () => {
    const deleteRes = await fetch(apiUrl('/api/tasks/does-not-exist'), { method: 'DELETE' });
    expect(deleteRes.status).toBe(404);
  });
});
