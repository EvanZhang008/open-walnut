/**
 * A response that is NEVER ENDED used to log nothing at all.
 *
 * `res.on('finish')` fires when `res.end()` has been called. An SSE stream is ended by
 * the client going away: `attachSse` cleans up on the request's `close` and never ends
 * the response. So every streaming endpoint in this app — `/api/v1/events`, the session
 * and conversation streams — produced ZERO lines in the request log over its entire
 * life. A phone feed that opened and died every two seconds was plainly visible on the
 * phone and completely invisible on the server, which is the wrong way round: the server
 * is where someone looks when the phone says the feed is broken.
 *
 * Two things have to be true, and they pull against each other: a never-ended response
 * must produce a line, and an ordinary response must not produce two.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';

import {
  requestLogger, setRouteRecoveryPublisher, _resetRouteHealthForTest,
} from '../../src/web/middleware/request-logger.js';

import { setErrorNotificationSink } from '../../src/logging/subsystem.js';
import { log } from '../../src/logging/index.js';
import { resetMetrics, snapshot } from '../../src/core/observability/metrics.js';

interface Logged { message: string; meta?: Record<string, unknown> }

let infoLines: Logged[] = [];
let errorLines: Logged[] = [];
let recoveries: string[][] = [];

/**
 * Start a request through the middleware and hand back the levers a test needs:
 * which events to emit, and in which order.
 */
function start(opts: {
  method?: string
  url?: string
  status?: number
  contentType?: string
  headersSent?: boolean
}) {
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  (res as unknown as { statusCode: number }).statusCode = opts.status ?? 200;
  (res as unknown as { headersSent: boolean }).headersSent = opts.headersSent ?? true;
  (res as unknown as Record<string, unknown>).setHeader = () => res;
  (res as unknown as Record<string, unknown>).getHeader = (name: string) =>
    (name === 'content-type' ? opts.contentType : undefined);

  const url = opts.url ?? '/api/v1/events';
  const req = {
    method: opts.method ?? 'GET',
    originalUrl: url,
    path: url.split('?')[0],
    query: {},
    headers: {},
  } as unknown as Request;

  requestLogger(req, res, () => {});
  return {
    finish: () => res.emit('finish'),
    close: () => res.emit('close'),
  };
}

beforeEach(() => {
  infoLines = [];
  errorLines = [];
  recoveries = [];
  resetMetrics();
  vi.spyOn(log.web, 'info').mockImplementation((message, meta) => {
    infoLines.push({ message: String(message), meta: meta as Record<string, unknown> });
  });
  setErrorNotificationSink((payload) => { errorLines.push(payload as unknown as Logged); });
  setRouteRecoveryPublisher((keys) => { recoveries.push(keys); });
});

afterEach(() => {
  vi.restoreAllMocks();
  setErrorNotificationSink(null);
  setRouteRecoveryPublisher(null);
  _resetRouteHealthForTest();
  resetMetrics();
});

describe('a response nobody ends is still logged', () => {
  it('THE BUG: an SSE stream that only ever closes produces a line', () => {
    const req = start({ contentType: 'text/event-stream' });
    req.close();
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0].message).toBe('GET /api/v1/events → 200 (0ms)');
  });

  it('says the connection went away rather than the response ending', () => {
    const req = start({ contentType: 'text/event-stream' });
    req.close();
    expect(infoLines[0].meta?.aborted).toBe(true);
    expect(infoLines[0].meta?.stream).toBe(true);
  });

  it('records whether the client got any of the response', () => {
    // A client that hung up before we answered is a different diagnosis from one that
    // read half a stream, and `statusCode` cannot tell them apart: it is 200 by default
    // whether or not we ever sent it.
    const req = start({ url: '/api/tasks', headersSent: false });
    req.close();
    expect(infoLines[0].meta?.sent).toBe(false);
  });
});

describe('and an ordinary response is still logged exactly once', () => {
  it('finish then close is ONE line, not two', () => {
    // `close` fires after `finish` for every normal response, so a second bare
    // listener would have doubled the entire request log.
    const req = start({ url: '/api/tasks', status: 200 });
    req.finish();
    req.close();
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0].meta?.aborted).toBeUndefined();
  });

  it('a normal response never claims to be a stream', () => {
    const req = start({ url: '/api/tasks', contentType: 'application/json' });
    req.finish();
    expect(infoLines[0].meta?.stream).toBeUndefined();
  });

  it('a 5xx that then aborts still becomes exactly one keyed card', () => {
    const req = start({ url: '/api/tasks', status: 500 });
    req.finish();
    req.close();
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0].meta?.recoveryKey).toBe('route:GET /api/tasks');
  });

  it('a 5xx that ONLY aborts is not silent either', () => {
    const req = start({ url: '/api/tasks', status: 500 });
    req.close();
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0].meta?.aborted).toBe(true);
  });
});

describe('an abort is not an answer', () => {
  it('a client that hung up before we replied does NOT retire the route\'s error card', () => {
    // The recovery edge exists because "the endpoint responded" retires a red card. An
    // aborted request never responded, and `statusCode` cannot say so on its own: it
    // reads 200 by default whether or not we ever used it. Clearing a card for a route
    // that is still broken is worse than leaving it up.
    const failing = start({ url: '/api/tasks', status: 500 });
    failing.finish();
    expect(recoveries).toEqual([]);

    const hungUp = start({ url: '/api/tasks', headersSent: false });
    hungUp.close();
    expect(recoveries).toEqual([]);
  });

  it('…but a stream that really answered and THEN died does count as recovery', () => {
    const failing = start({ url: '/api/v1/events', status: 500 });
    failing.finish();
    const stream = start({ contentType: 'text/event-stream', headersSent: true });
    stream.close();
    expect(recoveries).toEqual([['route:GET /api/v1/events']]);
  });
});

describe("a stream's lifetime is not a latency", () => {
  it('a stream measures into http.sse, leaving the latency histogram alone', () => {
    // An SSE feed held open for hours would otherwise land an hours-long sample in the
    // series every dashboard reads as "this route is slow".
    const req = start({ contentType: 'text/event-stream' });
    req.close();
    const names = snapshot().series.map((s) => s.name);
    expect(names).toContain('http.sse');
    expect(names).not.toContain('http.request');
  });

  it('an ordinary request still measures into http.request', () => {
    const req = start({ url: '/api/tasks', contentType: 'application/json' });
    req.finish();
    const names = snapshot().series.map((s) => s.name);
    expect(names).toContain('http.request');
    expect(names).not.toContain('http.sse');
  });

  it('the stream series keeps the route label, so one bad feed is identifiable', () => {
    const req = start({ contentType: 'text/event-stream' });
    req.close();
    const series = snapshot().series.find((s) => s.name === 'http.sse');
    expect(series?.labels?.route).toBe('/api/v1/events');
  });
});
