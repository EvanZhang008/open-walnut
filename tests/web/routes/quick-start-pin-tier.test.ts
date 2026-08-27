/**
 * Repro test 1 — quick-start `taskMeta.pinTier` focus path.
 *
 * Verifies that POST /api/sessions/quick-start with `taskMeta.pinTier: 'focus'`:
 *   1. pins the freshly-created task (togglePin runs first), and
 *   2. sets its focus_tier to 'focus' (setFocusTier runs second).
 *
 * The route deliberately sequences togglePin() BEFORE setFocusTier() because
 * setFocusTier throws if the task isn't pinned (see sessions.ts:478-488). This
 * test locks in that contract for the 'focus' tier specifically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

// Mock process liveness to avoid real PID checks
vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
}));

// Mock daemon-connection (used by enrichWithLiveStatus + quick-start host clear)
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: () => {},
}));

// Mock session-manager (used by restart to kill process)
vi.mock('../../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}));

// Mock claude-code-session (the sessionRunner import at module level)
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: null,
}));

// Mock session-message-queue (used by retry/restart to inspect & resend the queue)
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
import { getTask, _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
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

describe('POST /api/sessions/quick-start — taskMeta.pinTier=focus', () => {
  it('pins the new task and sets focus_tier to "focus"', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test-focus',
        message: 'Build the focus feature',
        taskMeta: { pinTier: 'focus' },
      });

    expect(res.status).toBe(200);
    expect(res.body.taskId).toBeTruthy();

    const task = await getTask(res.body.taskId);
    expect(task).not.toBeNull();
    expect(task!.pinned).toBe(true);
    expect(task!.focus_tier).toBe('focus');
  });

  it('leaves the task in Inbox (no project supplied)', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test-focus-2',
        message: 'Another focus task',
        taskMeta: { pinTier: 'focus' },
      });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    // The hardcoded `Local / 'Quick Start'` staging group is gone: an unfiled
    // quick-start lands in Inbox and the auto-organize pass (disabled in tests)
    // is what may later file it under a real project.
    expect(task!.project).toBe('');
    expect(task!.pinned).toBe(true);
    expect(task!.focus_tier).toBe('focus');
  });

  it('accepts the built-in backlog tier', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test-backlog',
        message: 'Someday task',
        taskMeta: { pinTier: 'backlog' },
      });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task!.pinned).toBe(true);
    expect(task!.focus_tier).toBe('backlog');
  });

  it('rejects an invalid pinTier value with 400', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test-focus-3',
        message: 'Bad tier',
        taskMeta: { pinTier: 'bogus' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid taskMeta.pinTier');
  });

  it('accepts a STALE ct_* pinTier and self-heals it to Satellite', async () => {
    // The launcher remembers the last tier in localStorage (mirrored across
    // browsers by ui-prefs-sync). After the user deletes that tier in Settings,
    // launches must NOT 400 forever — the unregistered ct_* id passes through
    // and setFocusTier self-heals it to the default bucket (focus_tier unset).
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test-focus-stale',
        message: 'Launch with a deleted tier remembered',
        taskMeta: { pinTier: 'ct_deadbeef' },
      });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task!.pinned).toBe(true);
    expect(task!.focus_tier).toBeUndefined();
  });

  it('pins into Satellite when no pinTier is supplied', async () => {
    // Board default (2026-08-26): a launch with no client opinion still lands on
    // the pinned board, in Satellite — which is stored as NO focus_tier.
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test-focus-4',
        message: 'No tier task',
      });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task!.pinned).toBe(true);
    expect(task!.focus_tier).toBeUndefined();
  });

  it('leaves the task unpinned when the client sends pinTier: null', async () => {
    // The launcher's unpin gesture: an explicit null must still win over the
    // board default.
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test-focus-5',
        message: 'Deliberately off the board',
        taskMeta: { pinTier: null },
      });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task!.pinned).toBeFalsy();
    expect(task!.focus_tier).toBeUndefined();
  });
});
