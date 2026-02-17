import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { dashboardRouter } from '../../../src/web/routes/dashboard.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, completeTask } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/dashboard', dashboardRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/dashboard', () => {
  it('returns dashboard data with stats', async () => {
    const app = createApp();
    const res = await request(app).get('/api/dashboard');

    expect(res.status).toBe(200);
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.total).toBe(0);
    expect(res.body.stats.todo).toBe(0);
    expect(res.body.stats.in_progress).toBe(0);
    expect(res.body.stats.done).toBe(0);
  });

  it('returns correct stats after adding tasks', async () => {
    await addTask({ title: 'Task 1' });
    await addTask({ title: 'Task 2', priority: 'immediate' });
    const { task: t3 } = await addTask({ title: 'Task 3' });
    await completeTask(t3.id);

    const app = createApp();
    const res = await request(app).get('/api/dashboard');

    expect(res.status).toBe(200);
    expect(res.body.stats.total).toBe(3);
    expect(res.body.stats.todo).toBe(2);
    expect(res.body.stats.done).toBe(1);
  });

  it('includes urgent_tasks for high priority items', async () => {
    await addTask({ title: 'Urgent one', priority: 'immediate' });
    await addTask({ title: 'Normal one', priority: 'none' });

    const app = createApp();
    const res = await request(app).get('/api/dashboard');

    expect(res.status).toBe(200);
    expect(res.body.urgent_tasks).toHaveLength(1);
    expect(res.body.urgent_tasks[0].title).toBe('Urgent one');
  });

  it('includes recent_sessions array', async () => {
    const app = createApp();
    const res = await request(app).get('/api/dashboard');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recent_sessions)).toBe(true);
  });
});
