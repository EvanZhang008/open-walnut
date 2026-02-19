/**
 * E2E: Agent tool mutations emit WS events to connected browsers.
 *
 * Verifies the previously broken path:
 *   Agent → tool (e.g. create_task) → bus.emit → WS broadcast → client receives
 *
 * This is distinct from the REST path (POST /api/tasks → bus.emit → WS)
 * which always worked. The agent tools call core functions directly and
 * must emit bus events themselves.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { executeTool } from '../../src/agent/tools.js';
import { _resetForTesting } from '../../src/core/task-manager.js';

/** Pre-create a category so strict validation passes for subsequent task creation. */
async function ensureCategory(name: string, source = 'ms-todo') {
  await executeTool('create_task', { type: 'category', name, source });
}

// ── Helpers ──

let server: HttpServer;
let port: number;

interface WsFrame {
  type: string;
  name?: string;
  data?: Record<string, unknown>;
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 3000): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame;
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(frame);
      }
    };
    const timer = setTimeout(() => { ws.off('message', handler); reject(new Error(`Timed out waiting for ${eventName}`)); }, timeoutMs);
    ws.on('message', handler);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractId(toolResult: string): string {
  const match = toolResult.match(/\[([^\]]+)\]/);
  if (!match) throw new Error(`No ID found in: ${toolResult}`);
  return match[1];
}

// ── Setup / Teardown ──

beforeAll(async () => {
  _resetForTesting();
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

describe('Agent tool → WS event E2E', () => {
  it('create_task tool emits task:created to WS clients', async () => {
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:created');

    await ensureCategory('Work');
    await executeTool('create_task', { title: 'Agent-created task', category: 'Work' });

    const frame = await eventPromise;
    expect(frame.name).toBe('task:created');
    expect((frame.data as any).task.title).toBe('Agent-created task');

    ws.close();
    await delay(50);
  });

  it('update_task with phase AGENT_COMPLETE emits task:updated to WS clients', async () => {
    const addResult = await executeTool('create_task', { title: 'Complete via agent' });
    const taskId = extractId(addResult);

    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:updated');

    await executeTool('update_task', { id: taskId, phase: 'AGENT_COMPLETE' });

    const frame = await eventPromise;
    expect(frame.name).toBe('task:updated');
    expect((frame.data as any).task.id).toBe(taskId);
    expect((frame.data as any).task.phase).toBe('AGENT_COMPLETE');
    expect((frame.data as any).task.status).toBe('in_progress');

    ws.close();
    await delay(50);
  });

  it('update_task tool emits task:updated to WS clients', async () => {
    const addResult = await executeTool('create_task', { title: 'Update via agent' });
    const taskId = extractId(addResult);

    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:updated');

    await executeTool('update_task', { id: taskId, title: 'Updated by agent', priority: 'immediate' });

    const frame = await eventPromise;
    expect(frame.name).toBe('task:updated');
    expect((frame.data as any).task.title).toBe('Updated by agent');

    ws.close();
    await delay(50);
  });

  it('update_task with append_note emits task:updated to WS clients', async () => {
    const addResult = await executeTool('create_task', { title: 'Note via agent' });
    const taskId = extractId(addResult);

    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:updated');

    await executeTool('update_task', { id: taskId, append_note: 'Agent added this note' });

    const frame = await eventPromise;
    expect(frame.name).toBe('task:updated');
    expect((frame.data as any).task.id).toBe(taskId);

    ws.close();
    await delay(50);
  });

  it('rename_category tool emits task:updated to WS clients', async () => {
    await ensureCategory('OldCat');
    await executeTool('create_task', { title: 'Rename test task', category: 'OldCat' });

    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:updated');

    await executeTool('rename_category', { old_category: 'OldCat', new_category: 'NewCat' });

    const frame = await eventPromise;
    expect(frame.name).toBe('task:updated');
    expect((frame.data as any).oldCategory).toBe('OldCat');
    expect((frame.data as any).newCategory).toBe('NewCat');
    expect((frame.data as any).count).toBe(1);

    ws.close();
    await delay(50);
  });

  it('rename_category event has no task field (bulk operation)', async () => {
    await ensureCategory('BulkOld');
    await executeTool('create_task', { title: 'Bulk test', category: 'BulkOld' });

    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:updated');

    await executeTool('rename_category', { old_category: 'BulkOld', new_category: 'BulkNew' });

    const frame = await eventPromise;
    // The rename payload does NOT contain a `task` field — the frontend
    // must handle this gracefully (refetch instead of crashing).
    expect((frame.data as any).task).toBeUndefined();
    expect((frame.data as any).oldCategory).toBe('BulkOld');

    ws.close();
    await delay(50);
  });

  it('agent tool events reach multiple WS clients simultaneously', async () => {
    const ws1 = await connectWs();
    const ws2 = await connectWs();

    const event1 = waitForWsEvent(ws1, 'task:created');
    const event2 = waitForWsEvent(ws2, 'task:created');

    await executeTool('create_task', { title: 'Multi-client agent test' });

    const [frame1, frame2] = await Promise.all([event1, event2]);
    expect(frame1.name).toBe('task:created');
    expect(frame2.name).toBe('task:created');
    expect((frame1.data as any).task.title).toBe('Multi-client agent test');
    expect((frame2.data as any).task.title).toBe('Multi-client agent test');

    ws1.close();
    ws2.close();
    await delay(50);
  });

  it('agent-created task is persisted and visible via REST', async () => {
    await ensureCategory('TestCat');
    const addResult = await executeTool('create_task', { title: 'Persist check', category: 'TestCat', priority: 'immediate' });
    const taskId = extractId(addResult);

    const res = await fetch(`http://localhost:${port}/api/tasks/${taskId}`);
    expect(res.status).toBe(200);
    const { task } = await res.json() as { task: { id: string; title: string; priority: string } };
    expect(task.id).toBe(taskId);
    expect(task.title).toBe('Persist check');
    expect(task.priority).toBe('immediate');
  });
});
