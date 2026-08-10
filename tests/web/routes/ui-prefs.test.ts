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
import { WALNUT_HOME, UI_PREFS_FILE } from '../../../src/constants.js';
import { uiPrefsRouter, _resetUiPrefsMigrationForTest } from '../../../src/web/routes/ui-prefs.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

const LEGACY_PREFS_FILE = path.join(WALNUT_HOME, 'ui-prefs.json');

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
  // The legacy→config/share move is memoized per process; each test starts from
  // a fresh WALNUT_HOME, so it has to be allowed to run again.
  _resetUiPrefsMigrationForTest();
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
    await fs.mkdir(path.dirname(UI_PREFS_FILE), { recursive: true });
    await fs.writeFile(UI_PREFS_FILE, JSON.stringify({ 'open-walnut-legacy': '0.4' }));
    const res = await request(createApp()).get('/api/ui-prefs');
    expect(res.body.prefs['open-walnut-legacy']).toEqual({ v: '0.4', ts: 0 });
  });
});

describe('one-time move of the root ui-prefs.json into config/share/', () => {
  it('moves the file, keeps portable keys, drops machine-specific ones', async () => {
    await fs.writeFile(LEGACY_PREFS_FILE, JSON.stringify({
      'open-walnut-theme': { v: 'dark', ts: 100 },
      // The KEY embeds this box's absolute path — meaningless on another device,
      // and the new location is synced, so it must not travel.
      'open-walnut-file-explorer-selected:local:/Users/someone/repo': { v: '/Users/someone/repo/a.md', ts: 100 },
    }));

    const res = await request(createApp()).get('/api/ui-prefs');

    expect(Object.keys(res.body.prefs)).toEqual(['open-walnut-theme']);
    expect(res.body.prefs['open-walnut-theme']).toEqual({ v: 'dark', ts: 100 });
    // New file exists; the old one is gone (a move, not a copy — a leftover
    // would keep the pre-2026-08 root path alive as a second source of truth).
    await expect(fs.access(UI_PREFS_FILE)).resolves.toBeUndefined();
    await expect(fs.access(LEGACY_PREFS_FILE)).rejects.toThrow();
  });

  it('leaves an already-migrated file alone (new location wins)', async () => {
    await fs.mkdir(path.dirname(UI_PREFS_FILE), { recursive: true });
    await fs.writeFile(UI_PREFS_FILE, JSON.stringify({ 'open-walnut-theme': { v: 'new', ts: 200 } }));
    await fs.writeFile(LEGACY_PREFS_FILE, JSON.stringify({ 'open-walnut-theme': { v: 'stale', ts: 100 } }));

    const res = await request(createApp()).get('/api/ui-prefs');

    expect(res.body.prefs['open-walnut-theme']).toEqual({ v: 'new', ts: 200 });
    // The stale root copy is left on disk untouched — deleting a file we didn't
    // migrate is not this code's business.
    await expect(fs.access(LEGACY_PREFS_FILE)).resolves.toBeUndefined();
  });

  it('moves a corrupt legacy file verbatim (migration never eats data it cannot parse)', async () => {
    await fs.writeFile(LEGACY_PREFS_FILE, '{not json');

    // The route's corrupt-file contract is UNCHANGED by the move: readJsonFile
    // throws rather than silently returning {} (which would let the next PUT
    // re-persist an empty file over the user's layout). The client's boot merge
    // already treats a failed GET as "keep local values", so this is a hiccup,
    // not a broken UI.
    await request(createApp()).get('/api/ui-prefs');

    // Unparsable content can't be key-filtered, but it still moves — leaving it
    // at the root would keep the pre-2026-08 path alive as a second location.
    await expect(fs.access(LEGACY_PREFS_FILE)).rejects.toThrow();
    expect(await fs.readFile(UI_PREFS_FILE, 'utf-8')).toBe('{not json');
  });

  it('rejects machine-specific keys on write, not just during migration', async () => {
    const app = createApp();
    await request(app).put('/api/ui-prefs').send({
      prefs: {
        'open-walnut-file-explorer-selected:local:/repo': { v: '/repo/a.md', ts: 100 },
        'open-walnut-theme': { v: 'dark', ts: 100 },
      },
    });
    const res = await request(app).get('/api/ui-prefs');
    expect(Object.keys(res.body.prefs)).toEqual(['open-walnut-theme']);
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
