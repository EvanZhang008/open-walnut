/**
 * The retry of a user's write (docs/plan/walnut-replica-servers-impl.md,
 * section 3, "Op ids"): one op id per user action, kept across every attempt,
 * so a host replica and the Mac apply the action once whichever attempt got
 * through (the Mac's applied-ops ledger dedupes by it). Each attempt gets the
 * id and passes it to the API call (`{ opId }`).
 *
 * Not retried: a 4xx (the server answered), and an answer that says the write
 * may have been kept or must wait: a 504 whose body says `error.sent: true`
 * (it reached the Mac, which may have applied it), a 503 `leader_unsure` with
 * `why: 'lost_answer'` (an earlier try may be journaled) or `journal_unwritable`.
 * Those are surfaced, as their message asks ("check it before you try again").
 * A 504 `sent: false` and a plain 503 `leader_unsure` (the forward failed before
 * a byte reached the Mac, and the daemon journaled nothing) were never applied
 * and are retried.
 *
 * The client's own deadline (its fetch timeout, which fires before a replica's
 * write budget does) is retried under the same id by design: the write may have
 * reached a slow Mac, and the Mac's applied-ops ledger with its in-flight op-id
 * reservation (WP9) applies the action once.
 */
import { ApiError } from './client';
import { mintOpId } from './op-id';

/** The replica's error code and `sent` flag, when the body has its shape ({ error: { code, sent } }). */
function replicaError(err: ApiError): { code?: string; sent?: boolean; why?: string } {
  const body = err.body as { error?: unknown } | undefined;
  const e = body && typeof body === 'object' ? body.error : undefined;
  if (!e || typeof e !== 'object') return {};
  const { code, sent, why } = e as { code?: unknown; sent?: unknown; why?: unknown };
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof sent === 'boolean' ? { sent } : {}),
    ...(typeof why === 'string' ? { why } : {}),
  };
}

/** Whether a failed write may be tried again (with the same op id). */
export function writeRetryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  if (err.status >= 400 && err.status < 500) return false;
  const { code, sent, why } = replicaError(err);
  if (err.status === 504 && sent === true) return false;
  if (err.status === 503 && code === 'leader_unsure' && why === 'lost_answer') return false;
  if (err.status === 503 && code === 'journal_unwritable') return false;
  return true;
}

/** A newer action took this write's place before one of its retries: the retries were dropped. */
export class WriteSuperseded extends Error {
  constructor() {
    super('A newer change took the place of this one.');
    this.name = 'WriteSuperseded';
  }
}

/**
 * Run a write, retried `retries` times on a retryable failure, every attempt
 * under one op id. `delay`: a number is the base of a growing wait (base,
 * 2 x base, ...); a function gives the wait before retry `i` (0-based).
 * `superseded`: looked at before each retry; once true, the retries are
 * dropped and the write rejects with WriteSuperseded.
 */
export async function withWriteRetry<T>(
  fn: (opId: string) => Promise<T>,
  retries = 2,
  delay: number | ((i: number) => number) = 300,
  superseded?: () => boolean,
): Promise<T> {
  const opId = mintOpId();
  const waitFor = typeof delay === 'function' ? delay : (i: number) => delay * (i + 1);
  let lastErr: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(opId); }
    catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (!writeRetryable(lastErr)) throw lastErr;
      if (i < retries) {
        await new Promise((r) => setTimeout(r, waitFor(i)));
        if (superseded?.()) throw new WriteSuperseded();
      }
    }
  }
  throw lastErr!;
}
