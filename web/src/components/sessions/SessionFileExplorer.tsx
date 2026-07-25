/**
 * SessionFileExplorer — VS Code-style two-pane file browser for a session.
 *
 * Left:  multi-root, lazy-loaded, in-place expandable directory tree.
 *        Roots = the session cwd (expanded by default) + every git repo the
 *        session changed files in (collapsed quick-access sections, like the
 *        Changed tab's repo groups). Local + remote (daemon) via /api/files/list.
 * Right: inline file content preview (FileContentView, syntax-highlight + line numbers).
 *
 * The toolbar path field fuzzy-matches recent folders (same scorer as the "@"
 * mention picker) — type a fragment, pick a suggestion, jump there.
 *
 * Expanded-dir state persists in localStorage, keyed per host + resolved root.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { fetchDirList, type DirEntry } from '@/api/files';
import { fetchSessionChangedPaths } from '@/api/session-changes';
import { FileContentView } from '@/components/common/FileContentView';
import { formatSize } from '@/utils/format';
import { getRecentFolders, fuzzyMatchRecents, type RecentFolder } from '@/utils/recentFolders';
import { log } from '@/utils/log';

interface SessionFileExplorerProps {
  cwd?: string;
  host?: string;
  /** Session id — enables the changed-repo quick-access root sections. */
  sessionId?: string;
  /** Line to highlight/scroll-to in the initially-selected file's preview. */
  initialLine?: number;
}

interface TreeNode {
  path: string;
  name: string;
  type: 'dir' | 'file';
  size?: number;
  depth: number;
}

interface RootSection {
  path: string;
  label: string;
  /** 'cwd' = session working dir; 'changed' = a git repo (or submodule) the
   *  session edited — GIT ROOTS ONLY, per-folder sections were noise. */
  kind: 'cwd' | 'changed';
  /** Changed-file count badge. */
  fileCount?: number;
}

const LS_EXPANDED = 'open-walnut-file-explorer-expanded';
const LS_OPEN_ROOTS = 'open-walnut-file-explorer-open-roots';
// v2 key: re-baseline everyone — old persisted drags left the tree eating half
// the panel; the preview pane is the star, the tree is navigation chrome.
const LS_TREE_WIDTH = 'open-walnut-file-explorer-tree-width2';
const TREE_WIDTH_DEFAULT = 200;
const TREE_WIDTH_MIN = 140;
const TREE_WIDTH_MAX = 600;

function lsKeyFor(host: string | undefined, root: string): string {
  return `${LS_EXPANDED}:${host ?? 'local'}:${root}`;
}

function lsOpenRootsKey(host: string | undefined, root: string): string {
  return `${LS_OPEN_ROOTS}:${host ?? 'local'}:${root}`;
}

function loadOpenRoots(host: string | undefined, root: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(lsOpenRootsKey(host, root));
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* corrupt/denied */ }
  return null;
}

function loadTreeWidth(): number {
  try {
    const n = Number(localStorage.getItem(LS_TREE_WIDTH));
    if (Number.isFinite(n) && n >= TREE_WIDTH_MIN && n <= TREE_WIDTH_MAX) return n;
  } catch { /* denied */ }
  return TREE_WIDTH_DEFAULT;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function parentPath(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

function lastSegment(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

export function SessionFileExplorer({ cwd, host, sessionId, initialLine }: SessionFileExplorerProps) {
  const [root, setRoot] = useState<string>(cwd || '~');
  const [showHidden, setShowHidden] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenMap, setChildrenMap] = useState<Map<string, DirEntry[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorPaths, setErrorPaths] = useState<Map<string, string>>(new Map());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  // The folder the user last clicked into — shown in the toolbar path so it
  // follows navigation (falls back to the root when nothing is focused).
  const [focusedDir, setFocusedDir] = useState<string | null>(null);
  // Changed-repo quick-access roots (collapsed by default; cwd root expanded).
  const [changedRoots, setChangedRoots] = useState<RootSection[]>([]);
  const [openRoots, setOpenRoots] = useState<Set<string>>(new Set());
  // Tree pane width — drag the divider to resize; persisted globally.
  const [treeWidth, setTreeWidth] = useState<number>(loadTreeWidth);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: treeWidth };
    const onMove = (ev: MouseEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      const w = Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, st.startWidth + (ev.clientX - st.startX)));
      setTreeWidth(w);
    };
    const onUp = () => {
      dragStateRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
      setTreeWidth((w) => {
        try { localStorage.setItem(LS_TREE_WIDTH, String(w)); } catch { /* denied */ }
        return w;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [treeWidth]);

  // toggleDir must persist to the CURRENT root's localStorage key, but we don't
  // want it re-created every time `root` changes (~ → absolute resolution). A ref
  // mirror lets the stable callback read the latest key without taking it as a dep.
  const lsKeyRef = useRef(lsKeyFor(host, root));
  lsKeyRef.current = lsKeyFor(host, root);

  // Mirror of loaded-dir keys + in-flight set, read inside callbacks/effects
  // without adding them as deps (avoids needless callback churn / stale resets).
  const childrenMapRef = useRef(childrenMap);
  childrenMapRef.current = childrenMap;
  const inFlightRef = useRef<Set<string>>(new Set());
  // Self-reference for the restore-expanded eager loads inside loadDir's body.
  const loadDirRef = useRef<((dirPath: string, opts?: { isRoot?: boolean; restoreExpanded?: boolean }) => Promise<void>) | null>(null);

  const loadDir = useCallback(async (
    dirPath: string,
    opts: { isRoot?: boolean; restoreExpanded?: boolean } = {},
  ): Promise<void> => {
    const { isRoot = false, restoreExpanded = false } = opts;
    // Dedupe concurrent loads of the same dir (rapid double-clicks, overlapping refetch)
    if (inFlightRef.current.has(dirPath)) return;
    inFlightRef.current.add(dirPath);
    setLoadingPaths((prev) => new Set(prev).add(dirPath));
    setErrorPaths((prev) => { const next = new Map(prev); next.delete(dirPath); return next; });
    try {
      const res = await fetchDirList(dirPath, host, showHidden);
      // Backend resolves ~ → absolute path and returns it; adopt it as the canonical
      // root so localStorage keys and child paths are all absolute (keeps the
      // persisted expand-state key stable instead of split between ~ and /abs).
      const canonical = isRoot && res.path ? res.path : dirPath;
      setChildrenMap((prev) => new Map(prev).set(canonical, res.entries));
      if (isRoot) {
        if (canonical !== root) setRoot(canonical);
        setRootError(null);
        if (restoreExpanded) {
          let restored = new Set<string>();
          try {
            const raw = localStorage.getItem(lsKeyFor(host, canonical));
            if (raw) restored = new Set(JSON.parse(raw) as string[]);
          } catch { /* corrupt/denied — start collapsed */ }
          setExpanded(restored);
          // ROOT-CAUSE fix for "refresh auto-closed my folders + first click is
          // dead": restoring `expanded` alone re-marks dirs as open, but their
          // children were never fetched, so nothing renders below them and the
          // first click merely flips the stale expanded bit (invisible). Eagerly
          // load every restored dir's children so the tree actually reopens.
          for (const p of [...restored].slice(0, 64)) {
            if (!childrenMapRef.current.has(p)) void loadDirRef.current?.(p);
          }
        }
        // If the user typed a file path, the backend listed its parent and flagged
        // the file — open it in the preview pane (VS Code style).
        if (res.selectedFile) setSelectedFile(joinPath(canonical, res.selectedFile));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('file-explorer', 'failed to list dir', { dirPath, host, error: msg });
      if (isRoot) setRootError(msg);
      else setErrorPaths((prev) => new Map(prev).set(dirPath, msg));
    } finally {
      inFlightRef.current.delete(dirPath);
      setLoadingPaths((prev) => { const next = new Set(prev); next.delete(dirPath); return next; });
    }
  }, [host, showHidden, root]);
  loadDirRef.current = loadDir;

  // Full reset + load root only when the session (cwd/host) changes — NOT when
  // showHidden flips (that's handled below without nuking expand/selection state).
  // loadDir is intentionally omitted: it changes with showHidden, which must not reset.
  useEffect(() => {
    const initialRoot = cwd || '~';
    setRoot(initialRoot);
    setChildrenMap(new Map());
    setErrorPaths(new Map());
    setSelectedFile(null);
    setFocusedDir(null);
    setExpanded(new Set()); // re-restored in loadDir once the root resolves to absolute
    setOpenRoots(new Set([initialRoot])); // cwd section open; re-keyed on canonicalization below
    void loadDir(initialRoot, { isRoot: true, restoreExpanded: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, host]);

  // Keep the open-state key in sync when ~ resolves to the canonical absolute
  // root, restoring any persisted open sections (survives Refresh + reload) and
  // eagerly loading their children so restored sections actually render.
  useEffect(() => {
    const persisted = loadOpenRoots(host, root);
    setOpenRoots((prev) => {
      const next = persisted ?? new Set(prev);
      next.add(root);
      return next;
    });
    if (persisted) {
      for (const p of [...persisted].slice(0, 16)) {
        if (!childrenMapRef.current.has(p)) void loadDirRef.current?.(p);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, host]);

  // Changed-file quick access: ONE section per git repo/submodule the session
  // edited (git roots only — a section per changed folder was a noisy wall).
  // Browsing AROUND the changed files happens by expanding inside the repo
  // section. Light fetch (paths only). Best-effort — a failure must not break
  // plain browsing.
  useEffect(() => {
    if (!sessionId) { setChangedRoots([]); return; }
    let cancelled = false;
    const ctrl = new AbortController();
    fetchSessionChangedPaths(sessionId, { signal: ctrl.signal })
      .then((res) => {
        if (cancelled) return;
        const roots: RootSection[] = [];
        const seen = new Set<string>();
        for (const g of res.groups) {
          const repoRoot = g.repoRoot.replace(/\/+$/, '');
          if (repoRoot && !seen.has(repoRoot)) {
            seen.add(repoRoot);
            roots.push({ path: repoRoot, label: g.label || lastSegment(repoRoot), kind: 'changed', fileCount: g.files.length });
          }
        }
        setChangedRoots(roots);
      })
      .catch((err) => {
        if (!cancelled) log.info('file-explorer', 'changed-roots fetch failed (non-fatal)', { sessionId, error: String(err) });
      });
    return () => { cancelled = true; ctrl.abort(); };
  }, [sessionId]);

  // Toggling hidden files refetches in place, preserving expansion + selection
  // (VS Code keeps your tree open). Skip the initial mount (reset effect already loaded).
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    for (const p of childrenMapRef.current.keys()) {
      void loadDir(p, { isRoot: p === root });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  const toggleDir = useCallback((node: TreeNode) => {
    setFocusedDir(node.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) {
        // Desync guard: marked expanded but children never loaded (state was
        // restored / refresh raced) — a "collapse" here would be an invisible
        // no-op (the dead first click). Load the children and stay expanded.
        if (!childrenMapRef.current.has(node.path)) {
          void loadDir(node.path);
          return prev;
        }
        next.delete(node.path);
      } else {
        next.add(node.path);
        if (!childrenMapRef.current.has(node.path)) void loadDir(node.path);
      }
      try { localStorage.setItem(lsKeyRef.current, JSON.stringify([...next])); } catch { /* quota/denied */ }
      return next;
    });
  }, [loadDir]);

  const toggleRoot = useCallback((rootPath: string) => {
    setFocusedDir(rootPath);
    setOpenRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rootPath)) {
        // Same desync guard as toggleDir: open-but-unloaded → load, don't close.
        if (!childrenMapRef.current.has(rootPath)) {
          void loadDir(rootPath);
          return prev;
        }
        next.delete(rootPath);
      } else {
        next.add(rootPath);
        if (!childrenMapRef.current.has(rootPath)) void loadDir(rootPath);
      }
      try { localStorage.setItem(lsOpenRootsKey(host, root), JSON.stringify([...next])); } catch { /* quota/denied */ }
      return next;
    });
  }, [loadDir, host, root]);

  // The rendered root sections: cwd first (labelled with its folder name), then
  // each changed repo. A changed repo that IS the cwd doesn't get its own
  // section — its count badge folds into the cwd header instead.
  const rootSections = useMemo<RootSection[]>(() => {
    const rootNorm = root.replace(/\/+$/, '');
    const cwdChanged = changedRoots.find((r) => r.path === rootNorm);
    const cwdSection: RootSection = {
      path: root, label: lastSegment(root), kind: 'cwd', fileCount: cwdChanged?.fileCount,
    };
    const rest = changedRoots.filter((r) => r.path !== rootNorm);
    return [cwdSection, ...rest];
  }, [root, changedRoots]);

  // Flatten one root's expanded subtree into visible rows (DFS). Memoized per
  // childrenMap/expanded change so unrelated re-renders don't re-walk the tree.
  const rowsByRoot = useMemo(() => {
    const byRoot = new Map<string, TreeNode[]>();
    const walk = (dirPath: string, depth: number, out: TreeNode[]) => {
      const entries = childrenMap.get(dirPath);
      if (!entries) return;
      for (const e of entries) {
        const full = joinPath(dirPath, e.name);
        out.push({ path: full, name: e.name, type: e.type, size: e.size, depth });
        if (e.type === 'dir' && expanded.has(full)) walk(full, depth + 1, out);
      }
    };
    for (const s of rootSections) {
      if (!openRoots.has(s.path)) continue;
      const out: TreeNode[] = [];
      walk(s.path, 1, out);
      byRoot.set(s.path, out);
    }
    return byRoot;
  }, [rootSections, openRoots, childrenMap, expanded]);

  const goUp = useCallback(() => {
    const parent = parentPath(root);
    if (parent !== root) {
      setChildrenMap(new Map());
      setSelectedFile(null);
      setFocusedDir(null);
      void loadDir(parent, { isRoot: true, restoreExpanded: true });
    }
  }, [root, loadDir]);

  const handleRefresh = useCallback(() => {
    // Refetch root + every loaded dir IN PLACE — do NOT clear childrenMap first.
    // Nuking it collapsed every expanded subtree until refetches trickled in
    // (and left `expanded` pointing at unloaded dirs → the dead first click).
    // loadDir overwrites each dir's entries as fresh listings arrive.
    const loaded = [...childrenMapRef.current.keys()];
    if (loaded.length === 0) { void loadDir(root, { isRoot: true }); return; }
    for (const p of loaded) void loadDir(p, { isRoot: p === root });
  }, [root, loadDir]);

  // ── Editable root path with fuzzy recent-folder suggestions (same scorer as "@") ──
  const [editingPath, setEditingPath] = useState(false);
  const [pathQuery, setPathQuery] = useState('');
  const [recents, setRecents] = useState<RecentFolder[]>([]);
  const [suggestIdx, setSuggestIdx] = useState(0);

  useEffect(() => {
    if (!editingPath) return;
    let cancelled = false;
    getRecentFolders(host).then((r) => { if (!cancelled) setRecents(r); });
    return () => { cancelled = true; };
  }, [editingPath, host]);

  const suggestions = useMemo(() => {
    if (!editingPath) return [];
    // Absolute paths are a direct jump — no suggestions needed once it looks like one.
    const q = pathQuery.trim();
    if (!q || q.startsWith('/') || q.startsWith('~')) return [];
    return fuzzyMatchRecents(q, recents, { cwd }).slice(0, 8);
  }, [editingPath, pathQuery, recents, cwd]);

  const commitPath = useCallback((raw: string) => {
    const next = raw.trim();
    setEditingPath(false);
    setPathQuery('');
    if (!next || next === root) return;
    setChildrenMap(new Map());
    setSelectedFile(null);
    setFocusedDir(null);
    void loadDir(next, { isRoot: true, restoreExpanded: true });
  }, [root, loadDir]);

  return (
    <div className="session-file-explorer">
      <div className="session-file-explorer-toolbar">
        <button className="sfe-btn" onClick={goUp} title="Go to parent directory">↑</button>
        {editingPath ? (
          <div className="sfe-path-edit">
            <input
              className="sfe-root-path-input"
              defaultValue={focusedDir ?? root}
              autoFocus
              spellCheck={false}
              placeholder="Absolute path, or type to fuzzy-match recent folders"
              onChange={(e) => { setPathQuery(e.target.value); setSuggestIdx(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); setSuggestIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
                else if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); setSuggestIdx((i) => Math.max(i - 1, 0)); }
                else if (e.key === 'Enter') {
                  e.preventDefault();
                  const picked = suggestions[suggestIdx];
                  commitPath(picked ? picked.path : (e.target as HTMLInputElement).value);
                }
                else if (e.key === 'Escape') { e.preventDefault(); setEditingPath(false); setPathQuery(''); }
              }}
              onBlur={(e) => {
                // Let a suggestion mousedown win over blur-commit.
                const val = (e.target as HTMLInputElement).value;
                setTimeout(() => { if (editingPath) commitPath(val); }, 150);
              }}
            />
            {suggestions.length > 0 && (
              <div className="sfe-path-suggest">
                {suggestions.map((s, i) => (
                  <div
                    key={s.path}
                    className={`sfe-path-suggest-item${i === suggestIdx ? ' active' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); commitPath(s.path); }}
                    title={s.path}
                  >
                    {s.path}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <span
            className="sfe-root-path"
            title={`${focusedDir ?? root} — click to edit (fuzzy-matches recent folders)`}
            onClick={() => setEditingPath(true)}
          >
            {focusedDir ?? root}
          </span>
        )}
        <div className="sfe-toolbar-actions">
          <button className="sfe-btn" onClick={handleRefresh} title="Refresh">⟳</button>
          <label className="sfe-hidden-toggle" title="Show hidden files">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            <span>Hidden</span>
          </label>
        </div>
      </div>

      <div className="session-file-explorer-body">
        <div className="session-file-explorer-tree" style={{ width: `${treeWidth}px` }}>
          {rootError && <div className="sfe-error">{rootError}</div>}
          {rootSections.map((section) => {
            const isOpen = openRoots.has(section.path);
            const rows = rowsByRoot.get(section.path) ?? [];
            const isRootLoading = loadingPaths.has(section.path);
            return (
              <div key={section.path} className="sfe-root-section">
                <div
                  className={`session-file-explorer-node sfe-root-header${section.kind === 'changed' ? ' sfe-root-changed' : ''}`}
                  onClick={() => toggleRoot(section.path)}
                  title={section.path}
                >
                  <span className="sfe-arrow">{isRootLoading ? '…' : isOpen ? '▼' : '▶'}</span>
                  <span className="sfe-icon">{section.kind === 'cwd' ? '🏠' : '📦'}</span>
                  <span className="sfe-name">{section.label}</span>
                  {section.fileCount != null && section.fileCount > 0 && (
                    <span className="sfe-size sfe-changed-badge">{section.fileCount} changed</span>
                  )}
                </div>
                {isOpen && !rootError && isRootLoading && rows.length === 0 && (
                  <div className="sfe-loading" style={{ paddingLeft: '22px' }}>Loading…</div>
                )}
                {isOpen && childrenMap.has(section.path) && rows.length === 0 && (
                  <div className="sfe-empty" style={{ paddingLeft: '22px' }}>Empty directory</div>
                )}
                {isOpen && rows.map((node) => {
                  const isExpanded = expanded.has(node.path);
                  const isSelected = node.type === 'file' && selectedFile === node.path;
                  const isLoading = loadingPaths.has(node.path);
                  const err = errorPaths.get(node.path);
                  return (
                    <div key={node.path}>
                      <div
                        className={`session-file-explorer-node${isSelected ? ' selected' : ''}`}
                        style={{ paddingLeft: `${8 + node.depth * 14}px` }}
                        onClick={() => {
                          if (node.type === 'dir') toggleDir(node);
                          else { setSelectedFile(node.path); setFocusedDir(parentPath(node.path)); }
                        }}
                        title={node.path}
                      >
                        <span className="sfe-arrow">
                          {node.type === 'dir' ? (isLoading ? '…' : isExpanded ? '▼' : '▶') : ''}
                        </span>
                        <span className="sfe-icon">{node.type === 'dir' ? '📁' : '📄'}</span>
                        <span className="sfe-name">{node.name}</span>
                        {/* size is local-only — daemon fs.ls returns just {name,type} for remote */}
                        {node.type === 'file' && node.size != null && (
                          <span className="sfe-size">{formatSize(node.size)}</span>
                        )}
                      </div>
                      {err && (
                        <div className="sfe-error" style={{ paddingLeft: `${8 + (node.depth + 1) * 14}px` }}>{err}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div
          className="sfe-divider"
          onMouseDown={onDividerMouseDown}
          title="Drag to resize"
          role="separator"
          aria-orientation="vertical"
        />

        <div className="session-file-explorer-preview">
          {selectedFile ? (
            <FileContentView
              key={selectedFile}
              path={selectedFile}
              host={host}
              line={selectedFile === cwd ? initialLine : undefined}
            />
          ) : (
            <div className="sfe-preview-empty">Select a file to preview</div>
          )}
        </div>
      </div>
    </div>
  );
}
