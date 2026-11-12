/**
 * Tests for the identical-request coalescer in web/src/api/sessions.ts
 * (fetchSessionHistory).
 *
 * Why it exists: the same history request routinely fires twice at the same
 * moment — SessionPanel and SessionChatHistory each mount useSessionHistory
 * for the SAME session (two full fetches per open), and a turn's
 * batch-completed triggers both the hook's delta and session-cache's
 * background delta (identical ?since= pairs observed in the prod log).
 * One in-flight request per exact shape must serve every concurrent caller.
 *
 * Abort contract: the underlying request aborts only when EVERY subscriber
 * has aborted — one caller unmounting must not kill the fetch for the other.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
}));

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, apiGet: mocks.apiGet };
});

// flight-recorder is dynamically imported inside the fetch; stub it so the
// test never touches its module state.
vi.mock('@/stream/flight-recorder', () => ({ recordFlight: vi.fn() }));

import { fetchSessionHistory, noteSessionHistoryMoved } from '@/api/sessions';

interface Deferred {
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
}

function deferApiGet(): Deferred[] {
  const calls: Deferred[] = [];
  mocks.apiGet.mockImplementation((_path: string, _params: unknown, opts?: { signal?: AbortSignal }) => {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ promise, resolve, reject, signal: opts?.signal });
    return promise;
  });
  return calls;
}

const RESPONSE = { messages: [{ role: 'user', text: 'hi' }], cursor: 1 };

beforeEach(() => {
  mocks.apiGet.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchSessionHistory coalescing', () => {
  it('keeps the first-paint source and snapshot through the response projection', async () => {
    const calls = deferApiGet();
    const read = fetchSessionHistory('source-projection', { source: 'streams', tail: 400 });
    calls[0].resolve({ ...RESPONSE, firstPaintSource: 'ready', snapshot: '2026-01-01T00:00:00Z' });
    expect(await read).toMatchObject({ firstPaintSource: 'ready', snapshot: '2026-01-01T00:00:00Z' });
    expect(mocks.apiGet.mock.calls[0][1]).toMatchObject({ source: 'streams', screen: '1' });
  });

  it('two concurrent identical requests share ONE network call and both resolve', async () => {
    const calls = deferApiGet();
    const p1 = fetchSessionHistory('sess-1', { tail: 400 });
    const p2 = fetchSessionHistory('sess-1', { tail: 400 });
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);

    calls[0].resolve(RESPONSE);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.messages).toHaveLength(1);
    expect(r2.messages).toHaveLength(1);
  });

  it('different request shapes do NOT coalesce', async () => {
    const calls = deferApiGet();
    void fetchSessionHistory('sess-1', { tail: 400 }).catch(() => {});
    void fetchSessionHistory('sess-1', { source: 'streams', tail: 400 }).catch(() => {});
    void fetchSessionHistory('sess-1', { since: 12 }).catch(() => {});
    void fetchSessionHistory('sess-2', { tail: 400 }).catch(() => {});
    expect(mocks.apiGet).toHaveBeenCalledTimes(4);
    calls.forEach((c) => c.resolve(RESPONSE));
  });

  it('a settled request is NOT reused — the next call fetches fresh', async () => {
    const calls = deferApiGet();
    const p1 = fetchSessionHistory('sess-1', { tail: 400 });
    calls[0].resolve(RESPONSE);
    await p1;

    const p2 = fetchSessionHistory('sess-1', { tail: 400 });
    expect(mocks.apiGet).toHaveBeenCalledTimes(2);
    calls[1].resolve(RESPONSE);
    await p2;
  });

  it('one subscriber aborting does NOT abort the shared request', async () => {
    const calls = deferApiGet();
    const ac1 = new AbortController();
    const p1 = fetchSessionHistory('sess-1', { tail: 400, signal: ac1.signal });
    const p2 = fetchSessionHistory('sess-1', { tail: 400 });
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);

    ac1.abort();
    expect(calls[0].signal?.aborted).toBe(false);

    calls[0].resolve(RESPONSE);
    // The aborted caller's promise still settles (its useEffect `cancelled`
    // flag ignores the result) — it must not reject the shared promise.
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.messages).toHaveLength(1);
    expect(r2.messages).toHaveLength(1);
  });

  it('when ALL subscribers abort, the underlying request aborts', async () => {
    const calls = deferApiGet();
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = fetchSessionHistory('sess-1', { tail: 400, signal: ac1.signal });
    const p2 = fetchSessionHistory('sess-1', { tail: 400, signal: ac2.signal });
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);

    ac1.abort();
    expect(calls[0].signal?.aborted).toBe(false);
    ac2.abort();
    expect(calls[0].signal?.aborted).toBe(true);

    // Simulate the transport honoring the abort.
    calls[0].reject(new DOMException('aborted', 'AbortError'));
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
  });

  it('an already-aborted signal still gets the shared result without killing it for others', async () => {
    const calls = deferApiGet();
    const live = fetchSessionHistory('sess-1', { tail: 400 });
    const ac = new AbortController();
    ac.abort();
    const dead = fetchSessionHistory('sess-1', { tail: 400, signal: ac.signal });
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);
    expect(calls[0].signal?.aborted).toBe(false);

    calls[0].resolve(RESPONSE);
    await expect(live).resolves.toBeTruthy();
    await expect(dead).resolves.toBeTruthy();
  });

  it('a remount inside the abort window gets a FRESH request, not the doomed promise', async () => {
    // The eager delete-on-abort exists exactly for this: fast thread-chip
    // switching unmounts + remounts the same history shape before the aborted
    // fetch settles. The remount must not adopt the rejected promise.
    const calls = deferApiGet();
    const ac = new AbortController();
    const doomed = fetchSessionHistory('sess-1', { tail: 400, signal: ac.signal });
    ac.abort();
    expect(calls[0].signal?.aborted).toBe(true);

    // Remount BEFORE the doomed request settles → a second network call.
    const fresh = fetchSessionHistory('sess-1', { tail: 400 });
    expect(mocks.apiGet).toHaveBeenCalledTimes(2);

    // The doomed request settles late — its .finally must NOT evict the fresh
    // entry (identity-guarded), so a third caller still coalesces onto it.
    calls[0].reject(new DOMException('aborted', 'AbortError'));
    await expect(doomed).rejects.toThrow();
    const third = fetchSessionHistory('sess-1', { tail: 400 });
    expect(mocks.apiGet).toHaveBeenCalledTimes(2);

    calls[1].resolve(RESPONSE);
    await expect(fresh).resolves.toBeTruthy();
    await expect(third).resolves.toBeTruthy();
  });

  it('a failed request rejects all subscribers and is not cached for the next call', async () => {
    const calls = deferApiGet();
    const p1 = fetchSessionHistory('sess-1', { tail: 400 });
    const p2 = fetchSessionHistory('sess-1', { tail: 400 });
    calls[0].reject(new Error('boom'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');

    const p3 = fetchSessionHistory('sess-1', { tail: 400 });
    expect(mocks.apiGet).toHaveBeenCalledTimes(2);
    calls[1].resolve(RESPONSE);
    await expect(p3).resolves.toBeTruthy();
  });
  it('a read asked after the session moved on never joins one started before it', async () => {
    // The turn's end read joined the read its stream end had started a moment earlier,
    // and answered with the history from before the turn's last row (2026-11-02).
    const calls = deferApiGet();
    const before = fetchSessionHistory('sess-1', { since: 2, tail: 400 });
    noteSessionHistoryMoved('sess-1');
    const after = fetchSessionHistory('sess-1', { since: 2, tail: 400 });
    expect(mocks.apiGet).toHaveBeenCalledTimes(2);
    // The callers reacting to the same event still share one read.
    const sameEvent = fetchSessionHistory('sess-1', { since: 2, tail: 400 });
    expect(mocks.apiGet).toHaveBeenCalledTimes(2);
    // Another session's event leaves this session's reads joinable.
    noteSessionHistoryMoved('sess-2');
    void fetchSessionHistory('sess-1', { since: 2, tail: 400 });
    expect(mocks.apiGet).toHaveBeenCalledTimes(2);
    // A reconnect moves every session on.
    noteSessionHistoryMoved();
    void fetchSessionHistory('sess-1', { since: 2, tail: 400 }).catch(() => {});
    expect(mocks.apiGet).toHaveBeenCalledTimes(3);
    calls.forEach((c) => c.resolve(RESPONSE));
    await Promise.all([before, after, sameEvent]);
  });

  it('a turn boundary event on the socket starts the new epoch before any listener asks', async () => {
    const { wsClient } = await import('@/api/ws');
    const calls = deferApiGet();
    void fetchSessionHistory('sess-ws', { since: 1, tail: 400 });
    let joinedInListener = -1;
    const listener = () => {
      void fetchSessionHistory('sess-ws', { since: 1, tail: 400 });
      joinedInListener = mocks.apiGet.mock.calls.length;
    };
    wsClient.onEvent('session:batch-completed', listener);
    (wsClient as unknown as { dispatchEvent(f: unknown): void }).dispatchEvent({ type: 'event', name: 'session:batch-completed', data: { sessionId: 'sess-ws' }, seq: 1 });
    wsClient.offEvent('session:batch-completed', listener);
    expect(joinedInListener).toBe(2);
    calls.forEach((c) => c.resolve(RESPONSE));
  });
});
