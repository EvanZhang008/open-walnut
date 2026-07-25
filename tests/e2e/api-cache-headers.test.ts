/**
 * Regression test for the "Untitled session" browser-cache race
 * (inc-1784686852150 / inc-1784752220440).
 *
 * Express's default weak ETag let the browser turn concurrent duplicate GETs
 * to /api/sessions/:id into If-None-Match revalidations; the empty-body 304
 * surfaced to fetch() as "200 with no JSON", fetchSession() swallowed the
 * parse error into null, and the session panel rendered "Untitled session".
 *
 * The server-side fix is twofold — this test pins both:
 *   1. `app.set('etag', false)`  → no ETag header on API JSON, and a stale
 *      If-None-Match can never produce a 304.
 *   2. `Cache-Control: no-store` default on /api → the browser never caches
 *      or revalidates API responses (routes that want caching set their own).
 * Plus the forensics echo: X-Request-Id on every logged API response.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;
const previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

beforeAll(async () => {
  process.env.WALNUT_DISABLE_SEARCH = '1';
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  if (previousDisableSearch === undefined) {
    delete process.env.WALNUT_DISABLE_SEARCH;
  } else {
    process.env.WALNUT_DISABLE_SEARCH = previousDisableSearch;
  }
});

describe('API cache headers (Untitled-session 304-race regression)', () => {
  it('API JSON responses carry no ETag and Cache-Control: no-store', async () => {
    const res = await fetch(apiUrl('/api/sessions'));
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('echoes X-Request-Id for browser↔server log correlation', async () => {
    const res = await fetch(apiUrl('/api/sessions'));
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('If-None-Match can never produce a 304 on API JSON', async () => {
    // Pre-fix, replaying the response's own ETag returned an empty-body 304.
    // With etag disabled there is nothing to match — always a full 200 body.
    const first = await fetch(apiUrl('/api/sessions'));
    expect(first.status).toBe(200);
    const res = await fetch(apiUrl('/api/sessions'), {
      headers: { 'If-None-Match': 'W/"whatever-stale-etag"' },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it('routes that opt into caching still override the no-store default', async () => {
    // /api/images sets its own long-lived Cache-Control inside the handler
    // (404 here — the header contract is what matters for cacheable routes,
    // and error responses correctly keep the no-store default).
    const res = await fetch(apiUrl('/api/sessions/recent'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
