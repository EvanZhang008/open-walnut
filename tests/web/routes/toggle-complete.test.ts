/**
 * Tests for POST /api/tasks/:id/toggle-complete route, plus the active-children
 * completion guard at the route level.
 *
 * The old "slash format parsing" suites (`category: 'idea / work idea'` split
 * into category + project on create/PATCH) are gone with the category concept:
 * a `"A / B"` string is no longer a grouping path, it's just a project name.
 * The remaining `"Cat / Proj"` decoding lives only in the MS To-Do remote list
 * adapter (parseProjectFromListName — see tests/utils/format.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, completeTask } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('POST /api/tasks/:id/toggle-complete', () => {
  it('toggles a todo task to done', async () => {
    const { task } = await addTask({ title: 'Toggle via API' });
    const app = createApp();

    const res = await request(app).post(`/api/tasks/${task.id}/toggle-complete`);

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('done');
  });

  it('toggles a done task back to todo', async () => {
    const { task } = await addTask({ title: 'Reopen via API' });
    await completeTask(task.id);

    const app = createApp();
    const res = await request(app).post(`/api/tasks/${task.id}/toggle-complete`);

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('todo');
  });

  it('full cycle through the API: todo → done → todo', async () => {
    const { task } = await addTask({ title: 'Full API cycle' });
    const app = createApp();

    const res1 = await request(app).post(`/api/tasks/${task.id}/toggle-complete`);
    expect(res1.body.task.status).toBe('done');

    const res2 = await request(app).post(`/api/tasks/${task.id}/toggle-complete`);
    expect(res2.body.task.status).toBe('todo');
  });

  it('returns 500 for non-existent task', async () => {
    const app = createApp();
    const res = await request(app).post('/api/tasks/nonexistent/toggle-complete');
    expect(res.status).toBe(500);
  });

  it('state is persisted — refetch shows updated status', async () => {
    const { task } = await addTask({ title: 'Persist check' });
    const app = createApp();

    await request(app).post(`/api/tasks/${task.id}/toggle-complete`);

    const getRes = await request(app).get(`/api/tasks/${task.id}`);
    expect(getRes.body.task.status).toBe('done');

    await request(app).post(`/api/tasks/${task.id}/toggle-complete`);

    const getRes2 = await request(app).get(`/api/tasks/${task.id}`);
    expect(getRes2.body.task.status).toBe('todo');
  });
});

describe('POST /api/tasks — project is stored verbatim', () => {
  it('rejects a slash-bearing NEW project name with 400 (no splitting, no 500)', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Slash test', project: 'idea / work idea' });

    // assertValidProjectName: a new name becomes a filesystem path segment, so
    // '/' is refused at the boundary — mapped to 400 via InvalidProjectNameError.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path separators/);
  });

  it('does not title-case or otherwise rewrite the project name', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Plain test', project: 'work' });

    expect(res.status).toBe(201);
    expect(res.body.task.project).toBe('work');
  });
});

describe('active children guard — routes', () => {
  it('POST toggle-complete returns 409 when parent has active children', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Child', parent_task_id: parent.id });
    const app = createApp();

    const res = await request(app).post(`/api/tasks/${parent.id}/toggle-complete`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/child task/);
    expect(res.body.active_children).toBe(1);
  });

  it('POST complete returns 409 when parent has active children', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Child', parent_task_id: parent.id });
    const app = createApp();

    const res = await request(app).post(`/api/tasks/${parent.id}/complete`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/child task/);
  });

  it('PATCH phase=COMPLETE returns 409 when parent has active children', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Child', parent_task_id: parent.id });
    const app = createApp();

    const res = await request(app)
      .patch(`/api/tasks/${parent.id}`)
      .send({ phase: 'COMPLETE' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/child task/);
  });

  it('allows completing parent after all children complete', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent.id });
    await completeTask(child.id);
    const app = createApp();

    const res = await request(app).post(`/api/tasks/${parent.id}/toggle-complete`);

    expect(res.status).toBe(200);
    expect(res.body.task.phase).toBe('COMPLETE');
  });

  it('toggle-complete allows reopening a completed parent', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent.id });
    await completeTask(child.id);
    await completeTask(parent.id);
    const app = createApp();

    const res = await request(app).post(`/api/tasks/${parent.id}/toggle-complete`);

    expect(res.status).toBe(200);
    expect(res.body.task.phase).toBe('TODO');
  });
});

describe('PATCH /api/tasks/:id — project moves', () => {
  it('moves the task to the named project verbatim', async () => {
    const { task } = await addTask({ title: 'Update project', project: 'old' });
    const app = createApp();

    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ project: 'new proj' });

    expect(res.status).toBe(200);
    expect(res.body.task.project).toBe('new proj');
  });

  it("moves the task to Inbox on project=''", async () => {
    const { task } = await addTask({ title: 'Back to inbox', project: 'old' });
    const app = createApp();

    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ project: '' });

    expect(res.status).toBe(200);
    expect(res.body.task.project).toBe('');
  });
});
