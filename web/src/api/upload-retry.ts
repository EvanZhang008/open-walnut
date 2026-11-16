/**
 * The one retry every attachment upload goes through (a pasted or dropped
 * picture, an attached file, a note's image, a spilled paste).
 *
 * An upload that fails for a reason that clears on its own (the connection to
 * Walnut dropped, the server is restarting after a deploy, a proxy's 502/503/504,
 * a timeout) is not an error the person has to act on: it waits and tries again
 * by itself, with a growing pause, and at once when the page's socket to Walnut
 * reconnects or the browser comes back online. Only a real failure (too large,
 * a type the server refuses, a refusal) is thrown, with words that say what to do.
 *
 * While it waits, `onWaiting` is told (the composer shows "Waiting for Walnut"
 * on the attachment instead of a red error), and the attachment stays pending, so
 * a send made meanwhile waits for it instead of being blocked.
 *
 * Guard: tests/web/upload-retry-guard.test.ts fails when a file under web/src
 * calls an upload route without importing this module.
 */

/** What an attachment says while it waits to try again. */
export const UPLOAD_WAITING = 'Waiting for Walnut to reconnect';
/** The reasons that mean this page lost Walnut itself (not a session's host, not the Mac behind a replica). */
export const CONNECTION_DROPPED = 'The connection to Walnut dropped';
export const WALNUT_UNREACHABLE = 'Walnut is not reachable right now';
export function isConnectionReason(reason: string | undefined): boolean {
  return !reason || reason === CONNECTION_DROPPED || reason === WALNUT_UNREACHABLE || reason === UPLOAD_WAITING;
}

/** What a refusal of this browser's sign-in says to do (a retry cannot fix it). */
export const SIGN_IN_REFUSED = 'Walnut did not accept this browser\'s sign-in: reload the page, then attach it again';

/**
 * A failed try, said in words, and whether it clears on its own. `maxTries`: a
 * failure that may clear (a host's unexplained write error) is tried only that
 * many times in all, then thrown.
 */
export class UploadAttemptError extends Error {
  constructor(message: string, readonly transient: boolean, readonly code?: string, readonly maxTries?: number) {
    super(message);
    this.name = 'UploadAttemptError';
  }
}

/**
 * HTTP answers that clear on their own: no answer at all (0), a timeout (408),
 * too many at once (429), and a proxy or server between restarts (502, 503, 504).
 */
export function transientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

/** Whether a failed try clears on its own and is tried again. */
export function isTransientUploadError(err: unknown): boolean {
  if (err instanceof UploadAttemptError) return err.transient;
  // An ApiError (client.ts), read by its shape: this module stays free of the client's import.
  if (err instanceof Error && err.name === 'ApiError' && typeof (err as { status?: unknown }).status === 'number') {
    return transientStatus((err as unknown as { status: number }).status);
  }
  // fetch()'s own network failure ("Failed to fetch" in Chromium, "Load failed" in
  // WebKit, "NetworkError when attempting to fetch resource." in Firefox); any other
  // TypeError is a bug, and is thrown.
  if (err instanceof TypeError) return /failed to fetch|load failed|networkerror|network connection/i.test(err.message);
  if (err instanceof DOMException && err.name === 'TimeoutError') return true;
  return false;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** The pause before retry `i` (0-based): 1, 2, 4, then 8 s each. */
export function uploadRetryDelay(i: number): number {
  return Math.min(8_000, 1_000 * 2 ** i);
}

/**
 * Called once when Walnut is likely back: the page's socket reconnected, or the
 * browser came back online. Answers the unsubscribe.
 *
 * The socket client is loaded only here, when an upload already waits: the
 * modules that upload (the notes API among them) stay free of it, and of what it
 * imports (2026-11-16: the notes round-trip suite could not load ws.ts's imports).
 */
function onLikelyBack(cb: () => void): () => void {
  let stopped = false;
  let offWs = () => {};
  void import('./ws').then(({ wsClient }) => {
    if (stopped) return;
    const onState = (state: string) => { if (state === 'connected') cb(); };
    wsClient.onConnectionChange(onState);
    offWs = () => wsClient.offConnectionChange(onState);
  }, () => { /* no socket client here: the timer and the online event still wake it */ });
  const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
  if (hasWindow) window.addEventListener('online', cb);
  return () => {
    stopped = true;
    offWs();
    if (hasWindow) window.removeEventListener('online', cb);
  };
}

/** Wait `ms`, cut short when Walnut is likely back; rejects with an AbortError on abort. */
function pauseUntilBack(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Upload cancelled', 'AbortError')); return; }
    let off = () => {};
    const done = () => { clearTimeout(timer); off(); signal?.removeEventListener('abort', onAbort); };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    // A short beat after the reconnect: the socket opens a moment before every route answers.
    off = onLikelyBack(() => { done(); setTimeout(resolve, 250); });
    const onAbort = () => { done(); reject(new DOMException('Upload cancelled', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface UploadRetryOptions {
  signal?: AbortSignal;
  /**
   * How long transient failures may go on, from the first try, before the last
   * one is thrown. Unset: no limit (an attachment in a composer waits for Walnut
   * as long as it is attached; removing it aborts). A send that uploads at send
   * time passes one, so its own error and retry take over.
   */
  budgetMs?: number;
  /** Told when a try failed and the next waits (with why), and when a try starts again (null). */
  onWaiting?: (reason: string | null) => void;
  /** Pauses between tries (tests). */
  delay?: (i: number) => number;
}

/**
 * Run `attempt` until it succeeds, retrying transient failures (see above).
 * A real failure, or an abort, is thrown at once.
 */
export async function withUploadRetry<T>(attempt: () => Promise<T>, opts: UploadRetryOptions = {}): Promise<T> {
  const started = Date.now();
  const delay = opts.delay ?? uploadRetryDelay;
  let limited = 0;
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (isAbort(err) || opts.signal?.aborted || !isTransientUploadError(err)) throw err;
      if (err instanceof UploadAttemptError && err.maxTries && ++limited >= err.maxTries) throw err;
      const wait = delay(i);
      if (opts.budgetMs !== undefined && Date.now() - started + wait > opts.budgetMs) throw err;
      opts.onWaiting?.(err instanceof Error && err.message ? err.message : UPLOAD_WAITING);
      await pauseUntilBack(wait, opts.signal);
      if (opts.signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
      opts.onWaiting?.(null);
    }
  }
}

/** The budget of an upload made at send time: past it, the send's own error and retry take over. */
export const SEND_TIME_UPLOAD_BUDGET_MS = 2 * 60_000;
