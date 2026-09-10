/**
 * POST /api/notifications/fix — "Ask AI to fix" on an error notification.
 *
 * Contract under test:
 *   1. starts a real coding session in Walnut's own source (cwd = the checkout),
 *      briefed with the error, filed as `Fix: <title>` under project 'Walnut',
 *   2. records the repair on the notification (`fix`) and broadcasts
 *      `notification:updated`, so every client shows the same session,
 *   3. is idempotent — a second click reopens the same session (`reused: true`)
 *      unless `restart: true` asks for a fresh one,
 *   4. rejects what cannot be repaired (no dedupKey, unknown key, a non-error
 *      kind) and reports an unavailable source with the source's own status code.
 *
 * Also covers GET /api/config `selfRepair` (drives the button's enabled state).
 *
 * This install shape is the running checkout (WALNUT_INSTALL_DIR), so the source
 * resolves without git: nothing here can clone. The CLOUD_MODE refusal lives in
 * notification-fix-cloud.test.ts (constants are mocked per file).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-notiffix', {
  WALNUT_INSTALL_DIR: '/fake/walnut-checkout',
  WALNUT_PACKAGE_ROOT: '/fake/walnut-checkout',
}));

// Same session-spawning seam as tests/web/routes/quick-start-fix-walnut.test.ts:
// the task + SESSION_START emit are real, the CLI is not.
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
  parkMessages: async () => 0,
  parkStalePending: async () => [],
  unparkMessage: async () => false,
  sendMessageToSession: async () => {},
  getQueue: async () => [],
  revertToPending: async () => {},
}));

const { broadcastEvent } = vi.hoisted(() => ({ broadcastEvent: vi.fn() }));
vi.mock('../../../src/web/ws/handler.js', () => ({
  broadcastEvent,
  sendToClient: vi.fn(),
  sendStreamEvent: vi.fn(),
  registerMethod: vi.fn(),
  registerOwnedMethod: vi.fn(() => ({ dispose: () => {} })),
  removeOwnedMethods: vi.fn(() => 0),
  onClientDisconnect: vi.fn(() => ({ dispose: () => {} })),
  clientCount: vi.fn(() => 0),
  attachWss: vi.fn(),
  closeWss: vi.fn(),
  _getRpcMethodForTesting: vi.fn(),
}));

// Real source resolution by default (the running checkout), overridable per test
// so the unavailable path can be exercised without touching git.
const { sourceOverride } = vi.hoisted(() => ({
  sourceOverride: { ensure: null as null | ((...args: unknown[]) => unknown) },
}));
vi.mock('../../../src/core/self-repair/walnut-source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/self-repair/walnut-source.js')>();
  return {
    ...actual,
    ensureWalnutSource: (...args: unknown[]) =>
      (sourceOverride.ensure ?? (actual.ensureWalnutSource as (...a: unknown[]) => unknown))(...args),
  };
});

import express from 'express';
import request from 'supertest';
import { notificationsRouter } from '../../../src/web/routes/notifications.js';
import { configRouter } from '../../../src/web/routes/config.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { WalnutSourceError } from '../../../src/core/self-repair/walnut-source.js';
import {
  addNotification, upsertNotification, findNotification,
} from '../../../src/core/notifications/store.js';
import { getTask, listTasks, _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../../src/constants.js';

const CHECKOUT = '/fake/walnut-checkout';
const DEDUP_KEY = 'error:git:repo-size';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/config', configRouter);
  app.use(errorHandler);
  return app;
}

/** The error card the user clicks "Ask AI to fix" on. */
async function seedError() {
  await upsertNotification({
    kind: 'operation-error',
    severity: 'error',
    title: 'Data Repo Growing Too Large',
    body: 'The data repo is 3.4 GB; sync will get slow.',
    detail: '[git] {"sizeGb":3.4}',
    category: 'Data & Sync',
    recoveryKey: 'git',
    dedupKey: DEDUP_KEY,
  });
}

let started: Array<Record<string, unknown>> = [];

beforeAll(() => {
  // Belt and braces: nothing in this file should clone, and if it ever tried it
  // must not go anywhere near the real ~/open-walnut.
  process.env.WALNUT_SELF_REPAIR_CLONE_DIR = path.join(os.tmpdir(), `walnut-notiffix-never-${process.pid}`);
});

afterAll(() => {
  delete process.env.WALNUT_SELF_REPAIR_CLONE_DIR;
});

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  broadcastEvent.mockClear();
  sourceOverride.ensure = null;
  started = [];
  bus.subscribe('session-runner', (event) => {
    if (event.name === EventNames.SESSION_START) started.push(event.data as Record<string, unknown>);
  });
});

afterEach(async () => {
  bus.unsubscribe('session-runner');
  sourceOverride.ensure = null;
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

describe('POST /api/notifications/fix', () => {
  it('starts a briefed repair session in Walnut\'s own checkout', async () => {
    const app = createApp();
    await seedError();

    const res = await request(app).post('/api/notifications/fix').send({ dedupKey: DEDUP_KEY });

    expect(res.status).toBe(200);
    expect(res.body.reused).toBe(false);
    expect(res.body.cloned).toBe(false);
    expect(res.body.source).toEqual({ dir: CHECKOUT, kind: 'running' });
    expect(res.body.sessionId).toMatch(UUID_RE);
    expect(typeof res.body.startedAt).toBe('number');

    // The task: titled off the notification, filed under the real Walnut project.
    const task = await getTask(res.body.taskId);
    expect(task!.title).toBe('Fix: Data Repo Growing Too Large');
    expect(task!.project).toBe('Walnut');
    expect(task!.pinned).toBe(true);

    // The session starts IN the checkout, briefed with the error.
    expect(started).toHaveLength(1);
    expect(started[0].cwd).toBe(CHECKOUT);
    // The id in the response is the one the spawn will use, so the client can
    // open the column before the CLI exists.
    expect(started[0].preassignedSessionId).toBe(res.body.sessionId);
    expect(started[0].taskId).toBe(res.body.taskId);
    const message = started[0].message as string;
    expect(message).toContain('Data Repo Growing Too Large');
    expect(message).toContain('[git] {"sizeGb":3.4}');
    expect(message).toContain('Condition key: git');
    expect(message).toContain(`source checkout at ${CHECKOUT}`);

    // The card remembers its repair, and every client is told.
    const record = await findNotification(DEDUP_KEY);
    expect(record!.fix!.taskId).toBe(res.body.taskId);
    expect(record!.fix!.sessionId).toBe(res.body.sessionId);
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [eventName, payload] = broadcastEvent.mock.calls[0] as [string, { fix?: { taskId: string } }];
    expect(eventName).toBe('notification:updated');
    expect(payload.fix!.taskId).toBe(res.body.taskId);
  });

  it('reuses the existing repair on a second click — no duplicate session', async () => {
    const app = createApp();
    await seedError();

    const first = await request(app).post('/api/notifications/fix').send({ dedupKey: DEDUP_KEY });
    expect(first.status).toBe(200);
    broadcastEvent.mockClear();
    started = [];

    const second = await request(app).post('/api/notifications/fix').send({ dedupKey: DEDUP_KEY });

    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.taskId).toBe(first.body.taskId);
    expect(second.body.sessionId).toBe(first.body.sessionId);
    expect(started).toHaveLength(0);
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it('two overlapping clicks share one launch while the source is still being prepared', async () => {
    const app = createApp();
    await seedError();

    // Hold the source resolution open until BOTH requests are in: this is the
    // minutes-long clone window on an npm install, where `fix` is not written yet.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ensureCalls = 0;
    sourceOverride.ensure = async () => {
      ensureCalls++;
      await gate;
      return { source: { dir: CHECKOUT, kind: 'running' }, cloned: false };
    };

    const first = request(app).post('/api/notifications/fix').send({ dedupKey: DEDUP_KEY });
    const second = request(app).post('/api/notifications/fix').send({ dedupKey: DEDUP_KEY });
    // Let both reach the route before the first launch can finish.
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Exactly one task + one session; the late caller rides the first launch.
    expect(started).toHaveLength(1);
    expect(ensureCalls).toBe(1);
    expect(a.body.taskId).toBe(b.body.taskId);
    expect(a.body.sessionId).toBe(b.body.sessionId);
    expect([a.body.reused, b.body.reused].sort()).toEqual([false, true]);
  });

  it('restart: true starts a fresh session and repoints the card at it', async () => {
    const app = createApp();
    await seedError();

    const first = await request(app).post('/api/notifications/fix').send({ dedupKey: DEDUP_KEY });
    const second = await request(app).post('/api/notifications/fix').send({ dedupKey: DEDUP_KEY, restart: true });

    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(false);
    expect(second.body.taskId).not.toBe(first.body.taskId);
    expect(second.body.sessionId).not.toBe(first.body.sessionId);
    expect(started).toHaveLength(2);

    const record = await findNotification(DEDUP_KEY);
    expect(record!.fix!.taskId).toBe(second.body.taskId);
    expect(record!.fix!.sessionId).toBe(second.body.sessionId);
  });

  it('rejects a request with no dedupKey', async () => {
    const res = await request(createApp()).post('/api/notifications/fix').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('dedupKey');
    expect(started).toHaveLength(0);
  });

  it('404s an unknown dedupKey (the card was dismissed)', async () => {
    const app = createApp();
    await seedError();
    const res = await request(app).post('/api/notifications/fix').send({ dedupKey: 'error:absent' });
    expect(res.status).toBe(404);
    expect(started).toHaveLength(0);
  });

  it('refuses a notification that is not an error', async () => {
    const app = createApp();
    await addNotification({
      kind: 'cron', severity: 'info', title: 'Backup finished', dedupKey: 'cron:backup:1',
    });
    const res = await request(app).post('/api/notifications/fix').send({ dedupKey: 'cron:backup:1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('error notifications');
    expect(started).toHaveLength(0);
  });

  it('passes an unavailable source through with its own status code', async () => {
    const app = createApp();
    await seedError();
    const before = (await listTasks()).length;
    sourceOverride.ensure = () => {
      throw new WalnutSourceError('No Walnut source checkout and git is not installed', 503);
    };

    const res = await request(app).post('/api/notifications/fix').send({ dedupKey: DEDUP_KEY });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('No Walnut source checkout and git is not installed');
    // Nothing half-started: no task, no session, no pointer on the card.
    expect((await listTasks()).length).toBe(before);
    expect(started).toHaveLength(0);
    expect((await findNotification(DEDUP_KEY))!.fix).toBeUndefined();
    expect(broadcastEvent).not.toHaveBeenCalled();
  });
});

describe('GET /api/config — selfRepair', () => {
  it('reports the running checkout as the repair source', async () => {
    const res = await request(createApp()).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.selfRepair.available).toBe(true);
    expect(res.body.selfRepair.source).toEqual({ dir: CHECKOUT, kind: 'running' });
    expect(res.body.selfRepair.repoUrl).toBe('https://example.invalid/open-walnut.git');
  });
});
