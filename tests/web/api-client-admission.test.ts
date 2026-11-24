/**
 * Fetch admission control (web/src/api/client.ts).
 *
 * Browsers cap HTTP/1.1 at 6 connections per origin; excess fetches used to
 * queue inside the browser with their 15s abort timers already running, so a
 * burst (WS-reconnect refresh × open sessions) turned into "FAILED after 15s"
 * for requests the server never saw. The client now gates concurrency itself:
 *  - at most 6 fetches dispatched at once, the rest queue client-side: every
 *    request shares 5 of them (SHARED_FETCH_SLOTS) and the 6th is kept for a
 *    `priority: 'interactive'` GET, the read the person is waiting on; in the shared
 *    slots it waits its turn (2026-11-16, see the reserved-slot block at the end)
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
import { apiGet, apiPost, fetchLaneRaised, getFetchQueueStats, getLowFetchQueueStats, SHARED_FETCH_SLOTS, type FetchLane } from '../../web/src/api/client';
// The real product call site for `background: true`. tasks.ts pulls in the session
// status store, which is DOM-free too, so it loads in this tier unchanged.
import { quickParseTask } from '../../web/src/api/tasks';
import { fetchDirListMany } from '../../web/src/api/files';

type Resolver = { resolve: (r: Response) => void; url: string };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('suspended GET admission', () => {
  let win: EventTarget;
  let calls: string[];
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    win = new EventTarget();
    calls = [];
    vi.stubGlobal('window', win);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve(jsonResponse({}));
    }));
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('aborts suspended normal and low reads without leaving timers or listeners', async () => {
    const client = await import('../../web/src/api/client');
    win.dispatchEvent(new Event('pagehide'));
    const controllers = [new AbortController(), new AbortController()];
    const removed = controllers.map(ctrl => vi.spyOn(ctrl.signal, 'removeEventListener'));
    const reads = controllers.map((ctrl, i) => client.apiGet(`/api/abort/${i}`, undefined, {
      signal: ctrl.signal, ...(i ? { priority: 'low' as const } : {}),
    }).catch(error => error));
    expect(client.getFetchQueueStats()).toEqual({ inFlight: 0, queued: 2 });
    controllers.forEach(ctrl => ctrl.abort());
    expect((await Promise.all(reads)).map(error => error.name)).toEqual(['AbortError', 'AbortError']);
    removed.forEach(spy => expect(spy).toHaveBeenCalledWith('abort', expect.any(Function)));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    win.dispatchEvent(new Event('pageshow'));
    expect(calls).toEqual([]);
    expect(client.getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 });
  });

  it('retains both absolute budgets when restored before timers resume', async () => {
    const client = await import('../../web/src/api/client');
    const initial = Date.now();
    win.dispatchEvent(new Event('pagehide'));
    const normal = client.apiGet('/api/normal-expired').catch(error => error);
    const low = client.apiGet('/api/low-expired', undefined, { priority: 'low' }).catch(error => error);
    vi.setSystemTime(initial + 60_001);
    win.dispatchEvent(new Event('pageshow'));
    expect((await normal).name).toBe('TimeoutError');
    expect((await low).name).toBe('TimeoutError');
    expect(calls).toEqual([]);
    expect(client.getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 });
    expect(errorSpy.mock.calls.map(row => String(row[0]))).toEqual([
      expect.stringContaining('after 20000ms in the connection queue (page suspended)'),
      expect.stringContaining('after 60000ms in the connection queue (page suspended)'),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not renew the original budget when a granted slot suspends', async () => {
    const client = await import('../../web/src/api/client');
    const started = Date.now();
    const read = client.apiGet('/api/granted').catch(error => error);
    vi.setSystemTime(started + 19_000);
    win.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getFetchQueueStats()).toEqual({ inFlight: 0, queued: 1 });
    await vi.advanceTimersByTimeAsync(999);
    expect(client.getFetchQueueStats().queued).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await read).name).toBe('TimeoutError');
    win.dispatchEvent(new Event('pageshow'));
    expect(calls).toEqual([]);
    expect(String(errorSpy.mock.calls[0][0])).toContain('page suspended');
  });

  it('keeps the original queue deadline across grant and requeue', async () => {
    const client = await import('../../web/src/api/client');
    const started = Date.now();
    win.dispatchEvent(new Event('pagehide'));
    const read = client.apiGet('/api/requeued').catch(error => error);
    vi.setSystemTime(started + 19_000);
    win.dispatchEvent(new Event('pageshow'));
    win.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getFetchQueueStats()).toEqual({ inFlight: 0, queued: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await read).name).toBe('TimeoutError');
    expect(calls).toEqual([]);
  });

  it('lets background POSTs pass a suspended GET head in either lane', async () => {
    const client = await import('../../web/src/api/client');
    const pending: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      calls.push(url);
      if (url.startsWith('/api/block/')) return new Promise<Response>(resolve => { pending.push(() => resolve(jsonResponse({}))); });
      return Promise.resolve(jsonResponse({}));
    }));
    const blockers = Array.from({ length: client.SHARED_FETCH_SLOTS }, (_, i) => client.apiGet(`/api/block/${i}`).catch(() => undefined));
    await vi.advanceTimersByTimeAsync(0);
    const reads = [client.apiGet('/api/held-normal').catch(error => error),
      client.apiGet('/api/held-low', undefined, { priority: 'low' }).catch(error => error)];
    const posts = [client.apiPost('/api/post-normal', {}, { background: true }).catch(error => error),
      client.apiPost('/api/post-low', {}, { background: true, priority: 'low' }).catch(error => error)];
    win.dispatchEvent(new Event('pagehide'));
    pending.splice(0).forEach(resolve => resolve());
    await Promise.all(blockers);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(posts);
    expect(calls.slice(client.SHARED_FETCH_SLOTS)).toEqual(['/api/post-normal', '/api/post-low']);
    expect(client.getFetchQueueStats()).toEqual({ inFlight: 0, queued: 2 });
    win.dispatchEvent(new Event('pageshow'));
    await Promise.all(reads);
    expect(calls.slice(client.SHARED_FETCH_SLOTS + 2)).toEqual(['/api/held-normal', '/api/held-low']);
    expect(client.getLowFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 });
    expect(client.getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 });
  });
});

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

  it('directory background POSTs use at most two slots and yield to a user write', async () => {
    const reads = Array.from({ length: 5 }, (_, i) => fetchDirListMany([`/repo-${i}`], 'remote', false, { background: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 2, queued: 3 });
    const write = apiPost('/api/user-write', { value: 'typed' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toContain('/api/user-write');
    pending.find(p => p.url === '/api/user-write')!.resolve(jsonResponse({ ok: true }));
    pending = pending.filter(p => p.url !== '/api/user-write');
    await write;
    while (pending.length || getFetchQueueStats().queued) {
      for (const p of pending.splice(0)) p.resolve(jsonResponse({ listings: [], truncated: false, timedOut: false }));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await Promise.all(reads);
  });

  it('normal fetches fill every shared slot and no more; the rest wait client-side', async () => {
    const results = Array.from({ length: SHARED_FETCH_SLOTS + 4 }, (_, i) => apiGet(`/api/t${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(SHARED_FETCH_SLOTS);
    expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 4 });

    // Completing one dispatches exactly one more.
    pending.shift()!.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(SHARED_FETCH_SLOTS + 1);

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all(results);
  });

  it('non-GET jumps the queue ahead of waiting GETs', async () => {
    const all = Array.from({ length: SHARED_FETCH_SLOTS + 2 }, (_, i) => apiGet(`/api/g${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats().queued).toBe(2);

    const patch = apiPost('/api/write-op', { x: 1 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));

    // Free one slot → the write must dispatch before the 2 queued GETs.
    pending.shift()!.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    const dispatched = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(dispatched[SHARED_FETCH_SLOTS]).toBe('/api/write-op');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all([...all, patch]);
  });

  it('caller abort while queued removes the entry without dispatching', async () => {
    const blockers = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/b${i}`).catch(() => {}));
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
    const blockers = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));

    const waited = apiGet('/api/waited', undefined, { timeoutMs: 150 });
    const waitedSettled = waited.then(() => 'ok', (e) => (e as Error).name);
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats().queued).toBe(1);

    // Hold it in the queue well past its own 150ms budget.
    await new Promise((r) => setTimeout(r, 400));
    expect(getFetchQueueStats().queued).toBe(1); // still waiting, not timed out

    pending.shift()!.resolve(jsonResponse({}));
    await vi.waitFor(() => {
      const idx = fetchMock.mock.calls.findIndex((c) => String(c[0]) === '/api/waited');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(pending.some((p) => p.url === '/api/waited')).toBe(true);
    }, { timeout: 10_000, interval: 5 });
    // Answer within its (fresh) 150ms budget.
    pending.find((p) => p.url === '/api/waited')!.resolve(jsonResponse({ ok: true }));
    pending = pending.filter((p) => p.url !== '/api/waited');
    expect(await waitedSettled).toBe('ok');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all(blockers);
  });

  it('a request that waits out the queue budget fails as a retryable TimeoutError AND names itself in the log', async () => {
    // The 2026-09-17 folder-registry outage: six slow requests pinned the pool
    // (today the shared slots are what pins it)
    // while a boot burst queued behind them; everything past 20s was rejected
    // HERE, before attemptRequest, so no "[api] … FAILED" line was ever written
    // and the only evidence was the server's request log NOT containing the
    // request. The rejection must (a) say which request died, with the queue
    // state, and (b) be classified retryable, because the request never left
    // the browser and asking again is always safe.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const blockers = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/pinned${i}`).catch(() => {}));
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
      // It names what held the connections, longest first, so a saturation says its cause.
      expect(line![1]).toEqual({
        queued: 0, queuedLow: 0, inFlight: SHARED_FETCH_SLOTS, priority: 'normal',
        holding: Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => `GET /api/pinned${i} 20000ms`),
      });

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
    // Starting state: gate idle. GETs take every shared slot, then two more GETs
    // queue (these are "the screen"), then one background POST, then one ordinary
    // (user-action) POST.
    const blockers = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(SHARED_FETCH_SLOTS);

    const paints = [apiGet('/api/paint0').catch(() => {}), apiGet('/api/paint1').catch(() => {})];
    const background = apiPost('/api/tasks/quick-parse', { text: 'x' }, { background: true }).catch(() => {});
    const userWrite = apiPost('/api/tasks/save', { text: 'x' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 4 });

    // Free the pool one connection at a time and record the dispatch order.
    for (let i = 0; i < 4; i++) {
      pending.shift()!.resolve(jsonResponse({}));
      await new Promise((r) => setTimeout(r, 0));
    }
    const order = fetchMock.mock.calls.slice(SHARED_FETCH_SLOTS).map((c) => String(c[0]));
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
    const blockers = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));

    const paint = apiGet('/api/files/list', { path: '/' }).catch(() => {});
    const parse = quickParseTask('lunch with sam tomorrow 12pm').catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 2 });

    pending.shift()!.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    expect(String(fetchMock.mock.calls[SHARED_FETCH_SLOTS][0])).toBe('/api/files/list?path=%2F');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all([...blockers, paint, parse]);
  });

  it('background writes saturating every shared slot cannot starve a GET behind them', async () => {
    // Starting state: gate idle. Background POSTs (the per-keystroke parse
    // burst) hold every shared connection; a GET queues; then ANOTHER keystroke's POST
    // arrives. Under the old "every non-GET is urgent" rule that late POST
    // unshifted ahead of the GET, and a continuous sentence repeated that forever
    // — the GET was starved for as long as the user kept typing.
    const saturate = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) =>
      apiPost(`/api/tasks/quick-parse?k=${i}`, { text: `k${i}` }, { background: true }).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 0 });

    const paint = apiGet('/api/tasks/groups').catch(() => {});
    const laterKeystroke = apiPost('/api/tasks/quick-parse?k=6', { text: 'k6' }, { background: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 2 });

    pending.shift()!.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    // Queue order, not write-priority order: the GET is next.
    expect(String(fetchMock.mock.calls[SHARED_FETCH_SLOTS][0])).toBe('/api/tasks/groups');
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain('/api/tasks/quick-parse?k=6');

    pending.shift()!.resolve(jsonResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    expect(String(fetchMock.mock.calls[SHARED_FETCH_SLOTS + 1][0])).toBe('/api/tasks/quick-parse?k=6');

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
    const blockers = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));

    const ctrl = new AbortController();
    const superseded = apiPost('/api/tasks/quick-parse', { text: 'lunch wi' }, {
      background: true, signal: ctrl.signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 1 });

    ctrl.abort();
    await expect(superseded).rejects.toMatchObject({ name: 'AbortError' });
    expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 0 });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain('/api/tasks/quick-parse');

    // Drain the pool: accounting must return to exactly zero…
    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all(blockers);
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 });

    // …and every shared connection must still be acquirable afterwards.
    const after = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/after${i}`).catch(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 0 });
    expect(fetchMock.mock.calls.slice(-SHARED_FETCH_SLOTS).map((c) => String(c[0]))).toEqual(
      Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => `/api/after${i}`));

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

    // The other shared connections stay free for what paints the screen: a
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
    // Starting state: normal reads hold every shared slot. A low read queues FIRST,
    // then a normal one.
    const hold = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await tick();
    const low = apiGet('/api/skills', undefined, { priority: 'low' }).catch(() => {});
    const normal = apiGet('/api/working-dirs').catch(() => {});
    await tick();
    expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 2 });

    pending.shift()!.resolve(jsonResponse({}));
    await tick();
    expect(urls()[SHARED_FETCH_SLOTS]).toBe('/api/working-dirs');
    expect(urls()).not.toContain('/api/skills');

    pending.shift()!.resolve(jsonResponse({}));
    await tick();
    expect(urls()[SHARED_FETCH_SLOTS + 1]).toBe('/api/skills');

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
    const hold = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
    await tick();
    const onDispatch = vi.fn();
    const queued = apiGet('/api/tasks', undefined, { onDispatch }).catch(() => {});
    await tick();
    expect(onDispatch).not.toHaveBeenCalled();

    pending.shift()!.resolve(jsonResponse({}));
    await tick();
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(urls()[SHARED_FETCH_SLOTS]).toBe('/api/tasks');

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all([...hold, queued]);
  });

  it('aborting or failing low GETs returns both lanes to zero', async () => {
    // One low read fails on the wire (HTTP 404: a 500 is quietly retried since
    // background-retry.ts, which would hold the slot for its retry waits), one is aborted while queued
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

    pending.find((p) => p.url === '/api/low-a')!.resolve(new Response('boom', { status: 404 }));
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

  // ── reserved interactive slot (2026-11-16) ─────────────────────────────────
  // Jumping the queue was not enough: draft saves (3 to 12 s) and remote reads
  // (4 to 9 s) held all six connections, and a chat's first-screen read waited
  // 1.25 s for one of them to end. One slot is now kept for `priority: 'interactive'`.

  describe('reserved interactive slot', () => {
    const interactive = (path: string, signal?: AbortSignal) =>
      apiGet(path, undefined, { priority: 'interactive', signal });
    const release = (url: string) => {
      const idx = pending.findIndex((p) => p.url === url);
      pending.splice(idx, 1)[0].resolve(jsonResponse({}));
    };

    it('with every shared slot held by slow GETs and more normal GETs queued, an interactive GET dispatches at once', async () => {
      const hold = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/slow${i}`).catch(() => {}));
      const queued = [apiGet('/api/queued0').catch(() => {}), apiGet('/api/queued1').catch(() => {})];
      await tick();
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 2 });

      const onDispatch = vi.fn();
      const read = apiGet('/api/chat/first-screen', undefined, { priority: 'interactive', onDispatch }).catch(() => {});
      await tick();
      // Nothing was released: it took the reserved slot, not a shared one, and did not wait behind the queue.
      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(urls()[SHARED_FETCH_SLOTS]).toBe('/api/chat/first-screen');
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS + 1, queued: 2 });

      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await tick();
      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await Promise.all([...hold, ...queued, read]);
    });

    it.each([
      ['background writes', (i: number) => apiPost(`/api/drafts/save?k=${i}`, { text: `k${i}` }, { background: true })],
      ['urgent writes', (i: number) => apiPost(`/api/tasks/save?k=${i}`, { text: `k${i}` })],
    ])('with every shared slot held by %s, an interactive GET still dispatches at once', async (_kind, write) => {
      const hold = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => write(i).catch(() => {}));
      // One more write of the same kind waits; urgent ones sit at the head of the shared queue.
      const waitingWrite = write(SHARED_FETCH_SLOTS).catch(() => {});
      await tick();
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 1 });

      const read = interactive('/api/chat/first-screen').catch(() => {});
      await tick();
      expect(urls()).toHaveLength(SHARED_FETCH_SLOTS + 1);
      expect(urls()[SHARED_FETCH_SLOTS]).toBe('/api/chat/first-screen');
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS + 1, queued: 1 });

      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await tick();
      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await Promise.all([...hold, waitingWrite, read]);
    });

    it('normal requests never take the reserved slot: with every shared slot in flight, the next fetch waits for an interactive GET', async () => {
      const hold = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
      const waiting = [
        apiGet('/api/normal-read').catch(() => {}),
        apiPost('/api/user-write', { x: 1 }).catch(() => {}),
        apiPost('/api/tasks/quick-parse', { text: 'x' }, { background: true }).catch(() => {}),
      ];
      await tick();
      await tick();
      // A free connection exists, yet none of the waiting requests may use it.
      expect(fetchMock).toHaveBeenCalledTimes(SHARED_FETCH_SLOTS);
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 3 });

      const read = interactive('/api/chat/first-screen').catch(() => {});
      await tick();
      expect(fetchMock).toHaveBeenCalledTimes(SHARED_FETCH_SLOTS + 1);
      expect(urls()[SHARED_FETCH_SLOTS]).toBe('/api/chat/first-screen');
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS + 1, queued: 3 });

      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await tick();
      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await Promise.all([...hold, ...waiting, read]);
    });

    it('when the reserved slot is busy too, a second interactive GET waits its turn among the normal GETs and takes the reserved slot when it frees', async () => {
      const hold = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
      const first = interactive('/api/chat/a').catch(() => {});
      await tick();
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS + 1, queued: 0 });

      const normals = [apiGet('/api/normal0').catch(() => {}), apiGet('/api/normal1').catch(() => {})];
      const second = interactive('/api/chat/b').catch(() => {});
      await tick();
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS + 1, queued: 3 });
      expect(urls()).not.toContain('/api/chat/b');

      // A shared slot frees: the normal GET that came first takes it (a page that opens many
      // chats at once does not hold back its other reads behind them).
      release('/api/hold0');
      await tick();
      expect(urls()[SHARED_FETCH_SLOTS + 1]).toBe('/api/normal0');
      expect(urls()).not.toContain('/api/chat/b');

      // The reserved slot frees: the interactive GET takes it, ahead of the normal still waiting.
      release('/api/chat/a');
      await tick();
      expect(urls()[SHARED_FETCH_SLOTS + 2]).toBe('/api/chat/b');
      expect(urls()).not.toContain('/api/normal1');
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS + 1, queued: 1 });

      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await tick();
      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await Promise.all([...hold, first, ...normals, second]);
    });

    it('a waiting read whose lane is raised (a read the person waits on joined it) takes the reserved slot at once', async () => {
      const hold = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
      const ahead = apiGet('/api/normal-ahead').catch(() => {});
      const lane: FetchLane = { interactive: false };
      const read = apiGet('/api/chat/first-screen', undefined, { lane }).catch(() => {});
      await tick();
      expect(urls()).not.toContain('/api/chat/first-screen');
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS, queued: 2 });

      lane.interactive = true;
      fetchLaneRaised();
      await tick();
      expect(urls()[SHARED_FETCH_SLOTS]).toBe('/api/chat/first-screen');
      expect(urls()).not.toContain('/api/normal-ahead');

      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await tick();
      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await Promise.all([...hold, ahead, read]);
    });

    it('a first screen waiting for the reserved slot goes before a read that yields, whichever came first', async () => {
      const hold = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
      const busy = interactive('/api/chat/busy').catch(() => {});
      await tick();
      // A chat's record (it yields) queues first, then a first screen.
      const record = apiGet('/api/sessions/a', undefined, { lane: { interactive: true, yields: true } }).catch(() => {});
      const screen = interactive('/api/chat/first-screen').catch(() => {});
      await tick();
      expect(urls()).not.toContain('/api/sessions/a');
      expect(urls()).not.toContain('/api/chat/first-screen');

      release('/api/chat/busy');
      await tick();
      expect(urls()[SHARED_FETCH_SLOTS + 1]).toBe('/api/chat/first-screen');
      expect(urls()).not.toContain('/api/sessions/a');
      release('/api/chat/first-screen');
      await tick();
      expect(urls()[SHARED_FETCH_SLOTS + 2], 'the record follows once no first screen waits').toBe('/api/sessions/a');

      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await tick();
      await Promise.all([...hold, busy, record, screen]);
    });

    it('aborting a queued interactive GET removes it and leaks no slot', async () => {
      const hold = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/hold${i}`).catch(() => {}));
      const first = interactive('/api/chat/a').catch(() => {});
      await tick();
      const ctrl = new AbortController();
      const aborted = interactive('/api/chat/left', ctrl.signal);
      await tick();
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS + 1, queued: 1 });

      ctrl.abort();
      await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS + 1, queued: 0 });

      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await Promise.all([...hold, first]);
      await tick();
      expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 });
      expect(urls()).not.toContain('/api/chat/left');

      // Every shared slot and the reserved one are still acquirable.
      const after = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/after${i}`).catch(() => {}));
      const again = interactive('/api/chat/again').catch(() => {});
      await tick();
      expect(getFetchQueueStats()).toEqual({ inFlight: SHARED_FETCH_SLOTS + 1, queued: 0 });
      expect(urls().slice(-1)).toEqual(['/api/chat/again']);

      for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
      await Promise.all([...after, again]);
    });
  });
});

describe('a read that waits while the page is in the background', () => {
  // 2026-11-23, live: the Mac app's tab reloaded itself while hidden; its first reads held the
  // connections 63 to 245 s while the engine ran the page in bursts, and 90 reads behind them were
  // rejected in 7 minutes nobody was looking. Such a wait is named for it, and the real-use
  // monitor leaves it out (usage-watch/normalize.ts), as it does a page that is leaving.
  let doc: EventTarget & { visibilityState: string };
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', doc);
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  async function rejectedCause(hide: 'before' | 'during' | 'never'): Promise<string> {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = await import('../../web/src/api/client');
    const hideNow = () => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); };
    const showNow = () => { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); };
    if (hide === 'before') { hideNow(); await vi.advanceTimersByTimeAsync(1_000); showNow(); }
    for (let i = 0; i < client.SHARED_FETCH_SLOTS; i++) void client.apiGet(`/api/hold${i}`).catch(() => {});
    const behind = client.apiGet('/api/behind', undefined, { timeoutMs: 120_000 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    if (hide === 'during') { hideNow(); await vi.advanceTimersByTimeAsync(1_000); showNow(); }
    await vi.advanceTimersByTimeAsync(20_000);
    await behind;
    const line = errorSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('/api/behind rejected'));
    return /\(([^)]+)\)$/.exec(line ?? '')?.[1] ?? 'not rejected';
  }

  it('hidden during its wait: page hidden', async () => {
    expect(await rejectedCause('during')).toBe('page hidden');
  });
  it('hidden only before it was asked, or never: pool saturated, as before', async () => {
    expect(await rejectedCause('before')).toBe('pool saturated');
    vi.resetModules();
    expect(await rejectedCause('never')).toBe('pool saturated');
  });
});

describe('a request out on the network while the page is in the background', () => {
  // 2026-11-24, live: the Mac app's /org page while hidden: GET /api/notes-v2/list answered in 24 ms
  // on the server and timed out in the page 15 s later, beside other answers 15 to 17 s late. Its
  // timeout is named for the hidden window, logged as a warning, and the real-use monitor leaves
  // it out (usage-watch/normalize.ts).
  let doc: EventTarget & { visibilityState: string };
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', doc);
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  async function timeoutLine(hide: 'before' | 'during' | 'never'): Promise<{ level: 'error' | 'warn'; line: string } | null> {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = await import('../../web/src/api/client');
    const hideNow = () => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); };
    const showNow = () => { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); };
    if (hide === 'before') { hideNow(); await vi.advanceTimersByTimeAsync(1_000); showNow(); }
    const out = client.apiGet('/api/notes-v2/list', undefined, { timeoutMs: 15_000 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(2_000);
    if (hide === 'during') { hideNow(); await vi.advanceTimersByTimeAsync(1_000); showNow(); }
    await vi.advanceTimersByTimeAsync(20_000);
    await out;
    const find = (spy: typeof errorSpy) => spy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('/api/notes-v2/list FAILED'));
    const e = find(errorSpy); const w = find(warnSpy);
    return e ? { level: 'error', line: e } : w ? { level: 'warn', line: w } : null;
  }

  it('hidden while it was out: a warning that names the hidden page', async () => {
    const got = await timeoutLine('during');
    expect(got?.level).toBe('warn');
    expect(got?.line).toMatch(/\(timeout 15000ms, page hidden\)$/);
  });
  it('hidden only before it was sent, or never: an error, as before', async () => {
    for (const hide of ['before', 'never'] as const) {
      vi.resetModules();
      const got = await timeoutLine(hide);
      expect(got?.level, hide).toBe('error');
      expect(got?.line, hide).toMatch(/\(timeout 15000ms\)$/);
    }
  });
});

describe('a request that never reached the server', () => {
  // 2026-11-24: at every deploy restart the page logged its reads (tag-display, config, supervision)
  // as errors with the browser's "Load failed". Each engine's words for a request that never reached
  // Walnut are a warning named unreachable; anything else the browser threw stays an error.
  beforeEach(() => { vi.resetModules(); vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' })) });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() });

  async function lineFor(message: string): Promise<{ level: 'error' | 'warn'; line: string } | null> {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(message) }));
    const client = await import('../../web/src/api/client');
    await client.apiGet('/api/config').catch(() => {});
    const find = (spy: typeof errorSpy) => spy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('/api/config FAILED'));
    const e = find(errorSpy); const w = find(warnSpy);
    errorSpy.mockRestore(); warnSpy.mockRestore();
    return e ? { level: 'error', line: e } : w ? { level: 'warn', line: w } : null;
  }

  it('each engine\'s network words: a warning named unreachable', async () => {
    for (const message of ['Load failed', 'Failed to fetch', 'NetworkError when attempting to fetch resource.', 'The network connection was lost.']) {
      vi.resetModules();
      const got = await lineFor(message);
      expect(got?.level, message).toBe('warn');
      expect(got?.line, message).toMatch(/\(unreachable\)$/);
    }
  });
  it('a request the browser refused stays an error', async () => {
    const got = await lineFor("Failed to execute 'fetch' on 'Window': Invalid value");
    expect(got?.level).toBe('error');
  });
});
