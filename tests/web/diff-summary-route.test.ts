/**
 * GET /api/sessions/:sessionId/changes/summary — REAL route coverage (no
 * page.route stubs, no mocked express): startServer({port:0,dev:true}) and
 * actual HTTP. Pins the wire contract the browser strip depends on:
 *   - 400 for a missing path and for a repeated ?path= param
 *   - 404 (typed JSON, not HTML) for an unknown session — this also proves the
 *     route isn't shadowed by /changes or /changes/file and that the
 *     DiffSummaryError → SessionControlError instanceof mapping holds across
 *     the dynamic import.
 * Model calls never happen here: backgroundAiDisabled() is true under vitest,
 * and these paths fail before reaching the gate anyway.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-diff-summary-route'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port = 0;

const apiUrl = (path: string) => `http://localhost:${port}${path}`;

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
  // Background writers can recreate files mid-rm (ENOTEMPTY) — retry.
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('GET /api/sessions/:sessionId/changes/summary', () => {
  it('400 when path is missing', async () => {
    const res = await fetch(apiUrl('/api/sessions/whatever/changes/summary'));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('path query param');
  });

  it('400 when path is repeated (?path=a&path=b arrives as an array)', async () => {
    const res = await fetch(apiUrl('/api/sessions/whatever/changes/summary?path=/a&path=/b'));
    expect(res.status).toBe(400);
  });

  it('404 typed JSON for an unknown session (proves route match + error mapping)', async () => {
    const res = await fetch(apiUrl('/api/sessions/no-such-session/changes/summary?path=/repo/src/a.ts'));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as { error: string };
    // 'Session not found' comes from diff-summary.ts — NOT the /changes or
    // /changes/file handlers, so the route wasn't shadowed.
    expect(body.error).toBe('Session not found');
  });
});
