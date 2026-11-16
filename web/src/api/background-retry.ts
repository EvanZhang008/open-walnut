/**
 * A request nobody clicked is tried again, quietly, before anyone hears of it.
 *
 * 2026-11-16, the user, on a red `PUT /api/drafts → 500` card for a draft save that
 * waited on a busy file: "is there retry etc, can we avoid error unless we really try",
 * "only error useful to customer". The rule, one place for every call through
 * api/client.ts:
 *
 * - A read (every GET) and a write that asks for it with `quietRetry: true` (a draft save,
 *   the settings sync, a visit batch: writes the browser makes on its own, safe to send
 *   twice) are sent again after a short, growing wait when the failure is one a moment can
 *   cure: the connection dropped, the server answered 500 or 502, or it answered 503 saying
 *   `retry: true` (busy now, e.g. drafts.json's lock). A retry that succeeds leaves no trace
 *   but the log.
 * - A failure that stays is still only logged (the browser log and the server log);
 *   the caller decides what, if anything, the person must hear. A request failing on
 *   the server never raises a card by itself (src/web/routes/route-error-log.ts).
 * - Any other write is not retried here (a click, or a background write such as a refresh
 *   request whose resend would act twice): it may have landed,
 *   and its caller says what was not saved where they made it (withWriteRetry,
 *   OperationErrorBridge, a failed message bubble with its Retry).
 *
 * Never retried: an answer (any 4xx, a 501), a status the caller expects (quietStatuses),
 * the caller's own abort, a deadline that already ran out and a 504 (the server is slow:
 * sending it again would add to its load), a 503 that does not ask for it (a dependency is
 * down), and a page that is going away.
 */
import { ApiError } from './api-error';
import { writeRetryable } from './write-retry';

/** The waits before each retry; the length is how many retries a request gets (tests shorten it). */
export const quietRetryTiming: { delaysMs: number[] } = { delaysMs: [600, 2_000] };

/** The waits for this request, each with up to a quarter more at random so many tabs do not retry at once. */
export function quietRetryDelays(random: () => number = Math.random): number[] {
  return quietRetryTiming.delaysMs.map((ms) => Math.round(ms * (1 + random() / 4)));
}

/** A 503 whose body says to try again (`{ retry: true }`): busy now, not a dependency down. */
function asksForRetry(err: ApiError): boolean {
  return (err.body as { retry?: unknown } | undefined)?.retry === true;
}

/** Whether a failed read, or a write that asked for quiet retries, may be sent again after a wait. */
export function quietlyRetryable(err: unknown, opts: { write: boolean; quietStatuses?: number[] }): boolean {
  if (err instanceof DOMException) return false; // the caller's abort, or a deadline that ran out
  if (err instanceof ApiError) {
    if (opts.quietStatuses?.includes(err.status)) return false;
    if (!(err.status === 500 || err.status === 502 || (err.status === 503 && asksForRetry(err)))) return false;
    // A write's answer may say it was kept, or must not be sent again blind (write-retry.ts).
    return !opts.write || writeRetryable(err);
  }
  // fetch's own failure: the connection dropped or was refused.
  return err instanceof TypeError;
}
