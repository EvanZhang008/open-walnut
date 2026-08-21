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
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer, setErrorNotificationRepeatTtlMs } from '../../src/web/server.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { dismissNotifications } from '../../src/core/notifications/store.js';

let server: HttpServer;
let port: number;
const previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH;

/** Every notification:* frame this connection saw, in arrival order. */
interface NotifFrame { name: string; data: FeedEntry }
let ws: WebSocket;
let notifFrames: NotifFrame[] = [];

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface FeedEntry {
  id: string;
  kind: string;
  title: string;
  body?: string;
  read: boolean;
  dedupKey: string;
  sessionId?: string;
  taskId?: string;
  requestId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  count?: number;
  lastTimestamp?: number;
  timestamp: number;
}

interface FeedResponse {
  feed: FeedEntry[];
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

  // A real web client, so the broadcast half of the contract is observable
  // (notification:new on first insert, notification:updated on a fold).
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}/ws`);
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as { type?: string; name?: string; data?: unknown };
    if (frame.type === 'event' && frame.name?.startsWith('notification:')) {
      notifFrames.push({ name: frame.name, data: frame.data as FeedEntry });
    }
  });

  // publishErrorNotification carries a 60s in-memory absorber so a failure on a
  // 30s timer can't do a locked read-modify-write + a broadcast per occurrence.
  // The fold/count contract below deliberately fires repeats back-to-back, so
  // disable the absorber rather than weaken the assertions.
  setErrorNotificationRepeatTtlMs(0);

  // Vitest deliberately blocks the production local-daemon directory. The
  // resulting startup safety alert is unrelated to notification routing.
  await dismissNotifications();
  notifFrames = [];
});

afterAll(async () => {
  ws?.close();
  setErrorNotificationRepeatTtlMs(60_000);
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

  it('persists a permission request into the feed with the detail the UI renders', async () => {
    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: 'sess-e2e-1',
      requestId: 'req-e2e-1',
      toolName: 'Bash',
      input: { command: 'ls -la /tmp', description: 'list tmp' },
    }, ['*']);

    const body = await pollFeed((f) => f.feed.some((n) => n.dedupKey === 'perm:req-e2e-1'));
    const perm = body.feed.find((n) => n.dedupKey === 'perm:req-e2e-1');
    expect(perm).toBeTruthy();
    expect(perm?.kind).toBe('permission');
    expect(perm?.title).toBe('Bash');
    // The card can now answer "approve what?" on its own.
    expect(perm?.requestId).toBe('req-e2e-1');
    expect(perm?.toolName).toBe('Bash');
    expect(perm?.input).toEqual({ command: 'ls -la /tmp', description: 'list tmp' });
    expect(perm?.body).toBe('ls -la /tmp');
    expect(body.unreadCount).toBeGreaterThanOrEqual(1);

    // The insert is pushed live so the bell updates without a refresh.
    const news = notifFrames.filter((f) => f.data?.dedupKey === 'perm:req-e2e-1');
    expect(news).toHaveLength(1);
    expect(news[0].name).toBe('notification:new');
  });

  it('does not double-persist, re-count, or re-broadcast a re-emitted permission request', async () => {
    const before = await getFeed();
    const original = before.feed.find((n) => n.dedupKey === 'perm:req-e2e-1')!;

    // The CLI re-asks the SAME requestId every 60s while nobody answers.
    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: 'sess-e2e-1',
      requestId: 'req-e2e-1',
      toolName: 'Bash',
      input: { command: 'ls -la /tmp', description: 'list tmp' },
    }, ['*']);
    await delay(300);

    const body = await getFeed();
    const matches = body.feed.filter((n) => n.dedupKey === 'perm:req-e2e-1');
    expect(matches).toHaveLength(1);
    // A re-ask is the same pending request, NOT a new occurrence.
    expect(matches[0].count).toBeUndefined();
    expect(matches[0].id).toBe(original.id);
    expect(matches[0].timestamp).toBe(original.timestamp);
    // ...and it must not re-toast connected UIs.
    expect(notifFrames.filter((f) => f.data?.dedupKey === 'perm:req-e2e-1')).toHaveLength(1);
  });

  it('summarizes non-Bash permission requests too', async () => {
    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: 'sess-e2e-1',
      requestId: 'req-e2e-plan',
      toolName: 'ExitPlanMode',
      input: { plan: 'Step 1: do the thing' },
    }, ['*']);
    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: 'sess-e2e-1',
      requestId: 'req-e2e-write',
      toolName: 'Write',
      input: { file_path: 'src/new-file.ts', content: 'x'.repeat(3000) },
    }, ['*']);

    const body = await pollFeed((f) =>
      f.feed.some((n) => n.dedupKey === 'perm:req-e2e-plan')
      && f.feed.some((n) => n.dedupKey === 'perm:req-e2e-write'));

    const plan = body.feed.find((n) => n.dedupKey === 'perm:req-e2e-plan')!;
    expect(plan.body).toBe('Plan ready for review');
    expect((plan.input as { plan: string }).plan).toBe('Step 1: do the thing');

    const write = body.feed.find((n) => n.dedupKey === 'perm:req-e2e-write')!;
    expect(write.body).toBe('src/new-file.ts');
    expect(write.input?.file_path).toBe('src/new-file.ts');
    // Content is stored as a bounded preview, not the whole file.
    expect((write.input as { content: string }).content).toHaveLength(401);
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

  it('folds repeated session errors into ONE record with a growing count', async () => {
    const sessionId = 'sess-runtime-error-e2e';
    // A runtime session error has no in-memory suppression window (unlike
    // delivery_failed), so both events reach the store — which is exactly the
    // case that used to produce two near-identical cards, because the dedupKey
    // hashed the body. Now one scope = one card that folds its repeats.
    bus.emit(EventNames.SESSION_ERROR, {
      sessionId, error: 'CLI exited with code 1',
    }, ['main-ai', 'session-runner'], { source: 'session-runner' });

    await pollFeed((f) => f.feed.some((n) => n.sessionId === sessionId));

    bus.emit(EventNames.SESSION_ERROR, {
      sessionId, error: 'CLI exited with code 2',
    }, ['main-ai', 'session-runner'], { source: 'session-runner' });

    const body = await pollFeed((f) => f.feed.some((n) => n.sessionId === sessionId && n.count === 2));
    const matches = body.feed.filter((n) => n.sessionId === sessionId && n.title === 'Session Error');
    expect(matches).toHaveLength(1);
    expect(matches[0].count).toBe(2);
    // The card shows the LATEST failure, keyed on first-seen identity.
    expect(matches[0].body).toContain('CLI exited with code 2');
    expect(matches[0].dedupKey).toBe(`error:session:${sessionId}:runtime`);
    expect(matches[0].lastTimestamp).toBeGreaterThanOrEqual(matches[0].timestamp);

    // First occurrence toasts; the fold patches the same card in place.
    const frames = notifFrames.filter((f) => f.data?.dedupKey === `error:session:${sessionId}:runtime`);
    expect(frames.map((f) => f.name)).toEqual(['notification:new', 'notification:updated']);
    expect(frames[1].data.count).toBe(2);
  });

  it('absorbs a repeat inside the TTL window without touching the store or the socket', async () => {
    // A failure sitting on a 30s timer (git:auto-commit) or a poll loop used to
    // do an unconditional locked read-modify-write of notifications.json PLUS a
    // WS broadcast on EVERY occurrence, forever.
    setErrorNotificationRepeatTtlMs(60_000);
    try {
      const sessionId = 'sess-absorber-e2e';
      const scope = `error:session:${sessionId}:runtime`;
      bus.emit(EventNames.SESSION_ERROR, {
        sessionId, error: 'flapping',
      }, ['main-ai', 'session-runner'], { source: 'session-runner' });
      await pollFeed((f) => f.feed.some((n) => n.dedupKey === scope));

      for (let i = 0; i < 5; i++) {
        bus.emit(EventNames.SESSION_ERROR, {
          sessionId, error: `flapping ${i}`,
        }, ['main-ai', 'session-runner'], { source: 'session-runner' });
      }
      await delay(300);

      const body = await getFeed();
      const matches = body.feed.filter((n) => n.dedupKey === scope);
      expect(matches).toHaveLength(1);
      expect(matches[0].count).toBeUndefined(); // absorbed repeats are not counted
      const frames = notifFrames.filter((f) => f.data?.dedupKey === scope);
      expect(frames.map((f) => f.name)).toEqual(['notification:new']);
    } finally {
      setErrorNotificationRepeatTtlMs(0);
    }
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
