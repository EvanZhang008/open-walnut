import { useState, useCallback, useRef, useEffect, useMemo, memo } from 'react';
import { searchNotesHybrid, saveNoteContent, revealNote } from '@/api/notes-v2';
import type { NoteTreeNode, SearchResult, SearchFolderGroup } from '@/api/notes-v2';
import { NotesBookmarksGroup } from './NotesBookmarksGroup';
import { NotesRecentGroup, RECENT_GROUP_KEY } from './NotesRecentGroup';
import { HighlightedText, HighlightedTitle } from './HighlightedText';
import { useConfirm, useAlert } from '@/hooks/useConfirm';
import { copyTextDeferred } from '@/utils/clipboard';

/**
 * Folder expand/collapse persistence (Feature 3). The expanded-folders set is
 * mirrored to localStorage on every toggle and hydrated on mount. Stale paths
 * (folders that no longer exist) are kept verbatim — they simply never match a
 * render, so they're harmless and survive a temporary move/rename.
 *
 * The same set doubles as the Recent group's collapse store via the RECENT_GROUP_KEY
 * sentinel (Feature 4): present in the set ⇒ Recent group is COLLAPSED. Folders use
 * the opposite convention (present ⇒ expanded), so the sentinel is treated specially.
 */
const LS_EXPANDED_KEY = 'open-walnut-notes-expanded';

/**
 * Keystroke debounce before the first (string-only) search fires. 300ms read as
 * laggy on a leg that answers in ~40ms; 120ms is below the ~150ms threshold where
 * a UI stops feeling reactive, while still collapsing a fast typist's burst into
 * one request.
 */
const SEARCH_DEBOUNCE_MS = 120;

function readExpandedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_EXPANDED_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
    }
  } catch { /* malformed / disabled storage — start fresh */ }
  return new Set();
}

/** Collect every note (non-attachment file) path in the tree — used to skip stale recents. */
function collectNotePaths(nodes: NoteTreeNode[], acc: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.type === 'folder') {
      if (n.children) collectNotePaths(n.children, acc);
    } else if (n.kind !== 'attachment') {
      acc.add(n.path);
    }
  }
  return acc;
}

/**
 * path → file node for every file in the tree. The Bookmarks / Recent / search
 * rows only carry a PATH, so this is how a right-click on one of them recovers
 * the real node (name + note-vs-attachment kind) the context menu needs.
 */
function collectFileNodes(nodes: NoteTreeNode[], acc: Map<string, NoteTreeNode> = new Map()): Map<string, NoteTreeNode> {
  for (const n of nodes) {
    if (n.type === 'folder') {
      if (n.children) collectFileNodes(n.children, acc);
    } else {
      acc.set(n.path, n);
    }
  }
  return acc;
}

/** Every file path (notes AND attachments) — used for the move name-collision guard. */
function collectFilePaths(nodes: NoteTreeNode[], acc: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.type === 'folder') {
      if (n.children) collectFilePaths(n.children, acc);
    } else {
      acc.add(n.path);
    }
  }
  return acc;
}

interface NotesTreePanelProps {
  tree: NoteTreeNode[];
  selectedPath: string | null;
  /**
   * Open a note. `opts.newTab` (⌘-click / context-menu) opens it in a new tab;
   * `opts.scrollToText` (search-result click) scrolls the editor to the first
   * occurrence of the matched text instead of landing at the top.
   */
  onSelect: (path: string, opts?: { newTab?: boolean; scrollToText?: string }) => void;
  /** Preview an attachment (image/pdf) — distinct from onSelect, which markdown-loads. */
  onPreviewAttachment: (path: string) => void;
  onCreateNote: (path: string) => void;
  onCreateFolder: (path: string) => void;
  onDeleteNote: (path: string) => void;
  /** Recursively delete a folder (notes + attachments). Gated behind a danger confirm. */
  onDeleteFolder: (path: string) => void | Promise<void>;
  /** Delete a binary attachment (png/pdf/docx/…). */
  onDeleteAttachment: (path: string) => void | Promise<void>;
  onRenameNote: (from: string, to: string) => void | Promise<void>;
  onRefresh: () => void;
  /** Vault-relative paths (WITH .md) of bookmarked notes — drives the Bookmarks group. */
  favoriteNotes: string[];
  /** Toggle a note's bookmark (used by the inline un-bookmark affordance). */
  onToggleFavorite: (path: string) => void;
  /**
   * Reveal-in-tree target (locate button / auto-locate on tab switch / breadcrumb
   * click). When `revealNonce` changes, every ancestor folder of `revealPath` is
   * expanded and the node is scrolled into view. The nonce lets the SAME path be
   * re-revealed (a plain path-equality effect wouldn't re-fire).
   */
  revealPath?: string | null;
  revealNonce?: number;
  /**
   * Start a REAL Claude Code session (full MCP/skills config) in the chat
   * column, opened on the clicked note/folder (undefined = vault root).
   */
  onStartSession?: (targetPath?: string) => void;
  /**
   * Start a NEW Walnut Agent (note-agent) chat in the chat column, named after
   * the clicked note/folder — a fresh conversation, deletable from the switcher.
   */
  onStartAgentChat?: (targetPath?: string) => void;
}

/** Cumulative folder prefixes of a vault path: `a/b/c.md` → ['a', 'a/b', 'a/b/c.md']. */
function ancestorFolderPaths(p: string): string[] {
  const segs = p.split('/');
  const out: string[] = [];
  for (let i = 1; i <= segs.length; i++) out.push(segs.slice(0, i).join('/'));
  return out;
}

/**
 * memo()'d: NotesPage re-renders on every saveStatus tick while typing
 * (saving→saved→idle). The tree's props are referentially stable across those
 * ticks, so memoization keeps the whole left pane out of that render loop —
 * part of the "page flashes while typing" fix.
 */
export const NotesTreePanel = memo(function NotesTreePanel({
  tree,
  selectedPath,
  onSelect,
  onPreviewAttachment,
  onCreateNote,
  onCreateFolder,
  onDeleteNote,
  onDeleteFolder,
  onDeleteAttachment,
  onRenameNote,
  onRefresh,
  favoriteNotes,
  onToggleFavorite,
  revealPath,
  revealNonce,
  onStartSession,
  onStartAgentChat,
}: NotesTreePanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  // Folders whose NAME matched the query — rendered ABOVE the note rows so a
  // query like "dairy" answers with the Dairy/ folder, not 30 date-named notes.
  const [searchFolders, setSearchFolders] = useState<SearchFolderGroup[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(readExpandedFolders);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [newItemType, setNewItemType] = useState<'file' | 'folder'>('file');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: NoteTreeNode } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Drag-to-move (#5): the path being dragged + the current drop-target folder
  // ('' = vault root). Backend POST /api/notes-v2/move preserves id + backlinks.
  // draggingPathRef mirrors the state so drag handlers read the source
  // SYNCHRONOUSLY — React state hasn't always flushed by the time dragover/drop
  // fire, which made drops silently no-op / land on the wrong target. State is
  // kept only to drive the dragging/drop-target visual classes.
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const draggingPathRef = useRef<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const alert = useAlert();

  // Reveal-in-tree: expand every ancestor folder of revealPath, then scroll the
  // node into view. Re-fires whenever revealNonce changes (so the locate button
  // works even on the already-selected note). `revealPath` may be a folder
  // (breadcrumb click) or a note (locate button / tab switch).
  useEffect(() => {
    if (!revealPath) return;
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      // Expand all prefixes EXCEPT the leaf itself when it's a FILE (its parent
      // folders must open, but a .md/attachment leaf isn't a folder — adding it
      // would persist junk paths in the expanded set). For a folder target we
      // expand it too so its children show.
      const prefixes = ancestorFolderPaths(revealPath);
      const isFile = /\.[A-Za-z0-9]+$/.test(revealPath);
      for (const p of prefixes) {
        if (isFile && p === revealPath) continue;
        next.add(p);
      }
      return next;
    });
    // Defer scroll until the newly-expanded rows have rendered.
    const t = setTimeout(() => {
      const el = bodyRef.current?.querySelector(
        `[data-node-path="${(window as unknown as { CSS?: typeof CSS }).CSS?.escape ? CSS.escape(revealPath) : revealPath}"]`,
      ) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest' });
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealPath, revealNonce]);

  // Feature 3: persist the expanded-folders set (+ Recent collapse sentinel) on change.
  useEffect(() => {
    try { localStorage.setItem(LS_EXPANDED_KEY, JSON.stringify([...expandedFolders])); } catch { /* ignore */ }
  }, [expandedFolders]);

  // Feature 4: note paths present in the current tree (skip stale recents).
  const existingNotePaths = useMemo(() => collectNotePaths(tree), [tree]);
  // All files (incl. attachments) — the drag-move collision guard must see both.
  const existingFilePaths = useMemo(() => collectFilePaths(tree), [tree]);
  // path → node, so a path-only row (Bookmarks / Recent / search hit) can open
  // the SAME context menu the tree rows do.
  const fileNodeByPath = useMemo(() => collectFileNodes(tree), [tree]);
  // Recent group is COLLAPSED iff the sentinel is in the expanded-folders set.
  const recentExpanded = !expandedFolders.has(RECENT_GROUP_KEY);
  const toggleRecent = useCallback(() => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(RECENT_GROUP_KEY)) next.delete(RECENT_GROUP_KEY);
      else next.add(RECENT_GROUP_KEY);
      return next;
    });
  }, []);

  // Focus input when creating
  useEffect(() => {
    if (creatingIn !== null && newItemInputRef.current) {
      newItemInputRef.current.focus();
    }
  }, [creatingIn]);

  useEffect(() => {
    if (renaming !== null && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  // Clamp the context menu into the viewport. A right-click near the bottom
  // edge rendered the menu's tail (incl. Delete) off-screen and unclickable —
  // measure after render and shift up/left as needed.
  useEffect(() => {
    if (!contextMenu) return;
    const el = contextMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const overBottom = rect.bottom - window.innerHeight + 8;
    const overRight = rect.right - window.innerWidth + 8;
    if (overBottom > 0 || overRight > 0) {
      setContextMenu((cm) => {
        if (!cm) return cm;
        const y = overBottom > 0 ? Math.max(8, cm.y - overBottom) : cm.y;
        const x = overRight > 0 ? Math.max(8, cm.x - overRight) : cm.x;
        // Fixed point: a menu taller than the viewport pins at 8 and can't be
        // clamped further — returning the SAME object stops the effect re-firing
        // (else this loops forever on very short windows).
        if (x === cm.x && y === cm.y) return cm;
        return { ...cm, x, y };
      });
    }
  }, [contextMenu]);

  // Cleanup search debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  // Search handler — TWO-STAGE so the list feels instant.
  //
  // Stage 1 (`mode=string`) is pure local SQLite FTS/LIKE/folder matching: ~20-60ms,
  // no embedding, no model. It renders at SEARCH_DEBOUNCE_MS so results appear
  // while you're still typing.
  // Stage 2 (`mode=hybrid`) adds the semantic leg and REPLACES stage 1 when it
  // lands. It's the slower leg (embedding + vector lookup), so it must never gate
  // first paint — that ordering is the whole point.
  //
  // Previous results stay rendered during a refetch (we only set state on
  // response) so typing never collapses the list to a flash of "No results". The
  // seq guard drops out-of-order responses so a slow older query can't overwrite
  // a newer one, and each keystroke aborts the previous stage-2 request so the
  // server isn't doing embedding work for text the user already replaced.
  const searchSeqRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;

    if (!value.trim()) {
      searchSeqRef.current++; // invalidate any in-flight search
      setSearchResults(null);
      setSearchFolders([]);
      return;
    }

    const seq = ++searchSeqRef.current;
    searchTimerRef.current = setTimeout(() => {
      const q = value.trim();
      const ac = new AbortController();
      searchAbortRef.current = ac;
      const fresh = () => seq === searchSeqRef.current;

      // Stage 1 — instant, string-only.
      searchNotesHybrid(q, { mode: 'string', signal: ac.signal })
        .then((p) => {
          if (!fresh()) return;
          setSearchResults(p.results);
          setSearchFolders(p.folders ?? []);
        })
        .catch(() => { if (fresh()) setSearchResults([]); });

      // Stage 2 — semantic upgrade, merged in when it arrives.
      searchNotesHybrid(q, { mode: 'hybrid', signal: ac.signal })
        .then((p) => {
          if (!fresh()) return;
          setSearchResults(p.results);
          setSearchFolders(p.folders ?? []);
        })
        .catch(() => { /* stage 1 already rendered — a semantic failure is not fatal */ });
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleNewItem = useCallback((parentPath: string | null, type: 'file' | 'folder') => {
    setCreatingIn(parentPath ?? '');
    setNewItemType(type);
    setNewItemName('');
    // Expand parent folder
    if (parentPath) {
      setExpandedFolders(prev => new Set(prev).add(parentPath));
    }
  }, []);

  const handleConfirmNewItem = useCallback(async () => {
    const name = newItemName.trim();
    if (!name) { setCreatingIn(null); return; }

    const parentPath = creatingIn || '';
    const fullPath = parentPath ? `${parentPath}/${name}` : name;

    try {
      if (newItemType === 'folder') {
        await onCreateFolder(fullPath);
      } else {
        const notePath = fullPath.endsWith('.md') ? fullPath : `${fullPath}.md`;
        await saveNoteContent(notePath, '');
        onRefresh();
        onCreateNote(notePath);
      }
    } catch { /* silently fail, tree will refresh */ }
    setCreatingIn(null);
    setNewItemName('');
  }, [newItemName, creatingIn, newItemType, onCreateFolder, onCreateNote, onRefresh]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: NoteTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  /**
   * Right-click on a row that only knows a PATH: the Bookmarks group, the Recent
   * group, and search hits. Without this they fell through to the BROWSER's own
   * menu (Look Up / Translate / Services in the Mac app) — the whole tree offers
   * Walnut's menu, so these must too. The real node is preferred so the menu
   * shows note-vs-attachment actions; a synthesized one keeps a row whose file
   * left the tree from regressing to the native menu.
   */
  const handlePathContextMenu = useCallback((e: React.MouseEvent, p: string) => {
    const node: NoteTreeNode = fileNodeByPath.get(p) ?? {
      name: p.split('/').pop() ?? p,
      path: p,
      type: 'file',
      kind: p.toLowerCase().endsWith('.md') ? 'note' : 'attachment',
    };
    handleContextMenu(e, node);
  }, [fileNodeByPath, handleContextMenu]);

  const handleStartRename = useCallback((node: NoteTreeNode) => {
    setRenaming(node.path);
    setRenameValue(node.name.replace(/\.md$/, ''));
    setContextMenu(null);
  }, []);

  const handleConfirmRename = useCallback(async () => {
    if (!renaming || !renameValue.trim()) { setRenaming(null); return; }

    const dir = renaming.includes('/') ? renaming.substring(0, renaming.lastIndexOf('/')) : '';
    const oldName = renaming;
    const newName = renameValue.trim();
    const newPath = dir ? `${dir}/${newName}.md` : `${newName}.md`;

    if (newPath !== oldName) {
      await onRenameNote(oldName, newPath);
    }
    setRenaming(null);
  }, [renaming, renameValue, onRenameNote]);

  const handleDeleteFromMenu = useCallback(async () => {
    if (!contextMenu) return;
    const { node } = contextMenu;
    setContextMenu(null);

    if (node.type === 'folder') {
      // Recursive delete — spell out exactly how much is going away.
      const files = collectFilePaths(node.children ?? []);
      const notes = collectNotePaths(node.children ?? []);
      const attachments = files.size - notes.size;
      const parts = [
        notes.size ? `${notes.size} ${notes.size === 1 ? 'note' : 'notes'}` : '',
        attachments ? `${attachments} ${attachments === 1 ? 'attachment' : 'attachments'}` : '',
      ].filter(Boolean).join(' and ');
      const ok = await confirm({
        title: `Delete folder “${node.name}”?`,
        message: parts
          ? `This permanently deletes the folder and everything inside it (${parts}). This cannot be undone.`
          : 'This permanently deletes the folder and everything inside it. This cannot be undone.',
        confirmLabel: 'Delete folder',
        danger: true,
      });
      if (!ok) return;
      try {
        await onDeleteFolder(node.path);
      } catch (e) {
        await alert({ title: 'Delete failed', message: e instanceof Error ? e.message : 'Could not delete the folder.' });
      }
      return;
    }

    if (!(await confirm({ title: `Delete “${node.name}”?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      if (node.kind === 'attachment') await onDeleteAttachment(node.path);
      else await onDeleteNote(node.path);
    } catch (e) {
      await alert({ title: 'Delete failed', message: e instanceof Error ? e.message : 'Could not delete the file.' });
    }
  }, [contextMenu, onDeleteNote, onDeleteFolder, onDeleteAttachment, confirm, alert]);

  // Local-machine actions (context menu): Finder / default app / VS Code /
  // Copy path. Failures (cloud mode 400, clipboard denial) surface via alert —
  // a swallowed rejection reads as "the menu item did nothing".
  const handleReveal = useCallback((p: string, mode: 'finder' | 'app' | 'vscode') => {
    setContextMenu(null);
    revealNote(p, mode).catch(() => {
      void alert({ title: 'Not available', message: 'Opening local files only works on the local console.' });
    });
  }, [alert]);

  // Copy path: the text is only known AFTER a network round-trip, which is
  // exactly the case a plain navigator.clipboard.writeText cannot survive —
  // Safari/WKWebView (the Mac app) voids the click's user-activation while the
  // resolve is in flight and rejects the write ("Copy failed" on every use).
  // copyTextDeferred hands the clipboard a promise minted INSIDE the gesture and
  // falls back to the app's NSPasteboard bridge / execCommand, so it must be
  // called synchronously here — never awaited first.
  const handleCopyPath = useCallback((p: string) => {
    setContextMenu(null);
    copyTextDeferred(revealNote(p, 'path')).then(
      (result) => {
        if (result !== 'failed') return;
        void alert({ title: 'Copy failed', message: 'Could not copy the path to the clipboard.' });
      },
      () => {
        // The resolve itself failed (cloud mode 400s, file gone).
        void alert({ title: 'Copy failed', message: 'Could not resolve the file path on this machine.' });
      },
    );
  }, [alert]);

  // ── Drag-to-move (#5) ──
  // The dragged source is held in a ref (read synchronously by dragover/drop)
  // AND state (drives visuals). Drop targets are resolved from the DOM via the
  // nearest `[data-drop-folder]` ancestor of the event target, NOT from
  // per-row handlers — so a drop anywhere inside an EXPANDED folder (its child
  // rows / blank child area) resolves to THAT folder instead of bubbling up to
  // the root drop zone (the old bug that sent files to the vault root).
  const handleDragStart = useCallback((e: React.DragEvent, path: string) => {
    e.stopPropagation();
    draggingPathRef.current = path;
    setDraggingPath(path);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', path); } catch { /* some browsers restrict */ }
  }, []);

  const handleDragEnd = useCallback(() => {
    draggingPathRef.current = null;
    setDraggingPath(null);
    setDropTarget(null);
  }, []);

  // True if moving `src` into `destFolder` is a no-op or illegal: same dir,
  // onto itself, or into its own subtree (folder dragged into a descendant).
  const isInvalidDrop = useCallback((src: string | null, destFolder: string): boolean => {
    if (src == null) return true;
    const srcDir = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : '';
    if (srcDir === destFolder) return true;                 // same dir — no-op
    if (destFolder === src) return true;                    // onto itself
    if (destFolder.startsWith(src + '/')) return true;      // into own descendant
    return false;
  }, []);

  // Resolve the drop FOLDER for a drag event from the DOM: walk up from the
  // event target to the nearest element carrying `data-drop-folder`. Returns
  // '' (vault root) when none is found (the blank tree body). This single
  // resolver is the whole fix for "drops land on root / no indicator on open
  // folders" — the innermost folder wins, children included.
  const resolveDropFolder = useCallback((e: React.DragEvent): string => {
    const start = e.target as HTMLElement | null;
    const host = (start?.closest?.('[data-drop-folder]') as HTMLElement | null) ?? null;
    return host?.getAttribute('data-drop-folder') ?? '';
  }, []);

  const handleTreeDragOver = useCallback((e: React.DragEvent) => {
    const src = draggingPathRef.current;
    if (src == null) return;
    e.preventDefault();
    const dest = resolveDropFolder(e);
    e.dataTransfer.dropEffect = isInvalidDrop(src, dest) ? 'none' : 'move';
    // Highlight the resolved folder ('' = root). Only update when it actually
    // changes so moving the cursor within one folder doesn't thrash the class.
    setDropTarget((prev) => (prev === dest ? prev : dest));
  }, [resolveDropFolder, isInvalidDrop]);

  const performMove = useCallback(async (src: string, destFolder: string) => {
    const base = src.split('/').pop() as string;
    const to = destFolder ? `${destFolder}/${base}` : base;
    if (to === src) return;
    // Guard a name collision before hitting the backend (move endpoint 4xx's on
    // an existing destination, which would otherwise fail silently). Attachments
    // collide too, so check ALL files, not just notes.
    if (existingFilePaths.has(to)) {
      await alert({ title: 'Already exists', message: `A file named “${base}” already exists in that folder.` });
      return;
    }
    try {
      // → NotesPage.handleRenameNote → moveNote (preserves id/backlinks)
      await onRenameNote(src, to);
    } catch (e) {
      // Surface the failure — a silently-swallowed rejection made failed drags
      // look like the drop just didn't register (user-reported confusion).
      await alert({ title: 'Move failed', message: e instanceof Error ? e.message : 'Could not move the file.' });
    }
  }, [onRenameNote, existingFilePaths, alert]);

  // Single drop handler for the whole tree (delegated). Resolves the target
  // folder from the DOM so it's correct regardless of which row/area received
  // the event.
  const handleTreeDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const src = draggingPathRef.current;
    const dest = resolveDropFolder(e);
    draggingPathRef.current = null;
    setDraggingPath(null);
    setDropTarget(null);
    if (src == null || isInvalidDrop(src, dest)) return;
    void performMove(src, dest);
  }, [resolveDropFolder, isInvalidDrop, performMove]);

  // Render tree node recursively
  const renderNode = (node: NoteTreeNode, depth: number = 0) => {
    const isExpanded = expandedFolders.has(node.path);
    const isSelected = selectedPath === node.path;
    const isRenaming = renaming === node.path;

    if (node.type === 'folder') {
      // `data-drop-folder` on the WRAPPER (row + children) is what makes a drop
      // anywhere inside this folder — including its expanded child area —
      // resolve to THIS folder via resolveDropFolder, instead of bubbling to the
      // root drop zone. The highlight is driven by dropTarget matching this path.
      const isDropTarget = dropTarget === node.path && !isInvalidDrop(draggingPath, node.path);
      return (
        <div key={node.path} data-drop-folder={node.path} className={isDropTarget ? 'notes-tree-folder-drop' : undefined}>
          <div
            className={`notes-tree-item notes-tree-folder depth-${depth}${isDropTarget ? ' notes-tree-drop-target' : ''}`}
            data-node-path={node.path}
            onClick={() => toggleFolder(node.path)}
            onContextMenu={(e) => handleContextMenu(e, node)}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
          >
            <span className={`notes-tree-arrow ${isExpanded ? 'expanded' : ''}`}>
              <ChevronIcon />
            </span>
            <FolderIcon />
            <span className="notes-tree-name">{node.name}</span>
          </div>
          {isExpanded && node.children && (
            <div className="notes-tree-children">
              {creatingIn === node.path && renderNewItemInput(depth + 1)}
              {node.children.map(child => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    // Attachments (image/pdf): preview on click, keep the extension in the label,
    // distinct icon, and no inline markdown-rename input.
    const isAttachment = node.kind === 'attachment';
    if (isAttachment) {
      return (
        <div
          key={node.path}
          className={`notes-tree-item notes-tree-file notes-tree-attachment depth-${depth} ${isSelected ? 'selected' : ''}${draggingPath === node.path ? ' notes-tree-dragging' : ''}`}
          data-node-path={node.path}
          draggable
          onDragStart={(e) => handleDragStart(e, node.path)}
          onDragEnd={handleDragEnd}
          onClick={() => onPreviewAttachment(node.path)}
          onContextMenu={(e) => handleContextMenu(e, node)}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <AttachmentIcon name={node.name} />
          <span className="notes-tree-name">{node.name}</span>
        </div>
      );
    }

    return (
      <div
        key={node.path}
        className={`notes-tree-item notes-tree-file depth-${depth} ${isSelected ? 'selected' : ''}${draggingPath === node.path ? ' notes-tree-dragging' : ''}`}
        data-node-path={node.path}
        draggable={!isRenaming}
        onDragStart={(e) => handleDragStart(e, node.path)}
        onDragEnd={handleDragEnd}
        // ⌘/Ctrl-click opens in a NEW tab (Obsidian/browser convention).
        onClick={(e) => !isRenaming && onSelect(node.path, { newTab: e.metaKey || e.ctrlKey })}
        onContextMenu={(e) => handleContextMenu(e, node)}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        <FileIcon />
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="notes-tree-inline-input"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleConfirmRename();
              if (e.key === 'Escape') setRenaming(null);
            }}
            onBlur={handleConfirmRename}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="notes-tree-name">{node.name.replace(/\.md$/, '')}</span>
        )}
      </div>
    );
  };

  const renderNewItemInput = (depth: number) => (
    <div
      className={`notes-tree-item notes-tree-new-item depth-${depth}`}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
    >
      {newItemType === 'folder' ? <FolderIcon /> : <FileIcon />}
      <input
        ref={newItemInputRef}
        className="notes-tree-inline-input"
        placeholder={newItemType === 'folder' ? 'folder name' : 'note name'}
        value={newItemName}
        onChange={e => setNewItemName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') handleConfirmNewItem();
          if (e.key === 'Escape') setCreatingIn(null);
        }}
        onBlur={handleConfirmNewItem}
      />
    </div>
  );

  return (
    <div className="notes-tree-panel">
      <div className="notes-tree-header">
        <h3>Notes</h3>
        <div className="notes-tree-actions">
          <button
            className="notes-tree-action-btn"
            onClick={() => handleNewItem(null, 'file')}
            title="New Note"
          >
            <PlusFileIcon />
          </button>
          <button
            className="notes-tree-action-btn"
            onClick={() => handleNewItem(null, 'folder')}
            title="New Folder"
          >
            <PlusFolderIcon />
          </button>
        </div>
      </div>

      <div className="notes-tree-search">
        <input
          type="text"
          placeholder="Search notes..."
          value={searchQuery}
          onChange={e => handleSearchChange(e.target.value)}
          className="notes-search-input"
        />
      </div>

      {/* Bookmarks group (§2.6) — collapsible, at the TOP of the tree. Hidden while
          searching (search owns the body) and when there are no favorited notes. */}
      {!searchResults && (
        <NotesBookmarksGroup
          favoriteNotes={favoriteNotes}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onToggleFavorite={onToggleFavorite}
          onContextMenu={handlePathContextMenu}
        />
      )}

      {/* Recent group (Feature 4) — collapsible, directly UNDER Bookmarks. Reads the
          shared Cmd+K recents store; hidden while searching and when empty. */}
      {!searchResults && (
        <NotesRecentGroup
          existingPaths={existingNotePaths}
          selectedPath={selectedPath}
          onSelect={onSelect}
          expanded={recentExpanded}
          onToggle={toggleRecent}
          onContextMenu={handlePathContextMenu}
        />
      )}

      <div
        className={`notes-tree-body${dropTarget === '' && draggingPath && !isInvalidDrop(draggingPath, '') ? ' notes-tree-drop-root' : ''}`}
        ref={bodyRef}
        // ONE delegated drag surface for the whole tree. resolveDropFolder walks
        // up from the event target to the nearest [data-drop-folder]; a drop in
        // blank space (no such ancestor) resolves to '' = vault root. This is why
        // dropping inside an expanded folder no longer falls through to root.
        onDragOver={handleTreeDragOver}
        onDrop={handleTreeDrop}
      >
        {searchResults ? (
          <div className="notes-search-results">
            {/* Matching FOLDERS first. Clicking one exits search and reveals the
                folder expanded in the tree — the natural answer to "where do my
                dairy notes live?". Path shown so two same-named folders differ. */}
            {searchFolders.map(f => (
              <div
                key={`folder:${f.path}`}
                className="notes-tree-item notes-tree-folder notes-search-folder"
                onContextMenu={(e) => handleContextMenu(e, { name: f.name, path: f.path, type: 'folder' })}
                onClick={() => {
                  setSearchQuery('');
                  setSearchResults(null);
                  setSearchFolders([]);
                  setExpandedFolders(prev => {
                    const next = new Set(prev);
                    for (const p of ancestorFolderPaths(f.path)) next.add(p);
                    return next;
                  });
                  // Defer so the newly-expanded rows exist before we scroll.
                  setTimeout(() => {
                    bodyRef.current
                      ?.querySelector(`[data-node-path="${CSS.escape(f.path)}"]`)
                      ?.scrollIntoView({ block: 'nearest' });
                  }, 60);
                }}
                title={f.path}
              >
                <FolderIcon />
                <div className="notes-search-result-content">
                  <span className="notes-tree-name">
                    <HighlightedTitle text={f.name} query={searchQuery} />
                  </span>
                  <span className="notes-search-snippet">
                    {f.path}
                    {' · '}
                    {f.noteCount} {f.noteCount === 1 ? 'note' : 'notes'}
                  </span>
                </div>
              </div>
            ))}
            {searchResults.length === 0 && searchFolders.length === 0 ? (
              <div className="notes-tree-empty">No results</div>
            ) : (
              searchResults.map(r => (
                <div
                  key={r.path}
                  className={`notes-tree-item notes-tree-file notes-search-result ${selectedPath === r.path ? 'selected' : ''}`}
                  onContextMenu={(e) => handlePathContextMenu(e, r.path)}
                  onClick={() => {
                    // Attachment hits (OCR/PDF text) open in the preview pane —
                    // the note loader .md-suffixes the path and 404s on binaries.
                    if (r.matchType === 'attachment') onPreviewAttachment(r.path);
                    else {
                      // Jump to the MATCH, not the top of the note: the snippet's
                      // <mark> holds the exact matched span (falls back to the raw
                      // query for semantic hits, which carry no mark).
                      const m = r.snippet?.match(/<mark>([^<]{1,80})<\/mark>/);
                      onSelect(r.path, { scrollToText: m?.[1] || searchQuery.trim() });
                    }
                    setSearchQuery('');
                    setSearchResults(null);
                  }}
                >
                  <FileIcon />
                  <div className="notes-search-result-content">
                    <span className="notes-tree-name">
                      {/* Server highlights snippets only — titles get a client-side first-match mark. */}
                      <HighlightedTitle
                        text={r.title || r.name || r.path.split('/').pop()?.replace(/\.md$/, '') || ''}
                        query={searchQuery}
                      />
                    </span>
                    {/* WHERE the note lives — without this, same-named notes in
                        different folders are indistinguishable in the result list. */}
                    {r.path.includes('/') && (
                      <span className="notes-search-path" title={r.path}>
                        {r.path.slice(0, r.path.lastIndexOf('/'))}
                      </span>
                    )}
                    <span className="notes-search-snippet">
                      {/* Snippet carries literal <mark> tags from the server — render real marks, never raw HTML. */}
                      <HighlightedText text={r.snippet} />
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <>
            {creatingIn === '' && renderNewItemInput(0)}
            {tree.length === 0 ? (
              <div className="notes-tree-empty">
                No notes yet. Click + to create one.
              </div>
            ) : (
              tree.map(node => renderNode(node, 0))
            )}
          </>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="notes-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.node.type === 'folder' && (
            <>
              <button onClick={() => { handleNewItem(contextMenu.node.path, 'file'); setContextMenu(null); }}>
                New Note
              </button>
              <button onClick={() => { handleNewItem(contextMenu.node.path, 'folder'); setContextMenu(null); }}>
                New Folder
              </button>
            </>
          )}
          {/* Notes get Open-in-new-tab + bookmark toggle + Rename. Rename stays
              note-only because the rename route speaks the .md-suffix convention,
              which binary files don't; Delete has dedicated routes per node type. */}
          {contextMenu.node.type === 'file' && contextMenu.node.kind !== 'attachment' && (
            <>
              <button onClick={() => { const p = contextMenu.node.path; setContextMenu(null); onSelect(p, { newTab: true }); }}>
                Open in new tab
              </button>
              <button onClick={() => { const p = contextMenu.node.path; setContextMenu(null); onToggleFavorite(p); }}>
                {favoriteNotes.includes(contextMenu.node.path) ? 'Remove bookmark' : 'Bookmark'}
              </button>
              <button onClick={() => handleStartRename(contextMenu.node)}>Rename</button>
            </>
          )}
          {/* Attachments (docx/xlsx/pdf/…): open with the OS default app (Word/Excel). */}
          {contextMenu.node.kind === 'attachment' && (
            <button onClick={() => handleReveal(contextMenu.node.path, 'app')}>Open in default app</button>
          )}
          {/* Chat-column launchers — a fresh Walnut Agent conversation, or a
              real Claude Code session (full MCP/skills config), opened on this
              note/folder. Both land as named entries in the pane's switcher. */}
          {onStartAgentChat && contextMenu.node.kind !== 'attachment' && (
            <button onClick={() => { const p = contextMenu.node.path; setContextMenu(null); onStartAgentChat(p); }}>
              New Note Agent chat
            </button>
          )}
          {onStartSession && contextMenu.node.kind !== 'attachment' && (
            <button onClick={() => { const p = contextMenu.node.path; setContextMenu(null); onStartSession(p); }}>
              Start Claude Code session
            </button>
          )}
          {/* Local-machine actions — every node type (file, folder, attachment). */}
          <button onClick={() => handleReveal(contextMenu.node.path, 'finder')}>Reveal in Finder</button>
          <button onClick={() => handleCopyPath(contextMenu.node.path)}>Copy path</button>
          <button onClick={() => handleReveal(contextMenu.node.path, 'vscode')}>Open in VS Code</button>
          {/* Delete — every node type. Notes/attachments get a plain confirm; folders a
              recursive-delete confirm with the contained note/attachment count. */}
          <button className="danger" onClick={handleDeleteFromMenu}>
            {contextMenu.node.type === 'folder' ? 'Delete folder' : 'Delete'}
          </button>
        </div>
      )}
    </div>
  );
});

// ─── Inline SVG Icons ────────────────────────────────────────────────────

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" className="notes-tree-icon">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" className="notes-tree-icon">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/** Icon for an attachment node — image glyph for pictures, document glyph for PDF/Office. */
function AttachmentIcon({ name }: { name: string }) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'pdf') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" className="notes-tree-icon notes-tree-icon-attachment">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <path d="M9 15h1.5a1.5 1.5 0 0 0 0-3H9v4M14 12v4M14 12h2M14 14h1.5" strokeWidth="1.4" />
      </svg>
    );
  }
  if (['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'].includes(ext)) {
    // Office document glyph — file outline with text lines.
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" className="notes-tree-icon notes-tree-icon-attachment">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" strokeWidth="1.4" />
        <line x1="8" y1="17" x2="13" y2="17" strokeWidth="1.4" />
      </svg>
    );
  }
  // Image glyph (png/jpg/jpeg/gif/webp).
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" className="notes-tree-icon notes-tree-icon-attachment">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

function PlusFileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function PlusFolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}
