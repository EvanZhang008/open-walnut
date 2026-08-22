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
import {
  startServer, stopServer, setErrorNotificationRepeatTtlMs, publishRecovery, getDiskWatermarkHandle,
} from '../../src/web/server.js';
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
  severity: string;
  title: string;
  body?: string;
  read: boolean;
  dedupKey: string;
  /** permission: 'expired' = nobody answered and nobody can.
   *  operation-error: 'recovered' = the failing operation succeeded again. */
  resolved?: 'allowed' | 'denied' | 'expired' | 'recovered';
  /** operation-error only — which condition a recovery can retire this under. */
  recoveryKey?: string;
  /** operation-error only — the family the Errors rail groups by (humanize.ts). */
  category?: string;
  /** operation-error only — the raw technical line, behind a Details toggle. */
  detail?: string;
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

    // Matched on the dedupKey, not the title: the title is humanized copy now
    // ("Message couldn't be delivered"), and a test keyed on display text breaks
    // on every wording change while proving nothing about the record's identity.
    const dedupKey = `error:session:${sessionId}:delivery`;
    await pollFeed((feed) => feed.feed.some((n) => n.dedupKey === dedupKey));
    await delay(100);

    const feed = await getFeed();
    const deliveryFailures = feed.feed.filter((n) => n.dedupKey === dedupKey);
    expect(deliveryFailures).toHaveLength(1);
    expect(deliveryFailures[0]).toMatchObject({
      kind: 'operation-error',
      title: "Message couldn't be delivered",
      category: 'Sessions',
      sessionId,
    });
    // The producer's reassurance body is already human, so the humanizer keeps it
    // verbatim rather than replacing it with a weaker summary.
    expect(deliveryFailures[0].body).toContain(error);
    expect(deliveryFailures[0].body).toContain('not lost');

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
    const scope = `error:session:${sessionId}:runtime`;
    const matches = body.feed.filter((n) => n.dedupKey === scope);
    expect(matches).toHaveLength(1);
    expect(matches[0].count).toBe(2);
    expect(matches[0].title).toBe('A session hit an error');
    // The card shows the LATEST failure, keyed on first-seen identity.
    expect(matches[0].body).toContain('CLI exited with code 2');
    expect(matches[0].dedupKey).toBe(scope);
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

  it("stamps 'expired' when the CLI WITHDRAWS a request (control_cancel_request)", async () => {
    // The cancel emit carries `allowed: false` AND `cancelled: true`. The server
    // handler used to stamp only on `typeof allowed === 'boolean'`… which this
    // event satisfies, so the risk cuts both ways: the OLD build left the record
    // unresolved forever (phantom in Needs Action), and a naive fix would label a
    // withdrawal as the user's "Denied". It must read 'expired'.
    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: 'sess-e2e-cancel',
      requestId: 'req-e2e-cancel',
      toolName: 'ExitPlanMode',
      input: { plan: 'Step 1' },
    }, ['*']);
    await pollFeed((f) => f.feed.some((n) => n.dedupKey === 'perm:req-e2e-cancel'));

    bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, {
      sessionId: 'sess-e2e-cancel',
      requestId: 'req-e2e-cancel',
      allowed: false,
      cancelled: true,
    }, ['*'], { source: 'session-runner' });

    const body = await pollFeed((f) =>
      f.feed.some((n) => n.dedupKey === 'perm:req-e2e-cancel' && n.resolved === 'expired'));
    const rec = body.feed.find((n) => n.dedupKey === 'perm:req-e2e-cancel')!;
    expect(rec.resolved).toBe('expired');
    // Neutral severity: an expiry is a fact about a dead ask, not a failure.
    expect(rec.severity).toBe('info');
  });

  it('still records a REAL user decision as allowed/denied', async () => {
    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: 'sess-e2e-answer',
      requestId: 'req-e2e-answer',
      toolName: 'Bash',
      input: { command: 'echo hi' },
    }, ['*']);
    await pollFeed((f) => f.feed.some((n) => n.dedupKey === 'perm:req-e2e-answer'));

    bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, {
      sessionId: 'sess-e2e-answer',
      requestId: 'req-e2e-answer',
      allowed: true,
    }, ['*'], { source: 'session-runner' });

    const body = await pollFeed((f) =>
      f.feed.some((n) => n.dedupKey === 'perm:req-e2e-answer' && n.resolved === 'allowed'));
    expect(body.feed.find((n) => n.dedupKey === 'perm:req-e2e-answer')?.severity).toBe('success');
  });

  // ── Error recovery: an error describes a CONDITION, and conditions recover ──
  //
  // The bug this closes: the feed was fire-and-forget, so after the user fixed a
  // plugin's auth the wall of red errors stayed forever and the Errors rail
  // stopped being worth reading. Full loop here: a real log.error through the
  // live bridge → recoveryKey on the record → publishRecovery stamps it, pushes
  // notification:updated, and releases the TTL absorber.

  it('tags a plugin log error with its recoveryKey, then retires it on recovery', async () => {
    const { createSubsystemLogger } = await import('../../src/logging/index.js');
    // Logged under the CORE 'web' subsystem, exactly like the sync poll loop —
    // so `pluginId` in the meta is the only thing that gives it a lifecycle.
    createSubsystemLogger('web').error('plugin-a sync failing repeatedly', {
      pluginId: 'plugin-a', consecutiveFailures: 5, error: 'auth token expired',
    });

    const seen = await pollFeed((f) => f.feed.some((n) => n.recoveryKey === 'plugin:plugin-a'));
    const rec = seen.feed.find((n) => n.recoveryKey === 'plugin:plugin-a')!;
    expect(rec.kind).toBe('operation-error');
    expect(rec.severity).toBe('error');
    expect(rec.resolved).toBeUndefined();
    const dedupKey = rec.dedupKey;
    notifFrames = [];

    // The user runs the auth flow; the next sync tick succeeds and signals.
    const count = await publishRecovery(['plugin:plugin-a']);
    expect(count).toBeGreaterThanOrEqual(1);

    const after = await pollFeed((f) =>
      f.feed.some((n) => n.dedupKey === dedupKey && n.resolved === 'recovered'));
    const settled = after.feed.find((n) => n.dedupKey === dedupKey)!;
    expect(settled.resolved).toBe('recovered');
    // 'info' so the panel's red severity dot goes quiet with the stamp.
    expect(settled.severity).toBe('info');

    // Live tabs get the stamp pushed — the card gains its Recovered chip without
    // a refresh (the panel's F2 merge patches in place).
    const frames = notifFrames.filter((f) => f.data?.dedupKey === dedupKey);
    expect(frames.map((f) => f.name)).toEqual(['notification:updated']);
    expect(frames[0].data.resolved).toBe('recovered');
  });

  it('a recovery does NOT re-badge the bell (read is left alone)', async () => {
    const { createSubsystemLogger } = await import('../../src/logging/index.js');
    createSubsystemLogger('plugin-b').error('list fetch failed', { error: '401' });
    const seen = await pollFeed((f) => f.feed.some((n) => n.recoveryKey === 'plugin:plugin-b'));
    const dedupKey = seen.feed.find((n) => n.recoveryKey === 'plugin:plugin-b')!.dedupKey;

    // Read it, as the user would when triaging the outage.
    await fetch(apiUrl('/api/notifications/mark-read'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const readBefore = await getFeed();
    expect(readBefore.unreadCount).toBe(0);

    await publishRecovery(['plugin:plugin-b']);
    const after = await pollFeed((f) =>
      f.feed.some((n) => n.dedupKey === dedupKey && n.resolved === 'recovered'));
    // Recovery is good news; announcing "the thing you fixed is fixed" with a
    // fresh badge is exactly the noise this feature removes.
    expect(after.unreadCount).toBe(0);
    expect(after.feed.find((n) => n.dedupKey === dedupKey)?.read).toBe(true);
  });

  it('disk full → recovered → full again: the real seam, and the absorber is released', async () => {
    // The whole loop through the SERVER's own wiring (its notify + onRecovered
    // callbacks, not a copy of them in the test — a re-implemented seam is how a
    // test passes while production is unwired).
    //
    // The sequence that used to lie to the user: fail → recover → fail again
    // inside one 60s absorber window. With the absorber still armed, the
    // re-failure was swallowed and the card sat green while the disk was full.
    // So this runs with the PRODUCTION 60s TTL, not the test's 0.
    const handle = getDiskWatermarkHandle();
    expect(handle, 'server must have started the disk watermark monitor').toBeTruthy();

    setErrorNotificationRepeatTtlMs(60_000);
    const { _setStatfsForTest, resetDiskWatermarkForTest } =
      await import('../../src/core/disk-watermark.js');
    /** 30GiB filesystem at `pct` used — small enough to trip the absolute-free gate too. */
    const stubUsedPct = (pct: number): void => {
      const blocks = 30 * 256;
      const bsize = 4 * 1024 * 1024;
      const bavail = Math.round((blocks * (100 - pct)) / 100);
      _setStatfsForTest(async () => ({ bsize, blocks, bfree: bavail, bavail }));
    };
    try {
      resetDiskWatermarkForTest();

      // ok → critical: the server publishes under recoveryKey 'disk' and arms the
      // absorber for the disk:critical scope.
      stubUsedPct(95);
      await handle!.poll();
      const failing = await pollFeed((f) => f.feed.some((n) => n.dedupKey === 'error:disk:critical'));
      const broken = failing.feed.find((n) => n.dedupKey === 'error:disk:critical')!;
      expect(broken.recoveryKey).toBe('disk');
      expect(broken.resolved).toBeUndefined();
      expect(broken.severity).toBe('error');

      // Space freed → critical → warn → ok. The module reports the ok edge through
      // onRecovered, which the server turns into publishRecovery(['disk']).
      stubUsedPct(85); // below critical hysteresis, still warn
      await handle!.poll();
      stubUsedPct(40);
      await handle!.poll();
      const recovered = await pollFeed((f) =>
        f.feed.some((n) => n.dedupKey === 'error:disk:critical' && n.resolved === 'recovered'));
      const settled = recovered.feed.find((n) => n.dedupKey === 'error:disk:critical')!;
      expect(settled.resolved).toBe('recovered');
      expect(settled.severity).toBe('info');

      // Broken AGAIN, immediately — well inside the 60s absorber window that the
      // first failure armed. Because recovery released it, this notifies fresh.
      stubUsedPct(96);
      await handle!.poll();
      const refailed = await pollFeed((f) =>
        f.feed.some((n) => n.dedupKey === 'error:disk:critical' && n.resolved === undefined));
      const again = refailed.feed.find((n) => n.dedupKey === 'error:disk:critical')!;
      // Back to red: the fold clears a non-permission `resolved`, so the card
      // stops claiming recovery the moment the condition returns.
      expect(again.resolved).toBeUndefined();
      expect(again.severity).toBe('error');
    } finally {
      _setStatfsForTest(null);
      resetDiskWatermarkForTest();
      setErrorNotificationRepeatTtlMs(0);
    }
  });

  // ── Round 2: every error class gets a recovery signal or a terminal point ──
  //
  // Round 1 wired plugin/git/backup/disk. The live feed then proved the gaps: 20
  // unresolved cards, including NINE for one failing route, session errors on
  // long-dead sessions, a SERVER EXIT: SIGTERM from a server already replaced, and
  // a bus subscriber card outliving its bug. These drive the new seams through the
  // REAL server (its own middleware, its own bus, its own publishers) rather than a
  // re-implementation of them in the test.

  it('ROUTE: repeated 5xx on one endpoint = ONE card, retired by the next success', async () => {
    // Driven through the SERVER's real request-logger middleware — the failing-route
    // memory lives inside that module, so a test that logged the line itself would
    // pass while production's recovery edge stayed unwired.
    //
    // The 5xx generator is the disk guard: a critically-full disk answers every
    // mutating /api request 507 (a 5xx), which is exactly a route failing for a
    // reason outside the route. Freeing the disk makes the same request succeed.
    const { _setStatfsForTest, resetDiskWatermarkForTest } =
      await import('../../src/core/disk-watermark.js');
    const handle = getDiskWatermarkHandle();
    expect(handle, 'server must have started the disk watermark monitor').toBeTruthy();
    const stubUsedPct = (pct: number): void => {
      const blocks = 30 * 256;
      const bsize = 4 * 1024 * 1024;
      const bavail = Math.round((blocks * (100 - pct)) / 100);
      _setStatfsForTest(async () => ({ bsize, blocks, bfree: bavail, bavail }));
    };

    const path = '/api/tasks';
    const key = 'route:POST /api/tasks';
    try {
      resetDiskWatermarkForTest();
      stubUsedPct(96);
      await handle!.poll(); // arms the 507 gate

      // Three occurrences with different bodies/latencies. Under the OLD log shape
      // (`POST /api/tasks → 507 (23ms)`) each hashed to its own card — that is how
      // one broken endpoint became nine unresolved cards in the live feed.
      for (const title of ['a', 'bb', 'ccc']) {
        const res = await fetch(apiUrl(path), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        });
        expect(res.status).toBe(507);
        await delay(30);
      }

      const failing = await pollFeed((f) => f.feed.some((n) => n.recoveryKey === key));
      const cards = failing.feed.filter((n) => n.recoveryKey === key);
      // ONE card for one condition, whatever the latency and body were.
      expect(cards).toHaveLength(1);
      expect(cards[0].title).toBe('POST /api/tasks → 507');
      expect(cards[0].title).not.toMatch(/ms\)/);
      expect(cards[0].resolved).toBeUndefined();
      const dedupKey = cards[0].dedupKey;

      // Disk freed → the SAME request now answers <500, and the middleware's
      // failing→healthy edge fires publishRecovery through the injected publisher.
      stubUsedPct(40);
      await handle!.poll();
      const ok = await fetch(apiUrl(path), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'recovered' }),
      });
      expect(ok.status).toBeLessThan(500);

      const settled = await pollFeed((f) =>
        f.feed.some((n) => n.dedupKey === dedupKey && n.resolved === 'recovered'));
      const rec = settled.feed.find((n) => n.dedupKey === dedupKey)!;
      expect(rec.resolved).toBe('recovered');
      expect(rec.severity).toBe('info');
    } finally {
      _setStatfsForTest(null);
      resetDiskWatermarkForTest();
      await handle!.poll();
    }
  });

  it('SESSION: a session error retires on that session\'s next clean result', async () => {
    const sessionId = 'sess-recovery-e2e';
    bus.emit(EventNames.SESSION_ERROR, {
      sessionId, error: 'turn blew up',
    }, ['main-ai', 'session-runner'], { source: 'session-runner' });

    const failing = await pollFeed((f) =>
      f.feed.some((n) => n.dedupKey === `error:session:${sessionId}:runtime`));
    const card = failing.feed.find((n) => n.dedupKey === `error:session:${sessionId}:runtime`)!;
    // The key the round-1 code never set, which is why these sat red forever.
    expect(card.recoveryKey).toBe(`session:${sessionId}`);
    expect(card.resolved).toBeUndefined();

    // The session runs again and finishes cleanly — its own recovery signal.
    bus.emit(EventNames.SESSION_RESULT, {
      sessionId, result: 'done', isError: false,
    }, ['main-ai', 'session-runner'], { source: 'session-runner' });

    const settled = await pollFeed((f) =>
      f.feed.some((n) => n.dedupKey === `error:session:${sessionId}:runtime` && n.resolved === 'recovered'));
    const rec = settled.feed.find((n) => n.dedupKey === `error:session:${sessionId}:runtime`)!;
    expect(rec.resolved).toBe('recovered');
    expect(rec.severity).toBe('info');
  });

  it('SESSION: a clean result for a session that never failed changes nothing', async () => {
    // The hot path — this fires on every turn of every session. It must not scan
    // the store, and above all must not retire ANOTHER session's card.
    const other = 'sess-innocent-e2e';
    bus.emit(EventNames.SESSION_ERROR, {
      sessionId: other, error: 'still broken',
    }, ['main-ai', 'session-runner'], { source: 'session-runner' });
    await pollFeed((f) => f.feed.some((n) => n.dedupKey === `error:session:${other}:runtime`));

    bus.emit(EventNames.SESSION_RESULT, {
      sessionId: 'sess-never-failed-e2e', result: 'fine', isError: false,
    }, ['main-ai', 'session-runner'], { source: 'session-runner' });
    await delay(300);

    const feed = await getFeed();
    expect(feed.feed.find((n) => n.dedupKey === `error:session:${other}:runtime`)?.resolved)
      .toBeUndefined();
  });

  it('SESSION FAMILY: a bridge-written session log shares the session\'s key', async () => {
    // 'self-report UNPARSEABLE' (session subsystem) and 'stream-convergence
    // VIOLATION' (obs) were both keyless one-shots in the live feed. Scoping them
    // to the session means the session's next clean turn retires them with the
    // rest of its family — no per-call-site wiring.
    const sessionId = 'sess-family-e2e';
    const { createSubsystemLogger } = await import('../../src/logging/index.js');
    createSubsystemLogger('session').error(
      'turn-complete-summary: self-report UNPARSEABLE — no note section labels found',
      { sessionId, taskId: 'task-family-e2e' },
    );

    const seen = await pollFeed((f) => f.feed.some((n) => n.recoveryKey === `session:${sessionId}`));
    const dedupKey = seen.feed.find((n) => n.recoveryKey === `session:${sessionId}`)!.dedupKey;

    // Mark the session as failing through the same publish site production uses,
    // then let a clean result retire BOTH cards at once.
    bus.emit(EventNames.SESSION_ERROR, {
      sessionId, error: 'and the turn failed too',
    }, ['main-ai', 'session-runner'], { source: 'session-runner' });
    await pollFeed((f) => f.feed.some((n) => n.dedupKey === `error:session:${sessionId}:runtime`));

    bus.emit(EventNames.SESSION_RESULT, {
      sessionId, result: 'ok', isError: false,
    }, ['main-ai', 'session-runner'], { source: 'session-runner' });

    const settled = await pollFeed((f) =>
      f.feed.some((n) => n.dedupKey === dedupKey && n.resolved === 'recovered'));
    // The log-bridge card AND the hand-published one, one signal.
    expect(settled.feed.find((n) => n.dedupKey === dedupKey)?.resolved).toBe('recovered');
    expect(settled.feed.find((n) => n.dedupKey === `error:session:${sessionId}:runtime`)?.resolved)
      .toBe('recovered');
  });

  it('BUS: a throwing subscriber\'s card retires on the next clean dispatch', async () => {
    // The live feed's `subscriber "main-ai" threw` card. The bus is core and cannot
    // import the store, so this rides the publisher the server injects at startup.
    let boom = true;
    const eventName = 'e2e:bus-recovery-probe';
    bus.subscribe('e2e-probe', () => { if (boom) throw new Error('probe bug'); });
    try {
      bus.emit(eventName, {}, ['e2e-probe']);
      const failing = await pollFeed((f) =>
        f.feed.some((n) => n.recoveryKey === `bus:e2e-probe:${eventName}`));
      const card = failing.feed.find((n) => n.recoveryKey === `bus:e2e-probe:${eventName}`)!;
      // Humanized on the way in: the raw log line ('subscriber "e2e-probe" threw
      // on event …') is now the card's `detail`, behind a Details toggle.
      expect(card.title).toBe('An internal event handler failed');
      expect(card.category).toBe('Internal');
      expect(card.body).toContain('"e2e-probe"');
      expect(card.detail).toContain('[bus]');
      expect(card.resolved).toBeUndefined();

      boom = false;
      bus.emit(eventName, {}, ['e2e-probe']);
      const settled = await pollFeed((f) =>
        f.feed.some((n) => n.dedupKey === card.dedupKey && n.resolved === 'recovered'));
      expect(settled.feed.find((n) => n.dedupKey === card.dedupKey)?.resolved).toBe('recovered');
    } finally {
      bus.unsubscribe('e2e-probe');
    }
  });

  it('SERVER LIFECYCLE: the running server IS the recovery for an exit card', async () => {
    // 'SERVER EXIT: SIGTERM' has no later success point by definition — the failing
    // process is gone. Every deploy therefore left a permanent red card for a
    // server that had already been replaced by a healthy one. A boot is the signal.
    const { createSubsystemLogger } = await import('../../src/logging/index.js');
    createSubsystemLogger('web').error('SERVER EXIT: SIGTERM (killed by another process)', {
      pid: 12345, uptime: 900, recoveryKey: 'server-lifecycle',
    });
    const failing = await pollFeed((f) => f.feed.some((n) => n.recoveryKey === 'server-lifecycle'));
    const dedupKey = failing.feed.find((n) => n.recoveryKey === 'server-lifecycle')!.dedupKey;

    // What startServer() does at boot, verbatim.
    await publishRecovery(['server-lifecycle']);
    const settled = await pollFeed((f) =>
      f.feed.some((n) => n.dedupKey === dedupKey && n.resolved === 'recovered'));
    expect(settled.feed.find((n) => n.dedupKey === dedupKey)?.resolved).toBe('recovered');
  });

  it('COMPACTION has its OWN key — the auto-commit edge must not retire it', async () => {
    // Round-1 bug: compaction cards carried 'git', so a healthy 30s auto-commit
    // tick marked a still-broken daily history rewrite as recovered. Worse than
    // never recovering it: the user is told the repo-growth problem is fixed while
    // the repo keeps growing.
    const { createSubsystemLogger } = await import('../../src/logging/index.js');
    const logger = createSubsystemLogger('web');
    logger.error('Data Repo Compaction Failing (e2e)', { recoveryKey: 'git:compaction', error: 'tree mismatch' });
    logger.error('Data Backup Failing (e2e)', { recoveryKey: 'git', error: 'push rejected' });

    const failing = await pollFeed((f) =>
      f.feed.some((n) => n.recoveryKey === 'git:compaction')
      && f.feed.some((n) => n.recoveryKey === 'git'));
    const compaction = failing.feed.find((n) => n.recoveryKey === 'git:compaction')!;
    const autoCommit = failing.feed.find((n) => n.recoveryKey === 'git')!;

    // The auto-commit tick recovers — and only its OWN family.
    await publishRecovery(['git']);
    const afterGit = await pollFeed((f) =>
      f.feed.some((n) => n.dedupKey === autoCommit.dedupKey && n.resolved === 'recovered'));
    expect(afterGit.feed.find((n) => n.dedupKey === autoCommit.dedupKey)?.resolved).toBe('recovered');
    // Compaction is STILL broken and still says so.
    expect(afterGit.feed.find((n) => n.dedupKey === compaction.dedupKey)?.resolved).toBeUndefined();

    // A completed compaction run is the only thing that retires it.
    await publishRecovery(['git:compaction']);
    const afterCompaction = await pollFeed((f) =>
      f.feed.some((n) => n.dedupKey === compaction.dedupKey && n.resolved === 'recovered'));
    expect(afterCompaction.feed.find((n) => n.dedupKey === compaction.dedupKey)?.resolved)
      .toBe('recovered');
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
