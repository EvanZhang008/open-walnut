/**
 * SessionPathSelector — popover above chat input for picking a working directory.
 * Replaces the old SessionLauncherDrawer with an inline popover that positions
 * itself like CommandPalette (absolute, bottom: 100%).
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

/** Path-aware fuzzy match for edit mode — splits on / to match individual segments.
 *  Returns a score: 2 = startsWith, 1 = segment match, 0 = no match. */
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

/** Merged item: either from session history or live filesystem listing */
interface ListItem {
  cwd: string;
  host: string | null;
  hostLabel?: string;
  category: string;
  count: number;
  lastUsed: string;
  live?: boolean; // true = from live fs listing, not session history
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

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch on open
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

  // Live directory listing with 3-level preload cache.
  // API returns 3 levels deep → we cache and filter client-side.
  // Only re-fetch when user navigates beyond cached depth.
  const liveCacheRef = useRef<{ prefix: string; host: string | undefined; dirs: string[] } | null>(null);

  useEffect(() => {
    if (!editMode || !editingPath || editingPath.length < 2) {
      setLiveDirs([]);
      return;
    }

    const host = hostFilter !== 'all' && hostFilter !== '__local__' ? hostFilter : undefined;
    const cache = liveCacheRef.current;

    // Check if current path is within the cached tree
    if (cache && cache.host === host && editingPath.startsWith(cache.prefix)) {
      // Filter cached dirs client-side — instant
      const dir = editingPath.endsWith('/') ? editingPath : editingPath.slice(0, editingPath.lastIndexOf('/') + 1);
      const partial = editingPath.endsWith('/') ? '' : editingPath.slice(editingPath.lastIndexOf('/') + 1);
      const filtered = cache.dirs.filter(p => {
        // Must be a direct child of `dir`
        if (!p.startsWith(dir)) return false;
        const rest = p.slice(dir.length);
        if (rest.includes('/')) return false; // deeper than one level
        if (partial && !rest.toLowerCase().startsWith(partial.toLowerCase())) return false;
        return true;
      });
      setLiveDirs(filtered);
      return;
    }

    // Not in cache — fetch from API with preload
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    liveTimerRef.current = setTimeout(() => {
      setLiveLoading(true);
      listDirs(editingPath, host)
        .then(d => {
          // Cache the full tree
          const dir = editingPath.endsWith('/') ? editingPath : editingPath.slice(0, editingPath.lastIndexOf('/') + 1);
          liveCacheRef.current = { prefix: dir, host, dirs: d };
          // Filter to direct children for display
          const partial = editingPath.endsWith('/') ? '' : editingPath.slice(editingPath.lastIndexOf('/') + 1);
          const filtered = d.filter(p => {
            if (!p.startsWith(dir)) return false;
            const rest = p.slice(dir.length);
            if (rest.includes('/')) return false;
            if (partial && !rest.toLowerCase().startsWith(partial.toLowerCase())) return false;
            return true;
          });
          setLiveDirs(filtered);
          setLiveLoading(false);
        })
        .catch(() => { setLiveDirs([]); setLiveLoading(false); });
    }, 150); // shorter debounce since SSH is now fast with multiplexing
    return () => { if (liveTimerRef.current) clearTimeout(liveTimerRef.current); };
  }, [editMode, editingPath, hostFilter]);

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

  // Resolve current host for live items
  const currentHost = hostFilter !== 'all' && hostFilter !== '__local__' ? hostFilter : null;
  const currentHostLabel = hostTabs.find(t => t.key === hostFilter)?.label;

  // Filtered list — merges history + live dirs in edit mode
  const filtered: ListItem[] = useMemo(() => {
    const hostFiltered = dirs.filter(d => {
      if (hostFilter === '__local__' && d.host) return false;
      if (hostFilter !== 'all' && hostFilter !== '__local__' && d.host !== hostFilter) return false;
      return true;
    });
    if (editMode) {
      // History matches
      const scored = hostFiltered
        .map(d => ({ d, score: pathFuzzyScore(editingPath, d.cwd) }))
        .filter(x => x.score > 0);
      scored.sort((a, b) => b.score - a.score);
      const historyItems: ListItem[] = scored.map(x => ({ ...x.d, live: false }));

      // Live filesystem entries — deduplicate against history
      const historySet = new Set(historyItems.map(h => h.cwd));
      const liveItems: ListItem[] = liveDirs
        .filter(p => !historySet.has(p))
        .map(p => ({
          cwd: p,
          host: currentHost,
          hostLabel: currentHostLabel,
          category: 'Inbox',
          count: 0,
          lastUsed: '',
          live: true,
        }));

      // Live items first (they're the actual fs completions), then history
      return [...liveItems, ...historyItems];
    }
    return hostFiltered.filter(d => fuzzyMatch(query, d.cwd)).map(d => ({ ...d, live: false }));
  }, [dirs, query, hostFilter, editMode, editingPath, liveDirs, currentHost, currentHostLabel]);

  useEffect(() => { setSelectedIdx(0); }, [query, hostFilter, editMode, editingPath, liveDirs]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.sps-path-item');
    items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  // Select handler
  const handleSelect = useCallback((d: ListItem) => {
    onSelect({ cwd: d.cwd, host: d.host, hostLabel: d.hostLabel, category: d.category });
  }, [onSelect]);

  // Enter edit mode with a given path
  const enterEditMode = useCallback((d: ListItem) => {
    setEditMode(true);
    setEditingPath(d.cwd);
    setSelectedIdx(0);
  }, []);

  // Keyboard navigation (scoped to search input, not global)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editMode) {
      // --- EDIT MODE ---
      if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIdx]) {
          // If a live dir is selected, use it (Tab-complete into it with trailing /)
          const sel = filtered[selectedIdx];
          if (sel.live) {
            setEditingPath(sel.cwd + '/');
            return;
          }
        }
        const match = dirs.find(d => d.cwd === editingPath);
        onSelect({
          cwd: editingPath,
          host: match?.host ?? currentHost,
          hostLabel: match?.hostLabel ?? currentHostLabel,
          category: match?.category ?? 'Inbox',
        });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setEditMode(false);
        setEditingPath('');
        setLiveDirs([]);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx(prev => Math.min(prev + 1, Math.max(filtered.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Tab') {
        // Tab-complete from selected item — append / to drill into dirs
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
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIdx]) enterEditMode(filtered[selectedIdx]);
      } else if (e.key === 'Escape') {
        onClose();
      }
    }
  }, [editMode, editingPath, filtered, selectedIdx, dirs, onSelect, onClose, enterEditMode, currentHost, currentHostLabel]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid closing on the click that opened us
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 100);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="session-path-selector" ref={popoverRef}>
      {/* Search */}
      <div className="sps-search">
        <input
          ref={searchRef}
          className={`sps-search-input${editMode ? ' editing' : ''}`}
          type="text"
          placeholder={editMode ? 'Type path... (Tab complete, Enter confirm, Esc cancel)' : 'Search paths... (↑↓ navigate, Enter select, Esc close)'}
          value={editMode ? editingPath : query}
          onChange={e => editMode ? setEditingPath(e.target.value) : setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        {editMode && liveLoading && <span className="sps-live-indicator">listing...</span>}
      </div>

      {/* Host filter */}
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
        </div>
      )}

      {/* Path list */}
      <div className="sps-path-list" ref={listRef}>
        {loading && <div className="sps-empty">Loading paths...</div>}
        {error && <div className="sps-error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="sps-empty">
            {editMode
              ? (liveLoading ? 'Listing directories...' : 'No directories found. Type a path and press Enter to use it.')
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
                } else {
                  setEditingPath(d.cwd);
                }
              } else {
                enterEditMode(d);
              }
            }}
            onMouseEnter={() => setSelectedIdx(idx)}
          >
            <div className="sps-path-main">
              <span className="sps-path-cwd">{d.cwd}{d.live ? '/' : ''}</span>
              {d.live
                ? <span className="sps-path-host-tag sps-tag-live">dir</span>
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
