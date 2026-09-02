/**
 * End-to-end through the real /api/search route against a REAL index (no lane
 * mocks): the three searchInner legs must serve from the hybrid-search index
 * while the reference lane keeps running in front of it (exact-id
 * short-circuit).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-search-v2'));

import express from 'express';
import request from 'supertest';
import { searchRouter } from '../../../src/web/routes/search.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, _resetForTesting } from '../../../src/core/task-manager.js';
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { getSearchV2Index, resetSearchV2IndexForTests } from '../../../src/core/search/wiring.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  // Keyword-only: don't spawn a real embed worker in route tests.
  process.env.WALNUT_SEARCH_V2_SEMANTIC = '0';
  _resetForTesting();
  resetSearchV2IndexForTests();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  delete process.env.WALNUT_SEARCH_V2_SEMANTIC;
  resetSearchV2IndexForTests();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/search over the hybrid index', () => {
  it('serves task results from the index, subword matching included', async () => {
    const { task } = await addTask({ title: 'Fix AcmeEventOperator reconciler' });
    getSearchV2Index().upsert({
      kind: 'task',
      ref: task.id,
      title: task.title,
      note: 'Reconciler loops on missing CRDs.',
      updatedAt: Date.now(),
    });

    // "event operator" only matches via camelCase subwords — the exact shape
    // the old engine lost (the query that motivated the whole rebuild).
    const res = await request(createApp()).get('/api/search?q=event%20operator%20reconciler');
    expect(res.status).toBe(200);
    const hit = res.body.results.find((r: { taskId?: string }) => r.taskId === task.id);
    expect(hit).toBeDefined();
    expect(hit.type).toBe('task');
    expect(hit.snippet.length).toBeGreaterThan(0);
  });

  it('keeps the exact-reference lane in front of the index', async () => {
    const { task } = await addTask({ title: 'Reference lane stays authoritative' });
    // NOT in the index at all — an exact id must still resolve.
    const res = await request(createApp()).get(`/api/search?q=${task.id}`);
    expect(res.status).toBe(200);
    expect(res.body.results[0]?.taskId).toBe(task.id);
    expect(res.body.results[0]?.matchField).toBe('id');
  });

  it('serves memory-kind results with the file path', async () => {
    getSearchV2Index().upsert({
      kind: 'memory',
      ref: '/fake/memory/quasar-alignment.md',
      title: 'Quasar alignment notes',
      note: 'Calibration drifts weekly.',
      updatedAt: Date.now(),
    });
    const res = await request(createApp()).get('/api/search?q=quasar%20alignment');
    expect(res.status).toBe(200);
    const hit = res.body.results.find((r: { path?: string }) => r.path === '/fake/memory/quasar-alignment.md');
    expect(hit).toBeDefined();
    expect(hit.type).toBe('memory');
  });

  it('returns empty (not an error) when the index has no match', async () => {
    getSearchV2Index(); // open an empty index
    const res = await request(createApp()).get('/api/search?q=zxqv%20nonexistent');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('surfaces the owning task via a session hit when the task text misses the query', async () => {
    // Production shape (2026-08-23): the user searches with words that appear
    // ONLY in a session transcript — the owning task's title/note never say
    // them. The session leg must return the session hit CARRYING taskId so
    // the frontend can associate it back to the owning task; a task-lane
    // miss alone must not make the work item unfindable.
    _resetSessionTrackerForTesting();
    const { task } = await addTask({ title: 'Marina helper improvements' });
    const sid = 'a0a0a0a0-1111-2222-3333-444444444444';
    await createSessionRecord(sid, task.id, 'marina', '/tmp', { title: task.title });

    const index = getSearchV2Index();
    index.upsert({
      kind: 'task',
      ref: task.id,
      title: task.title,
      note: 'Refactor the helper pipeline.', // no query words here
      updatedAt: Date.now(),
    });
    index.upsert({
      kind: 'session',
      ref: sid,
      title: task.title,
      note: 'User report: the marina helper bot stops answering replies after the third turn.',
      updatedAt: Date.now(),
    });

    const res = await request(createApp())
      .get('/api/search?q=helper%20bot%20stops%20answering%20replies');
    expect(res.status).toBe(200);
    const sessionHit = res.body.results.find(
      (r: { type?: string; sessionId?: string }) => r.type === 'session' && r.sessionId === sid,
    );
    expect(sessionHit).toBeDefined();
    // The association the frontend contract depends on: session hit → owner.
    expect(sessionHit.taskId).toBe(task.id);
  });

  it('finds transcript-only work when the task title is still a placeholder', async () => {
    // Production shape (2026-08-23): a quick-start task keeps its placeholder
    // title ("Session: <dir>") with an empty note, so the TASK doc contains
    // zero query terms — every searchable word lives in the session
    // transcript. The session leg must still surface the work item (carrying
    // taskId for owner mapping), and between two sessions with identical
    // evidence the recently-active one must rank first (recency component).
    _resetSessionTrackerForTesting();
    const { task } = await addTask({ title: 'Session: marina' }); // placeholder
    const sid = 'b1b1b1b1-1111-2222-3333-444444444444';
    await createSessionRecord(sid, task.id, 'marina', '/tmp', { title: 'Session: marina' });
    const { task: oldTask } = await addTask({ title: 'Session: archive' });
    const oldSid = 'c2c2c2c2-1111-2222-3333-444444444444';
    await createSessionRecord(oldSid, oldTask.id, 'marina', '/tmp', { title: 'Session: archive' });

    const evidence = 'Turn 3: extend the file viewer to render docx xlsx pptx office document preview inline.';
    const index = getSearchV2Index();
    index.upsert({ kind: 'task', ref: task.id, title: 'Session: marina', note: '', updatedAt: Date.now() });
    index.upsert({ kind: 'session', ref: sid, title: 'Session: marina', note: evidence, updatedAt: Date.now() });
    index.upsert({
      kind: 'session', ref: oldSid, title: 'Session: archive', note: evidence,
      updatedAt: Date.now() - 300 * 24 * 3600 * 1000, // identical text, 300 days stale
    });

    const res = await request(createApp()).get('/api/search?q=docx%20xlsx%20office%20file%20preview');
    expect(res.status).toBe(200);
    const results = res.body.results as Array<{ type?: string; sessionId?: string; taskId?: string }>;
    const recent = results.find((r) => r.type === 'session' && r.sessionId === sid);
    expect(recent).toBeDefined();
    expect(recent!.taskId).toBe(task.id);
    const recentRank = results.findIndex((r) => r.sessionId === sid);
    const staleRank = results.findIndex((r) => r.sessionId === oldSid);
    expect(staleRank).toBeGreaterThan(-1);
    expect(recentRank).toBeLessThan(staleRank);
  });
});
