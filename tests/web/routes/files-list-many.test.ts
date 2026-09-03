/**
 * POST /api/files/list-many — the tree restore in one request, through the real
 * HTTP edge.
 *
 * The bug it exists for: opening a session's Files panel reopens every directory
 * the user had expanded, and the explorer fetched each one separately (up to 64).
 * A browser runs 6 connections per origin, so on a remote session — one SSH round
 * trip per listing, ~1.4s cold — the restore held the entire pool and every other
 * request in the app queued behind it. That is what "opening Files makes Walnut
 * slow" was: not a slow listing, a fan-out.
 *
 * So the contract here is about the failure modes of a batch, all of which turn a
 * batch into a worse version of the loop it replaced:
 *  - one unreadable directory must not fail the other 63,
 *  - duplicates must not eat the cap,
 *  - the cap must hold and SAY it held (truncated), so the client can tell a
 *    complete answer from a clipped one,
 *  - the guards must be the same code as the single-directory route, since a
 *    second validation path is how a traversal check gets skipped in one place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';

const { filesRouter } = await import('../../../src/web/routes/files.js');
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/files', filesRouter);
  app.use(errorHandler);
  return app;
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-list-many-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('POST /api/files/list-many', () => {
  it('answers every requested directory in one response', async () => {
    for (const d of ['a', 'b', 'c']) {
      await fs.mkdir(path.join(tmp, d), { recursive: true });
      await fs.writeFile(path.join(tmp, d, `${d}.txt`), 'x\n');
    }
    const paths = ['a', 'b', 'c'].map((d) => path.join(tmp, d));
    const res = await request(createApp()).post('/api/files/list-many').send({ paths });
    expect(res.status).toBe(200);
    expect(res.body.listings).toHaveLength(3);
    expect(res.body.truncated).toBe(false);
    for (const p of paths) {
      const hit = res.body.listings.find((l: { path: string }) => l.path === p);
      expect(hit, `${p} must be in the batch`).toBeTruthy();
      expect(hit.entries.map((e: { name: string }) => e.name)).toEqual([path.basename(p) + '.txt']);
    }
  });

  it('keeps the good directories when one cannot be read', async () => {
    await fs.mkdir(path.join(tmp, 'real'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'real', 'f.txt'), 'x\n');
    const res = await request(createApp()).post('/api/files/list-many')
      .send({ paths: [path.join(tmp, 'real'), path.join(tmp, 'gone-for-good')] });
    expect(res.status).toBe(200);
    const byPath = new Map(res.body.listings.map((l: { path: string }) => [l.path, l]));
    expect((byPath.get(path.join(tmp, 'real')) as { entries: unknown[] }).entries).toHaveLength(1);
    // The dead one reports why, in the same shape, so the tree can leave that
    // node closed instead of dropping the whole restore.
    expect((byPath.get(path.join(tmp, 'gone-for-good')) as { error?: string }).error).toBeTruthy();
  });

  it('de-duplicates before capping, and reports a clipped batch', async () => {
    const dirs: string[] = [];
    for (let i = 0; i < 70; i++) {
      const d = path.join(tmp, `d${i}`);
      await fs.mkdir(d, { recursive: true });
      dirs.push(d);
    }
    // 70 real directories, and the first one repeated 20 times: a naive cap would
    // spend 20 of its 64 slots on one directory and silently lose 20 real ones.
    const withDupes = [...Array(20).fill(dirs[0]), ...dirs];
    const res = await request(createApp()).post('/api/files/list-many').send({ paths: withDupes });
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.listings).toHaveLength(64);
    const unique = new Set(res.body.listings.map((l: { path: string }) => l.path));
    expect(unique.size, 'no directory is listed twice').toBe(64);
  });

  it('applies the same path guards as the single-directory route', async () => {
    const app = createApp();
    // Relative and traversal paths are refused by listSessionFiles itself, which
    // is the point of sharing it: the batch cannot be the lax door.
    const res = await request(app).post('/api/files/list-many')
      .send({ paths: ['not/absolute', `${tmp}/../../etc`] });
    expect(res.status).toBe(200);
    for (const l of res.body.listings) expect(l.error, `${l.path} must be refused`).toBeTruthy();

    // A malformed body is a 400, not a 500 and not an empty success.
    expect((await request(app).post('/api/files/list-many').send({})).status).toBe(400);
    expect((await request(app).post('/api/files/list-many').send({ paths: 'a' })).status).toBe(400);
    // Nothing to do is a valid, empty answer.
    const empty = await request(app).post('/api/files/list-many').send({ paths: [] });
    expect(empty.status).toBe(200);
    expect(empty.body.listings).toEqual([]);
  });
});
