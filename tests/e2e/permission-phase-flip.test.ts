/**
 * E2E: a permission request / AskUserQuestion flips the TASK phase, not just the
 * session badge (2026-08-18 user call: "只要是 agent 完事要等,都是把它变成
 * Agent Complete" — permission, AskUserQuestion, plan approval, error alike).
 *
 * Wiring under test is the server.ts bus subscriber (real server, real bus,
 * real task store):
 *   session:permission-request  → applySessionPhase('session:awaiting-human')
 *                                 → task AGENT_COMPLETE + unread (red row NOW)
 *   session:permission-resolved (allowed/denied) → 'session:human-answered'
 *                                 → task IN_PROGRESS + read (agent resumes)
 *   session:permission-resolved (expired) → NO pullback (nobody decided; the
 *                                 handed-back AGENT_COMPLETE stands)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';

let server: HttpServer;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll the task until pred holds or timeout — the bus subscriber is async. */
async function pollTask(taskId: string, pred: (t: { phase: string; unread?: boolean }) => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let task = await getTask(taskId);
  while (!pred(task) && Date.now() < deadline) {
    await delay(50);
    task = await getTask(taskId);
  }
  return task;
}

async function makeTaskWithSession(sid: string): Promise<string> {
  const { task } = await addTask({ title: 'perm-flip', project: 'p' });
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

describe('permission request drives the task phase (awaiting-human)', () => {
  it('request → AGENT_COMPLETE+unread; human answers → IN_PROGRESS+read', async () => {
    const sid = 'sess-perm-flip-1';
    const taskId = await makeTaskWithSession(sid);

    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: sid, taskId, requestId: 'req-flip-1',
      toolName: 'Bash', input: { command: 'rm -rf build' },
    }, ['*']);

    let task = await pollTask(taskId, (t) => t.phase === 'AGENT_COMPLETE');
    expect(task.phase).toBe('AGENT_COMPLETE');
    expect(task.unread).toBe(true);

    bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, {
      sessionId: sid, taskId, requestId: 'req-flip-1', allowed: true,
    }, ['*']);

    task = await pollTask(taskId, (t) => t.phase === 'IN_PROGRESS');
    expect(task.phase).toBe('IN_PROGRESS');
    expect(task.unread).toBe(false);
  });

  it('deny is also a human decision → pullback to IN_PROGRESS', async () => {
    const sid = 'sess-perm-flip-2';
    const taskId = await makeTaskWithSession(sid);

    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: sid, taskId, requestId: 'req-flip-2', toolName: 'Write',
    }, ['*']);
    await pollTask(taskId, (t) => t.phase === 'AGENT_COMPLETE');

    bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, {
      sessionId: sid, taskId, requestId: 'req-flip-2', allowed: false,
    }, ['*']);

    const task = await pollTask(taskId, (t) => t.phase === 'IN_PROGRESS');
    expect(task.phase).toBe('IN_PROGRESS');
  });

  it('EXPIRED resolution (session died, nobody decided) keeps AGENT_COMPLETE', async () => {
    const sid = 'sess-perm-flip-3';
    const taskId = await makeTaskWithSession(sid);

    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: sid, taskId, requestId: 'req-flip-3', toolName: 'Bash',
    }, ['*']);
    await pollTask(taskId, (t) => t.phase === 'AGENT_COMPLETE');

    // The terminal-transition expiry emits allowed:false + expired:true —
    // a boolean-first consumer would mislabel this as a human deny.
    bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, {
      sessionId: sid, taskId, requestId: 'req-flip-3', allowed: false, expired: true,
    }, ['*']);

    await delay(600); // give a wrong pullback time to land
    const task = await getTask(taskId);
    expect(task.phase).toBe('AGENT_COMPLETE');
    expect(task.unread).toBe(true);
  });

  it('cancelled resolution (withdrawn request) also does NOT pull back', async () => {
    const sid = 'sess-perm-flip-4';
    const taskId = await makeTaskWithSession(sid);

    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: sid, taskId, requestId: 'req-flip-4', toolName: 'Bash',
    }, ['*']);
    await pollTask(taskId, (t) => t.phase === 'AGENT_COMPLETE');

    bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, {
      sessionId: sid, taskId, requestId: 'req-flip-4', allowed: false, cancelled: true,
    }, ['*']);

    await delay(600);
    const task = await getTask(taskId);
    expect(task.phase).toBe('AGENT_COMPLETE');
  });

  it('request without taskId in the event resolves the task via the session record', async () => {
    const sid = 'sess-perm-flip-5';
    const taskId = await makeTaskWithSession(sid);

    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: sid, requestId: 'req-flip-5', toolName: 'AskUserQuestion',
    }, ['*']);

    const task = await pollTask(taskId, (t) => t.phase === 'AGENT_COMPLETE');
    expect(task.phase).toBe('AGENT_COMPLETE');
  });
});
