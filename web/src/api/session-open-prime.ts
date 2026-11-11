import { fetchSessionHistory, HISTORY_TAIL_LIMIT, type SessionHistoryResult } from './sessions';
import { getHistoryCache } from '@/cache/session-cache';

interface Prime { promise: Promise<SessionHistoryResult>; timer: ReturnType<typeof setTimeout> }
const primes = new Map<string, Prime>();

/** Start the first read at the click, before mounting a dense Home page's column. */
export function primeSessionOpenHistory(sessionId: string): void {
  if (getHistoryCache(sessionId) || primes.has(sessionId)) return;
  const promise = fetchSessionHistory(sessionId, { source: 'streams', tail: HISTORY_TAIL_LIMIT });
  promise.catch(() => {});
  const timer = setTimeout(() => { if (primes.get(sessionId)?.promise === promise) primes.delete(sessionId); }, 30_000);
  primes.set(sessionId, { promise, timer });
}

/** Both history consumers mounted in the same commit join the click's read, not a new fetch. */
export function takeSessionOpenHistory(sessionId: string): Promise<SessionHistoryResult> | null {
  const prime = primes.get(sessionId);
  if (!prime) return null;
  queueMicrotask(() => {
    if (primes.get(sessionId) !== prime) return;
    primes.delete(sessionId);
    clearTimeout(prime.timer);
  });
  return prime.promise;
}
