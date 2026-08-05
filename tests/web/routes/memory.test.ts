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

// ── Read-only entry telemetry (memory usefulness evidence) ──

describe('GET /api/memory/telemetry', () => {
  it('reports both bounded stores with the honesty caveat when empty', async () => {
    const app = createApp();
    const res = await request(app).get('/api/memory/telemetry');

    expect(res.status).toBe(200);
    expect(res.body.stores.memory.entryCount).toBe(0);
    expect(res.body.stores.user.entryCount).toBe(0);
    // Must state that no per-entry "used" count exists — memory is injected, not retrieved.
    expect(res.body.note).toContain('injected into every turn');
  });

  it('lists entries with per-entry evidence and bootstraps records for untracked ones', async () => {
    const memDir = path.join(WALNUT_HOME, 'memory');
    nodeFs.mkdirSync(memDir, { recursive: true });
    nodeFs.writeFileSync(
      path.join(memDir, 'MEMORY.md'),
      '# MEMORY.md\n\n## Reply Concisely\n\nShort answers.\n\n## Verify Before Claiming Done\n\nRun the tests.\n',
    );

    const app = createApp();
    const res = await request(app).get('/api/memory/telemetry');

    expect(res.status).toBe(200);
    expect(res.body.stores.memory.entryCount).toBe(2);
    const titles = res.body.stores.memory.entries.map((e: { title: string }) => e.title);
    expect(titles).toEqual(['Reply Concisely', 'Verify Before Claiming Done']);
    const first = res.body.stores.memory.entries[0];
    expect(first.chars).toBeGreaterThan(0);
    // Pre-existing entries: age observed from now, never a fabricated creation date.
    expect(first.origin).toBe('pre-existing');
    expect(first.writes).toBe(0);
    expect(first.evidence).toContain('Reply Concisely');
    // Sidecar is dot-prefixed so the *.md memory index never picks it up.
    expect(nodeFs.existsSync(path.join(memDir, '.entry-telemetry.json'))).toBe(true);
  });

  it('a browser edit of MEMORY.md is recorded as human-edit provenance', async () => {
    const memDir = path.join(WALNUT_HOME, 'memory');
    nodeFs.mkdirSync(memDir, { recursive: true });
    nodeFs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# MEMORY.md\n');

    const app = createApp();
    const put = await request(app)
      .put('/api/memory/global')
      .send({ content: '# MEMORY.md\n\n## Hand Written Rule\n\nAdded by the user in the editor.\n' });
    expect(put.status).toBe(200);

    const res = await request(app).get('/api/memory/telemetry');
    const entry = res.body.stores.memory.entries.find(
      (e: { title: string }) => e.title === 'Hand Written Rule',
    );
    expect(entry.origin).toBe('human-edit');
    expect(entry.interactive_writes).toBe(1);
    expect(entry.evidence).toContain('human/');
  });

  it('a browser edit of USER.md is tracked on the user target', async () => {
    const memDir = path.join(WALNUT_HOME, 'memory');
    nodeFs.mkdirSync(memDir, { recursive: true });

    const app = createApp();
    const put = await request(app)
      .put('/api/memory/user')
      .send({ content: '# USER.md\n\n## Time Zone\n\nUser works in the Pacific time zone.\n' });
    expect(put.status).toBe(200);

    const res = await request(app).get('/api/memory/telemetry');
    expect(res.body.stores.user.entryCount).toBe(1);
    expect(res.body.stores.user.entries[0].origin).toBe('human-edit');
    expect(res.body.stores.memory.entryCount).toBe(0);
  });
});
