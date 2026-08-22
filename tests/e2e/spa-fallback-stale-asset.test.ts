/**
 * E2E: in production mode, a request for a missing build artifact must 404 —
 * it must NOT fall through to the SPA shell.
 *
 * Every deploy re-hashes and wipes dist/web/static/assets, so a tab that was
 * open across the deploy keeps asking for chunk names that no longer exist.
 * Answering those with index.html returned `200 text/html` where the browser
 * expected a JS module, and since every code-split import in the app has a
 * best-effort catch, the failure was completely silent: the reported symptom
 * was a .go file rendering with no syntax colors, in a tab that had highlighted
 * Go fine an hour before.
 *
 * Deep links must still work, so the two behaviours are pinned together.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

/** Production static serving needs a built SPA; skip rather than fail without one. */
const staticDir = path.join(process.cwd(), 'dist', 'web', 'static');
const built = fs.existsSync(path.join(staticDir, 'index.html'));

let server: HttpServer;
let base = '';

beforeAll(async () => {
  if (!built) return;
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  // dev: false is the point — that is the only mode that mounts static + fallback.
  server = await startServer({ port: 0, dev: false });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  if (!built) return;
  await stopServer();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe.skipIf(!built)('SPA fallback vs stale build assets', () => {
  it('a chunk name from a replaced build 404s instead of returning the SPA shell', async () => {
    const res = await fetch(`${base}/assets/index-fromAnOldBuild.js`);
    expect(res.status).toBe(404);
    // The status is what stops the browser from parsing a page as a module;
    // assert the body is not the app shell either (Express's own 404 page is
    // HTML, so the content type alone proves nothing).
    expect(await res.text()).not.toContain('id="root"');
  });

  it('the same holds for a stale stylesheet', async () => {
    const res = await fetch(`${base}/assets/index-fromAnOldBuild.css`);
    expect(res.status).toBe(404);
  });

  it('a missing root-level file 404s too', async () => {
    const res = await fetch(`${base}/definitely-not-here.json`);
    expect(res.status).toBe(404);
  });

  it('client-side deep links still get the SPA shell', async () => {
    for (const p of ['/', '/tasks', '/sessions?id=abc']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('content-type') ?? '', p).toContain('text/html');
    }
  });

  it('a real built asset is still served as a module', async () => {
    const assets = fs.readdirSync(path.join(staticDir, 'assets')).filter((f) => f.endsWith('.js'));
    expect(assets.length).toBeGreaterThan(0);
    const res = await fetch(`${base}/assets/${assets[0]}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/javascript/);
  });
});
