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
    const body1 = await res1.json() as { projects: string[] };
    expect(body1.projects).toEqual([]);

    // Add favorites
    await fetch(apiUrl('/api/favorites/projects/Work'), { method: 'POST' });
    await fetch(apiUrl('/api/favorites/projects/HomeLab'), { method: 'POST' });

    // Read back
    const res2 = await fetch(apiUrl('/api/favorites'));
    const body2 = await res2.json() as { projects: string[] };
    expect(body2.projects).toContain('Work');
    expect(body2.projects).toContain('HomeLab');

    // Remove one
    await fetch(apiUrl('/api/favorites/projects/Work'), { method: 'DELETE' });

    // Verify
    const res3 = await fetch(apiUrl('/api/favorites'));
    const body3 = await res3.json() as { projects: string[] };
    expect(body3.projects).not.toContain('Work');
    expect(body3.projects).toContain('HomeLab');
  });

  it('favorites emit config:changed event', async () => {
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'config:changed');

    await fetch(apiUrl('/api/favorites/projects/Test'), { method: 'POST' });

    const event = await eventPromise;
    expect(event.name).toBe('config:changed');

    ws.close();
    await delay(50);

    // Cleanup
    await fetch(apiUrl('/api/favorites/projects/Test'), { method: 'DELETE' });
  });

  it('favorites are stored in config and persist across reads', async () => {
    await fetch(apiUrl('/api/favorites/projects/Persistent'), { method: 'POST' });

    // Verify via config endpoint
    const configRes = await fetch(apiUrl('/api/config'));
    const configBody = await configRes.json() as { config: { favorites?: { projects?: string[] } } };
    expect(configBody.config.favorites?.projects).toContain('Persistent');

    // Cleanup
    await fetch(apiUrl('/api/favorites/projects/Persistent'), { method: 'DELETE' });
  });
});

// ── Fix 4: Project is the single grouping layer ──
//
// The retired two-level "Category / Project" slash encoding no longer exists:
// `project` is a plain name, stored verbatim, and an omitted project means Inbox.

describe('Fix 4: project field E2E', () => {
  it('creating a task stores the project name verbatim', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Project E2E', project: 'Work idea' }),
    });
    const body = await res.json() as { task: { project: string } };

    expect(body.task.project).toBe('Work idea');
  });

  it('creating a task without a project lands in Inbox (empty project)', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Inbox E2E' }),
    });
    const body = await res.json() as { task: { project: string } };

    expect(body.task.project).toBe('');
  });

  it('WS event for a created task carries the project', async () => {
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:created');

    await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Project WS E2E', project: 'Health' }),
    });

    const event = await eventPromise;
    const data = event.data as { task: { project: string } };
    expect(data.task.project).toBe('Health');

    ws.close();
    await delay(50);
  });

  it('GET returns the stored project', async () => {
    const createRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'GET verify', project: 'Taxes' }),
    });
    const { task } = await createRes.json() as { task: { id: string; project: string } };

    const getRes = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const body = await getRes.json() as { task: { project: string } };

    expect(body.task.project).toBe('Taxes');
  });

  it('PATCH updates the project', async () => {
    const task = await createTask('Patch project');
    const res = await fetch(apiUrl(`/api/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Ai eureka' }),
    });
    const body = await res.json() as { task: { project: string } };

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
      body: JSON.stringify({ title: 'Pipeline test', project: 'work', priority: 'immediate' }),
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

// ── The retired `starred` field is INERT on PATCH ──
//
// The starred system was removed from the product (pin + focus_tier is the
// working set). PATCH must still accept the key from an old client rather than
// 400 it, and must not write it back onto the row.

describe('retired starred field on PATCH /api/tasks/:id', () => {
  it('accepts starred in the body, writes nothing, and touches no other field', async () => {
    const task = await createTask('Retired star field', { project: 'work', priority: 'immediate' });

    const patchRes = await fetch(apiUrl(`/api/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    });
    // Not a 400 — an old client's body degrades to a no-op.
    expect(patchRes.status).toBe(200);

    const res = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const updated = ((await res.json()) as {
      task: { title: string; project: string; priority: string; starred?: boolean };
    }).task;

    expect(updated.starred).not.toBe(true);
    expect(updated.title).toBe('Retired star field');
    expect(updated.project).toBe('work');
    expect(updated.priority).toBe('immediate');
  });
});
