/**
 * When ui-prefs-sync.ts asks the server for the user's prefs again after the boot read failed
 * (a deploy, a busy Mac), and which answers end the asking.
 */

/** The boot read: the first render waits on no more than this. */
export const BOOT_TIMEOUT_MS = 2500;
/** After a failed first read: wait, then ask with a longer deadline. About two minutes in all. */
export const RETRY_PLAN: ReadonlyArray<{ waitMs: number; timeoutMs: number }> = [
  { waitMs: 1_000, timeoutMs: 5_000 },
  { waitMs: 3_000, timeoutMs: 8_000 },
  { waitMs: 6_000, timeoutMs: 12_000 },
  { waitMs: 12_000, timeoutMs: 15_000 },
  { waitMs: 20_000, timeoutMs: 20_000 },
  { waitMs: 30_000, timeoutMs: 30_000 },
];
/** Past the plan: one try every few minutes, plus one whenever the page comes back online or into view. */
export const SLOW_RETRY_MS = 5 * 60_000;
export const EVENT_RETRY_TIMEOUT_MS = 15_000;

/**
 * A refusal that asking again will not change (a 4xx other than a timeout or rate limit):
 * the page syncs as it did before this retry existed, on its local values.
 */
export function settledRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}
