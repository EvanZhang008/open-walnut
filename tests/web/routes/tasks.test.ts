import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, linkSessionSlot, _resetForTesting } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/tasks', () => {
  it('returns empty task list initially', async () => {
    const app = createApp();
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
  });

  it('returns tasks after creating some', async () => {
    await addTask({ title: 'Task A' });
    await addTask({ title: 'Task B' });

    const app = createApp();
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(2);
  });

  it('filters by status', async () => {
    await addTask({ title: 'Todo task' });
    const { task } = await addTask({ title: 'Done task' });
    const { completeTask } = await import('../../../src/core/task-manager.js');
    await completeTask(task.id);

    const app = createApp();
    const res = await request(app).get('/api/tasks?status=todo');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].title).toBe('Todo task');
  });

  it('filters by category', async () => {
    await addTask({ title: 'Work task', category: 'work' });
    await addTask({ title: 'Life task', category: 'life' });

    const app = createApp();
    const res = await request(app).get('/api/tasks?category=work');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].title).toBe('Work task');
  });

  it('filters by project', async () => {
    await addTask({ title: 'HomeLab task', category: 'work', project: 'HomeLab' });
    await addTask({ title: 'Costco task', category: 'work', project: 'Costco' });

    const app = createApp();
    const res = await request(app).get('/api/tasks?project=HomeLab');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].title).toBe('HomeLab task');
  });
});

describe('GET /api/tasks/enriched', () => {
  it('returns enriched tasks with computed fields', async () => {
    await addTask({ title: 'Overdue task', due_date: '2020-01-01' });
    await addTask({ title: 'Normal task' });

    const app = createApp();
    const res = await request(app).get('/api/tasks/enriched');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(2);

    const overdue = res.body.tasks.find((t: { title: string }) => t.title === 'Overdue task');
    expect(overdue.overdue).toBe(true);

    const normal = res.body.tasks.find((t: { title: string }) => t.title === 'Normal task');
    expect(normal.overdue).toBe(false);
  });
});

describe('GET /api/tasks/:id', () => {
  it('returns a single task', async () => {
    const { task } = await addTask({ title: 'Specific task' });

    const app = createApp();
    const res = await request(app).get(`/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('Specific task');
    expect(res.body.task.id).toBe(task.id);
  });

  it('returns 500 for non-existent task', async () => {
    const app = createApp();
    const res = await request(app).get('/api/tasks/nonexistent-id');
    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});

describe('POST /api/tasks', () => {
  it('creates a task and returns it', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'New task', priority: 'immediate', category: 'work' });

    expect(res.status).toBe(201);
    expect(res.body.task.title).toBe('New task');
    expect(res.body.task.priority).toBe('immediate');
    expect(res.body.task.category).toBe('work');
    expect(res.body.task.id).toBeDefined();
  });

  it('creates a task with default fields', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Simple task' });

    expect(res.status).toBe(201);
    expect(res.body.task.priority).toBe('none');
    expect(res.body.task.status).toBe('todo');
  });

  it('creates a local task when source="local" is passed', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Local note', category: 'Scratch', source: 'local' });

    expect(res.status).toBe(201);
    expect(res.body.task.source).toBe('local');
    expect(res.body.task.category).toBe('Scratch');
  });

  // source validation removed in v3 — source is now derived from store.categories in addTask
});

describe('PATCH /api/tasks/:id', () => {
  it('updates task fields', async () => {
    const { task } = await addTask({ title: 'Original' });

    const app = createApp();
    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ title: 'Updated', priority: 'immediate' });

    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('Updated');
    expect(res.body.task.priority).toBe('immediate');
  });
});

describe('POST /api/tasks/:id/complete', () => {
  it('marks a task as done', async () => {
    const { task } = await addTask({ title: 'To complete' });

    const app = createApp();
    const res = await request(app).post(`/api/tasks/${task.id}/complete`);

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('done');
  });
});

describe('POST /api/tasks/:id/star', () => {
  it('toggles starred state', async () => {
    const { task } = await addTask({ title: 'Starrable' });

    const app = createApp();

    const res1 = await request(app).post(`/api/tasks/${task.id}/star`);
    expect(res1.status).toBe(200);
    expect(res1.body.starred).toBe(true);

    const res2 = await request(app).post(`/api/tasks/${task.id}/star`);
    expect(res2.status).toBe(200);
    expect(res2.body.starred).toBe(false);
  });
});

describe('POST /api/tasks/:id/notes', () => {
  it('adds a note to a task', async () => {
    const { task } = await addTask({ title: 'Notable' });

    const app = createApp();
    const res = await request(app)
      .post(`/api/tasks/${task.id}/notes`)
      .send({ content: 'Important note' });

    expect(res.status).toBe(200);
    expect(res.body.task.note).toContain('Important note');
  });
});

describe('PATCH /api/tasks/reorder', () => {
  it('reorders tasks within a group and persists', async () => {
    const { task: t1 } = await addTask({ title: 'First', category: 'work', project: 'HomeLab' });
    const { task: t2 } = await addTask({ title: 'Second', category: 'work', project: 'HomeLab' });
    const { task: t3 } = await addTask({ title: 'Third', category: 'work', project: 'HomeLab' });

    const app = createApp();
    const res = await request(app)
      .patch('/api/tasks/reorder')
      .send({ category: 'work', project: 'HomeLab', taskIds: [t3.id, t1.id, t2.id] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify order persisted via GET
    const listRes = await request(app).get('/api/tasks?category=work&project=HomeLab');
    expect(listRes.status).toBe(200);
    expect(listRes.body.tasks[0].id).toBe(t3.id);
    expect(listRes.body.tasks[1].id).toBe(t1.id);
    expect(listRes.body.tasks[2].id).toBe(t2.id);
  });

  it('returns 400 for missing taskIds', async () => {
    const app = createApp();
    const res = await request(app)
      .patch('/api/tasks/reorder')
      .send({ category: 'work', project: 'HomeLab' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for empty taskIds', async () => {
    const app = createApp();
    const res = await request(app)
      .patch('/api/tasks/reorder')
      .send({ category: 'work', project: 'HomeLab', taskIds: [] });

    expect(res.status).toBe(400);
  });

  it('returns 500 for mismatched IDs', async () => {
    await addTask({ title: 'One', category: 'work', project: 'HomeLab' });

    const app = createApp();
    const res = await request(app)
      .patch('/api/tasks/reorder')
      .send({ category: 'work', project: 'HomeLab', taskIds: ['fake-id'] });

    expect(res.status).toBe(500);
  });
});

// Subtask endpoint tests removed — subtasks are now child tasks in the plugin system

describe('DELETE /api/tasks/:id', () => {
  it('deletes a task and returns 204', async () => {
    const { task } = await addTask({ title: 'Delete via API' });

    const app = createApp();
    const res = await request(app).delete(`/api/tasks/${task.id}`);
    expect(res.status).toBe(204);

    // Verify task is gone
    const listRes = await request(app).get('/api/tasks');
    expect(listRes.body.tasks).toHaveLength(0);
  });

  it('returns 409 when task has active session slots', async () => {
    const { task } = await addTask({ title: 'Active session task' });
    await linkSessionSlot(task.id, 'session-aaa', 'exec');

    const app = createApp();
    const res = await request(app).delete(`/api/tasks/${task.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active sessions/);
    expect(res.body.active_session_ids).toContain('session-aaa');

    // Verify task still exists
    const listRes = await request(app).get('/api/tasks');
    expect(listRes.body.tasks).toHaveLength(1);
  });

  it('returns 409 with both slots occupied', async () => {
    const { task } = await addTask({ title: 'Multi session task' });
    await linkSessionSlot(task.id, 'sess-plan', 'plan');
    await linkSessionSlot(task.id, 'sess-exec', 'exec');

    const app = createApp();
    const res = await request(app).delete(`/api/tasks/${task.id}`);
    expect(res.status).toBe(409);
    expect(res.body.active_session_ids).toHaveLength(2);
    expect(res.body.active_session_ids).toContain('sess-plan');
    expect(res.body.active_session_ids).toContain('sess-exec');
  });

  it('returns 500 for non-existent task', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/tasks/nonexistent-id');
    expect(res.status).toBe(500);
  });
});

describe('Category-source conflict (409)', () => {
  async function setupPluginConfig() {
    const { CONFIG_FILE } = await import('../../../src/constants.js');
    const path = await import('node:path');
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        plugins: { 'plugin-a': { room_id: 'room-123', category: 'Work' } },
      }),
    );
  }

  it('PATCH /api/tasks/:id returns 409 on category change source conflict', async () => {
    await setupPluginConfig();

    // Create a plugin-a task in 'Work' (matches config plugin-a category)
    const { task: pluginTask } = await addTask({ title: 'Plugin task', category: 'Work' });
    expect(pluginTask.source).toBe('plugin-a');

    // Create a local task in 'Life' (no ms-todo plugin registered, defaults to local)
    const { task: localTask } = await addTask({ title: 'Local task', category: 'Life' });
    expect(localTask.source).toBe('local');

    const app = createApp();
    // Try to move local task to the 'Work' category (plugin-a)
    const res = await request(app)
      .patch(`/api/tasks/${localTask.id}`)
      .send({ category: 'Work' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Cannot move task');
    expect(res.body.intended_source).toBe('local');
    expect(res.body.existing_source).toBe('plugin-a');
  });

  it('PATCH /api/tasks/:id succeeds for same-source category change', async () => {
    // Both tasks are local (no external plugin config)
    const { task: t1 } = await addTask({ title: 'Task A', category: 'Alpha' });
    await addTask({ title: 'Task B', category: 'Beta' });

    const app = createApp();
    const res = await request(app)
      .patch(`/api/tasks/${t1.id}`)
      .send({ category: 'Beta' });

    expect(res.status).toBe(200);
    expect(res.body.task.category).toBe('Beta');
  });
});
