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
import { useState, useEffect, useRef, useCallback } from 'react';
import { searchSessions } from '@/api/sessions';
import type { SessionRecord } from '@open-walnut/core';
import { ICON_SEARCH } from '@/components/common/Icons';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';

interface SessionSearchPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

const DEBOUNCE_MS = 250;

export function SessionSearchPanel({ open, onClose, onOpenSession }: SessionSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
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
      searchSessions(query, 30)
        .then((sessions) => {
          if (seq !== requestSeq.current) return;
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

  // Autofocus + reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      // rAF: the input may not be mounted yet on the same tick.
      requestAnimationFrame(() => inputRef.current?.focus());
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
        <input
          ref={inputRef}
          type="text"
          className="session-search-input"
          placeholder="Search sessions — title, task, path, host…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Search sessions"
        />
        {loading && <span className="todo-search-spinner" />}
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
            <span className="session-search-meta">
              {s.host ? `${s.host} · ` : ''}
              {s.cwd ? `${s.cwd.split('/').slice(-2).join('/')} · ` : ''}
              {timeAgo(s.lastActiveAt)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
