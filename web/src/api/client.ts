import { getDeviceToken } from './device-token';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Parsed error-response JSON, when the server sent one (e.g. { error, hint }). */
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Fetch admission control ────────────────────────────────────────────────
// Browsers allow only 6 HTTP/1.1 connections per origin. Excess fetches queue
// INSIDE the browser with their abort timers already running, so one burst
// (e.g. a WS-reconnect refresh of every open session while a slow request pins
// the pool) cascades into "FAILED after 15s" for requests the server never
// received (2026-08-11: a PATCH "failed" 3× client-side while the server
// answered the one attempt that arrived in 304ms). Gate concurrency here
// instead: the timeout timer starts when the request is actually dispatched,
// never while it waits for a connection. Writes (non-GET) jump the queue —
// a user action must not wait behind a pile of background GETs.
const MAX_CONCURRENT_FETCHES = 6;
const MAX_QUEUE_WAIT_MS = 20_000;
const QUEUE_DEPTH_WARN_STEP = 10;

interface QueuedFetch {
  dispatch: () => void;
  fail: (err: unknown) => void;
  callerSignal?: AbortSignal;
  onCallerAbort?: () => void;
  waitTimer: ReturnType<typeof setTimeout>;
}

let inFlightFetches = 0;
const fetchQueue: QueuedFetch[] = [];

function pumpFetchQueue(): void {
  while (inFlightFetches < MAX_CONCURRENT_FETCHES && fetchQueue.length > 0) {
    const next = fetchQueue.shift()!;
    clearTimeout(next.waitTimer);
    if (next.callerSignal && next.onCallerAbort) {
      next.callerSignal.removeEventListener('abort', next.onCallerAbort);
    }
    inFlightFetches++;
    next.dispatch();
  }
}

function acquireFetchSlot(urgent: boolean, callerSignal?: AbortSignal): Promise<void> {
  if (callerSignal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  if (inFlightFetches < MAX_CONCURRENT_FETCHES && fetchQueue.length === 0) {
    inFlightFetches++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const entry: QueuedFetch = {
      dispatch: resolve,
      fail: reject,
      callerSignal,
      waitTimer: setTimeout(() => {
        const idx = fetchQueue.indexOf(entry);
        if (idx >= 0) fetchQueue.splice(idx, 1);
        if (callerSignal && entry.onCallerAbort) {
          callerSignal.removeEventListener('abort', entry.onCallerAbort);
        }
        // TimeoutError so existing timeout handling applies; the message makes
        // the saturation case distinguishable from a real network timeout.
        reject(new DOMException(
          `Request queued ${MAX_QUEUE_WAIT_MS}ms without a free connection — pool saturated`,
          'TimeoutError',
        ));
      }, MAX_QUEUE_WAIT_MS),
    };
    if (callerSignal) {
      entry.onCallerAbort = () => {
        clearTimeout(entry.waitTimer);
        const idx = fetchQueue.indexOf(entry);
        if (idx >= 0) fetchQueue.splice(idx, 1);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      callerSignal.addEventListener('abort', entry.onCallerAbort, { once: true });
    }
    if (urgent) fetchQueue.unshift(entry);
    else fetchQueue.push(entry);
    if (fetchQueue.length % QUEUE_DEPTH_WARN_STEP === 0) {
      console.warn('[api] fetch queue backing up', {
        queued: fetchQueue.length, inFlight: inFlightFetches,
      });
    }
  });
}

function releaseFetchSlot(): void {
  inFlightFetches--;
  pumpFetchQueue();
}

/** Test hook — not for product code. */
export function getFetchQueueStats(): { inFlight: number; queued: number } {
  return { inFlight: inFlightFetches, queued: fetchQueue.length };
}

/** Sentinel: attemptRequest asks the wrapper to retry with cache bypass AFTER
 *  releasing its connection slot (retrying inside would hold two slots and
 *  can deadlock the pool if several requests hit the cache race at once). */
const RETRY_WITH_CACHE_BYPASS = Symbol('retry-with-cache-bypass');

async function request<T>(method: string, path: string, body?: unknown, extra?: { signal?: AbortSignal; timeoutMs?: number; cacheBypass?: boolean }): Promise<T> {
  await acquireFetchSlot(method !== 'GET', extra?.signal);
  let retryWithBypass = false;
  try {
    return await attemptRequest<T>(method, path, body, extra);
  } catch (err) {
    if (err === RETRY_WITH_CACHE_BYPASS) retryWithBypass = true;
    else throw err;
  } finally {
    releaseFetchSlot();
  }
  // Cache-race retry re-enters through the gate (fresh slot, fresh timer) —
  // retrying while still holding the slot would double-book the pool.
  return request<T>(method, path, body, { ...extra, cacheBypass: true });
}

async function attemptRequest<T>(method: string, path: string, body?: unknown, extra?: { signal?: AbortSignal; timeoutMs?: number; cacheBypass?: boolean }): Promise<T> {
  const timeoutMs = extra?.timeoutMs ?? 15_000;
  // Created AFTER slot acquisition — the timer measures the network round
  // trip only, never time spent waiting for a connection.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = extra?.signal
    ? AbortSignal.any([extra.signal, timeoutSignal])
    : timeoutSignal;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Cloud-mode auth: attach the stored device token when one exists.
  // On a trusted LAN no token is stored → header omitted → behavior unchanged.
  const deviceToken = getDeviceToken();
  if (deviceToken) headers['Authorization'] = `Bearer ${deviceToken}`;
  const opts: RequestInit = {
    method,
    headers,
    signal,
  };
  // Retry path for the empty-body cache race: skip the HTTP cache entirely so
  // a poisoned/entity-less cached entry cannot be replayed (see catch below).
  if (extra?.cacheBypass) opts.cache = 'no-store';
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    const elapsed = Math.round(performance.now() - t0);
    // A superseded request (e.g. debounced search) aborts via the caller's
    // signal — that's expected cancellation, not a failure. Don't log it at
    // ERROR level (it pollutes the console and masks real errors). A genuine
    // request timeout fires AbortSignal.timeout → 'TimeoutError', which we DO
    // surface. AbortError without a timeout = intentional caller abort.
    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    if (isAbort && !isTimeout) {
      throw err;
    }
    console.error(`[api] ${method} ${path} FAILED after ${elapsed}ms${isTimeout ? ` (timeout ${timeoutMs}ms)` : ''}`, err);
    throw err;
  }
  const elapsed = Math.round(performance.now() - t0);
  if (!res.ok) {
    let message = res.statusText;
    let errBody: unknown;
    try {
      const data = await res.json();
      errBody = data;
      if (data.error) message = data.error;
    } catch {
      // use statusText
    }
    console.error(`[api] ${method} ${path} → ${res.status} in ${elapsed}ms: ${message}`);
    throw new ApiError(res.status, message, errBody);
  }
  if (res.status === 204) return undefined as T;
  const jsonT0 = performance.now();
  let data: T;
  try {
    // Read text first so a parse failure can log WHAT arrived (empty vs
    // truncated) — res.json() destroys that evidence.
    const raw = await res.text();
    data = JSON.parse(raw) as T;
  } catch (jsonErr) {
    // An aborted body read is caller cleanup, not the 304 empty-body cache race
    // this retry exists for. Propagate it quietly without logging or retrying.
    if (
      typeof jsonErr === 'object'
      && jsonErr !== null
      && 'name' in jsonErr
      && jsonErr.name === 'AbortError'
    ) {
      throw jsonErr;
    }
    // Empty/truncated body on a GET is (in practice) the browser-cache 304
    // race: two concurrent GETs to the same URL, the second revalidates and
    // fetch() surfaces "200" with no usable entity (inc-1784686852150,
    // inc-1784752220440). One retry with cache:'no-store' goes straight to
    // the network and resolves it. Non-GET or second failure → ApiError so
    // callers' existing .catch() paths handle it (never crash React).
    const reqId = res.headers.get('x-request-id') ?? '?';
    const detail = {
      status: res.status,
      reqId,
      etag: res.headers.get('etag') ?? undefined,
      contentLength: res.headers.get('content-length') ?? undefined,
      retrying: method === 'GET' && !extra?.cacheBypass,
    };
    console.error(`[api] ${method} ${path} → ${res.status} JSON parse failed in ${Math.round(performance.now() - jsonT0)}ms`, jsonErr, JSON.stringify(detail));
    if (method === 'GET' && !extra?.cacheBypass) {
      throw RETRY_WITH_CACHE_BYPASS;
    }
    throw new ApiError(res.status, `Response body is not valid JSON (${(jsonErr as Error).message ?? 'parse error'})`);
  }
  const jsonMs = Math.round(performance.now() - jsonT0);
  // Log slow requests (>500ms wall or >100ms JSON parse). `elapsed` is WALL
  // time (request issued → our callback ran) — on a blocked main thread it
  // includes queueing, so it lies about the network. Pull the browser's
  // Resource Timing entry for the REAL network duration and log both: a big
  // wall-vs-net gap means "main thread was blocked", not "server was slow"
  // (the 2026-07-23 investigation burned hours on exactly that misread).
  if (elapsed > 500 || jsonMs > 100) {
    const size = res.headers.get('content-length') ?? '?';
    let netMs: number | undefined;
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.responseEnd >= t0 && e.name.includes(path.split('?')[0])) {
          netMs = Math.round(e.responseEnd - e.startTime);
          break;
        }
      }
    } catch { /* resource timing unavailable — wall time only */ }
    const blockedHint = netMs !== undefined && elapsed - netMs > 1_000
      ? ` ⚠ main-thread queued ${elapsed - netMs}ms`
      : '';
    console.warn(`[api] ${method} ${path} → 200 in ${elapsed}ms (net: ${netMs ?? '?'}ms, json parse: ${jsonMs}ms, size: ${size})${blockedHint}`);
  }
  return data;
}

export function apiGet<T>(path: string, params?: Record<string, string>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  const url = params ? `${path}?${new URLSearchParams(params)}` : path;
  return request<T>('GET', url, undefined, opts);
}

/** GET a text/plain endpoint (e.g. /api/bug-report) with the same auth/timeout plumbing. */
export async function apiGetText(path: string, params?: Record<string, string>, opts?: { timeoutMs?: number }): Promise<string> {
  const url = params ? `${path}?${new URLSearchParams(params)}` : path;
  const headers: Record<string, string> = {};
  const deviceToken = getDeviceToken();
  if (deviceToken) headers['Authorization'] = `Bearer ${deviceToken}`;
  await acquireFetchSlot(false);
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000) });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const data = await res.json();
        if (data.error) message = data.error;
      } catch { /* use statusText */ }
      throw new ApiError(res.status, message);
    }
    return await res.text();
  } finally {
    releaseFetchSlot();
  }
}

export function apiPost<T>(path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
  return request<T>('POST', path, body, opts);
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PATCH', path, body);
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

// Default void for fire-and-forget deletes; pass T when the server responds
// 200 + JSON body (request() parses any JSON response regardless of method).
export function apiDelete<T = void>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}

export { ApiError };
