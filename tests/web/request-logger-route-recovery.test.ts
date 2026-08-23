/**
 * The request logger's notification behavior — the nine-cards bug, end to end
 * through the real middleware (a fake req/res, not a whole server).
 *
 * Two contracts:
 *   1. A 5xx logs a STABLE message (normalized path, no latency, no query) plus a
 *      recoveryKey, so a repeat folds into ONE card that a later success can
 *      retire. The live feed had NINE `GET/PUT /api/ui-prefs → 500` cards for one
 *      condition because the old line embedded the duration.
 *   2. A <500 response signals recovery for a route that HAD failed — and does
 *      nothing at all otherwise. This runs on every request in the app, so the
 *      healthy path must not allocate, not publish, and not grow a map.
 *   3. 501 is the ONE exempt 5xx: it is this codebase's `not_supported_cloud`
 *      degradation (a deliberate answer, not a failure), so it logs at warn and
 *      is treated like a 4xx — never a card.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';

import {
  requestLogger, setRouteRecoveryPublisher, _resetRouteHealthForTest,
} from '../../src/web/middleware/request-logger.js';
import { errorHandler } from '../../src/web/middleware/error-handler.js';
import { setErrorNotificationSink } from '../../src/logging/subsystem.js';
import { log } from '../../src/logging/index.js';
import { dedupFingerprintForTest } from '../../src/core/notifications/log-error-bridge.js';

interface Logged { subsystem: string; message: string; meta?: Record<string, unknown> }

let errorLogs: Logged[] = [];
let recoveries: string[][] = [];

/** A minimal req/res pair that drives the middleware's res.on('finish') path. */
function fire(method: string, url: string, status: number, durationMs = 0): void {
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  (res as unknown as { statusCode: number }).statusCode = status;
  (res as unknown as Record<string, unknown>).setHeader = () => res;
  (res as unknown as Record<string, unknown>).getHeader = () => undefined;

  const [pathOnly, qs] = url.split('?');
  const query: Record<string, string> = {};
  for (const pair of (qs ?? '').split('&').filter(Boolean)) {
    const [k, v] = pair.split('=');
    query[k] = v ?? '';
  }
  const req = {
    method, originalUrl: url, path: pathOnly, query, headers: {},
  } as unknown as Request;

  // The middleware stamps `start = Date.now()` then reads it again in 'finish'.
  const real = Date.now;
  const t0 = real();
  vi.spyOn(Date, 'now').mockImplementation(() => t0);
  try {
    requestLogger(req, res, () => {});
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + durationMs);
    res.emit('finish');
  } finally {
    vi.mocked(Date.now).mockRestore?.();
    Date.now = real;
  }
}

beforeEach(() => {
  errorLogs = [];
  recoveries = [];
  // Tap the SAME sink the notification bridge installs, so this asserts on what
  // the bridge would actually fingerprint rather than on a paraphrase of it.
  setErrorNotificationSink((payload) => { errorLogs.push(payload); });
  setRouteRecoveryPublisher((keys) => { recoveries.push(keys); });
});

afterEach(() => {
  setErrorNotificationSink(null);
  setRouteRecoveryPublisher(null);
  _resetRouteHealthForTest();
});

describe('5xx → one stable, keyed error record', () => {
  it('THE BUG: two 500s differing only in latency and query log the SAME message', () => {
    fire('GET', '/api/ui-prefs?keys=layout', 500, 23);
    fire('GET', '/api/ui-prefs?keys=columns', 500, 1204);

    expect(errorLogs).toHaveLength(2);
    // Identical message → identical dedup fingerprint → ONE folded card, not two.
    expect(errorLogs[0].message).toBe(errorLogs[1].message);
    expect(errorLogs[0].message).toBe('GET /api/ui-prefs → 500');
    // The pieces that used to split the card now ride the meta, which is outside
    // the bridge's DEDUP_META_KEYS allowlist.
    expect(errorLogs[0].message).not.toMatch(/ms|keys=/);
    expect(errorLogs[0].meta?.ms).toBe(23);
    expect(errorLogs[1].meta?.ms).toBe(1204);
  });

  it('carries the route condition key, so a later success can retire the card', () => {
    fire('PUT', '/api/ui-prefs', 500);
    expect(errorLogs[0].meta?.recoveryKey).toBe('route:PUT /api/ui-prefs');
  });

  it('folds every entity of one failing route onto one condition', () => {
    fire('PUT', '/api/tasks/1784686852150/phase', 500);
    fire('PUT', '/api/tasks/1784686852999/phase', 500);
    expect(errorLogs[0].message).toBe(errorLogs[1].message);
    expect(errorLogs[0].message).toBe('PUT /api/tasks/:id/phase → 500');
    expect(errorLogs[0].meta?.recoveryKey).toBe('route:PUT /api/tasks/:id/phase');
  });

  it('keeps the RAW url in the meta — normalizing must not lose the diagnosis', () => {
    fire('GET', '/api/ui-prefs?keys=layout', 500);
    expect(errorLogs[0].meta?.url).toBe('/api/ui-prefs?keys=layout');
  });

  it('a DESIGNED 501 never becomes an error card, but is still in the log at warn', () => {
    // 501 has exactly one meaning in this codebase: `not_supported_cloud`, the
    // cloud replica answering honestly that a capability lives on the primary box
    // (search-memory-v1, console-v1, console-extras-v1, …). The route WORKS. As an
    // error it minted red cards for normal replica behavior — and those cards then
    // rode git-sync into the primary's feed, describing a condition that cannot
    // exist there.
    const warn = vi.spyOn(log.web, 'warn').mockImplementation(() => {});
    try {
      fire('GET', '/api/search-memory-v1', 501);
      expect(errorLogs).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('→ 501');
    } finally {
      warn.mockRestore();
    }
  });

  it('a 501 counts as the endpoint answering: it recovers a route that HAD failed', () => {
    fire('GET', '/api/search-memory-v1', 500);
    fire('GET', '/api/search-memory-v1', 501);
    expect(recoveries).toEqual([['route:GET /api/search-memory-v1']]);
  });

  it('every OTHER 5xx still becomes a keyed card', () => {
    for (const status of [500, 502, 503, 504]) {
      fire('GET', '/api/config', status);
    }
    expect(errorLogs).toHaveLength(4);
    expect(new Set(errorLogs.map((l) => l.meta?.recoveryKey)))
      .toEqual(new Set(['route:GET /api/config']));
  });

  it('4xx NEVER creates an error record at all', () => {
    // These log at warn, which the sink does not receive — so a wall of 404s from
    // a stale frontend can never become a wall of red cards.
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      fire('GET', '/api/tasks/nope', status);
    }
    expect(errorLogs).toEqual([]);
  });

  it('2xx/3xx never create an error record', () => {
    fire('GET', '/api/tasks', 200);
    fire('GET', '/api/tasks', 304);
    expect(errorLogs).toEqual([]);
  });
});

/**
 * A THROWN 5xx is logged twice — by errorHandler (which has the exception) and
 * again by the request logger when the response finishes. Both must land on ONE
 * card, or every route that throws shows the user two identical rows.
 */
describe('errorHandler + requestLogger converge on one card', () => {
  /** Drive errorHandler with a thrown error, ignoring its response write. */
  function fireThrown(method: string, url: string, err: Error & { status?: number }): void {
    const res = {
      status: () => res, json: () => res,
    } as unknown as Response;
    const req = { method, originalUrl: url, reqId: 'abc123' } as unknown as Request;
    errorHandler(err, req, res, () => {});
  }

  it('the two producers hash IDENTICALLY for the same failing request', () => {
    fireThrown('POST', '/api/tasks?dryRun=1', new Error('sqlite is locked'));
    fire('POST', '/api/tasks?dryRun=1', 500, 340);
    expect(errorLogs).toHaveLength(2);
    // Same message…
    expect(errorLogs[0].message).toBe('POST /api/tasks → 500');
    expect(errorLogs[1].message).toBe(errorLogs[0].message);
    // …and, through the bridge's REAL fingerprint rule, the same dedup identity —
    // so the second folds into the first instead of opening a second card.
    // (`status` used to ride errorHandler's meta only, and it IS in the dedup
    // allowlist, so the two hashed differently and produced two rows.)
    expect(dedupFingerprintForTest(errorLogs[1] as never))
      .toBe(dedupFingerprintForTest(errorLogs[0] as never));
  });

  it('errorHandler keys a 5xx and carries the exception message as context', () => {
    fireThrown('PUT', '/api/tasks/1784686852150/phase', new Error('phase not allowed'));
    expect(errorLogs[0].message).toBe('PUT /api/tasks/:id/phase → 500');
    expect(errorLogs[0].meta?.recoveryKey).toBe('route:PUT /api/tasks/:id/phase');
    expect(errorLogs[0].meta?.message).toBe('phase not allowed');
    expect(errorLogs[0].meta?.url).toBe('/api/tasks/1784686852150/phase');
  });

  it('errorHandler folds two DIFFERENT causes on one endpoint into one condition', () => {
    // One row that shows the latest cause, not a growing list. The endpoint is the
    // condition; which exception it threw today is the body.
    fireThrown('POST', '/api/tasks', new Error('sqlite is locked'));
    fireThrown('POST', '/api/tasks', new Error('disk quota exceeded'));
    expect(dedupFingerprintForTest(errorLogs[1] as never))
      .toBe(dedupFingerprintForTest(errorLogs[0] as never));
  });

  it('a thrown 4xx gets NO key (a client problem has no endpoint recovery)', () => {
    const err = Object.assign(new Error('bad request'), { status: 400 });
    fireThrown('POST', '/api/tasks', err);
    expect(errorLogs[0].meta?.recoveryKey).toBeUndefined();
    // …and no stack either: a 400 is not a server defect worth a stack dump.
    expect(errorLogs[0].meta?.stack).toBeUndefined();
  });
});

describe('recovery edge on a healthy response', () => {
  it('500 then 200 on the same route publishes the recovery ONCE', () => {
    fire('GET', '/api/ui-prefs?keys=a', 500);
    expect(recoveries).toEqual([]);

    fire('GET', '/api/ui-prefs?keys=b', 200);
    expect(recoveries).toEqual([['route:GET /api/ui-prefs']]);

    // Steady healthy traffic afterwards must not keep signalling — each signal is
    // a locked read-modify-write of notifications.json.
    for (let i = 0; i < 100; i++) fire('GET', '/api/ui-prefs', 200);
    expect(recoveries).toHaveLength(1);
  });

  it('HOT PATH: a route that never failed never publishes anything', () => {
    for (let i = 0; i < 500; i++) fire('GET', `/api/tasks/${i}`, 200);
    expect(recoveries).toEqual([]);
  });

  it('a 4xx counts as recovered — the endpoint is reachable and reasoning again', () => {
    fire('POST', '/api/sessions/start-quick', 500);
    fire('POST', '/api/sessions/start-quick', 400);
    expect(recoveries).toEqual([['route:POST /api/sessions/start-quick']]);
  });

  it('does NOT recover a DIFFERENT route or a different method', () => {
    fire('GET', '/api/ui-prefs', 500);
    fire('PUT', '/api/ui-prefs', 200);          // same path, other method
    fire('GET', '/api/tasks', 200);             // other path
    expect(recoveries).toEqual([]);
    fire('GET', '/api/ui-prefs', 200);
    expect(recoveries).toEqual([['route:GET /api/ui-prefs']]);
  });

  it('recovers per-route when several are failing', () => {
    fire('GET', '/api/ui-prefs', 500);
    fire('PUT', '/api/ui-prefs', 500);
    fire('PUT', '/api/ui-prefs', 200);
    expect(recoveries).toEqual([['route:PUT /api/ui-prefs']]);
    fire('GET', '/api/ui-prefs', 200);
    expect(recoveries).toEqual([
      ['route:PUT /api/ui-prefs'],
      ['route:GET /api/ui-prefs'],
    ]);
  });

  it('re-arms: fail → recover → fail → recover', () => {
    for (let episode = 0; episode < 3; episode++) {
      fire('GET', '/api/flappy', 500);
      fire('GET', '/api/flappy', 200);
    }
    expect(recoveries).toHaveLength(3);
  });

  it('matches an entity-id request against the route that failed', () => {
    // The failure and the success are almost never the same entity, so the key
    // must collapse ids for the edge to be detected at all.
    fire('GET', '/api/sessions/aaaaaaaaaaaaaaaa/history?tail=400', 500);
    fire('GET', '/api/sessions/bbbbbbbbbbbbbbbb/history', 200);
    expect(recoveries).toEqual([['route:GET /api/sessions/:id/history']]);
  });

  it('with no publisher wired, a healthy response is a harmless no-op', () => {
    setRouteRecoveryPublisher(null);
    fire('GET', '/api/ui-prefs', 500);
    expect(() => fire('GET', '/api/ui-prefs', 200)).not.toThrow();
  });

  it('setRouteRecoveryPublisher clears the failing memory (a fresh server saw nothing)', () => {
    // Tests start several in-process servers; a leftover "failing" entry would make
    // the NEW server's first healthy response fire a recovery for a condition it
    // never observed.
    fire('GET', '/api/ui-prefs', 500);
    setRouteRecoveryPublisher((keys) => { recoveries.push(keys); });
    fire('GET', '/api/ui-prefs', 200);
    expect(recoveries).toEqual([]);
  });
});
