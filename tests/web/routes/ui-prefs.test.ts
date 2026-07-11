/**
 * Tests for the UI preferences routes — server-side persistence of browser
 * layout state (collapse flags, splitter ratios, dragged heights) with
 * per-key last-writer-wins timestamps.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME } from '../../../src/constants.js';
import { uiPrefsRouter } from '../../../src/web/routes/ui-prefs.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ui-prefs', uiPrefsRouter);
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

describe('GET /api/ui-prefs', () => {
  it('returns empty prefs when none saved', async () => {
    const res = await request(createApp()).get('/api/ui-prefs');
    expect(res.status).toBe(200);
    expect(res.body.prefs).toEqual({});
  });

  it('migrates legacy plain-string entries to ts:0', async () => {
    await fs.writeFile(
      path.join(WALNUT_HOME, 'ui-prefs.json'),
      JSON.stringify({ 'open-walnut-legacy': '0.4' }),
    );
    const res = await request(createApp()).get('/api/ui-prefs');
    expect(res.body.prefs['open-walnut-legacy']).toEqual({ v: '0.4', ts: 0 });
  });
});

describe('PUT /api/ui-prefs', () => {
  it('saves and round-trips layout keys', async () => {
    const app = createApp();
    const put = await request(app).put('/api/ui-prefs').send({
      prefs: {
        'walnut-todo-collapsed-sections': { v: '["pinned","tasks"]', ts: 100 },
        'open-walnut-todo-pinned-ratio': { v: '0.55', ts: 100 },
      },
    });
    expect(put.status).toBe(200);

    const res = await request(app).get('/api/ui-prefs');
    expect(res.body.prefs['walnut-todo-collapsed-sections']).toEqual({ v: '["pinned","tasks"]', ts: 100 });
    expect(res.body.prefs['open-walnut-todo-pinned-ratio']).toEqual({ v: '0.55', ts: 100 });
  });

  it('newer write wins, stale write loses (LWW)', async () => {
    const app = createApp();
    await request(app).put('/api/ui-prefs').send({ prefs: { 'open-walnut-a': { v: 'new', ts: 200 } } });
    // Stale flush arriving late must NOT clobber the newer value.
    await request(app).put('/api/ui-prefs').send({ prefs: { 'open-walnut-a': { v: 'old', ts: 100 } } });

    const res = await request(app).get('/api/ui-prefs');
    expect(res.body.prefs['open-walnut-a']).toEqual({ v: 'new', ts: 200 });
  });

  it('null value is a delete tombstone', async () => {
    const app = createApp();
    await request(app).put('/api/ui-prefs').send({ prefs: { 'open-walnut-a': { v: '1', ts: 100 } } });
    await request(app).put('/api/ui-prefs').send({ prefs: { 'open-walnut-a': { v: null, ts: 200 } } });

    const res = await request(app).get('/api/ui-prefs');
    expect(res.body.prefs['open-walnut-a']).toEqual({ v: null, ts: 200 });
  });

  it('rejects non-layout keys (tokens, drafts, diff reviews, sync meta)', async () => {
    const app = createApp();
    await request(app).put('/api/ui-prefs').send({
      prefs: {
        'walnut.deviceToken': { v: 'secret', ts: 100 },
        'draft:session:abc': { v: 'hello', ts: 100 },
        'open-walnut-diff-review:sid': { v: '{"big":"blob"}', ts: 100 },
        'open-walnut-ui-prefs-sync-meta': { v: '{}', ts: 100 },
        'open-walnut-ok': { v: 'yes', ts: 100 },
      },
    });
    const res = await request(app).get('/api/ui-prefs');
    expect(Object.keys(res.body.prefs)).toEqual(['open-walnut-ok']);
  });

  it('400s on missing prefs object', async () => {
    const res = await request(createApp()).put('/api/ui-prefs').send({});
    expect(res.status).toBe(400);
  });

  it('ignores oversized values and malformed entries', async () => {
    const app = createApp();
    await request(app).put('/api/ui-prefs').send({
      prefs: {
        'open-walnut-huge': { v: 'x'.repeat(9000), ts: 100 },
        'open-walnut-no-ts': { v: 'x' },
        'open-walnut-fine': { v: 'ok', ts: 100 },
      },
    });
    const res = await request(app).get('/api/ui-prefs');
    expect(Object.keys(res.body.prefs)).toEqual(['open-walnut-fine']);
  });
});
