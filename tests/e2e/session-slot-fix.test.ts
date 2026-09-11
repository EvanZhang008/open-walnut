/**
 * E2E tests for the 1-task-1-session slot rule:
 *   1. A terminal (stopped / error) session does NOT block a new start
 *   2. A live session DOES block it, with the live session's id in the body
 *   3. checkSessionLimit skips error and embedded/sdk sessions
 *
 * Tests 1-2 go through POST /api/v1/tasks/:id/start (the route behind the
 * session_start op) on a real server; test 3 calls session-tracker directly.
 *
 * They deliberately post a RELATIVE cwd, which the route refuses with 400 —
 * AFTER the slot check. So 409 means "the slot was taken" and 400 means "the
 * slot was free", and no session is ever spawned: a spawned session would still
 * be settling its process_status while test 3 counts running sessions, which
 * made that count flap by one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import {
  createSessionRecord,
  updateSessionRecord,
  checkSessionLimit,
} from '../../src/core/session-tracker.js';

// ── Helpers ──

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

/** Ask the start route for a session, with a cwd it will refuse (see header). */
async function startSession(taskId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(apiUrl(`/api/v1/tasks/${taskId}/start`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Continue working', cwd: 'not/absolute' }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function createTask(title: string, opts: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, ...opts }),
  });
  expect(res.status).toBe(201);
  const body = await res.json() as { task: Record<string, unknown> };
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
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

// ══════════════════════════════════════════════════════════════════
// Tests 1-2: which sessions occupy the task's slot
// ══════════════════════════════════════════════════════════════════

describe('POST /tasks/:id/start — the slot rule', () => {
  it('a stopped session does not occupy the slot', async () => {
    const task = await createTask('Stopped session slot test', { category: 'Test' });
    const taskId = task.id as string;

    const stopped = await createSessionRecord('stopped-sess-001', taskId, 'Test', '/tmp', { pid: 99990 });
    await updateSessionRecord(stopped.claudeSessionId, { process_status: 'stopped' });
    const { linkSessionSlot } = await import('../../src/core/task-manager.js');
    await linkSessionSlot(taskId, 'stopped-sess-001', 'exec');

    const { status, body } = await startSession(taskId);
    // Past the slot check, refused only on the deliberately relative cwd.
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain('absolute');
  });

  it('an error session does not occupy the slot', async () => {
    const task = await createTask('Error session slot test', { category: 'Test' });
    const taskId = task.id as string;

    const errored = await createSessionRecord('error-sess-001', taskId, 'Test', '/tmp', { pid: 99991 });
    await updateSessionRecord(errored.claudeSessionId, { process_status: 'error' });
    const { linkSessionSlot } = await import('../../src/core/task-manager.js');
    await linkSessionSlot(taskId, 'error-sess-001', 'exec');

    const { status, body } = await startSession(taskId);
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain('absolute');
  });

  it('a running session occupies the slot and its id comes back in the 409', async () => {
    const task = await createTask('Running session slot test', { category: 'Test' });
    const taskId = task.id as string;

    await createSessionRecord('running-sess-001', taskId, 'Test', '/tmp', { pid: 99993 });
    const { linkSessionSlot } = await import('../../src/core/task-manager.js');
    await linkSessionSlot(taskId, 'running-sess-001', 'exec');

    const { status, body } = await startSession(taskId);
    expect(status).toBe(409);
    // The caller needs the live id to be able to send into it instead.
    expect(JSON.stringify(body)).toContain('running-sess-001');
  });
});

// ══════════════════════════════════════════════════════════════════
// Test 4: checkSessionLimit skips error and embedded/sdk sessions
// ══════════════════════════════════════════════════════════════════

describe('checkSessionLimit skips error and embedded/sdk sessions', () => {
  it('does not count error, embedded, or sdk sessions toward the limit', async () => {
    // Take a baseline of running sessions (prior tests may have left sessions in the store)
    const baseline = await checkSessionLimit(undefined, { local: 100 });
    const baselineRunning = baseline.running;

    // Create sessions of various types that should NOT count toward the limit:

    // 1. Error session (has PID but process_status = error)
    await createSessionRecord('limit-error-001', 'limit-task-1', 'proj', '/tmp', { pid: 88001 });
    await updateSessionRecord('limit-error-001', { process_status: 'error' });

    // 2. Embedded session (running but provider = embedded)
    await createSessionRecord('limit-embedded-001', 'limit-task-2', 'proj', '/tmp', {
      pid: 88002,
      provider: 'embedded',
      type: 'subagent',
    });

    // 3. SDK session (running but provider = sdk)
    await createSessionRecord('limit-sdk-001', 'limit-task-3', 'proj', '/tmp', {
      pid: 88003,
      provider: 'sdk',
    });

    // Check session limit — none of the 3 new sessions should count toward the limit
    const result = await checkSessionLimit(undefined, { local: 100 });

    // Running count should be unchanged from baseline (error/embedded/sdk are all skipped)
    expect(result.running).toBe(baselineRunning);
    expect(result.allowed).toBe(true);
  });
});
