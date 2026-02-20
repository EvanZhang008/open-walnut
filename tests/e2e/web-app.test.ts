/**
 * E2E smoke tests for the full web application stack.
 *
 * Starts a real server with Express + WebSocket on a random port,
 * tests REST API + WebSocket event push + task lifecycle end-to-end.
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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

// ── Server startup ──

describe('Server startup', () => {
  it('startServer() starts without errors', () => {
    expect(server).toBeDefined();
    expect(server.listening).toBe(true);
  });

  it('server responds to HTTP requests on configured port', async () => {
    const res = await fetch(apiUrl('/api/dashboard'));
    expect(res.status).toBe(200);
  });

  it('WebSocket accepts connections', async () => {
    const ws = await connectWs();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await delay(50);
  });
});

// ── Task lifecycle E2E ──

describe('Task lifecycle E2E', () => {
  let taskId: string;

  it('create task via POST /api/tasks', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'E2E task', priority: 'immediate', category: 'work', project: 'walnut' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { task: { id: string; title: string; priority: string } };
    expect(body.task.title).toBe('E2E task');
    expect(body.task.priority).toBe('immediate');
    taskId = body.task.id;
  });

  it('verify task appears in GET /api/tasks', async () => {
    const res = await fetch(apiUrl('/api/tasks'));
    const body = await res.json() as { tasks: Array<{ id: string; title: string }> };
    expect(body.tasks.some((t) => t.id === taskId)).toBe(true);
  });

  it('update task via PATCH', async () => {
    const res = await fetch(apiUrl(`/api/tasks/${taskId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated E2E task' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { task: { title: string } };
    expect(body.task.title).toBe('Updated E2E task');
  });

  it('star task', async () => {
    const res = await fetch(apiUrl(`/api/tasks/${taskId}/star`), { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { starred: boolean };
    expect(body.starred).toBe(true);
  });

  it('add note', async () => {
    const res = await fetch(apiUrl(`/api/tasks/${taskId}/notes`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'E2E note content' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { task: { note: string } };
    expect(body.task.note).toContain('E2E note content');
  });

  it('child task lifecycle (create as child, complete, delete)', async () => {
    // Create a child task
    const addRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'E2E child task', parent_task_id: taskId, category: 'E2E', project: 'E2E' }),
    });
    expect(addRes.status).toBe(201);
    const addBody = await addRes.json() as { task: { id: string; parent_task_id: string } };
    expect(addBody.task.parent_task_id).toBe(taskId);
    const childId = addBody.task.id;

    // Complete child task
    const completeRes = await fetch(apiUrl(`/api/tasks/${childId}/complete`), { method: 'POST' });
    expect(completeRes.status).toBe(200);

    // Delete child task
    const delRes = await fetch(apiUrl(`/api/tasks/${childId}`), { method: 'DELETE' });
    expect(delRes.status).toBe(200);
  });

  it('complete task', async () => {
    const res = await fetch(apiUrl(`/api/tasks/${taskId}/complete`), { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { task: { status: string } };
    expect(body.task.status).toBe('done');
  });
});

// ── Task description at creation E2E ──

describe('Task description at creation E2E', () => {
  it('creates task with description and persists it', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Described task', description: 'What & why context', category: 'work' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { task: { id: string; description: string } };
    expect(body.task.description).toBe('What & why context');

    // Verify persistence via GET
    const getRes = await fetch(apiUrl(`/api/tasks/${body.task.id}`));
    const getBody = await getRes.json() as { task: { description: string } };
    expect(getBody.task.description).toBe('What & why context');
  });

  it('creates task without description — defaults to empty string', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'No-desc task' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { task: { description: string } };
    expect(body.task.description).toBe('');
  });
});

// ── Dashboard E2E ──

describe('Dashboard E2E', () => {
  it('GET /api/dashboard returns stats reflecting task operations', async () => {
    const res = await fetch(apiUrl('/api/dashboard'));
    expect(res.status).toBe(200);
    const body = await res.json() as { stats: { total: number; done: number } };
    expect(body.stats.total).toBeGreaterThanOrEqual(1);
    expect(body.stats.done).toBeGreaterThanOrEqual(1);
  });
});

// ── Search E2E ──

describe('Search E2E', () => {
  it('search finds a task by title', async () => {
    // Create a task with distinctive title
    await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Unique zebra task for search' }),
    });

    // Wait for indexing to complete (memory watcher debounce)
    await new Promise(r => setTimeout(r, 2000));

    // Search with retry (indexing may take a moment)
    let found = false;
    for (let i = 0; i < 3; i++) {
      const res = await fetch(apiUrl('/api/search?q=zebra'));
      expect(res.status).toBe(200);
      const body = await res.json() as { results: Array<{ title: string; type?: string }> };
      const taskResults = body.results.filter(r => r.title?.includes('zebra'));
      if (taskResults.length > 0) {
        found = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(found).toBe(true);
  });
});

// ── WebSocket real-time E2E ──

describe('WebSocket real-time E2E', () => {
  it('WS client receives task:created event when task created via REST', async () => {
    const ws = await connectWs();
    const msgPromise = waitForWsMessage(ws);

    await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'WS event test task' }),
    });

    const frame = await msgPromise;
    expect(frame.type).toBe('event');
    expect(frame.name).toBe('task:created');

    ws.close();
    await delay(50);
  });

  it('WS client receives task:completed event when task completed via REST', async () => {
    // Create a task first
    const createRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Complete me for WS test' }),
    });
    const { task } = await createRes.json() as { task: { id: string } };

    const ws = await connectWs();
    const msgPromise = waitForWsMessage(ws);

    await fetch(apiUrl(`/api/tasks/${task.id}/complete`), { method: 'POST' });

    const frame = await msgPromise;
    expect(frame.type).toBe('event');
    expect(frame.name).toBe('task:completed');

    ws.close();
    await delay(50);
  });

  it('multiple WS clients all receive the same event', async () => {
    const ws1 = await connectWs();
    const ws2 = await connectWs();

    const msg1 = waitForWsMessage(ws1);
    const msg2 = waitForWsMessage(ws2);

    await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Multi WS test' }),
    });

    const [frame1, frame2] = await Promise.all([msg1, msg2]);
    expect(frame1.type).toBe('event');
    expect(frame2.type).toBe('event');
    expect(frame1.name).toBe(frame2.name);

    ws1.close();
    ws2.close();
    await delay(50);
  });
});

// ── Config E2E ──

describe('Config E2E', () => {
  it('read config, modify, save, re-read — changes persist', async () => {
    // Read initial config
    const getRes1 = await fetch(apiUrl('/api/config'));
    expect(getRes1.status).toBe(200);
    const { config: initial } = await getRes1.json() as { config: Record<string, unknown> };

    // Modify config
    const updated = { ...initial, user: { name: 'E2E Tester' } };
    const putRes = await fetch(apiUrl('/api/config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    expect(putRes.status).toBe(200);

    // Re-read and verify
    const getRes2 = await fetch(apiUrl('/api/config'));
    const { config: reread } = await getRes2.json() as { config: { user: { name: string } } };
    expect(reread.user.name).toBe('E2E Tester');
  });
});
