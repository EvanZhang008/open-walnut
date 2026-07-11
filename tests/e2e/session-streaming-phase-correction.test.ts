/**
 * E2E: a streaming session corrects a stale AWAIT_HUMAN_ACTION.
 *
 * Bug 3 (2026-06-14 investigation): a transient/late session:error flipped a
 * task to AWAIT_HUMAN_ACTION while the session had actually recovered (remote
 * CLI exited cleanly at a turn boundary → --resume recovered it). The task
 * then showed "awaiting human" while the session was visibly streaming.
 *
 * Fix: when server.ts receives session:status-changed{process_status:running}
 * for a task stuck in AWAIT_HUMAN_ACTION, it applies the 'session:streaming'
 * phase trigger which corrects it back to IN_PROGRESS — but ONLY for
 * AWAIT_HUMAN_ACTION (terminal / other phases untouched).
 *
 * This drives the REAL server bus handler (not the phase pure-function) by
 * emitting on the shared bus singleton and asserting via REST.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;

const apiUrl = (p: string) => `http://localhost:${port}${p}`;

async function createTask(title: string): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(201);
  return (await res.json() as { task: Record<string, unknown> }).task;
}

async function patchTask(id: string, fields: Record<string, unknown>): Promise<void> {
  const res = await fetch(apiUrl(`/api/tasks/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  expect(res.status).toBe(200);
}

async function fetchTask(id: string): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl(`/api/tasks/${id}`));
  expect(res.status).toBe(200);
  return (await res.json() as { task: Record<string, unknown> }).task;
}

/** Emit a running status-changed exactly like claude-code-session.emitStatusChanged. */
async function emitRunning(sessionId: string, taskId: string): Promise<void> {
  const { bus, EventNames } = await import('../../src/core/event-bus.js');
  bus.emit(EventNames.SESSION_STATUS_CHANGED, {
    sessionId, taskId, process_status: 'running', phase: 'IN_PROGRESS',
  }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' });
  // Handler does the phase correction in a fire-and-forget async IIFE.
  await new Promise((r) => setTimeout(r, 150));
}

/** Emit a text-delta exactly like claude-code-session does for streaming text.
 *  Critically: NO accompanying status-changed{running} — a pure-text turn never
 *  emits emitStatusChanged('IN_PROGRESS'), which is why the discrete-status fix
 *  alone missed this path. */
async function emitTextDelta(sessionId: string, taskId: string): Promise<void> {
  const { bus, EventNames } = await import('../../src/core/event-bus.js');
  bus.emit(EventNames.SESSION_TEXT_DELTA, {
    sessionId, taskId, delta: 'hello',
  }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' });
  await new Promise((r) => setTimeout(r, 150));
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

describe('streaming session corrects stale AWAIT_HUMAN_ACTION', () => {
  it('AWAIT_HUMAN_ACTION → IN_PROGRESS when the session streams again', async () => {
    const task = await createTask('streaming-corrects-await');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'AWAIT_HUMAN_ACTION' });
    expect((await fetchTask(taskId)).phase).toBe('AWAIT_HUMAN_ACTION');

    await emitRunning('sess-await-1', taskId);

    const fetched = await fetchTask(taskId);
    expect(fetched.phase).toBe('IN_PROGRESS');
    expect(fetched.status).toBe('in_progress');
  });

  it('does NOT disturb a COMPLETE task (terminal phase stays put)', async () => {
    const task = await createTask('streaming-leaves-complete');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'COMPLETE' });

    await emitRunning('sess-complete-1', taskId);

    expect((await fetchTask(taskId)).phase).toBe('COMPLETE');
  });

  it('does NOT disturb an AGENT_COMPLETE task (only await is corrected)', async () => {
    const task = await createTask('streaming-leaves-agent-complete');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'AGENT_COMPLETE' });

    await emitRunning('sess-ac-1', taskId);

    expect((await fetchTask(taskId)).phase).toBe('AGENT_COMPLETE');
  });
});

// The decisive regression coverage: a PURE-TEXT streaming turn (text-delta with
// NO status-changed{running}) must still correct a stale AWAIT_HUMAN_ACTION.
// This is exactly the path the discrete status-changed fix missed — the agent
// visibly streams text while the task stays stuck "awaiting human".
describe('text-delta alone corrects stale AWAIT_HUMAN_ACTION', () => {
  it('AWAIT_HUMAN_ACTION → IN_PROGRESS on text-delta (no status-changed)', async () => {
    const task = await createTask('text-delta-corrects-await');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'AWAIT_HUMAN_ACTION' });
    expect((await fetchTask(taskId)).phase).toBe('AWAIT_HUMAN_ACTION');

    await emitTextDelta('sess-delta-1', taskId);

    const fetched = await fetchTask(taskId);
    expect(fetched.phase).toBe('IN_PROGRESS');
    expect(fetched.status).toBe('in_progress');
  });

  it('does NOT disturb a COMPLETE task on text-delta (terminal stays put)', async () => {
    const task = await createTask('text-delta-leaves-complete');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'COMPLETE' });

    await emitTextDelta('sess-delta-2', taskId);

    expect((await fetchTask(taskId)).phase).toBe('COMPLETE');
  });

  it('does NOT disturb an AGENT_COMPLETE task on text-delta', async () => {
    const task = await createTask('text-delta-leaves-agent-complete');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'AGENT_COMPLETE' });

    await emitTextDelta('sess-delta-3', taskId);

    expect((await fetchTask(taskId)).phase).toBe('AGENT_COMPLETE');
  });
});

// Fix C2 (incident 10e7df54): a REPLAYED delta must never raise the phase.
// After a server restart the fresh session object has an empty stream-dedup set,
// so a daemon-replayed text-delta passes upstream dedup and reaches
// enforceStreamingPhase looking like live output. The tell is the persisted
// session record: live output always rides a record flipped 'running' at send
// time, so a non-running record means replay noise — the guard must skip the
// raise. The tests above cover sessions with NO record (record==null passes
// through); these cover the record-present branches on both sides of the guard.
describe('replayed delta (record not running) must not raise AWAIT_HUMAN_ACTION', () => {
  async function seedSessionRecord(
    sessionId: string, taskId: string, processStatus: 'idle' | 'running',
  ): Promise<void> {
    const { createSessionRecord, updateSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord(sessionId, taskId, 'Walnut'); // created as 'running'
    if (processStatus !== 'running') {
      await updateSessionRecord(sessionId, { process_status: processStatus });
    }
  }

  it('record idle (replay): AWAIT_HUMAN_ACTION stays put on text-delta', async () => {
    const task = await createTask('replay-delta-leaves-await');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'AWAIT_HUMAN_ACTION' });
    await seedSessionRecord('sess-replay-idle-1', taskId, 'idle');

    await emitTextDelta('sess-replay-idle-1', taskId);

    // REVERT CHECK: without the guard, the delta raises AWAIT → IN_PROGRESS here.
    expect((await fetchTask(taskId)).phase).toBe('AWAIT_HUMAN_ACTION');
  });

  it('record running (live): AWAIT_HUMAN_ACTION → IN_PROGRESS still works', async () => {
    const task = await createTask('live-delta-corrects-await');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'AWAIT_HUMAN_ACTION' });
    await seedSessionRecord('sess-live-running-1', taskId, 'running');

    await emitTextDelta('sess-live-running-1', taskId);

    const fetched = await fetchTask(taskId);
    expect(fetched.phase).toBe('IN_PROGRESS');
    expect(fetched.status).toBe('in_progress');
  });
});
