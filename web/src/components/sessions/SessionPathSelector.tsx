/**
 * SessionPathSelector — popover above chat input for picking a working directory.
 * Replaces the old SessionLauncherDrawer with an inline popover that positions
 * itself like CommandPalette (absolute, bottom: 100%).
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { fetchWorkingDirs, type WorkingDirEntry } from '@/api/sessions';

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

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Fetch on open
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setQuery('');
    setSelectedIdx(0);
    setHostFilter('all');
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

  // Filtered list
  const filtered = useMemo(() => {
    return dirs.filter(d => {
      if (hostFilter === '__local__' && d.host) return false;
      if (hostFilter !== 'all' && hostFilter !== '__local__' && d.host !== hostFilter) return false;
      return fuzzyMatch(query, d.cwd);
    });
  }, [dirs, query, hostFilter]);

  useEffect(() => { setSelectedIdx(0); }, [query, hostFilter]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.sps-path-item');
    items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  // Select handler
  const handleSelect = useCallback((d: WorkingDirEntry) => {
    onSelect({ cwd: d.cwd, host: d.host, hostLabel: d.hostLabel, category: d.category });
  }, [onSelect]);

  // Keyboard navigation (scoped to search input, not global)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(prev => Math.min(prev + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIdx]) handleSelect(filtered[selectedIdx]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [filtered, selectedIdx, handleSelect, onClose]);

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
          className="sps-search-input"
          type="text"
          placeholder="Search paths... (↑↓ navigate, Enter select, Esc close)"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
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
            {dirs.length === 0
              ? 'No session history yet. Start a session on a task first.'
              : 'No paths match your search.'}
          </div>
        )}
        {filtered.map((d, idx) => (
          <div
            key={`${d.cwd}::${d.host ?? ''}`}
            className={`sps-path-item${idx === selectedIdx ? ' active' : ''}`}
            onClick={() => handleSelect(d)}
            onMouseEnter={() => setSelectedIdx(idx)}
          >
            <div className="sps-path-main">
              <span className="sps-path-cwd" title={d.cwd}>{d.cwd}</span>
              <span className="sps-path-host-tag">{d.host ? (d.hostLabel ?? d.host) : 'local'}</span>
            </div>
            <div className="sps-path-meta">
              <span className="sps-path-category">{d.category}</span>
              <span>{d.count} session{d.count !== 1 ? 's' : ''}</span>
              <span>{timeAgo(d.lastUsed)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
