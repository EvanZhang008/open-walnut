/**
 * Cloud-mode auth integration tests — real startServer({ port: 0 }) with
 * CLOUD_MODE enabled (via the constants mock, the single source of truth for
 * every importer) and an isolated temp OPEN_WALNUT_HOME.
 *
 * Covers: 401 on unauthenticated API, first-boot claim flow, device-token
 * auth, revocation, per-IP rate limiting, public health/status endpoints,
 * and WS upgrade token enforcement.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../../helpers/mock-constants.js';

// CLOUD_MODE: true rides the constants mock — auth middleware, WS handler and
// server startup all read the flag from this module.
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-test', { CLOUD_MODE: true }));

import { WALNUT_HOME } from '../../../src/constants.js';
import { startServer, stopServer } from '../../../src/web/server.js';
import {
  createDevice,
  revokeDevice,
  getSetupTokenIfUnclaimed,
  _resetDeviceAuthForTesting,
} from '../../../src/core/device-auth.js';
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js';

let server: HttpServer;
let port: number;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  _resetDeviceAuthForTesting();
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
}, 30_000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  _resetAuthRateLimitForTesting();
});

describe('cloud mode auth enforcement', () => {
  let deviceToken: string;

  it('rejects unauthenticated /api/tasks with 401 (LAN bypass disabled)', async () => {
    const res = await fetch(apiUrl('/api/tasks'));
    expect(res.status).toBe(401);
  });

  it('health endpoint stays public (monitoring)', async () => {
    const res = await fetch(apiUrl('/api/system/health'));
    expect(res.status).toBe(200);
  });

  it('GET /api/v1/setup/status is public and reports unclaimed', async () => {
    const res = await fetch(apiUrl('/api/v1/setup/status'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: false });
  });

  it('claim with a wrong setup token → 401', async () => {
    const res = await fetch(apiUrl('/api/v1/setup/claim'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken: 'f'.repeat(32), deviceName: 'intruder' }),
    });
    expect(res.status).toBe(401);
  });

  it('claim with the real setup token → 200 with a working device token', async () => {
    // Same module singleton the server's boot banner used.
    const setup = await getSetupTokenIfUnclaimed();
    expect(setup).not.toBeNull();

    const res = await fetch(apiUrl('/api/v1/setup/claim'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken: setup!.token, deviceName: 'first-phone' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { deviceName: string; token: string };
    expect(body.deviceName).toBe('first-phone');
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
    deviceToken = body.token;
  });

  it('authenticated request with the device token → 200', async () => {
    const res = await fetch(apiUrl('/api/tasks'), {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('setup/status now reports claimed', async () => {
    const res = await fetch(apiUrl('/api/v1/setup/status'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: true });
  });

  it('second claim → 403 (path closed permanently)', async () => {
    const setup = await getSetupTokenIfUnclaimed(); // null once claimed
    expect(setup).toBeNull();
    const res = await fetch(apiUrl('/api/v1/setup/claim'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken: 'a'.repeat(32), deviceName: 'second-phone' }),
    });
    expect(res.status).toBe(403);
  });

  it('revoked device token → 401', async () => {
    const { token } = await createDevice('temp-device');
    const okRes = await fetch(apiUrl('/api/tasks'), { headers: { Authorization: `Bearer ${token}` } });
    expect(okRes.status).toBe(200);

    await revokeDevice('temp-device');
    const res = await fetch(apiUrl('/api/tasks'), { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it('token-ABSENT requests never trip the rate limiter (unpaired SPA boot)', async () => {
    // Regression: an unpaired browser loading the SPA fires a dozen tokenless
    // API calls; counting those as auth failures 429-locked the pairing device.
    _resetAuthRateLimitForTesting();
    for (let i = 0; i < 15; i++) {
      const res = await fetch(apiUrl('/api/tasks'));
      expect(res.status).toBe(401); // still denied — just not counted
    }
    const after = await fetch(apiUrl('/api/tasks'));
    expect(after.status).toBe(401); // NOT 429
  });

  it('rate-limits repeated auth failures with 429', async () => {
    _resetAuthRateLimitForTesting();
    for (let i = 0; i < 10; i++) {
      const res = await fetch(apiUrl('/api/tasks'), {
        headers: { Authorization: 'Bearer 00000000000000000000000000000000' },
      });
      expect(res.status).toBe(401);
    }
    const limited = await fetch(apiUrl('/api/tasks'), {
      headers: { Authorization: 'Bearer 00000000000000000000000000000000' },
    });
    expect(limited.status).toBe(429);
  });

  it('WS upgrade without a token is rejected', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('error', (err) => resolve(`error:${err.message}`));
    });
    expect(outcome).toContain('error');
    expect(outcome).toContain('401');
  });

  it('WS upgrade with ?token=<device token> connects', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${deviceToken}`);
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('error', (err) => resolve(`error:${err.message}`));
    });
    expect(outcome).toBe('open');
  });
});
