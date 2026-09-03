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
 *
 * Every listing is stale-while-revalidate over `cache/dirlist-idb`: the last
 * known rows paint immediately (a remote listing is an SSH-tunnel round trip, and
 * the tree used to render a bare `Loading…` until the first one landed), and the
 * network fetch always still runs and overwrites them.
 */
import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDragGesture } from '@/hooks/useDragGesture';
import { fetchDirList, fetchDirListMany, downloadFileUrl, fetchReferences, type DirEntry, type ReferencesResponse } from '@/api/files';
import { fetchSessionChangedPaths } from '@/api/session-changes';
import { useFileContentPrefetch } from '@/hooks/useFileContentPrefetch';
import { FileContentView } from '@/components/common/FileContentView';
import { ReferencePanel } from '@/components/common/ReferencePanel';
import { FileTreeContextMenu, type FileTreeContextTarget } from './FileTreeContextMenu';
import { FileTreeEditRow } from './FileTreeEditRow';
import { useFileTreeMutations, judgeRestoredSelection } from './useFileTreeMutations';
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
import { useFileDraftPaths } from '@/utils/file-drafts';
import {
  getCachedDirList, getCachedDirListsBulk, setCachedDirList, deleteCachedDirListsUnder,
} from '@/cache/dirlist-idb';
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
  /** Muted repo context rendered before `label` ("repo" or "repo/…") — a bare
   *  folder name like "templates" says nothing on a deep monorepo path. */
  prefix?: string;
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
// How many persisted-expanded dirs a re-open reconstructs: the cache prime and
// the eager refetch walk the SAME list, so one bound keeps them in step.
const MAX_RESTORE_LOADS = 64;
const TREE_WIDTH_DEFAULT = 200;
const TREE_WIDTH_MIN = 140;
const TREE_WIDTH_MAX = 600;

function lsKeyFor(host: string | undefined, root: string): string {
  return `${LS_EXPANDED}:${host ?? 'local'}:${root}`;
}

function lsOpenRootsKey(host: string | undefined, root: string): string {
  return `${LS_OPEN_ROOTS}:${host ?? 'local'}:${root}`;
}

function loadExpandedSet(host: string | undefined, root: string): Set<string> {
  try {
    const raw = localStorage.getItem(lsKeyFor(host, root));
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* corrupt/denied — start collapsed */ }
  return new Set();
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
  // Dirs currently showing CACHED rows that no fetch has confirmed yet. Only
  // consumed to decide what a failed refetch does: with cached rows on screen a
  // failure is a quiet note (below), never a wipe-and-error.
  const [stalePaths, setStalePaths] = useState<Set<string>>(new Set());
  const stalePathsRef = useRef(stalePaths);
  stalePathsRef.current = stalePaths;
  // "Showing the last known contents — couldn't reach the host." Muted, keeps rows.
  const [staleErrors, setStaleErrors] = useState<Map<string, string>>(new Map());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
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
  const lsOpenRootsKeyRef = useRef(lsOpenRootsKey(host, root));
  lsOpenRootsKeyRef.current = lsOpenRootsKey(host, root);

  // Mirror of loaded-dir keys + in-flight set, read inside callbacks/effects
  // without adding them as deps (avoids needless callback churn / stale resets).
  const childrenMapRef = useRef(childrenMap);
  childrenMapRef.current = childrenMap;
  const inFlightRef = useRef<Set<string>>(new Set());
  // Self-reference for the restore-expanded eager loads inside loadDir's body.
  const loadDirRef = useRef<((dirPath: string, opts?: { isRoot?: boolean; restoreExpanded?: boolean }) => Promise<void>) | null>(null);
  // Same self-reference, for the ONE batched restore loadDir's body kicks off.
  const loadDirsBatchRef = useRef<((dirPaths: string[]) => Promise<void>) | null>(null);
  // A restored selection awaiting existence-check against its parent listing —
  // a file deleted since the last visit must not leave a dead preview pane.
  const pendingValidateRef = useRef<string | null>(null);
  // Dirs a NETWORK listing has answered for since the last reset. `stalePaths`
  // can't answer this: the bulk prime marks every candidate it read, INCLUDING
  // dirs the fetch already beat it to (deliberately — the mark also picks "muted
  // note" over "red error" for a later failure), so a fresh dir can carry a stale
  // mark. The stale-selection pruner destroys persisted state, so it needs the
  // strict truth, not the conservative one.
  const freshDirsRef = useRef<Set<string>>(new Set());
  // Bumped on every full reset (cwd/host change). The cache prime is async, so
  // this is what stops one session's cached rows landing in another's tree.
  const resetGenRef = useRef(0);

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

  /** Fresh rows landed for these paths: drop the cached-guess mark and any
   *  "showing the last known contents" note. */
  const clearStale = useCallback((...paths: string[]) => {
    setStalePaths((prev) => {
      if (!paths.some((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      for (const p of paths) next.delete(p);
      return next;
    });
    setStaleErrors((prev) => {
      if (!paths.some((p) => prev.has(p))) return prev;
      const next = new Map(prev);
      for (const p of paths) next.delete(p);
      return next;
    });
  }, []);

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

    // ── Stale-while-revalidate ────────────────────────────────────────────────
    // Kick the cache read WITHOUT awaiting it, then fall straight through to the
    // fetch below. This ordering is the whole contract: the network call is
    // issued on this same synchronous run, so a slow, empty or broken cache read
    // can neither delay it nor replace it. The cached rows only ever land in a
    // dir the tree has nothing for, and only while the fetch has not answered.
    //   noCache (Refresh, post-mutation re-lists) skips the paint entirely.
    //   showHidden changes the CONTENT of a listing, so hidden mode skips the
    //   cache on BOTH sides rather than keying by the flag: the flag is per-mount
    //   state that always starts false, so the instant-paint path never runs in
    //   hidden mode and keying it would buy nothing — while a second key scope
    //   would double every invalidation and put a wrong-mode listing (hidden rows
    //   in a hidden-off tree) one mistake away from painting.
    let painted = false;
    let freshLanded = false;
    const cacheRead = (!noCache && !showHidden && !childrenMapRef.current.has(dirPath))
      ? getCachedDirList(host, dirPath).catch(() => null)
      : null;
    void cacheRead?.then((rec) => {
      if (freshLanded || !rec || rec.entries.length === 0) return;
      painted = true;
      setChildrenMap((prev) => (prev.has(dirPath) ? prev : new Map(prev).set(dirPath, rec.entries)));
      setStalePaths((prev) => (prev.has(dirPath) ? prev : new Set(prev).add(dirPath)));
    });

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
      freshLanded = true;
      freshDirsRef.current.add(dirPath);
      freshDirsRef.current.add(canonical);
      setChildrenMap((prev) => new Map(prev).set(canonical, res.entries));
      // Fresh rows are on screen: this dir is no longer a cached guess, and any
      // "couldn't reach the host" note from an earlier attempt is answered.
      clearStale(dirPath, canonical);
      // Persist for the next open. Writes on the noCache path too — a Refresh
      // must correct what a later panel-open will paint from, not bypass it.
      if (!showHidden) void setCachedDirList(host, canonical, res);
      // A stand-in listing gets a plain "couldn't find X" note, not an error.
      setNotFound(res.requestedPath ?? null);
      if (isRoot) {
        if (canonical !== root) setRoot(canonical);
        setRootError(null);
        if (restoreExpanded) {
          const restored = loadExpandedSet(host, canonical);
          setExpanded(restored);
          // ROOT-CAUSE fix for "refresh auto-closed my folders + first click is
          // dead": restoring `expanded` alone re-marks dirs as open, but their
          // children were never fetched, so nothing renders below them and the
          // first click merely flips the stale expanded bit (invisible). Eagerly
          // load every restored dir's children so the tree actually reopens.
          // NO `childrenMap.has` guard: the reset effect primes exactly these
          // paths from the cache, and skipping them here would turn an instant
          // paint into a tree that never refreshes.
          // ONE request for all of them — see loadDirsBatch for why a fetch per
          // directory made the whole app wait.
          void loadDirsBatchRef.current?.([...restored].slice(0, MAX_RESTORE_LOADS));
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
            // Fetch unless a FRESH listing already answered for this dir — the
            // validation below waits for one, so skipping the fetch because the
            // cache had painted rows would leave the question open forever (and
            // answering it FROM those cached rows is what deleted a live file's
            // remembered selection + history stop).
            if (dir !== canonical && !freshDirsRef.current.has(dir)) void loadDirRef.current?.(dir);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('file-explorer', 'failed to list dir', { dirPath, host, error: msg });
      // The cache read may still be in flight; the fetch has already failed, so
      // letting it finish costs nothing and can only turn an error pane into
      // usable rows. (Registered second, so its paint runs before this line.)
      if (cacheRead) await cacheRead;
      // A stale listing is far more useful than an error pane, so when rows are
      // on screen — from this call's paint OR from the reset effect's bulk prime
      // — the failure is a muted note beside them, not a replacement for them.
      if (painted || stalePathsRef.current.has(dirPath)) {
        setStaleErrors((prev) => new Map(prev).set(dirPath, msg));
      } else if (isRoot) setRootError(msg);
      else setErrorPaths((prev) => new Map(prev).set(dirPath, msg));
    } finally {
      inFlightRef.current.delete(dirPath);
      setLoadingPaths((prev) => { const next = new Set(prev); next.delete(dirPath); return next; });
    }
  }, [host, showHidden, root, cwd, sessionId, clearStale]);
  loadDirRef.current = loadDir;

  /** Refresh every remembered-expanded directory in ONE request.
   *
   *  This used to be a loop of loadDir calls, i.e. up to 64 parallel fetches on
   *  every panel open. A browser runs 6 connections per origin, so on a remote
   *  session (one SSH round trip per listing, ~1.4s cold) the restore held the
   *  whole pool and every other request in the app waited behind it — which is
   *  what "opening Files makes Walnut slow" actually was.
   *
   *  Deliberately narrower than loadDir: no cache paint (the reset effect already
   *  primes exactly these paths from one IndexedDB transaction), no root
   *  canonicalisation, and no self-healing. These paths come from the client's own
   *  persisted expand set, so a path that will not list means the directory is
   *  gone; resolving 64 of them would reintroduce the cost this removes. */
  const loadDirsBatch = useCallback(async (dirPaths: string[]): Promise<void> => {
    const wanted = dirPaths.filter((p) => !inFlightRef.current.has(p));
    if (!wanted.length) return;
    for (const p of wanted) inFlightRef.current.add(p);
    setLoadingPaths((prev) => { const next = new Set(prev); for (const p of wanted) next.add(p); return next; });
    try {
      const { listings, timedOut } = await fetchDirListMany(wanted, host, showHidden);
      const fresh = listings.filter((l): l is Extract<typeof l, { entries: DirEntry[] }> => !l.error);
      // One setState for the whole batch: 64 sequential map copies would be 64
      // renders of a tree whose rows are the expensive part.
      if (fresh.length) {
        setChildrenMap((prev) => {
          const next = new Map(prev);
          for (const l of fresh) next.set(l.path, l.entries);
          return next;
        });
      }
      for (const l of fresh) {
        freshDirsRef.current.add(l.path);
        clearStale(l.path);
        if (!showHidden) void setCachedDirList(host, l.path, l);
      }
      for (const l of listings) {
        if (!l.error) continue;
        // Same rule as loadDir: with rows already on screen a failure is a note
        // beside them, never a replacement for them.
        if (stalePathsRef.current.has(l.path)) setStaleErrors((prev) => new Map(prev).set(l.path, l.error));
        else setErrorPaths((prev) => new Map(prev).set(l.path, l.error));
      }
      if (timedOut) {
        log.info('file-explorer', 'tree restore answered partially', { host, asked: wanted.length, got: fresh.length });
      }
    } catch (err) {
      // The batch is a correction on top of the cache paint, so a total failure
      // leaves the tree exactly as the cache drew it rather than erroring over it.
      log.warn('file-explorer', 'batch dir restore failed', {
        host, count: wanted.length, error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      for (const p of wanted) inFlightRef.current.delete(p);
      setLoadingPaths((prev) => { const next = new Set(prev); for (const p of wanted) next.delete(p); return next; });
    }
  }, [host, showHidden, clearStale]);
  loadDirsBatchRef.current = loadDirsBatch;

  // Full reset + load root only when the session (cwd/host) changes — NOT when
  // showHidden flips (that's handled below without nuking expand/selection state).
  // loadDir is intentionally omitted: it changes with showHidden, which must not reset.
  useEffect(() => {
    const gen = ++resetGenRef.current;
    const initialRoot = cwd || '~';
    setRoot(initialRoot);
    setChildrenMap(new Map());
    // Dropping the rows drops their freshness: whatever repaints these dirs next
    // may well be the cache.
    freshDirsRef.current = new Set();
    setErrorPaths(new Map());
    setStalePaths(new Set());
    setStaleErrors(new Map());
    setSelectedFile(null);
    setFocusedDir(null);
    pendingValidateRef.current = null;
    // Which dirs were open last time is ALREADY on disk in localStorage, so it
    // needs no await — which is what makes an instant reconstruction possible.
    // loadDir re-reads it under the canonical root and wins on any disagreement.
    const restored = loadExpandedSet(host, initialRoot);
    setExpanded(restored);
    setOpenRoots(new Set([initialRoot])); // cwd section open; re-keyed on canonicalization below
    // Paint the whole previously-visible tree from ONE IndexedDB transaction.
    // Only the root and the RESTORED-expanded paths, never everything cached:
    // a dir the user collapsed left the persisted set, so it can't be resurrected.
    if (!showHidden) {
      const wanted = [initialRoot, ...[...restored].slice(0, MAX_RESTORE_LOADS)];
      void getCachedDirListsBulk(host, wanted).then((cached) => {
        // A newer reset (different session) owns the tree now — its rows are not ours.
        if (resetGenRef.current !== gen || cached.size === 0) return;
        const paintable = [...cached.keys()].filter((p) => cached.get(p)!.entries.length > 0);
        if (paintable.length === 0) return;
        // "Already loaded?" is decided INSIDE the updater, against the map React
        // actually holds — childrenMapRef out here still points at the render
        // before this effect's clear, so it is not an authority yet.
        setChildrenMap((prev) => {
          let next = prev;
          for (const p of paintable) {
            // Never clobber: the fetch may already have answered for this dir.
            if (next.has(p)) continue;
            if (next === prev) next = new Map(prev);
            next.set(p, cached.get(p)!.entries);
          }
          return next;
        });
        // Deliberately marks every candidate, including one the fetch just beat us
        // to: the mark only chooses "muted note" over "red error" on a LATER
        // failure, and with real rows on screen that is the better of the two.
        setStalePaths((prev) => {
          const next = new Set(prev);
          for (const p of paintable) next.add(p);
          return next;
        });
      });
    }
    // Unconditional and NOT gated on the prime: the cache is a prefill, the fetch
    // is the answer. Every restored dir gets refetched from inside this call.
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
  //
  // Gated on a FRESH listing (judgeRestoredSelection). This effect runs on every
  // childrenMap change, which includes the bulk cache prime and loadDir's cached
  // paint — and a cached listing that predates the file said "not there", so the
  // pruner used to clear the remembered file and drop its history stop, both
  // PERSISTED, for a file that exists. `pendingValidateRef` stays armed until real
  // rows land so the fresh answer is the one that decides.
  useEffect(() => {
    const pending = pendingValidateRef.current;
    if (!pending) return;
    const dir = parentPath(pending);
    const verdict = judgeRestoredSelection({
      path: pending,
      entries: childrenMap.get(dir),
      parentIsFresh: freshDirsRef.current.has(dir),
    });
    if (verdict === 'wait') return;
    pendingValidateRef.current = null;
    if (verdict === 'keep') return;
    setSelectedFile((cur) => (cur === pending ? null : cur));
    saveSelectedFile(host, scopeRef.current, null);
    const pruned = removeFromFileHistory(historyRef.current, pending);
    if (pruned !== historyRef.current) {
      historyRef.current = pruned;
      setHistory(pruned);
      saveFileHistory(host, scopeRef.current, pruned);
    }
    // childrenMap is the trigger: every fresh listing installs a NEW map, so this
    // re-runs the moment real rows for the pending file's dir land.
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
    // A cwd deep inside a monorepo labels as just its folder name ("templates"),
    // which identifies nothing. When a known repo root CONTAINS the cwd (deepest
    // wins — a submodule is more specific than its superproject), prefix the
    // header with the repo: "repo/…/templates". Full path stays on hover.
    const container = changedRoots
      .filter((r) => rootNorm.startsWith(`${r.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    let prefix: string | undefined;
    if (container) {
      const repoName = lastSegment(container.path);
      const isDirectChild = !rootNorm.slice(container.path.length + 1).includes('/');
      prefix = isDirectChild ? repoName : `${repoName}/…`;
    }
    const cwdSection: RootSection = {
      path: root, label: lastSegment(root), prefix, kind: 'cwd', fileCount: cwdChanged?.fileCount,
    };
    const rest = changedRoots.filter((r) => r.path !== rootNorm);
    return [cwdSection, ...rest];
  }, [root, changedRoots]);

  // Which paths are SECTION HEADERS: they open via `openRoots`, and they can't be
  // renamed/deleted (the mutation hook needs both facts).
  const rootPaths = useMemo(() => new Set(rootSections.map((s) => s.path)), [rootSections]);
  const rootPathsRef = useRef(rootPaths);
  rootPathsRef.current = rootPaths;

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
      freshDirsRef.current = new Set();
      setStalePaths(new Set());
      setStaleErrors(new Map());
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
    freshDirsRef.current = new Set();
    setStalePaths(new Set());
    setStaleErrors(new Map());
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
  // Files with unsaved edits parked in the draft store (survives closing the pane).
  const draftPaths = useFileDraftPaths(host);
  // Hovering a file row reads it ahead of the click, into the same content cache
  // the viewer paints from.
  const prefetch = useFileContentPrefetch(host);
  const [ctxMenu, setCtxMenu] = useState<FileTreeContextTarget | null>(null);

  const openContextMenu = useCallback((
    e: React.MouseEvent,
    node: { path: string; type: 'dir' | 'file'; isRoot?: boolean; relativeRoot?: string },
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const point = { x: e.clientX, y: e.clientY };
    // Open immediately (a right-click must never feel laggy); the vault-note
    // check is async (notesDir fetch) and patches "Open in Notes" in when it
    // resolves — for the same target only, so a fast re-click can't cross-fill.
    setCtxMenu({ point, path: node.path, type: node.type, isRoot: node.isRoot, relativeRoot: node.relativeRoot });
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

  // ── File mutations (create / rename / duplicate / delete) ─────────────────
  // All the API calls + tree-state repair live in the hook; this component only
  // renders `editing` as a row and hands the menu its callbacks.
  // A renamed/deleted DIRECTORY invalidates more than its parent's listing: its
  // own persisted record and every descendant's still point at a path that no
  // longer exists, and re-listing the parent can't see any of them. The mutation
  // hook reports the affected dir paths; dropping the subtree is our business.
  const forgetCachedSubtrees = useCallback((paths: string[]) => {
    for (const p of paths) void deleteCachedDirListsUnder(host, p);
  }, [host]);

  const {
    editing, editError, pendingNotice, startCreate, startRename, cancelEdit, commitEdit, duplicate, remove,
  } = useFileTreeMutations({
    host, loadDir, childrenMapRef, rootPathsRef, selectedFileRef, scopeRef, historyRef,
    lsExpandedKeyRef: lsKeyRef, lsOpenRootsKeyRef,
    setExpanded, setChildrenMap, setOpenRoots, setHistory, commitSelection, selectFile,
    onDirPathsChanged: forgetCachedSubtrees,
  });

  // WHERE the edit row renders. A dir can be visible in more than one open root
  // section (a changed-repo section overlapping the cwd tree), and rendering the
  // input in each of them would put two focused inputs on screen — so the first
  // section that shows the target wins, and a target that is only a section
  // HEADER (its children are rows, it is not) renders above its children.
  const editTarget = editing ? (editing.kind === 'rename' ? editing.path : editing.parentDir) : null;
  const editAnchor = useMemo<{ rootPath: string; asRow: boolean } | null>(() => {
    if (!editTarget) return null;
    for (const s of rootSections) {
      if (!openRoots.has(s.path)) continue;
      if (rowsByRoot.get(s.path)?.some((n) => n.path === editTarget)) {
        return { rootPath: s.path, asRow: true };
      }
    }
    const section = rootSections.find((s) => s.path === editTarget);
    return section ? { rootPath: section.path, asRow: false } : null;
  }, [editTarget, rootSections, rowsByRoot, openRoots]);

  const renderEditRow = useCallback((depth: number) => {
    if (!editing) return null;
    const currentName = editing.kind === 'rename' ? lastSegment(editing.path) : '';
    // Rename preselects the STEM (VS Code): typing replaces the name and keeps
    // the extension. Dirs and dotfiles have no stem to isolate — select it all.
    const dot = currentName.lastIndexOf('.');
    const stemLength = editing.kind === 'rename' && editing.type === 'file' && dot > 0
      ? dot
      : undefined;
    return (
      <FileTreeEditRow
        // Keyed on the edit identity: switching New File → New Folder (or to a
        // different target) must REMOUNT, or the input keeps the old typed value
        // and never re-runs its focus/select effect.
        key={`${editing.kind}:${editTarget ?? ''}`}
        kind={editing.kind}
        depth={depth}
        initialValue={currentName}
        entryType={editing.kind === 'rename' ? editing.type : undefined}
        stemLength={stemLength}
        error={editError}
        onCommit={(name) => { void commitEdit(name); }}
        onCancel={cancelEdit}
      />
    );
  }, [editing, editTarget, editError, commitEdit, cancelEdit]);

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
        <div
          className="session-file-explorer-tree"
          style={{ width: `${treeWidth}px` }}
          // Empty background: every row handler stopPropagations, so anything
          // reaching here is the blank space — right-clicking it targets the tree
          // ROOT, which is what makes "New File… at the cwd" reachable with no row.
          onContextMenu={(e) => openContextMenu(e, { path: root, type: 'dir', isRoot: true, relativeRoot: root })}
        >
          {rootError && <div className="sfe-error">{rootError}</div>}
          {/* A delete/duplicate the server answered 202 for: still running on the
              host. Muted, not red — nothing failed, the tree re-lists on its own. */}
          {pendingNotice && (
            <div className="sfe-notice sfe-notice-pending" role="status">{pendingNotice}</div>
          )}
          {/* Cached rows are on screen and the refetch failed. Muted, not red, and
              NOT in place of the tree: a listing from two minutes ago is far more
              useful than an error pane where the files used to be. */}
          {staleErrors.has(root) && (
            <div className="sfe-notice" title={staleErrors.get(root)}>
              Showing the last known contents — the refresh didn't get through.
            </div>
          )}
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
            const editRowHere = !!editAnchor && !editAnchor.asRow && editAnchor.rootPath === section.path;
            return (
              <div key={section.path} className="sfe-root-section">
                <div
                  className={`session-file-explorer-node sfe-root-header${section.kind === 'changed' ? ' sfe-root-changed' : ''}`}
                  onClick={() => toggleRoot(section.path)}
                  onContextMenu={(e) => openContextMenu(e, {
                    path: section.path, type: 'dir', isRoot: true, relativeRoot: section.path,
                  })}
                  title={section.path}
                >
                  <span className="sfe-arrow">{isRootLoading ? '…' : isOpen ? '▼' : '▶'}</span>
                  <span className="sfe-icon">{section.kind === 'cwd' ? '🏠' : '📦'}</span>
                  <span className={`sfe-name${section.prefix ? ' sfe-name-ctx' : ''}`}>
                    {section.prefix && <span className="sfe-name-prefix">{section.prefix}/</span>}
                    <span className="sfe-name-base">{section.label}</span>
                  </span>
                  {section.fileCount != null && section.fileCount > 0 && (
                    <span className="sfe-size sfe-changed-badge">{section.fileCount} changed</span>
                  )}
                </div>
                {/* A create straight into this root: first row under the header. */}
                {isOpen && editRowHere && renderEditRow(1)}
                {isOpen && !rootError && isRootLoading && rows.length === 0 && (
                  <div className="sfe-loading" style={{ paddingLeft: '22px' }}>Loading…</div>
                )}
                {isOpen && childrenMap.has(section.path) && rows.length === 0 && !editRowHere && (
                  <div className="sfe-empty" style={{ paddingLeft: '22px' }}>Empty directory</div>
                )}
                {isOpen && rows.map((node) => {
                  const isExpanded = expanded.has(node.path);
                  const isSelected = node.type === 'file' && selectedFile === node.path;
                  const isLoading = loadingPaths.has(node.path);
                  const err = errorPaths.get(node.path);
                  // Mutually exclusive with `err`: loadDir's catch picks one.
                  const staleNote = staleErrors.get(node.path);
                  const anchored = !!editAnchor && editAnchor.asRow && editAnchor.rootPath === section.path;
                  const isRenaming = anchored && editing?.kind === 'rename' && editing.path === node.path;
                  const createsHere = anchored && !!editing && editing.kind !== 'rename'
                    && editing.parentDir === node.path;
                  return (
                    <div key={node.path}>
                      {isRenaming ? renderEditRow(node.depth) : (
                      <div
                        className={`session-file-explorer-node${isSelected ? ' selected' : ''}`}
                        style={{ paddingLeft: `${8 + node.depth * 14}px` }}
                        onClick={() => {
                          if (node.type === 'dir') toggleDir(node);
                          // Remember the file being read so reopening the panel resumes here.
                          else selectFile(node.path);
                        }}
                        onContextMenu={(e) => openContextMenu(e, { ...node, relativeRoot: section.path })}
                        // Resting on a file row is the earliest signal it is about
                        // to be opened; the read finishes before the click lands.
                        // Bounded in useFileContentPrefetch (dwell, one in flight,
                        // raw kinds and big files skipped, once per path).
                        onMouseEnter={node.type === 'file'
                          ? () => prefetch.hover(node.path, node.size)
                          : undefined}
                        onMouseLeave={node.type === 'file' ? prefetch.cancel : undefined}
                        title={node.path}
                      >
                        <span className="sfe-arrow">
                          {node.type === 'dir' ? (isLoading ? '…' : isExpanded ? '▼' : '▶') : ''}
                        </span>
                        <span className="sfe-icon">{node.type === 'dir' ? '📁' : '📄'}</span>
                        <span className="sfe-name">{node.name}</span>
                        {/* Unsaved edits live in the draft store, not in this pane, so a
                            file can hold work while its editor is closed — the dot is the
                            only way to find it again. */}
                        {node.type === 'file' && draftPaths.has(node.path) && (
                          <span className="sfe-draft-dot" title="Unsaved changes">●</span>
                        )}
                        {/* size is local-only — daemon fs.ls returns just {name,type} for remote */}
                        {node.type === 'file' && node.size != null && (
                          <span className="sfe-size">{formatSize(node.size)}</span>
                        )}
                      </div>
                      )}
                      {/* A create INTO this dir: first row under it, one level deeper. */}
                      {createsHere && renderEditRow(node.depth + 1)}
                      {err && (
                        <div className="sfe-error" style={{ paddingLeft: `${8 + (node.depth + 1) * 14}px` }}>{err}</div>
                      )}
                      {staleNote && isExpanded && (
                        <div
                          className="sfe-notice"
                          style={{ paddingLeft: `${8 + (node.depth + 1) * 14}px` }}
                          title={staleNote}
                        >
                          Showing the last known contents.
                        </div>
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
              // Live Edit uses it to hear this session's agent writing the open
              // file (session:tool-use/result) and pull those bytes in.
              sessionId={sessionId}
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
          onNewFile={(dir) => startCreate(dir, 'create-file')}
          onNewFolder={(dir) => startCreate(dir, 'create-dir')}
          onRename={(p) => startRename(p, ctxMenu.type)}
          onDuplicate={(p) => { void duplicate(p, ctxMenu.type); }}
          onDelete={(p, t) => { void remove(p, t); }}
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
