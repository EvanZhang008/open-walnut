/**
 * /api/v1 session launch — CLOUD_MODE (REPLICA) behavior. A cloud companion
 * has no spawn path (the /bridge allowlist excludes `start`), so both launch
 * endpoints return a clear 503 not_supported_cloud instead of half-working.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-launch-v1-cloud', { CLOUD_MODE: true }));

import express from 'express';
import request from 'supertest';
import { sessionLaunchV1Router } from '../../../src/web/routes/session-launch-v1.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', sessionLaunchV1Router);
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

describe('session launch on a REPLICA', () => {
  it('GET /sessions/launch-options → 503 not_supported_cloud', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('not_supported_cloud');
  });

  it('POST /sessions → 503 not_supported_cloud', async () => {
    const res = await request(createApp())
      .post('/api/v1/sessions')
      .send({ cwd: '/tmp/x', message: 'hi' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('not_supported_cloud');
  });
});
