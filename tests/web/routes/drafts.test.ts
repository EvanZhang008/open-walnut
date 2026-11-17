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
  saveDrafts, draftsSaveTiming, DraftsBusyError,
} from '../../../src/web/routes/drafts.js';
import { withFileLock } from '../../../src/utils/file-lock.js';
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

/**
 * 2026-11-16: on a loaded Mac each save held drafts.json's lock for seconds, the saves of
 * every window queued on it one by one, and one that waited past the lock's 10 s answered
 * 500 (a red card for a draft save). A save that arrives while the file is busy now folds
 * into one write, and a lock that stays busy answers 503 (try again), never a 500.
 */
describe('drafts saves while the file is busy', () => {
  const timing = { ...draftsSaveTiming, backoffMs: [...draftsSaveTiming.backoffMs] };
  afterEach(() => { Object.assign(draftsSaveTiming, timing); vi.restoreAllMocks(); });

  /** Hold drafts.json's lock as another writer would, for `ms`. */
  /** Resolves once the lock is taken; `released` resolves once the holder lets it go. */
  function holdLock(ms: number): Promise<void> & { released: Promise<unknown> } {
    let held!: () => void;
    const taken = new Promise<void>((r) => { held = r; });
    const released = withFileLock(DRAFTS_FILE(), () => { held(); return new Promise((r) => setTimeout(r, ms)); });
    return Object.assign(taken, { released });
  }

  it('forty saves that arrive while the lock is held all land, in one or two writes, none failing', async () => {
    await fs.mkdir(`${WALNUT_HOME}/local`, { recursive: true });
    const writes = vi.spyOn(fs, 'rename');
    await holdLock(1500);
    const app = createApp();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      request(app).put('/api/drafts').send({ drafts: { [`draft:k${i}`]: { v: `t${i}`, ts: i + 1 } } })));
    expect(results.map((r) => r.status)).toEqual(Array(40).fill(200));
    const disk = JSON.parse(await fs.readFile(DRAFTS_FILE(), 'utf8'));
    expect(Object.keys(disk)).toHaveLength(40);
    expect(writes.mock.calls.filter(([, to]) => to === DRAFTS_FILE()).length).toBeLessThanOrEqual(2);
  });

  it('the newer words of one key win when two saves of it fold together', async () => {
    await holdLock(300);
    await Promise.all([
      saveDrafts({ 'draft:a': { v: 'newer', ts: 20 } }),
      saveDrafts({ 'draft:a': { v: 'older', ts: 10 } }),
      saveDrafts({ 'draft:a': { v: 'oldest', ts: 5 } }),
    ]);
    expect(JSON.parse(await fs.readFile(DRAFTS_FILE(), 'utf8'))['draft:a']).toEqual({ v: 'newer', ts: 20 });
  });

  it('a save made right after another one settled is written too (a drain that just ended starts again)', async () => {
    await saveDrafts({ 'draft:first': { v: '1', ts: 1 } });
    await saveDrafts({ 'draft:second': { v: '2', ts: 2 } });
    await Promise.resolve().then(() => saveDrafts({ 'draft:third': { v: '3', ts: 3 } }));
    const disk = JSON.parse(await fs.readFile(DRAFTS_FILE(), 'utf8'));
    expect(Object.keys(disk).sort()).toEqual(['draft:first', 'draft:second', 'draft:third']);
  });

  it('a write that fails (not the lock) answers the PUTs in it, and the next save works', async () => {
    await fs.mkdir(`${WALNUT_HOME}/local`, { recursive: true });
    const real = fs.rename.bind(fs);
    let failed = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === DRAFTS_FILE() && !failed) { failed = true; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
      return real(from, to);
    });
    await expect(saveDrafts({ 'draft:a': { v: 'x', ts: 1 } })).rejects.toThrow('disk full');
    rename.mockRestore();
    await saveDrafts({ 'draft:b': { v: 'y', ts: 2 } });
    expect(JSON.parse(await fs.readFile(DRAFTS_FILE(), 'utf8'))['draft:b'].v).toBe('y');
  });

  it('a lock busy past one wait is tried again, and the words land once it frees', async () => {
    Object.assign(draftsSaveTiming, { lockWaitMs: 150, backoffMs: [50] });
    await holdLock(500);
    await saveDrafts({ 'draft:late': { v: 'kept', ts: 1 } });
    expect(JSON.parse(await fs.readFile(DRAFTS_FILE(), 'utf8'))['draft:late'].v).toBe('kept');
  });

  it('a lock busy past the deadline answers 503 with Retry-After, not 500, and the next save works', async () => {
    Object.assign(draftsSaveTiming, { lockWaitMs: 100, deadlineMs: 250, backoffMs: [50] });
    const hold = holdLock(1500);
    await hold;
    await expect(saveDrafts({ 'draft:x': { v: 'a', ts: 1 } })).rejects.toBeInstanceOf(DraftsBusyError);
    const res = await request(createApp()).put('/api/drafts').send({ drafts: { 'draft:y': { v: 'b', ts: 2 } } });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.retry).toBe(true);
    await hold.released;
    const ok = await request(createApp()).put('/api/drafts').send({ drafts: { 'draft:z': { v: 'c', ts: 3 } } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(await fs.readFile(DRAFTS_FILE(), 'utf8'))['draft:z'].v).toBe('c');
  });
});
