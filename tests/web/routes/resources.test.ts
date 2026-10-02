/**
 * /api/resources: the hydrate + fresh read behind the Machine readout. The
 * sampler is faked at the module boundary; the contract pinned here is that a
 * plain GET never samples (the live frames arrive over the WS), only `watch`
 * marks the readout watched, every read carries the per-host deadline, one host
 * can be asked for, history is opt-in, and a server without a sampler (replica,
 * vitest) answers 204 instead of hanging.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const sampler = {
  markWatched: vi.fn(),
  watching: vi.fn(() => false),
  read: vi.fn(async (host: string, opts: Record<string, unknown>) => ({ host, at: 1, ok: true, processCount: 1, sessions: [], totals: { sessions: 0, rssBytes: 0, cpuPct: null }, opts })),
  readAll: vi.fn(async (opts: Record<string, unknown>) => [{ host: '__local__', at: 1, ok: true, processCount: 1, sessions: [], totals: { sessions: 0, rssBytes: 0, cpuPct: null }, opts }]),
};
let installed: typeof sampler | null = sampler;
vi.mock('../../../src/core/sessions/session-resources.js', () => ({
  getSessionResourceSampler: () => installed,
  READ_DEADLINE_MS: 2_500,
}));

import { resourcesRouter } from '../../../src/web/routes/resources.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use('/api/resources', resourcesRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  installed = sampler;
  sampler.markWatched.mockClear();
  sampler.read.mockClear();
  sampler.readAll.mockClear();
  sampler.watching.mockReturnValue(false);
});

describe('GET /api/resources', () => {
  it('a plain read hands back the last frames and never marks the readout watched', async () => {
    const res = await request(createApp()).get('/api/resources');
    expect(res.status).toBe(200);
    expect(res.body.hosts).toHaveLength(1);
    expect(res.body.watching).toBe(false);
    expect(sampler.readAll).toHaveBeenCalledWith({ fresh: false, history: false, deadlineMs: 2_500 });
    expect(sampler.markWatched).not.toHaveBeenCalled();
  });

  it('fresh=1 samples now without speeding anything up; watch=1 is what marks the readout watched', async () => {
    const res = await request(createApp()).get('/api/resources?fresh=1&history=true');
    expect(res.status).toBe(200);
    expect(sampler.markWatched).not.toHaveBeenCalled();
    expect(sampler.readAll).toHaveBeenCalledWith({ fresh: true, history: true, deadlineMs: 2_500 });
    sampler.watching.mockReturnValue(true);
    const watched = await request(createApp()).get('/api/resources?fresh=1&history=1&watch=1');
    expect(watched.body.watching).toBe(true);
    expect(sampler.markWatched).toHaveBeenCalledTimes(1);
  });

  it('host= asks for that one host', async () => {
    const res = await request(createApp()).get('/api/resources?host=clouddev&fresh=1');
    expect(res.status).toBe(200);
    expect(res.body.hosts.map((h: { host: string }) => h.host)).toEqual(['clouddev']);
    expect(sampler.read).toHaveBeenCalledWith('clouddev', { fresh: true, history: false, deadlineMs: 2_500 });
    expect(sampler.readAll).not.toHaveBeenCalled();
  });

  it('no sampler (a replica, vitest, WALNUT_SESSION_RESOURCES=0) answers 204, not an error and not a hang', async () => {
    installed = null;
    const res = await request(createApp()).get('/api/resources?fresh=1');
    expect(res.status).toBe(204);
  });

  it('a sampler failure is a 500 through the error handler, not an unhandled rejection', async () => {
    sampler.readAll.mockRejectedValueOnce(new Error('boom'));
    const res = await request(createApp()).get('/api/resources');
    expect(res.status).toBe(500);
  });
});
