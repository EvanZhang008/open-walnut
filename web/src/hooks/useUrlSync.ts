import { useRef, useEffect, useState, useCallback } from 'react';
import { MAX_PANELS } from '@/hooks/useSessionPanelMode';

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

// Session columns ride the URL as s1..sN. Capped at the same ceiling as the panel
// setting so a custom count is fully shareable/reloadable — a lower cap here would
// silently drop the rightmost columns of a 5- or 6-panel layout on refresh. The cap
// also stops a corrupt/hand-edited link asking for unbounded columns; MainPage trims
// to the user's actual panel setting anyway.
const MAX_URL_SESSIONS = MAX_PANELS;
const SESSION_PARAMS = Array.from({ length: MAX_URL_SESSIONS }, (_, i) => `s${i + 1}`);

function parseUrlParams(): UrlPending | null {
  if (window.location.pathname !== '/') return null;
  const sp = new URLSearchParams(window.location.search);
  const task = sp.get('task');
  const cat = sp.get('cat');
  // s1..sN in order. A gap (s1 + s3, only possible by hand-editing) is closed
  // rather than treated as an empty column.
  const sessionIds = SESSION_PARAMS.map(k => sp.get(k)).filter((v): v is string => !!v);
  // Empty params (e.g. ?cat=) are treated as absent
  if (sessionIds.length === 0 && !task && !cat) return null;
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
  // Only persist real session IDs (not pending: placeholders).
  const sessions = params.sessionColumns.filter(s => !s.startsWith('pending:'));
  sessions.slice(0, MAX_URL_SESSIONS).forEach((id, i) => sp.set(SESSION_PARAMS[i], id));
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
    // The URL is the source of truth until MainPage either restores the pending
    // state or conclusively determines that the target no longer exists.
    if (pending) return;

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
  }, [focusedTaskId, sessionColumns, activeCategory, visible, pending]);

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
