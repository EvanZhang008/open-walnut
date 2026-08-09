/**
 * POST /api/sessions/quick-start — client `project` seed (project-header
 * "+ → Add session (with task)").
 *
 * - `project: "Name"` files the new task under that project (registry row
 *   auto-created when unknown).
 * - Omitted/empty → Inbox ('').
 * - A name the registry gate rejects (path separators) → 400, not 500.
 * - fix-walnut intent overrides any client seed (spread order in the route).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
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
import { _resetForTesting as resetTaskManager, getTask, getStoreProjects } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
});

afterEach(async () => {
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

describe('POST /api/sessions/quick-start — project param', () => {
  it('files the new task under the given project and auto-creates the registry row', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp', message: 'go', project: 'Marina' });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task.project).toBe('Marina');
    const projects = await getStoreProjects();
    expect(projects['Marina']?.source).toBe('local');
  });

  it('omitted project → Inbox', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp', message: 'go' });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task.project).toBe('');
  });

  it('whitespace-only project → Inbox (trimmed away)', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp', message: 'go', project: '   ' });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task.project).toBe('');
  });

  it('rejects a non-string project with 400', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp', message: 'go', project: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('project');
  });

  it('project name with path separators → 400 (registry gate), not 500', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp', message: 'go', project: 'evil/name' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path separators/i);
  });

  it('fix-walnut intent overrides a client project seed', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp', message: 'broken', project: 'Marina', intent: 'fix-walnut' });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task.project).toBe('Walnut');
  });
});
