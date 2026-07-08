/**
 * REGRESSION: SSH-down window must degrade to cached history, not a blank
 * "Failed to load history" screen (inc-1783406628291).
 *
 * Incident chain: fd leak → every ssh spawn fails EBADF → daemon reconnect
 * stuck → remote JSONL read times out (30s) → the history route 502'd → the
 * UI showed an error over hours-old streaming blocks.
 *
 * Contract pinned here:
 *   · full fetch + read failure + cache available → 200 { stale: true,
 *     staleReason } serving the last-good parse;
 *   · full fetch + read failure + NO cache → 502 (unchanged — nothing to serve);
 *   · ?since= delta + read failure → 502 even WITH cache (a stale total would
 *     corrupt the client's delta cursor).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

// Controllable history source: per-sid messages, per-sid failure, per-sid cache.
const historyBySid = new Map<string, unknown[]>();
const failingSids = new Set<string>();
const cacheBySid = new Map<string, unknown[]>();
vi.mock('../../../src/core/session-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/session-history.js')>();
  return {
    ...actual,
    readSessionHistory: async (sessionId: string) => {
      if (failingSids.has(sessionId)) throw new Error('Remote read failed (clouddev): Session file read timeout (30s)');
      return historyBySid.get(sessionId) ?? [];
    },
    getCachedSessionHistory: (sessionId: string) => cacheBySid.get(sessionId),
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

function msg(text: string): unknown {
  return { role: 'assistant', text };
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  historyBySid.clear();
  failingSids.clear();
  cacheBySid.clear();
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

async function seedRemoteSession(sid: string): Promise<void> {
  await createSessionRecord(sid, `task-${sid}`, 'proj');
  await updateSessionRecord(sid, { host: 'clouddev' } as never);
}

describe('GET /:sessionId/history — degraded mode on live-read failure', () => {
  it('read failure + cache → 200 stale payload (the incident fix)', async () => {
    await seedRemoteSession('sid-stale');
    failingSids.add('sid-stale');
    cacheBySid.set('sid-stale', [msg('cached-1'), msg('cached-2')]);
    const app = createApp();

    const res = await request(app).get('/api/sessions/sid-stale/history');
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.staleReason).toContain('timeout');
    expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual(['cached-1', 'cached-2']);
  });

  it('read failure + NO cache → 502 (unchanged)', async () => {
    await seedRemoteSession('sid-nocache');
    failingSids.add('sid-nocache');
    const app = createApp();

    const res = await request(app).get('/api/sessions/sid-nocache/history');
    expect(res.status).toBe(502);
  });

  it('read failure + ?since delta → 502 even with cache (never corrupt the cursor)', async () => {
    await seedRemoteSession('sid-delta');
    failingSids.add('sid-delta');
    cacheBySid.set('sid-delta', [msg('cached-1')]);
    const app = createApp();

    const res = await request(app).get('/api/sessions/sid-delta/history?since=1');
    expect(res.status).toBe(502);
    expect(res.body.stale).toBeUndefined();
  });

  it('healthy read never reports stale', async () => {
    await seedRemoteSession('sid-ok');
    historyBySid.set('sid-ok', [msg('live-1')]);
    cacheBySid.set('sid-ok', [msg('old-cached')]); // cache present but must not be used
    const app = createApp();

    const res = await request(app).get('/api/sessions/sid-ok/history');
    expect(res.status).toBe(200);
    expect(res.body.stale).toBeUndefined();
    expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual(['live-1']);
  });
});
