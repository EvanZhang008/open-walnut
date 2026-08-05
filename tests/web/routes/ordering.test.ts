/**
 * Tests for the ordering API routes.
 *
 * Project is the single grouping layer, so ordering is ONE flat list
 * (`config.ordering.projects: string[]`) served by GET /api/ordering and
 * replaced wholesale by PUT /api/ordering/projects. The old two-level shape
 * (`ordering.categories` + per-category `ordering.projects[cat]`) is gone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME } from '../../../src/constants.js';
import { orderingRouter } from '../../../src/web/routes/ordering.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ordering', orderingRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/ordering', () => {
  it('returns an empty flat list when no ordering exists', async () => {
    const app = createApp();
    const res = await request(app).get('/api/ordering');

    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
    // The retired second level must not resurface in the payload.
    expect(res.body).not.toHaveProperty('categories');
  });
});

describe('PUT /api/ordering/projects', () => {
  it('sets the project order', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/ordering/projects')
      .send({ order: ['HomeLab', 'Taxes', 'AI Eureka'] });

    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual(['HomeLab', 'Taxes', 'AI Eureka']);
  });

  it('replaces the existing order wholesale', async () => {
    const app = createApp();
    await request(app)
      .put('/api/ordering/projects')
      .send({ order: ['HomeLab', 'Taxes'] });

    const res = await request(app)
      .put('/api/ordering/projects')
      .send({ order: ['Taxes', 'HomeLab', 'Travel'] });

    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual(['Taxes', 'HomeLab', 'Travel']);
  });

  it('accepts project names with spaces', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/ordering/projects')
      .send({ order: ['My Project', 'Proj B'] });

    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual(['My Project', 'Proj B']);
  });

  it('rejects a non-array body', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/ordering/projects')
      .send({ order: 'not-an-array' });

    expect(res.status).toBe(400);
  });

  it('rejects an array holding non-strings', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/ordering/projects')
      .send({ order: ['Work', 42] });

    expect(res.status).toBe(400);
  });

  it('accepts an empty order (clears the ordering)', async () => {
    const app = createApp();
    await request(app).put('/api/ordering/projects').send({ order: ['Work'] });

    const res = await request(app).put('/api/ordering/projects').send({ order: [] });
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });

  it('persists across config re-reads', async () => {
    const app = createApp();
    await request(app)
      .put('/api/ordering/projects')
      .send({ order: ['Life', 'Work'] });

    // Fresh app instance forces config re-read
    const app2 = createApp();
    const res = await request(app2).get('/api/ordering');
    expect(res.body.projects).toEqual(['Life', 'Work']);
  });
});
