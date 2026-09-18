/**
 * Retry a fetch whose failure the next attempt can fix.
 *
 * A boot-time registry (folder names, project rows, custom tiers, the engine
 * catalog, plugin apps) is fetched once and read for the life of the page. Every
 * one of them used to be a single attempt with a swallowed error, so when that
 * attempt died the page ran on an empty registry until a manual reload.
 * 2026-09-17: a hidden tab reloaded onto a new build while the server's event
 * loop was stalled for ~15s; the client's 6-slot connection queue rejected
 * everything that had waited 20s, and every folder in the task list lost its
 * name. The task list itself recovered because it already retried. The default
 * schedule below covers ~30s, longer than the stall that caused it.
 *
 * Callers keep their last good value: this only ever REPLACES state from a
 * successful answer, and the caller decides what an exhausted retry means.
 */
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';

/** Wait before each retry; the length is the retry budget. */
export const REGISTRY_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000];

/**
 * A failure the next attempt can fix: a timeout (including the connection
 * queue's "pool saturated" rejection, which never reached the server), a network
 * error, a 5xx, or a 2xx whose body failed validation. Never a 4xx: the server
 * answered, and asking again will not change its mind.
 */
export function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status < 400 || error.status >= 500;
  }
  if (error instanceof TypeError) return true;
  return error instanceof Error && error.name === 'TimeoutError';
}

export interface FetchRetryFailure {
  /** 1-based attempt number that failed. */
  attempt: number;
  /** True when another attempt is scheduled `delayMs` from now. */
  willRetry: boolean;
  delayMs?: number;
}

export interface FetchRetryOptions {
  /** Log subsystem, e.g. 'tasks'. */
  subsystem: string;
  /** What is being fetched, for the log line: 'task folder registry'. */
  label: string;
  /** Overrides the default schedule (tests, or a caller with a tighter budget). */
  delaysMs?: readonly number[];
  /**
   * Aborting ends the wait between attempts and rejects with an AbortError
   * without logging: an unmount or a superseding call is not a failure. This
   * signal is the ONLY thing read as an intentional cancel; an AbortError from
   * elsewhere is classified like any other error.
   */
  signal?: AbortSignal;
  isRetryable?: (error: unknown) => boolean;
  /**
   * Called on every failed attempt, before the wait. Lets a caller degrade at
   * once (publish its fallback, stop a spinner) while the retries continue,
   * instead of holding its consumers for the whole schedule.
   */
  onFailure?: (error: unknown, failure: FetchRetryFailure) => void;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted.', 'AbortError');
  }
}

/** Resolves after `ms`; rejects with an AbortError the moment `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      try { throwIfAborted(signal); } catch (err) { reject(err); }
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `attempt` until it resolves, retrying retryable failures on the schedule.
 * Rejects with the last error once the schedule is spent or the error is one a
 * retry cannot fix. Every failure is logged with the attempt number so a
 * registry that ends up empty has a trace saying why: a spent schedule is an
 * error, while a non-retryable answer is the server's verdict (an old server
 * without the route answers 404 on every load) and stays at warn.
 */
export async function fetchWithRetry<T>(attempt: () => Promise<T>, opts: FetchRetryOptions): Promise<T> {
  const delays = opts.delaysMs ?? REGISTRY_RETRY_DELAYS_MS;
  const retryable = opts.isRetryable ?? isRetryableFetchError;
  for (let n = 0; ; n++) {
    throwIfAborted(opts.signal);
    try {
      return await attempt();
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      const delay = delays[n];
      const isRetryable = retryable(error);
      const canRetry = delay !== undefined && isRetryable;
      const failure: FetchRetryFailure = { attempt: n + 1, willRetry: canRetry, ...(canRetry ? { delayMs: delay } : {}) };
      if (!canRetry) {
        const exhausted = delay === undefined;
        const fields = { attempt: n + 1, error: String(error), retryable: isRetryable, exhausted };
        if (exhausted) log.error(opts.subsystem, `${opts.label} fetch failed`, fields);
        else log.warn(opts.subsystem, `${opts.label} fetch failed`, fields);
        opts.onFailure?.(error, failure);
        throw error;
      }
      log.warn(opts.subsystem, `${opts.label} fetch failed, retrying in ${delay}ms`, {
        attempt: n + 1, error: String(error),
      });
      opts.onFailure?.(error, failure);
      await sleep(delay, opts.signal);
    }
  }
}
