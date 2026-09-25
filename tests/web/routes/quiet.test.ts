/**
 * Quiet mode routes + mark-read by dedupKey.
 *
 *   GET /api/quiet → state; PUT { on, minutes?, allowPermissions? } holds or clears
 *   the `user` hold ONLY, so a plugin's focus hold survives the human's "off".
 *   POST /api/notifications/mark-read { dedupKeys } marks by key (what a reminder
 *   button knows), and an explicitly empty list is not mark-ALL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('quiet-route-test'));

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME } from '../../../src/constants.js';
import { quietRouter } from '../../../src/web/routes/quiet.js';
import { notificationsRouter } from '../../../src/web/routes/notifications.js';
import { addNotification, listNotifications } from '../../../src/core/notifications/store.js';
import { setQuiet, stopQuiet } from '../../../src/core/quiet/quiet-state.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/quiet', quietRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  stopQuiet();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  stopQuiet();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('/api/quiet', () => {
  it('turns the user hold on for N minutes and off again', async () => {
    const app = createApp();
    expect((await request(app).get('/api/quiet')).body).toEqual({ active: false, allowPermissions: true, holds: [] });

    const before = Date.now();
    const on = await request(app).put('/api/quiet').send({ on: true, minutes: 60, allowPermissions: false });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ active: true, allowPermissions: false });
    expect(on.body.holds[0].source).toBe('user');
    expect(on.body.holds[0].until).toBeGreaterThanOrEqual(before + 60 * 60_000);

    const off = await request(app).put('/api/quiet').send({ on: false });
    expect(off.body.active).toBe(false);
  });

  it('"off" clears only the human\'s hold', async () => {
    await setQuiet({ source: 'plugin:walnut-rhythm', reason: 'Focus block' });
    const app = createApp();
    await request(app).put('/api/quiet').send({ on: true });
    const off = await request(app).put('/api/quiet').send({ on: false });
    expect(off.body.active).toBe(true);
    expect(off.body.holds.map((h: { source: string }) => h.source)).toEqual(['plugin:walnut-rhythm']);
  });

  it('rejects a malformed body with 400', async () => {
    const app = createApp();
    expect((await request(app).put('/api/quiet').send({})).status).toBe(400);
    expect((await request(app).put('/api/quiet').send({ on: true, minutes: -5 })).status).toBe(400);
    expect((await request(app).put('/api/quiet').send({ on: true, minutes: 'soon' })).status).toBe(400);
    expect((await request(app).put('/api/quiet').send({ on: true, allowPermissions: 'yes' })).status).toBe(400);
  });
});

describe('POST /api/notifications/mark-read { dedupKeys }', () => {
  it('marks by key, and an empty key list marks nothing', async () => {
    await addNotification({ kind: 'reminder', severity: 'info', title: 'a', dedupKey: 'plugin:r:a' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'b', dedupKey: 'cron:b' });
    const app = createApp();

    const none = await request(app).post('/api/notifications/mark-read').send({ dedupKeys: [] });
    expect(none.body.unreadCount).toBe(2);

    const one = await request(app).post('/api/notifications/mark-read').send({ dedupKeys: ['plugin:r:a'] });
    expect(one.body.unreadCount).toBe(1);
    const { feed } = await listNotifications();
    expect(feed.find(n => n.dedupKey === 'cron:b')?.read).toBe(false);

    expect((await request(app).post('/api/notifications/mark-read').send({ dedupKeys: 'x' })).status).toBe(400);
  });
});
