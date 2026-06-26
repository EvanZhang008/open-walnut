/**
 * E2E test for the fork message shaping through a real server:
 *   1. A fork always prepends a FOCUS directive so the child treats the new request
 *      as its primary task (not a continuation of the parent's prior work).
 *   2. Attached images are saved to disk and a "read these files" context is prepended
 *      to the fork message (path-based, same as quick-start).
 *
 * We capture the SESSION_START event the fork route emits (to 'session-runner') with
 * a global bus subscriber, then assert on its `message`. Everything except the model
 * layer is real Walnut code.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-fork-focus'));

// Deterministic, offline model so async title refinement doesn't hit the network.
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(async () => ({
    content: [{ type: 'text', text: 'New Task' }],
    stopReason: 'end_turn',
  })),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { bus, EventNames } from '../../src/core/event-bus.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

// SESSION_START fires synchronously inside the fork request, so we must already be
// subscribed before issuing the fetch. We buffer every SESSION_START message keyed by
// taskId for the whole suite and look it up by the taskId the fork route returns.
const sessionStartMessages = new Map<string, string>();

/** Wait for (or read the already-buffered) SESSION_START message for a task id. */
async function getSessionStartMessage(taskId: string, timeoutMs = 4000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = sessionStartMessages.get(taskId);
    if (m !== undefined) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('SESSION_START not observed in time');
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Buffer every fork's SESSION_START message (emitted synchronously to 'session-runner').
  bus.subscribe('test-capture-fork', (event) => {
    if (event.name !== EventNames.SESSION_START) return;
    const data = event.data as { taskId?: string; message?: string };
    if (data.taskId) sessionStartMessages.set(data.taskId, data.message ?? '');
  }, { global: true, interest: [EventNames.SESSION_START] });
});

afterAll(async () => {
  try { bus.unsubscribe('test-capture-fork'); } catch { /* ignore */ }
  await stopServer();
  // The fork triggers async session spawn attempts that keep writing into WALNUT_HOME
  // briefly after the tests finish — give them a beat, then retry the rm so the
  // teardown doesn't flake with ENOTEMPTY.
  await new Promise((r) => setTimeout(r, 200));
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('fork focus prompt + image attachment', () => {
  it('prepends the focus directive and wraps the user request', async () => {
    const parent = await addTask({ title: 'Webhook Sender', category: 'Inbox' });
    const sid = 'fork-focus-src-1';
    await createSessionRecord(sid, parent.task.id, 'proj', '/tmp/fork-focus-cwd');

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create_child_task: true, message: 'Add retry backoff' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    const message = await getSessionStartMessage(body.taskId);
    expect(message).toContain('This is a forked session');
    expect(message).toContain('Do not resume or continue the parent');
    // The user's request is included verbatim under a "New request:" header.
    expect(message).toContain('New request:');
    expect(message).toContain('Add retry backoff');
  });

  it('still injects the focus directive even with no custom message', async () => {
    const parent = await addTask({ title: 'Plain Parent', category: 'Inbox' });
    const sid = 'fork-focus-src-2';
    await createSessionRecord(sid, parent.task.id, 'proj', '/tmp/fork-focus-cwd-2');

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create_child_task: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    const message = await getSessionStartMessage(body.taskId);
    expect(message).toContain('This is a forked session');
    // Falls back to the default "Continue working on" request text. The fork task is
    // titled `Fork of <parent>`, so the default references that.
    expect(message).toContain('Continue working on: Fork of Plain Parent');
  });

  it('saves an attached image and prepends a read-these-files context', async () => {
    const parent = await addTask({ title: 'Visual Task', category: 'Inbox' });
    const sid = 'fork-focus-src-3';
    await createSessionRecord(sid, parent.task.id, 'proj', '/tmp/fork-focus-cwd-3');

    // 1x1 transparent PNG.
    const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        create_child_task: true,
        message: 'Match this mockup',
        images: [{ data: PNG_1x1, mediaType: 'image/png' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    const message = await getSessionStartMessage(body.taskId);
    // Image context is prepended (buildSessionImageContext), focus directive + request follow.
    expect(message).toContain('attached an image');
    expect(message).toContain('Read this file for visual context');
    expect(message).toContain('This is a forked session');
    expect(message).toContain('Match this mockup');
    // The image-context path points into the images dir and the file actually exists.
    const m = message.match(/(\/[^\s]+\.(?:png|jpg|jpeg|gif|webp))/);
    expect(m).toBeTruthy();
    if (m) {
      const stat = await fs.stat(m[1]);
      expect(stat.isFile()).toBe(true);
    }
  });
});
