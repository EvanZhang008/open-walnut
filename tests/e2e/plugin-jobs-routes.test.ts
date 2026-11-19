/**
 * The plugin jobs routes through a REAL server (src/web/routes/plugin-jobs-routes.ts).
 * The plugin page reads GET /api/plugin-runtime/:id/jobs every 10 s on every plugin's
 * page, so a normal state answers 200 with no jobs and the reason: an error status
 * there was logged by the browser on every read (a 404 for each plugin without jobs).
 * A test server places no jobs, which is one of those normal states.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';

import path from 'node:path';
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { CLOUD_BOX_HOST_ALIAS, setCloudBoxState } from '../../src/core/hosts/cloud-box-host.js';

let server: HttpServer;
let port: number;

async function api(method: string, route: string, body?: unknown) {
  const r = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 90_000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('plugin jobs routes', () => {
  it('the status GET answers 200 with no jobs and the reason where none are placed', async () => {
    const res = await api('GET', '/api/plugin-runtime/acme-none/jobs');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ pluginId: 'acme-none', declared: [], jobs: [], reason: expect.stringMatching(/test server/) });
  });

  it('a request the page makes only for a shown job still says why it cannot be answered', async () => {
    const logs = await api('GET', '/api/plugin-runtime/acme-none/jobs/worker/logs');
    expect(logs.status).toBe(503);
    expect(logs.data.error).toMatch(/test server/);
  });

  // A connection is an abstraction: the cloud box takes a job's code over its tunnel
  // (DaemonConnection.uploadFile; cloud-box-link-features-twins-e2e.test.ts), so it is a
  // place for jobs like any other host. A name that is no host is still refused.
  it('jobs may be placed on the cloud box, and an unknown host is still refused', async () => {
    await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), 'version: 1\nuser:\n  name: Tester\n');
    setCloudBoxState({ domain: 'box.example.test', secure: true, capability: 'ready', checkedAt: null });
    try {
      const put = await api('PUT', '/api/plugin-runtime/acme-none/jobs/run-on', { runOn: CLOUD_BOX_HOST_ALIAS });
      expect(put).toEqual({ status: 200, data: { pluginId: 'acme-none', runOn: CLOUD_BOX_HOST_ALIAS } });
      const unknown = await api('PUT', '/api/plugin-runtime/acme-none/jobs/run-on', { runOn: 'no-such-box' });
      expect(unknown.status).toBe(400);
      expect(unknown.data.error).toBe('no-such-box is not a host in Settings, Hosts');
    } finally {
      setCloudBoxState(null);
    }
  });

  it('an id that is not a plugin id is refused', async () => {
    const res = await api('GET', '/api/plugin-runtime/..%2Fx/jobs');
    expect(res.status).toBe(400);
  });
});
