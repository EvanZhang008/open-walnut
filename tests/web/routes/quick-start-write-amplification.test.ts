/**
 * Quick-start must not rewrite the whole task table.
 *
 * The felt bug: "starting a session takes seconds before anything appears". Half
 * of that was NOT the Claude CLI — it was Walnut's own SQLite write path.
 * task-manager's helpers are all read-whole-store → mutate → writeStore(), and
 * writeStore used to `INSERT OR REPLACE` EVERY task row on any edit. One
 * quick-start runs ~5 of those helpers (addTask → updateTask → [togglePin →
 * setFocusTier] → linkSession), so with a real store (~4k tasks) the click cost
 * seconds of pure row churn before SESSION_START was even emitted.
 *
 * This test pins the fix as a COMPLEXITY contract, not a timing one (timings are
 * flaky on shared CI): with N pre-existing tasks, a quick-start must write a
 * number of rows that does NOT scale with N. It asserts on rows actually written,
 * counted via SQLite's `total_changes`, so a regression to the full-rewrite
 * behavior fails loudly regardless of machine speed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-qs-write-amp'));

vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
}));
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: () => {},
}));
vi.mock('../../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}));
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: null,
}));
vi.mock('../../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: async () => {},
  getQueue: async () => [],
  revertToPending: async () => {},
}));

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, listTasks, _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { getDb } from '../../../src/core/task-db.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

/** Rows written so far on our connection (INSERT/UPDATE/DELETE counted by SQLite). */
function totalChanges(): number {
  const db = getDb()!;
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}

/** Seed `n` filler tasks, then measure the row-writes caused by one quick-start. */
async function rowWritesForQuickStart(n: number): Promise<number> {
  for (let i = 0; i < n; i++) {
    await addTask({ title: `filler ${i}`, category: 'Local', source: 'local' });
  }
  // Warm the whole-store read cache and seed the row shadow so we measure the
  // steady state, not first-write seeding.
  await listTasks();

  const before = totalChanges();
  const res = await request(createApp())
    .post('/api/sessions/quick-start')
    .send({ cwd: '/tmp', message: 'hello' });
  expect(res.status).toBe(200);
  return totalChanges() - before;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
});

afterEach(async () => {
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('POST /api/sessions/quick-start — write amplification', () => {
  it('writes a bounded number of rows regardless of how many tasks exist', async () => {
    const small = await rowWritesForQuickStart(10);
    // Fresh store for the second sample so the two runs are independent.
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    resetTaskManager();
    const large = await rowWritesForQuickStart(120);

    // Full-rewrite behavior would make `large - small` ≈ 110 per writeStore call
    // (×~4 calls ≈ 440+). A bounded write path keeps the delta near zero; allow
    // generous headroom for the category/group snapshot tables, which are small
    // and legitimately rewritten per commit.
    expect(large - small).toBeLessThan(60);

    // Sanity: the quick-start really did write something (guards against a
    // no-op/short-circuit making this pass vacuously).
    expect(small).toBeGreaterThan(0);
  });
});
