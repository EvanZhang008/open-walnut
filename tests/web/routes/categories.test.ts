import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { categoriesRouter } from '../../../src/web/routes/categories.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, createCategory, _resetForTesting } from '../../../src/core/task-manager.js';
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/categories', categoriesRouter);
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

describe('POST /api/categories/rename', () => {
  it('renames a category successfully', async () => {
    await addTask({ title: 'Task A', category: 'OldName' });

    const app = createApp();
    const res = await request(app)
      .post('/api/categories/rename')
      .send({ oldCategory: 'OldName', newCategory: 'NewName' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('returns 400 for missing oldCategory', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/categories/rename')
      .send({ newCategory: 'NewName' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing newCategory', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/categories/rename')
      .send({ oldCategory: 'OldName' });

    expect(res.status).toBe(400);
  });

  it('returns 409 when target category has different-source tasks', async () => {
    // Use addTaskFull to inject a plugin-a task into a category that's NOT config plugin-a category
    // This isolates Check 2 (existing tasks) from Check 1 (config reservation).
    const { addTaskFull } = await import('../../../src/core/task-manager.js');
    const now = new Date().toISOString();
    await addTaskFull({
      title: 'Plugin task',
      status: 'todo',
      phase: 'TODO' as const,
      priority: 'none',
      category: 'TeamWork',
      project: 'TeamWork',
      source: 'plugin-a',
      session_ids: [],
      description: '',
      summary: '',
      note: '',
      created_at: now,
      updated_at: now,
    });

    // Create local task in 'Life' (default when no plugins registered)
    await addTask({ title: 'Life task', category: 'Life' });

    const app = createApp();
    // Rename 'Life' (local) → 'TeamWork' (has plugin-a tasks)
    const res = await request(app)
      .post('/api/categories/rename')
      .send({ oldCategory: 'Life', newCategory: 'TeamWork' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already has');
    expect(res.body.intended_source).toBe('local');
    expect(res.body.existing_source).toBe('plugin-a');
  });

  it('returns 409 when target is config plugin category for non-plugin tasks', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        plugins: { 'plugin-a': { room_id: 'room-123', category: 'PluginA Zone' } },
      }),
    );

    await addTask({ title: 'My task', category: 'Personal' });

    const app = createApp();
    const res = await request(app)
      .post('/api/categories/rename')
      .send({ oldCategory: 'Personal', newCategory: 'PluginA Zone' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('plugin-a sync');
  });
});

describe('GET /api/categories', () => {
  it('returns categories with source and task counts', async () => {
    await addTask({ title: 'Task A', category: 'Life' });
    await addTask({ title: 'Task B', category: 'Life' });
    await addTask({ title: 'Task C', category: 'Work', source: 'local' });

    const app = createApp();
    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const life = res.body.find((c: { name: string }) => c.name === 'Life');
    expect(life).toBeDefined();
    expect(life.source).toBe('local');
    expect(life.todo).toBe(2);

    const work = res.body.find((c: { name: string }) => c.name === 'Work');
    expect(work).toBeDefined();
    expect(work.source).toBe('local');
  });

  it('includes empty categories from store.categories (migrated from config)', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        local: { categories: ['EmptyLocal'] },
      }),
    );

    const app = createApp();
    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(200);
    const empty = res.body.find((c: { name: string }) => c.name === 'EmptyLocal');
    expect(empty).toBeDefined();
    expect(empty.source).toBe('local');
    expect(empty.todo).toBe(0);
  });
});

describe('POST /api/categories', () => {
  it('creates a new local category', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/categories')
      .send({ name: 'Scratch', source: 'local' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: 'Scratch', source: 'local' });
  });

  it('returns 409 for duplicate category', async () => {
    await createCategory('Scratch', 'local');

    const app = createApp();
    const res = await request(app)
      .post('/api/categories')
      .send({ name: 'scratch', source: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already exists');
  });

  it('returns 400 for missing name', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/categories')
      .send({ source: 'local' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid source', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/categories')
      .send({ name: 'Test', source: 'invalid' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/categories/:name/source', () => {
  it('updates a category source via store.categories', async () => {
    // Category must exist in store.categories first
    await createCategory('Scratch', 'local');

    const app = createApp();
    const res = await request(app)
      .post('/api/categories/Scratch/source')
      .send({ source: 'ms-todo' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'Scratch', source: 'ms-todo' });
  });

  it('returns 404 for non-existent category', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/categories/NonExist/source')
      .send({ source: 'local' });

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid source', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/categories/Test/source')
      .send({ source: 'invalid' });

    expect(res.status).toBe(400);
  });

  it('returns 409 when category has conflicting tasks', async () => {
    // Create category as ms-todo explicitly, then add a task
    await createCategory('Life', 'ms-todo');
    await addTask({ title: 'Task', category: 'Life' });

    const app = createApp();
    const res = await request(app)
      .post('/api/categories/Life/source')
      .send({ source: 'local' });

    expect(res.status).toBe(409);
    expect(res.body.existing_source).toBe('ms-todo');
  });
});
