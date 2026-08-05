/**
 * POST /api/v1/tasks — CLOUD_MODE (REPLICA) behavior. A cloud companion has
 * no task DB (it serves the git-synced projection), so task creation returns
 * the same 503 not_supported_cloud the session launch endpoints use. The iOS
 * app hides its create entry point when /status reports REPLICA; the 503 is
 * the server-side backstop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskcreate-cloud', { CLOUD_MODE: true }));

import express from 'express';
import request from 'supertest';
import { apiV1Router } from '../../../src/web/routes/api-v1.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiV1Router);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('task creation on a REPLICA', () => {
  it('POST /tasks → 503 not_supported_cloud', async () => {
    const res = await request(createApp())
      .post('/api/v1/tasks')
      .send({ title: 'should not land anywhere' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('not_supported_cloud');
  });

  it('the 503 gate outranks validation — no body probing on a replica', async () => {
    // Even an invalid body gets the replica answer: nothing about the task DB
    // may run in cloud mode, validation included.
    const res = await request(createApp()).post('/api/v1/tasks').send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('not_supported_cloud');
  });
});
