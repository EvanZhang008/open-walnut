/**
 * E2E tests for centralized TASK_UPDATED event emission from updateTask().
 *
 * updateTask() in src/core/task-manager.ts auto-emits TASK_UPDATED to ['web-ui']
 * (plus optional extraTargets) on every call.  Previously callers had to emit
 * manually — many forgot, causing stale UI.
 *
 * These tests verify:
 *   1. updateTask() emits task:updated via WebSocket
 *   2. Phase rollback emits task:updated with source tag
 *   3. extraTargets adds destinations to the bus event
 *   4. Exactly one task:updated WS event is emitted per PATCH (no double-emission)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-task-update-ws'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

// ── Types ──

interface WsFrame {
  type: string;
  name?: string;
  data?: unknown;
  [key: string]: unknown;
}

// ── Server state ──

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

// ── WebSocket helpers ──

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/**
 * Collect all WS frames whose type==='event' and name is in eventNames.
 * The array is live — callers can inspect it after triggering actions.
 */
function collectWsEvents(ws: WebSocket, eventNames: string[]): WsFrame[] {
  const events: WsFrame[] = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as WsFrame;
    if (frame.type === 'event' && eventNames.includes(frame.name!)) {
      events.push(frame);
    }
  });
  return events;
}

/**
 * Wait for the next WS event matching eventName (rejects on timeout).
 */
function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 5000): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for WS event "${eventName}"`)),
      timeoutMs,
    );
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame;
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(frame);
      }
    };
    ws.on('message', handler);
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── REST helpers ──

async function createTask(title: string): Promise<{ id: string; phase: string }> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, category: 'test' }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { task: { id: string; phase: string } };
  return body.task;
}

async function patchTask(id: string, fields: Record<string, unknown>): Promise<{ id: string; phase: string }> {
  const res = await fetch(apiUrl(`/api/tasks/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { task: { id: string; phase: string } };
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

describe('updateTask() centralized TASK_UPDATED emission', () => {
  /**
   * Test 1: PATCH /api/tasks/:id triggers a task:updated WS event with the
   *         correct task.phase.  This works because tasks.ts calls
   *         updateTask(..., { source: 'api', extraTargets: ['main-agent'] }),
   *         which emits TASK_UPDATED to ['web-ui', 'main-agent'].  The
   *         'web-ui' subscriber in server.ts broadcasts it to WS clients.
   */
  it('updateTask() emits task:updated via WebSocket on phase change', async () => {
    const ws = await connectWs();
    try {
      const task = await createTask('WS emission test task');

      // Start collecting BEFORE the PATCH so we don't miss the event
      const eventPromise = waitForWsEvent(ws, 'task:updated');

      await patchTask(task.id, { phase: 'IN_PROGRESS' });

      const frame = await eventPromise;

      expect(frame.name).toBe('task:updated');
      const data = frame.data as { task: { id: string; phase: string } };
      expect(data.task.id).toBe(task.id);
      expect(data.task.phase).toBe('IN_PROGRESS');
    } finally {
      ws.close();
      await delay(50);
    }
  });

  /**
   * Test 2: Calling updateTask() directly (not via REST) with
   *         { source: 'phase-rollback' } still emits task:updated to 'web-ui'.
   *         This verifies the centralized emission works for internal callers
   *         (e.g. phase-rollback logic in session handling).
   */
  it('direct updateTask() call with source tag emits task:updated via WebSocket', async () => {
    const task = await createTask('Phase rollback WS test');
    // Set the task to a handed-back phase via REST first, so the rollback below
    // is a real transition. (WAIT removed 2026-08-18 — was 'WAIT'; PATCH would
    // now answer 400 for it, since VALID_PHASES no longer contains it.)
    await patchTask(task.id, { phase: 'AGENT_COMPLETE' });

    const ws = await connectWs();
    try {
      const eventPromise = waitForWsEvent(ws, 'task:updated');

      // Simulate internal phase-rollback: call updateTask() directly
      const { updateTask } = await import('../../src/core/task-manager.js');
      await updateTask(task.id, { phase: 'IN_PROGRESS' }, { source: 'phase-rollback' });

      const frame = await eventPromise;

      expect(frame.name).toBe('task:updated');
      const data = frame.data as { task: { id: string; phase: string } };
      expect(data.task.id).toBe(task.id);
      expect(data.task.phase).toBe('IN_PROGRESS');
    } finally {
      ws.close();
      await delay(50);
    }
  });

  /**
   * Test 3: When PATCH /api/tasks/:id is used, tasks.ts passes
   *         extraTargets: ['main-agent'].  The bus event should therefore be
   *         delivered to BOTH 'web-ui' and 'main-agent'.  We verify by
   *         subscribing a test observer directly on the bus and checking the
   *         event's destinations array.
   */
  it('PATCH via REST includes main-agent in bus event destinations', async () => {
    const task = await createTask('extraTargets test task');

    const { bus } = await import('../../src/core/event-bus.js');

    const capturedDestinations: string[][] = [];
    const subscriberName = `test-observer-${Date.now()}`;
    bus.subscribe(
      subscriberName,
      (event) => {
        if (
          event.name === 'task:updated' &&
          (event.data as { task?: { id: string } })?.task?.id === task.id
        ) {
          capturedDestinations.push([...event.destinations]);
        }
      },
      // global: true — receive ALL events regardless of destinations field
      { global: true },
    );

    try {
      await patchTask(task.id, { phase: 'IN_PROGRESS' });

      // Give the synchronous bus dispatch time to complete (it's sync, so await is enough)
      await delay(50);

      // At least one event should have been captured for this task
      expect(capturedDestinations.length).toBeGreaterThanOrEqual(1);

      // The event emitted by updateTask() must include both 'web-ui' and 'main-agent'
      const found = capturedDestinations.find(
        (d) => d.includes('web-ui') && d.includes('main-agent'),
      );
      expect(
        found,
        `Expected a bus event with destinations containing both 'web-ui' and 'main-agent'. ` +
        `Captured: ${JSON.stringify(capturedDestinations)}`,
      ).toBeDefined();
    } finally {
      bus.unsubscribe(subscriberName);
    }
  });

  /**
   * Test 4: Exactly ONE task:updated WS event is emitted per PATCH.
   *         This guards against double-emission regressions where callers
   *         both relied on the centralized emission AND emitted again manually.
   */
  it('exactly one task:updated WS event is emitted per PATCH (no double-emission)', async () => {
    const task = await createTask('No-double-emission test');

    const ws = await connectWs();
    try {
      const collected = collectWsEvents(ws, ['task:updated']);

      await patchTask(task.id, { phase: 'IN_PROGRESS' });

      // Wait long enough for any delayed/double emissions to arrive
      await delay(300);

      // Filter to events for this specific task
      const forThisTask = collected.filter(
        (f) => (f.data as { task?: { id: string } })?.task?.id === task.id,
      );

      expect(
        forThisTask.length,
        `Expected exactly 1 task:updated event for task ${task.id}, got ${forThisTask.length}`,
      ).toBe(1);
    } finally {
      ws.close();
      await delay(50);
    }
  });
});
