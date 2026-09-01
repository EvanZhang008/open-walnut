/**
 * E2E test for async fork-title refinement through a real server.
 *
 * Forking a session with a custom message should:
 *   - return immediately with the child task created (placeholder `Fork of <parent>`),
 *   - then asynchronously refine the child task title to `<label> - fork of <parent>`
 *     using the (mocked) model summary of the fork message.
 *
 * We mock the model layer so summarizeForkPrompt is deterministic and offline.
 * Everything else (fork route, addTask, updateTask, event bus) is real Walnut code.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-fork-title'));

// Deterministic, offline model: returns a fixed label for the fork prompt.
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(async () => ({
    content: [{ type: 'text', text: 'Add Retry Backoff' }],
    stopReason: 'end_turn',
  })),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';

let server: HttpServer;
let port: number;
const SRC_SID = 'fork-src-session';

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

async function getTaskById(id: string) {
  const res = await fetch(apiUrl(`/api/tasks/${id}`));
  const { task } = await res.json() as {
    task: { id: string; title: string; group_id?: string; walnut_agent?: boolean };
  };
  return task;
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

describe('fork title async refinement', () => {
  it('creates the child task then refines its title from the fork message', async () => {
    // Parent task + a source session record pointing at it (with a cwd).
    const parent = await addTask({ title: 'Webhook Sender', category: 'Inbox' });
    await createSessionRecord(SRC_SID, parent.task.id, 'proj', '/tmp/fork-cwd');

    const res = await fetch(apiUrl(`/api/sessions/${SRC_SID}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        create_child_task: true,
        message: 'Please add exponential retry backoff to the webhook sender',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string; childTaskCreated?: boolean };
    expect(body.childTaskCreated).toBe(true);

    // Immediately the placeholder title is present (no blocking on the LLM).
    const initial = await getTaskById(body.taskId);
    expect(initial.title).toBe('Fork of Webhook Sender');

    // The async refine updates the title to `<label> - fork of <parent>`.
    let refined = initial.title;
    for (let i = 0; i < 40 && refined === 'Fork of Webhook Sender'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      refined = (await getTaskById(body.taskId)).title;
    }
    expect(refined).toBe('Add Retry Backoff - fork of Webhook Sender');
  });

  it('keeps the placeholder title when forking without a custom message', async () => {
    const parent = await addTask({ title: 'Plain Parent', category: 'Inbox' });
    const sid2 = 'fork-src-session-2';
    await createSessionRecord(sid2, parent.task.id, 'proj', '/tmp/fork-cwd-2');

    const res = await fetch(apiUrl(`/api/sessions/${sid2}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create_child_task: true }), // no message
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    // Give any (unexpected) async refine a chance to run, then assert unchanged.
    await new Promise((r) => setTimeout(r, 300));
    const task = await getTaskById(body.taskId);
    expect(task.title).toBe('Fork of Plain Parent');
  });

  it('groups an ordinary fork with its source task', async () => {
    const parent = await addTask({ title: 'Grouped Parent', category: 'Inbox' });
    const sid = 'fork-src-session-3';
    await createSessionRecord(sid, parent.task.id, 'proj', '/tmp/fork-cwd-3');

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create_child_task: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    const fork = await getTaskById(body.taskId);
    const source = await getTaskById(parent.task.id);
    expect(fork.group_id).toBeTruthy();
    expect(source.group_id).toBe(fork.group_id);
  });

  it('keeps an Ask Walnut fork flat (no auto-folder) and inherits walnut_agent', async () => {
    const parent = await addTask({
      title: 'Ask Walnut', project: 'Ask Walnut', walnut_agent: true,
    });
    const sid = 'fork-src-session-walnut';
    await createSessionRecord(sid, parent.task.id, 'Ask Walnut', '/tmp/fork-cwd-w');

    const res = await fetch(apiUrl(`/api/sessions/${sid}/fork`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create_child_task: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string };

    const fork = await getTaskById(body.taskId);
    const source = await getTaskById(parent.task.id);
    // The Ask Walnut project IS the grouping — no "<title> Variants" folder.
    expect(fork.group_id).toBeUndefined();
    expect(source.group_id).toBeUndefined();
    // A fork of a Walnut conversation is still a Walnut conversation.
    expect(fork.walnut_agent).toBe(true);
  });
});
