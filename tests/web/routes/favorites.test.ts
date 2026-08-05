/**
 * Tests for the favorites API routes.
 * Covers CRUD for project and note favorites via /api/favorites. Project is the
 * single grouping layer, so there is no second (category) favorites dimension.
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
    expect(res.body.projects).toEqual([]);
    expect(res.body.notes).toEqual([]);
    // The retired category dimension must not resurface in the payload.
    expect(res.body).not.toHaveProperty('categories');
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

  it('deleting non-existent favorite is safe', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/favorites/projects/NonExistent');
    expect(res.status).toBe(200);
  });

  it('multiple projects can be favorited', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/projects/HomeLab');
    await request(app).post('/api/favorites/projects/Taxes');
    await request(app).post('/api/favorites/projects/Travel');

    const res = await request(app).get('/api/favorites');
    expect(res.body.projects).toHaveLength(3);
    expect(res.body.projects).toContain('HomeLab');
    expect(res.body.projects).toContain('Taxes');
    expect(res.body.projects).toContain('Travel');
  });

  it('handles URL-encoded project names', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/projects/AI%20Eureka');

    expect(res.status).toBe(200);
    expect(res.body.projects).toContain('AI Eureka');
  });

  // Project identity is case-INSENSITIVE (task_projects is NOCASE), so the
  // favorites list must be too — otherwise "HomeLab" and "homelab" both persist
  // and the star toggle looks dead on whichever spelling isn't stored.
  it('POST is idempotent across case (no differently-cased duplicate)', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/projects/HomeLab');
    const res = await request(app).post('/api/favorites/projects/homelab');

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
  });

  it('DELETE matches case-insensitively', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/projects/HomeLab');
    const res = await request(app).delete('/api/favorites/projects/HOMELAB');

    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });
});

describe('Note favorites', () => {
  it('POST adds a note favorite via body', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });

    expect(res.status).toBe(200);
    expect(res.body.notes).toContain('PARA/foo.md');
  });

  it('POST without a path returns 400', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/notes').send({});

    expect(res.status).toBe(400);
  });

  it('adding same note twice is idempotent', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });
    const res = await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });

    expect(res.status).toBe(200);
    expect(res.body.notes.filter((p: string) => p === 'PARA/foo.md')).toHaveLength(1);
  });

  it('GET returns favorited notes', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/notes').send({ path: '1 Projects/alpha.md' });
    await request(app).post('/api/favorites/notes').send({ path: '2 Areas/beta.md' });

    const res = await request(app).get('/api/favorites');
    expect(res.body.notes).toHaveLength(2);
    expect(res.body.notes).toContain('1 Projects/alpha.md');
    expect(res.body.notes).toContain('2 Areas/beta.md');
  });

  it('DELETE removes a note favorite via body', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });
    const res = await request(app).delete('/api/favorites/notes').send({ path: 'PARA/foo.md' });

    expect(res.status).toBe(200);
    expect(res.body.notes).not.toContain('PARA/foo.md');
  });

  it('DELETE removes a note favorite via query string', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });
    const res = await request(app).delete('/api/favorites/notes?path=PARA%2Ffoo.md');

    expect(res.status).toBe(200);
    expect(res.body.notes).not.toContain('PARA/foo.md');
  });

  it('preserves slashes and .md verbatim (exact-string storage)', async () => {
    const app = createApp();
    const path = '3 Resources/sub dir/My Note.md';
    await request(app).post('/api/favorites/notes').send({ path });

    const res = await request(app).get('/api/favorites');
    expect(res.body.notes).toEqual([path]);
  });
});

describe('Mixed favorites', () => {
  it('project and note favorites are independent', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/projects/HomeLab');
    await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });

    const res = await request(app).get('/api/favorites');
    expect(res.body.projects).toEqual(['HomeLab']);
    expect(res.body.notes).toEqual(['PARA/foo.md']);

    // Deleting a project favorite doesn't affect notes
    await request(app).delete('/api/favorites/projects/HomeLab');
    const res2 = await request(app).get('/api/favorites');
    expect(res2.body.projects).toEqual([]);
    expect(res2.body.notes).toEqual(['PARA/foo.md']);
  });

  it('favorites persist to config and survive re-reads', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/projects/HomeLab');
    await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });

    // Create fresh app instance to force config re-read
    const app2 = createApp();
    const res = await request(app2).get('/api/favorites');
    expect(res.body.projects).toEqual(['HomeLab']);
    expect(res.body.notes).toEqual(['PARA/foo.md']);
  });
});
