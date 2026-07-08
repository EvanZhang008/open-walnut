import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNotesTree } from '@/hooks/useNotesTree';
import { useNoteContent } from '@/hooks/useNoteContent';
import { useFavorites } from '@/hooks/useFavorites';
import { NotesTreePanel } from '@/components/notes/NotesTreePanel';
import { NotesEditorPanel } from '@/components/notes/NotesEditorPanel';
import { NotesTabStrip, type OpenTab, type TabKind } from '@/components/notes/NotesTabStrip';
import { AttachmentPreview } from '@/components/notes/AttachmentPreview';
import { NotesChat } from '@/components/notes/NotesChat';
import { CommandPalette, pushRecent } from '@/components/notes/CommandPalette';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ICON_EXPAND } from '@/components/common/Icons';
import { openPopout } from '@/popout/openPopout';
import { saveNoteContent } from '@/api/notes-v2';
import { log } from '@/utils/log';

const LS_WIDTH_KEY = 'open-walnut-notes-tree-width';
const LS_TABS_KEY = 'open-walnut-notes-tabs';
const LS_CHAT_OPEN_KEY = 'open-walnut-notes-chat-open';
const WIDTH_MIN = 220;
const WIDTH_MAX = 500;
const WIDTH_DEFAULT = 280;

function clampWidth(w: number): number {
  return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, w));
}

function readWidth(): number {
  try {
    const stored = localStorage.getItem(LS_WIDTH_KEY);
    if (stored) return clampWidth(Number(stored));
  } catch { /* ignore */ }
  return WIDTH_DEFAULT;
}

interface PersistedTabs {
  tabs: OpenTab[];
  activePath: string | null;
}

/** A localStorage entry is a valid tab iff it's `{ path: string, kind: 'note'|'attachment' }`. */
function isValidTab(t: unknown): t is OpenTab {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return typeof o.path === 'string' && (o.kind === 'note' || o.kind === 'attachment');
}

/**
 * Hydrate the open-tabs workspace on first mount (§1.4):
 *   - Always restore the persisted `{tabs, activePath}` workspace from localStorage.
 *   - A `?path=` / `?attachment=` URL param (deep link / refresh / pop-out) then
 *     wins the ACTIVE slot — appended as a tab if not already open.
 * The URL must NOT replace the whole workspace: the page itself mirrors the
 * active tab into `?path=`, so a plain refresh always carries one — treating it
 * as a sole-tab deep link silently dropped every other open tab on reload.
 */
function hydrateTabs(searchParams: URLSearchParams): PersistedTabs {
  const urlAttachment = searchParams.get('attachment');
  const urlPath = searchParams.get('path');
  const urlTab: OpenTab | null = urlAttachment
    ? { path: urlAttachment, kind: 'attachment' }
    : urlPath
      ? { path: urlPath, kind: 'note' }
      : null;

  let tabs: OpenTab[] = [];
  let activePath: string | null = null;
  try {
    const raw = localStorage.getItem(LS_TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedTabs>;
      tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isValidTab) : [];
      const wanted = typeof parsed.activePath === 'string' ? parsed.activePath : null;
      activePath = tabs.some((t) => t.path === wanted) ? wanted : (tabs[0]?.path ?? null);
    }
  } catch { /* malformed / disabled storage — start from the URL tab alone */ }

  if (urlTab) {
    if (!tabs.some((t) => t.path === urlTab.path)) tabs = [...tabs, urlTab];
    activePath = urlTab.path;
  }
  return { tabs, activePath };
}

export function NotesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { tree, loading: treeLoading, error: treeError, refresh: refreshTree, addFolder, removeNote, renameNote } = useNotesTree();
  const { favoriteNotes, toggleFavoriteNote, isNoteFavorite } = useFavorites();

  // ── Open-tabs model (replaces the old single selectedPath + attachmentPath) ──
  const initial = useRef<PersistedTabs | null>(null);
  if (initial.current === null) initial.current = hydrateTabs(searchParams);
  const [tabs, setTabs] = useState<OpenTab[]>(initial.current.tabs);
  const [activePath, setActivePath] = useState<string | null>(initial.current.activePath);

  // Reveal-in-tree target + nonce (locate button, auto-locate on tab switch,
  // breadcrumb folder click). Bumping the nonce re-fires the tree's reveal effect
  // even for the same path. See NotesTreePanel.revealPath/revealNonce.
  const [reveal, setReveal] = useState<{ path: string; nonce: number }>({ path: '', nonce: 0 });
  const revealInTree = useCallback((path: string) => {
    setReveal((r) => ({ path, nonce: r.nonce + 1 }));
  }, []);

  // Collapsible AI assistant column (#6), persisted. Default hidden.
  const [chatOpen, setChatOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_CHAT_OPEN_KEY) === '1'; } catch { return false; }
  });
  const toggleChat = useCallback(() => {
    setChatOpen((v) => {
      const next = !v;
      try { localStorage.setItem(LS_CHAT_OPEN_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const activeTab = useMemo(() => tabs.find((t) => t.path === activePath) ?? null, [tabs, activePath]);
  // useNoteContent only ever sees a NOTE path; attachment tabs (and "no tab") → null
  // so the markdown editor never loads a binary file and the hook clears.
  const activeNotePath = activeTab?.kind === 'note' ? activeTab.path : null;

  const {
    content,
    loading: contentLoading,
    updatedAt,
    saveStatus,
    onEditorUpdate,
    pendingExternal,
    applyExternalChange,
    dismissExternalChange,
    markMovedAway,
  } = useNoteContent(activeNotePath);

  // ── Persist {tabs, activePath} (mirrors the tree-width persistence) ──
  useEffect(() => {
    try {
      localStorage.setItem(LS_TABS_KEY, JSON.stringify({ tabs, activePath }));
    } catch { /* ignore quota / disabled storage */ }
  }, [tabs, activePath]);

  // ── Auto-locate (#2): whenever the active tab changes, reveal it in the tree
  //    (expand its folders + scroll into view). Only for note/attachment paths. ──
  useEffect(() => {
    if (activePath) revealInTree(activePath);
  }, [activePath, revealInTree]);

  // ── URL sync: mirror the active tab into ?path= / ?attachment= (replace, never push) ──
  useEffect(() => {
    if (!activeTab) {
      // Only clear if a notes param is present (avoid clobbering unrelated params).
      if (searchParams.get('path') || searchParams.get('attachment')) {
        setSearchParams({}, { replace: true });
      }
      return;
    }
    const next: Record<string, string> =
      activeTab.kind === 'attachment' ? { attachment: activeTab.path } : { path: activeTab.path };
    setSearchParams(next, { replace: true });
  // setSearchParams is stable; intentionally exclude searchParams to avoid a sync loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // ── Single source of truth for opening a path (§1.3). All programmatic opens
  //    (tree click, Cmd+K, bookmark click, create, rename follow) funnel here. ──
  const openInTab = useCallback((path: string, kind: TabKind, opts?: { newTab?: boolean }) => {
    setTabs((prev) => {
      const existingIdx = prev.findIndex((t) => t.path === path);
      // Already open → activate it (ignore newTab; never duplicate).
      if (existingIdx !== -1) return prev;
      const tab: OpenTab = { path, kind };
      if (opts?.newTab && prev.length > 0) {
        // Insert after the active tab so a ⌘-click lands adjacent to its origin.
        const activeIdx = prev.findIndex((t) => t.path === activePath);
        const at = activeIdx === -1 ? prev.length : activeIdx + 1;
        return [...prev.slice(0, at), tab, ...prev.slice(at)];
      }
      // Replace the active tab in place (Obsidian single-click default), or create the first tab.
      const activeIdx = prev.findIndex((t) => t.path === activePath);
      if (activeIdx === -1) return [...prev, tab];
      const next = [...prev];
      next[activeIdx] = tab;
      return next;
    });
    setActivePath(path);
    if (kind === 'note') pushRecent(path);
  }, [activePath]);

  // Thin wrappers preserve the existing prop names consumed by tree / palette /
  // backlinks / wiki-link clicks — they all open in the ACTIVE tab by default.
  const handleSelect = useCallback((path: string, opts?: { newTab?: boolean }) => openInTab(path, 'note', opts), [openInTab]);
  const handlePreviewAttachment = useCallback((path: string) => openInTab(path, 'attachment'), [openInTab]);

  const handleActivateTab = useCallback((path: string) => { setActivePath(path); }, []);

  const handleCloseTab = useCallback((path: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.path !== path);
      // If we closed the active tab, activate the right neighbor, else the left,
      // else null (empty state). Closing a non-active tab leaves active untouched.
      setActivePath((cur) => {
        if (cur !== path) return cur;
        if (next.length === 0) return null;
        const neighbor = next[idx] ?? next[idx - 1] ?? next[0];
        return neighbor ? neighbor.path : null;
      });
      return next;
    });
  }, []);

  // '+' → a fresh place to pick/create a note: clear the active tab (shows the
  // empty state) and open the Cmd+K quick-switcher (§1.3 "New / empty").
  const handleNewTab = useCallback(() => {
    setActivePath(null);
    // Defer so the empty state renders before the palette steals focus.
    setTimeout(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    }, 0);
  }, []);

  // Resizable left pane
  const [listWidth, setListWidth] = useState(readWidth);
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const listPaneRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = listWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    listPaneRef.current?.classList.add('resizing');

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = clampWidth(startWidthRef.current + (ev.clientX - startXRef.current));
      setListWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      listPaneRef.current?.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [listWidth]);

  useEffect(() => {
    try { localStorage.setItem(LS_WIDTH_KEY, String(listWidth)); } catch { /* ignore */ }
  }, [listWidth]);

  const handleCreateNote = useCallback(
    async (notePath: string) => {
      // Just open the path — the editor will create it on first save.
      handleSelect(notePath);
      await refreshTree();
    },
    [handleSelect, refreshTree],
  );

  /**
   * Quick-capture create used by the Cmd+K palette and the /notes empty-state
   * CTA. An empty `title` means a blank/untitled note (⌘↵ — 0 required
   * decisions): we mint a sensible default name. We persist an empty file
   * immediately (mirrors the tree-panel create path) so the new note exists on
   * disk + in the tree, then open it. The BE stamps the frontmatter `id` on this
   * first write (§2 identity contract).
   */
  const handleQuickCreate = useCallback(
    async (title: string) => {
      const trimmed = title.trim();
      // Sanitize a title into a flat vault filename (no path traversal / slashes).
      const safe = trimmed
        .replace(/[\\/]+/g, '-')
        .replace(/[<>:"|?* -]/g, '')
        .trim();
      const base = safe || `Untitled ${new Date().toISOString().slice(0, 10)} ${Date.now().toString(36)}`;
      const notePath = `${base}.md`;
      try {
        await saveNoteContent(notePath, '');
      } catch (err) {
        // A 409/exists or transient error still lets us open the path (the editor
        // loads existing content). Log and continue rather than dropping capture.
        log.warn('notes', 'Quick-capture create failed (opening anyway)', {
          notePath, error: err instanceof Error ? err.message : String(err),
        });
      }
      await refreshTree();
      handleSelect(notePath);
    },
    [refreshTree, handleSelect],
  );

  // Deleted note open in a tab → drop every matching tab (§1.6). Neighbor rule
  // matches close: if the deleted tab was active, activate a neighbor / empty.
  const handleDeleteNote = useCallback(
    async (notePath: string) => {
      await removeNote(notePath);
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === notePath);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.path !== notePath);
        setActivePath((cur) => {
          if (cur !== notePath) return cur;
          if (next.length === 0) return null;
          const neighbor = next[idx] ?? next[idx - 1] ?? next[0];
          return neighbor ? neighbor.path : null;
        });
        return next;
      });
    },
    [removeNote],
  );

  // Renamed/moved note open in a tab → rewrite its path IN PLACE (preserve
  // position + active state) so flush-on-switch isn't triggered spuriously (§1.6).
  const handleRenameNote = useCallback(
    async (from: string, to: string) => {
      // If the note being moved is the one open in the editor, flush its pending
      // edits to the OLD path AND mark it moved-away FIRST. Otherwise the
      // post-rename path change (or a tiptap re-emit) fires a stale
      // `saveNoteContent(oldPath)` that re-creates the just-renamed file at its
      // old location → the drag-to-move duplication bug (one note became 3
      // divergent copies). See useNoteContent.markMovedAway.
      if (from === activeNotePath) {
        await markMovedAway(from);
      }
      await renameNote(from, to);
      setTabs((prev) => prev.map((t) => (t.path === from ? { ...t, path: to } : t)));
      setActivePath((cur) => (cur === from ? to : cur));
    },
    [renameNote, activeNotePath, markMovedAway],
  );

  if (treeLoading) return <LoadingSpinner />;
  if (treeError) return <div className="empty-state"><p>Error: {treeError}</p></div>;

  return (
    <div className="notes-split-view">
      <div
        className="notes-tree-pane"
        ref={listPaneRef}
        style={{ width: listWidth, flex: `0 0 ${listWidth}px` }}
      >
        <NotesTreePanel
          tree={tree}
          selectedPath={activePath}
          onSelect={handleSelect}
          onPreviewAttachment={handlePreviewAttachment}
          onCreateNote={handleCreateNote}
          onCreateFolder={addFolder}
          onDeleteNote={handleDeleteNote}
          onRenameNote={handleRenameNote}
          onRefresh={refreshTree}
          favoriteNotes={favoriteNotes}
          onToggleFavorite={toggleFavoriteNote}
          revealPath={reveal.path}
          revealNonce={reveal.nonce}
        />
      </div>
      <div className="notes-resize-handle" onMouseDown={handleResizeStart} />
      <div className="notes-editor-pane">
        <button
          className={`notes-ai-toggle${chatOpen ? ' active' : ''}`}
          onClick={toggleChat}
          aria-pressed={chatOpen}
          title={chatOpen ? 'Hide Note Assistant' : 'Ask the Note Assistant'}
        >
          <SparkleIcon />
          <span>AI</span>
        </button>
        {tabs.length > 0 && (
          <NotesTabStrip
            tabs={tabs}
            activePath={activePath}
            onActivate={handleActivateTab}
            onClose={handleCloseTab}
            onNewTab={handleNewTab}
          />
        )}
        <div className="notes-editor-body">
          {activeTab?.kind === 'attachment' ? (
            <AttachmentPreview notePath={activeTab.path} />
          ) : !activeNotePath ? (
            <NotesEmptyState onNewNote={() => handleQuickCreate('')} />
          ) : contentLoading ? (
            <LoadingSpinner />
          ) : (
            // position:relative so the floating pop-out button anchors to the
            // editor pane's top-right (NotesEditorPanel owns its own header, so we
            // overlay rather than editing that cross-owned component).
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <button
                className="global-notes-expand-btn"
                style={{
                  position: 'absolute', top: 9, right: 16, zIndex: 5,
                  background: 'var(--bg)', border: '1px solid var(--border)',
                  display: 'inline-flex', alignItems: 'center', padding: 5,
                }}
                onClick={() => openPopout('note', { path: activeNotePath })}
                aria-label="Open note in a new window"
                title="Open in new window"
              >
                {ICON_EXPAND}
              </button>
              <NotesEditorPanel
                notePath={activeNotePath}
                content={content}
                updatedAt={updatedAt}
                saveStatus={saveStatus}
                onEditorUpdate={onEditorUpdate}
                onNavigate={handleSelect}
                onLocate={() => revealInTree(activeNotePath)}
                onBreadcrumbNavigate={revealInTree}
                pendingExternal={pendingExternal}
                onApplyExternal={applyExternalChange}
                onDismissExternal={dismissExternalChange}
                isFavorite={isNoteFavorite(activeNotePath)}
                onToggleFavorite={() => toggleFavoriteNote(activeNotePath)}
              />
            </div>
          )}
        </div>
      </div>
      {chatOpen && (
        <>
          <div className="notes-chat-divider" />
          <div className="notes-chat-pane">
            <NotesChat activeNotePath={activeNotePath} />
          </div>
        </>
      )}

      {/*
        Cmd+K global front door (P0, §4.3). Mounted here on the notes-owned
        NotesPage with its own window keydown listener — no MainPage/App.tsx
        edit. Scope caveat: the shortcut is active only while /notes is mounted
        (reported in sharedFileTouches). Cmd+K jump opens in a NEW tab (or
        activates the existing one).
      */}
      <CommandPalette onNavigate={(p) => handleSelect(p, { newTab: true })} onCreate={handleQuickCreate} />
    </div>
  );
}

/**
 * Newcomer on-ramp (§3.6½): the /notes empty state shown when no note is
 * selected. One visible "New note" CTA (0 required decisions) + a one-line
 * hint + the Cmd+K discoverability nudge. This is the P0 capture floor that
 * guarantees time-to-first-note without the full palette.
 */
function NotesEmptyState({ onNewNote }: { onNewNote: () => void }) {
  return (
    <div className="notes-empty-state">
      <div className="notes-empty-state-content">
        <h2 className="notes-empty-state-title">Your notes</h2>
        <p className="notes-empty-state-hint">
          Type to capture; search finds it later. Press <kbd>⌘K</kbd> to jump to a note or search.
        </p>
        <button className="notes-empty-state-cta" onClick={onNewNote}>
          + New note
        </button>
      </div>
    </div>
  );
}

/** Sparkle glyph for the AI assistant toggle. */
function SparkleIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
      <path d="M8 1.5l1.2 3.1L12.5 6 9.2 7.4 8 10.5 6.8 7.4 3.5 6l3.3-1.4L8 1.5z" />
      <path d="M12.5 9.5l.6 1.5 1.6.7-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.7.6-1.5z" opacity="0.7" />
    </svg>
  );
}
