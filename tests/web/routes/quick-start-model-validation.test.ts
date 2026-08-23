/**
 * POST /api/sessions/quick-start — model normalization.
 *
 * The spawn route shares the switch validator with POST /:id/model:
 *  - legacy picker alias ('opus-1m') → CLI mapping ('opus[1m]')
 *  - catalog value (full provider ID from the host-catalog dropdown) → verbatim
 *  - ''/'default'/absent → Auto (no --model)
 *  - garbage → explicit 400 (the old allowlist silently downgraded to Auto,
 *    which read as "my model choice was ignored")
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
}));
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: () => {},
  getDaemonConnection: async () => ({ send: async () => ({ ok: true }) }),
}));
vi.mock('../../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}));
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: null,
}));
vi.mock('../../../src/core/session-message-queue.js', () => ({
  parkMessages: async () => 0,
  parkStalePending: async () => [],
  unparkMessage: async () => false,
  sendMessageToSession: async () => {},
  getQueue: async () => [],
  revertToPending: async () => {},
}));

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import type { BusEvent } from '../../../src/core/event-bus.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

let starts: BusEvent[];

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  bus.clear();
  starts = [];
  bus.subscribe('session-runner', (e) => { if (e.name === EventNames.SESSION_START) starts.push(e); });
});

afterEach(async () => {
  bus.clear();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

const CWD = '/tmp';

describe('POST /api/sessions/quick-start — model validation', () => {
  it('legacy alias maps to its CLI form (opus-1m → opus[1m])', async () => {
    const res = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: CWD, message: 'go', model: 'opus-1m' });
    expect(res.status).toBe(200);
    expect(starts).toHaveLength(1);
    expect((starts[0]!.data as { model?: string }).model).toBe('opus[1m]');
  });

  it('catalog value (full provider ID) passes verbatim to SESSION_START', async () => {
    const id = 'global.anthropic.claude-fable-5[1m]';
    const res = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: CWD, message: 'go', model: id });
    expect(res.status).toBe(200);
    expect((starts[0]!.data as { model?: string }).model).toBe(id);
  });

  it("''/default/absent all mean Auto (no model on the event)", async () => {
    for (const model of ['', 'default', undefined]) {
      starts.length = 0;
      const res = await request(createApp()).post('/api/sessions/quick-start')
        .send({ cwd: CWD, message: 'go', ...(model !== undefined ? { model } : {}) });
      expect(res.status).toBe(200);
      expect((starts[0]!.data as { model?: string }).model).toBeUndefined();
    }
  });

  it('garbage model → explicit 400, NOT a silent Auto downgrade', async () => {
    const res = await request(createApp()).post('/api/sessions/quick-start')
      .send({ cwd: CWD, message: 'go', model: 'not a model; rm -rf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid model');
    expect(starts).toHaveLength(0); // no session started on a rejected model
  });
});
