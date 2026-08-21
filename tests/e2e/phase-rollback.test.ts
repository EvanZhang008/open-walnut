/**
 * E2E tests for automatic phase rollback when sessions resume.
 *
 * When send_to_session is called and the task is in a post-completion phase
 * (AGENT_COMPLETE — WAIT was the other one until its removal 2026-08-18), the
 * phase should auto-rollback to IN_PROGRESS. COMPLETE and pre-completion phases
 * are unaffected.
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

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
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

async function patchTask(id: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl(`/api/tasks/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { task: Record<string, unknown> };
  return body.task;
}

async function fetchTask(id: string): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl(`/api/tasks/${id}`));
  expect(res.status).toBe(200);
  const body = await res.json() as { task: Record<string, unknown> };
  return body.task;
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

describe('sessionInputPhase (replaces shouldRollbackToInProgress)', () => {
  it('returns IN_PROGRESS for post-completion phases', async () => {
    const { sessionInputPhase } = await import('../../src/core/phase.js');
    // (WAIT removed 2026-08-18 — AGENT_COMPLETE is the only post-completion,
    // non-terminal phase left.)
    expect(sessionInputPhase('AGENT_COMPLETE')).toBe('IN_PROGRESS');
    expect(sessionInputPhase('TODO')).toBe('IN_PROGRESS');
  });

  it('returns null for terminal and already-IN_PROGRESS phases', async () => {
    const { sessionInputPhase } = await import('../../src/core/phase.js');
    expect(sessionInputPhase('COMPLETE')).toBeNull();
    expect(sessionInputPhase('IN_PROGRESS')).toBeNull();
  });
});

describe('Phase rollback on send_to_session', () => {
  it('rolls back AGENT_COMPLETE to IN_PROGRESS when session resumes', async () => {
    // Create task + set phase to AGENT_COMPLETE
    const task = await createTask('Rollback test - AGENT_COMPLETE');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'AGENT_COMPLETE' });

    // Create a session record linked to this task
    const { createSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('rollback-sess-1', taskId, 'test-project');

    // Simulate what send_to_session does: sessionInputPhase determines rollback
    const { getTask, updateTask } = await import('../../src/core/task-manager.js');
    const { sessionInputPhase } = await import('../../src/core/phase.js');

    const loaded = await getTask(taskId);
    expect(loaded).toBeTruthy();
    expect(loaded!.phase).toBe('AGENT_COMPLETE');

    const newPhase = sessionInputPhase(loaded!.phase);
    if (newPhase) {
      await updateTask(taskId, { phase: newPhase });
    }

    // Verify via REST
    const fetched = await fetchTask(taskId);
    expect(fetched.phase).toBe('IN_PROGRESS');
    expect(fetched.status).toBe('in_progress');
  });

  it('does NOT rollback COMPLETE phase', async () => {
    const task = await createTask('Rollback test - COMPLETE');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'COMPLETE' });

    const { createSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('rollback-sess-2', taskId, 'test-project');

    const { getTask } = await import('../../src/core/task-manager.js');
    const { sessionInputPhase } = await import('../../src/core/phase.js');

    const loaded = await getTask(taskId);
    expect(loaded).toBeTruthy();
    expect(sessionInputPhase(loaded!.phase)).toBeNull();

    // Verify phase unchanged via REST
    const fetched = await fetchTask(taskId);
    expect(fetched.phase).toBe('COMPLETE');
  });

  it('does NOT rollback IN_PROGRESS phase', async () => {
    const task = await createTask('Rollback test - IN_PROGRESS');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'IN_PROGRESS' });

    const { createSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('rollback-sess-3', taskId, 'test-project');

    const { getTask } = await import('../../src/core/task-manager.js');
    const { sessionInputPhase } = await import('../../src/core/phase.js');

    const loaded = await getTask(taskId);
    expect(loaded).toBeTruthy();
    expect(sessionInputPhase(loaded!.phase)).toBeNull();

    const fetched = await fetchTask(taskId);
    expect(fetched.phase).toBe('IN_PROGRESS');
  });

  // (WAIT removed 2026-08-18 — this used to pin "rolls back WAIT". TODO is where
  // retired WAIT rows migrated to, and it rolls back the same way: any
  // non-terminal, non-IN_PROGRESS phase is pulled to IN_PROGRESS on send.)
  it('rolls back TODO to IN_PROGRESS (the phase retired WAIT rows became)', async () => {
    const task = await createTask('Rollback test - TODO');
    const taskId = task.id as string;
    await patchTask(taskId, { phase: 'TODO' });

    const { getTask, updateTask } = await import('../../src/core/task-manager.js');
    const { sessionInputPhase } = await import('../../src/core/phase.js');

    const loaded = await getTask(taskId);
    expect(loaded!.phase).toBe('TODO');

    const newPhase = sessionInputPhase(loaded!.phase);
    if (newPhase) {
      await updateTask(taskId, { phase: newPhase });
    }

    const fetched = await fetchTask(taskId);
    expect(fetched.phase).toBe('IN_PROGRESS');
  });
});
