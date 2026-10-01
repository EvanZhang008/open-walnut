/**
 * POST /api/sessions/quick-start — client `project` seed (project-header
 * "+ → Add session (with task)").
 *
 * - `project: "Name"` files the new task under that project (registry row
 *   auto-created when unknown).
 * - Omitted/empty → Inbox ('').
 * - A name the registry gate rejects (path separators) → 400, not 500.
 * - `projectFromFolder`: the server decides the name (folder-project.ts): the
 *   folder's own project, else a new one named after it, made unique.
 * - fix-walnut intent overrides any client seed (spread order in the route).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());
// The host Start gate has its own tests (tests/core/sessions/host-start-gate.test.ts);
// these launches are the ones past it.
vi.mock('../../../src/core/sessions/host-start-gate.js', () => ({ hostStartGate: async () => null }));
// A fix-walnut launch runs in Walnut's source, and this install shape has none
// (no WALNUT_INSTALL_DIR), so the real lookup would CLONE upstream. Where a repair
// runs is quick-start-fix-walnut.test.ts's subject; here it is a fixed answer.
vi.mock('../../../src/core/self-repair/walnut-source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/self-repair/walnut-source.js')>();
  return { ...actual, ensureWalnutSource: async () => ({ source: { dir: '/tmp', kind: 'configured' as const }, cloned: false }) };
});

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
import { _resetForTesting as resetTaskManager, getTask, getStoreProjects, getProjectMetadata, setProjectMetadata, ensureProject, deleteProject, renameProject } from '../../../src/core/task-manager.js';
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

  it("files under the folder's own project and NEVER rewrites its default_cwd", async () => {
    const app = createApp();
    await ensureProject('Marina', 'local');
    await setProjectMetadata('Marina', { default_cwd: '/home/marina' });
    // A stale draft carrying the lowercase basename still lands on the owner.
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/home/marina/', message: 'go', project: 'marina', projectFromFolder: true });

    expect(res.status).toBe(200);
    expect((await getTask(res.body.taskId)).project).toBe('Marina');
    expect((await getProjectMetadata('Marina'))?.default_cwd).toBe('/home/marina');
  });

  it("a folder-derived name another folder owns is re-decided from the launch folder", async () => {
    // 2026-09-28: a team folder inside a shared checkout landed in the
    // checkout's project. An older window can still send that parent's name.
    const app = createApp();
    await ensureProject('Hub Agent', 'local');
    await setProjectMetadata('Hub Agent', { default_cwd: '/work/hub' });
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/work/hub/teams/coral', message: 'go', project: 'Hub Agent', projectFromFolder: true });

    expect(res.status).toBe(200);
    expect((await getTask(res.body.taskId)).project).toBe('coral');
    expect((await getProjectMetadata('coral'))?.default_cwd).toBe('/work/hub/teams/coral');
    expect((await getProjectMetadata('Hub Agent'))?.default_cwd).toBe('/work/hub');
  });

  it('two folders with the same name get two projects, each its own on the next launch', async () => {
    const app = createApp();
    const first = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/a/acme/kelp', message: 'go', project: 'kelp', projectFromFolder: true });
    // The second draft was opened before the first launch made "kelp".
    const second = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/b/reef/kelp', message: 'go', project: 'kelp', projectFromFolder: true });
    const again = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/b/reef/kelp', message: 'go', project: 'reef-kelp', projectFromFolder: true });

    expect((await getTask(first.body.taskId)).project).toBe('kelp');
    expect((await getTask(second.body.taskId)).project).toBe('reef-kelp');
    expect((await getTask(again.body.taskId)).project).toBe('reef-kelp');
    expect((await getProjectMetadata('kelp'))?.default_cwd).toBe('/a/acme/kelp');
    expect((await getProjectMetadata('reef-kelp'))?.default_cwd).toBe('/b/reef/kelp');
  });

  it('two launches at once from two same-named folders still get two projects', async () => {
    // Decide-and-create is one locked step: both reading "reed" as free and
    // both filing under it would put two folders in one project.
    const app = createApp();
    const [a, b] = await Promise.all([
      request(app).post('/api/sessions/quick-start')
        .send({ cwd: '/east/reed', message: 'go', project: 'reed', projectFromFolder: true }),
      request(app).post('/api/sessions/quick-start')
        .send({ cwd: '/west/reed', message: 'go', project: 'reed', projectFromFolder: true }),
    ]);
    const byFolder = {
      '/east/reed': (await getTask(a.body.taskId)).project,
      '/west/reed': (await getTask(b.body.taskId)).project,
    };
    // Whichever ran first took "reed"; the other grew by its parent folder.
    expect([byFolder['/east/reed'], byFolder['/west/reed']].sort()).toSatisfy((names: string[]) =>
      JSON.stringify(names) === '["east-reed","reed"]' || JSON.stringify(names) === '["reed","west-reed"]');
    for (const [folder, name] of Object.entries(byFolder)) {
      expect((await getProjectMetadata(name))?.default_cwd).toBe(folder);
    }
  });

  it('a remote launch whose name and parent-name are taken gets the host suffix', async () => {
    const app = createApp();
    await ensureProject('tidepool', 'local');
    await ensureProject('acme-tidepool', 'local');
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/repos/acme/tidepool', message: 'go', project: 'tidepool', host: 'devbox', projectFromFolder: true });

    expect(res.status).toBe(200);
    expect((await getTask(res.body.taskId)).project).toBe('acme-tidepool (devbox)');
    const meta = await getProjectMetadata('acme-tidepool (devbox)');
    expect(meta?.default_cwd).toBe('/repos/acme/tidepool');
    expect(meta?.default_host).toBe('devbox');
  });

  it('an existing project WITHOUT a folder is a name conflict, and stays unstamped', async () => {
    const app = createApp();
    await ensureProject('Roamer', 'local');
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/second/Roamer', message: 'go', project: 'Roamer', projectFromFolder: true });

    expect(res.status).toBe(200);
    expect((await getTask(res.body.taskId)).project).toBe('second-Roamer');
    expect((await getProjectMetadata('second-Roamer'))?.default_cwd).toBe('/second/Roamer');
    expect((await getProjectMetadata('Roamer'))?.default_cwd ?? null).toBeNull();
  });

  it('a folder whose name can never name a project files the task in the Inbox', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/home/me/.claude', message: 'go', project: 'me', projectFromFolder: true });

    expect(res.status).toBe(200);
    expect((await getTask(res.body.taskId)).project).toBe('');
    expect(Object.keys(await getStoreProjects())).not.toContain('me');
  });

  it('a launch carrying a DELETED project files the task in the Inbox and does not re-create the row', async () => {
    // The draft column remembers its last project for as long as the tab lives.
    // 2026-09-08: a project deleted at 21:15 was re-created by a launch still
    // carrying its name — the launch was a WRITE that minted the registry row.
    await ensureProject('Fix Walnut', 'local');
    await deleteProject('Fix Walnut');

    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp', message: 'go', project: 'Fix Walnut' });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task.project).toBe('');
    expect(Object.keys(await getStoreProjects())).not.toContain('Fix Walnut');
  });

  it("a folder named after a DELETED project does not re-create it either", async () => {
    await ensureProject('tidepool', 'local');
    await deleteProject('tidepool');

    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/repos/tidepool', message: 'go', project: 'tidepool', projectFromFolder: true });

    expect(res.status).toBe(200);
    expect((await getTask(res.body.taskId)).project).toBe('');
    expect(Object.keys(await getStoreProjects())).not.toContain('tidepool');
  });

  it('a launch carrying a RENAMED project follows to the survivor', async () => {
    await ensureProject('Old Name', 'local');
    await renameProject('Old Name', 'New Name');

    const app = createApp();
    const res = await request(app).post('/api/sessions/quick-start')
      .send({ cwd: '/tmp', message: 'go', project: 'Old Name' });

    expect(res.status).toBe(200);
    expect((await getTask(res.body.taskId)).project).toBe('New Name');
    expect(Object.keys(await getStoreProjects())).not.toContain('Old Name');
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
