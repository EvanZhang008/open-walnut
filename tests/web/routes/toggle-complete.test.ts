/**
 * Tests for POST /api/tasks/:id/toggle-complete route (Fix 2).
 * Also tests slash-format parsing via POST /api/tasks (Fix 4).
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

describe('POST /api/tasks — slash format parsing', () => {
  it('creates a task with slash-separated category/project', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Slash test', category: 'idea / work idea' });

    expect(res.status).toBe(201);
    expect(res.body.task.category).toBe('Idea');
    expect(res.body.task.project).toBe('Work idea');
  });

  it('explicit project overrides slash-parsed project', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Override test', category: 'idea / work idea', project: 'custom' });

    expect(res.status).toBe(201);
    expect(res.body.task.category).toBe('Idea');
    expect(res.body.task.project).toBe('custom');
  });

  it('plain category with no slash is unchanged', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Plain test', category: 'work' });

    expect(res.status).toBe(201);
    expect(res.body.task.category).toBe('work');
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

describe('PATCH /api/tasks/:id — slash format parsing', () => {
  it('updates category with slash-separated format', async () => {
    const { task } = await addTask({ title: 'Update slash', category: 'old' });
    const app = createApp();

    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ category: 'new cat / new proj' });

    expect(res.status).toBe(200);
    expect(res.body.task.category).toBe('New cat');
    expect(res.body.task.project).toBe('New proj');
  });

  it('explicit project in update overrides slash parsing', async () => {
    const { task } = await addTask({ title: 'Update override', category: 'old' });
    const app = createApp();

    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ category: 'new cat / new proj', project: 'explicit' });

    expect(res.status).toBe(200);
    expect(res.body.task.project).toBe('explicit');
  });
});
