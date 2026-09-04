import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchSlashCommands, fetchSessionSlashCommands,
  type SlashCommandItem, type SlashCommandsResult,
} from '@/api/slash-commands';
import { perf } from '@/utils/perf-logger';

interface CacheEntry extends SlashCommandsResult {
  /** When this result was fetched (epoch ms) — drives the on-open revalidation. */
  at: number;
}

// Module-level global cache: shared across all hook instances (e.g. multiple DockTaskCards).
// Each key is fetched at most once per mount — avoids 3x duplicate requests (22KB each).
const globalCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, Promise<SlashCommandsResult>>();

/** A cached list older than this is revalidated (in the background) when the palette opens. */
const OPEN_REVALIDATE_AFTER_MS = 60_000;
/**
 * Backoff for automatic retries after a result that is not the final answer —
 * a degraded one (host unreachable) or, for a live session, a discovery
 * fallback (its CLI has not reported yet). The palette used to keep a degraded
 * list until the user found the Refresh button; now it converges by itself.
 */
const RETRY_BACKOFF_MS = [3_000, 8_000, 20_000, 45_000, 90_000];

// Key on session id when we have one (the CLI's own list), else on BOTH cwd and
// host so remote/local discovery lists never share a cache entry.
function cacheKeyOf(cwd?: string, host?: string, sessionId?: string): string {
  if (sessionId) return `session::${sessionId}`;
  return `${cwd ?? '__no_cwd__'}::${host ?? '__local__'}`;
}

/** True when a result is the best one this key can get — nothing left to retry for. */
function isSettled(result: SlashCommandsResult, sessionId?: string): boolean {
  if (result.degraded) return false;
  return sessionId ? result.source === 'cli' : true;
}

export interface UseSlashCommands {
  items: SlashCommandItem[];
  loading: boolean;
  /** Where the current list came from, and whether the host could be reached. */
  status: Pick<SlashCommandsResult, 'source' | 'degraded'>;
  search: (query: string) => SlashCommandItem[];
  /** Force a fresh server-side re-scan (bypasses both caches). */
  refresh: () => void;
  /** Call when the palette opens: revalidates in the background if the list is
   *  stale or not settled. Cheap for a live session (a memory lookup server-side). */
  onPaletteOpen: () => void;
}

/**
 * The slash commands a composer can offer.
 *
 * With a `sessionId` (a live session) the list is what that session's CLI
 * advertised in its init line, decorated with descriptions — never a Walnut
 * re-discovery of the host. Without one (draft composers) it is the directory
 * scan for the cwd/host pair.
 *
 * Stale-while-revalidate: a cached list (if any) is shown instantly, then a
 * background fetch refreshes it. Results that are not settled (degraded, or
 * discovery for a live session) retry automatically with backoff while the
 * hook is mounted, and every palette open revalidates a list older than a
 * minute. `refresh()` forces a server-side re-scan (?fresh=1).
 */
export function useSlashCommands(cwd?: string, host?: string, sessionId?: string): UseSlashCommands {
  const [items, setItems] = useState<SlashCommandItem[]>([]);
  const [status, setStatus] = useState<UseSlashCommands['status']>({ source: 'discovery', degraded: false });
  const [loading, setLoading] = useState(false);
  // Track the latest key so an in-flight refresh for a stale key never overwrites items.
  const keyRef = useRef('');
  const retryTimerRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const applyResult = useCallback((key: string, result: SlashCommandsResult) => {
    if (keyRef.current !== key) return;
    setItems(result.items);
    setStatus({ source: result.source, degraded: result.degraded });
  }, []);

  // Fetch one key (non-fresh unless asked), publish it, and arm the next retry
  // if the answer is not settled. Defined as a ref-stable function so the retry
  // timer can call back into it without re-creating effects.
  const runRef = useRef<(fresh: boolean) => Promise<void>>(async () => {});
  runRef.current = async (fresh: boolean) => {
    const key = cacheKeyOf(cwd, host, sessionId);
    const result = await revalidate(key, cwd, host, sessionId, fresh);
    if (keyRef.current !== key) return;
    if (result) applyResult(key, result);
    clearRetry();
    // A failed fetch keeps the stale list; it still deserves a retry unless what
    // we already hold is the settled answer.
    const held = result ?? globalCache.get(key);
    if (held && isSettled(held, sessionId)) {
      retryCountRef.current = 0;
      return;
    }
    const attempt = retryCountRef.current;
    if (attempt >= RETRY_BACKOFF_MS.length) return;
    retryCountRef.current = attempt + 1;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      void runRef.current(false);
    }, RETRY_BACKOFF_MS[attempt]);
  };

  const load = useCallback((fresh: boolean) => {
    const key = cacheKeyOf(cwd, host, sessionId);
    keyRef.current = key;
    clearRetry();
    retryCountRef.current = 0;
    const cached = globalCache.get(key);
    if (cached) applyResult(key, cached);          // show stale immediately
    if (cached && !fresh) {
      // Revalidate in the background — no spinner, no flash.
      void runRef.current(false);
      return;
    }

    setLoading(true);
    void runRef.current(fresh).finally(() => { if (keyRef.current === key) setLoading(false); });
  }, [cwd, host, sessionId, applyResult, clearRetry]);

  useEffect(() => {
    load(false);
    return () => {
      clearRetry();
      // A fetch resolving after unmount must neither publish nor arm a retry.
      keyRef.current = '';
    };
  }, [load, clearRetry]);

  /** Force a fresh server-side re-scan (bypasses both caches). */
  const refresh = useCallback(() => { load(true); }, [load]);

  const onPaletteOpen = useCallback(() => {
    const key = cacheKeyOf(cwd, host, sessionId);
    const cached = globalCache.get(key);
    if (cached && isSettled(cached, sessionId) && Date.now() - cached.at < OPEN_REVALIDATE_AFTER_MS) return;
    if (inflightRequests.has(key)) return;
    void runRef.current(false);
  }, [cwd, host, sessionId]);

  const search = useCallback((query: string): SlashCommandItem[] => {
    if (!query) return items;
    const q = query.toLowerCase();
    // Score: name prefix > name contains > description contains
    const scored: { item: SlashCommandItem; score: number }[] = [];
    for (const item of items) {
      const nameLower = item.name.toLowerCase();
      const descLower = item.description.toLowerCase();
      if (nameLower.startsWith(q)) {
        scored.push({ item, score: 3 });
      } else if (nameLower.includes(q)) {
        scored.push({ item, score: 2 });
      } else if (descLower.includes(q)) {
        scored.push({ item, score: 1 });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    return scored.map((s) => s.item);
  }, [items]);

  return { items, loading, status, search, refresh, onPaletteOpen };
}

/**
 * Fetch one key (deduping concurrent callers) and write the global cache.
 * Returns null on failure so the caller keeps whatever (stale) list it has —
 * transient daemon/ssh failures shouldn't blank the palette.
 * `fresh` forces a server-side re-scan via ?fresh=1.
 */
async function revalidate(
  key: string,
  cwd: string | undefined,
  host: string | undefined,
  sessionId: string | undefined,
  fresh: boolean,
): Promise<SlashCommandsResult | null> {
  // A forced refresh must not reuse a non-fresh inflight request.
  let promise = fresh ? undefined : inflightRequests.get(key);
  if (!promise) {
    const endPerf = perf.start('slash-commands:fetch');
    promise = sessionId ? fetchSessionSlashCommands(sessionId, fresh) : fetchSlashCommands(cwd, host, fresh);
    inflightRequests.set(key, promise);
    promise.then((r) => endPerf(`${r.items.length} cmds · ${r.source}${r.degraded ? ' · degraded' : ''}`)).catch(() => endPerf('error'));
    promise.finally(() => {
      if (inflightRequests.get(key) === promise) inflightRequests.delete(key);
    });
  }

  try {
    const result = await promise;
    globalCache.set(key, { ...result, at: Date.now() });
    return result;
  } catch {
    return null;
  }
}
