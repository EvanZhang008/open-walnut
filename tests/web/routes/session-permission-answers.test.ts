/**
 * POST /api/sessions/:sid/permission — the `answers` body field (AskUserQuestion).
 *
 * The Claude Code CLI's AskUserQuestion tool echoes the `answers` field back out
 * of the permission response's `updatedInput`, so answering it is not "allow vs
 * deny" — the allow response IS the answer payload. This pins the wire contract
 * end-to-end: route body → respondSessionPermission validation →
 * session.resolvePermissionRequest(requestId, allow, denyMessage, { answers }).
 *
 * What's real: Express + the whole route/core stack. What's stubbed: only the
 * live ClaudeCodeSession (its resolvePermissionRequest is a spy — no CLI is ever
 * spawned).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-perm-answers'));

import { WALNUT_HOME } from '../../../src/constants.js';
import { startServer, stopServer } from '../../../src/web/server.js';
import { sessionRunner } from '../../../src/providers/claude-code-session.js';
import { createSessionRecord } from '../../../src/core/session-tracker.js';

let server: HttpServer;
let port: number;
const SID = 'perm-answers-sid';

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

type ResolveArgs = [string, boolean, string | undefined, Record<string, unknown> | undefined];

/** Register a fake live session whose resolvePermissionRequest records its args. */
function registerFakeSession() {
  const resolvePermissionRequest = vi.fn(
    (..._args: ResolveArgs) => true,
  );
  const fake = {
    sessionId: SID,
    resolvePermissionRequest,
    detach: () => {},
    kill: () => {},
    get active() { return false; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sessionRunner as any).sessions.set(SID, fake);
  return fake;
}

function unregisterFakeSession() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sessionRunner as any).sessions.delete(SID);
}

async function post(body: unknown): Promise<Response> {
  return fetch(apiUrl(`/api/sessions/${SID}/permission`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  await createSessionRecord(SID, undefined, 'proj');
});

afterAll(async () => {
  unregisterFakeSession();
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  unregisterFakeSession();
});

describe('POST /api/sessions/:sid/permission with answers', () => {
  it('forwards answers as the updatedInput patch', async () => {
    const fake = registerFakeSession();
    const answers = { 'Which database?': 'Postgres', 'Migrate now?': 'Later' };

    const res = await post({ requestId: 'req-1', allow: true, answers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'resolved', requestId: 'req-1', allow: true });

    expect(fake.resolvePermissionRequest).toHaveBeenCalledTimes(1);
    const args = fake.resolvePermissionRequest.mock.calls[0] as ResolveArgs;
    expect(args[0]).toBe('req-1');
    expect(args[1]).toBe(true);
    // 4th arg is the patch — the KEY assertion: it is wrapped under `answers`,
    // because respondToControlRequest merges the patch over the tool's own input
    // and the CLI reads `input.answers`.
    expect(args[3]).toEqual({ answers });
  });

  it('omits the patch entirely when answers is absent (every other tool unchanged)', async () => {
    const fake = registerFakeSession();
    const res = await post({ requestId: 'req-2', allow: true });
    expect(res.status).toBe(200);
    const args = fake.resolvePermissionRequest.mock.calls[0] as ResolveArgs;
    expect(args[3]).toBeUndefined();
  });

  it('omits the patch when answers is an empty object (nothing to inject)', async () => {
    const fake = registerFakeSession();
    const res = await post({ requestId: 'req-3', allow: true, answers: {} });
    expect(res.status).toBe(200);
    const args = fake.resolvePermissionRequest.mock.calls[0] as ResolveArgs;
    expect(args[3]).toBeUndefined();
  });

  it('a Dismiss deny still carries the message and no patch', async () => {
    const fake = registerFakeSession();
    const res = await post({ requestId: 'req-4', allow: false, message: 'User dismissed the questions' });
    expect(res.status).toBe(200);
    const args = fake.resolvePermissionRequest.mock.calls[0] as ResolveArgs;
    expect(args[1]).toBe(false);
    expect(args[2]).toBe('User dismissed the questions');
    expect(args[3]).toBeUndefined();
  });

  // `answers` is forwarded verbatim into the CLI's tool input, so a malformed
  // shape would reach the model as a corrupt answer set. Reject at the edge.
  it('400s on an array', async () => {
    registerFakeSession();
    const res = await post({ requestId: 'req-5', allow: true, answers: ['Postgres'] });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/answers must be an object/);
  });

  it('400s on non-string values (number, object, null, array)', async () => {
    registerFakeSession();
    for (const bad of [{ q: 1 }, { q: { nested: 'x' } }, { q: null }, { q: ['a'] }]) {
      const res = await post({ requestId: 'req-6', allow: true, answers: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/answers values must be strings/);
    }
  });

  it('400s on a bare string or number in place of the map', async () => {
    registerFakeSession();
    for (const bad of ['Postgres', 42]) {
      const res = await post({ requestId: 'req-7', allow: true, answers: bad });
      expect(res.status, String(bad)).toBe(400);
    }
  });

  it('a rejected body never reaches the live session', async () => {
    const fake = registerFakeSession();
    await post({ requestId: 'req-8', allow: true, answers: [1, 2] });
    expect(fake.resolvePermissionRequest).not.toHaveBeenCalled();
  });
});
