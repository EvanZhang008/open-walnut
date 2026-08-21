/**
 * E2E: the session:streaming phase trigger is RETIRED — streaming never moves
 * the task phase. (WAIT removed 2026-08-18.)
 *
 * WHAT THIS FILE USED TO PIN (Bug 3, 2026-06-14 investigation): a transient/late
 * session:error flipped a task to WAIT while the session had actually recovered
 * (remote CLI exited cleanly at a turn boundary → --resume recovered it). The
 * task then showed "awaiting human" while the session was visibly streaming, so
 * server.ts applied a 'session:streaming' trigger on status-changed{running} and
 * on text-delta to pull WAIT back to IN_PROGRESS.
 *
 * WHY THE PREMISE IS GONE: WAIT was removed on 2026-08-18 (a blocked/parked task
 * is just TODO). session:error now lands on AGENT_COMPLETE, and a newly-running
 * turn is already pulled back to IN_PROGRESS by session:turn-start — the CLI's own
 * turn-start signal, which is authoritative where a delta was only circumstantial.
 * sessionStreamingPhase() is therefore an unconditional no-op, kept parseable so a
 * replayed event from an old server doesn't crash.
 *
 * SO THE FILE NOW PINS THE RETIREMENT: both streaming signals still reach the
 * server bus handlers (the emit sites and enforceStreamingPhase are untouched, and
 * enforceStreamingPhase still owns the 'error' record self-heal of incident
 * 10e7df54), but NO phase write comes out the other side, for ANY phase. If
 * someone re-points session:streaming at a real phase, these fail.
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
 *  emits emitStatusChanged('IN_PROGRESS'), which is why the old discrete-status fix
 *  needed this second path at all. */
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

describe('status-changed{running}: session:streaming writes no phase', () => {
  // AGENT_COMPLETE is the interesting one: it is where session:error lands now,
  // i.e. exactly the "stale red row while the session streams" shape the old
  // trigger was built for. Proving it stays put proves the retirement — the
  // pullback is session:turn-start's job (a real CLI turn-start signal), not a delta's.
  it('leaves AGENT_COMPLETE alone (the old error-repaint shape)', async () => {
    const task = await createTask('streaming-leaves-agent-complete');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'AGENT_COMPLETE' });

    await emitRunning('sess-ac-1', taskId);

    expect((await fetchTask(taskId)).phase).toBe('AGENT_COMPLETE');
  });

  it('leaves TODO alone (where retired WAIT rows migrated to)', async () => {
    const task = await createTask('streaming-leaves-todo');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'TODO' });

    await emitRunning('sess-todo-1', taskId);

    expect((await fetchTask(taskId)).phase).toBe('TODO');
  });

  it('does NOT disturb a COMPLETE task (terminal phase stays put)', async () => {
    const task = await createTask('streaming-leaves-complete');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'COMPLETE' });

    await emitRunning('sess-complete-1', taskId);

    expect((await fetchTask(taskId)).phase).toBe('COMPLETE');
  });
});

// The path the old discrete-status fix missed: a PURE-TEXT streaming turn
// (text-delta with NO status-changed{running}). It still reaches
// enforceStreamingPhase — that function keeps its replay guard and its 'error'
// record self-heal — but the phase trigger it ends on is now a no-op.
describe('text-delta alone: session:streaming writes no phase', () => {
  it('leaves AGENT_COMPLETE alone on text-delta', async () => {
    const task = await createTask('text-delta-leaves-agent-complete');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'AGENT_COMPLETE' });

    await emitTextDelta('sess-delta-3', taskId);

    expect((await fetchTask(taskId)).phase).toBe('AGENT_COMPLETE');
  });

  it('leaves TODO alone on text-delta', async () => {
    const task = await createTask('text-delta-leaves-todo');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'TODO' });

    await emitTextDelta('sess-delta-4', taskId);

    expect((await fetchTask(taskId)).phase).toBe('TODO');
  });

  it('does NOT disturb a COMPLETE task on text-delta (terminal stays put)', async () => {
    const task = await createTask('text-delta-leaves-complete');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'COMPLETE' });

    await emitTextDelta('sess-delta-2', taskId);

    expect((await fetchTask(taskId)).phase).toBe('COMPLETE');
  });
});

// Fix C2 (incident 10e7df54): a REPLAYED delta must never raise the phase.
// After a server restart the fresh session object has an empty stream-dedup set,
// so a daemon-replayed text-delta passes upstream dedup and reaches
// enforceStreamingPhase looking like live output. The tell is the persisted
// session record: live output always rides a record flipped 'running' at send
// time, so a non-running record means replay noise.
//
// Since the trigger's retirement (2026-08-18) NEITHER branch can write a phase,
// which is a strictly stronger guarantee than the guard gave. Both sides of the
// guard are still exercised here so a future re-wiring of session:streaming can't
// silently reintroduce the raise on either path.
describe('replayed vs live delta: neither raises the phase any more', () => {
  async function seedSessionRecord(
    sessionId: string, taskId: string, processStatus: 'idle' | 'running',
  ): Promise<void> {
    const { createSessionRecord, updateSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord(sessionId, taskId, 'Walnut'); // created as 'running'
    if (processStatus !== 'running') {
      await updateSessionRecord(sessionId, { process_status: processStatus });
    }
  }

  it('record idle (replay): phase stays put on text-delta', async () => {
    const task = await createTask('replay-delta-leaves-phase');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'AGENT_COMPLETE' });
    await seedSessionRecord('sess-replay-idle-1', taskId, 'idle');

    await emitTextDelta('sess-replay-idle-1', taskId);

    expect((await fetchTask(taskId)).phase).toBe('AGENT_COMPLETE');
  });

  it('record running (live): phase ALSO stays put (the retirement)', async () => {
    // REVERT CHECK: before 2026-08-18 this branch was the one that DID raise —
    // the assertion below is what flips if session:streaming is re-armed.
    const task = await createTask('live-delta-leaves-phase');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'AGENT_COMPLETE' });
    await seedSessionRecord('sess-live-running-1', taskId, 'running');

    await emitTextDelta('sess-live-running-1', taskId);

    expect((await fetchTask(taskId)).phase).toBe('AGENT_COMPLETE');
  });
});
