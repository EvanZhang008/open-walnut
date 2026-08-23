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
import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDragGesture } from '@/hooks/useDragGesture';
import { fetchDirList, downloadFileUrl, fetchReferences, type DirEntry, type ReferencesResponse } from '@/api/files';
import { fetchSessionChangedPaths } from '@/api/session-changes';
import { FileContentView } from '@/components/common/FileContentView';
import { ReferencePanel } from '@/components/common/ReferencePanel';
import { FileTreeContextMenu, type FileTreeContextTarget } from './FileTreeContextMenu';
import { parentPath, revealAncestors } from './reveal-ancestors';
import { ICON_REFRESH, ICON_PANEL_LEFT, ICON_PANEL_LEFT_FILLED } from '@/components/common/Icons';
import { formatSize } from '@/utils/format';
import { getRecentFolders, fuzzyMatchRecents, type RecentFolder } from '@/utils/recentFolders';
import {
  loadSelectedFile, saveSelectedFile,
  loadFileHistory, saveFileHistory, pushFileHistory, removeFromFileHistory,
  stampFileHistoryLine,
  type FileHistory,
} from '@/utils/file-view-state';
import { vaultRelativeNotePath } from '@/utils/notes-link';
import { useRevealFile } from '@/hooks/useRevealFile';
import { openPopout } from '@/popout/openPopout';
import { log } from '@/utils/log';

interface SessionFileExplorerProps {
  cwd?: string;
  host?: string;
  /** Session id — enables the changed-repo quick-access root sections. */
  sessionId?: string;
  /** Line to highlight/scroll-to in the initially-selected file's preview. */
  initialLine?: number;
  /** Keyword to flash at `initialLine` (a reference jump from the Changed tab
   *  lands on the symbol, not just the row). */
  initialTerm?: string;
  /**
   * Stable key for "which file was I reading" + the back/forward history.
   *
   * MUST NOT be the tree root: `cwd` differs between the two ways into this panel
   * for the SAME session (Files chip → session cwd; a file-path click in the chat
   * → that file's parent dir), and keying the memory by root made the two entries
   * write/read different keys — so the chip always reopened on the empty preview
   * pane. Callers pass the session cwd here; omitted → falls back to the root.
   */
  memoryScope?: string;
  /**
   * Quote-to-ask sink. Forwarded to the preview pane so selecting text in a file
   * raises the "Ask about this" pill (same affordance as the Changed tab). Absent
   * → no pill; the standalone FileViewer overlay has no chat input to prefill.
   */
  onSelectCode?: (filePath: string, line: number | undefined, code: string) => void;
  /**
   * The chat segment of the full-width bar. In split view the panel passes its
   * chat toggle here so the ONE bar reads: [tree toggle] nav … | chat [toggle]
   * — both layout controls live on the same bar, at its two corners.
   */
  barRightSlot?: ReactNode;
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
const LS_TREE_COLLAPSED = 'open-walnut-file-explorer-tree-collapsed';
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

function lastSegment(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

export function SessionFileExplorer({ cwd, host, sessionId, initialLine, initialTerm, memoryScope, onSelectCode, barRightSlot }: SessionFileExplorerProps) {
  const [root, setRoot] = useState<string>(cwd || '~');
  const [showHidden, setShowHidden] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenMap, setChildrenMap] = useState<Map<string, DirEntry[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorPaths, setErrorPaths] = useState<Map<string, string>>(new Map());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  // The path the user asked for when the backend could only offer a nearby
  // directory instead. Rendered as a calm, dismissible note above the tree — a raw
  // `ENOENT: scandir` was the whole reported complaint. Only set when the answer is
  // a STAND-IN: a successful heal explains itself, since the tree is already
  // showing the right folder.
  const [notFound, setNotFound] = useState<string | null>(null);
  // The folder the user last clicked into — shown in the toolbar path so it
  // follows navigation (falls back to the root when nothing is focused).
  const [focusedDir, setFocusedDir] = useState<string | null>(null);
  // Changed-repo quick-access roots (collapsed by default; cwd root expanded).
  const [changedRoots, setChangedRoots] = useState<RootSection[]>([]);
  const [openRoots, setOpenRoots] = useState<Set<string>>(new Set());
  // Tree pane collapse — same affordance as the Changed tab's tree toggle and
  // the split chat column: hide navigation chrome, give the preview the width.
  const [treeCollapsed, setTreeCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_TREE_COLLAPSED) === '1'; } catch { return false; }
  });
  const toggleTreeCollapsed = useCallback(() => {
    // Persist OUTSIDE the updater: StrictMode double-invokes updaters, and this
    // key syncs to the server via ui-prefs — an impure updater would double-PUT.
    const next = !treeCollapsed;
    try { localStorage.setItem(LS_TREE_COLLAPSED, next ? '1' : '0'); } catch { /* denied */ }
    setTreeCollapsed(next);
  }, [treeCollapsed]);
  // Tree pane width — drag the divider to resize; persisted globally.
  // The preview pane immediately right of this divider renders an <iframe> for
  // HTML files, which is why this drag used to stick: a raw document mouseup
  // listener never fires once the cursor is over the iframe. useDragGesture
  // captures the pointer so every move/up comes back to the handle.
  const [treeWidth, setTreeWidth] = useState<number>(loadTreeWidth);
  const treeWidthRef = useRef(treeWidth);
  treeWidthRef.current = treeWidth;
  const startWidthRef = useRef(treeWidth);

  const { onPointerDown: onDividerPointerDown } = useDragGesture({
    cursor: 'col-resize',
    onStart: () => { startWidthRef.current = treeWidthRef.current; },
    onMove: ({ dx }) => {
      setTreeWidth(Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, startWidthRef.current + dx)));
    },
    onEnd: () => {
      try { localStorage.setItem(LS_TREE_WIDTH, String(treeWidthRef.current)); } catch { /* denied */ }
    },
  });

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
  // A restored selection awaiting existence-check against its parent listing —
  // a file deleted since the last visit must not leave a dead preview pane.
  const pendingValidateRef = useRef<string | null>(null);

  // ── Remembered file + browser-style back/forward history ──────────────────
  // Keyed by a STABLE scope, never by `root`: the Files chip roots at the session
  // cwd while a chat file-path click roots at that file's parent dir, so a
  // root-keyed memory had the two entries writing different keys (the reported
  // bug — the chip always reopened on the empty preview pane).
  const scope = memoryScope || root;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [history, setHistory] = useState<FileHistory>(() => loadFileHistory(host, memoryScope || (cwd || '~')));
  const historyRef = useRef(history);
  historyRef.current = history;

  /** Single writer for "the preview is now showing this file". */
  const commitSelection = useCallback((filePath: string | null, opts: { push?: boolean; line?: number } = {}) => {
    setSelectedFile(filePath);
    saveSelectedFile(host, scopeRef.current, filePath);
    if (!filePath || opts.push === false) return;
    // pushFileHistory no-ops when this file is already the current entry, so a
    // restore (or a re-click on the open file) can't duplicate or truncate.
    // A positioned jump (opts.line — reference panel) records the line so
    // Back/Forward return to the exact spot, editor-style.
    const next = pushFileHistory(historyRef.current, filePath, opts.line);
    if (next === historyRef.current) return;
    historyRef.current = next;
    setHistory(next);
    saveFileHistory(host, scopeRef.current, next);
  }, [host]);
  const commitSelectionRef = useRef(commitSelection);
  commitSelectionRef.current = commitSelection;

  const loadDir = useCallback(async (
    dirPath: string,
    opts: { isRoot?: boolean; restoreExpanded?: boolean; noCache?: boolean } = {},
  ): Promise<void> => {
    const { isRoot = false, restoreExpanded = false, noCache = false } = opts;
    // Dedupe concurrent loads of the same dir (rapid double-clicks, overlapping refetch)
    if (inFlightRef.current.has(dirPath)) return;
    inFlightRef.current.add(dirPath);
    setLoadingPaths((prev) => new Set(prev).add(dirPath));
    setErrorPaths((prev) => { const next = new Map(prev); next.delete(dirPath); return next; });
    try {
      // cwd + sessionId let the backend SELF-HEAL a path that doesn't exist
      // (resolve it against the session's transcript / git index, then list what
      // it found) instead of answering `ENOENT: scandir`.
      const res = await fetchDirList(dirPath, host, showHidden, { noCache, cwd, sessionId });
      // Backend resolves ~ → absolute path and returns it; adopt it as the canonical
      // root so localStorage keys and child paths are all absolute (keeps the
      // persisted expand-state key stable instead of split between ~ and /abs).
      // The same applies when the backend HEALED an unlistable path: `res.path` is
      // then a different directory entirely, and every child path must hang off it.
      const canonical = res.path && (isRoot || res.path !== dirPath) ? res.path : dirPath;
      setChildrenMap((prev) => new Map(prev).set(canonical, res.entries));
      // A stand-in listing gets a plain "couldn't find X" note, not an error.
      setNotFound(res.requestedPath ?? null);
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
        // If the user typed a file path (or a click deep-linked one), the backend
        // listed its parent and flagged the file — open it in the preview pane
        // (VS Code style). An EXPLICIT target always beats the remembered one.
        if (res.selectedFile) {
          const target = joinPath(canonical, res.selectedFile);
          // A deep-linked file IS a navigation — it joins the back/forward stack.
          commitSelectionRef.current(target);
        } else if (restoreExpanded) {
          // Nothing explicit: reopen the file that was last being read in this
          // scope, so toggling the Files panel resumes instead of showing the empty
          // "Select a file to preview" pane. Validated below once its parent
          // listing arrives (the file may have been deleted since).
          const remembered = loadSelectedFile(host, scopeRef.current);
          if (remembered) {
            // push:false — restoring what you were already reading is not a new
            // navigation, so it must not truncate the forward tail.
            commitSelectionRef.current(remembered, { push: false });
            pendingValidateRef.current = remembered;
            const dir = parentPath(remembered);
            if (dir !== canonical && !childrenMapRef.current.has(dir)) void loadDirRef.current?.(dir);
          }
        }
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
  }, [host, showHidden, root, cwd, sessionId]);
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
    pendingValidateRef.current = null;
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

  // The remembered file + history belong to the scope, so re-read them when the
  // scope (or host) changes — i.e. when this explorer is pointed at a different
  // session — NOT on every re-root inside the same session.
  useEffect(() => {
    const loaded = loadFileHistory(host, scope);
    historyRef.current = loaded;
    setHistory(loaded);
  }, [host, scope]);

  // REVEAL the selected file in the tree: expand every ancestor between the root
  // and the file and load their listings. Without this, "remembered the file" only
  // filled the preview pane — the tree still sat collapsed at the root, so the
  // selected row was invisible and the file looked un-found ("it should go there
  // automatically"). Also what makes Back/Forward land on a visible row.
  useEffect(() => {
    if (!selectedFile) return;
    const ancestors = revealAncestors(root, selectedFile);
    if (ancestors.length === 0) return; // direct child of the root — already visible
    setExpanded((prev) => {
      if (ancestors.every((a) => prev.has(a))) return prev; // no-op guard: keeps this effect from looping
      const next = new Set(prev);
      for (const a of ancestors) next.add(a);
      try { localStorage.setItem(lsKeyRef.current, JSON.stringify([...next])); } catch { /* quota/denied */ }
      return next;
    });
    for (const a of ancestors) {
      if (!childrenMapRef.current.has(a)) void loadDirRef.current?.(a);
    }
  }, [selectedFile, root]);

  // Drop a restored selection whose file no longer exists (deleted/renamed since
  // the last visit) once its parent directory listing lands — otherwise the
  // preview pane sits on a permanent "file not found". It leaves the history too:
  // a Back button that lands on a dead file is worse than a shorter stack.
  useEffect(() => {
    const pending = pendingValidateRef.current;
    if (!pending) return;
    const entries = childrenMap.get(parentPath(pending));
    if (!entries) return; // listing not in yet
    pendingValidateRef.current = null;
    const name = lastSegment(pending);
    if (!entries.some((e) => e.name === name && e.type === 'file')) {
      setSelectedFile((cur) => (cur === pending ? null : cur));
      saveSelectedFile(host, scopeRef.current, null);
      const pruned = removeFromFileHistory(historyRef.current, pending);
      if (pruned !== historyRef.current) {
        historyRef.current = pruned;
        setHistory(pruned);
        saveFileHistory(host, scopeRef.current, pruned);
      }
    }
  }, [childrenMap, host]);

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
            // Name only — g.label is a submodule's whole path under the
            // superproject, which clips from the right and hides the name.
            // The header's title already carries the full path for hover.
            roots.push({ path: repoRoot, label: lastSegment(repoRoot) || g.label, kind: 'changed', fileCount: g.files.length });
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
      // The open file SURVIVES a re-root (VS Code keeps your editor open while you
      // browse elsewhere), and the memory is scope-keyed now, so clearing it here
      // would only flash the empty pane before loadDir restored the same file.
      setFocusedDir(null);
      pendingValidateRef.current = null;
      void loadDir(parent, { isRoot: true, restoreExpanded: true });
    }
  }, [root, loadDir]);

  // Bumped on every Refresh so the preview pane refetches the open file too —
  // "refresh the file panel" means the tree AND the content you're looking at.
  const [reloadToken, setReloadToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(() => {
    // Refetch root + every loaded dir IN PLACE — do NOT clear childrenMap first.
    // Nuking it collapsed every expanded subtree until refetches trickled in
    // (and left `expanded` pointing at unloaded dirs → the dead first click).
    // loadDir overwrites each dir's entries as fresh listings arrive.
    const loaded = [...childrenMapRef.current.keys()];
    const targets = loaded.length === 0 ? [root] : loaded;
    setReloadToken((n) => n + 1);
    setRefreshing(true);
    void Promise.all(targets.map((p) => loadDir(p, { isRoot: p === root, noCache: true })))
      .finally(() => setRefreshing(false));
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
    // Selection survives the jump for the same reason as goUp: the memory is
    // scope-keyed, so clearing it here would just flash the empty preview pane.
    // Typing a FILE path still wins — loadDir's res.selectedFile is explicit.
    setFocusedDir(null);
    pendingValidateRef.current = null;
    void loadDir(next, { isRoot: true, restoreExpanded: true });
  }, [root, loadDir]);

  // ── Right-click menu (Walnut's own, not the browser's) ────────────────────
  const navigate = useNavigate();
  const { canReveal, reveal, error: revealError, clearError: clearRevealError } = useRevealFile(host);
  const [ctxMenu, setCtxMenu] = useState<FileTreeContextTarget | null>(null);

  const openContextMenu = useCallback((e: React.MouseEvent, node: { path: string; type: 'dir' | 'file' }) => {
    e.preventDefault();
    e.stopPropagation();
    const point = { x: e.clientX, y: e.clientY };
    // Open immediately (a right-click must never feel laggy); the vault-note
    // check is async (notesDir fetch) and patches "Open in Notes" in when it
    // resolves — for the same target only, so a fast re-click can't cross-fill.
    setCtxMenu({ point, path: node.path, type: node.type });
    if (node.type === 'file') {
      void vaultRelativeNotePath(node.path, host).then((rel) => {
        if (!rel) return;
        setCtxMenu((cur) => (cur && cur.path === node.path ? { ...cur, notePath: rel } : cur));
      }).catch(() => { /* not a note — menu just lacks the item */ });
    }
  }, [host]);

  // Jump target of a positioned navigation (reference row / lined history stop):
  // open that file at that line in the preview pane. `term` is the symbol that
  // was jumped to — the preview flashes it so the eye lands on the keyword, not
  // just the line. Rides separate state — `initialLine` is the mount deep link.
  const [refLine, setRefLine] = useState<{ file: string; line: number; term?: string } | null>(null);

  const selectFile = useCallback((filePath: string) => {
    setFocusedDir(parentPath(filePath));
    // A plain tree click is NOT a positioned jump — drop any leftover reference
    // target, or reopening the same file would re-land on the old jump line.
    setRefLine(null);
    commitSelection(filePath);
  }, [commitSelection]);

  // ── Browser-style Back / Forward over the files read in this scope ─────────
  // Both buttons move the index WITHOUT pushing (that would truncate the tail —
  // the classic broken-back-button bug), and load the target's parent dir so the
  // tree row is visible/selected when you land there, exactly like a tree click.
  const canGoBack = history.index > 0;
  const canGoForward = history.index >= 0 && history.index < history.entries.length - 1;

  const navigateHistory = useCallback((delta: -1 | 1) => {
    const cur = historyRef.current;
    const nextIdx = cur.index + delta;
    const target = cur.entries[nextIdx];
    if (!target) return;
    const next = { entries: cur.entries, index: nextIdx };
    historyRef.current = next;
    setHistory(next);
    saveFileHistory(host, scopeRef.current, next);
    setSelectedFile(target.path);
    setFocusedDir(parentPath(target.path));
    saveSelectedFile(host, scopeRef.current, target.path);
    // A stop recorded with a line (reference jump / stamped departure) returns
    // to that exact position; un-lined stops resume via the scroll memory.
    setRefLine(target.line ? { file: target.path, line: target.line } : null);
    const dir = parentPath(target.path);
    if (!childrenMapRef.current.has(dir)) void loadDirRef.current?.(dir);
  }, [host]);

  // ── Reference search (cmd+click an identifier in the preview) ──────────────
  // The panel lives HERE (a third column of the explorer body) so a match click
  // can reuse the normal file-open path — history, tree reveal, everything.
  const [refState, setRefState] = useState<{
    symbol: string; fromFile: string; loading: boolean; result: ReferencesResponse | null; error: string | null;
  } | null>(null);
  const refSeqRef = useRef(0);

  const openReference = useCallback((file: string, lineNum: number, term?: string) => {
    setRefLine({ file, line: lineNum, term });
    setFocusedDir(parentPath(file));
    commitSelectionRef.current(file, { line: lineNum });
  }, []);

  /** Editor-style history: before a positioned jump leaves, pin the departure
   *  line on the CURRENT entry so Back returns to the exact spot, not just the
   *  file. Plain scrolls don't stamp (the scroll memory owns those). */
  const stampDeparture = useCallback((fromFile: string, fromLine: number) => {
    const next = stampFileHistoryLine(historyRef.current, fromFile, fromLine);
    if (next === historyRef.current) return;
    historyRef.current = next;
    setHistory(next);
    saveFileHistory(host, scopeRef.current, next);
  }, [host]);

  const handleSymbolLookup = useCallback((symbol: string, fromFile: string, fromLine?: number) => {
    if (fromLine) stampDeparture(fromFile, fromLine);
    const seq = ++refSeqRef.current;
    setRefState({ symbol, fromFile, loading: true, result: null, error: null });
    fetchReferences(fromFile, symbol, host)
      .then((res) => {
        if (refSeqRef.current !== seq) return; // a newer lookup superseded this one
        // Exactly one definition somewhere else → jump straight there (VS Code
        // behavior); the panel still opens so the reader keeps the full picture.
        setRefState({ symbol, fromFile, loading: false, result: res, error: null });
        const defs = res.matches.filter((m) => m.kind === 'def');
        if (defs.length === 1 && defs[0]!.file !== fromFile) {
          openReference(defs[0]!.file, defs[0]!.line, symbol);
        }
        log.info('file-explorer', 'reference lookup', {
          symbol, fromFile, host, matches: res.matches.length, tool: res.tool, truncated: res.truncated,
        });
      })
      .catch((err) => {
        if (refSeqRef.current !== seq) return;
        setRefState({ symbol, fromFile, loading: false, result: null, error: err instanceof Error ? err.message : String(err) });
      });
  }, [host, openReference, stampDeparture]);

  const closeReferences = useCallback(() => {
    refSeqRef.current += 1;
    setRefState(null);
  }, []);

  // Esc closes the panel (capture so the fullscreen/overlay handlers don't eat it).
  useEffect(() => {
    if (!refState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeReferences(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [refState, closeReferences]);

  // ⌘/Ctrl + [ / ] — the shortcut every editor and browser uses. Listened on
  // window, NOT on the explorer subtree: tree rows are plain divs with no
  // tabindex, so nothing inside here ever holds focus and a local listener would
  // simply never fire. Guards: text fields keep their brackets, and when more
  // than one explorer is mounted the keys only drive the focused one.
  const explorerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key !== '[' && e.key !== ']') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const el = explorerRef.current;
      if (!el) return;
      if (document.querySelectorAll('.session-file-explorer').length > 1
        && !el.contains(document.activeElement)) return;
      e.preventDefault();
      navigateHistory(e.key === '[' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigateHistory]);

  return (
    <div className="session-file-explorer" ref={explorerRef}>
      <div className="session-file-explorer-toolbar">
        {/* VS Code-style layout toggle: window glyph, left compartment filled
            while the tree shows. Lives HERE (toolbar, fixed spot) — the
            floating chevron + collapsed rail were unfindable/unreadable. */}
        <button
          type="button"
          className="sfe-btn sfe-tree-toggle"
          onClick={toggleTreeCollapsed}
          title={treeCollapsed ? 'Show file tree' : 'Hide file tree'}
          aria-label={treeCollapsed ? 'Show file tree' : 'Hide file tree'}
          aria-expanded={!treeCollapsed}
        >
          {treeCollapsed ? ICON_PANEL_LEFT : ICON_PANEL_LEFT_FILLED}
        </button>
        <div className="sfe-nav-group">
          <button
            type="button"
            className="sfe-btn sfe-nav-btn"
            onClick={() => navigateHistory(-1)}
            disabled={!canGoBack}
            title={canGoBack ? `Back to ${lastSegment(history.entries[history.index - 1]!.path)} (⌘[)` : 'Back (no earlier file)'}
            aria-label="Back to the previously viewed file"
          >‹</button>
          <button
            type="button"
            className="sfe-btn sfe-nav-btn"
            onClick={() => navigateHistory(1)}
            disabled={!canGoForward}
            title={canGoForward ? `Forward to ${lastSegment(history.entries[history.index + 1]!.path)} (⌘])` : 'Forward (no later file)'}
            aria-label="Forward to the next viewed file"
          >›</button>
        </div>
        <button type="button" className="sfe-btn sfe-up-btn" onClick={goUp} title="Go to parent directory" aria-label="Go to parent directory">↑</button>
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
          <button
            type="button"
            className={`sfe-btn sfe-refresh-btn${refreshing ? ' is-refreshing' : ''}`}
            onClick={handleRefresh}
            title="Refresh — re-list folders and reload the open file"
            aria-label="Refresh file panel"
          >
            {ICON_REFRESH}
            <span className="sfe-btn-label">Refresh</span>
          </button>
          <label className="sfe-hidden-toggle" title="Show hidden files">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            <span>Hidden</span>
          </label>
        </div>
        {barRightSlot}
      </div>

      <div className="session-file-explorer-body">
        {!treeCollapsed && (
        <div className="session-file-explorer-tree" style={{ width: `${treeWidth}px` }}>
          {rootError && <div className="sfe-error">{rootError}</div>}
          {/* Only a GENUINE miss gets a note (the errno-replacement contract).
              A successful heal ("found it nearby") explains itself — the tree
              is already showing the right folder, so a banner is just noise
              (2026-08-18 feedback). Dismissible either way. */}
          {notFound && (
            <div className="sfe-notice" title={notFound}>
              Couldn't find <code>{notFound}</code> — showing the nearest folder.
              <button
                type="button"
                className="sfe-notice-dismiss"
                onClick={() => setNotFound(null)}
                title="Dismiss"
                aria-label="Dismiss path notice"
              >
                ✕
              </button>
            </div>
          )}
          {rootSections.map((section) => {
            const isOpen = openRoots.has(section.path);
            const rows = rowsByRoot.get(section.path) ?? [];
            const isRootLoading = loadingPaths.has(section.path);
            return (
              <div key={section.path} className="sfe-root-section">
                <div
                  className={`session-file-explorer-node sfe-root-header${section.kind === 'changed' ? ' sfe-root-changed' : ''}`}
                  onClick={() => toggleRoot(section.path)}
                  onContextMenu={(e) => openContextMenu(e, { path: section.path, type: 'dir' })}
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
                          // Remember the file being read so reopening the panel resumes here.
                          else selectFile(node.path);
                        }}
                        onContextMenu={(e) => openContextMenu(e, node)}
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
        )}

        {!treeCollapsed && (
        <div
          className="sfe-divider"
          onPointerDown={onDividerPointerDown}
          title="Drag to resize"
          role="separator"
          aria-orientation="vertical"
        />
        )}

        <div className="session-file-explorer-preview">
          {selectedFile ? (
            <FileContentView
              key={selectedFile}
              path={selectedFile}
              host={host}
              // Reference jumps ride refLine; the mount-time deep link keeps initialLine.
              line={refLine?.file === selectedFile ? refLine.line : (selectedFile === cwd ? initialLine : undefined)}
              lineTerm={refLine?.file === selectedFile ? refLine.term : (selectedFile === cwd ? initialTerm : undefined)}
              reloadToken={reloadToken}
              onSelectCode={onSelectCode}
              onSymbolLookup={handleSymbolLookup}
              // A save changes the file's size on disk, so the tree's size column
              // is now stale — re-list just that file's directory (not the whole
              // tree: a full Refresh would also reload the file we just wrote).
              onSaved={(saved) => { void loadDir(parentPath(saved), { noCache: true }); }}
            />
          ) : (
            <div className="sfe-preview-empty">Select a file to preview</div>
          )}
        </div>

        {refState && (
          <ReferencePanel
            symbol={refState.symbol}
            currentFile={refState.fromFile}
            result={refState.result}
            loading={refState.loading}
            error={refState.error}
            onOpen={(file, lineNum) => openReference(file, lineNum, refState.symbol)}
            onClose={closeReferences}
          />
        )}
      </div>

      {ctxMenu && (
        <FileTreeContextMenu
          target={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onOpen={selectFile}
          onOpenInNotes={(rel) => navigate(`/notes?path=${encodeURIComponent(rel)}`)}
          onOpenInNewTab={(p) => openPopout('file', { path: p, host })}
          onDownload={(p) => { window.location.href = downloadFileUrl(p, host); }}
          onReveal={reveal}
          canReveal={canReveal}
        />
      )}
      {revealError && (
        <div className="sfe-reveal-error" role="alert" onClick={clearRevealError} title="Click to dismiss">
          {revealError}
        </div>
      )}
    </div>
  );
}
