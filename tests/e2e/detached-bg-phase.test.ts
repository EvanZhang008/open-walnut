/**
 * E2E: a turn-over with a live detached (run_in_background) command must NOT
 * flip the task to AGENT_COMPLETE (user decision 2026-08-28,
 * inc-1787893885321: "如果是 Running Background 那当然应该是一个 Running 状态"
 * — the session is still working, so the row is not handed back yet).
 *
 * Wiring under test is the server.ts session:result bus subscriber (real
 * server, real bus, real task store):
 *   session:result {detachedBgActive:true}  → phase flip SKIPPED (IN_PROGRESS stands)
 *   session:result (no flag)                → AGENT_COMPLETE as always
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { sessionResultPhase } from '../../src/core/phase.js';
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { setSnapshotModeForTests, _resetSnapshotGateForTests } from '../../src/core/session-snapshot-gate.js';

let server: HttpServer;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollTask(taskId: string, pred: (t: { phase: string }) => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let task = await getTask(taskId);
  while (!pred(task) && Date.now() < deadline) {
    await delay(50);
    task = await getTask(taskId);
  }
  return task;
}

async function makeTaskWithSession(sid: string): Promise<string> {
  const { task } = await addTask({ title: 'bg-flip', project: 'p' });
  await updateTaskRaw(task.id, { phase: 'IN_PROGRESS' as never, session_id: sid });
  await createSessionRecord(sid, task.id, 'p');
  return task.id;
}

beforeAll(async () => {
  process.env.WALNUT_DISABLE_SEARCH = '1';
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  delete process.env.WALNUT_DISABLE_SEARCH;
});

describe('snapshot-only handback reaches the task API', () => {
  it('recovers a missed result, serves the red phase, and preserves a later human choice', async () => {
    const { applySnapshot } = await import('../../src/core/session-snapshot-apply.js');
    const { foldLine, initialFoldState, assembleSnapshot } = await import('../../src/providers/daemon-fold.js');
    const sid = 'snapshot-only-http';
    const taskId = await makeTaskWithSession(sid);
    await updateTaskRaw(taskId, { updated_at: '2026-01-01T00:00:00Z' });
    let state = initialFoldState();
    let offset = 0;
    for (const event of [
      { type: 'system', subtype: 'session_state_changed', state: 'running' },
      { type: 'result', is_error: false, num_turns: 74 },
      { type: 'system', subtype: 'session_state_changed', state: 'idle' },
    ]) {
      const line = JSON.stringify(event);
      offset += Buffer.byteLength(line) + 1;
      state = foldLine(state, line, offset);
    }
    const snapshot = assembleSnapshot({ foldState: state, pendingCtrl: null, dead: false, pid: 4242, exitCode: null });
    setSnapshotModeForTests('enforce');
    try {
      await applySnapshot(sid, snapshot, 'pull-30s');
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${taskId}`);
      expect(response.ok).toBe(true);
      const { task } = await response.json() as { task: { phase: string; session_status: { process_status: string } } };
      expect(task.phase).toBe(sessionResultPhase('IN_PROGRESS'));
      expect(task.session_status.process_status).toBe('idle');
      await updateTaskRaw(taskId, { phase: 'IN_PROGRESS', updated_at: '2099-01-01T00:00:00Z' });
      await applySnapshot(sid, snapshot, 'pull-30s');
      expect((await getTask(taskId)).phase).toBe('IN_PROGRESS');
    } finally {
      _resetSnapshotGateForTests();
      setSnapshotModeForTests('off');
    }
  });
});

describe('detached background work gates the AGENT_COMPLETE flip', () => {
  it('result with detachedBgActive → task stays IN_PROGRESS', async () => {
    const sid = 'sess-bg-flip-1';
    const taskId = await makeTaskWithSession(sid);

    bus.emit(EventNames.SESSION_RESULT, {
      sessionId: sid, taskId, result: 'launched the bench in background',
      isError: false, detachedBgActive: true,
    }, ['*'], { source: 'session-runner' });

    // Give the async subscriber time to (wrongly) flip, then assert it didn't.
    await delay(1200);
    const task = await getTask(taskId);
    expect(task.phase).toBe('IN_PROGRESS');
  });

  it('result WITHOUT the flag flips AGENT_COMPLETE as always (control)', async () => {
    const sid = 'sess-bg-flip-2';
    const taskId = await makeTaskWithSession(sid);

    bus.emit(EventNames.SESSION_RESULT, {
      sessionId: sid, taskId, result: 'all done', isError: false,
    }, ['*'], { source: 'session-runner' });

    const task = await pollTask(taskId, (t) => t.phase === 'AGENT_COMPLETE');
    expect(task.phase).toBe('AGENT_COMPLETE');
  });

  it('final hand-back still works: a later un-flagged result flips it', async () => {
    const sid = 'sess-bg-flip-3';
    const taskId = await makeTaskWithSession(sid);

    bus.emit(EventNames.SESSION_RESULT, {
      sessionId: sid, taskId, result: 'bench running', isError: false, detachedBgActive: true,
    }, ['*'], { source: 'session-runner' });
    await delay(800);
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS');

    // The drain path (runner followup-closure applies 'session:result' directly;
    // here we exercise the equivalent bus shape a final result would produce).
    bus.emit(EventNames.SESSION_RESULT, {
      sessionId: sid, taskId, result: 'bench finished, scored', isError: false,
    }, ['*'], { source: 'session-runner' });

    const task = await pollTask(taskId, (t) => t.phase === 'AGENT_COMPLETE');
    expect(task.phase).toBe('AGENT_COMPLETE');
  });
});
