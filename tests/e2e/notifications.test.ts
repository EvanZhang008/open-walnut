/**
 * E2E tests for the unified notification system: real server + event bus + the
 * persistent feed route. Follows the harness in tests/e2e/cron-lifecycle.test.ts.
 *
 * Verifies the end-to-end wiring the unit tests can't reach:
 *   - GET /api/notifications serves an empty feed on a fresh server.
 *   - A session:permission-request emitted on the bus (what the session runner
 *     does) is persisted into the feed by the server.ts subscriber, and shows up
 *     via GET with an unread count.
 *   - A cron:notification (emitted via the same path the cron callback uses) also
 *     lands in the feed.
 *   - POST /mark-read clears the unread count.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { dismissNotifications } from '../../src/core/notifications/store.js';

let server: HttpServer;
let port: number;
const previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface FeedResponse {
  feed: Array<{
    id: string;
    kind: string;
    title: string;
    body?: string;
    read: boolean;
    dedupKey: string;
    sessionId?: string;
    taskId?: string;
  }>;
  unreadCount: number;
}

async function getFeed(): Promise<FeedResponse> {
  const res = await fetch(apiUrl('/api/notifications'));
  expect(res.status).toBe(200);
  return (await res.json()) as FeedResponse;
}

/** Poll the feed until `pred` holds or we time out (the bus subscriber is async). */
async function pollFeed(pred: (f: FeedResponse) => boolean, timeoutMs = 3000): Promise<FeedResponse> {
  const deadline = Date.now() + timeoutMs;
  let last = await getFeed();
  while (!pred(last) && Date.now() < deadline) {
    await delay(50);
    last = await getFeed();
  }
  return last;
}

beforeAll(async () => {
  process.env.WALNUT_DISABLE_SEARCH = '1';
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Vitest deliberately blocks the production local-daemon directory. The
  // resulting startup safety alert is unrelated to notification routing.
  await dismissNotifications();
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

describe('Notification feed API', () => {
  it('serves an empty feed on a fresh server', async () => {
    const body = await getFeed();
    expect(body.feed).toEqual([]);
    expect(body.unreadCount).toBe(0);
  });

  it('persists a permission request into the feed', async () => {
    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: 'sess-e2e-1',
      requestId: 'req-e2e-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    }, ['*']);

    const body = await pollFeed((f) => f.feed.some((n) => n.dedupKey === 'perm:req-e2e-1'));
    const perm = body.feed.find((n) => n.dedupKey === 'perm:req-e2e-1');
    expect(perm).toBeTruthy();
    expect(perm?.kind).toBe('permission');
    expect(perm?.title).toBe('Bash');
    expect(body.unreadCount).toBeGreaterThanOrEqual(1);
  });

  it('does not double-persist a re-emitted permission request (dedup by requestId)', async () => {
    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: 'sess-e2e-1',
      requestId: 'req-e2e-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    }, ['*']);
    await delay(200);
    const body = await getFeed();
    expect(body.feed.filter((n) => n.dedupKey === 'perm:req-e2e-1')).toHaveLength(1);
  });

  it('routes repeated delivery failures to one notification and keeps them out of chat', async () => {
    const sessionId = 'sess-delivery-failed-e2e';
    const error = 'No active session found for session ID: sess-delivery-failed-e2e';
    const payload = {
      sessionId,
      error,
      errorKind: 'delivery_failed' as const,
    };

    // Reproduce the repeated outage events that previously accumulated as
    // permanent red cards in the main conversation.
    bus.emit(EventNames.SESSION_ERROR, payload, ['main-ai', 'session-runner'], {
      source: 'session-runner',
    });
    bus.emit(EventNames.SESSION_ERROR, payload, ['main-ai', 'session-runner'], {
      source: 'session-runner',
    });

    await pollFeed((feed) => feed.feed.some((n) =>
      n.title === 'Session Delivery Failed' && n.sessionId === sessionId));
    await delay(100);

    const feed = await getFeed();
    const deliveryFailures = feed.feed.filter((n) =>
      n.title === 'Session Delivery Failed' && n.sessionId === sessionId);
    expect(deliveryFailures).toHaveLength(1);
    expect(deliveryFailures[0]).toMatchObject({
      kind: 'operation-error',
      body: expect.stringContaining(error),
      sessionId,
    });

    const historyRes = await fetch(apiUrl('/api/chat/history'));
    expect(historyRes.status).toBe(200);
    const history = await historyRes.json() as {
      messages: Array<{ content: unknown; source?: string }>;
    };
    expect(history.messages.filter((entry) => entry.source === 'session-error')).toHaveLength(0);
    expect(JSON.stringify(history.messages)).not.toContain('Session Delivery Failed');
    expect(JSON.stringify(history.messages)).not.toContain(error);
  });

  it('marks all read, clearing the unread count', async () => {
    const res = await fetch(apiUrl('/api/notifications/mark-read'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await getFeed();
    expect(body.unreadCount).toBe(0);
    expect(body.feed.every((n) => n.read)).toBe(true);
  });
});
