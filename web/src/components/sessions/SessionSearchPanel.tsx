/**
 * SessionSearchPanel — search-and-open for sessions on the home page (the ONLY
 * session surface). A compact trigger button sits at the top of the sessions
 * area; opening it shows a search input + result list. Typing queries the
 * server (`GET /api/sessions/recent?q=` — the full session list lives server-
 * side, the client never holds it), and clicking a result opens that session
 * as a home-page column.
 *
 * Keyboard: the input autofocuses on open; ArrowUp/Down move the selection,
 * Enter opens it, Escape clears the query first and closes when already empty.
 */
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { searchSessions } from '@/api/sessions';
import type { SessionRecord } from '@open-walnut/core';
import { ICON_SEARCH } from '@/components/common/Icons';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';

interface SessionSearchPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

const DEBOUNCE_MS = 250;

/** The recent list this page last fetched: an open draws it in its first frame while it refreshes. */
let lastRecent: SessionRecord[] | null = null;
const RECENT_LIMIT = 30;

/**
 * Read the recent list once, before the finder is first opened (Home calls it at load), so even
 * the first open draws its list in its first frame instead of an empty box that grows when it lands.
 */
export function warmSessionSearch(): void {
  if (lastRecent) return;
  searchSessions('', RECENT_LIMIT)
    .then((sessions) => { if (!lastRecent) lastRecent = sessions; })
    .catch(() => { /* the finder reads it itself when it opens */ });
}

export function SessionSearchPanel({ open, onClose, onOpenSession }: SessionSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SessionRecord[]>(() => lastRecent ?? []);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const hostName = useHostDisplayLabels();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Monotonic request id — a stale slow response must not clobber a newer one.
  const requestSeq = useRef(0);

  // Fetch (debounced). Empty query still fetches: shows the recent list.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const seq = ++requestSeq.current;
    const t = setTimeout(() => {
      searchSessions(query, RECENT_LIMIT)
        .then((sessions) => {
          if (seq !== requestSeq.current) return;
          if (!query) lastRecent = sessions;
          setResults(sessions);
          setSelectedIdx(0);
          setLoading(false);
        })
        .catch((err) => {
          if (seq !== requestSeq.current) return;
          log.warn('session-search', 'search failed', { error: String(err) });
          setResults([]);
          setLoading(false);
        });
    }, query ? DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [open, query]);

  // Autofocus + reset on open, before the frame paints: the caret is in the box in the first frame.
  useLayoutEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      if (lastRecent) setResults(lastRecent);
      // The input is mounted by the commit this effect follows; the rAF covers one that is not yet.
      if (inputRef.current) inputRef.current.focus();
      else requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Outside click closes
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, onClose]);

  const openResult = useCallback((sid: string) => {
    onOpenSession(sid);
    onClose();
  }, [onOpenSession, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // preventDefault too: browsers act on Escape (cancel fetches, exit
      // fullscreen, clear <input type=search>) even when propagation stops.
      e.preventDefault();
      e.stopPropagation();
      // First Escape clears the query; second closes the panel.
      if (query) setQuery('');
      else onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // Zero results: keep 0, don't let `length - 1` drive selectedIdx to -1.
      setSelectedIdx((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIdx]) {
      e.preventDefault();
      openResult(results[selectedIdx].claudeSessionId);
    }
  }, [query, results, selectedIdx, onClose, openResult]);

  if (!open) return null;

  return (
    <div className="session-search-panel" ref={panelRef}>
      <div className="session-search-input-row">
        <span className="session-search-icon">{ICON_SEARCH}</span>
        <input data-no-draft="search"
          ref={inputRef}
          type="text"
          className="session-search-input"
          placeholder="Search sessions — title, task, path, host…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Search sessions"
        />
        {/* A refresh behind a list already on screen is silent; the spinner says "wait" only when
            there is nothing to read yet or the list is for an older query. */}
        <span className="session-search-spinner-slot" aria-hidden="true">
          {loading && (results.length === 0 || query !== '') && <span className="todo-search-spinner" />}
        </span>
      </div>
      <div className="session-search-results" role="listbox">
        {!loading && results.length === 0 && (
          <div className="session-search-empty">
            {query ? `No sessions match '${query}'` : 'No sessions yet'}
          </div>
        )}
        {results.map((s, i) => (
          <button
            key={s.claudeSessionId}
            role="option"
            aria-selected={i === selectedIdx}
            className={`session-search-result${i === selectedIdx ? ' is-selected' : ''}`}
            onClick={() => openResult(s.claudeSessionId)}
            onMouseEnter={() => setSelectedIdx(i)}
          >
            <span className={`session-search-dot status-${s.process_status}`} aria-hidden="true" />
            <span className="session-search-title">
              {s.title || s.cwd?.split('/').pop() || s.claudeSessionId.slice(0, 8)}
            </span>
            {/* The folder's own name (the full path is the tooltip), then when: the time never
                ellipsizes away behind a long path. */}
            <span className="session-search-meta" title={s.cwd || undefined}>
              {s.host && <span className="session-search-host">{hostName(s.host)} · </span>}
              {s.cwd && <span className="session-search-folder">{s.cwd.split('/').filter(Boolean).pop()}</span>}
              {s.cwd && <span className="session-search-sep"> · </span>}
              <span className="session-search-time">{timeAgo(s.lastActiveAt)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
