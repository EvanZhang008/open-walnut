import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { memoryRouter } from '../../../src/web/routes/memory.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/memory', memoryRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/memory', () => {
  it('returns empty list when no memory files exist', async () => {
    const app = createApp();
    const res = await request(app).get('/api/memory');

    expect(res.status).toBe(200);
    expect(res.body.memories).toEqual([]);
  });

  it('returns memory entries when files exist', async () => {
    // Create a knowledge file
    const knowledgeDir = path.join(WALNUT_HOME, 'memory', 'knowledge');
    nodeFs.mkdirSync(knowledgeDir, { recursive: true });
    nodeFs.writeFileSync(path.join(knowledgeDir, 'test-note.md'), '# Test Note\n\nSome content here.');

    const app = createApp();
    const res = await request(app).get('/api/memory');

    expect(res.status).toBe(200);
    expect(res.body.memories.length).toBeGreaterThanOrEqual(1);
    const found = res.body.memories.find((m: { title: string }) => m.title === 'Test Note');
    expect(found).toBeDefined();
  });

  it('filters by category', async () => {
    // Create files in different categories
    const sessionsDir = path.join(WALNUT_HOME, 'memory', 'sessions');
    const knowledgeDir = path.join(WALNUT_HOME, 'memory', 'knowledge');
    nodeFs.mkdirSync(sessionsDir, { recursive: true });
    nodeFs.mkdirSync(knowledgeDir, { recursive: true });
    nodeFs.writeFileSync(path.join(sessionsDir, 'sess.md'), '# Session\nSession content');
    nodeFs.writeFileSync(path.join(knowledgeDir, 'know.md'), '# Knowledge\nKnowledge content');

    const app = createApp();
    const res = await request(app).get('/api/memory?category=session');

    expect(res.status).toBe(200);
    expect(res.body.memories.every((m: { category: string }) => m.category === 'session')).toBe(true);
  });
});

describe('GET /api/memory/:path', () => {
  it('returns a specific memory entry', async () => {
    const knowledgeDir = path.join(WALNUT_HOME, 'memory', 'knowledge');
    nodeFs.mkdirSync(knowledgeDir, { recursive: true });
    nodeFs.writeFileSync(path.join(knowledgeDir, 'specific.md'), '# Specific Entry\n\nDetailed content.');

    const app = createApp();
    const res = await request(app).get('/api/memory/knowledge/specific.md');

    expect(res.status).toBe(200);
    expect(res.body.memory).toBeDefined();
    expect(res.body.memory.title).toBe('Specific Entry');
    expect(res.body.memory.content).toContain('Detailed content');
  });

  it('returns 404 for non-existent memory path', async () => {
    const app = createApp();
    const res = await request(app).get('/api/memory/nonexistent/file.md');

    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});
