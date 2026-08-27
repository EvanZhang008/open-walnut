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
import { FileContentView } from '@/components/common/FileContentView';
import { formatSize } from '@/utils/format';
import { log } from '@/utils/log';
import { recordRecentFolder, getRecentFolders, fuzzyMatchRecents, type RecentFolder } from '@/utils/recentFolders';
import { joinPath, parentPath, relativeTo, parseQuery } from './mention-path';

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
    // "@?" recents mode: a fuzzy search over folders the user has opened before —
    // any depth, not limited to the current cwd. Recents come from the shared,
    // server-persisted UNION of session working dirs (frequent-dirs) + "@"-browsed
    // folders (mention-dirs) — scoped to THIS session's host (you can't reference a
    // folder on another machine over this transport). Folders under the current cwd
    // are boosted to the top but never excluded. The text after "?" is the fuzzy query.
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
    useEffect(() => {
      if (!recentsMode) return;
      let cancelled = false;
      // Scoped to this session's host — a remote session won't list local folders.
      getRecentFolders(host).then((r) => { if (!cancelled) setAllRecents(r); }).catch(() => {});
      return () => { cancelled = true; };
    }, [recentsMode, host]);
    const recentMatches = useMemo(
      () => (recentsMode ? fuzzyMatchRecents(recentQuery, allRecents, { cwd: rootPath }) : []),
      [recentsMode, recentQuery, allRecents, rootPath],
    );

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
      const el = list.children[selectedIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

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
            /* "@?" recents mode: a single full-width list of recently-opened folders. */
            <div className="file-mention-list file-mention-list-recents" ref={listRef}>
              {recentMatches.length === 0 && (
                <div className="fmp-empty">No recent folders yet — browse some with @ first</div>
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
                    <span className="fmp-icon">🕘</span>
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
              <span>@? recents</span>
              <span>esc close</span>
            </>
          )}
        </div>
      </div>
    );
  },
);
