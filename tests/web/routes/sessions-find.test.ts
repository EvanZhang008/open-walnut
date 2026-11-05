/**
 * GET /:sessionId/find?q= — which rows of the WHOLE transcript hold the text, for
 * the web's Cmd+F to count and step to rows it has not loaded. Pinned here is the
 * route contract; the search itself has its own tests
 * (tests/core/sessions/session-find.test.ts):
 *   · the answer is {matches (oldest first), total, capped} plus `partial` when
 *     only part of a very long file could be read;
 *   · a windowed (very long) transcript is paged back to its start;
 *   · a missing or over-long q is a 400, an unknown session a 404, and a failed
 *     read a 502 the client retries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

type Row = { msgId: string; role: string; text: string; timestamp: string };
let full: { messages: Row[]; windowed: boolean } | Error = { messages: [], windowed: false };
let older: { messages: Row[]; reachedStart: boolean } | null = null;
const beforeCalls: string[] = [];

vi.mock('../../../src/core/session-history-pages.js', () => ({
  readSessionHistoryBefore: async (_sid: string, _cwd: string | undefined, _host: string | undefined, before: string) => {
    beforeCalls.push(before);
    return older;
  },
  isPastFullReadCeiling: async () => false,
}));

vi.mock('../../../src/core/sessions/session-lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/sessions/session-lifecycle.js')>();
  return {
    ...actual,
    readProviderSessionHistory: async () => {
      if (full instanceof Error) throw full;
      return { ...full, sourceAvailable: true };
    },
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { _resetSessionFindCacheForTests } from '../../../src/core/sessions/session-find.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

const row = (i: number, text: string): Row => ({
  msgId: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', text,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
});

describe('GET /:sessionId/find', () => {
  beforeEach(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    full = { messages: [], windowed: false };
    older = null;
    beforeCalls.length = 0;
    _resetSessionFindCacheForTests();
  });

  afterEach(async () => {
    _resetSessionTrackerForTesting();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('answers the rows holding the text, oldest first, with counts', async () => {
    const sid = 'find-001';
    await createSessionRecord(sid, 'task-1', 'p');
    full = { messages: [row(0, 'where is the otter'), row(1, 'otter, otter'), row(2, 'nothing here')], windowed: false };
    const res = await request(createApp()).get(`/api/sessions/${sid}/find`).query({ q: 'Otter' });
    expect(res.status).toBe(200);
    expect(res.body.matches.map((m: { id: string; count: number }) => [m.id, m.count])).toEqual([['m0', 1], ['m1', 2]]);
    expect(res.body.total).toBe(3);
    expect(res.body.capped).toBe(false);
    expect(res.body).not.toHaveProperty('partial');
    // case=1 matches case.
    const exact = await request(createApp()).get(`/api/sessions/${sid}/find`).query({ q: 'Otter', case: '1' });
    expect(exact.body.total).toBe(0);
  });

  it('pages a windowed transcript back to its start', async () => {
    const sid = 'find-002';
    await createSessionRecord(sid, 'task-2', 'p');
    full = { messages: [row(100, 'tail otter')], windowed: true };
    older = { messages: [row(1, 'oldest otter')], reachedStart: true };
    const res = await request(createApp()).get(`/api/sessions/${sid}/find`).query({ q: 'otter' });
    expect(res.status).toBe(200);
    expect(res.body.matches.map((m: { id: string }) => m.id)).toEqual(['m1', 'm100']);
    expect(beforeCalls).toEqual([row(100, '').timestamp]);
    expect(res.body).not.toHaveProperty('partial');
  });

  it('says partial when the older part cannot be read', async () => {
    const sid = 'find-003';
    await createSessionRecord(sid, 'task-3', 'p');
    full = { messages: [row(100, 'tail otter')], windowed: true };
    older = null;
    const res = await request(createApp()).get(`/api/sessions/${sid}/find`).query({ q: 'otter' });
    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(true);
    expect(res.body.total).toBe(1);
  });

  it('refuses a missing or over-long query, and an unknown session', async () => {
    const sid = 'find-004';
    await createSessionRecord(sid, 'task-4', 'p');
    expect((await request(createApp()).get(`/api/sessions/${sid}/find`)).status).toBe(400);
    expect((await request(createApp()).get(`/api/sessions/${sid}/find`).query({ q: 'x'.repeat(201) })).status).toBe(400);
    expect((await request(createApp()).get('/api/sessions/no-such-session/find').query({ q: 'otter' })).status).toBe(404);
  });

  it('a failed read is a 502 with the reason', async () => {
    const sid = 'find-005';
    await createSessionRecord(sid, 'task-5', 'p');
    full = new Error('ssh: connect to host gone');
    const res = await request(createApp()).get(`/api/sessions/${sid}/find`).query({ q: 'otter' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBeTruthy();
  });
});
