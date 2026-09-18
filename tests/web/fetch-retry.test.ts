/**
 * fetchWithRetry (web/src/utils/fetch-retry.ts): the one retry policy every
 * boot-time registry shares.
 *
 * What is pinned:
 *  - which failures are worth a second attempt (timeouts incl. the connection
 *    queue's "pool saturated" rejection, network errors, 5xx, malformed 2xx)
 *    and which are not (any 4xx: the server answered);
 *  - the schedule is honoured exactly: one attempt per delay, then the last
 *    error is rethrown and marked exhausted;
 *  - a non-retryable error rejects at once, with no wait, logged at WARN (the
 *    server's verdict); only a spent schedule is logged at ERROR;
 *  - aborting the caller's signal ends the wait between attempts without a
 *    further call and without a log (an unmount is not a failure); an
 *    AbortError from anywhere else is an ordinary failure;
 *  - every failed attempt leaves a log line naming the registry and reaches
 *    `onFailure`, so a caller can degrade at once while retries continue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/utils/log', () => ({ log: logMock }));

import { ApiError } from '../../web/src/api/client';
import { fetchWithRetry, isRetryableFetchError, REGISTRY_RETRY_DELAYS_MS } from '../../web/src/utils/fetch-retry';

const timeout = () => new DOMException('timed out', 'TimeoutError');
const poolSaturated = () => new DOMException(
  'Request queued 20000ms without a free connection — pool saturated', 'TimeoutError',
);

beforeEach(() => {
  vi.useFakeTimers();
  logMock.warn.mockReset();
  logMock.error.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isRetryableFetchError', () => {
  it.each([
    ['request timeout', timeout()],
    ['connection-queue rejection (pool saturated)', poolSaturated()],
    ['network failure', new TypeError('Failed to fetch')],
    ['malformed successful response', new ApiError(200, 'Invalid JSON')],
    ['server error', new ApiError(500, 'Internal Server Error')],
    ['upstream server error', new ApiError(503, 'Service Unavailable')],
  ])('retries %s', (_label, error) => {
    expect(isRetryableFetchError(error)).toBe(true);
  });

  it.each([
    ['bad request', new ApiError(400, 'Bad Request')],
    ['missing endpoint (old server)', new ApiError(404, 'Not Found')],
    ['a plain Error', new Error('boom')],
    ['an intentional abort', new DOMException('aborted', 'AbortError')],
  ])('does not retry %s', (_label, error) => {
    expect(isRetryableFetchError(error)).toBe(false);
  });
});

describe('fetchWithRetry', () => {
  const opts = { subsystem: 'tasks', label: 'task folder registry' };

  it('resolves on the first attempt without logging', async () => {
    const attempt = vi.fn(async () => 'ok');
    await expect(fetchWithRetry(attempt, opts)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('waits the scheduled delay, then retries a retryable failure', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(poolSaturated())
      .mockResolvedValueOnce('recovered');
    const p = fetchWithRetry(attempt, { ...opts, delaysMs: [2_000] });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(1);

    // Not yet: the schedule says 2s.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(attempt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('recovered');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn.mock.calls[0][1]).toBe('task folder registry fetch failed, retrying in 2000ms');
    expect(logMock.warn.mock.calls[0][2]).toMatchObject({ attempt: 1 });
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('spends the whole schedule, then rethrows the last error marked exhausted', async () => {
    const errors = [timeout(), new TypeError('Failed to fetch'), new ApiError(503, 'down')];
    const attempt = vi.fn()
      .mockRejectedValueOnce(errors[0])
      .mockRejectedValueOnce(errors[1])
      .mockRejectedValueOnce(errors[2]);
    const p = fetchWithRetry(attempt, { ...opts, delaysMs: [100, 200] });
    // Attach the handler before the clock moves so a rejection is never unobserved.
    const settled = p.then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100 + 200);
    expect(await settled).toBe(errors[2]);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(logMock.warn).toHaveBeenCalledTimes(2);
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.error.mock.calls[0][1]).toBe('task folder registry fetch failed');
    expect(logMock.error.mock.calls[0][2]).toMatchObject({ attempt: 3, retryable: true, exhausted: true });
  });

  it('rejects a non-retryable error at once, without waiting or retrying, at WARN: it is the server\'s verdict', async () => {
    // An old server without the route answers 404 on every page load; that is a
    // designed outcome for the caller (compiled-in default), not a broken fetch,
    // and must not flood the error-level audit.
    const notFound = new ApiError(404, 'Not Found');
    const attempt = vi.fn().mockRejectedValue(notFound);
    const settled = fetchWithRetry(attempt, opts).then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled).toBe(notFound);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(logMock.error).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn.mock.calls[0][1]).toBe('task folder registry fetch failed');
    expect(logMock.warn.mock.calls[0][2]).toMatchObject({ attempt: 1, retryable: false, exhausted: false });
  });

  it('reports every failed attempt to onFailure, saying whether a retry follows', async () => {
    const seen: Array<{ attempt: number; willRetry: boolean; delayMs?: number }> = [];
    const attempt = vi.fn()
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(timeout());
    const settled = fetchWithRetry(attempt, { ...opts, delaysMs: [100], onFailure: (_e, f) => seen.push(f) })
      .then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    await settled;
    expect(seen).toEqual([
      { attempt: 1, willRetry: true, delayMs: 100 },
      { attempt: 2, willRetry: false },
    ]);
  });

  it('an AbortError that did not come from the caller\'s signal is an ordinary failure', async () => {
    // Only the caller's signal means "cancelled on purpose"; an engine that
    // reports a network abort this way must still leave a trace.
    const attempt = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const settled = fetchWithRetry(attempt, opts).then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(((await settled) as DOMException).name).toBe('AbortError');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it('a signal aborted between attempts ends the wait: no further call, no error log', async () => {
    const attempt = vi.fn().mockRejectedValue(timeout());
    const ctrl = new AbortController();
    const settled = fetchWithRetry(attempt, { ...opts, signal: ctrl.signal })
      .then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    expect(attempt).toHaveBeenCalledTimes(1);

    ctrl.abort();
    const err = await settled;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');

    // The scheduled retry must not fire after the abort.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('an already-aborted signal makes no attempt at all', async () => {
    const attempt = vi.fn(async () => 'never');
    const ctrl = new AbortController();
    ctrl.abort();
    const settled = fetchWithRetry(attempt, { ...opts, signal: ctrl.signal })
      .then(() => 'resolved', (e: unknown) => e);
    expect(((await settled) as DOMException).name).toBe('AbortError');
    expect(attempt).not.toHaveBeenCalled();
  });

  it('the default registry schedule covers about half a minute', () => {
    // The stall that motivated this was ~15s; the budget must outlive it with
    // room to spare, and stay short enough that a reload is never faster.
    const total = REGISTRY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(20_000);
    expect(total).toBeLessThanOrEqual(45_000);
  });
});
