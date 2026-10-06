/**
 * GET /:sessionId/history?before=<ISO> — one page of history older than the oldest row
 * the client holds, for a transcript past the full read's byte ceiling.
 *
 * The reported failure (2026-10-04, a 38 MB session): "Load earlier messages" did
 * nothing, because the only read past the tail was the full read, which that file
 * can never complete, so every click re-served the same 4 MB tail. The route now
 * pages such a transcript in bounded windows; the window reader has its own tests
 * (tests/core/session-projection-paging.test.ts). Pinned here is the route contract:
 *   · a page is {messages, reachedStart} and never carries the tail-sized `windowed`
 *     payload, cursor, or `unsettled` stamps;
 *   · a fork, a journal session and an unknown session answer `unavailable`, not an
 *     error and not a wrong page;
 *   · a transcript the window reader cannot read answers `unavailable: unreadable`;
 *   · a bad `before` is a 400; a reader failure is a 502 the client retries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

type Row = { msgId: string; role: string; text: string; timestamp: string; tools?: unknown[] };
const calls: Array<{ sessionId: string; cwd?: string; host?: string; before: string; want: { minMessages: number; minText: number; isText: (m: Row) => boolean } }> = [];
let pageAnswer: { messages: Row[]; reachedStart: boolean } | null | Error = { messages: [], reachedStart: true };

vi.mock('../../../src/core/session-history-pages.js', () => ({
  readSessionHistoryBefore: async (
    sessionId: string, cwd: string | undefined, host: string | undefined, before: string,
    want: { minMessages: number; minText: number; isText: (m: Row) => boolean },
  ) => {
    calls.push({ sessionId, cwd, host, before, want });
    if (pageAnswer instanceof Error) throw pageAnswer;
    return pageAnswer;
  },
  isPastFullReadCeiling: async () => true,
}));

vi.mock('../../../src/core/sessions/session-lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/sessions/session-lifecycle.js')>();
  return {
    ...actual,
    // The full read must never be reached by a `before` request.
    readProviderSessionHistory: async () => { throw new Error('full read must not run for ?before='); },
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

function row(i: number, extra: Partial<Row> = {}): Row {
  return {
    msgId: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `message ${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    ...extra,
  };
}

const BEFORE = '2026-01-01T01:00:00.000Z';

describe('GET /:sessionId/history?before=', () => {
  beforeEach(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    calls.length = 0;
    pageAnswer = { messages: [], reachedStart: true };
  });

  afterEach(async () => {
    _resetSessionTrackerForTesting();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('serves the page oldest first with reachedStart, and no cursor or windowed flag', async () => {
    const sid = 'before-page-001';
    await createSessionRecord(sid, 'task-1', 'p');
    await updateSessionRecord(sid, { cwd: '/tmp/marina/pages' });
    pageAnswer = { messages: [row(1), row(2), row(3)], reachedStart: false };

    const res = await request(createApp()).get(`/api/sessions/${sid}/history`).query({ before: BEFORE });

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: Row) => m.msgId)).toEqual(['m1', 'm2', 'm3']);
    expect(res.body.reachedStart).toBe(false);
    expect(res.body).not.toHaveProperty('cursor');
    expect(res.body).not.toHaveProperty('windowed');
    expect(res.body).not.toHaveProperty('delta');
    expect(res.body).not.toHaveProperty('unavailable');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sessionId: sid, cwd: '/tmp/marina/pages', before: BEFORE });
    expect(calls[0].want.minMessages).toBeGreaterThanOrEqual(400);
  });

  it('never stamps a page row unsettled: the client would re-ask for ids the tail cannot answer', async () => {
    const sid = 'before-unsettled-001';
    await createSessionRecord(sid, '/tmp/marina/pages', 'p');
    const openCall = row(1, { role: 'assistant', tools: [{ toolUseId: 'tu-1', name: 'Bash' }] });
    pageAnswer = { messages: [openCall], reachedStart: true };

    const res = await request(createApp()).get(`/api/sessions/${sid}/history`).query({ before: BEFORE });

    expect(res.status).toBe(200);
    expect(res.body.messages[0]).not.toHaveProperty('unsettled');
    expect(res.body.reachedStart).toBe(true);
  });

  it('counts a page in prose: the human\'s words and the assistant\'s, not injected lines or empty rows', async () => {
    const sid = 'before-prose-001';
    await createSessionRecord(sid, '/tmp/marina/pages', 'p');
    await request(createApp()).get(`/api/sessions/${sid}/history`).query({ before: BEFORE });

    const { isText, minText } = calls[0].want;
    expect(minText).toBeGreaterThan(0);
    expect(isText(row(0, { role: 'user', text: 'please clean up' }))).toBe(true);
    expect(isText(row(1, { role: 'assistant', text: 'Done.' }))).toBe(true);
    expect(isText(row(2, { role: 'assistant', text: '   ' }))).toBe(false);
    expect(isText(row(3, { role: 'user', text: 'x', ...{ injected: true } } as Partial<Row>))).toBe(false);
  });

  it('a fork answers unavailable (its history is its ancestors plus this file), never a wrong page', async () => {
    const sid = 'before-fork-001';
    await createSessionRecord(sid, '/tmp/marina/pages', 'p');
    await updateSessionRecord(sid, { forkedFromSessionId: 'some-parent' });

    const res = await request(createApp()).get(`/api/sessions/${sid}/history`).query({ before: BEFORE });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [], reachedStart: false, unavailable: 'fork' });
    expect(calls).toHaveLength(0);
  });

  it('an unknown session answers unavailable, not a 500', async () => {
    const res = await request(createApp()).get('/api/sessions/no-such-session/history').query({ before: BEFORE });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [], reachedStart: false, unavailable: 'session-not-found' });
  });

  it('a transcript the window reader cannot read (rewound, path unresolved) answers unavailable: unreadable', async () => {
    const sid = 'before-unreadable-001';
    await createSessionRecord(sid, '/tmp/marina/pages', 'p');
    pageAnswer = null;

    const res = await request(createApp()).get(`/api/sessions/${sid}/history`).query({ before: BEFORE });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [], reachedStart: false, unavailable: 'unreadable' });
  });

  it('a reader failure is a 502 the client can retry, and the full read never runs', async () => {
    const sid = 'before-fail-001';
    await createSessionRecord(sid, '/tmp/marina/pages', 'p');
    pageAnswer = new Error('Remote read timeout (30s)');

    const res = await request(createApp()).get(`/api/sessions/${sid}/history`).query({ before: BEFORE });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/timeout/i);
  });

  it('a before that is not a timestamp is a 400 and reads nothing', async () => {
    const sid = 'before-bad-001';
    await createSessionRecord(sid, '/tmp/marina/pages', 'p');

    const res = await request(createApp()).get(`/api/sessions/${sid}/history`).query({ before: 'yesterday-ish' });

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
