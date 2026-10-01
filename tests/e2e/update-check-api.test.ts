/**
 * GET /api/system/update and POST /api/system/update/check through a real server.
 *
 * The registry is a local HTTP stub (never npm). This repo is a source checkout,
 * so the server's own checker reports `enabled: false, reason: 'source'`: the
 * first case pins that, because it is exactly what a contributor's :3456 must
 * say. The rest swap in a checker that believes it is an npm install.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import http from 'node:http';
import fs from 'node:fs/promises';

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { UpdateChecker, setUpdateCheckerForTest, type UpdateStatus } from '../../src/core/self-update/update-check.js';
import type { InstallInfo } from '../../src/core/self-update/install-kind.js';

let server: HttpServer;
let port: number;
let registry: HttpServer;
let registryUrl: string;
/** What the stub answers next: a version, an HTTP status, or 'hang'. */
let answer: string | number | 'hang' = '0.9.0';
let registryHits = 0;

const NPM: InstallInfo = {
  kind: 'npm', sourceDir: null, packageRoot: '/usr/local/lib/node_modules/open-walnut', manager: 'npm',
  updateCommand: 'npm install -g open-walnut@latest',
};

async function api(method: string, path: string): Promise<{ status: number; data: UpdateStatus }> {
  const r = await fetch(`http://localhost:${port}${path}`, { method });
  return { status: r.status, data: (await r.json()) as UpdateStatus };
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  registry = http.createServer((req, res) => {
    registryHits++;
    if (answer === 'hang') return; // never answers; the checker's own deadline ends it
    if (typeof answer === 'number') { res.statusCode = answer; res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: 'open-walnut', version: answer, _path: req.url }));
  });
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
  const addr = registry.address();
  registryUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/open-walnut/latest`;

  server = await startServer({ port: 0, dev: true });
  const saddr = server.address();
  port = typeof saddr === 'object' && saddr ? saddr.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
  registry.closeAllConnections();
  await new Promise<void>((resolve) => registry.close(() => resolve()));
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('update check API', () => {
  it('this checkout is a source install: the server never asks the registry', async () => {
    const r = await api('GET', '/api/system/update');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ enabled: false, reason: 'source', available: false, latest: null });
    expect(r.data.install.kind).toBe('source');
    const forced = await api('POST', '/api/system/update/check');
    expect(forced.status).toBe(200);
    expect(forced.data).toMatchObject({ enabled: false, reason: 'source' });
    expect(registryHits).toBe(0);
  });

  it('an npm install: GET is the cache, POST asks the stub registry and reports the newer version', async () => {
    setUpdateCheckerForTest(new UpdateChecker({ registryUrl, current: '0.5.1', currentKnown: true, install: NPM, env: {} }));
    const before = await api('GET', '/api/system/update');
    expect(before.data).toMatchObject({ enabled: true, current: '0.5.1', latest: null, available: false, checkedAt: null });
    expect(registryHits).toBe(0);

    const checked = await api('POST', '/api/system/update/check');
    expect(checked.status).toBe(200);
    expect(checked.data).toMatchObject({ available: true, latest: '0.9.0', error: null });
    expect(checked.data.install.updateCommand).toBe('npm install -g open-walnut@latest');
    expect(typeof checked.data.checkedAt).toBe('string');
    expect(registryHits).toBe(1);

    // GET now serves the answer without another registry call.
    const after = await api('GET', '/api/system/update');
    expect(after.data).toMatchObject({ available: true, latest: '0.9.0' });
    expect(registryHits).toBe(1);
  });

  it('a failing registry keeps the last answer and records the error', async () => {
    answer = 503;
    const r = await api('POST', '/api/system/update/check');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ available: true, latest: '0.9.0', error: 'registry answered HTTP 503' });
  });

  it('the same version published is "not available"', async () => {
    answer = '0.5.1';
    const r = await api('POST', '/api/system/update/check');
    expect(r.data).toMatchObject({ available: false, latest: '0.5.1', error: null });
  });

  it('a hung registry ends at the checker deadline, and the route answers with the stored status', async () => {
    answer = 'hang';
    const started = Date.now();
    const r = await api('POST', '/api/system/update/check');
    const took = Date.now() - started;
    expect(r.status).toBe(200);
    expect(took).toBeLessThan(8_000);
    expect(r.data.error).toMatch(/abort|timeout/i);
    expect(r.data).toMatchObject({ latest: '0.5.1', available: false });
  }, 15_000);

  it('a disabled checker (opted out) answers at once from both routes', async () => {
    answer = '0.9.0';
    const hits = registryHits;
    setUpdateCheckerForTest(new UpdateChecker({ registryUrl, current: '0.5.1', currentKnown: true, install: NPM, env: { WALNUT_NO_UPDATE_CHECK: '1' } }));
    expect((await api('GET', '/api/system/update')).data).toMatchObject({ enabled: false, reason: 'opted-out' });
    expect((await api('POST', '/api/system/update/check')).data).toMatchObject({ enabled: false, reason: 'opted-out', latest: null });
    expect(registryHits).toBe(hits);
  });
});
