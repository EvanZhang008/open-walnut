import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { searchRouter } from '../../../src/web/routes/search.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/search', () => {
  it('returns empty results for empty query', async () => {
    const app = createApp();
    const res = await request(app).get('/api/search?q=');

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('finds tasks by title', async () => {
    await addTask({ title: 'Fix authentication bug' });
    await addTask({ title: 'Add logging' });

    const app = createApp();
    // Use mode=keyword to avoid Ollama dependency (vector search tested separately)
    const res = await request(app).get('/api/search?q=authentication&mode=keyword');

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(res.body.results[0].title).toBe('Fix authentication bug');
    expect(res.body.results[0].type).toBe('task');
  });

  it('filters by types parameter', async () => {
    await addTask({ title: 'Searchable task' });

    const app = createApp();
    const res = await request(app).get('/api/search?q=searchable&types=task&mode=keyword');

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(res.body.results.every((r: { type: string }) => r.type === 'task')).toBe(true);
  });

  it('respects limit parameter', async () => {
    await addTask({ title: 'Match one' });
    await addTask({ title: 'Match two' });
    await addTask({ title: 'Match three' });

    const app = createApp();
    const res = await request(app).get('/api/search?q=match&limit=2&mode=keyword');

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeLessThanOrEqual(2);
  });
});
