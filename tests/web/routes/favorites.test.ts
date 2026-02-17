/**
 * Tests for the favorites API routes (Fix 3).
 * Covers CRUD for category/project favorites via /api/favorites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME } from '../../../src/constants.js';
import { favoritesRouter } from '../../../src/web/routes/favorites.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/favorites', favoritesRouter);
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

describe('GET /api/favorites', () => {
  it('returns empty arrays when no favorites exist', async () => {
    const app = createApp();
    const res = await request(app).get('/api/favorites');

    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([]);
    expect(res.body.projects).toEqual([]);
  });
});

describe('Category favorites', () => {
  it('POST adds a category favorite', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/categories/Work');

    expect(res.status).toBe(200);
    expect(res.body.categories).toContain('Work');
  });

  it('adding same category twice is idempotent', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/categories/Work');
    const res = await request(app).post('/api/favorites/categories/Work');

    expect(res.status).toBe(200);
    expect(res.body.categories.filter((c: string) => c === 'Work')).toHaveLength(1);
  });

  it('DELETE removes a category favorite', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/categories/Work');
    const res = await request(app).delete('/api/favorites/categories/Work');

    expect(res.status).toBe(200);
    expect(res.body.categories).not.toContain('Work');
  });

  it('deleting non-existent favorite is safe', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/favorites/categories/NonExistent');
    expect(res.status).toBe(200);
  });

  it('multiple categories can be favorited', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/categories/Work');
    await request(app).post('/api/favorites/categories/Life');
    await request(app).post('/api/favorites/categories/Personal');

    const res = await request(app).get('/api/favorites');
    expect(res.body.categories).toHaveLength(3);
    expect(res.body.categories).toContain('Work');
    expect(res.body.categories).toContain('Life');
    expect(res.body.categories).toContain('Personal');
  });

  it('handles URL-encoded category names', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/categories/My%20Category');

    expect(res.status).toBe(200);
    expect(res.body.categories).toContain('My Category');
  });
});

describe('Project favorites', () => {
  it('POST adds a project favorite', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/projects/HomeLab');

    expect(res.status).toBe(200);
    expect(res.body.projects).toContain('HomeLab');
  });

  it('adding same project twice is idempotent', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/projects/HomeLab');
    const res = await request(app).post('/api/favorites/projects/HomeLab');

    expect(res.status).toBe(200);
    expect(res.body.projects.filter((p: string) => p === 'HomeLab')).toHaveLength(1);
  });

  it('DELETE removes a project favorite', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/projects/HomeLab');
    const res = await request(app).delete('/api/favorites/projects/HomeLab');

    expect(res.status).toBe(200);
    expect(res.body.projects).not.toContain('HomeLab');
  });

  it('handles URL-encoded project names', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/projects/AI%20Eureka');

    expect(res.status).toBe(200);
    expect(res.body.projects).toContain('AI Eureka');
  });
});

describe('Mixed favorites', () => {
  it('category and project favorites are independent', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/categories/Work');
    await request(app).post('/api/favorites/projects/HomeLab');

    const res = await request(app).get('/api/favorites');
    expect(res.body.categories).toEqual(['Work']);
    expect(res.body.projects).toEqual(['HomeLab']);

    // Deleting a category doesn't affect projects
    await request(app).delete('/api/favorites/categories/Work');
    const res2 = await request(app).get('/api/favorites');
    expect(res2.body.categories).toEqual([]);
    expect(res2.body.projects).toEqual(['HomeLab']);
  });

  it('favorites persist to config and survive re-reads', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/categories/Work');
    await request(app).post('/api/favorites/projects/HomeLab');

    // Create fresh app instance to force config re-read
    const app2 = createApp();
    const res = await request(app2).get('/api/favorites');
    expect(res.body.categories).toEqual(['Work']);
    expect(res.body.projects).toEqual(['HomeLab']);
  });
});
