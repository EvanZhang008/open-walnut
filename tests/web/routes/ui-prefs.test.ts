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
import { resetRecentTouchHistoryForTest } from '../../../src/core/recent-touch-history.js';
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
  resetRecentTouchHistoryForTest();
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

  it('?key= answers that one entry, or none when it is not saved', async () => {
    await fs.mkdir(path.dirname(UI_PREFS_FILE), { recursive: true });
    await fs.writeFile(UI_PREFS_FILE, JSON.stringify({
      'walnut-todo-recent-opened': { v: '[{"id":"t1","at":"2026-11-06T19:30:00.000Z","human":true}]', ts: 5 },
      'open-walnut-theme': { v: 'dark', ts: 6 },
    }));
    const one = await request(createApp()).get('/api/ui-prefs').query({ key: 'walnut-todo-recent-opened' });
    expect(one.body.prefs['walnut-todo-recent-opened'].v).toBe('[{"id":"t1","at":"2026-11-06T19:30:00.000Z","human":true}]');
    const none = await request(createApp()).get('/api/ui-prefs').query({ key: 'walnut-todo-missing' });
    expect(none.body.prefs).toEqual({});
    // An inherited name is not a key.
    const proto = await request(createApp()).get('/api/ui-prefs').query({ key: 'constructor' });
    expect(proto.body.prefs).toEqual({});
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
    await expect(fs.access(UI_PREFS_FILE).then(() => true)).resolves.toBe(true);
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
    await expect(fs.access(LEGACY_PREFS_FILE).then(() => true)).resolves.toBe(true);
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

  it('the tasks opened lately are stored as the union of every write, stale or concurrent', async () => {
    // 2026-11-07 verifier: two devices each read the server, opened A and B, and PUT at once;
    // last-writer-wins kept only B. The key is a list every window adds to.
    const KEY = 'walnut-todo-recent-opened';
    const app = createApp();
    const list = (...e: Array<[string, string]>) => JSON.stringify(e.map(([id, at]) => ({ id, at, human: true })));
    await request(app).put('/api/ui-prefs').send({ prefs: { [KEY]: { v: list(['old', '2026-11-07T08:00:00.000Z']), ts: 100 } } });
    await Promise.all([
      request(app).put('/api/ui-prefs').send({ prefs: { [KEY]: { v: list(['A', '2026-11-07T09:00:00.000Z'], ['old', '2026-11-07T08:00:00.000Z']), ts: 300 } } }),
      request(app).put('/api/ui-prefs').send({ prefs: { [KEY]: { v: list(['B', '2026-11-07T09:00:01.000Z'], ['old', '2026-11-07T08:00:00.000Z']), ts: 200 } } }),
    ]);
    // A stale write still adds its opens; the newest open of a task wins.
    await request(app).put('/api/ui-prefs').send({ prefs: { [KEY]: { v: list(['C', '2026-11-07T07:00:00.000Z'], ['A', '2026-11-07T06:00:00.000Z']), ts: 50 } } });
    const res = await request(app).get('/api/ui-prefs');
    expect(JSON.parse(res.body.prefs[KEY].v).map((e: { id: string }) => e.id)).toEqual(['B', 'A', 'old', 'C']);
    expect(res.body.prefs[KEY].ts).toBe(300);
    // Any other key keeps last-writer-wins.
    await Promise.all([
      request(app).put('/api/ui-prefs').send({ prefs: { 'open-walnut-x': { v: '1', ts: 10 }, 'open-walnut-y': { v: 'y', ts: 10 } } }),
      request(app).put('/api/ui-prefs').send({ prefs: { 'open-walnut-x': { v: '2', ts: 20 }, 'open-walnut-z': { v: 'z', ts: 20 } } }),
    ]);
    const after = (await request(app).get('/api/ui-prefs')).body.prefs;
    expect(after['open-walnut-x'].v).toBe('2');
    // Concurrent PUTs never drop each other's keys.
    expect(after['open-walnut-y'].v).toBe('y');
    expect(after['open-walnut-z'].v).toBe('z');
  });

  it('an agent prefs write cannot insert or move any Recent row', async () => {
    const app = createApp();
    const key = 'walnut-todo-recent-opened';
    const human = JSON.stringify([{ id: 'human', at: '2026-11-07T09:00:00Z', human: true }]);
    await request(app).put('/api/ui-prefs').send({ prefs: { [key]: { v: human, ts: 100 } } });
    for (const headers of [{ 'x-walnut-caller-sid': 'agent-session' }, { 'x-walnut-caller-kind': 'automation' }]) {
      await request(app).put('/api/ui-prefs').set(headers).send({ prefs: {
        [key]: { v: JSON.stringify([{ id: 'agent-only', at: '2026-11-07T10:00:00Z' }, { id: 'human', at: '2026-11-07T11:00:00Z' }]), ts: 200 },
      } });
      expect((await request(app).get('/api/ui-prefs')).body.prefs[key].v).toBe(human);
    }
  });

  it('discards old automatic opens and a stale old browser cannot reintroduce them', async () => {
    await fs.mkdir(path.dirname(UI_PREFS_FILE), { recursive: true });
    const old = JSON.stringify([{ id: 'auto-opened', at: '2026-11-07T09:00:00Z' }]);
    await fs.writeFile(UI_PREFS_FILE, JSON.stringify({ 'walnut-todo-recent-opened': { v: old, ts: 1 } }));
    const app = createApp();
    expect(JSON.parse((await request(app).get('/api/ui-prefs')).body.prefs['walnut-todo-recent-opened'].v)).toEqual([]);
    await request(app).put('/api/ui-prefs').send({ prefs: { 'walnut-todo-recent-opened': { v: old, ts: Date.now() + 1000 } } });
    expect(JSON.parse((await request(app).get('/api/ui-prefs')).body.prefs['walnut-todo-recent-opened'].v)).toEqual([]);
  });

  it('an old paired phone can add a new human open but cannot hand back its stale list', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as typeof req & { deviceName: string }).deviceName = 'test-phone'; next(); });
    app.use('/api/ui-prefs', uiPrefsRouter);
    await request(app).get('/api/ui-prefs');
    const time = new Date(Date.now() + 100).toISOString();
    await request(app).put('/api/ui-prefs').set('User-Agent', 'Walnut/1.0 CFNetwork/1 Darwin/1').send({ prefs: { 'walnut-todo-recent-opened': {
      v: JSON.stringify([{ id: 'stale', at: '2026-11-07T09:00:00Z' }, { id: 'phone-open', at: time }]), ts: Date.now(),
    } } });
    const res = await request(app).get('/api/ui-prefs');
    expect(JSON.parse(res.body.prefs['walnut-todo-recent-opened'].v)).toEqual([{ id: 'phone-open', at: time, human: true }]);
  });

  it('a paired web browser cannot relabel automatic opens as human', async () => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as typeof req & { deviceName: string }).deviceName = 'paired-browser'; next(); });
    app.use('/api/ui-prefs', uiPrefsRouter);
    await request(app).get('/api/ui-prefs');
    await request(app).put('/api/ui-prefs').set('User-Agent', 'Mozilla/5.0 Safari/605.1.15').send({ prefs: { 'walnut-todo-recent-opened': {
      v: JSON.stringify([{ id: 'automatic', at: new Date(Date.now() + 1000).toISOString() }]), ts: Date.now(),
    } } });
    expect(JSON.parse((await request(app).get('/api/ui-prefs')).body.prefs['walnut-todo-recent-opened'].v)).toEqual([]);
  });

  it('old human messages join Recent without treating agent updates as visits', async () => {
    const dir = path.join(WALNUT_HOME, 'user-asks');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'human-task.json'), JSON.stringify({ version: 1, taskId: 'human-task', asks: [{ id: 'ua-1', at: '2026-11-07T09:00:00Z', text: 'My question', via: 'chat', state: 'closed' }] }));
    const res = await request(createApp()).get('/api/ui-prefs').query({ key: 'walnut-todo-recent-opened' });
    expect(JSON.parse(res.body.prefs['walnut-todo-recent-opened'].v)).toEqual([{ id: 'human-task', at: '2026-11-07T09:00:00Z', human: true }]);
  });

  it('a failed history migration leaves reads usable and retries recovery', async () => {
    const dir = path.join(WALNUT_HOME, 'user-asks');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'human.json'), JSON.stringify({ version: 1, taskId: 'human', asks: [{ id: 'ua-1', at: '2026-11-07T09:00:00Z', text: 'Hi', via: 'chat', state: 'open' }] }));
    const utils = await import('../../../src/utils/fs.js');
    const spy = vi.spyOn(utils, 'writeJsonFile').mockRejectedValueOnce(new Error('disk full'));
    const app = createApp();
    try {
      const first = await request(app).get('/api/ui-prefs');
      expect(first.status).toBe(200);
      const second = await request(app).get('/api/ui-prefs');
      expect(second.status).toBe(200);
      expect(JSON.parse(second.body.prefs['walnut-todo-recent-opened'].v)).toEqual([{ id: 'human', at: '2026-11-07T09:00:00Z', human: true }]);
    } finally { spy.mockRestore(); }
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

describe('the layout record (Home and Org columns) is kept on disk', () => {
  it('stores every field and reads it back from the file', async () => {
    const { LAYOUT_FIELDS, encodeField } = await import('../../../web/src/utils/layout-record.js');
    // Six locked columns with long ids: the largest strip a window keeps.
    const strip = Array.from({ length: 6 }, (_, i) => ({ id: `session-${i}-${'x'.repeat(48)}`, locked: true }));
    const prefs = Object.fromEntries(Object.values(LAYOUT_FIELDS).map((key, i) => [key, { v: encodeField(key.includes('columns') ? strip : `value-${i}`), ts: 1000 + i }]));
    const put = await request(createApp()).put('/api/ui-prefs').send({ prefs });
    expect(put.status).toBe(200);
    const onDisk = JSON.parse(await fs.readFile(UI_PREFS_FILE, 'utf8')) as Record<string, { v: string }>;
    const res = await request(createApp()).get('/api/ui-prefs');
    for (const key of Object.values(LAYOUT_FIELDS)) {
      expect(onDisk[key]?.v, key).toBe(prefs[key].v);
      expect(res.body.prefs[key], key).toEqual(prefs[key]);
    }
  });
});
