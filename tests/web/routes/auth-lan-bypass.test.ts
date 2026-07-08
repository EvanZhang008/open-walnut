/**
 * Non-cloud (trusted LAN) auth behavior — must stay 100% unchanged by the
 * cloud-mode device-token work. Default constants mock → CLOUD_MODE: false.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../../src/web/middleware/auth.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', authMiddleware);
  app.get('/api/ping', (_req, res) => { res.json({ ok: true }); });
  return app;
}

describe('authMiddleware in non-cloud mode (LAN bypass intact)', () => {
  it('allows unauthenticated localhost requests (existing behavior)', async () => {
    const app = createApp();
    // supertest connects from 127.0.0.1 → private-network bypass applies.
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('still requires a Bearer key for public-internet IPs', async () => {
    const app = express();
    // Simulate a public source IP: trust the X-Forwarded-For header.
    app.set('trust proxy', true);
    app.use('/api', authMiddleware);
    app.get('/api/ping', (_req, res) => { res.json({ ok: true }); });

    const res = await request(app)
      .get('/api/ping')
      .set('X-Forwarded-For', '203.0.113.7');
    expect(res.status).toBe(401);
  });
});
