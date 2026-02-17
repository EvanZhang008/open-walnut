/**
 * Tests for the ordering API routes.
 * Covers GET/PUT for category and project display ordering via /api/ordering.
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
  it('returns empty defaults when no ordering exists', async () => {
    const app = createApp();
    const res = await request(app).get('/api/ordering');

    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([]);
    expect(res.body.projects).toEqual({});
  });
});

describe('PUT /api/ordering/categories', () => {
  it('sets category order', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/ordering/categories')
      .send({ order: ['Work', 'Life', 'Personal'] });

    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual(['Work', 'Life', 'Personal']);
  });

  it('replaces existing category order', async () => {
    const app = createApp();
    await request(app)
      .put('/api/ordering/categories')
      .send({ order: ['Work', 'Life'] });

    const res = await request(app)
      .put('/api/ordering/categories')
      .send({ order: ['Life', 'Work', 'Personal'] });

    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual(['Life', 'Work', 'Personal']);
  });

  it('rejects non-array body', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/ordering/categories')
      .send({ order: 'not-an-array' });

    expect(res.status).toBe(400);
  });

  it('persists across config re-reads', async () => {
    const app = createApp();
    await request(app)
      .put('/api/ordering/categories')
      .send({ order: ['Work', 'Life'] });

    // Fresh app instance forces config re-read
    const app2 = createApp();
    const res = await request(app2).get('/api/ordering');
    expect(res.body.categories).toEqual(['Work', 'Life']);
  });
});

describe('PUT /api/ordering/projects/:category', () => {
  it('sets project order within a category', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/ordering/projects/Work')
      .send({ order: ['HomeLab', 'Taxes', 'AI Eureka'] });

    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual({ Work: ['HomeLab', 'Taxes', 'AI Eureka'] });
  });

  it('replaces existing project order', async () => {
    const app = createApp();
    await request(app)
      .put('/api/ordering/projects/Work')
      .send({ order: ['HomeLab', 'Taxes'] });

    const res = await request(app)
      .put('/api/ordering/projects/Work')
      .send({ order: ['Taxes', 'HomeLab'] });

    expect(res.status).toBe(200);
    expect(res.body.projects.Work).toEqual(['Taxes', 'HomeLab']);
  });

  it('handles URL-encoded category names', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/ordering/projects/My%20Category')
      .send({ order: ['Proj A', 'Proj B'] });

    expect(res.status).toBe(200);
    expect(res.body.projects['My Category']).toEqual(['Proj A', 'Proj B']);
  });

  it('rejects non-array body', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/ordering/projects/Work')
      .send({ order: 'bad' });

    expect(res.status).toBe(400);
  });

  it('multiple categories have independent project orders', async () => {
    const app = createApp();
    await request(app)
      .put('/api/ordering/projects/Work')
      .send({ order: ['HomeLab', 'Taxes'] });
    await request(app)
      .put('/api/ordering/projects/Life')
      .send({ order: ['Costco', 'Travel'] });

    const res = await request(app).get('/api/ordering');
    expect(res.body.projects).toEqual({
      Work: ['HomeLab', 'Taxes'],
      Life: ['Costco', 'Travel'],
    });
  });
});

describe('Mixed ordering', () => {
  it('category and project ordering are independent', async () => {
    const app = createApp();
    await request(app)
      .put('/api/ordering/categories')
      .send({ order: ['Life', 'Work'] });
    await request(app)
      .put('/api/ordering/projects/Work')
      .send({ order: ['HomeLab', 'Taxes'] });

    const res = await request(app).get('/api/ordering');
    expect(res.body.categories).toEqual(['Life', 'Work']);
    expect(res.body.projects).toEqual({ Work: ['HomeLab', 'Taxes'] });

    // Changing categories doesn't affect projects
    await request(app)
      .put('/api/ordering/categories')
      .send({ order: ['Work'] });

    const res2 = await request(app).get('/api/ordering');
    expect(res2.body.categories).toEqual(['Work']);
    expect(res2.body.projects).toEqual({ Work: ['HomeLab', 'Taxes'] });
  });

  it('full ordering persists to config and survives re-reads', async () => {
    const app = createApp();
    await request(app)
      .put('/api/ordering/categories')
      .send({ order: ['Life', 'Work'] });
    await request(app)
      .put('/api/ordering/projects/Work')
      .send({ order: ['HomeLab', 'Taxes'] });

    // Fresh app instance
    const app2 = createApp();
    const res = await request(app2).get('/api/ordering');
    expect(res.body.categories).toEqual(['Life', 'Work']);
    expect(res.body.projects).toEqual({ Work: ['HomeLab', 'Taxes'] });
  });
});
