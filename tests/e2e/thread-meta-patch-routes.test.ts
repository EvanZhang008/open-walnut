/**
 * `thread_meta` over HTTP (C17): the web PATCH /api/sessions/:id and the frozen
 * PATCH /api/v1/sessions/:id run the SAME core (patchSession), so every 400 case
 * and the upsert itself are asserted against both routes by one table.
 * Real server via startServer({ port: 0, dev: true }).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-thread-meta-routes'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js';

let server: HttpServer;
let port: number;

const ROUTES = [
  { name: 'web', path: (sid: string) => `/api/sessions/${sid}` },
  { name: 'v1', path: (sid: string) => `/api/v1/sessions/${sid}` },
] as const;

async function patch(p: string, body: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  for (const r of ROUTES) await createSessionRecord(`meta-route-${r.name}`, `task-${r.name}`, 'proj', '/tmp');
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

const BAD_BODIES: Array<[string, unknown, RegExp]> = [
  ['unknown status', { thread_meta: [{ headId: 'h1', status: 'closed' }] }, /status must be one of/],
  ['title over 120 chars', { thread_meta: [{ headId: 'h1', title: 'x'.repeat(121) }] }, /title must be a string \(max 120/],
  ['more than 500 entries', { thread_meta: Array.from({ length: 501 }, (_, i) => ({ headId: `h${i}` })) }, /at most 500/],
  ['not an array', { thread_meta: { headId: 'h1' } }, /thread_meta must be an array/],
  ['empty headId', { thread_meta: [{ headId: '' }] }, /headId must be a non-empty string/],
];

describe.each(ROUTES)('PATCH thread_meta via the $name route', (route) => {
  const sid = `meta-route-${route.name}`;

  it.each(BAD_BODIES)('%s answers 400 and stores nothing', async (_label, body, message) => {
    const res = await patch(route.path(sid), body);
    expect(res.status).toBe(400);
    expect(res.text).toMatch(message);
    expect((await getSessionByClaudeId(sid))?.threadMeta).toBeUndefined();
  });

  it('upserts by headId, null clears, unlisted entries stay', async () => {
    const first = await patch(route.path(sid), {
      thread_anchors: [{ msgId: 'head-1', parent: 'reply-1', source: 'selection', at: '2026-09-26T10:00:00.000Z' }],
      thread_meta: [
        { headId: 'head-1', status: 'open', titleState: 'pending', question: 'why?' },
        { headId: 'head-2', status: 'older', title: 'Old one' },
      ],
    });
    expect(first.status).toBe(200);
    const second = await patch(route.path(sid), { thread_meta: [{ headId: 'head-2', status: 'resolved', title: null }] });
    expect(second.status).toBe(200);
    const meta = (await getSessionByClaudeId(sid))?.threadMeta ?? [];
    expect(meta.map((e) => e.headId)).toEqual(['head-1', 'head-2']);
    // Test servers keep the background AI gate closed: pending is stored as unavailable.
    expect(meta[0]).toMatchObject({ status: 'open', titleState: 'unavailable', question: 'why?' });
    expect(meta[1].status).toBe('resolved');
    expect(meta[1].title).toBeUndefined();
    expect(second.json?.session?.threadMeta ?? second.json?.threadMeta).toBeDefined();
  });
});

describe('v1 at-least-one-field rule', () => {
  it('names thread_meta and thread_anchors in the empty-body 400', async () => {
    const res = await patch('/api/v1/sessions/meta-route-v1', {});
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/thread_anchors, thread_meta/);
  });
});
