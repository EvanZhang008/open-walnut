/**
 * FileMentionPopup — Claude-Code-style "@" file reference picker.
 *
 * A mini VS Code browser shown above the chat input when the user types "@".
 * Left: single-level listing of the current browse dir (dirs first, then files),
 * filtered by the text typed after "@". Right: inline preview of the selected
 * file (FileContentView). Local + remote (daemon) via /api/files/list.
 *
 * Keyboard is driven by the parent ChatInput through the imperative handle:
 *   move(±1)        — change selection
 *   into()          — →/Enter: dir → navigate into it; file → select it
 *   up()            — ←: navigate to the parent directory
 *   selectCurrent() — Cmd/Ctrl+Enter: select current item regardless of type
 * Navigation (into dir / go up) is internal; selection returns an absolute
 * path via onSelect (the chat input inserts it as an "@" ref).
 */
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { fetchDirList, type DirEntry } from '@/api/files';
import { apiGet } from '@/api/client';
import { getHostStatus, subscribeHostStatus } from '@/hooks/useHostStatus';
import { FileContentView } from '@/components/common/FileContentView';
import { formatSize } from '@/utils/format';
import { log } from '@/utils/log';
import { recordRecentFolder, getRecentFolders, fuzzyMatchRecents, type RecentFolder } from '@/utils/recentFolders';
import { joinPath, parentPath, relativeTo, normalizePath, parseQuery } from './mention-path';

export interface FileMentionHandle {
  /** Move selection by delta (wraps). */
  move: (delta: number) => void;
  /** Right arrow / Enter on a dir → navigate into it; on a file → select it. */
  into: () => void;
  /** Left arrow → navigate to the parent directory. */
  up: () => void;
  /** Cmd/Ctrl+Enter: select current item (file or dir) regardless of type. */
  selectCurrent: () => void;
}

interface FileMentionPopupProps {
  /** Root directory the browse starts from (session cwd or quick-start cwd). */
  cwd: string;
  /** SSH host (undefined = local). */
  host?: string;
  /** Text typed after "@". Interpreted as a path: the portion up to the last "/"
   *  navigates (absolute `/…` or `~/…` jump anywhere, otherwise resolved against
   *  cwd); the final segment filters the listing. */
  query: string;
  /** Called when the user selects a file or folder. Path is absolute (avoids
   *  ambiguity about what a relative ref would resolve against). */
  onSelect: (absPath: string) => void;
  /** Rewrite the "@query" text to browse an absolute dir (used when jumping to a
   *  recent folder from "@?" mode — keeps the textarea and popup state in sync). */
  onNavigate: (absDir: string) => void;
  onClose: () => void;
}

// Path helpers (joinPath / parentPath / relativeTo / normalizePath / parseQuery)
// live in mention-path.ts, shared with the unified MentionPalette so both
// surfaces interpret an "@query" path identically.

export const FileMentionPopup = forwardRef<FileMentionHandle, FileMentionPopupProps>(
  function FileMentionPopup({ cwd, host, query, onSelect, onNavigate, onClose }, ref) {
    // The canonical root resolved by the backend (~ → absolute). Selection paths
    // are computed relative to this so inserted refs are short + portable.
    const [rootPath, setRootPath] = useState<string>(cwd);
    const [browseDir, setBrowseDir] = useState<string>(cwd);
    const [entries, setEntries] = useState<DirEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [previewFile, setPreviewFile] = useState<string | null>(null);

    const listRef = useRef<HTMLDivElement>(null);
    const inFlightRef = useRef<string | null>(null);

    const loadDir = useCallback(
      async (dirPath: string, opts: { isRoot?: boolean } = {}) => {
        if (inFlightRef.current === dirPath) return;
        inFlightRef.current = dirPath;
        setLoading(true);
        setError(null);
        try {
          const res = await fetchDirList(dirPath, host, false);
          // Drop stale responses: a faster navigation to another dir may have
          // superseded this load. Last-write-wins on the in-flight token, not on
          // response arrival order (FileContentView guards its own fetch the same way).
          if (inFlightRef.current !== dirPath) return;
          // Backend resolves ~ → absolute; adopt it so child/selection paths are absolute.
          const canonical = res.path || dirPath;
          setBrowseDir(canonical);
          if (opts.isRoot) setRootPath(canonical);
          // Record the visited folder so "@?" can fuzzy-jump back to it later — but
          // NOT on the root open, which fires on EVERY popup open. Each record POSTs
          // a synchronous full-file rewrite server-side (event-loop-starvation history
          // in this repo), so we only persist folders the user deliberately navigated
          // into (into/up/breadcrumb/path-typing), not the passive open-at-cwd. The cwd
          // is already a session working dir, so it's covered by the frequent-dirs union.
          if (!opts.isRoot) recordRecentFolder(canonical, host);
          setEntries(res.entries);
          // If the requested path was a file, the backend listed its parent and
          // flagged the file — pre-select it so the right pane previews it.
          const fileIdx = res.selectedFile
            ? res.entries.findIndex((e) => e.name === res.selectedFile && e.type === 'file')
            : -1;
          setSelectedIndex(fileIdx >= 0 ? fileIdx : 0);
          setPreviewFile(null);
        } catch (err) {
          if (inFlightRef.current !== dirPath) return;
          const msg = err instanceof Error ? err.message : String(err);
          log.error('file-mention', 'failed to list dir', { dirPath, host, error: msg });
          setError(msg);
          setEntries([]);
        } finally {
          if (inFlightRef.current === dirPath) {
            inFlightRef.current = null;
            setLoading(false);
          }
        }
      },
      [host],
    );

    // (Re)load from the root whenever the session context (cwd/host) changes.
    // Guard empty cwd (session still loading) so we don't hit the backend with "".
    useEffect(() => {
      if (!cwd) { setError('No working directory'); setLoading(false); return; }
      setRootPath(cwd);
      setBrowseDir(cwd);
      void loadDir(cwd, { isRoot: true });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cwd, host]);

    // The "@query" doubles as a path: its dir portion drives navigation, its last
    // segment filters. When typing crosses a "/" (e.g. "src/" → "src/web"), the
    // target dir changes and we load it. Compare against browseDir so we only fetch
    // when the resolved directory actually moves (typing the filter part is free).
    // "@?" searches recent folders across this host plus a bounded live listing
    // under the current cwd; it never lists the entire host.
    const recentsMode = query.startsWith('?');
    const recentQuery = recentsMode ? query.slice(1) : '';

    const { dir: targetDir, filter: filterTerm } = parseQuery(query, cwd);
    useEffect(() => {
      // In recents mode "@?…" the query is a fuzzy search, NOT a path — don't let a
      // "/" in it trigger a phantom background loadDir (which would also pollute the
      // recents store with a dir the user never actually opened).
      if (!cwd || recentsMode) return;
      // Normalize trailing slash before comparing so "/a/b" and "/a/b/" match.
      const norm = (p: string) => p.replace(/\/+$/, '') || '/';
      if (norm(targetDir) !== norm(browseDir)) void loadDir(targetDir);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetDir, recentsMode]);
    const [allRecents, setAllRecents] = useState<RecentFolder[]>([]);
    const [nearby, setNearby] = useState<{ dir: string; host?: string; folders: RecentFolder[] } | null>(null);
    const [searchError, setSearchError] = useState(false);
    const [searching, setSearching] = useState(false);
    const [retrySearch, setRetrySearch] = useState(0);
    const searchActive = !!recentQuery.trim();
    const searchDir = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
    const requestedSearch = useRef<{ dir: string; host?: string; retry: number } | null>(null);
    useEffect(() => {
      if (!recentsMode) return;
      let cancelled = false;
      setAllRecents([]);
      getRecentFolders(host).then((r) => { if (!cancelled) setAllRecents(r); });
      return () => { cancelled = true; };
    }, [recentsMode, host]);
    useEffect(() => {
      if (!recentsMode || !searchActive || !cwd) {
        requestedSearch.current = null;
        setSearching(false);
        setSearchError(false);
        setNearby(null);
        return;
      }
      if (requestedSearch.current?.dir === searchDir && requestedSearch.current.host === host
        && requestedSearch.current.retry === retrySearch) return;
      requestedSearch.current = { dir: searchDir, host, retry: retrySearch };
      let cancelled = false;
      setSearching(true);
      setSearchError(false);
      setNearby((current) => current?.dir === searchDir && current.host === host ? current : null);
      let poll: ReturnType<typeof setTimeout> | undefined;
      let attempts = 0;
      let inFlight = false;
      let incomplete = false;
      const siblingDir = parentPath(searchDir);
      const roots = [
        { dir: searchDir, depth: '3' },
        ...(siblingDir !== '/' && siblingDir !== (searchDir.replace(/\/+$/, '') || '/')
          ? [{ dir: siblingDir.endsWith('/') ? siblingDir : `${siblingDir}/`, depth: '1' }]
          : []),
      ];
      let pendingRoots = roots;
      const previousPaths = nearby?.dir === searchDir && nearby.host === host
        ? nearby.folders.map((folder) => folder.path) : [];
      const previousByRoot = new Map(roots.map((root) => [root.dir,
        previousPaths.filter((path) => path.startsWith(root.dir)
          && (root.dir === searchDir || !path.slice(root.dir.length).includes('/'))),
      ]));
      const found = new Map<string, string[]>();
      const loadNearby = () => {
        poll = undefined;
        if (inFlight) return;
        inFlight = true;
        Promise.all(pendingRoots.map(async (root) => {
          const params = new URLSearchParams({ prefix: root.dir, depth: root.depth });
          if (host) { params.set('host', host); params.set('pending', '1'); params.set('wait', '500'); }
          try {
            const listing = await apiGet<{ dirs: string[]; exists: boolean; pending?: object; hostError?: object; incomplete?: object }>(
              `/api/sessions/list-dirs?${params}`,
            );
            return { root, listing };
          } catch (err) {
            log.error('file-mention', 'failed to search folders', { cwd, host, dir: root.dir, error: String(err) });
            return { root, listing: null };
          }
        })).then((results) => {
          if (cancelled) return;
          pendingRoots = [];
          for (const { root, listing } of results) {
            if (listing?.pending) { pendingRoots.push(root); continue; }
            if (!listing || listing.hostError || !listing.exists) { incomplete = true; continue; }
            found.set(root.dir, listing.dirs);
            if (listing.incomplete) incomplete = true;
          }
          const retained = roots.flatMap((root) => found.has(root.dir) ? [] : previousByRoot.get(root.dir) ?? []);
          const paths = new Set([...retained, ...Array.from(found.values()).flat()]);
          setNearby({ dir: searchDir, host, folders: Array.from(paths, (path) => ({ path, host })) });
          if (pendingRoots.length && ++attempts < 6) {
            poll = setTimeout(loadNearby, 1500);
          } else {
            setSearching(false);
          }
          setSearchError(incomplete || (pendingRoots.length > 0 && attempts >= 6));
        }).finally(() => { inFlight = false; });
      };
      const timer = setTimeout(loadNearby, 150);
      const unsubscribe = host ? subscribeHostStatus(() => {
        if (getHostStatus(host)?.connected && poll) {
          clearTimeout(poll);
          poll = undefined;
          loadNearby();
        }
      }) : undefined;
      return () => {
        cancelled = true;
        clearTimeout(timer);
        clearTimeout(poll);
        unsubscribe?.();
        if (requestedSearch.current?.dir === searchDir && requestedSearch.current.host === host
          && requestedSearch.current.retry === retrySearch) requestedSearch.current = null;
      };
    }, [recentsMode, searchActive, searchDir, cwd, host, retrySearch]);
    const nearbyFolders = nearby?.dir === searchDir && nearby.host === host ? nearby.folders : [];

    const recentMatches = useMemo(() => {
      if (!recentsMode) return [];
      if (!searchActive) return fuzzyMatchRecents('', allRecents, { cwd: rootPath }).slice(0, 40);
      const seen = new Set(allRecents.map((r) => r.path));
      const candidates = [...allRecents, ...nearbyFolders.filter((r) => !seen.has(r.path))];
      return fuzzyMatchRecents(recentQuery, candidates, { cwd: rootPath }).slice(0, 40);
    }, [recentsMode, recentQuery, searchActive, allRecents, nearby, rootPath]);

    // Filter the current dir by the trailing path segment (case-insensitive,
    // prefix matches rank before substring matches).
    const filtered = useMemo(() => {
      const q = filterTerm.trim().toLowerCase();
      if (!q) return entries;
      const starts: DirEntry[] = [];
      const contains: DirEntry[] = [];
      for (const e of entries) {
        const n = e.name.toLowerCase();
        if (n.startsWith(q)) starts.push(e);
        else if (n.includes(q)) contains.push(e);
      }
      return [...starts, ...contains];
    }, [entries, filterTerm]);

    // Reset selection to the top whenever the filter (or recents query) changes —
    // the result set can reorder at the same length, so clamping on length alone
    // would silently leave the highlight on a different item.
    useEffect(() => {
      setSelectedIndex(0);
    }, [filterTerm, recentQuery, recentsMode]);

    // Global Escape closes the popup even after the user has clicked into it and
    // the textarea lost focus (the parent's keydown handler only fires while the
    // textarea is focused). Capture phase + stopPropagation so it doesn't also
    // trigger an outer overlay's Escape handler.
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); }
      };
      window.addEventListener('keydown', handler, true);
      return () => window.removeEventListener('keydown', handler, true);
    }, [onClose]);

    // Preview the selected file (skip dirs).
    useEffect(() => {
      const item = filtered[selectedIndex];
      if (item && item.type === 'file') setPreviewFile(joinPath(browseDir, item.name));
      else setPreviewFile(null);
    }, [filtered, selectedIndex, browseDir]);

    // Scroll selection into view.
    useEffect(() => {
      const list = listRef.current;
      if (!list) return;
      const el = list.querySelector('.file-mention-item.selected');
      el?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex, recentMatches]);

    const enterDir = useCallback(
      (dirPath: string) => {
        void loadDir(dirPath);
      },
      [loadDir],
    );

    const goUp = useCallback(() => {
      const parent = parentPath(browseDir);
      if (parent !== browseDir) void loadDir(parent);
    }, [browseDir, loadDir]);

    // Editable path: click the breadcrumb to type an absolute path and jump there.
    const [editingPath, setEditingPath] = useState(false);
    const commitPath = useCallback((raw: string) => {
      // Collapse any "."/".." the user typed (backend rejects literal ".."), so the
      // breadcrumb editor accepts "../foo" the same way the "@query" path does.
      const next = raw.trim() ? normalizePath(raw.trim()) : '';
      setEditingPath(false);
      if (next && next !== browseDir) void loadDir(next);
    }, [browseDir, loadDir]);

    const selectEntry = useCallback(
      (entry: DirEntry) => {
        onSelect(joinPath(browseDir, entry.name));
      },
      [browseDir, onSelect],
    );

    // Open a recent folder: leave "@?" mode and browse into it (lists its contents).
    // Recents are already host-filtered (getRecentFolders(host)), so every entry is on
    // this session's host and is always browsable — no cross-host fallback needed.
    const chooseRecent = useCallback(
      (r: RecentFolder) => { onNavigate(r.path); },
      [onNavigate],
    );

    // Active list length depends on mode (recents vs current-dir entries).
    const listLen = recentsMode ? recentMatches.length : filtered.length;

    useImperativeHandle(
      ref,
      (): FileMentionHandle => ({
        move: (delta) => {
          setSelectedIndex((i) => {
            if (listLen === 0) return 0;
            return (i + delta + listLen) % listLen;
          });
        },
        into: () => {
          if (recentsMode) {
            const r = recentMatches[selectedIndex];
            if (r) chooseRecent(r);
            return;
          }
          const item = filtered[selectedIndex];
          if (!item) return;
          if (item.type === 'dir') enterDir(joinPath(browseDir, item.name));
          else selectEntry(item);
        },
        up: goUp,
        selectCurrent: () => {
          if (recentsMode) {
            const r = recentMatches[selectedIndex];
            if (r) onSelect(r.path); // select the recent folder directly as the @ref
            return;
          }
          const item = filtered[selectedIndex];
          if (item) selectEntry(item);
        },
      }),
      [recentsMode, recentMatches, filtered, listLen, selectedIndex, browseDir, enterDir, selectEntry, chooseRecent, onSelect, goUp],
    );

    const atRoot = browseDir === rootPath;

    return (
      <div className="file-mention-popup">
        <div className="file-mention-toolbar">
          <button
            className="fmp-btn"
            onMouseDown={(e) => { e.preventDefault(); goUp(); }}
            disabled={browseDir === '/'}
            title="Go to parent directory"
          >
            ↑
          </button>
          {editingPath ? (
            <input
              className="fmp-breadcrumb-input"
              defaultValue={browseDir}
              autoFocus
              spellCheck={false}
              onKeyDown={(e) => {
                e.stopPropagation(); // don't let popup keyboard nav intercept typing
                if (e.key === 'Enter') { e.preventDefault(); commitPath((e.target as HTMLInputElement).value); }
                else if (e.key === 'Escape') { e.preventDefault(); setEditingPath(false); }
              }}
              onBlur={(e) => commitPath(e.target.value)}
            />
          ) : (
            <span
              className="fmp-breadcrumb"
              title={`${browseDir} — click to edit`}
              onMouseDown={(e) => { e.preventDefault(); setEditingPath(true); }}
            >
              {atRoot ? browseDir : relativeTo(rootPath, browseDir)}
            </span>
          )}
          <button
            className="fmp-btn fmp-select-folder"
            onMouseDown={(e) => { e.preventDefault(); onSelect(browseDir); }}
            title="Select this folder (⌘⏎ also selects the highlighted item)"
          >
            Select folder
          </button>
          <button
            className="fmp-btn fmp-close"
            onMouseDown={(e) => { e.preventDefault(); onClose(); }}
            title="Close (Esc)"
          >
            &times;
          </button>
        </div>

        <div className="file-mention-body">
          {recentsMode ? (
            <div className="file-mention-list file-mention-list-recents" ref={listRef}>
              {searchError && (
                <div className="fmp-error">Nearby results may be incomplete. <button type="button" onMouseDown={(e) => { e.preventDefault(); setRetrySearch((n) => n + 1); }}>Retry</button></div>
              )}
              {searching && recentMatches.length > 0 && <div className="fmp-loading">Searching nearby folders…</div>}
              {recentMatches.length === 0 && !searchError && (
                <div className="fmp-empty">{searching ? 'Searching nearby folders…' : recentQuery.trim() ? 'No folders match here. Type @/path to browse elsewhere.' : 'No recent folders yet. Type a name to search nearby folders.'}</div>
              )}
              {recentMatches.map((r, i) => {
                const name = r.path.slice(r.path.lastIndexOf('/') + 1) || r.path;
                return (
                  <div
                    key={`${r.host ?? 'local'}:${r.path}`}
                    className={`file-mention-item fmp-recent-item${i === selectedIndex ? ' selected' : ''}`}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onMouseDown={(e) => { e.preventDefault(); chooseRecent(r); }}
                    title={`${r.path}${r.host ? ` (on ${r.host})` : ''}`}
                  >
                    <span className="fmp-icon">{allRecents.some((recent) => recent.path === r.path) ? '🕘' : '📁'}</span>
                    <span className="fmp-recent">
                      <span className="fmp-recent-name">{name}</span>
                      <span className="fmp-recent-path">{r.path}</span>
                    </span>
                    <button
                      className="fmp-pick"
                      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onSelect(r.path); }}
                      title="Select this folder (⌘⏎)"
                    >
                      Select
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              <div className="file-mention-list" ref={listRef}>
                {error && <div className="fmp-error">{error}</div>}
                {!error && loading && <div className="fmp-loading">Loading…</div>}
                {!error && !loading && filtered.length === 0 && (
                  <div className="fmp-empty">No matches</div>
                )}
                {!error &&
                  filtered.map((entry, i) => (
                    <div
                      key={`${entry.type}:${entry.name}`}
                      className={`file-mention-item${i === selectedIndex ? ' selected' : ''}`}
                      onMouseEnter={() => setSelectedIndex(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (entry.type === 'dir') enterDir(joinPath(browseDir, entry.name));
                        else selectEntry(entry);
                      }}
                      title={joinPath(browseDir, entry.name)}
                    >
                      <span className="fmp-icon">{entry.type === 'dir' ? '📁' : '📄'}</span>
                      <span className="fmp-name">{entry.name}</span>
                      {entry.type === 'dir' && <span className="fmp-into">→</span>}
                      {entry.type === 'file' && entry.size != null && (
                        <span className="fmp-size">{formatSize(entry.size)}</span>
                      )}
                      {/* Select-this affordance: works for both files and dirs */}
                      <button
                        className="fmp-pick"
                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); selectEntry(entry); }}
                        title="Select this (⌘⏎)"
                      >
                        Select
                      </button>
                    </div>
                  ))}
              </div>

              <div className="file-mention-preview">
                {previewFile ? (
                  <FileContentView key={previewFile} path={previewFile} host={host} />
                ) : (
                  <div className="fmp-preview-empty">
                    {filtered[selectedIndex]?.type === 'dir'
                      ? 'Folder — →/⏎ to open, ⌘⏎ to select'
                      : 'Select a file to preview'}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="file-mention-hint">
          {recentsMode ? (
            <>
              <span>↑↓ move</span>
              <span>⏎ open folder</span>
              <span>⌘⏎ select</span>
              <span>esc close</span>
            </>
          ) : (
            <>
              <span>↑↓ move</span>
              <span>→/⏎ open dir</span>
              <span>← parent</span>
              <span>⌘⏎ select</span>
              <span>@? find folders</span>
              <span>esc close</span>
            </>
          )}
        </div>
      </div>
    );
  },
);
