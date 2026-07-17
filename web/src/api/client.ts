import { getDeviceToken } from './device-token';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown, extra?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  const timeoutMs = extra?.timeoutMs ?? 15_000;
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
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {
      // use statusText
    }
    console.error(`[api] ${method} ${path} → ${res.status} in ${elapsed}ms: ${message}`);
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  const jsonT0 = performance.now();
  let data: T;
  try {
    data = await res.json();
  } catch (jsonErr) {
    // Server may return a truncated or empty body (e.g. killed mid-response,
    // partial write through a proxy, or stale static asset). Surface it as an
    // ApiError so callers' existing .catch() paths handle it gracefully instead
    // of an uncaught exception crashing React.
    console.error(`[api] ${method} ${path} → ${res.status} JSON parse failed in ${Math.round(performance.now() - jsonT0)}ms`, jsonErr);
    throw new ApiError(res.status, `Response body is not valid JSON (${(jsonErr as Error).message ?? 'parse error'})`);
  }
  const jsonMs = Math.round(performance.now() - jsonT0);
  // Log slow requests (>500ms network or >100ms JSON parse)
  if (elapsed > 500 || jsonMs > 100) {
    const size = res.headers.get('content-length') ?? '?';
    console.warn(`[api] ${method} ${path} → 200 in ${elapsed}ms (json parse: ${jsonMs}ms, size: ${size})`);
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
  const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000) });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch { /* use statusText */ }
    throw new ApiError(res.status, message);
  }
  return res.text();
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

export function apiDelete(path: string): Promise<void> {
  return request<void>('DELETE', path);
}

export { ApiError };
