import { getDeviceToken, renewSignIn } from './device-token';
import { noteAuthRefusal } from './unpaired';
import { asDeadlineError } from '../utils/request-failure';
import { mintOpId, isWriteMethod, OP_ID_HEADER, WAIT_HEADER, DEFAULT_WRITE_WAIT_MS } from './op-id';
import { leaderErrorMessage, noteResponseHeaders } from './leader-presence';
import { readsSuspended, onReadLifecycle } from './read-lifecycle';

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
//
// A third class, `priority: 'low'`, is for GETs nobody is looking at yet: the
// "/" palette's skill and slash-command lists, a reload's workflow
// reconstruction. They get a slot only while no normal request is waiting, and
// never more than MAX_LOW_PRIORITY_IN_FLIGHT at once, so at least four slots
// always stay free for what paints the screen. Without the cap a reload handed
// the first slot to a 1.2MB skill list (11s under load) and two more to the
// session palette (13.5s): the task list and the draft's quick folders queued
// behind them and showed up 10.8s / 5s after the refresh (2026-09-23).
const MAX_CONCURRENT_FETCHES = 6;
const MAX_LOW_PRIORITY_IN_FLIGHT = 2;
const MAX_QUEUE_WAIT_MS = 20_000;
// Low requests yield to every normal one, so on a busy page they can
// legitimately wait longer than a normal request ever should.
const MAX_LOW_QUEUE_WAIT_MS = 60_000;
const QUEUE_DEPTH_WARN_STEP = 10;

type FetchPriority = 'urgent' | 'normal' | 'low';

interface FetchAdmission {
  deadline: number;
  waitMs: number;
  suspended: boolean;
}

interface QueuedFetch {
  dispatch: () => void;
  callerSignal?: AbortSignal;
  onCallerAbort?: () => void;
  waitTimer: ReturnType<typeof setTimeout>;
  /** A write: sent at once when the page goes (sendQueuedWritesNow). */
  write: boolean;
  /** Reads wait for cancellation or pageshow; durable writes can leave the queue. */
  read: boolean;
  admission: FetchAdmission;
  expire: () => void;
  /** `METHOD /path`, for the queue's test hook. */
  label: string;
}

let inFlightFetches = 0;
let inFlightLowFetches = 0;
const fetchQueue: QueuedFetch[] = [];
const lowFetchQueue: QueuedFetch[] = [];

function startQueued(next: QueuedFetch, low: boolean): void {
  if (Date.now() >= next.admission.deadline) {
    next.expire();
    return;
  }
  clearTimeout(next.waitTimer);
  if (next.callerSignal && next.onCallerAbort) {
    next.callerSignal.removeEventListener('abort', next.onCallerAbort);
  }
  inFlightFetches++;
  if (low) inFlightLowFetches++;
  next.dispatch();
}

function eligibleIndex(queue: QueuedFetch[]): number {
  return queue.findIndex((entry) => !entry.read || !readsSuspended());
}

function pumpFetchQueue(): void {
  // A restored page's timers may not have run yet. Expire before dispatching.
  for (const queue of [fetchQueue, lowFetchQueue]) {
    for (const entry of [...queue]) if (Date.now() >= entry.admission.deadline) entry.expire();
  }
  while (inFlightFetches < MAX_CONCURRENT_FETCHES) {
    const normal = eligibleIndex(fetchQueue);
    const low = eligibleIndex(lowFetchQueue);
    if (normal >= 0) {
      startQueued(fetchQueue.splice(normal, 1)[0], false);
    } else if (low >= 0 && inFlightLowFetches < MAX_LOW_PRIORITY_IN_FLIGHT) {
      startQueued(lowFetchQueue.splice(low, 1)[0], true);
    } else {
      break;
    }
  }
}

function fetchAdmission(priority: FetchPriority): FetchAdmission {
  const waitMs = priority === 'low' ? MAX_LOW_QUEUE_WAIT_MS : MAX_QUEUE_WAIT_MS;
  return { deadline: Date.now() + waitMs, waitMs, suspended: false };
}

function acquireFetchSlot(priority: FetchPriority, label: string, callerSignal?: AbortSignal, write = false, read = false, admission = fetchAdmission(priority)): Promise<void> {
  if (read && readsSuspended()) admission.suspended = true;
  if (callerSignal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  const low = priority === 'low';
  const free = inFlightFetches < MAX_CONCURRENT_FETCHES && eligibleIndex(fetchQueue) < 0;
  if (!(read && readsSuspended()) && Date.now() < admission.deadline && free
    && (!low || (eligibleIndex(lowFetchQueue) < 0 && inFlightLowFetches < MAX_LOW_PRIORITY_IN_FLIGHT))) {
    inFlightFetches++;
    if (low) inFlightLowFetches++;
    return Promise.resolve();
  }
  const queue = low ? lowFetchQueue : fetchQueue;
  const { waitMs } = admission;
  return new Promise<void>((resolve, reject) => {
    const expire = () => {
      clearTimeout(entry.waitTimer);
      const idx = queue.indexOf(entry);
      if (idx >= 0) queue.splice(idx, 1);
      if (callerSignal && entry.onCallerAbort) callerSignal.removeEventListener('abort', entry.onCallerAbort);
      const cause = admission.suspended ? 'page suspended' : 'pool saturated';
      console.error(`[api] ${label} rejected after ${waitMs}ms in the connection queue (${cause})`, {
        queued: fetchQueue.length, queuedLow: lowFetchQueue.length, inFlight: inFlightFetches, priority,
      });
      reject(new DOMException(admission.suspended
        ? `Request queued ${waitMs}ms while the page was suspended`
        : `Request queued ${waitMs}ms without a free connection — pool saturated`, 'TimeoutError'));
    };
    const entry: QueuedFetch = {
      dispatch: resolve,
      callerSignal,
      write,
      read,
      admission,
      expire,
      label,
      waitTimer: setTimeout(expire, Math.max(0, admission.deadline - Date.now())),
    };
    if (callerSignal) {
      entry.onCallerAbort = () => {
        clearTimeout(entry.waitTimer);
        const idx = queue.indexOf(entry);
        if (idx >= 0) queue.splice(idx, 1);
        callerSignal.removeEventListener('abort', entry.onCallerAbort!);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      callerSignal.addEventListener('abort', entry.onCallerAbort, { once: true });
    }
    if (priority === 'urgent') queue.unshift(entry);
    else queue.push(entry);
    if (!low && fetchQueue.length % QUEUE_DEPTH_WARN_STEP === 0) {
      console.warn('[api] fetch queue backing up', {
        queued: fetchQueue.length, queuedLow: lowFetchQueue.length, inFlight: inFlightFetches,
      });
    }
    pumpFetchQueue();
  });
}

/**
 * The page is going: every write still waiting for a slot is sent now, past the cap. JS stops
 * before the queue would drain, so a write left in it is never sent at all (2026-11-06, CI: the
 * visit batch its timer had queued behind a full pool was gone when the page reloaded). A write
 * resumes in a microtask, still inside the exit edge, and so goes with keepalive. GETs stay put.
 */
function sendQueuedWritesNow(): void {
  for (const [queue, low] of [[fetchQueue, false], [lowFetchQueue, true]] as const) {
    for (const entry of queue.filter((e) => e.write)) {
      queue.splice(queue.indexOf(entry), 1);
      startQueued(entry, low);
    }
  }
}

function releaseFetchSlot(priority: FetchPriority): void {
  inFlightFetches--;
  if (priority === 'low') inFlightLowFetches--;
  pumpFetchQueue();
}

/** Test hook — not for product code. */
export function getFetchQueueStats(): { inFlight: number; queued: number } {
  // `queued` counts BOTH lanes: callers use it as "is anything still waiting".
  return { inFlight: inFlightFetches, queued: fetchQueue.length + lowFetchQueue.length };
}

/** Test hook — `METHOD /path` of every request still waiting for a slot, both lanes. */
export function queuedFetchLabels(): string[] {
  return [...fetchQueue, ...lowFetchQueue].map((e) => e.label);
}

/** Test hook — the low-priority lane alone (its share of in-flight + its queue). */
export function getLowFetchQueueStats(): { inFlight: number; queued: number } {
  return { inFlight: inFlightLowFetches, queued: lowFetchQueue.length };
}

/** Sentinel: attemptRequest asks the wrapper to retry with cache bypass AFTER
 *  releasing its connection slot (retrying inside would hold two slots and
 *  can deadlock the pool if several requests hit the cache race at once). */
const RETRY_WITH_CACHE_BYPASS = Symbol('retry-with-cache-bypass');

/**
 * attemptRequest's ask to send once more with the token held now, after its
 * slot is released: the browser's sign-in ran out (`renew`: renew it first,
 * api/device-token.ts) or was renewed while the request was out. A 401 is the
 * auth middleware's, so the first attempt never reached a handler.
 */
class RetryWithToken {
  constructor(readonly renew: boolean, readonly refusal: ApiError) {}
}

/**
 * The page is going away (a reload, a navigation, the window closing): the
 * browser cancels every request still in flight, which reaches us as a
 * "Failed to fetch" from fetch() or from the body read. That is the page's own
 * exit, not a server or network failure, so it is not logged as an error
 * (2026-10-30: every reload in a browser test logged "JSON parse failed" for the
 * requests it cut). A back-forward cache restore brings the page back.
 */
onReadLifecycle(() => {
  if (readsSuspended()) {
    for (const queue of [fetchQueue, lowFetchQueue]) {
      for (const entry of queue) if (entry.read) entry.admission.suspended = true;
    }
  } else {
    exitEdge = false;
    pumpFetchQueue();
  }
});
/**
 * True from a hide or pagehide edge until its handlers have run. A write made there (a pending
 * settings save, a visit batch) is a page-exit write: the browser cancels an ordinary request
 * when the page goes, so it is sent with keepalive, and at once, since a request still waiting
 * for a connection slot when the page stops is never sent at all (2026-11-01: a reload lost the
 * visit batch its hide edge sent, which WebKit logs as "cannot load ... due to access control
 * checks"). Listeners here are registered before any module that imports the client.
 */
let exitEdge = false;
function markExitEdge(): void {
  exitEdge = true;
  setTimeout(() => { exitEdge = false; }, 0);
  sendQueuedWritesNow();
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', markExitEdge);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') markExitEdge();
      else exitEdge = false;
    });
  }
}
function cutByPageExit(err: unknown): boolean {
  return readsSuspended() && err instanceof TypeError;
}
/** A write now may outlive the page: the page is leaving, at a hide edge, or hidden. */
function writeMayOutlivePage(): boolean {
  return readsSuspended() || exitEdge || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
}
/** fetch keepalive refuses a request once the keepalive bodies in flight pass 64 KB (UTF-8 bytes). */
const KEEPALIVE_MAX_BODY = 60_000;
function fitsKeepalive(body: BodyInit | null | undefined): boolean {
  if (typeof body !== 'string') return !body;
  // Most characters are one byte; count bytes only when the length alone does not settle it.
  if (body.length * 3 <= KEEPALIVE_MAX_BODY) return true;
  return body.length <= KEEPALIVE_MAX_BODY && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BODY;
}

interface RequestExtra {
  signal?: AbortSignal;
  timeoutMs?: number;
  cacheBypass?: boolean;
  quietStatuses?: number[];
  background?: boolean;
  readOnly?: boolean;
  /** Yield to every normal request; POST also requires background: true. */
  priority?: 'low';
  /** Called the moment the request leaves the admission queue for the network —
   *  the earliest the server can see it. A caller reasoning about "is this
   *  response newer than X" needs this, not the time it CALLED the API: a call
   *  can sit in the queue for seconds. Fires again on the cache-bypass retry. */
  onDispatch?: () => void;
  /** The write's op id (one per user action): a retried action passes its own (write-retry.ts), else request() mints one. */
  opId?: string;
  /** Send with fetch keepalive, so a page reload or exit does not cancel it (small bodies only).
   *  Every write made while the page hides or leaves gets it without asking. */
  keepalive?: boolean;
  /** Already sent again with a new token (RetryWithToken): a second 401 stands. */
  tokenRetried?: boolean;
}

function priorityOf(method: string, extra?: RequestExtra): FetchPriority {
  // A non-GET jumps the queue because it is normally a USER action. `background: true`
  // opts out: a write nobody is waiting on must not outrank the GETs that are
  // painting the screen. Without this, the draft composer's per-keystroke AI parse
  // (a POST) took all six slots ahead of the path picker's listings and held each
  // for its full 10s model timeout (2026-09-17).
  if (method !== 'GET') {
    if (!extra?.background) return 'urgent';
    return extra.priority === 'low' ? 'low' : 'normal';
  }
  return extra?.priority === 'low' ? 'low' : 'normal';
}

async function request<T>(method: string, path: string, body?: unknown, extra?: RequestExtra): Promise<T> {
  // One op id per user action that writes, minted before the queue so every
  // attempt of this call carries the same one (a host replica dedupes by it).
  if (isWriteMethod(method) && !extra?.opId) extra = { ...extra, opId: mintOpId() };
  const read = method === 'GET' || extra?.readOnly === true;
  const write = isWriteMethod(method) && !read;
  const outlives = write && (!extra?.background || extra?.keepalive === true);
  if (write && writeMayOutlivePage()) {
    extra = { ...extra, keepalive: true };
    // The page is going: JS stops before a queued request would get its slot (and before a renewal would land).
    if (readsSuspended() || exitEdge) {
      return attemptRequest<T>(method, path, body, extra).catch((err: unknown) => {
        throw err instanceof RetryWithToken ? err.refusal : err;
      });
    }
  }
  const priority = priorityOf(method, extra);
  const admission = fetchAdmission(priority);
  let retryWithToken: RetryWithToken | null = null;
  for (;;) {
    await acquireFetchSlot(priority, `${method} ${path}`, extra?.signal, outlives, read, admission);
    try {
      // Release a granted slot before rejoining the queue with the same deadline.
      if (read && readsSuspended()) { admission.suspended = true; continue; }
      if (outlives && !extra?.keepalive && writeMayOutlivePage()) extra = { ...extra, keepalive: true };
      extra?.onDispatch?.();
      if (read && readsSuspended()) { admission.suspended = true; continue; }
      return await attemptRequest<T>(method, path, body, extra);
    } catch (err) {
      if (err instanceof RetryWithToken) retryWithToken = err;
      else if (err !== RETRY_WITH_CACHE_BYPASS) throw err;
    } finally {
      releaseFetchSlot(priority);
    }
    break;
  }
  if (retryWithToken) {
    if (retryWithToken.renew) {
      const renewed = await renewSignIn();
      if (renewed.kind !== 'renewed' && renewed.kind !== 'held') {
        // Only the renewal route's own refusal says this browser is signed out; anything else
        // (no answer, a server that does not renew) leaves the refusal as it is, asked again later.
        if (renewed.kind === 'refused') noteAuthRefusal(renewed.body);
        throw retryWithToken.refusal;
      }
    }
    return request<T>(method, path, body, { ...extra, tokenRetried: true });
  }
  // Cache-race retry re-enters through the gate (fresh slot, fresh timer) —
  // retrying while still holding the slot would double-book the pool.
  return request<T>(method, path, body, { ...extra, cacheBypass: true });
}

/** fetch, and once more without keepalive when keepalive refused it (its in-flight budget was full). */
async function fetchOnce(path: string, opts: RequestInit): Promise<Response> {
  try {
    return await fetch(path, opts);
  } catch (err) {
    if (!opts.keepalive || readsSuspended() || !(err instanceof TypeError) || opts.signal?.aborted) throw err;
    return fetch(path, { ...opts, keepalive: false });
  }
}

async function attemptRequest<T>(method: string, path: string, body?: unknown, extra?: { signal?: AbortSignal; timeoutMs?: number; cacheBypass?: boolean; quietStatuses?: number[]; opId?: string; keepalive?: boolean; tokenRetried?: boolean }): Promise<T> {
  const timeoutMs = extra?.timeoutMs ?? 15_000;
  // Created AFTER slot acquisition — the timer measures the network round
  // trip only, never time spent waiting for a connection.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = extra?.signal
    ? AbortSignal.any([extra.signal, timeoutSignal])
    : timeoutSignal;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Attach the stored device token when one exists (a cloud replica, or a
  // browser on another device). On the server's own machine none is needed.
  const deviceToken = getDeviceToken();
  if (deviceToken) headers['Authorization'] = `Bearer ${deviceToken}`;
  if (extra?.opId) headers[OP_ID_HEADER] = extra.opId;
  if (extra?.opId && timeoutMs > DEFAULT_WRITE_WAIT_MS) headers[WAIT_HEADER] = String(timeoutMs);
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
  if (extra?.keepalive && fitsKeepalive(opts.body)) opts.keepalive = true;
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetchOnce(path, opts);
  } catch (caught) {
    // A deadline is a TimeoutError in every engine (WebKit says AbortError), so
    // the checks below and every caller's `name === 'TimeoutError'` see it.
    const err = asDeadlineError(caught, signal);
    const elapsed = Math.round(performance.now() - t0);
    // A superseded request (e.g. debounced search) aborts via the caller's
    // signal — that's expected cancellation, not a failure. Don't log it at
    // ERROR level (it pollutes the console and masks real errors). A genuine
    // request timeout fires AbortSignal.timeout → 'TimeoutError', which we DO
    // surface. AbortError without a timeout = intentional caller abort.
    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    if ((isAbort && !isTimeout) || cutByPageExit(err)) {
      throw err;
    }
    console.error(`[api] ${method} ${path} FAILED after ${elapsed}ms${isTimeout ? ` (timeout ${timeoutMs}ms)` : ''}`, err);
    throw err;
  }
  const elapsed = Math.round(performance.now() - t0);
  // A host replica says who answered (api/leader-presence.ts): the away line reads it.
  noteResponseHeaders(res.headers);
  if (!res.ok) {
    let message = res.statusText;
    let errBody: unknown;
    try {
      const data = await res.json();
      errBody = data;
      // A replica's answer is { error: { code, message } }: its message, never "[object Object]".
      if (typeof data.error === 'string') message = data.error;
      else if (typeof data.error?.message === 'string') message = data.error.message;
      // A host replica's answer while the Mac is away: plain words, "Needs your Mac" with the reason.
      message = leaderErrorMessage(data, res.status) ?? message;
    } catch {
      // use statusText
    }
    // quietStatuses: statuses the caller EXPECTS in some environments (e.g. a
    // 503 "feature disabled") — warn keeps them out of the error-log audit.
    // A sign-in that ran out is renewed and sent again below: expected, not an error.
    const quiet = (extra?.quietStatuses?.includes(res.status) ?? false)
      || (res.status === 401 && (errBody as { code?: unknown } | undefined)?.code === 'token_expired');
    (quiet ? console.warn : console.error)(`[api] ${method} ${path} → ${res.status} in ${elapsed}ms: ${message}`);
    if (res.status === 401 && deviceToken && !extra?.tokenRetried) {
      const code = (errBody as { code?: unknown } | undefined)?.code;
      // Renewed while this was out, or ran out: sent again with the token held then.
      if (deviceToken !== getDeviceToken()) throw new RetryWithToken(false, new ApiError(res.status, message, errBody));
      if (code === 'token_expired') throw new RetryWithToken(true, new ApiError(res.status, message, errBody));
    }
    // Only a refusal of the credential this browser holds NOW says it is signed
    // out: a request sent before a `#pair=` code was traded carried none.
    if (res.status === 401 && (deviceToken ?? null) === getDeviceToken()) noteAuthRefusal(errBody);
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
    if (cutByPageExit(jsonErr)) throw jsonErr;
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

export function apiGet<T>(path: string, params?: Record<string, string>, opts?: { signal?: AbortSignal; timeoutMs?: number; quietStatuses?: number[]; priority?: 'low'; onDispatch?: () => void }): Promise<T> {
  const url = params ? `${path}?${new URLSearchParams(params)}` : path;
  return request<T>('GET', url, undefined, opts);
}

/** GET a text/plain endpoint (e.g. /api/bug-report) with the same auth/timeout plumbing. */
export async function apiGetText(path: string, params?: Record<string, string>, opts?: { timeoutMs?: number }): Promise<string> {
  const url = params ? `${path}?${new URLSearchParams(params)}` : path;
  const headers: Record<string, string> = {};
  const deviceToken = getDeviceToken();
  if (deviceToken) headers['Authorization'] = `Bearer ${deviceToken}`;
  const admission = fetchAdmission('normal');
  for (;;) {
    await acquireFetchSlot('normal', `GET ${path}`, undefined, false, true, admission);
    try {
      if (readsSuspended()) { admission.suspended = true; continue; }
      let res: Response;
      const deadline = AbortSignal.timeout(opts?.timeoutMs ?? 30_000);
      try {
        res = await fetch(url, { method: 'GET', headers, signal: deadline });
      } catch (err) {
        throw asDeadlineError(err, deadline);
      }
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
      releaseFetchSlot('normal');
    }
  }
}

// quietStatuses is offered here for the same reason apiGet offers it: a POST can have a DESIGNED
// non-2xx outcome (a refused credential, a capability the provider does not have), and those must
// not land in the error-log audit as if something broke.
export function apiPost<T>(path: string, body?: unknown, opts?: { timeoutMs?: number; quietStatuses?: number[]; signal?: AbortSignal; background?: boolean; readOnly?: boolean; priority?: 'low'; opId?: string; keepalive?: boolean }): Promise<T> {
  return request<T>('POST', path, body, opts);
}

// Same options as apiPost, and for the same reason: a PATCH has designed non-2xx outcomes too. A
// draft edit that races a send answers 409 by contract, and without this that expected answer was
// logged at error level in the audit, which is how a real fault gets lost in the noise.
export function apiPatch<T>(path: string, body?: unknown, opts?: { timeoutMs?: number; quietStatuses?: number[]; opId?: string }): Promise<T> {
  return request<T>('PATCH', path, body, opts);
}

export function apiPut<T>(path: string, body?: unknown, opts?: { timeoutMs?: number; opId?: string }): Promise<T> {
  return request<T>('PUT', path, body, opts);
}

// Default void for fire-and-forget deletes; pass T when the server responds
// 200 + JSON body (request() parses any JSON response regardless of method).
export function apiDelete<T = void>(path: string, opts?: { timeoutMs?: number; quietStatuses?: number[]; opId?: string }): Promise<T> {
  return request<T>('DELETE', path, undefined, opts);
}

export { ApiError };
