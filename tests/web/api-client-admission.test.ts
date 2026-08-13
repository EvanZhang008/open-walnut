/**
 * Fetch admission control (web/src/api/client.ts).
 *
 * Browsers cap HTTP/1.1 at 6 connections per origin; excess fetches used to
 * queue inside the browser with their 15s abort timers already running, so a
 * burst (WS-reconnect refresh × open sessions) turned into "FAILED after 15s"
 * for requests the server never saw. The client now gates concurrency itself:
 *  - at most 6 fetches dispatched at once, the rest queue client-side
 *  - the timeout timer starts at DISPATCH, not at enqueue
 *  - writes (non-GET) jump the queue ahead of background GETs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// jsdom-free: the client only needs fetch/AbortSignal/performance, all present
// in the node test environment.
import { apiGet, apiPost, getFetchQueueStats } from '../../web/src/api/client';

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
});
