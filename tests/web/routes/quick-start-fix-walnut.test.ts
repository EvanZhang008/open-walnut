/**
 * Fix-Walnut quick-start intent.
 *
 * POST /api/sessions/quick-start with `intent: 'fix-walnut'` must:
 *   1. wrap the user's report in the repair briefing (SESSION_START message),
 *   2. title the task "Fix Walnut: <report>" under project "Fix Walnut",
 *   3. pin the task to the launcher's Satellite baseline by default (same launch
 *      defaults as a regular quick session — NOT a hardcoded Focus override) —
 *      while still honoring an explicit client pick, including `pinTier: null`
 *      to opt out,
 *   4. reject unknown intent values with 400,
 *   5. leave plain quick-starts (no intent) untouched.
 *
 * Also covers GET /api/config `installDir` exposure (drives the UI pill).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-fixwalnut', {
  WALNUT_INSTALL_DIR: '/fake/walnut-checkout',
}));

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
import { configRouter } from '../../../src/web/routes/config.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { getTask, _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/config', configRouter);
  app.use(errorHandler);
  return app;
}

/** Capture the next SESSION_START payload emitted on the bus (subscribes as 'session-runner'). */
function captureSessionStart(): { get: () => Record<string, unknown> | null; dispose: () => void } {
  let payload: Record<string, unknown> | null = null;
  bus.subscribe('session-runner', (event) => {
    if (event.name === EventNames.SESSION_START) payload = event.data as Record<string, unknown>;
  });
  return { get: () => payload, dispose: () => bus.unsubscribe('session-runner') };
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
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

describe('POST /api/sessions/quick-start — intent=fix-walnut', () => {
  it('wraps the report in the repair briefing and titles the task', async () => {
    const app = createApp();
    const capture = captureSessionStart();
    try {
      const res = await request(app)
        .post('/api/sessions/quick-start')
        .send({
          cwd: '/fake/walnut-checkout',
          message: 'sessions panel keeps spinning',
          intent: 'fix-walnut',
        });

      expect(res.status).toBe(200);
      const task = await getTask(res.body.taskId);
      expect(task!.title).toBe('Fix Walnut: sessions panel keeps spinning');
      expect(task!.project).toBe('Fix Walnut');

      const started = capture.get();
      expect(started).not.toBeNull();
      const message = started!.message as string;
      // Briefing wraps the verbatim report and demands root-cause + verification.
      expect(message).toContain('sessions panel keeps spinning');
      expect(message).toContain('something wrong with Walnut');
      expect(message).toContain('root cause');
      expect(message).toContain('scripts/walnut-logs.sh');
    } finally {
      capture.dispose();
    }
  });

  // A taskMeta-less Fix Walnut launch (headless clients — iOS/cloud) gets the
  // SAME default tier as a regular quick session (Satellite), not a hardcoded
  // Focus override: the pill must follow the user's normal launch settings.
  // (The web client sends its sticky launcher tier explicitly.)
  it('pins the task to the Satellite baseline when the client sends no taskMeta', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/fake/walnut-checkout',
        message: 'default tier is not applied',
        intent: 'fix-walnut',
      });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task!.pinned).toBe(true);
    // Satellite is the tier-less pinned state: setFocusTier only writes
    // focus_tier for 'focus'/'wait' (splitTiers buckets everything else
    // into satellite_tasks).
    expect(task!.focus_tier).toBeUndefined();
  });

  it('honors an explicit non-focus tier instead of forcing focus', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/fake/walnut-checkout',
        message: 'park this one',
        intent: 'fix-walnut',
        taskMeta: { pinTier: 'wait' },
      });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task!.pinned).toBe(true);
    expect(task!.focus_tier).toBe('wait');
  });

  it('lets an explicit pinTier:null opt out of pinning', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/fake/walnut-checkout',
        message: 'do not pin me',
        intent: 'fix-walnut',
        taskMeta: { pinTier: null },
      });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task!.pinned).toBeFalsy();
    expect(task!.focus_tier).toBeUndefined();
  });

  it('does not pin plain quick-starts that send no taskMeta', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/plain-dir', message: 'no intent here' });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task!.pinned).toBeFalsy();
    expect(task!.focus_tier).toBeUndefined();
  });

  it('rejects unknown intent values with 400', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({ cwd: '/tmp/x', message: 'hi', intent: 'bogus' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid intent');
  });

  it('leaves plain quick-starts untouched (no wrapping, default title/project)', async () => {
    const app = createApp();
    const capture = captureSessionStart();
    try {
      const res = await request(app)
        .post('/api/sessions/quick-start')
        .send({ cwd: '/tmp/plain-dir', message: 'just do the thing' });

      expect(res.status).toBe(200);
      const task = await getTask(res.body.taskId);
      expect(task!.title).toBe('Session: plain-dir');
      expect(task!.project).toBe('Quick Start');
      expect(capture.get()!.message).toBe('just do the thing');
    } finally {
      capture.dispose();
    }
  });

  it('truncates a long report to 60 chars in the task title', async () => {
    const app = createApp();
    const longReport = 'x'.repeat(200);
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({ cwd: '/fake/walnut-checkout', message: longReport, intent: 'fix-walnut' });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task!.title).toBe(`Fix Walnut: ${'x'.repeat(60)}`);
  });
});

describe('GET /api/config — installDir', () => {
  it('exposes WALNUT_INSTALL_DIR', async () => {
    const app = createApp();
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.installDir).toBe('/fake/walnut-checkout');
  });
});
