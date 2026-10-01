/**
 * The slower data feed behind the composer's "@" Tasks group: hybrid search.
 *
 * GET /api/search (full-text + vector, the same engine the task search box
 * uses) is the layer that turns "login bug" into "OAuth callback 401". It is
 * NOT per-keystroke: an uncached hybrid query costs real server work
 * (embedding + vector legs), so the hook debounces briefly and aborts
 * superseded requests. The palette paints the local fuzzy layer first and
 * folds these hits in when they land, so the user never waits on it — the list
 * just gets smarter a beat later.
 *
 * Sessions are searched too: a hit on a transcript names the task that owns
 * the session (the slim row's `id`), and the palette folds it into that task's
 * row (mention-entities.ts, hitsAsTasks).
 */
import { useEffect, useRef, useState } from 'react';
import { apiGet } from '@/api/client';
import { log } from '@/utils/log';

/**
 * One slim row from GET /api/search?slim=1 (src/web/routes/search.ts). For a
 * session row `id` is the id of the task that OWNS the transcript (the
 * session's own id when no task does) and `ref` is the `<session-ref/>` that
 * names the session itself.
 */
export interface EntitySearchHit {
  type: 'task' | 'session' | 'memory';
  id: string;
  title: string;
  summary: string;
  phase?: string;
  project?: string;
  ref?: string;
  isAutoExpanded?: boolean;
}

const SEARCH_DEBOUNCE_MS = 220;
const SEARCH_LIMIT = 20;
const SEARCH_TIMEOUT_MS = 8_000;
const SEARCH_MEMO_CAP = 60;

/** Per-page memo so retyping a query paints its server hits instantly. */
const memo = new Map<string, EntitySearchHit[]>();

function remember(q: string, hits: EntitySearchHit[]): void {
  if (memo.size >= SEARCH_MEMO_CAP) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(q, hits);
}

export async function searchEntities(q: string, signal?: AbortSignal): Promise<EntitySearchHit[]> {
  const res = await apiGet<{ results: EntitySearchHit[] }>(
    '/api/search',
    { q, types: 'task,session', slim: '1', limit: String(SEARCH_LIMIT) },
    { signal, timeoutMs: SEARCH_TIMEOUT_MS },
  );
  // Rows injected as children of a matching parent are not hits themselves.
  return (res.results ?? [])
    .filter((r) => (r.type === 'task' || r.type === 'session') && !r.isAutoExpanded);
}

export interface EntitySearchState {
  /** Hits for `forQuery` (possibly from the memo); [] while nothing matched. */
  hits: EntitySearchHit[];
  /** The trimmed query these hits answer — compare with the live query before
   *  merging, so stale hits never re-rank a newer query's list. */
  forQuery: string;
  /** A request for the live query is in flight (or waiting on the debounce). */
  loading: boolean;
}

const IDLE: EntitySearchState = { hits: [], forQuery: '', loading: false };

/**
 * Debounced hybrid search for the palette. `enabled=false` or an empty query
 * yields the idle state without touching the network.
 */
export function useEntitySearch(query: string, enabled: boolean): EntitySearchState {
  const q = enabled ? query.trim() : '';
  const [state, setState] = useState<EntitySearchState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (!q) { setState(IDLE); return; }
    const memoized = memo.get(q);
    if (memoized) { setState({ hits: memoized, forQuery: q, loading: false }); return; }
    setState((prev) => ({ ...prev, loading: true }));
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(() => {
      searchEntities(q, controller.signal)
        .then((hits) => {
          if (controller.signal.aborted) return;
          remember(q, hits);
          setState({ hits, forQuery: q, loading: false });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          log.warn('mention-search', 'hybrid search failed (local results stay)', {
            q, error: err instanceof Error ? err.message : String(err),
          });
          // An error is still an answer for THIS query: the palette's "settled
          // and empty" auto-close keys on forQuery, and a stale forQuery would
          // leave a multi-word query open on an empty list, swallowing Enter.
          setState({ hits: [], forQuery: q, loading: false });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  return state;
}

/** Test-only reset. */
export function __resetMentionSearch(): void {
  memo.clear();
}
