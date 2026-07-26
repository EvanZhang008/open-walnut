/**
 * Verifies the pre-assigned-session-id contract that makes the session panel
 * mount instantly.
 *
 * Before this, a session's id was only learned from the CLI's first init JSONL
 * line (3-6s after the click), so the UI had to park on a placeholder column and
 * then remount when the real id arrived. Now the route mints the id up front and
 * returns it, so the real panel mounts in the same frame as the click.
 *
 * Two invariants matter and are both asserted here:
 *   1. The response carries a v4 sessionId, and that SAME id is forwarded to the
 *      session runner (it becomes the CLI's `--session-id`).
 *   2. GET /api/sessions/:id resolves with NO wait. The panel's first act is that
 *      GET, and it treats 404 as "session does not exist" (not a transient
 *      error), so a 404 window would strand it in the "Untitled session" empty
 *      state. The pre-spawn record seed closes that window.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
}));

vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: () => {},
}));

vi.mock('../../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}));

vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: null,
}));

vi.mock('../../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: async () => {},
  getQueue: async () => [],
  revertToPending: async () => {},
}));

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../../src/constants.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

// Capture SESSION_START payloads so we can assert the id actually reaches the
// runner (i.e. would become `--session-id`), not just that it's in the response.
let starts: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  starts = [];
  bus.subscribe('preassign-probe', (e) => {
    if (e.name === EventNames.SESSION_START) starts.push(e.data as Record<string, unknown>);
  }, { global: true, interest: ['session:start'] });
});

afterEach(async () => {
  bus.unsubscribe('preassign-probe');
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

describe('pre-assigned session id', () => {
  it('quick-start returns a v4 sessionId, forwards it to the runner, and it reads back with no wait', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/preassign-qs', message: 'hello' });

    expect(res.status).toBe(200);
    // 1. Response carries the id — this is what lets the UI skip the placeholder.
    expect(res.body.sessionId).toMatch(UUID_V4);

    // 2. The very same id reached the session runner (becomes --session-id).
    const start = starts.find(s => s.taskId === res.body.taskId);
    expect(start?.preassignedSessionId).toBe(res.body.sessionId);

    // 3. Readable immediately. This is the assertion that would fail without the
    //    pre-spawn seed (404 until the CLI spawned).
    const get = await request(app).get(`/api/sessions/${res.body.sessionId}`);
    expect(get.status).toBe(200);
    expect(get.body.session.claudeSessionId).toBe(res.body.sessionId);
    expect(get.body.session.taskId).toBe(res.body.taskId);
    // Parked, not mid-turn: no turn has run, so the UI must not show "working".
    expect(get.body.session.process_status).toBe('idle');
  });

  it('fork returns its own sessionId, distinct from the source, readable with no wait', async () => {
    const app = createApp();
    const src = await request(app)
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/preassign-fork', message: 'parent work' });
    expect(src.status).toBe(200);

    const res = await request(app)
      .post(`/api/sessions/${src.body.sessionId}/fork`)
      .send({ create_child_task: true, message: 'child work' });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toMatch(UUID_V4);
    // A fork mints a NEW session; reusing the parent id would collide on disk.
    expect(res.body.sessionId).not.toBe(src.body.sessionId);
    expect(res.body.sourceSessionId).toBe(src.body.sessionId);

    const forkStart = starts.find(s => s.forkedFromSessionId === src.body.sessionId);
    expect(forkStart?.preassignedSessionId).toBe(res.body.sessionId);

    const get = await request(app).get(`/api/sessions/${res.body.sessionId}`);
    expect(get.status).toBe(200);
    // Lineage must be on the seeded row, not only filled in after spawn.
    expect(get.body.session.forkedFromSessionId).toBe(src.body.sessionId);
  });

  it('a Codex (ACP) start omits sessionId — its adapter owns id assignment', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/preassign-codex', message: 'hi', engine: 'codex' });

    expect(res.status).toBe(200);
    // Clients must treat sessionId as optional; Codex keeps the poll-for-id path.
    expect(res.body.sessionId).toBeUndefined();
    const start = starts.find(s => s.taskId === res.body.taskId);
    expect(start?.preassignedSessionId).toBeUndefined();
  });
});
