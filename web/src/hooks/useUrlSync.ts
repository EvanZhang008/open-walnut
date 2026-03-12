import { useRef, useEffect, useState, useCallback } from 'react';

// Starred tab uses Unicode star internally; URL uses readable "starred"
const STARRED_INTERNAL = '\u2605';
const STARRED_URL = 'starred';

function categoryToUrl(cat: string): string {
  if (cat === STARRED_INTERNAL) return STARRED_URL;
  return cat;
}

function categoryFromUrl(val: string): string {
  if (val === STARRED_URL) return STARRED_INTERNAL;
  return val;
}

export interface UrlPending {
  taskId: string | null;
  sessionIds: string[];
  category: string | null;
}

function parseUrlParams(): UrlPending | null {
  if (window.location.pathname !== '/') return null;
  const sp = new URLSearchParams(window.location.search);
  const s1 = sp.get('s1');
  const s2 = sp.get('s2');
  const task = sp.get('task');
  const cat = sp.get('cat');
  // Empty params (e.g. ?cat=) are treated as absent
  if (!s1 && !s2 && !task && !cat) return null;
  const sessionIds: string[] = [];
  if (s1) sessionIds.push(s1);
  if (s2) sessionIds.push(s2);
  return {
    taskId: task || null,
    sessionIds,
    category: cat ? categoryFromUrl(cat) : null,
  };
}

function buildSearch(params: {
  focusedTaskId?: string;
  sessionColumns: string[];
  activeCategory?: string;
}): string {
  const sp = new URLSearchParams();
  // Only persist real session IDs (not pending: placeholders). Max 2 columns.
  const sessions = params.sessionColumns.filter(s => !s.startsWith('pending:'));
  if (sessions[0]) sp.set('s1', sessions[0]);
  if (sessions[1]) sp.set('s2', sessions[1]);
  if (params.focusedTaskId) sp.set('task', params.focusedTaskId);
  if (params.activeCategory) sp.set('cat', categoryToUrl(params.activeCategory));
  const str = sp.toString();
  return str ? `?${str}` : '';
}

interface UseUrlSyncOpts {
  focusedTaskId: string | undefined;
  sessionColumns: string[];
  activeCategory: string | undefined;
  visible: boolean;
}

export function useUrlSync(opts: UseUrlSyncOpts): {
  pending: UrlPending | null;
  clearPending: () => void;
} {
  const { focusedTaskId, sessionColumns, activeCategory, visible } = opts;

  // Parse URL once on first render
  const [pending, setPending] = useState<UrlPending | null>(() => parseUrlParams());

  const clearPending = useCallback(() => setPending(null), []);

  // Debounce timer ref
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // State → URL (debounced replaceState)
  useEffect(() => {
    if (!visible) return;
    if (window.location.pathname !== '/') return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const search = buildSearch({ focusedTaskId, sessionColumns, activeCategory });
      // Compare against live URL to avoid redundant replaceState calls.
      // This also prevents echo: when we apply URL params → state changes → effect fires,
      // the computed search matches the existing URL, so no write occurs.
      if (search === window.location.search) return;
      window.history.replaceState(null, '', `/${search}`);
    }, 300);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [focusedTaskId, sessionColumns, activeCategory, visible]);

  // Popstate listener — browser back/forward (rare on SPA, but handle gracefully)
  useEffect(() => {
    const handlePopState = () => {
      if (window.location.pathname !== '/') return;
      const parsed = parseUrlParams();
      if (parsed) setPending(parsed);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return { pending, clearPending };
}
