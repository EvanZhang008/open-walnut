/**
 * POST /api/tasks/suggest-feedback + GET /api/tasks/suggest-accuracy.
 *
 * These two routes are how "the draft's auto-suggestions feel inaccurate" becomes a
 * number, so the claims that matter are about robustness and honesty:
 *   - a round trip records what was suggested against what was launched,
 *   - an unrecognised field NEVER fails the write (the request rides a launch the
 *     user already committed — losing telemetry is fine, disturbing a launch is not),
 *   - the routes resolve BEFORE `GET /:id`, i.e. Express doesn't read
 *     "suggest-accuracy" as a task id,
 *   - the summary is bounded by `limit` and shaped the same on an empty ledger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-test-suggest-feedback'));

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('POST /api/tasks/suggest-feedback', () => {
  it('records a commit and reports it back through the summary', async () => {
    const app = createApp();
    const post = await request(app).post('/api/tasks/suggest-feedback').send({
      surface: 'draft-session',
      textLen: 64,
      rules: 'visible-chips-v1',
      entries: [
        { field: 'project', suggested: 'Walnut', chosen: 'Fix Walnut' },
        { field: 'pinTier', suggested: 'satellite', chosen: 'satellite' },
      ],
    });
    expect(post.status).toBe(204);

    const res = await request(app).get('/api/tasks/suggest-accuracy');
    expect(res.status).toBe(200);
    expect(res.body.commits).toBe(1);
    expect(res.body.fields.project).toMatchObject({ changed: 1, kept: 0, total: 1, accuracy: 0 });
    expect(res.body.fields.pinTier).toMatchObject({ kept: 1, total: 1, accuracy: 1 });
    expect(res.body.overall).toMatchObject({ kept: 1, changed: 1, total: 2, accuracy: 0.5 });
    expect(res.body.recent[0]).toMatchObject({ surface: 'draft-session', textLen: 64 });
  });

  it('does not resolve as GET /:id — the summary route wins the path', async () => {
    // Registration order is the whole guarantee here: `/:id` sits below these two,
    // and a reorder would turn the summary into a 404 "task not found".
    const res = await request(createApp()).get('/api/tasks/suggest-accuracy');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('fields');
  });

  it('has a stable shape on an empty ledger', async () => {
    const res = await request(createApp()).get('/api/tasks/suggest-accuracy');
    expect(res.body.commits).toBe(0);
    expect(res.body.recent).toEqual([]);
    // Every field present, accuracy null (no evidence) rather than 0 (perfectly wrong).
    expect(res.body.fields.project).toMatchObject({ total: 0, accuracy: null });
    expect(res.body.overall).toMatchObject({ total: 0, accuracy: null });
  });

  it('DROPS an unrecognised field instead of failing the write', async () => {
    const app = createApp();
    const post = await request(app).post('/api/tasks/suggest-feedback').send({
      surface: 'draft-session',
      entries: [
        { field: 'somethingNew', suggested: 'x', chosen: 'y' },
        { field: 'project', suggested: 'Walnut', chosen: 'Walnut' },
      ],
    });
    expect(post.status).toBe(204);

    const res = await request(app).get('/api/tasks/suggest-accuracy');
    expect(res.body.recent[0].entries).toHaveLength(1);
    expect(res.body.recent[0].entries[0].field).toBe('project');
  });

  it('writes nothing at all when every entry is unusable', async () => {
    const app = createApp();
    const post = await request(app).post('/api/tasks/suggest-feedback').send({
      surface: 'draft-session',
      entries: [{ field: 'project', suggested: '' }, { field: 'nope', suggested: 'x' }],
    });
    expect(post.status).toBe(204);
    expect((await request(app).get('/api/tasks/suggest-accuracy')).body.commits).toBe(0);
  });

  it('rejects a missing surface and a non-array entries', async () => {
    const app = createApp();
    expect((await request(app).post('/api/tasks/suggest-feedback').send({ entries: [] })).status).toBe(400);
    expect((await request(app).post('/api/tasks/suggest-feedback')
      .send({ surface: 'draft-session', entries: 'nope' })).status).toBe(400);
  });

  it('rejects an entry list long enough to be a client bug', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({ field: 'project', suggested: `P${i}` }));
    const res = await request(createApp()).post('/api/tasks/suggest-feedback')
      .send({ surface: 'draft-session', entries });
    expect(res.status).toBe(400);
  });

  it('caps `limit` instead of returning the whole ledger', async () => {
    const app = createApp();
    for (const name of ['A', 'B', 'C']) {
      await request(app).post('/api/tasks/suggest-feedback').send({
        surface: 'draft-session',
        entries: [{ field: 'project', suggested: name, chosen: name }],
      });
    }
    const res = await request(app).get('/api/tasks/suggest-accuracy?limit=1');
    expect(res.body.recent).toHaveLength(1);
    expect(res.body.recent[0].entries[0].suggested).toBe('C');   // newest first
    // Non-numeric limits fall back to the default rather than 400ing a read-only route.
    expect((await request(app).get('/api/tasks/suggest-accuracy?limit=abc')).body.recent).toHaveLength(3);
  });
});

// C27 (server half) and C63: the visible-chips client tags every record; the
// tag is validated by shape and a bad one is dropped, never a 400.
describe('suggest-feedback rules tag', () => {
  const entries = [
    { field: 'pinTier', suggested: 'satellite', chosen: 'satellite' },
    { field: 'priority', suggested: 'immediate', chosen: 'important' },
    { field: 'dueDate', suggested: '2026-10-02', chosen: '2026-10-02' },
  ];

  it('a tagged Start answers 204 and moves the current pinTier count by one', async () => {
    const app = createApp();
    const before = (await request(app).get('/api/tasks/suggest-accuracy')).body;
    expect(before.fields.pinTier.total).toBe(0);
    const post = await request(app).post('/api/tasks/suggest-feedback')
      .send({ surface: 'draft-session', rules: 'visible-chips-v1', entries });
    expect(post.status).toBe(204);
    const after = (await request(app).get('/api/tasks/suggest-accuracy')).body;
    expect(after.fields.pinTier).toMatchObject({ kept: 1, total: before.fields.pinTier.total + 1 });
    expect(after.fields.priority).toMatchObject({ changed: 1, total: 1 });
    expect(after.fields.dueDate).toMatchObject({ kept: 1, total: 1 });
    expect(after.recent[0].rules).toBe('visible-chips-v1');
    expect(after.byRules['visible-chips-v1'].pinTier.total).toBe(1);
  });

  it('an untagged record is legacy: out of the top-level numbers, inside byRules.legacy', async () => {
    const app = createApp();
    expect((await request(app).post('/api/tasks/suggest-feedback')
      .send({ surface: 'draft-session', entries })).status).toBe(204);
    const res = (await request(app).get('/api/tasks/suggest-accuracy')).body;
    expect(res.commits).toBe(1);
    expect(res.fields.pinTier.total).toBe(0);
    expect(res.overall.total).toBe(0);
    expect(res.byRules.legacy.pinTier).toMatchObject({ kept: 1, total: 1 });
    expect(res.recent[0]).not.toHaveProperty('rules');
  });

  it.each([
    ['a number', 7],
    ['upper case', 'Visible-Chips-V1'],
    ['spaces and punctuation', 'visible chips; v1'],
    ['a prototype key', '__proto__'],
    ['an over-long slug', 'v'.repeat(41)],
    ['an empty string', ''],
  ])('drops a malformed tag (%s) and still records the commit as legacy', async (_label, rules) => {
    const app = createApp();
    const post = await request(app).post('/api/tasks/suggest-feedback')
      .send({ surface: 'draft-session', rules, entries });
    expect(post.status).toBe(204);
    const res = (await request(app).get('/api/tasks/suggest-accuracy')).body;
    expect(res.commits).toBe(1);
    expect(res.recent[0]).not.toHaveProperty('rules');
    expect(res.byRules.legacy.pinTier.total).toBe(1);
  });
});
