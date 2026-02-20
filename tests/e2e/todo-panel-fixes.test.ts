/**
 * E2E tests for Todo Panel fixes.
 *
 * Spins up a real server with Express + WebSocket, then tests:
 * - Fix 1: WebSocket event delivery with correct { task } wrapper structure
 * - Fix 2: Toggle complete lifecycle via API + WS events
 * - Fix 3: Favorites CRUD + config persistence
 * - Fix 4: Slash format parsing end-to-end
 *
 * These tests verify the full data flow: REST API → Core → Event Bus → WebSocket.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

// ── Helpers ──

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
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

interface WsEvent {
  type: string;
  name?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 3000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs);
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent;
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(frame);
      }
    };
    ws.on('message', handler);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function createTask(title: string, opts: Record<string, string> = {}): Promise<{ id: string; [key: string]: unknown }> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, ...opts }),
  });
  const body = await res.json() as { task: { id: string } };
  return body.task;
}

// ── Setup / Teardown ──

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

// ── Fix 1: WebSocket event structure ──

describe('Fix 1: WS events carry { task } wrapper', () => {
  it('task:created event has task field with id, title, status', async () => {
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:created');

    await createTask('WS structure test');

    const event = await eventPromise;
    const data = event.data as { task?: { id: string; title: string; status: string } };

    expect(data).toHaveProperty('task');
    expect(data.task).toHaveProperty('id');
    expect(data.task!.title).toBe('WS structure test');
    expect(data.task!.status).toBe('todo');

    ws.close();
    await delay(50);
  });

  it('task:completed event has task field with status done', async () => {
    const task = await createTask('Complete for WS test');
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:completed');

    await fetch(apiUrl(`/api/tasks/${task.id}/complete`), { method: 'POST' });

    const event = await eventPromise;
    const data = event.data as { task?: { id: string; status: string } };

    expect(data.task).toBeDefined();
    expect(data.task!.id).toBe(task.id);
    expect(data.task!.status).toBe('done');

    ws.close();
    await delay(50);
  });

  it('task:starred event has task field with starred boolean', async () => {
    const task = await createTask('Star for WS test');
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:starred');

    await fetch(apiUrl(`/api/tasks/${task.id}/star`), { method: 'POST' });

    const event = await eventPromise;
    const data = event.data as { task?: { id: string; starred: boolean } };

    expect(data.task).toBeDefined();
    expect(data.task!.id).toBe(task.id);

    ws.close();
    await delay(50);
  });

  it('task:updated event from PATCH has task field', async () => {
    const task = await createTask('Update for WS test');
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:updated');

    await fetch(apiUrl(`/api/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated title' }),
    });

    const event = await eventPromise;
    const data = event.data as { task?: { id: string; title: string } };

    expect(data.task).toBeDefined();
    expect(data.task!.id).toBe(task.id);
    expect(data.task!.title).toBe('Updated title');

    ws.close();
    await delay(50);
  });
});

// ── Fix 2: Toggle complete E2E ──

describe('Fix 2: Toggle complete E2E', () => {
  it('toggle-complete API: todo → done', async () => {
    const task = await createTask('Toggle E2E');

    const res = await fetch(apiUrl(`/api/tasks/${task.id}/toggle-complete`), { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { task: { status: string } };
    expect(body.task.status).toBe('done');
  });

  it('toggle-complete API: done → todo', async () => {
    const task = await createTask('Reopen E2E');
    await fetch(apiUrl(`/api/tasks/${task.id}/complete`), { method: 'POST' });

    const res = await fetch(apiUrl(`/api/tasks/${task.id}/toggle-complete`), { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { task: { status: string } };
    expect(body.task.status).toBe('todo');
  });

  it('toggle-complete fires task:completed when going to done', async () => {
    const task = await createTask('Toggle WS done');
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:completed');

    await fetch(apiUrl(`/api/tasks/${task.id}/toggle-complete`), { method: 'POST' });

    const event = await eventPromise;
    const data = event.data as { task: { id: string; status: string } };
    expect(data.task.status).toBe('done');

    ws.close();
    await delay(50);
  });

  it('toggle-complete fires task:updated when going back to todo', async () => {
    const task = await createTask('Toggle WS todo');
    await fetch(apiUrl(`/api/tasks/${task.id}/complete`), { method: 'POST' });

    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:updated');

    await fetch(apiUrl(`/api/tasks/${task.id}/toggle-complete`), { method: 'POST' });

    const event = await eventPromise;
    const data = event.data as { task: { id: string; status: string } };
    expect(data.task.status).toBe('todo');

    ws.close();
    await delay(50);
  });

  it('state persists after toggle — GET confirms', async () => {
    const task = await createTask('Toggle persist');

    await fetch(apiUrl(`/api/tasks/${task.id}/toggle-complete`), { method: 'POST' });
    const get1 = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const body1 = await get1.json() as { task: { status: string } };
    expect(body1.task.status).toBe('done');

    await fetch(apiUrl(`/api/tasks/${task.id}/toggle-complete`), { method: 'POST' });
    const get2 = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const body2 = await get2.json() as { task: { status: string } };
    expect(body2.task.status).toBe('todo');
  });
});

// ── Fix 3: Favorites E2E ──

describe('Fix 3: Favorites E2E', () => {
  it('full favorites lifecycle: add, read, remove', async () => {
    // Initially empty
    const res1 = await fetch(apiUrl('/api/favorites'));
    const body1 = await res1.json() as { categories: string[]; projects: string[] };
    expect(body1.categories).toEqual([]);
    expect(body1.projects).toEqual([]);

    // Add favorites
    await fetch(apiUrl('/api/favorites/categories/Work'), { method: 'POST' });
    await fetch(apiUrl('/api/favorites/projects/HomeLab'), { method: 'POST' });

    // Read back
    const res2 = await fetch(apiUrl('/api/favorites'));
    const body2 = await res2.json() as { categories: string[]; projects: string[] };
    expect(body2.categories).toContain('Work');
    expect(body2.projects).toContain('HomeLab');

    // Remove one
    await fetch(apiUrl('/api/favorites/categories/Work'), { method: 'DELETE' });

    // Verify
    const res3 = await fetch(apiUrl('/api/favorites'));
    const body3 = await res3.json() as { categories: string[]; projects: string[] };
    expect(body3.categories).not.toContain('Work');
    expect(body3.projects).toContain('HomeLab');
  });

  it('favorites emit config:changed event', async () => {
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'config:changed');

    await fetch(apiUrl('/api/favorites/categories/Test'), { method: 'POST' });

    const event = await eventPromise;
    expect(event.name).toBe('config:changed');

    ws.close();
    await delay(50);

    // Cleanup
    await fetch(apiUrl('/api/favorites/categories/Test'), { method: 'DELETE' });
  });

  it('favorites are stored in config and persist across reads', async () => {
    await fetch(apiUrl('/api/favorites/categories/Persistent'), { method: 'POST' });

    // Verify via config endpoint
    const configRes = await fetch(apiUrl('/api/config'));
    const configBody = await configRes.json() as { config: { favorites?: { categories?: string[] } } };
    expect(configBody.config.favorites?.categories).toContain('Persistent');

    // Cleanup
    await fetch(apiUrl('/api/favorites/categories/Persistent'), { method: 'DELETE' });
  });
});

// ── Fix 4: Slash parsing E2E ──

describe('Fix 4: Slash format parsing E2E', () => {
  it('creating task with "category / project" splits correctly', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Slash E2E', category: 'idea / work idea' }),
    });
    const body = await res.json() as { task: { category: string; project: string } };

    expect(body.task.category).toBe('Idea');
    expect(body.task.project).toBe('Work idea');
  });

  it('WS event for slash-parsed task has correct category/project', async () => {
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:created');

    await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Slash WS E2E', category: 'life / health' }),
    });

    const event = await eventPromise;
    const data = event.data as { task: { category: string; project: string } };
    expect(data.task.category).toBe('Life');
    expect(data.task.project).toBe('Health');

    ws.close();
    await delay(50);
  });

  it('GET returns task with parsed fields, not raw slash format', async () => {
    const createRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'GET verify', category: 'work / taxes' }),
    });
    const { task } = await createRes.json() as { task: { id: string; category: string; project: string } };

    const getRes = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const body = await getRes.json() as { task: { category: string; project: string } };

    expect(body.task.category).toBe('Work');
    expect(body.task.project).toBe('Taxes');
  });

  it('PATCH with slash category updates both fields', async () => {
    const task = await createTask('Patch slash');
    const res = await fetch(apiUrl(`/api/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'personal / ai eureka' }),
    });
    const body = await res.json() as { task: { category: string; project: string } };

    expect(body.task.category).toBe('Personal');
    expect(body.task.project).toBe('Ai eureka');
  });
});

// ── Combined flow: REST → Core → Bus → WS ──

describe('Full pipeline: REST → Core → Bus → WS delivery', () => {
  it('create task → WS receives full task object → toggle complete → WS receives updated state', async () => {
    const ws = await connectWs();

    // Step 1: Create task — WS should receive task:created with { task }
    const createPromise = waitForWsEvent(ws, 'task:created');
    const createRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pipeline test', category: 'work', priority: 'immediate' }),
    });
    const { task } = await createRes.json() as { task: { id: string } };

    const createEvent = await createPromise;
    const createData = createEvent.data as { task: { id: string; title: string; status: string } };
    expect(createData.task.id).toBe(task.id);
    expect(createData.task.title).toBe('Pipeline test');
    expect(createData.task.status).toBe('todo');

    // Step 2: Toggle to done — WS should receive task:completed
    const completePromise = waitForWsEvent(ws, 'task:completed');
    await fetch(apiUrl(`/api/tasks/${task.id}/toggle-complete`), { method: 'POST' });

    const completeEvent = await completePromise;
    const completeData = completeEvent.data as { task: { id: string; status: string } };
    expect(completeData.task.id).toBe(task.id);
    expect(completeData.task.status).toBe('done');

    // Step 3: Toggle back to todo — WS should receive task:updated
    const reopenPromise = waitForWsEvent(ws, 'task:updated');
    await fetch(apiUrl(`/api/tasks/${task.id}/toggle-complete`), { method: 'POST' });

    const reopenEvent = await reopenPromise;
    const reopenData = reopenEvent.data as { task: { id: string; status: string } };
    expect(reopenData.task.id).toBe(task.id);
    expect(reopenData.task.status).toBe('todo');

    // Step 4: Star — WS should receive task:starred
    const starPromise = waitForWsEvent(ws, 'task:starred');
    await fetch(apiUrl(`/api/tasks/${task.id}/star`), { method: 'POST' });

    const starEvent = await starPromise;
    const starData = starEvent.data as { task: { id: string; starred: boolean } };
    expect(starData.task.id).toBe(task.id);

    ws.close();
    await delay(50);
  });

  it('multiple WS clients all receive toggle-complete event', async () => {
    const task = await createTask('Multi client toggle');
    const ws1 = await connectWs();
    const ws2 = await connectWs();

    const event1 = waitForWsEvent(ws1, 'task:completed');
    const event2 = waitForWsEvent(ws2, 'task:completed');

    await fetch(apiUrl(`/api/tasks/${task.id}/toggle-complete`), { method: 'POST' });

    const [e1, e2] = await Promise.all([event1, event2]);
    const d1 = e1.data as { task: { id: string } };
    const d2 = e2.data as { task: { id: string } };

    expect(d1.task.id).toBe(task.id);
    expect(d2.task.id).toBe(task.id);

    ws1.close();
    ws2.close();
    await delay(50);
  });
});

// ── Starred via PATCH /api/tasks/:id E2E ──

describe('Starred via PATCH update_task', () => {
  it('PATCH starred=true sets starred, GET confirms, PATCH starred=false reverts', async () => {
    const task = await createTask('Star via PATCH test');

    // Baseline: starred should not be true
    const baseline = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const baseTask = ((await baseline.json()) as { task: { starred?: boolean } }).task;
    expect(baseTask.starred).not.toBe(true);

    // PATCH starred=true
    const patchRes = await fetch(apiUrl(`/api/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    });
    const patchTask = ((await patchRes.json()) as { task: { starred: boolean } }).task;
    expect(patchTask.starred).toBe(true);

    // GET confirms persistence
    const getRes = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const getTask = ((await getRes.json()) as { task: { starred: boolean } }).task;
    expect(getTask.starred).toBe(true);

    // PATCH starred=false
    const revertRes = await fetch(apiUrl(`/api/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: false }),
    });
    const revertTask = ((await revertRes.json()) as { task: { starred: boolean } }).task;
    expect(revertTask.starred).toBe(false);

    // GET confirms revert
    const finalRes = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const finalTask = ((await finalRes.json()) as { task: { starred: boolean } }).task;
    expect(finalTask.starred).toBe(false);
  });

  it('PATCH starred=true emits task:updated WS event with starred field', async () => {
    const task = await createTask('Star WS event test');
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:updated');

    await fetch(apiUrl(`/api/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    });

    const event = await eventPromise;
    const data = event.data as { task: { id: string; starred: boolean } };

    expect(data.task).toBeDefined();
    expect(data.task.id).toBe(task.id);
    expect(data.task.starred).toBe(true);

    ws.close();
    await delay(50);
  });

  it('starring does not affect other task fields', async () => {
    const task = await createTask('No side effects', { category: 'work', priority: 'immediate' });

    await fetch(apiUrl(`/api/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    });

    const res = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const updated = ((await res.json()) as { task: { title: string; category: string; priority: string; starred: boolean } }).task;

    expect(updated.title).toBe('No side effects');
    expect(updated.category).toBe('work');
    expect(updated.priority).toBe('immediate');
    expect(updated.starred).toBe(true);
  });
});
