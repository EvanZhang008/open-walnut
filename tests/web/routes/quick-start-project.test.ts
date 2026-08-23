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
  parkMessages: async () => 0,
  parkStalePending: async () => [],
  unparkMessage: async () => false,
  sendMessageToSession: async () => {},
  getQueue: async () => [],
  revertToPending: async () => {},
}));

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting as resetTaskManager, getTask, getStoreProjects, getProjectMetadata, setProjectMetadata } from '../../../src/core/task-manager.js';
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

  it('canonicalizes to the existing registry spelling (case-insensitive identity)', async () => {
    const app = createApp();
    // First create establishes the canonical spelling…
    await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp', message: 'go', project: 'Marina' });
    // …a later differently-cased seed must land on it, not fork a twin.
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp', message: 'go again', project: 'marina' });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task.project).toBe('Marina');
    const projects = await getStoreProjects();
    expect(Object.keys(projects).filter((k) => k.toLowerCase() === 'marina')).toEqual(['Marina']);
  });

  it('stamps a NEWLY created folder-derived project with the launch folder as default_cwd', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/repos/tidepool/', message: 'go', project: 'tidepool', projectFromFolder: true });

    expect(res.status).toBe(200);
    const meta = await getProjectMetadata('tidepool');
    // Trailing slash normalized away — projectByCwd on the web side keys verbatim
    // minus trailing slashes, so the stamp must match that shape.
    expect(meta?.default_cwd).toBe('/repos/tidepool');
    expect(meta?.default_host).toBeUndefined();
  });

  it('stamps default_host too when the launch targets a remote host', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/repos/acme', message: 'go', project: 'acme', host: 'devbox', projectFromFolder: true });

    expect(res.status).toBe(200);
    const meta = await getProjectMetadata('acme');
    expect(meta?.default_cwd).toBe('/repos/acme');
    expect(meta?.default_host).toBe('devbox');
  });

  it('WITHOUT projectFromFolder a new project is created but NOT stamped', async () => {
    // A routine or server-chosen project must not adopt whatever directory it
    // happened to first run in — only the draft's folder-derived pick may bind.
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/scratch/tmp-run', message: 'go', project: 'Drifter' });

    expect(res.status).toBe(200);
    const projects = await getStoreProjects();
    expect(projects['Drifter']?.source).toBe('local');
    const meta = await getProjectMetadata('Drifter');
    expect(meta?.default_cwd ?? undefined).toBeUndefined();
  });

  it("NEVER rewrites an EXISTING project's default_cwd", async () => {
    const app = createApp();
    await setProjectMetadata('Marina', { default_cwd: '/home/marina' });
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/somewhere/else', message: 'go', project: 'Marina', projectFromFolder: true });

    expect(res.status).toBe(200);
    const meta = await getProjectMetadata('Marina');
    expect(meta?.default_cwd).toBe('/home/marina');
  });

  it('an existing project WITHOUT default_cwd stays unstamped (only a first create earns one)', async () => {
    const app = createApp();
    // Row exists from a prior create…
    await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/first/place', message: 'go', project: 'Roamer', projectFromFolder: true });
    // Wipe the stamp to simulate a user who cleared it / a pre-feature row.
    await setProjectMetadata('Roamer', { default_cwd: null });
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/second/place', message: 'go', project: 'Roamer', projectFromFolder: true });

    expect(res.status).toBe(200);
    const meta = await getProjectMetadata('Roamer');
    expect(meta?.default_cwd ?? null).toBeNull();
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
