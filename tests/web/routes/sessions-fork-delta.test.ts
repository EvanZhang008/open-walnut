/**
 * REGRESSION: fork-ancestor transient failure must not corrupt the ?since
 * delta cursor space (2026-07-06 audit, bug-class (b): guessed/relative cursors).
 *
 * The client's cursor is minted against the COMBINED message space
 * (ancestorLen + ownLen). When the ancestor read fails transiently (SSH flap,
 * daemon reconnecting), the old code silently served `total = ownLen`:
 *   · since <= ownLen → sliced at a bogus offset (ancestor-relative cursor
 *     applied to own-only space) → wrong/duplicated messages in the delta;
 *   · since > ownLen → read as "client ahead" → full-replace with a history
 *     MISSING its fork prefix → the ancestor messages vanished from the UI.
 * Fix: delta requests fail closed with 503 (client keeps its view, retries);
 * full requests stay lenient (partial view better than none on first load).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

// Controllable per-session history source: the route reads the fork CHILD first,
// then each ancestor — we make the ancestor read throw to simulate the SSH flap.
const historyBySid = new Map<string, unknown[]>();
const failingSids = new Set<string>();
vi.mock('../../../src/core/session-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/session-history.js')>();
  return {
    ...actual,
    readSessionHistory: async (sessionId: string) => {
      if (failingSids.has(sessionId)) throw new Error('ssh: connection reset (simulated transient)');
      return historyBySid.get(sessionId) ?? [];
    },
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord } from '../../../src/core/session-tracker.js';
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
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /:sessionId/history — fork chain + ?since', () => {
  async function seedForkPair(): Promise<void> {
    await createSessionRecord('fork-src', 'task-src', 'proj');
    await createSessionRecord('fork-child', 'task-child', 'proj', undefined, {
      forkedFromSessionId: 'fork-src',
    });
    historyBySid.set('fork-src', [msg('src-1'), msg('src-2')]);
    historyBySid.set('fork-child', [msg('child-1'), msg('child-2')]);
  }

  it('healthy chain: cursor lives in the combined (ancestor+own) space', async () => {
    await seedForkPair();
    const app = createApp();

    const full = await request(app).get('/api/sessions/fork-child/history');
    expect(full.status).toBe(200);
    expect(full.body.total).toBe(4);
    expect(full.body.forkBoundaryIndex).toBe(2);

    const delta = await request(app).get('/api/sessions/fork-child/history?since=3');
    expect(delta.status).toBe(200);
    expect(delta.body.delta).toBe(true);
    expect(delta.body.messages.map((m: { text: string }) => m.text)).toEqual(['child-2']);
    expect(delta.body.cursor).toBe(4);
  });

  it('ancestor read fails + ?since → 503, NEVER a mis-sliced delta (the regression)', async () => {
    await seedForkPair();
    failingSids.add('fork-src');
    const app = createApp();

    // Client cursor 3 was minted against the combined space (2 ancestor + 2 own).
    // With the ancestor missing, total collapses to 2 — the old code treated
    // since=3 as "client ahead" and full-replaced with a fork-prefix-less
    // history, wiping the ancestor messages from the UI.
    const res = await request(app).get('/api/sessions/fork-child/history?since=3');
    expect(res.status).toBe(503);

    // Lower cursors must not silently slice the own-only space either.
    const res2 = await request(app).get('/api/sessions/fork-child/history?since=1');
    expect(res2.status).toBe(503);
  });

  it('ancestor read fails + full fetch (no since) → 200 partial view (lenient first load)', async () => {
    await seedForkPair();
    failingSids.add('fork-src');
    const app = createApp();

    const res = await request(app).get('/api/sessions/fork-child/history');
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual(['child-1', 'child-2']);
    // No boundary claim when the prefix is absent.
    expect(res.body.forkBoundaryIndex).toBeUndefined();
  });
});
