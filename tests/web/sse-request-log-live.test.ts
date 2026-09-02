/**
 * The premise, over a REAL socket: an SSE response never fires `finish`.
 *
 * The sibling test (`request-logger-stream-visibility.test.ts`) drives the middleware by
 * emitting `finish` / `close` itself, which pins the behaviour but takes the premise on
 * faith. This one stands up a real express app with the real `requestLogger` and the real
 * `attachSse`, opens a real HTTP connection, and hangs up — so what is asserted is node's
 * own event semantics, not my model of them.
 *
 * Deliberately not the whole walnut server: the point is the middleware + SSE pair, and a
 * fixture server would drag in auth, config and a data directory to prove nothing extra.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { requestLogger } from '../../src/web/middleware/request-logger.js';
import { attachSse, emitSse, closeAllSseChannels } from '../../src/web/sse-channels.js';
import { log } from '../../src/logging/index.js';

interface Logged { message: string; meta?: Record<string, unknown> }

let lines: Logged[] = [];
let server: Server | null = null;

function listen(): Promise<number> {
  const app = express();
  app.use('/api', requestLogger);
  app.get('/api/v1/events', (req, res) => {
    attachSse('test-feed', req, res, { onAttach: (write) => write('snapshot', { ok: true }) });
  });
  app.get('/api/plain', (_req, res) => { res.json({ ok: true }); });
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as AddressInfo).port);
    });
  });
}

beforeEach(() => {
  lines = [];
  vi.spyOn(log.web, 'info').mockImplementation((message, meta) => {
    lines.push({ message: String(message), meta: meta as Record<string, unknown> });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeAllSseChannels();
  const s = server;
  server = null;
  if (!s) return;
  // `close()` alone waits for every keep-alive socket, and fetch keeps one — which is a
  // hung suite, not a failing one, so it is worth the extra line.
  s.closeAllConnections?.();
  await new Promise<void>((resolve) => { s.close(() => resolve()); });
});

/** Wait until `predicate` holds, or fail loudly rather than hanging the suite. */
async function until(predicate: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('a real SSE connection over a real socket', () => {
  it('logs NOTHING while it is streaming, then exactly one line when the client hangs up', async () => {
    const port = await listen();
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    // Read the snapshot so the stream is demonstrably live and mid-flight.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('connected');
    emitSse('test-feed', 'ping', { n: 1 });

    // THE BUG, stated as a fact about node: a response nobody ended has not "finished",
    // so before this change the request log had nothing to show for a live feed.
    expect(lines.filter((l) => l.message.includes('/api/v1/events') && !l.message.startsWith('SSE open')))
      .toEqual([]);
    // …but the OPEN is visible, which is the other half of the fix.
    expect(lines.some((l) => l.message === 'GET /api/v1/events')).toBe(false);
    expect(lines.some((l) => l.message.startsWith('SSE open GET /api/v1/events'))).toBe(true);

    controller.abort();
    await until(
      () => lines.some((l) => l.message.startsWith('GET /api/v1/events →')),
      'the stream to be logged when it ends',
    );
    const ended = lines.find((l) => l.message.startsWith('GET /api/v1/events →'))!;
    expect(ended.meta?.stream).toBe(true);
    expect(ended.meta?.aborted).toBe(true);
    expect(Number(ended.meta?.reqId)).not.toBeNaN;
  });

  it('the open line and the end line share a reqId, so one stream is one story', async () => {
    const port = await listen();
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { signal: controller.signal });
    await res.body!.getReader().read();
    const open = lines.find((l) => l.message.startsWith('SSE open'))!;
    controller.abort();
    await until(
      () => lines.some((l) => l.message.startsWith('GET /api/v1/events →')),
      'the end line',
    );
    const ended = lines.find((l) => l.message.startsWith('GET /api/v1/events →'))!;
    expect(open.meta?.reqId).toBeTruthy();
    expect(ended.meta?.reqId).toBe(open.meta?.reqId);
  });

  it('an ordinary JSON request still logs exactly once, and is not called a stream', async () => {
    const port = await listen();
    await (await fetch(`http://127.0.0.1:${port}/api/plain`)).json();
    await until(() => lines.some((l) => l.message.includes('/api/plain')), 'the plain line');
    // Give `close` (which fires after `finish`) a chance to double-log if the guard broke.
    await new Promise((r) => setTimeout(r, 50));
    const plain = lines.filter((l) => l.message.includes('/api/plain'));
    expect(plain).toHaveLength(1);
    expect(plain[0].meta?.stream).toBeUndefined();
    expect(plain[0].meta?.aborted).toBeUndefined();
  });
});
