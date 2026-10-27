/**
 * The server's copy of unsent drafts (src/web/routes/drafts.ts): last writer
 * wins per key, tombstones for sent or cleared drafts, only draft keys, and a
 * machine-local file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME } from '../../../src/constants.js';
import {
  draftsRouter, DRAFTS_FILE, mergeDrafts, mirrorServes, pruneDrafts, MAX_DRAFT_LEN, MAX_DRAFTS, TOMBSTONE_DAYS,
} from '../../../src/web/routes/drafts.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/drafts', draftsRouter);
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

describe('mirrorServes', () => {
  it('serves every request unless the server runs opt-in (the browser fixture)', () => {
    expect(mirrorServes({ headers: {} }, undefined)).toBe(true);
    expect(mirrorServes({ headers: {} }, 'opt-in')).toBe(false);
    expect(mirrorServes({ headers: { 'x-walnut-drafts-mirror': '1' } }, 'opt-in')).toBe(true);
  });
});

describe('mergeDrafts', () => {
  it('keeps the newer write of a key; a tie goes to the patch', () => {
    const stored = { 'draft:a': { v: 'old', ts: 10 }, 'draft:b': { v: 'kept', ts: 50 } };
    const out = mergeDrafts(stored, { 'draft:a': { v: 'new', ts: 20 }, 'draft:b': { v: 'stale', ts: 40 } });
    expect(out['draft:a']).toEqual({ v: 'new', ts: 20 });
    expect(out['draft:b']).toEqual({ v: 'kept', ts: 50 });
    expect(mergeDrafts(stored, { 'draft:b': { v: 'retry', ts: 50 } })['draft:b'].v).toBe('retry');
  });

  it('a sent draft becomes a tombstone, and empty text counts as sent', () => {
    const out = mergeDrafts({ 'draft:a': { v: 'x', ts: 1 } }, { 'draft:a': { v: '', ts: 2 }, 'draft:b': { v: null, ts: 3 } }, 10);
    expect(out['draft:a']).toEqual({ v: null, ts: 2 });
    expect(out['draft:b']).toEqual({ v: null, ts: 3 });
  });

  it('refuses keys outside the draft families and malformed or oversized entries', () => {
    const out = mergeDrafts({}, {
      'open-walnut-theme': { v: 'dark', ts: 1 },
      'walnut.deviceToken': { v: 'secret', ts: 1 },
      'draft:no-ts': { v: 'x' },
      'draft:num': { v: 5, ts: 1 },
      'draft:big': { v: 'x'.repeat(MAX_DRAFT_LEN + 1), ts: 1 },
      'side-thread-draft:s1': { v: 'side', ts: 1 },
      // Unicode text round-trips as written (CJK and an emoji).
      'draft:question:s1:q1': { v: '\u4f60\u597d \u{1F600}', ts: 1 },
    });
    expect(Object.keys(out).sort()).toEqual(['draft:question:s1:q1', 'side-thread-draft:s1']);
    expect(out['draft:question:s1:q1'].v).toBe('\u4f60\u597d \u{1F600}');
  });

  it('drops old tombstones, and past the cap tombstones before drafts, oldest first', () => {
    const now = 1_000_000_000_000;
    const old = now - (TOMBSTONE_DAYS + 1) * 86_400_000;
    expect(pruneDrafts({ 'draft:gone': { v: null, ts: old }, 'draft:live': { v: 'x', ts: old } }, now))
      .toEqual({ 'draft:live': { v: 'x', ts: old } });
    const many: Record<string, { v: string | null; ts: number }> = {};
    for (let i = 0; i < MAX_DRAFTS; i++) many[`draft:k${i}`] = { v: 'x', ts: now - i };
    many['draft:tomb'] = { v: null, ts: now };
    const pruned = pruneDrafts(many, now);
    expect(Object.keys(pruned)).toHaveLength(MAX_DRAFTS);
    expect(pruned['draft:tomb']).toBeUndefined();
    expect(pruned['draft:k0']).toBeDefined();
  });
});

describe('/api/drafts', () => {
  it('GET is empty at first; PUT then GET returns the merged drafts', async () => {
    const app = createApp();
    expect((await request(app).get('/api/drafts')).body).toEqual({ drafts: {} });
    const put = await request(app).put('/api/drafts').send({ drafts: { 'draft:question:s1:q1': { v: 'half a reply', ts: 5 } } });
    expect(put.status).toBe(200);
    await request(app).put('/api/drafts').send({ drafts: { 'draft:question:s1:q1': { v: 'older', ts: 4 } } });
    const got = await request(app).get('/api/drafts');
    expect(got.body.drafts).toEqual({ 'draft:question:s1:q1': { v: 'half a reply', ts: 5 } });
    // Stored machine-local, under local/ (gitignored, never synced through git).
    expect(DRAFTS_FILE()).toBe(`${WALNUT_HOME}/local/drafts.json`);
    expect(JSON.parse(await fs.readFile(DRAFTS_FILE(), 'utf8'))['draft:question:s1:q1'].v).toBe('half a reply');
  });

  it('concurrent PUTs of different keys all land', async () => {
    const app = createApp();
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      request(app).put('/api/drafts').send({ drafts: { [`draft:k${i}`]: { v: `t${i}`, ts: i + 1 } } })));
    const got = await request(app).get('/api/drafts');
    expect(Object.keys(got.body.drafts)).toHaveLength(12);
  });

  it('refuses a body without a drafts object', async () => {
    const res = await request(createApp()).put('/api/drafts').send({ prefs: {} });
    expect(res.status).toBe(400);
  });

  it('a corrupt file reads as no drafts instead of failing', async () => {
    await fs.mkdir(`${WALNUT_HOME}/local`, { recursive: true });
    await fs.writeFile(DRAFTS_FILE(), '[1,2');
    const res = await request(createApp()).get('/api/drafts');
    expect(res.status).toBe(200);
    expect(res.body.drafts).toEqual({});
    // And the next save works.
    expect((await request(createApp()).put('/api/drafts').send({ drafts: { 'draft:a': { v: 'x', ts: Date.now() } } })).status).toBe(200);
    expect((await request(createApp()).get('/api/drafts')).body.drafts['draft:a'].v).toBe('x');
  });
});
