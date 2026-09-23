/**
 * Fetch admission control (web/src/api/client.ts).
 *
 * Browsers cap HTTP/1.1 at 6 connections per origin; excess fetches used to
 * queue inside the browser with their 15s abort timers already running, so a
 * burst (WS-reconnect refresh × open sessions) turned into "FAILED after 15s"
 * for requests the server never saw. The client now gates concurrency itself:
 *  - at most 6 fetches dispatched at once, the rest queue client-side
 *  - the timeout timer starts at DISPATCH, not at enqueue
 *  - writes (non-GET) jump the queue ahead of background GETs, UNLESS the caller
 *    marks them `background: true` (2026-09-17 — see the `background` block below)
 *  - `priority: 'low'` GETs (palette lists, workflow reconstruction) never hold
 *    more than 2 slots and never leave ahead of a waiting normal request
 *    (2026-09-23 — see the low-lane block at the end)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// jsdom-free: the client only needs fetch/AbortSignal/performance, all present
// in the node test environment.
import { apiGet, apiPost, getFetchQueueStats, getLowFetchQueueStats } from '../../web/src/api/client';
// The real product call site for `background: true`. tasks.ts pulls in the session
// status store, which is DOM-free too, so it loads in this tier unchanged.
import { quickParseTask } from '../../web/src/api/tasks';

type Resolver = { resolve: (r: Response) => void; url: string };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetch admission control', () => {
  let pending: Resolver[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pending = [];
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return new Promise<Response>((resolve) => {
        pending.push({ resolve, url });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    // Drain anything still queued so state doesn't leak across tests.
    while (pending.length > 0 || getFetchQueueStats().queued > 0) {
      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await new Promise((r) => setTimeout(r, 0));
    }
    vi.unstubAllGlobals();
  });

  it('dispatches at most 6 concurrent fetches; the rest wait client-side', async () => {
    const results = Array.from({ length: 10 }, (_, i) => apiGet(`/api/t${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 4 });

    // Completing one dispatches exactly one more.
    pending.shift()!.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(7);

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all(results);
  });

  it('non-GET jumps the queue ahead of waiting GETs', async () => {
    const all = Array.from({ length: 8 }, (_, i) => apiGet(`/api/g${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats().queued).toBe(2);

    const patch = apiPost('/api/write-op', { x: 1 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    // Free one slot → the write must dispatch before the 2 queued GETs.
    pending.shift()!.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    const dispatched = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(dispatched[6]).toBe('/api/write-op');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all([...all, patch]);
  });

  it('caller abort while queued removes the entry without dispatching', async () => {
    const blockers = Array.from({ length: 6 }, (_, i) => apiGet(`/api/b${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));

    const ctrl = new AbortController();
    const queued = apiGet('/api/late', undefined, { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats().queued).toBe(1);

    ctrl.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(getFetchQueueStats().queued).toBe(0);
    // Never dispatched.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain('/api/late');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all(blockers);
  });

  it('timeout timer starts at dispatch: a queued request outlives its own timeout budget while waiting', async () => {
    // AbortSignal.timeout uses the platform clock (not vitest fake timers), so
    // this test runs on real time with a tiny budget: a request with a 150ms
    // timeout that waits ~400ms in the queue must NOT fail — proof the timer
    // only starts at dispatch. Under the old model (timer starts at enqueue)
    // it would be long dead before dispatch.
    const blockers = Array.from({ length: 6 }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));

    const waited = apiGet('/api/waited', undefined, { timeoutMs: 150 });
    const waitedSettled = waited.then(() => 'ok', (e) => (e as Error).name);
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats().queued).toBe(1);

    // Hold it in the queue well past its own 150ms budget.
    await new Promise((r) => setTimeout(r, 400));
    expect(getFetchQueueStats().queued).toBe(1); // still waiting, not timed out

    pending.shift()!.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 20));
    const idx = fetchMock.mock.calls.findIndex((c) => String(c[0]) === '/api/waited');
    expect(idx).toBeGreaterThanOrEqual(0);
    // Answer within its (fresh) 150ms budget.
    pending.find((p) => p.url === '/api/waited')!.resolve(jsonResponse({ ok: true }));
    pending = pending.filter((p) => p.url !== '/api/waited');
    expect(await waitedSettled).toBe('ok');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all(blockers);
  });

  it('a request that waits out the queue budget fails as a retryable TimeoutError AND names itself in the log', async () => {
    // The 2026-09-17 folder-registry outage: six slow requests pinned the pool
    // while a boot burst queued behind them; everything past 20s was rejected
    // HERE, before attemptRequest, so no "[api] … FAILED" line was ever written
    // and the only evidence was the server's request log NOT containing the
    // request. The rejection must (a) say which request died, with the queue
    // state, and (b) be classified retryable, because the request never left
    // the browser and asking again is always safe.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const blockers = Array.from({ length: 6 }, (_, i) => apiGet(`/api/pinned${i}`).catch(() => {}));
      await vi.advanceTimersByTimeAsync(0);
      const starved = apiGet('/api/tasks/groups').then(() => 'ok', (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      expect(getFetchQueueStats().queued).toBe(1);

      await vi.advanceTimersByTimeAsync(19_999);
      expect(getFetchQueueStats().queued).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      const err = (await starved) as DOMException;
      expect(err).toBeInstanceOf(DOMException);
      expect(err.name).toBe('TimeoutError');
      expect(err.message).toContain('pool saturated');
      expect(getFetchQueueStats().queued).toBe(0);
      // The server never saw it.
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/tasks/groups')).toBe(false);

      const line = errorSpy.mock.calls.find((c) => String(c[0]).includes('/api/tasks/groups'));
      expect(line, 'a queue rejection must be logged with the request it killed').toBeDefined();
      expect(String(line![0])).toContain('GET /api/tasks/groups rejected after 20000ms in the connection queue (pool saturated)');
      expect(line![1]).toEqual({ queued: 0, queuedLow: 0, inFlight: 6, priority: 'normal' });

      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(blockers);
    } finally {
      vi.useRealTimers();
      errorSpy.mockRestore();
    }
  });

  // ── `background: true` — a write nobody is waiting on stops outranking paint ──
  // Before this flag EVERY non-GET jumped the queue, and the draft composer's
  // per-keystroke AI parse is a POST that holds its slot for a full 10s model
  // timeout. A continuous sentence therefore parked six of those at the head of
  // the queue and the GETs painting the screen never got a connection
  // (2026-09-17). The three cases below pin the FIFO half, the anti-starvation
  // half, and the slot accounting when a queued background write is aborted.

  it('a background write stays FIFO while a normal write still jumps the queue', async () => {
    // Starting state: gate idle. Six GETs take every slot, then two more GETs
    // queue (these are "the screen"), then one background POST, then one ordinary
    // (user-action) POST.
    const blockers = Array.from({ length: 6 }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(6);

    const paints = [apiGet('/api/paint0').catch(() => {}), apiGet('/api/paint1').catch(() => {})];
    const background = apiPost('/api/tasks/quick-parse', { text: 'x' }, { background: true }).catch(() => {});
    const userWrite = apiPost('/api/tasks/save', { text: 'x' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 4 });

    // Free the pool one connection at a time and record the dispatch order.
    for (let i = 0; i < 4; i++) {
      pending.shift()!.resolve(jsonResponse({}));
      await new Promise((r) => setTimeout(r, 0));
    }
    const order = fetchMock.mock.calls.slice(6).map((c) => String(c[0]));
    expect(order).toEqual([
      '/api/tasks/save',      // user action — still jumps to the front
      '/api/paint0',          // …then the screen, in the order it asked
      '/api/paint1',
      '/api/tasks/quick-parse', // background write goes LAST (old code: first)
    ]);

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all([...blockers, ...paints, background, userWrite]);
  });

  it('quickParseTask is wired as a background write, so it does not outrank the screen', async () => {
    // Starting state: gate idle. Same assertion as above but through the real
    // product call site — the flag is only useful if the caller actually passes it.
    const blockers = Array.from({ length: 6 }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));

    const paint = apiGet('/api/files/list', { path: '/' }).catch(() => {});
    const parse = quickParseTask('lunch with sam tomorrow 12pm').catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 2 });

    pending.shift()!.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    expect(String(fetchMock.mock.calls[6][0])).toBe('/api/files/list?path=%2F');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all([...blockers, paint, parse]);
  });

  it('background writes saturating all 6 slots cannot starve a GET behind them', async () => {
    // Starting state: gate idle. Six background POSTs (the per-keystroke parse
    // burst) hold every connection; a GET queues; then ANOTHER keystroke's POST
    // arrives. Under the old "every non-GET is urgent" rule that late POST
    // unshifted ahead of the GET, and a continuous sentence repeated that forever
    // — the GET was starved for as long as the user kept typing.
    const saturate = Array.from({ length: 6 }, (_, i) =>
      apiPost(`/api/tasks/quick-parse?k=${i}`, { text: `k${i}` }, { background: true }).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 0 });

    const paint = apiGet('/api/tasks/groups').catch(() => {});
    const laterKeystroke = apiPost('/api/tasks/quick-parse?k=6', { text: 'k6' }, { background: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 2 });

    pending.shift()!.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    // Queue order, not write-priority order: the GET is next.
    expect(String(fetchMock.mock.calls[6][0])).toBe('/api/tasks/groups');
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain('/api/tasks/quick-parse?k=6');

    pending.shift()!.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    expect(String(fetchMock.mock.calls[7][0])).toBe('/api/tasks/quick-parse?k=6');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all([...saturate, paint, laterKeystroke]);
  });

  it('aborting a queued background write drops it and leaks no slot', async () => {
    // Starting state: gate idle. A superseded keystroke parse aborts while still
    // queued — the common case, since the composer aborts the previous parse on
    // every new fire. If that path forgot the accounting, the pool would shrink by
    // one connection per keystroke and the app would wedge with zero in flight.
    const blockers = Array.from({ length: 6 }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));

    const ctrl = new AbortController();
    const superseded = apiPost('/api/tasks/quick-parse', { text: 'lunch wi' }, {
      background: true, signal: ctrl.signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 1 });

    ctrl.abort();
    await expect(superseded).rejects.toMatchObject({ name: 'AbortError' });
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 0 });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain('/api/tasks/quick-parse');

    // Drain the pool: accounting must return to exactly zero…
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all(blockers);
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 });

    // …and all six connections must still be acquirable afterwards.
    const after = Array.from({ length: 6 }, (_, i) => apiGet(`/api/after${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 0 });
    expect(fetchMock.mock.calls.slice(-6).map((c) => String(c[0]))).toEqual(
      Array.from({ length: 6 }, (_, i) => `/api/after${i}`));

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all(after);
  });

  // ── low-priority lane (2026-09-23) ─────────────────────────────────────────
  // A reload handed three of the six connections to the "/" palette's skill list
  // (1.2MB, up to 11s) and session slash commands (13.5s); the task list and the
  // draft's quick folders waited behind them for 10.8s / 5s.

  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('low GETs never hold more than 2 slots, even on an idle gate', async () => {
    // Starting state: gate idle. Five low reads arrive together.
    const lows = Array.from({ length: 5 }, (_, i) => apiGet(`/api/low${i}`, undefined, { priority: 'low' }).catch(() => {}));
    await tick();
    expect(urls()).toEqual(['/api/low0', '/api/low1']);
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 2, queued: 3 });
    expect(getFetchQueueStats()).toEqual({ inFlight: 2, queued: 3 });

    // The other four connections stay free for what paints the screen: a
    // normal GET leaves immediately, ahead of every queued low one.
    const paint = apiGet('/api/tasks').catch(() => {});
    await tick();
    expect(urls()[2]).toBe('/api/tasks');
    expect(getFetchQueueStats()).toEqual({ inFlight: 3, queued: 3 });

    // Finishing one low read lets exactly one more low read go.
    pending.find((p) => p.url === '/api/low0')!.resolve(jsonResponse({}));
    pending.splice(pending.findIndex((p) => p.url === '/api/low0'), 1);
    await tick();
    expect(urls()).toHaveLength(4);
    expect(urls()[3]).toBe('/api/low2');
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 2, queued: 2 });

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await tick();
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await tick();
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all([...lows, paint]);
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 });
  });

  it('a queued low GET never leaves ahead of a queued normal one, whatever the arrival order', async () => {
    // Starting state: six normal reads hold the pool. A low read queues FIRST,
    // then a normal one.
    const hold = Array.from({ length: 6 }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await tick();
    const low = apiGet('/api/skills', undefined, { priority: 'low' }).catch(() => {});
    const normal = apiGet('/api/working-dirs').catch(() => {});
    await tick();
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 2 });

    pending.shift()!.resolve(jsonResponse({}));
    await tick();
    expect(urls()[6]).toBe('/api/working-dirs');
    expect(urls()).not.toContain('/api/skills');

    pending.shift()!.resolve(jsonResponse({}));
    await tick();
    expect(urls()[7]).toBe('/api/skills');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all([...hold, low, normal]);
  });

  it('a new low GET queues behind a waiting low one instead of taking a free slot first', async () => {
    // Two low reads in flight (the cap), one low read waiting; a normal read
    // finishes and frees a general slot. A new low read must not use the free
    // slot to overtake the one already waiting (or break the cap).
    const lows = [0, 1, 2].map((i) => apiGet(`/api/low${i}`, undefined, { priority: 'low' }).catch(() => {}));
    await tick();
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 2, queued: 1 });
    const late = apiGet('/api/low3', undefined, { priority: 'low' }).catch(() => {});
    await tick();
    expect(urls()).toEqual(['/api/low0', '/api/low1']);
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 2, queued: 2 });

    pending.shift()!.resolve(jsonResponse({}));
    await tick();
    expect(urls()[2]).toBe('/api/low2');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await tick();
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all([...lows, late]);
  });

  it('onDispatch fires when the request leaves the queue, not when it is asked for', async () => {
    const hold = Array.from({ length: 6 }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await tick();
    const onDispatch = vi.fn();
    const queued = apiGet('/api/tasks', undefined, { onDispatch }).catch(() => {});
    await tick();
    expect(onDispatch).not.toHaveBeenCalled();

    pending.shift()!.resolve(jsonResponse({}));
    await tick();
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(urls()[6]).toBe('/api/tasks');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all([...hold, queued]);
  });

  it('aborting or failing low GETs returns both lanes to zero', async () => {
    // One low read fails on the wire (HTTP 500), one is aborted while queued
    // behind the cap: neither may leak a general or a low slot.
    const ctrl = new AbortController();
    const a = apiGet('/api/low-a', undefined, { priority: 'low' }).catch(() => 'failed');
    const b = apiGet('/api/low-b', undefined, { priority: 'low' }).catch(() => {});
    const aborted = apiGet('/api/low-c', undefined, { priority: 'low', signal: ctrl.signal });
    await tick();
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 2, queued: 1 });

    ctrl.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 2, queued: 0 });

    pending.find((p) => p.url === '/api/low-a')!.resolve(new Response('boom', { status: 500 }));
    pending.find((p) => p.url === '/api/low-b')!.resolve(jsonResponse({}));
    pending.splice(0);
    expect(await a).toBe('failed');
    await b;
    await tick();
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 });
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 });
    expect(urls()).not.toContain('/api/low-c');

    // The cap is intact afterwards: two low reads leave at once again.
    const again = [0, 1, 2].map((i) => apiGet(`/api/again${i}`, undefined, { priority: 'low' }).catch(() => {}));
    await tick();
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 2, queued: 1 });
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await tick();
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all(again);
  });
});
