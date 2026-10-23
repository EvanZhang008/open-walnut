/**
 * E2E tests for the side-question ("/btw") web routes through a real server.
 *
 * Spins up Express + WS via startServer({port:0, dev:true}) and exercises:
 *   - POST /api/sessions/:sid/side-question against a stubbed LIVE session
 *     (askSideQuestion is intercepted; the answer is persisted, NOT echoed to
 *     the transcript) — proves the route → askSideQuestion → store → response path.
 *   - GET history reflects the persisted entry.
 *   - POST .../promote creates a task holding the Q&A (never linked to the session).
 *   - DELETE removes the entry.
 *   - 404 when no live session is registered.
 *
 * We register a fake ClaudeCodeSession in the runner so findByClaudeId resolves it.
 * Only the side_question round-trip is stubbed; the rest is real Walnut code.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-btw'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { sessionRunner, ClaudeCodeSession } from '../../src/providers/claude-code-session.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';

let server: HttpServer;
let port: number;
const SID = 'btw-live-session';

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

/** Register a fake live session that answers side questions deterministically. */
function registerFakeSession(answer = 'the retry lives in remote-session-manager.ts') {
  const fake = {
    sessionId: SID,
    askSideQuestion: vi.fn(async (_q: string) => answer),
    // Lifecycle no-ops so the runner's shutdown sweep (detach/kill) doesn't throw.
    detach: () => {},
    kill: () => {},
    get active() { return false; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sessionRunner as any).sessions.set(SID, fake);
  return fake;
}

function unregisterFakeSession() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sessionRunner as any).sessions.delete(SID);
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  unregisterFakeSession();
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  unregisterFakeSession();
});

describe('side-question routes', () => {
  it('404s when no live session is registered', async () => {
    const res = await fetch(apiUrl(`/api/sessions/${SID}/side-question`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s on empty question', async () => {
    registerFakeSession();
    const res = await fetch(apiUrl(`/api/sessions/${SID}/side-question`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('asks, persists, and returns the answer without touching the transcript', async () => {
    const fake = registerFakeSession('answer about hasPipe');
    const res = await fetch(apiUrl(`/api/sessions/${SID}/side-question`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: "what's hasPipe?" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { sideQuestion: { id: string; question: string; answer: string } };
    expect(fake.askSideQuestion).toHaveBeenCalledWith("what's hasPipe?");
    expect(body.sideQuestion.question).toBe("what's hasPipe?");
    expect(body.sideQuestion.answer).toBe('answer about hasPipe');

    // GET history reflects it
    const listRes = await fetch(apiUrl(`/api/sessions/${SID}/side-questions`));
    const list = await listRes.json() as { sideQuestions: Array<{ id: string }> };
    expect(list.sideQuestions.some((q) => q.id === body.sideQuestion.id)).toBe(true);
  });

  it('promotes a side question into a task that carries the Q&A, not the session', async () => {
    registerFakeSession('promotable answer');
    const askRes = await fetch(apiUrl(`/api/sessions/${SID}/side-question`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'promote me' }),
    });
    const { sideQuestion } = await askRes.json() as { sideQuestion: { id: string } };

    const promoteRes = await fetch(apiUrl(`/api/sessions/${SID}/side-question/${sideQuestion.id}/promote`), {
      method: 'POST',
    });
    expect(promoteRes.status).toBe(200);
    const { taskId } = await promoteRes.json() as { taskId: string };
    expect(typeof taskId).toBe('string');

    // The task exists and carries the Q&A in its description. It is NOT linked to
    // the session: a session belongs to one task (core/sessions/one-session-per-task.ts).
    const taskRes = await fetch(apiUrl(`/api/tasks/${taskId}`));
    expect(taskRes.status).toBe(200);
    const { task } = await taskRes.json() as {
      task: { title: string; description?: string; session_id?: string; session_ids?: string[] };
    };
    expect(task.title).toBe('promote me');
    expect(task.description).toBe('promotable answer');
    expect(task.session_id).toBeUndefined();
    expect(task.session_ids ?? []).not.toContain(SID);

    // The side question remembers the task it became.
    const listRes = await fetch(apiUrl(`/api/sessions/${SID}/side-questions`));
    const list = await listRes.json() as { sideQuestions: Array<{ id: string; promotedTaskId?: string }> };
    expect(list.sideQuestions.find((q) => q.id === sideQuestion.id)?.promotedTaskId).toBe(taskId);
  });

  it('promotes into a SUBTASK when the session is working on a task', async () => {
    registerFakeSession('subtask answer');
    // Create a real parent task and a session record that links to it.
    const parent = await addTask({ title: 'parent task', category: 'Inbox' });
    await createSessionRecord(SID, parent.task.id, 'proj');

    const askRes = await fetch(apiUrl(`/api/sessions/${SID}/side-question`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'sub me' }),
    });
    const { sideQuestion } = await askRes.json() as { sideQuestion: { id: string } };

    const promoteRes = await fetch(apiUrl(`/api/sessions/${SID}/side-question/${sideQuestion.id}/promote`), {
      method: 'POST',
    });
    expect(promoteRes.status).toBe(200);
    const { taskId, parentTaskId } = await promoteRes.json() as { taskId: string; parentTaskId?: string };
    expect(parentTaskId).toBe(parent.task.id);

    const taskRes = await fetch(apiUrl(`/api/tasks/${taskId}`));
    const { task } = await taskRes.json() as { task: { parent_task_id?: string } };
    expect(task.parent_task_id).toBe(parent.task.id);
  });

  it('deletes a side question from history', async () => {
    registerFakeSession();
    const askRes = await fetch(apiUrl(`/api/sessions/${SID}/side-question`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'delete me' }),
    });
    const { sideQuestion } = await askRes.json() as { sideQuestion: { id: string } };

    const delRes = await fetch(apiUrl(`/api/sessions/${SID}/side-question/${sideQuestion.id}`), { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    const listRes = await fetch(apiUrl(`/api/sessions/${SID}/side-questions`));
    const list = await listRes.json() as { sideQuestions: Array<{ id: string }> };
    expect(list.sideQuestions.some((q) => q.id === sideQuestion.id)).toBe(false);
  });

  // Regression for the "Live session not found" bug: a session that is genuinely
  // ALIVE but absent from the in-memory map (the common case on a fresh process —
  // only reconciler-flagged sessions get pre-loaded). The old route used
  // findByClaudeId (map-only) and wrongly 404'd; the route now uses
  // getOrAttachLiveSession, which rehydrates via attachToExisting — the SAME
  // attach-on-demand a normal send turn gets in processNext. If this test 404s,
  // the route regressed back to map-only resolution.
  it('attaches on demand when the live session is NOT in the in-memory map', async () => {
    // Deliberately do NOT registerFakeSession — the map must be empty for SID.
    const ALIVE_SID = 'btw-attach-on-demand';
    await createSessionRecord(ALIVE_SID, undefined, 'proj');

    const attached = {
      sessionId: ALIVE_SID,
      askSideQuestion: vi.fn(async (_q: string) => 'attached-on-demand answer'),
      detach: () => {},
      kill: () => {},
      get active() { return false; },
    };
    // Force the rehydration path: alive probe passes, attachToExisting yields our fake.
    const aliveSpy = vi
      .spyOn(sessionRunner as unknown as { isSessionStillAlive: (r: unknown) => Promise<boolean> }, 'isSessionStillAlive')
      .mockResolvedValue(true);
    const attachSpy = vi
      .spyOn(ClaudeCodeSession, 'attachToExisting')
      .mockResolvedValue(attached as unknown as ClaudeCodeSession);

    try {
      const res = await fetch(apiUrl(`/api/sessions/${ALIVE_SID}/side-question`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'are you reachable?' }),
      });
      expect(res.status).toBe(200); // ← would be 404 under the old findByClaudeId-only route
      expect(attachSpy).toHaveBeenCalled();
      expect(attached.askSideQuestion).toHaveBeenCalledWith('are you reachable?');
      const body = await res.json() as { sideQuestion: { answer: string } };
      expect(body.sideQuestion.answer).toBe('attached-on-demand answer');
    } finally {
      aliveSpy.mockRestore();
      attachSpy.mockRestore();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sessionRunner as any).sessions.delete(ALIVE_SID);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sessionRunner as any).sessions.delete(`reconnected-${ALIVE_SID}`);
    }
  });
});
