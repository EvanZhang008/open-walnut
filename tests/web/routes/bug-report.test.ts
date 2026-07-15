/**
 * Tests for GET /api/bug-report — the one-shot diagnostic bundle route.
 *
 * Contract under test:
 *   - 200 text/plain with the bundle banner and injected system health.
 *   - Secrets seeded into logs come out [REDACTED].
 *   - 5s throttle → 429 on immediate repeat.
 *   - NEVER 500s, even when the builder's sources are missing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());
// The route imports getSystemHealth from server.ts (same pattern as
// routes/system.ts). Mock it so the test never loads the full server graph.
vi.mock('../../../src/web/server.js', () => ({
  getSystemHealth: () => ({ claudeCliAvailable: true, hasReadyProvider: true, daemons: [{ host: 'test-host', label: 'Test', connected: true }] }),
}));

import express from 'express';
import request from 'supertest';
import { LOG_DIR } from '../../../src/constants.js';
import { bugReportRouter } from '../../../src/web/routes/bug-report.js';

function createApp() {
  const app = express();
  app.use('/api/bug-report', bugReportRouter);
  return app;
}

describe('GET /api/bug-report', () => {
  beforeEach(() => {
    fs.rmSync(LOG_DIR, { recursive: true, force: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
  });

  // Tests run in file order; the module-level throttle starts at 0 so the
  // first request always passes, and the second test exploits the throttle
  // set by this one.
  it('returns 200 text/plain with the bundle and injected health', async () => {
    const res = await request(createApp()).get('/api/bug-report');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('WALNUT DIAGNOSTIC BUNDLE (server)');
    expect(res.text).toContain('test-host');
    expect(res.text).toContain('=== collection notes ===');
  });

  it('throttles immediate repeats with 429, then redacts secrets after cooldown', async () => {
    const app = createApp();
    const secret = 'sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const d = new Date();
    const dated = path.join(
      LOG_DIR,
      `open-walnut-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`,
    );
    fs.writeFileSync(dated, JSON.stringify({ time: d.toISOString(), level: 'info', subsystem: 'web', message: `oops ${secret}` }) + '\n');

    // Immediately after the previous test's generation → throttled.
    const throttled = await request(app).get('/api/bug-report');
    expect(throttled.status).toBe(429);

    // Wait out the 5s throttle window (real time — the throttle uses Date.now()).
    await new Promise((r) => setTimeout(r, 5_100));
    const res = await request(app).get('/api/bug-report');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(secret);
    expect(res.text).toContain('[REDACTED]');
  }, 15_000);
});
