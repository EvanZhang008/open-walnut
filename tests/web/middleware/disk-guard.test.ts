/**
 * The disk-full write guard, with the blocked state forced on.
 *
 * The rule being pinned: a full disk must not block the ONE action that fixes a
 * full disk. `POST /api/files/delete` used to be refused with everything else,
 * so the user was told "writes are paused, free disk space on the server" by the
 * very endpoint that frees disk space. Every other file mutation stays blocked —
 * mkdir/create/rename/duplicate all consume space.
 *
 * SAFETY: no filesystem work happens here at all. The guard is mounted in front
 * of a stub handler, so a request that passes the guard reaches `204`, never a
 * real file operation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

let blocked = true;

vi.mock('../../../src/core/disk-watermark.js', () => ({
  isDiskWriteBlocked: () => blocked,
  getDiskWatermarkState: () => ({ level: 'critical', usedPct: 99 }),
}));

const { diskGuardMiddleware } = await import('../../../src/web/middleware/disk-guard.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', diskGuardMiddleware);
  // Stub terminal handler: reaching it means the guard let the request through.
  app.use('/api', (_req, res) => { res.status(204).end(); });
  return app;
}

let app: express.Express;

beforeEach(() => {
  blocked = true;
  app = createApp();
});

describe('diskGuardMiddleware while the disk is critically full', () => {
  it('lets a delete through — deleting is how a full disk gets fixed', async () => {
    const res = await request(app).post('/api/files/delete').send({ path: '/a/b/c.txt' });
    expect(res.status).toBe(204);
  });

  it('still refuses the file mutations that CONSUME space', async () => {
    for (const op of ['mkdir', 'create', 'rename', 'duplicate']) {
      const res = await request(app).post(`/api/files/${op}`).send({ path: '/a/b/c.txt' });
      expect(res.status, op).toBe(507);
      expect(res.body.code, op).toBe('disk_full');
    }
  });

  it('keeps refusing an ordinary mutating route, and keeps the carve-outs open', async () => {
    expect((await request(app).post('/api/tasks').send({})).status).toBe(507);
    expect((await request(app).post('/api/browser-logs').send({})).status).toBe(204);
    expect((await request(app).post('/api/notifications/1/read').send({})).status).toBe(204);
  });

  it('never blocks a read', async () => {
    expect((await request(app).get('/api/tasks')).status).toBe(204);
  });

  it('blocks nothing once the watermark recovers', async () => {
    blocked = false;
    expect((await request(app).post('/api/files/mkdir').send({ path: '/a/b' })).status).toBe(204);
  });
});
