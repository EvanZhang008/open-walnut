/**
 * WALNUT_SEARCH_V2=1 end-to-end through the real /api/search route: the three
 * searchInner legs must serve from the hybrid-search index while the
 * reference lane keeps running in front of it (exact-id short-circuit).
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
import { WALNUT_HOME } from '../../../src/constants.js';
import { getSearchV2Index, resetSearchV2IndexForTests } from '../../../src/core/search/wiring.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  app.use(errorHandler);
  return app;
}

let previousFlag: string | undefined;

beforeEach(async () => {
  previousFlag = process.env.WALNUT_SEARCH_V2;
  process.env.WALNUT_SEARCH_V2 = '1';
  _resetForTesting();
  resetSearchV2IndexForTests();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  if (previousFlag === undefined) delete process.env.WALNUT_SEARCH_V2;
  else process.env.WALNUT_SEARCH_V2 = previousFlag;
  resetSearchV2IndexForTests();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/search with WALNUT_SEARCH_V2=1', () => {
  it('serves task results from the v2 index, subword matching included', async () => {
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
    // NOT in the v2 index at all — an exact id must still resolve.
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
});
