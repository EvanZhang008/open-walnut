import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { searchRouter } from '../../../src/web/routes/search.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, _resetForTesting } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  app.use(errorHandler);
  return app;
}

// These cases assert the LEXICAL (BM25-over-tasks.sqlite) path. The old
// `?mode=keyword` query param that used to select it was removed with the
// embedding search modes; the remaining switch is WALNUT_DISABLE_SEARCH=1.
// Without it, search() delegates tasks to QMD, and QMD has no task index here
// (qmd-task-sync is a server.ts bus subscriber, not part of this router) — so
// every query legitimately returned an empty set.
let previousDisableSearch: string | undefined;

beforeEach(async () => {
  previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH;
  process.env.WALNUT_DISABLE_SEARCH = '1';
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  if (previousDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH;
  else process.env.WALNUT_DISABLE_SEARCH = previousDisableSearch;
  _resetForTesting();
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
    const res = await request(app).get('/api/search?q=authentication');

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(res.body.results[0].title).toBe('Fix authentication bug');
    expect(res.body.results[0].type).toBe('task');
  });

  it('filters by types parameter', async () => {
    await addTask({ title: 'Searchable task' });

    const app = createApp();
    const res = await request(app).get('/api/search?q=searchable&types=task');

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(res.body.results.every((r: { type: string }) => r.type === 'task')).toBe(true);
  });

  it('accepts type (singular) as an alias of types', async () => {
    await addTask({ title: 'Searchable task' });

    const app = createApp();
    const res = await request(app).get('/api/search?q=searchable&type=task');

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(res.body.results.every((r: { type: string }) => r.type === 'task')).toBe(true);
  });

  it('rejects invalid type values through the alias too', async () => {
    const app = createApp();
    const res = await request(app).get('/api/search?q=x&type=bogus');
    expect(res.status).toBe(400);
  });

  it('respects limit parameter', async () => {
    await addTask({ title: 'Match one' });
    await addTask({ title: 'Match two' });
    await addTask({ title: 'Match three' });

    const app = createApp();
    const res = await request(app).get('/api/search?q=match&limit=2');

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeLessThanOrEqual(2);
  });
});

describe('GET /api/search?slim=1', () => {
  it('task rows carry type/id/title/summary/phase/project/ref and nothing bulky', async () => {
    const { task } = await addTask({
      title: 'Fix authentication bug',
      project: 'walnut',
      description: 'A very long description that should be compacted. '.repeat(20),
    });

    const app = createApp();
    const res = await request(app).get('/api/search?q=authentication&slim=1');

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: { id: string }) => r.id === task.id);
    expect(row).toBeDefined();
    expect(row.type).toBe('task');
    expect(row.title).toBe('Fix authentication bug');
    expect(row.phase).toBe(task.phase);
    expect(row.project).toBe('walnut');
    expect(row.ref).toBe(`<task-ref id="${task.id}" label="Fix authentication bug"/>`);
    // one-line summary, hard-bounded
    expect(typeof row.summary).toBe('string');
    expect(row.summary.length).toBeLessThanOrEqual(121); // 120 + ellipsis
    expect(row.summary).not.toContain('\n');
    // bulky/internal fields must not leak into slim rows
    expect(row.snippet).toBeUndefined();
    expect(row.score).toBeUndefined();
    expect(row.matchField).toBeUndefined();
  });

  it('slim=1 output is small enough to never need truncation', async () => {
    for (let i = 0; i < 10; i++) {
      await addTask({
        title: `Bulk match ${i}`,
        description: 'Long body content for search snippets. '.repeat(100),
      });
    }

    const app = createApp();
    const res = await request(app).get('/api/search?q=bulk&slim=1');

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    // Whole payload stays compact (the verbose default was 3KB+ per row)
    expect(JSON.stringify(res.body).length).toBeLessThan(400 * res.body.results.length + 100);
  });

  it('default (no slim) keeps the verbose shape', async () => {
    await addTask({ title: 'Verbose row' });

    const app = createApp();
    const res = await request(app).get('/api/search?q=verbose');

    expect(res.status).toBe(200);
    expect(res.body.results[0].snippet).toBeDefined();
    expect(res.body.results[0].score).toBeDefined();
  });
});
