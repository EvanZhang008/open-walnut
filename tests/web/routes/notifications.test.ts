/**
 * Tests for the notification center API routes.
 * Covers GET /api/notifications (feed + unread) and POST /mark-read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME } from '../../../src/constants.js';
import { notificationsRouter } from '../../../src/web/routes/notifications.js';
import { addNotification } from '../../../src/core/notifications/store.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/notifications', () => {
  it('returns an empty feed with zero unread when none exist', async () => {
    const res = await request(createApp()).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.feed).toEqual([]);
    expect(res.body.unreadCount).toBe(0);
  });

  it('returns persisted notifications with unread count', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'Backup', dedupKey: 'cron:Backup:1' });
    await addNotification({ kind: 'permission', severity: 'warning', title: 'Bash', sessionId: 's1', dedupKey: 'perm:r1' });

    const res = await request(createApp()).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.feed).toHaveLength(2);
    expect(res.body.unreadCount).toBe(2);
  });

  it('strips entity-ref XML from legacy bodies and truncates long ones', async () => {
    // Simulates a record persisted BEFORE producers started stripping refs.
    await addNotification({
      kind: 'cron', severity: 'info', title: 'Report',
      body: 'Done: <task-ref id="mr1-0001" label="Daily Report"/> and <session-ref id="abc" label="CLI run"/>. ' + 'x'.repeat(700),
      dedupKey: 'cron:Report:1',
    });

    const res = await request(createApp()).get('/api/notifications');
    const body = res.body.feed[0].body as string;
    expect(body).not.toContain('<task-ref');
    expect(body).not.toContain('<session-ref');
    expect(body).toContain('Daily Report');
    expect(body).toContain('CLI run');
    expect(body.length).toBeLessThanOrEqual(601); // 600 + ellipsis
  });

  it('passes the permission detail + fold fields through untouched', async () => {
    await addNotification({
      kind: 'permission', severity: 'warning', title: 'Bash',
      body: 'npm run build', sessionId: 's1', taskId: 't1',
      dedupKey: 'perm:r1',
      requestId: 'r1', toolName: 'Bash', input: { command: 'npm run build' },
      reason: 'not on the allowlist',
      acpOptions: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
      host: 'devbox', sessionTitle: 'Fix the parser', project: 'walnut',
      count: 3, lastTimestamp: 1_700_000_000_000,
    });

    const res = await request(createApp()).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.feed[0]).toMatchObject({
      requestId: 'r1',
      toolName: 'Bash',
      input: { command: 'npm run build' },
      reason: 'not on the allowlist',
      acpOptions: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
      host: 'devbox',
      sessionTitle: 'Fix the parser',
      project: 'walnut',
      count: 3,
      lastTimestamp: 1_700_000_000_000,
      body: 'npm run build',
    });
  });

  it('does not truncate `input` (already compacted at write time)', async () => {
    // sanitizeBody only rewrites `body`; a 700-char plan preview must survive.
    const plan = 'p'.repeat(700);
    await addNotification({
      kind: 'permission', severity: 'warning', title: 'ExitPlanMode',
      body: 'Plan ready for review', dedupKey: 'perm:r2',
      toolName: 'ExitPlanMode', input: { plan },
    });

    const res = await request(createApp()).get('/api/notifications');
    expect((res.body.feed[0].input as { plan: string }).plan).toHaveLength(700);
  });
});

describe('POST /api/notifications/mark-read', () => {
  it('marks all read when no ids supplied', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'A', dedupKey: 'k:a' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'B', dedupKey: 'k:b' });

    const res = await request(createApp()).post('/api/notifications/mark-read').send({});
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(0);
  });

  it('marks only the supplied ids read', async () => {
    const a = await addNotification({ kind: 'cron', severity: 'info', title: 'A', dedupKey: 'k:a' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'B', dedupKey: 'k:b' });

    const res = await request(createApp()).post('/api/notifications/mark-read').send({ ids: [a.id] });
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
  });

  it('rejects a non-array ids payload', async () => {
    const res = await request(createApp()).post('/api/notifications/mark-read').send({ ids: 'nope' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/notifications/dismiss', () => {
  it('dismisses by dedupKeys', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'A', dedupKey: 'k:a' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'B', dedupKey: 'k:b' });

    const res = await request(createApp()).post('/api/notifications/dismiss').send({ dedupKeys: ['k:a'] });
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
    expect(res.body.unreadCount).toBe(1);

    const list = await request(createApp()).get('/api/notifications');
    expect(list.body.feed).toHaveLength(1);
    expect(list.body.feed[0].dedupKey).toBe('k:b');
  });

  it('clears everything with an empty payload', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'A', dedupKey: 'k:a' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'B', dedupKey: 'k:b' });

    const res = await request(createApp()).post('/api/notifications/dismiss').send({});
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(2);

    const list = await request(createApp()).get('/api/notifications');
    expect(list.body.feed).toHaveLength(0);
  });

  it('treats an explicitly empty dedupKeys array as a no-op, not clear-all', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'A', dedupKey: 'k:a' });

    const res = await request(createApp()).post('/api/notifications/dismiss').send({ dedupKeys: [] });
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(0);

    const list = await request(createApp()).get('/api/notifications');
    expect(list.body.feed).toHaveLength(1);
  });

  it('rejects a non-array dedupKeys payload', async () => {
    const res = await request(createApp()).post('/api/notifications/dismiss').send({ dedupKeys: 42 });
    expect(res.status).toBe(400);
  });
});
