/**
 * SessionPathSelector — popover above chat input for picking a working directory.
 * Features: history paths, live SSH/local directory listing, Tab completion,
 * Shift+Tab host cycling, SSH pre-warm on open.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { fetchWorkingDirs, listDirs, type WorkingDirEntry } from '@/api/sessions';

export interface QuickStartPath {
  cwd: string;
  host: string | null;
  hostLabel?: string;
  category: string;
}

function timeAgo(iso: string): string {
  const ms = Math.max(0, Date.now() - new Date(iso).getTime());
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function fuzzyMatch(query: string, cwd: string): boolean {
  if (!query) return true;
  const lower = cwd.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(t => lower.includes(t));
}

function pathFuzzyScore(editingPath: string, cwd: string): number {
  if (!editingPath) return 2;
  const cwdLower = cwd.toLowerCase();
  const editLower = editingPath.toLowerCase();
  if (cwdLower.startsWith(editLower)) return 2;
  const segments = editLower.split('/').filter(s => s.length >= 2);
  if (segments.length === 0) return 2;
  const matchCount = segments.filter(seg => cwdLower.includes(seg)).length;
  return matchCount > 0 ? 1 : 0;
}

interface ListItem {
  cwd: string;
  host: string | null;
  hostLabel?: string;
  category: string;
  count: number;
  lastUsed: string;
  live?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (path: QuickStartPath) => void;
}

export function SessionPathSelector({ open, onClose, onSelect }: Props) {
  const [dirs, setDirs] = useState<WorkingDirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [hostFilter, setHostFilter] = useState<string>('all');
  const [editMode, setEditMode] = useState(false);
  const [editingPath, setEditingPath] = useState('');
  const [liveDirs, setLiveDirs] = useState<string[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  // For "All" mode: live dirs tagged with their source host
  const [liveTaggedDirs, setLiveTaggedDirs] = useState<Array<{ cwd: string; host: string | null; hostLabel?: string }>>([]);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch history + pre-warm SSH connections on open
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setQuery('');
    setSelectedIdx(0);
    setHostFilter('all');
    setEditMode(false);
    setEditingPath('');
    setLiveDirs([]);
    setLiveTaggedDirs([]);
    // fetchWorkingDirs returns from cache if already prefetched on page load
    fetchWorkingDirs()
      .then(d => { setDirs(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [open]);

  // Focus search on open
  useEffect(() => {
    if (open && !loading) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open, loading]);

  // Keep cursor at end of input when editingPath changes (e.g. after click or Tab)
  useEffect(() => {
    if (editMode && searchRef.current) {
      const len = editingPath.length;
      searchRef.current.setSelectionRange(len, len);
    }
  }, [editMode, editingPath]);

  // Live directory listing with multi-level preload cache
  const liveCacheRef = useRef<{ prefix: string; host: string | undefined; dirs: string[] } | null>(null);
  const activePath = editMode ? editingPath : ((query.startsWith('/') || query.startsWith('~')) ? query : '');

  // Resolve effective host for live listing
  const effectiveHost = hostFilter !== 'all' && hostFilter !== '__local__' ? hostFilter : undefined;

  useEffect(() => {
    if (!activePath || activePath.length < 2) {
      setLiveDirs([]);
      setLiveTaggedDirs([]);
      return;
    }

    const filterChildren = (allDirs: string[], parentDir: string, partialName: string) =>
      allDirs.filter(p => {
        if (!p.startsWith(parentDir)) return false;
        const rest = p.slice(parentDir.length);
        if (rest.includes('/')) return false;
        if (partialName && !rest.toLowerCase().startsWith(partialName.toLowerCase())) return false;
        return true;
      });

    const dir = activePath.endsWith('/') ? activePath : activePath.slice(0, activePath.lastIndexOf('/') + 1);
    const partial = activePath.endsWith('/') ? '' : activePath.slice(activePath.lastIndexOf('/') + 1);

    if (hostFilter === 'all') {
      // "All" mode: query local + all SSH hosts in parallel, tag results
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
      liveTimerRef.current = setTimeout(() => {
        const sshHosts = new Set<string>();
        for (const d of dirs) { if (d.host) sshHosts.add(d.host); }
        const hostLabels = new Map<string, string>();
        for (const d of dirs) { if (d.host && d.hostLabel) hostLabels.set(d.host, d.hostLabel); }

        const promises: Array<Promise<Array<{ cwd: string; host: string | null; hostLabel?: string }>>> = [];
        // Local
        promises.push(
          listDirs(activePath, null)
            .then(res => filterChildren(res.dirs, res.parent, partial).map(p => ({ cwd: p, host: null })))
            .catch(() => [])
        );
        // Each SSH host
        for (const host of sshHosts) {
          promises.push(
            listDirs(activePath, host)
              .then(res => filterChildren(res.dirs, res.parent, partial).map(p => ({ cwd: p, host, hostLabel: hostLabels.get(host) })))
              .catch(() => [])
          );
        }
        setLiveLoading(true);
        Promise.all(promises).then(results => {
          setLiveTaggedDirs(results.flat());
          setLiveDirs([]);
          setLiveLoading(false);
        });
      }, 150);
      return () => { if (liveTimerRef.current) clearTimeout(liveTimerRef.current); };
    }

    // Specific host or local mode
    const host = effectiveHost;
    const cache = liveCacheRef.current;

    if (cache && cache.host === host && activePath.startsWith(cache.prefix)) {
      const filtered = filterChildren(cache.dirs, dir, partial);
      if (filtered.length > 0 || dir === cache.prefix) {
        setLiveDirs(filtered);
        setLiveTaggedDirs([]);
        return;
      }
    }

    if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    liveTimerRef.current = setTimeout(() => {
      setLiveLoading(true);
      listDirs(activePath, host)
        .then(res => {
          // Use resolved parent from API (handles ~ expansion)
          liveCacheRef.current = { prefix: res.parent, host, dirs: res.dirs };
          setLiveDirs(filterChildren(res.dirs, res.parent, partial));
          setLiveTaggedDirs([]);
          setLiveLoading(false);
          // If prefix was ~, rewrite editingPath to the resolved path
          if (activePath.startsWith('~/') && res.parent && !res.parent.startsWith('~')) {
            setEditingPath(res.parent);
          }
        })
        .catch(() => { setLiveDirs([]); setLiveTaggedDirs([]); setLiveLoading(false); });
    }, 150);
    return () => { if (liveTimerRef.current) clearTimeout(liveTimerRef.current); };
  }, [activePath, hostFilter, effectiveHost, dirs]);

  // Host tabs
  const hostTabs = useMemo(() => {
    const labels = new Map<string, string>();
    labels.set('all', 'All');
    labels.set('__local__', 'Local');
    for (const d of dirs) {
      if (d.host && !labels.has(d.host)) labels.set(d.host, d.hostLabel ?? d.host);
    }
    return Array.from(labels.entries()).map(([key, label]) => ({ key, label }));
  }, [dirs]);

  const currentHost = hostFilter !== 'all' && hostFilter !== '__local__' ? hostFilter : null;
  const currentHostLabel = hostTabs.find(t => t.key === hostFilter)?.label;

  // Filtered list — merges history + live dirs
  const filtered: ListItem[] = useMemo(() => {
    const hostFiltered = dirs.filter(d => {
      if (hostFilter === '__local__' && d.host) return false;
      if (hostFilter !== 'all' && hostFilter !== '__local__' && d.host !== hostFilter) return false;
      return true;
    });

    // Build live items from either tagged (All mode) or single-host list
    const buildLiveItems = (historySet: Set<string>): ListItem[] => {
      if (liveTaggedDirs.length > 0) {
        // All mode: each item already has host/hostLabel
        return liveTaggedDirs
          .filter(p => !historySet.has(p.cwd))
          .map(p => ({
            cwd: p.cwd, host: p.host, hostLabel: p.hostLabel ?? (p.host ? undefined : 'local'),
            category: 'Inbox', count: 0, lastUsed: '', live: true,
          }));
      }
      return liveDirs
        .filter(p => !historySet.has(p))
        .map(p => ({
          cwd: p, host: currentHost, hostLabel: currentHostLabel,
          category: 'Inbox', count: 0, lastUsed: '', live: true,
        }));
    };

    if (editMode) {
      const scored = hostFiltered
        .map(d => ({ d, score: pathFuzzyScore(editingPath, d.cwd) }))
        .filter(x => x.score > 0);
      scored.sort((a, b) => b.score - a.score);
      const historyItems: ListItem[] = scored.map(x => ({ ...x.d, live: false }));
      const liveItems = buildLiveItems(new Set(historyItems.map(h => h.cwd)));
      return [...liveItems, ...historyItems];
    }

    // Browse mode
    const historyItems = hostFiltered.filter(d => fuzzyMatch(query, d.cwd)).map(d => ({ ...d, live: false }));
    if ((query.startsWith('/') || query.startsWith('~')) && (liveDirs.length > 0 || liveTaggedDirs.length > 0)) {
      const liveItems = buildLiveItems(new Set(historyItems.map(h => h.cwd)));
      return [...liveItems, ...historyItems];
    }
    return historyItems;
  }, [dirs, query, hostFilter, editMode, editingPath, liveDirs, liveTaggedDirs, currentHost, currentHostLabel]);

  useEffect(() => { setSelectedIdx(0); }, [query, hostFilter, editMode, editingPath, liveDirs, liveTaggedDirs]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.sps-path-item');
    items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleSelect = useCallback((d: ListItem) => {
    onSelect({ cwd: d.cwd, host: d.host, hostLabel: d.hostLabel, category: d.category });
  }, [onSelect]);

  // Confirm the current editingPath (Shift+Enter or Go button)
  const handleConfirm = useCallback(() => {
    if (!editingPath) return;
    const trimmed = editingPath.replace(/\/+$/, '') || '/';
    const match = dirs.find(d => d.cwd === trimmed);
    onSelect({
      cwd: trimmed,
      host: match?.host ?? currentHost,
      hostLabel: match?.hostLabel ?? currentHostLabel,
      category: match?.category ?? 'Inbox',
    });
  }, [editingPath, dirs, onSelect, currentHost, currentHostLabel]);

  const enterEditMode = useCallback((d: ListItem) => {
    setEditMode(true);
    setEditingPath(d.cwd);
    setSelectedIdx(0);
  }, []);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Shift+Tab: cycle host tabs (works in both modes)
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const idx = hostTabs.findIndex(t => t.key === hostFilter);
      const nextIdx = (idx + 1) % hostTabs.length;
      setHostFilter(hostTabs[nextIdx].key);
      return;
    }

    if (editMode) {
      // --- EDIT MODE ---
      if (e.key === 'Enter' && (e.shiftKey || e.metaKey)) {
        // Shift+Enter or Cmd+Enter: confirm and start session
        e.preventDefault();
        handleConfirm();
      } else if (e.key === 'Enter') {
        // Enter: always select/autocomplete (never sends)
        e.preventDefault();
        if (filtered.length > 0) {
          const sel = filtered[Math.min(selectedIdx, filtered.length - 1)];
          if (sel.live) {
            // Live directory — navigate deeper
            setEditingPath(sel.cwd + '/');
            if (sel.host && hostFilter === 'all') setHostFilter(sel.host);
          } else {
            // History item — fill the path into input
            setEditingPath(sel.cwd);
          }
        }
        // If no items, Enter does nothing (path is incomplete)
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setEditMode(false);
        setEditingPath('');
        setLiveDirs([]);
        setLiveTaggedDirs([]);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx(prev => Math.min(prev + 1, Math.max(filtered.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (filtered[selectedIdx]) {
          const sel = filtered[selectedIdx];
          setEditingPath(sel.cwd.endsWith('/') ? sel.cwd : sel.cwd + '/');
        }
      }
    } else {
      // --- BROWSE MODE ---
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx(prev => Math.min(prev + 1, Math.max(filtered.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && (e.shiftKey || e.metaKey)) {
        // Shift+Enter: send selected item directly (skip edit mode)
        e.preventDefault();
        if (filtered[selectedIdx] && !filtered[selectedIdx].live) {
          handleSelect(filtered[selectedIdx]);
        }
      } else if (e.key === 'Enter') {
        // Enter: enter edit mode with selected item
        e.preventDefault();
        if (filtered[selectedIdx]) {
          const sel = filtered[selectedIdx];
          if (sel.live) {
            setEditMode(true);
            setEditingPath(sel.cwd + '/');
            if (sel.host && hostFilter === 'all') setHostFilter(sel.host);
            setSelectedIdx(0);
          } else {
            enterEditMode(sel);
          }
        }
      } else if (e.key === 'Escape') {
        onClose();
      }
    }
  }, [editMode, filtered, selectedIdx, onClose, enterEditMode, handleConfirm, handleSelect, hostFilter, hostTabs]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 100);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="session-path-selector" ref={popoverRef}>
      <div className="sps-search">
        <input
          ref={searchRef}
          className={`sps-search-input${editMode ? ' editing' : ''}`}
          type="text"
          placeholder={editMode ? 'Type path... (Enter select, ⇧Enter go, Esc back)' : 'Search paths... (↑↓ navigate, Enter select, Esc close)'}
          value={editMode ? editingPath : query}
          onChange={e => editMode ? setEditingPath(e.target.value) : setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        {editMode && editingPath && (
          <button
            className="sps-go-btn"
            onClick={handleConfirm}
            title="Start session (⇧Enter)"
          >
            Go <kbd>⇧↵</kbd>
          </button>
        )}
      </div>

      {hostTabs.length > 2 && (
        <div className="sps-host-filter">
          {hostTabs.map(tab => (
            <button
              key={tab.key}
              className={`sps-host-tab${hostFilter === tab.key ? ' active' : ''}`}
              onClick={() => setHostFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
          <span className="sps-host-hint">Shift+Tab</span>
        </div>
      )}

      <div className="sps-path-list" ref={listRef}>
        {loading && <div className="sps-empty">Loading paths...</div>}
        {error && <div className="sps-error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="sps-empty">
            {editMode
              ? (liveLoading ? 'Listing directories...' : 'No matches. Press ⇧Enter or click Go to use this path.')
              : dirs.length === 0
                ? 'No session history yet. Start a session on a task first.'
                : 'No paths match your search.'}
          </div>
        )}
        {filtered.map((d, idx) => (
          <div
            key={`${d.cwd}::${d.host ?? ''}::${d.live ? 'live' : 'hist'}`}
            className={`sps-path-item${idx === selectedIdx ? ' active' : ''}${d.live ? ' sps-live' : ''}`}
            onClick={() => {
              if (editMode) {
                if (d.live) {
                  setEditingPath(d.cwd + '/');
                  if (d.host && hostFilter === 'all') setHostFilter(d.host);
                } else {
                  setEditingPath(d.cwd);
                }
              } else {
                if (d.live) {
                  setEditMode(true);
                  setEditingPath(d.cwd + '/');
                  if (d.host && hostFilter === 'all') setHostFilter(d.host);
                  setSelectedIdx(0);
                } else {
                  enterEditMode(d);
                }
              }
            }}
            onMouseEnter={() => setSelectedIdx(idx)}
          >
            <div className="sps-path-main">
              <span className="sps-path-cwd">{d.cwd}{d.live ? '/' : ''}</span>
              {d.live
                ? <span className="sps-path-host-tag sps-tag-live">{d.host ? (d.hostLabel ?? d.host) : 'local'}</span>
                : <span className="sps-path-host-tag">{d.host ? (d.hostLabel ?? d.host) : 'local'}</span>
              }
            </div>
            {!d.live && (
              <div className="sps-path-meta">
                <span className="sps-path-category">{d.category}</span>
                <span>{d.count} session{d.count !== 1 ? 's' : ''}</span>
                <span>{timeAgo(d.lastUsed)}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
