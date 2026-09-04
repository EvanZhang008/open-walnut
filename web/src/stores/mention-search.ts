/**
 * The two slower data feeds behind the composer's "@" entity groups.
 *
 *   1. Project registry — one light fetch (GET /api/projects), cached module-wide
 *      with a short TTL and read synchronously through useSyncExternalStore,
 *      exactly like the session-mention index. Small list; the palette fuzzy-
 *      filters it locally.
 *   2. Hybrid search — GET /api/search (full-text + vector, the same engine the
 *      task search box uses). This is the layer that turns "login bug" into
 *      "OAuth callback 401". It is NOT per-keystroke: an uncached hybrid query
 *      costs real server work (embedding + vector legs), so the hook debounces
 *      briefly and aborts superseded requests. The palette paints the local
 *      fuzzy layer first and folds these hits in when they land, so the user
 *      never waits on it — the list just gets smarter a beat later.
 */
import { useEffect, useRef, useState } from 'react';
import { apiGet } from '@/api/client';
import { fetchProjects, type ProjectSummary } from '@/api/projects';
import { log } from '@/utils/log';
import { extractEntityRefs } from '@/utils/entity-ref-tags';

// ---- Projects index ---------------------------------------------------------

const PROJECTS_TTL_MS = 60_000;

let projects: ProjectSummary[] = [];
let projectsFetchedAt = 0;
let projectsInflight: Promise<void> | null = null;
const projectListeners = new Set<() => void>();

export function getProjectsIndex(): ProjectSummary[] {
  return projects;
}

export function subscribeProjectsIndex(listener: () => void): () => void {
  projectListeners.add(listener);
  return () => { projectListeners.delete(listener); };
}

/** After a failed fetch, wait this long before asking again. */
const PROJECTS_RETRY_MS = 5_000;

/** Refresh if stale or missing; concurrent callers share one request; a
 *  failure keeps the previous snapshot. An EMPTY registry is a valid answer and
 *  is cached like any other — this runs on every keystroke while the palette is
 *  open, and `/api/projects` scans the whole task table, so "no projects yet"
 *  must not turn into one scan per keystroke. */
export function ensureProjectsIndex(): Promise<void> {
  if (projectsInflight) return projectsInflight;
  if (projectsFetchedAt !== 0 && Date.now() - projectsFetchedAt < PROJECTS_TTL_MS) return Promise.resolve();
  projectsInflight = fetchProjects()
    .then((res) => {
      projects = res.projects ?? [];
      projectsFetchedAt = Date.now();
      for (const l of projectListeners) l();
    })
    .catch((err) => {
      // Back off rather than retrying on the very next keystroke.
      projectsFetchedAt = Date.now() - PROJECTS_TTL_MS + PROJECTS_RETRY_MS;
      log.warn('mention-search', 'projects fetch failed (keeping previous snapshot)', {
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => { projectsInflight = null; });
  return projectsInflight;
}

// ---- Hybrid entity search ---------------------------------------------------

/**
 * One slim row from GET /api/search?slim=1 (src/web/routes/search.ts), with
 * `id` normalized to the ENTITY's own id. The slim contract (kept for agents)
 * puts the owning TASK id in `id` for a session row and carries the session
 * id only inside `ref`; searchEntities unwraps that so a session hit here is
 * addressable as a session.
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

/** The entity id a slim row stands for: the `<…-ref id>` when present. */
export function entityIdOfHit(h: EntitySearchHit): string {
  if (h.ref) {
    const ref = extractEntityRefs(h.ref)[0];
    if (ref && ref.kind === h.type) return ref.id;
  }
  return h.id;
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
    .filter((r) => (r.type === 'task' || r.type === 'session') && !r.isAutoExpanded)
    .map((r) => ({ ...r, id: entityIdOfHit(r) }));
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
  projects = [];
  projectsFetchedAt = 0;
  projectsInflight = null;
  memo.clear();
}
