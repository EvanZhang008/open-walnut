/**
 * A grouped mail read that failed because the link dropped is read again by itself.
 *
 * 2026-11-09, the person: "why this is not reload correctly? automatically". A deploy restarted the
 * server under an open Mail window; every group page in flight failed with WebKit's bare "Load
 * failed" (a network error, no status), and nothing read them again, so five groups sat on
 * "Load failed Retry" until he pressed each button.
 *
 * A transient failure (no answer, 408, 429, a 5xx) schedules the same read again with backoff, and
 * every waiting read runs at once when the socket reconnects, the page becomes visible or the
 * browser comes back online. While a read waits, the list says it is reconnecting instead of
 * showing an error; only a failure that outlasts the series (or one that is not transient, an
 * auth refusal say) shows its reason and the Retry button.
 */
import { mailFailure, type MailFailure } from '@/api/mail';
import { onPageVisible, runWhenVisible } from '@/utils/page-visibility';
import { wsClient } from '@/api/ws';

/** About two minutes in all: longer than a deploy's restart, short enough to say so if it lasts. */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];

/** What the list shows while a read waits for its next try. */
export const RETRYING_LINE = 'Connection lost, reconnecting…';

/** What each engine's fetch says when no answer came: WebKit, Chromium, Firefox, WebKit mid-response. */
const NO_ANSWER = /^(load failed|failed to fetch|networkerror when attempting to fetch resource\.?|the network connection was lost\.?)$/i;

/**
 * Worth reading again: the server did not answer (a network error or the request's deadline), or
 * said it could not answer now. A status-0 failure that is neither (a bug in the code reading the
 * answer) is shown at once, never dressed up as a lost connection.
 */
export function isTransientError(error: unknown): boolean {
  const { status } = mailFailure(error);
  if (status === 408 || status === 429 || status >= 500) return true;
  if (status !== 0) return false;
  if (error instanceof DOMException) return error.name === 'TimeoutError';
  return error instanceof TypeError && NO_ANSWER.test(error.message.trim());
}

/** The reason a failure that lasted is shown with: a bare "Load failed" says nothing to a person. */
export function failureLine(failure: Pick<MailFailure, 'status' | 'message'>): string {
  if (failure.status === 0) return `Walnut did not answer (${failure.message || 'no connection'}).`;
  return failure.message;
}

interface Waiting {
  run: () => void;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Its read has started (by the timer or a wake); the next failure or success replaces the entry. */
  ran: boolean;
}

const waiting = new Map<string, Waiting>();
/** Reads whose series ran out: a reconnect, a visible edge or `online` still tries them once more. */
const spent = new Map<string, () => void>();

/**
 * A read under `key` failed. Returns true when it will be read again by itself (the caller shows the
 * reconnecting line), false when the failure is shown with Retry.
 */
export function retryLater(key: string, error: unknown, run: () => void): boolean {
  const held = waiting.get(key);
  if (held?.timer) clearTimeout(held.timer);
  if (!isTransientError(error)) { waiting.delete(key); spent.delete(key); return false; }
  const attempt = held ? held.attempt + 1 : 0;
  if (attempt >= RETRY_DELAYS_MS.length) {
    // Spent: the next failure (a Retry press, a wake) starts a fresh series.
    waiting.delete(key);
    spent.set(key, run);
    return false;
  }
  spent.delete(key);
  const entry: Waiting = { run, attempt, timer: null, ran: false };
  entry.timer = setTimeout(() => {
    entry.timer = null;
    // A hidden tab reads on its visible edge, one read per key (a wake on that edge may run it first).
    runWhenVisible(`mail-retry:${key}`, () => { start(key, entry); });
  }, RETRY_DELAYS_MS[attempt]);
  waiting.set(key, entry);
  return true;
}

/** The read under `key` succeeded (or was dropped): forget its series. */
export function retrySettled(key: string): void {
  const held = waiting.get(key);
  if (held?.timer) clearTimeout(held.timer);
  waiting.delete(key);
  spent.delete(key);
}

/** Is a read under `key` waiting for its next try? */
export function retryPending(key: string): boolean {
  return waiting.has(key);
}

/** Run a waiting read once: a timer and a wake that both reach it start one read. */
function start(key: string, entry: Waiting): void {
  if (waiting.get(key) !== entry || entry.ran) return;
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  entry.ran = true;
  entry.run();
}

/**
 * The link is back: every waiting read goes now, keeping its place in the series, and every spent one
 * gets one more try (a failure starts it a fresh series). A read already on its way is left alone.
 */
export function retryNow(): void {
  const again = [...spent.values()];
  spent.clear();
  for (const [key, entry] of [...waiting]) start(key, entry);
  for (const run of again) run();
}

export function resetLoadRetries(): void {
  for (const entry of waiting.values()) if (entry.timer) clearTimeout(entry.timer);
  waiting.clear();
  spent.clear();
}

if (typeof window !== 'undefined') {
  wsClient.onEvent('_ws:reconnected', () => { retryNow(); });
  onPageVisible(() => { retryNow(); });
  window.addEventListener('online', () => { retryNow(); });
}
