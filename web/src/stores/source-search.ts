/**
 * Data feed for the "@" picker's source tabs (Notes, Slack, Mail, …): which sources the
 * server has (GET /api/mention-sources) and what each one finds
 * (GET /api/mention-sources/:id/search).
 *
 * The server already holds a deadline and a 60 s cache per source; this side debounces
 * keystrokes, aborts a superseded request, and keeps each answer for a minute (the server's
 * own TTL), so going back to a tab or retyping a query paints at once, while a long-lived
 * window still sees new mail and freshly edited notes. A source's own failure is an
 * answer (`error`), shown on its tab only.
 *
 * A request that fails outright (no answer, or a 404/5xx while the server restarts) is asked
 * again a few times before the tab says the source is not available (2026-11-12: a deploy
 * restarted the server under an open picker, and its Slack tab said "not available right
 * now" until the query was typed again). The tab stays on its loading line meanwhile.
 */
import { useEffect, useRef, useState } from 'react';
import { apiGet } from '@/api/client';
import { log } from '@/utils/log';
import type { MentionSourceInfo, MentionSourceRow } from '@/components/chat/mention-sources-model';
import { rememberSourceLabels } from '@/utils/entity-ref-tags';

const LIST_TTL_MS = 60_000;
const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_TIMEOUT_MS = 10_000;
const MEMO_CAP = 200;
const MEMO_TTL_MS = 60_000;
/** Waits before each new ask of a search that failed outright: about 15 s in all, a restart's length. */
export const SEARCH_RETRY_STEPS_MS = [1_000, 2_000, 4_000, 8_000];

let listMemo: { at: number; sources: MentionSourceInfo[] } | null = null;
let listInFlight: Promise<MentionSourceInfo[]> | null = null;

export async function fetchMentionSources(): Promise<MentionSourceInfo[]> {
  if (listMemo && Date.now() - listMemo.at < LIST_TTL_MS) return listMemo.sources;
  if (listInFlight) return listInFlight;
  listInFlight = apiGet<{ sources?: MentionSourceInfo[] }>('/api/mention-sources', undefined, { timeoutMs: 5000 })
    .then((res) => {
      const sources = (res.sources ?? []).filter((s) => s && typeof s.id === 'string' && typeof s.label === 'string')
        .map((s) => ({ ...s, keywords: Array.isArray(s.keywords) ? s.keywords : [], kinds: Array.isArray(s.kinds) ? s.kinds : [] }));
      listMemo = { at: Date.now(), sources };
      rememberSourceLabels(sources);
      return sources;
    })
    .catch((err) => {
      // An older server has no such route: the picker is then just Tasks and Files.
      log.warn('mention-sources', 'source list unavailable', { error: err instanceof Error ? err.message : String(err) });
      listMemo = { at: Date.now(), sources: listMemo?.sources ?? [] };
      return listMemo.sources;
    })
    .finally(() => { listInFlight = null; });
  return listInFlight;
}

/** The server's sources; [] until they arrive (and on an older server). */
export function useMentionSources(): MentionSourceInfo[] {
  const [sources, setSources] = useState<MentionSourceInfo[]>(() => listMemo?.sources ?? []);
  useEffect(() => {
    let live = true;
    void fetchMentionSources().then((s) => { if (live) setSources(s); });
    return () => { live = false; };
  }, []);
  return sources;
}

export interface SourceAnswer {
  rows: MentionSourceRow[];
  error?: string;
}

const memo = new Map<string, { at: number; answer: SourceAnswer }>();
const keyOf = (sourceId: string, q: string, limit: number) => `${sourceId}\u0000${limit}\u0000${q.toLowerCase()}`;

function remember(key: string, answer: SourceAnswer): void {
  memo.delete(key);
  if (memo.size >= MEMO_CAP) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, { at: Date.now(), answer });
}

function recall(key: string): SourceAnswer | undefined {
  const hit = memo.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at < MEMO_TTL_MS) return hit.answer;
  memo.delete(key);
  return undefined;
}

export async function searchSource(sourceId: string, q: string, limit: number, signal?: AbortSignal): Promise<SourceAnswer> {
  const res = await apiGet<{ items?: MentionSourceRow[]; error?: string }>(
    `/api/mention-sources/${encodeURIComponent(sourceId)}/search`,
    { q, limit: String(limit) },
    { signal, timeoutMs: SEARCH_TIMEOUT_MS, priority: 'low' },
  );
  return { rows: Array.isArray(res.items) ? res.items : [], ...(res.error ? { error: res.error } : {}) };
}

export interface SourceSearchState {
  /** Answers by source id, each for `forQuery`. */
  answers: Map<string, SourceAnswer>;
  forQuery: string;
  /** Source ids still waiting on an answer for the live query. */
  loading: Set<string>;
}

const EMPTY: SourceSearchState = { answers: new Map(), forQuery: '', loading: new Set() };

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const timer = window.setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * A failure a restart makes and that passes by itself: no connection, or the server answering 404 / 408 /
 * 429 / 5xx while it starts or stops. A deadline is not one (the source is slow, asking again only waits
 * longer), and neither is another 4xx (the same question gets the same answer).
 */
export function passingFailure(err: unknown): boolean {
  if (err instanceof DOMException) return false;
  if (err instanceof TypeError) return true;
  const status = (err as { name?: string; status?: unknown } | null)?.name === 'ApiError' ? Number((err as { status?: unknown }).status) : NaN;
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

/** `searchSource`, asked again after each step of `SEARCH_RETRY_STEPS_MS` while it fails in a way that passes. */
async function searchSourceRetrying(sourceId: string, q: string, limit: number, signal: AbortSignal): Promise<SourceAnswer> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await searchSource(sourceId, q, limit, signal);
    } catch (err) {
      const step = SEARCH_RETRY_STEPS_MS[attempt];
      if (signal.aborted || step === undefined || !passingFailure(err)) throw err;
      log.info('mention-sources', 'source search failed, asking again', { sourceId, q, attempt: attempt + 1, waitMs: step, error: err instanceof Error ? err.message : String(err) });
      await pause(step, signal);
      if (signal.aborted) throw err;
    }
  }
}

/**
 * Debounced search of several sources at once for one query. `sourceIds` empty yields the
 * idle state. Every source answers on its own: a slow one never holds the others' rows.
 */
export function useSourceSearch(sourceIds: readonly string[], query: string, limit: number, debounceMs = SEARCH_DEBOUNCE_MS): SourceSearchState {
  const q = query.trim();
  const idsKey = sourceIds.join(',');
  const [state, setState] = useState<SourceSearchState>(EMPTY);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const ids = idsKey ? idsKey.split(',') : [];
    if (ids.length === 0) { setState(EMPTY); return; }
    const answers = new Map<string, SourceAnswer>();
    const loading = new Set<string>();
    for (const id of ids) {
      const hit = recall(keyOf(id, q, limit));
      if (hit) answers.set(id, hit); else loading.add(id);
    }
    setState({ answers: new Map(answers), forQuery: q, loading: new Set(loading) });
    if (loading.size === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(() => {
      for (const id of loading) {
        searchSourceRetrying(id, q, limit, controller.signal)
          .catch((err): SourceAnswer => {
            if (controller.signal.aborted) return { rows: [] };
            log.warn('mention-sources', 'source search failed', { sourceId: id, q, error: err instanceof Error ? err.message : String(err) });
            return { rows: [], error: 'failed' };
          })
          .then((answer) => {
            if (controller.signal.aborted) return;
            // A timeout is not kept: the next keystroke should ask again.
            if (!answer.error) remember(keyOf(id, q, limit), answer);
            setState((prev) => {
              if (prev.forQuery !== q) return prev;
              const nextAnswers = new Map(prev.answers);
              nextAnswers.set(id, answer);
              const nextLoading = new Set(prev.loading);
              nextLoading.delete(id);
              return { answers: nextAnswers, forQuery: q, loading: nextLoading };
            });
          });
      }
    }, debounceMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [idsKey, q, limit, debounceMs]);

  return state;
}

/** Test-only reset. */
export function __resetSourceSearch(): void {
  memo.clear();
  listMemo = null;
  listInFlight = null;
}
