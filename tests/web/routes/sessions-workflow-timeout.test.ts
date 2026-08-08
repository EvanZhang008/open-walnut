/**
 * Route-level deadline for GET /api/sessions/:id/workflow.
 *
 * The reconstruct path rides the daemon connection for remote sessions; a
 * wedged daemon held this request for minutes (382s measured), pinning one of
 * the browser's 6 per-origin connections and starving every other API call.
 * The route must answer 204 within its deadline instead of hanging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());
vi.mock('../../../src/core/session-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/session-history.js')>();
  return {
    ...actual,
    // Simulate a wedged daemon: the manifest read never resolves.
    reconstructWorkflowProgress: () => new Promise(() => {}),
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';

const SID = 'wf-timeout-sid';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('GET /api/sessions/:id/workflow — deadline', () => {
  it('answers 204 when the manifest read hangs (wedged daemon)', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', '/Users/test/wf-timeout');

    const started = Date.now();
    const res = await request(createApp()).get(`/api/sessions/${SID}/workflow`);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(204);
    // Deadline is 5s; allow slack for CI load but prove it didn't hang.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
});
