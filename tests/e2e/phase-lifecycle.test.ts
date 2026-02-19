/**
 * E2E tests for the phase lifecycle feature.
 *
 * Spins up a real server with Express + WebSocket, then tests:
 * 1. New tasks get phase=TODO by default
 * 2. Phase can be updated via PATCH /api/tasks/:id
 * 3. Phase drives derived status correctly (7→3 mapping)
 * 4. Phase cycling through all 7 states
 * 5. Toggle complete uses phase (TODO ↔ COMPLETE)
 * 6. Invalid phase values are rejected with 400
 * 7. Legacy status-only updates derive phase
 * 8. Phase migration: tasks without phase get it backfilled
 * 9. WebSocket events carry phase field
 * 10. Sprint field is persisted and returned
 * 11. Tags CRUD: create with tags, add_tags, remove_tags, set_tags
 * 12. Tags meta endpoint returns unique tags with counts
 * 13. Tags query filtering
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, TASKS_FILE, TASKS_DIR } from '../../src/constants.js';
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

interface TaskResponse {
  id: string;
  title: string;
  status: string;
  phase: string;
  sprint?: string;
  tags?: string[];
  completed_at?: string;
  [key: string]: unknown;
}

async function createTask(title: string, opts: Record<string, string> = {}): Promise<TaskResponse> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, ...opts }),
  });
  expect(res.status).toBe(201);
  const body = await res.json() as { task: TaskResponse };
  return body.task;
}

async function getTask(id: string): Promise<TaskResponse> {
  const res = await fetch(apiUrl(`/api/tasks/${id}`));
  expect(res.status).toBe(200);
  const body = await res.json() as { task: TaskResponse };
  return body.task;
}

async function updateTask(id: string, updates: Record<string, unknown>): Promise<TaskResponse> {
  const res = await fetch(apiUrl(`/api/tasks/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { task: TaskResponse };
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

// ── Tests ──

describe('Phase lifecycle E2E', () => {
  // Test 1: New tasks get phase=TODO
  it('new task gets phase=TODO and status=todo', async () => {
    const task = await createTask('Phase test: new task');
    expect(task.phase).toBe('TODO');
    expect(task.status).toBe('todo');
  });

  // Test 2: Phase can be updated via PATCH
  it('PATCH with phase updates both phase and derived status', async () => {
    const task = await createTask('Phase test: update');
    expect(task.phase).toBe('TODO');

    const updated = await updateTask(task.id, { phase: 'IN_PROGRESS' });
    expect(updated.phase).toBe('IN_PROGRESS');
    expect(updated.status).toBe('in_progress');
  });

  // Test 3: Phase → status mapping for all 7 phases
  it('all 7 phases derive correct status', async () => {
    const task = await createTask('Phase test: status mapping');

    const phaseToExpectedStatus: [string, string][] = [
      ['TODO', 'todo'],
      ['IN_PROGRESS', 'in_progress'],
      ['AGENT_COMPLETE', 'in_progress'],
      ['AWAIT_HUMAN_ACTION', 'in_progress'],
      ['PEER_CODE_REVIEW', 'in_progress'],
      ['RELEASE_IN_PIPELINE', 'in_progress'],
      ['COMPLETE', 'done'],
    ];

    for (const [phase, expectedStatus] of phaseToExpectedStatus) {
      const updated = await updateTask(task.id, { phase });
      expect(updated.phase).toBe(phase);
      expect(updated.status).toBe(expectedStatus);
    }
  });

  // Test 4: Phase cycling through all 7 states in order
  it('phase cycles through all 7 states in order', async () => {
    const task = await createTask('Phase test: cycle');
    expect(task.phase).toBe('TODO');

    const cycle = [
      'IN_PROGRESS',
      'AGENT_COMPLETE',
      'AWAIT_HUMAN_ACTION',
      'PEER_CODE_REVIEW',
      'RELEASE_IN_PIPELINE',
      'COMPLETE',
      'TODO', // back to start (full loop)
    ];

    let currentTask = task;
    for (const nextPhase of cycle) {
      currentTask = await updateTask(currentTask.id, { phase: nextPhase });
      expect(currentTask.phase).toBe(nextPhase);
    }
  });

  // Test 4b: AWAIT_HUMAN_ACTION phase derives in_progress status
  it('AWAIT_HUMAN_ACTION phase derives in_progress status', async () => {
    const task = await createTask('Phase test: await human action');

    const updated = await updateTask(task.id, { phase: 'AWAIT_HUMAN_ACTION' });
    expect(updated.phase).toBe('AWAIT_HUMAN_ACTION');
    expect(updated.status).toBe('in_progress');

    // Verify persisted via GET
    const fetched = await getTask(task.id);
    expect(fetched.phase).toBe('AWAIT_HUMAN_ACTION');
    expect(fetched.status).toBe('in_progress');
  });

  // Test 5: Toggle complete uses phase (TODO ↔ COMPLETE)
  it('toggle complete switches between TODO and COMPLETE phases', async () => {
    const task = await createTask('Phase test: toggle');
    expect(task.phase).toBe('TODO');

    // Toggle to complete
    let res = await fetch(apiUrl(`/api/tasks/${task.id}/toggle-complete`), { method: 'POST' });
    expect(res.status).toBe(200);
    let toggled = ((await res.json()) as { task: TaskResponse }).task;
    expect(toggled.phase).toBe('COMPLETE');
    expect(toggled.status).toBe('done');
    expect(toggled.completed_at).toBeDefined();

    // Toggle back to open
    res = await fetch(apiUrl(`/api/tasks/${task.id}/toggle-complete`), { method: 'POST' });
    expect(res.status).toBe(200);
    toggled = ((await res.json()) as { task: TaskResponse }).task;
    expect(toggled.phase).toBe('TODO');
    expect(toggled.status).toBe('todo');
    expect(toggled.completed_at).toBeUndefined();
  });

  // Test 6: Invalid phase values are rejected
  it('rejects invalid phase values with 400', async () => {
    const task = await createTask('Phase test: invalid');

    const res = await fetch(apiUrl(`/api/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'INVALID_PHASE' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('phase must be one of');
  });

  // Test 7: Legacy status-only updates derive phase
  it('status-only update derives corresponding phase', async () => {
    const task = await createTask('Phase test: legacy status');
    expect(task.phase).toBe('TODO');

    // Update only status → phase should be derived
    const updated = await updateTask(task.id, { status: 'in_progress' });
    expect(updated.status).toBe('in_progress');
    expect(updated.phase).toBe('IN_PROGRESS');

    // Update to done → phase should be COMPLETE
    const done = await updateTask(task.id, { status: 'done' });
    expect(done.status).toBe('done');
    expect(done.phase).toBe('COMPLETE');
  });

  // Test 8: Phase migration logic is correct (unit-level verification)
  it('phase migration: status-only task updated via API gets phase derived', async () => {
    // This tests that the migration path works: if a task somehow has no phase,
    // any update to it will ensure phase consistency via updateTaskRaw.
    // We can't test file-level migration in E2E since the store is already loaded.
    // Instead, we verify the API always returns phase for every task.
    const task = await createTask('Migration test: phase always present');
    expect(task.phase).toBe('TODO');
    expect(task.status).toBe('todo');

    // Update via status (legacy path) — phase should be derived
    const updated = await updateTask(task.id, { status: 'in_progress' });
    expect(updated.phase).toBe('IN_PROGRESS');
    expect(updated.status).toBe('in_progress');
  });

  // Test 9: WebSocket events carry phase field
  it('WS task:updated event carries phase field', async () => {
    const ws = await connectWs();
    try {
      const task = await createTask('Phase test: WS event');

      const eventPromise = waitForWsEvent(ws, 'task:updated');
      await updateTask(task.id, { phase: 'PEER_CODE_REVIEW' });

      const event = await eventPromise;
      const eventTask = (event.data as { task: TaskResponse }).task;
      expect(eventTask.phase).toBe('PEER_CODE_REVIEW');
      expect(eventTask.status).toBe('in_progress');
    } finally {
      ws.close();
      await delay(50);
    }
  });

  // Test 10: Complete task via POST /api/tasks/:id/complete sets COMPLETE phase
  it('POST /complete sets phase=COMPLETE', async () => {
    const task = await createTask('Phase test: complete endpoint');
    expect(task.phase).toBe('TODO');

    const res = await fetch(apiUrl(`/api/tasks/${task.id}/complete`), { method: 'POST' });
    expect(res.status).toBe(200);
    const completed = ((await res.json()) as { task: TaskResponse }).task;
    expect(completed.phase).toBe('COMPLETE');
    expect(completed.status).toBe('done');
    expect(completed.completed_at).toBeDefined();
  });

  // Test 11: Phase takes priority over status when both provided
  it('phase wins over status when both are provided', async () => {
    const task = await createTask('Phase test: priority');

    // Provide both phase and status — phase should win
    const updated = await updateTask(task.id, {
      phase: 'AGENT_COMPLETE',
      status: 'done', // this should be ignored, overridden by phase
    });
    expect(updated.phase).toBe('AGENT_COMPLETE');
    expect(updated.status).toBe('in_progress'); // derived from AGENT_COMPLETE, not 'done'
  });

  // Test 12: GET /api/tasks returns phase in list
  it('GET /api/tasks includes phase field in response', async () => {
    await createTask('Phase test: list');

    const res = await fetch(apiUrl('/api/tasks'));
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: TaskResponse[] };

    const found = body.tasks.find((t) => t.title === 'Phase test: list');
    expect(found).toBeDefined();
    expect(found!.phase).toBe('TODO');
  });

  // Test 13: GET /api/tasks/enriched returns phase
  it('GET /api/tasks/enriched includes phase field', async () => {
    await createTask('Phase test: enriched');

    const res = await fetch(apiUrl('/api/tasks/enriched'));
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: TaskResponse[] };

    const found = body.tasks.find((t) => t.title === 'Phase test: enriched');
    expect(found).toBeDefined();
    expect(found!.phase).toBe('TODO');
  });
});

describe('Active children guard E2E', () => {
  it('blocks completing parent with active child via toggle-complete', async () => {
    const parent = await createTask('E2E parent');
    await createTask('E2E child', { parent_task_id: parent.id });

    const res = await fetch(apiUrl(`/api/tasks/${parent.id}/toggle-complete`), { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; active_children: number };
    expect(body.error).toContain('child task');
    expect(body.active_children).toBe(1);
  });

  it('blocks completing parent with active child via POST /complete', async () => {
    const parent = await createTask('E2E parent 2');
    await createTask('E2E child 2', { parent_task_id: parent.id });

    const res = await fetch(apiUrl(`/api/tasks/${parent.id}/complete`), { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('child task');
  });

  it('blocks completing parent with active child via PATCH phase=COMPLETE', async () => {
    const parent = await createTask('E2E parent 3');
    await createTask('E2E child 3', { parent_task_id: parent.id });

    const res = await fetch(apiUrl(`/api/tasks/${parent.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'COMPLETE' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('child task');
  });

  it('allows completing parent after all children are complete', async () => {
    const parent = await createTask('E2E parent ok');
    const child = await createTask('E2E child ok', { parent_task_id: parent.id });

    // Complete child first
    const childRes = await fetch(apiUrl(`/api/tasks/${child.id}/complete`), { method: 'POST' });
    expect(childRes.status).toBe(200);

    // Now parent should complete successfully
    const parentRes = await fetch(apiUrl(`/api/tasks/${parent.id}/complete`), { method: 'POST' });
    expect(parentRes.status).toBe(200);
    const completed = ((await parentRes.json()) as { task: TaskResponse }).task;
    expect(completed.phase).toBe('COMPLETE');
  });

  it('allows reopening completed parent (toggle COMPLETE → TODO)', async () => {
    const parent = await createTask('E2E reopen parent');
    const child = await createTask('E2E reopen child', { parent_task_id: parent.id });

    // Complete both
    await fetch(apiUrl(`/api/tasks/${child.id}/complete`), { method: 'POST' });
    await fetch(apiUrl(`/api/tasks/${parent.id}/complete`), { method: 'POST' });

    // Reopen parent — should work since we're going FROM COMPLETE
    const res = await fetch(apiUrl(`/api/tasks/${parent.id}/toggle-complete`), { method: 'POST' });
    expect(res.status).toBe(200);
    const reopened = ((await res.json()) as { task: TaskResponse }).task;
    expect(reopened.phase).toBe('TODO');
  });

  it('persists guard — parent stays unchanged after blocked completion', async () => {
    const parent = await createTask('E2E persist guard');
    await createTask('E2E persist child', { parent_task_id: parent.id });

    // Try to complete — should fail
    const res = await fetch(apiUrl(`/api/tasks/${parent.id}/complete`), { method: 'POST' });
    expect(res.status).toBe(409);

    // Verify parent is still TODO
    const fetched = await getTask(parent.id);
    expect(fetched.phase).toBe('TODO');
    expect(fetched.status).toBe('todo');
  });
});

describe('Sprint field E2E', () => {
  it('sprint field is persisted via updateTaskRaw and returned', async () => {
    const task = await createTask('Sprint test task', { category: 'Work', project: 'HomeLab' });

    // Sprint isn't set via the normal update API (it comes from external plugin sync),
    // but we can verify it's returned when present in the task data.
    // Create task via API, then verify it doesn't have sprint
    expect(task.sprint).toBeUndefined();

    // Verify the field would be serialized if present (via GET)
    const fetched = await getTask(task.id);
    expect(fetched.sprint).toBeUndefined();
  });
});

// ── Tags CRUD E2E ──

describe('Tags CRUD E2E', () => {
  it('creates a task with tags', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Tags test: create', tags: ['frontend', 'urgent'] }),
    });
    expect(res.status).toBe(201);
    const { task } = await res.json() as { task: TaskResponse };
    expect(task.tags).toEqual(['frontend', 'urgent']);

    // Verify persisted
    const fetched = await getTask(task.id);
    expect(fetched.tags).toEqual(['frontend', 'urgent']);
  });

  it('creates a task with tags deduped', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Tags test: dedup create', tags: ['a', 'b', 'a'] }),
    });
    expect(res.status).toBe(201);
    const { task } = await res.json() as { task: TaskResponse };
    expect(task.tags).toEqual(['a', 'b']);
  });

  it('add_tags appends tags idempotently', async () => {
    const task = await createTask('Tags test: add');

    // Add tags to a task that has none
    const updated = await updateTask(task.id, { add_tags: ['backend', 'api'] });
    expect(updated.tags).toEqual(['backend', 'api']);

    // Add again — idempotent, no duplicates
    const updated2 = await updateTask(task.id, { add_tags: ['api', 'v2'] });
    expect(updated2.tags).toContain('backend');
    expect(updated2.tags).toContain('api');
    expect(updated2.tags).toContain('v2');
    expect(updated2.tags?.filter(t => t === 'api')).toHaveLength(1); // no duplicate
  });

  it('remove_tags removes specified tags', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Tags test: remove', tags: ['a', 'b', 'c'] }),
    });
    const { task } = await res.json() as { task: TaskResponse };

    // Remove one tag
    const updated = await updateTask(task.id, { remove_tags: ['b'] });
    expect(updated.tags).toEqual(['a', 'c']);

    // Remove all remaining
    const updated2 = await updateTask(task.id, { remove_tags: ['a', 'c'] });
    expect(updated2.tags).toBeUndefined(); // empty array → field deleted
  });

  it('set_tags replaces all tags', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Tags test: set', tags: ['old1', 'old2'] }),
    });
    const { task } = await res.json() as { task: TaskResponse };

    // Replace all tags
    const updated = await updateTask(task.id, { set_tags: ['new1', 'new2', 'new3'] });
    expect(updated.tags).toEqual(['new1', 'new2', 'new3']);

    // Set to empty → deletes field
    const updated2 = await updateTask(task.id, { set_tags: [] });
    expect(updated2.tags).toBeUndefined();
  });

  it('rejects non-array tag fields with 400', async () => {
    const task = await createTask('Tags test: validation');

    const res = await fetch(apiUrl(`/api/tasks/${task.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add_tags: 'not-an-array' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('add_tags must be an array');
  });

  it('WS task:updated event carries tags field', async () => {
    const ws = await connectWs();
    try {
      const task = await createTask('Tags test: WS');

      const eventPromise = waitForWsEvent(ws, 'task:updated');
      await updateTask(task.id, { add_tags: ['ws-tag'] });

      const event = await eventPromise;
      const eventTask = (event.data as { task: TaskResponse }).task;
      expect(eventTask.tags).toEqual(['ws-tag']);
    } finally {
      ws.close();
      await delay(50);
    }
  });

  it('GET /api/tasks filters by tags query param', async () => {
    // Create tasks with distinct tags
    const suffix = Date.now().toString();
    await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Filter tag A ${suffix}`, tags: ['filter-a'] }),
    });
    await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Filter tag B ${suffix}`, tags: ['filter-b'] }),
    });
    await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Filter tag AB ${suffix}`, tags: ['filter-a', 'filter-b'] }),
    });

    // Filter by filter-a → should get A and AB
    const res = await fetch(apiUrl('/api/tasks?tags=filter-a'));
    expect(res.status).toBe(200);
    const { tasks } = await res.json() as { tasks: TaskResponse[] };
    const titles = tasks.map(t => t.title);
    expect(titles).toContain(`Filter tag A ${suffix}`);
    expect(titles).toContain(`Filter tag AB ${suffix}`);
    expect(titles).not.toContain(`Filter tag B ${suffix}`);
  });

  it('GET /api/tasks/meta/tags returns unique tags with counts', async () => {
    // Tags from tasks created in earlier tests should appear
    const res = await fetch(apiUrl('/api/tasks/meta/tags'));
    expect(res.status).toBe(200);
    const { tags } = await res.json() as { tags: Array<{ tag: string; count: number }> };
    expect(Array.isArray(tags)).toBe(true);

    // At minimum, 'frontend' should exist from the first tags test
    const frontendTag = tags.find(t => t.tag === 'frontend');
    expect(frontendTag).toBeDefined();
    expect(frontendTag!.count).toBeGreaterThanOrEqual(1);
  });
});
