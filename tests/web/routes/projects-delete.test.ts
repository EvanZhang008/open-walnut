import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-projdel-smoke'));

import express from 'express';
import request from 'supertest';
import { projectsRouter } from '../../../src/web/routes/projects.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import {
  _resetForTesting,
  addTask,
  listTasks,
  getStoreProjects,
  ensureProject,
  setProjectMetadata,
  getProjectMetadata,
} from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { WALNUT_HOME } from '../../../src/constants.js';

let app: express.Express;

// Per-test isolation, NOT beforeAll: the five cases below each create their own
// projects, and a shared store made them order-dependent (case 5 leaned on the
// "Other" row that case 1 happened to leave behind). A fresh WALNUT_HOME per
// test means any case can run alone, in any order, or be `.only`'d.
//
// closeDb() must precede the rm: the SQLite handle (plus its -wal/-shm) is a
// process-global singleton, so removing the directory under a live handle leaves
// task-db pointing at a deleted inode and the next getDb() reuses it.
async function freshHome(): Promise<void> {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
}

beforeEach(async () => {
  await freshHome();
  app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use(errorHandler);
});

afterEach(freshHome);

describe('deleteProject', () => {
  it('moves tasks to Inbox and drops the row', async () => {
    const { task: a } = await addTask({ title: 'A', project: 'Marina' });
    const { task: b } = await addTask({ title: 'B', project: 'marina' });
    await addTask({ title: 'C', project: 'Other' });

    const list = await request(app).get('/api/projects');
    expect(list.status).toBe(200);
    expect(list.body.projects.map((p: any) => p.name).sort()).toEqual(['Marina', 'Other']);

    const del = await request(app).delete('/api/projects/Marina');
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ project: 'Marina', movedToInbox: 2 });

    const tasks = await listTasks();
    expect(tasks.find((t) => t.id === a.id)!.project).toBe('');
    expect(tasks.find((t) => t.id === b.id)!.project).toBe('');
    const projects = await getStoreProjects();
    expect(Object.keys(projects)).toEqual(['Other']);

    // Inbox counts show up on GET /
    const after = await request(app).get('/api/projects');
    expect(after.body.inbox.counts.todo).toBe(2);
    expect(after.body.projects.map((p: any) => p.name)).toEqual(['Other']);
  });

  it('404s an unknown project and 400s Inbox', async () => {
    expect((await request(app).delete('/api/projects/Nope')).status).toBe(404);
    expect((await request(app).delete('/api/projects/%20')).status).toBe(400);
  });

  it('409s a provider-claimed project', async () => {
    await ensureProject('Synced', 'ms-todo');
    const res = await request(app).delete('/api/projects/Synced');
    expect(res.status).toBe(409);
    expect((await getStoreProjects())['Synced']).toBeTruthy();
  });

  it('deletes an empty project row (no tasks)', async () => {
    await ensureProject('Empty');
    const res = await request(app).delete('/api/projects/Empty');
    expect(res.status).toBe(200);
    expect(res.body.movedToInbox).toBe(0);
    expect((await getStoreProjects())['Empty']).toBeUndefined();
  });

  it('preserves other rows metadata across a delete', async () => {
    // Own its "bystander" project rather than inheriting one from an earlier case.
    await addTask({ title: 'Keeper', project: 'Other' });
    await setProjectMetadata('Other', { default_cwd: '/tmp/x', remote_list: 'Legacy / Other' });
    await addTask({ title: 'D', project: 'Doomed' });

    expect((await request(app).delete('/api/projects/Doomed')).status).toBe(200);
    expect(await getProjectMetadata('Other')).toEqual({ default_cwd: '/tmp/x', remote_list: 'Legacy / Other' });
    expect((await getStoreProjects())['Other']).toBeTruthy();
  });
});

// The detail pane clears a setting by sending JSON `null` — `undefined` is dropped
// by JSON.stringify, so it never reaches the server and the merge is a silent
// no-op (the field appears to revert itself).
describe('PUT /api/projects/:name/metadata', () => {
  it('merges a set and clears a field sent as null', async () => {
    await ensureProject('Marina');

    const set = await request(app)
      .put('/api/projects/Marina/metadata')
      .send({ default_cwd: '/tmp/marina', default_host: 'devbox' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ default_cwd: '/tmp/marina', default_host: 'devbox' });

    const cleared = await request(app)
      .put('/api/projects/Marina/metadata')
      .send({ default_host: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.default_host).toBeUndefined();
    // The untouched sibling survives the merge.
    expect(cleared.body.default_cwd).toBe('/tmp/marina');
    expect(await getProjectMetadata('Marina')).toEqual({ default_cwd: '/tmp/marina' });
  });
});
