/**
 * A cloud replica refuses to repair: it has no source tree and no business
 * editing code. POST /api/notifications/fix answers 409 and starts nothing.
 *
 * Own file because CLOUD_MODE is a mocked constant (whole-file scope); the rest
 * of the endpoint lives in notification-fix.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-notiffix-cloud', {
  CLOUD_MODE: true,
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

import express from 'express';
import request from 'supertest';
import { notificationsRouter } from '../../../src/web/routes/notifications.js';
import { configRouter } from '../../../src/web/routes/config.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { upsertNotification, findNotification } from '../../../src/core/notifications/store.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../../src/constants.js';

const DEDUP_KEY = 'error:git:repo-size';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/config', configRouter);
  app.use(errorHandler);
  return app;
}

let started = 0;

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  started = 0;
  bus.subscribe('session-runner', (event) => {
    if (event.name === EventNames.SESSION_START) started += 1;
  });
});

afterEach(async () => {
  bus.unsubscribe('session-runner');
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('POST /api/notifications/fix in CLOUD_MODE', () => {
  it('409s and points the user at the primary console', async () => {
    const app = createApp();
    await upsertNotification({
      kind: 'operation-error',
      severity: 'error',
      title: 'Data Repo Growing Too Large',
      recoveryKey: 'git',
      dedupKey: DEDUP_KEY,
    });

    const res = await request(app).post('/api/notifications/fix').send({ dedupKey: DEDUP_KEY });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('primary console');
    expect(started).toBe(0);
    expect((await findNotification(DEDUP_KEY))!.fix).toBeUndefined();
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it('reports selfRepair unavailable on GET /api/config', async () => {
    const res = await request(createApp()).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.selfRepair.available).toBe(false);
    expect(res.body.selfRepair.reason).toBe('cloud');
  });
});
