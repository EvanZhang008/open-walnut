import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNotesTree } from '@/hooks/useNotesTree';
import { useNoteContent } from '@/hooks/useNoteContent';
import { useFavorites } from '@/hooks/useFavorites';
import { NotesTreePanel } from '@/components/notes/NotesTreePanel';
import { NotesEditorPanel } from '@/components/notes/NotesEditorPanel';
import { NotesTabStrip, type OpenTab, type TabKind } from '@/components/notes/NotesTabStrip';
import { AttachmentPreview } from '@/components/notes/AttachmentPreview';
import { NotesChat, NOTE_AGENT_ID } from '@/components/notes/NotesChat';
import { NotesChatSwitcher } from '@/components/notes/NotesChatSwitcher';
import { useConversations } from '@/hooks/useConversations';
import { NotesSessionChat } from '@/components/notes/NotesSessionChat';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import { CommandPalette, pushRecent } from '@/components/notes/CommandPalette';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ICON_EXPAND } from '@/components/common/Icons';
import { openPopout } from '@/popout/openPopout';
import { saveNoteContent } from '@/api/notes-v2';
import { quickStartSession, fetchSession } from '@/api/sessions';
import { fetchNotesDir } from '@/api/config';
import { log } from '@/utils/log';

const LS_WIDTH_KEY = 'open-walnut-notes-tree-width';
const LS_TABS_KEY = 'open-walnut-notes-tabs';
const LS_CHAT_OPEN_KEY = 'open-walnut-notes-chat-open';
// Persisted CC tab set: JSON array of {key,label,taskId?,sessionId?} (older
// formats — single {taskId,sessionId} object or a plain sid — still migrate).
const LS_CC_SESSION_KEY = 'open-walnut-notes-cc-session';
const LS_CC_MODE_KEY = 'open-walnut-notes-chat-mode';
const WIDTH_MIN = 220;
const WIDTH_MAX = 500;
const WIDTH_DEFAULT = 280;

function clampWidth(w: number): number {
  return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, w));
}

// Chat column (right pane) drag-resize bounds. Wide max — the full
// SessionPanel benefits from real estate on big screens.
const LS_CHAT_WIDTH_KEY = 'open-walnut-notes-chat-width';
const CHAT_WIDTH_MIN = 320;
const CHAT_WIDTH_MAX = 900;
const CHAT_WIDTH_DEFAULT = 420;

function clampChatWidth(w: number): number {
  if (!Number.isFinite(w)) return CHAT_WIDTH_DEFAULT;
  return Math.max(CHAT_WIDTH_MIN, Math.min(CHAT_WIDTH_MAX, w));
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

/** One Claude Code session tab in the chat column. */
interface CcTab {
  /** Stable identity for tab switching/persistence (`cc-<launch ts>`). */
  key: string;
  /** Display name — the note/folder the session was started from. */
  label: string;
  /** Vault-relative folder of the origin ('' = vault root) — disambiguates
   *  same-named notes and answers "which folder is this session in?". */
  folder?: string;
  taskId?: string;
  sessionId?: string;
  /** In-flight quick-start failure (shown inside the tab, not persisted). */
  error?: string;
}

/** Tab label from the right-clicked target: basename without .md; vault root → "Notes". */
function ccTabLabel(targetPath?: string): string {
  if (!targetPath) return 'Notes';
  const base = targetPath.split('/').pop() || targetPath;
  return base.replace(/\.md$/, '') || 'Notes';
}

/** Vault-relative folder of the origin. A folder target IS its own context;
 *  for a note it's the containing dir. Root → 'Notes' (the vault itself). */
function ccTabFolder(targetPath?: string): string {
  if (!targetPath) return 'Notes';
  if (!targetPath.endsWith('.md')) return targetPath; // folder target
  const idx = targetPath.lastIndexOf('/');
  return idx === -1 ? 'Notes' : targetPath.slice(0, idx);
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

  // ── Claude Code sessions hosted in the chat column (multi-tab) ──
  // REAL CLI sessions (full MCP/skills config) started from the tree's context
  // menu — one TAB PER SESSION, labeled after the note/folder it was started
  // from, so earlier sessions stay reachable instead of being replaced.
  // Tab lifecycle: `{key,label}` = pane open, HTTP in flight (INSTANT — set
  // synchronously in the click handler) → `taskId` = quick-start accepted,
  // linking → `sessionId` = live, rendered with the REAL <SessionPanel>.
  //
  // PERSISTENCE: the whole tab set + the active tab survive reloads as JSON —
  // each session sticks until its tab is explicitly closed (or the record is
  // genuinely gone/archived). A refresh mid-launch (taskId only) resumes the
  // pending resolution instead of losing the session.
  const [ccTabs, setCcTabs] = useState<CcTab[]>(() => {
    try {
      const raw = localStorage.getItem(LS_CC_SESSION_KEY);
      if (!raw) return [];
      if (raw.startsWith('[')) {
        const list = JSON.parse(raw) as CcTab[];
        return list.filter((t) => t && t.key && (t.taskId || t.sessionId));
      }
      // Legacy single-session formats: {taskId,sessionId} JSON or a plain sid.
      if (raw.startsWith('{')) {
        const p = JSON.parse(raw) as { taskId?: string; sessionId?: string };
        return (p.taskId || p.sessionId) ? [{ key: 'cc-legacy', label: 'Claude Code', taskId: p.taskId, sessionId: p.sessionId }] : [];
      }
      return [{ key: 'cc-legacy', label: 'Claude Code', sessionId: raw }];
    } catch { return []; }
  });
  // 'assistant' (main agent chat) | 'conv-…' (agent side chat) | a cc tab key.
  const [chatMode, setChatMode] = useState<string>(() => {
    try {
      const mode = localStorage.getItem(LS_CC_MODE_KEY);
      if (!mode || mode === 'assistant') return 'assistant';
      // Agent side chats validate against the fetched conversation list (effect
      // below) — trust the persisted id until that list arrives.
      if (mode.startsWith('conv-')) return mode;
      const raw = localStorage.getItem(LS_CC_SESSION_KEY) ?? '';
      // Legacy 'session' value maps onto the migrated single tab.
      if (mode === 'session') return raw ? 'cc-legacy' : 'assistant';
      return raw.includes(`"${mode}"`) ? mode : 'assistant';
    } catch { return 'assistant'; }
  });

  // ── Walnut Agent (note-agent) conversations: the stable main chat plus named
  // side chats — same right-click create / × delete lifecycle as CC sessions,
  // but backed by the conversations API (server-persisted, shared with the
  // home page's agent chat). The MAIN conversation is the permanent
  // "Note Agent" row; side chats can be removed. ──
  const noteConvs = useConversations(NOTE_AGENT_ID);
  const mainConvId = useMemo(
    () => noteConvs.conversations.find((c) => c.isMain)?.id ?? noteConvs.activeConversationId,
    [noteConvs.conversations, noteConvs.activeConversationId],
  );
  const agentSideChats = useMemo(
    () => noteConvs.conversations.filter((c) => !c.isMain),
    [noteConvs.conversations],
  );

  // A persisted agent-chat mode may point at a conversation deleted elsewhere —
  // fall back to the main chat once the list is authoritative.
  useEffect(() => {
    if (noteConvs.isLoading) return;
    if (chatMode.startsWith('conv-') && !noteConvs.conversations.some((c) => c.id === chatMode)) {
      setChatMode('assistant');
    }
  }, [noteConvs.isLoading, noteConvs.conversations, chatMode]);

  useEffect(() => {
    try {
      const persistable = ccTabs.filter((t) => t.taskId || t.sessionId)
        .map(({ key, label, folder, taskId, sessionId }) => ({ key, label, folder, taskId, sessionId }));
      if (persistable.length > 0) localStorage.setItem(LS_CC_SESSION_KEY, JSON.stringify(persistable));
      else localStorage.removeItem(LS_CC_SESSION_KEY);
    } catch { /* ignore */ }
  }, [ccTabs]);
  useEffect(() => {
    try { localStorage.setItem(LS_CC_MODE_KEY, chatMode); } catch { /* ignore */ }
  }, [chatMode]);

  // Prefetch the vault root once so the click handler never awaits it — the
  // promise is page-lifetime cached in api/config.
  useEffect(() => { void fetchNotesDir(); }, []);

  const handleCcResolved = useCallback((key: string, sessionId: string) => {
    setCcTabs((tabs) => tabs.map((t) => t.key === key ? { ...t, sessionId } : t));
  }, []);

  // Close ONE tab; if it was active, fall back to the newest remaining CC tab
  // (or the assistant when none are left).
  const handleCcClose = useCallback((key: string) => {
    setCcTabs((tabs) => {
      const next = tabs.filter((t) => t.key !== key);
      setChatMode((mode) => mode === key ? (next[next.length - 1]?.key ?? 'assistant') : mode);
      return next;
    });
  }, []);

  // Delete a Walnut Agent side chat (server-side; main is 409-protected there).
  const handleAgentChatDelete = useCallback((convId: string) => {
    setChatMode((mode) => (mode === convId ? 'assistant' : mode));
    void noteConvs.remove(convId);
  }, [noteConvs]);

  // The switcher's × dispatches by key shape: conversation ids delete an agent
  // side chat, anything else closes a CC session tab.
  const handleSwitcherClose = useCallback((key: string) => {
    if (key.startsWith('conv-')) handleAgentChatDelete(key);
    else handleCcClose(key);
  }, [handleAgentChatDelete, handleCcClose]);

  // Restored-session validation: persisted sids may point at sessions that were
  // archived/deleted while we were away — drop those tabs instead of rendering
  // dead panels. Live "close" stays explicit (each tab's ✕ / panel close).
  // Same fetch also BACKFILLS folder context onto entries persisted before the
  // folder field existed (they showed a bare "Claude Code" — confusing).
  const ccSids = ccTabs.map((t) => t.sessionId).filter(Boolean).join(',');
  useEffect(() => {
    if (!ccSids) return;
    let cancelled = false;
    for (const sid of ccSids.split(',')) {
      fetchSession(sid).then((s) => {
        if (cancelled) return;
        if (!s || s.archived) {
          log.info('notes', 'Persisted CC session is gone — closing its tab', { sessionId: sid });
          setCcTabs((tabs) => {
            const dead = tabs.find((t) => t.sessionId === sid);
            if (dead) setChatMode((mode) => mode === dead.key ? 'assistant' : mode);
            return tabs.filter((t) => t.sessionId !== sid);
          });
          return;
        }
        // Backfill: legacy entry with no folder → derive from the record. cwd
        // is the vault root for notes sessions, so the best available context
        // is the session title; fall back to the cwd basename.
        setCcTabs((tabs) => tabs.map((t) => {
          if (t.sessionId !== sid || t.folder !== undefined) return t;
          const fromTitle = s.title?.trim();
          const fromCwd = s.cwd ? s.cwd.split('/').filter(Boolean).pop() : undefined;
          const label = (t.label === 'Claude Code' && fromTitle) ? fromTitle : t.label;
          return { ...t, label, folder: fromCwd ?? 'Notes' };
        }));
      }).catch(() => { /* transient — keep the tab; the panel has its own retries */ });
    }
    return () => { cancelled = true; };
  }, [ccSids]);

  const activeCcTab = useMemo(() => ccTabs.find((t) => t.key === chatMode) ?? null, [ccTabs, chatMode]);

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

  // ── Inbound URL navigation while already MOUNTED: hydrateTabs only runs once,
  //    so a navigate('/notes?path=…') fired from inside this page (note link
  //    clicked in a chat-column session panel) must be handled here. The mirror
  //    effect above keeps the URL equal to the active tab, so only a param that
  //    points elsewhere is a real navigation. ──
  useEffect(() => {
    const urlAttachment = searchParams.get('attachment');
    const urlPath = searchParams.get('path');
    const target = urlAttachment ?? urlPath;
    if (target && target !== activePath) {
      openInTab(target, urlAttachment ? 'attachment' : 'note', { newTab: true });
    }
  // Only react to URL changes — activePath churn is the mirror effect's domain.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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

  // Context-menu "Start Claude Code session": quick-start in the notes vault
  // (cwd = NOTES_DIR so the CLI's native CLAUDE.md discovery picks up the vault
  // instructions). Message is EMPTY on purpose: spawn + init only (SessionStart
  // hook, MCP/skills load) — no auto first turn; the CLI idles until the user
  // actually types. PERCEIVED-INSTANT: pane state is set synchronously; the
  // HTTP round-trip fills in taskId later.
  // Context-menu "New Note Agent chat": a fresh named conversation of the
  // built-in agent, titled after the clicked note/folder — mirrors the CC
  // session flow but stays inside the conversations API (instant, no spawn).
  const handleStartAgentChat = useCallback(async (targetPath?: string) => {
    setChatOpen(true);
    try { localStorage.setItem(LS_CHAT_OPEN_KEY, '1'); } catch { /* ignore */ }
    if (targetPath) {
      if (targetPath.endsWith('.md')) handleSelect(targetPath);
      else revealInTree(targetPath);
    }
    try {
      const cid = await noteConvs.create(ccTabLabel(targetPath));
      setChatMode(cid);
      // Persist directly — same React same-value-bail caveat as the CC flow.
      try { localStorage.setItem(LS_CC_MODE_KEY, cid); } catch { /* ignore */ }
    } catch (err) {
      log.warn('notes', 'Failed to create Note Agent chat', {
        error: err instanceof Error ? err.message : String(err), targetPath,
      });
    }
  }, [noteConvs, handleSelect, revealInTree]);

  const handleStartCcSession = useCallback(async (targetPath?: string) => {
    const key = `cc-${Date.now()}`;
    setCcTabs((tabs) => [...tabs, { key, label: ccTabLabel(targetPath), folder: ccTabFolder(targetPath) }]);
    setChatMode(key);
    setChatOpen(true);
    // Persist directly too — the chatMode effect won't re-fire if the state
    // already equals `key` (React bails on same-value sets), yet the stored key
    // may have been cleared externally (e.g. a stale server-prefs merge).
    try {
      localStorage.setItem(LS_CHAT_OPEN_KEY, '1');
      localStorage.setItem(LS_CC_MODE_KEY, key);
    } catch { /* ignore */ }
    // Bring the session's subject into view: open the note in the editor, or
    // expand+scroll a folder in the tree — the pane and its target move together.
    if (targetPath) {
      if (targetPath.endsWith('.md')) handleSelect(targetPath);
      else revealInTree(targetPath);
    }
    try {
      const notesDir = await fetchNotesDir(); // prefetched on mount — resolves instantly
      if (!notesDir) throw new Error('Notes vault directory unavailable (cloud mode?)');
      const result = await quickStartSession({ cwd: notesDir, message: '' });
      setCcTabs((tabs) => tabs.map((t) => t.key === key && !t.sessionId ? { ...t, taskId: result.taskId } : t));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('notes', 'Failed to start Claude Code session from notes', { error: msg, targetPath });
      setCcTabs((tabs) => tabs.map((t) => t.key === key ? { ...t, error: msg } : t));
    }
  }, [handleSelect, revealInTree]);

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

  // Resizable chat column — the divider between editor and chat pane is a drag
  // handle (mirrors the tree resize). Width persists; dragging LEFT widens.
  const [chatWidth, setChatWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(LS_CHAT_WIDTH_KEY);
      if (stored) return clampChatWidth(Number(stored));
    } catch { /* ignore */ }
    return CHAT_WIDTH_DEFAULT;
  });
  const chatResizingRef = useRef(false);

  const handleChatResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    chatResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = chatWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      if (!chatResizingRef.current) return;
      // The pane is on the RIGHT: dragging the divider left grows it.
      setChatWidth(clampChatWidth(startWidth + (startX - ev.clientX)));
    };
    const onMouseUp = () => {
      chatResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [chatWidth]);

  useEffect(() => {
    try { localStorage.setItem(LS_CHAT_WIDTH_KEY, String(chatWidth)); } catch { /* ignore */ }
  }, [chatWidth]);

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
      // Sanitize a title into a flat vault filename: replace path separators,
      // strip only genuinely-unsafe filename chars. Spaces and hyphens are
      // perfectly legal (Obsidian convention) — an earlier over-eager character
      // class silently collapsed "Project Plan" → "ProjectPlan.md".
      const safe = trimmed
        .replace(/[\\/]+/g, '-')
        .replace(/[<>:"|?*]/g, '')
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

  // Rendered into the tab strip's trailing slot (both the with-tabs and the
  // no-tabs strip), so there's a single definition of the button.
  const aiToggleButton = (
    <button
      className={`notes-ai-toggle${chatOpen ? ' active' : ''}`}
      onClick={toggleChat}
      aria-pressed={chatOpen}
      title={chatOpen ? 'Hide Note Agent' : 'Ask the Note Agent'}
    >
      <SparkleIcon />
      <span>AI</span>
    </button>
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
          onStartSession={handleStartCcSession}
          onStartAgentChat={handleStartAgentChat}
        />
      </div>
      <div className="notes-resize-handle" onMouseDown={handleResizeStart} />
      <div className="notes-editor-pane">
        {/* The AI toggle is IN the tab strip (real layout space, right-aligned), not
            floating over the pane — an absolute overlay sat on top of the note's own
            header/content. With no tabs open there's no strip, so we render a bare
            strip that holds just the button. */}
        {tabs.length > 0 ? (
          <NotesTabStrip
            tabs={tabs}
            activePath={activePath}
            onActivate={handleActivateTab}
            onClose={handleCloseTab}
            onNewTab={handleNewTab}
            trailing={aiToggleButton}
          />
        ) : (
          <div className="notes-tab-strip notes-tab-strip-empty">
            <div className="notes-tab-trailing">{aiToggleButton}</div>
          </div>
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
          <div className="notes-chat-divider" onMouseDown={handleChatResizeStart} title="Drag to resize" />
          <div className="notes-chat-pane" style={{ flex: `0 0 ${chatWidth}px`, width: chatWidth }}>
            {(() => {
              // Dropdown switcher — only shown once there's something to switch
              // BETWEEN (a CC session or an agent side chat), so the plain agent
              // keeps its uncluttered header. The trigger reads as the pane's
              // title (current selection); the menu lists every Walnut Agent
              // chat + every session (named by origin, each with its own ×).
              const tabs = (ccTabs.length > 0 || agentSideChats.length > 0) ? (
                <NotesChatSwitcher
                  sessions={ccTabs.map((t) => ({
                    key: t.key,
                    label: t.label,
                    folder: t.folder,
                    error: Boolean(t.error),
                    pending: !t.sessionId && !t.error,
                  }))}
                  agentChats={agentSideChats.map((c) => ({ key: c.id, label: c.title }))}
                  active={chatMode}
                  onSelect={setChatMode}
                  onCloseSession={handleSwitcherClose}
                />
              ) : undefined;

              if (activeCcTab) {
                if (activeCcTab.error) {
                  return (
                    <div className="notes-chat">
                      <div className="notes-chat-header">{tabs}</div>
                      <div className="notes-chat-empty">
                        <p style={{ color: 'var(--color-error, #ff3b30)' }}>Failed to start session: {activeCcTab.error}</p>
                        <p>Close this tab, fix the issue, then retry from the notes tree's context menu.</p>
                      </div>
                    </div>
                  );
                }
                // Live session → the REAL SessionPanel (same rich UI as the
                // home-page session columns: title, Fork/Changed/Files/Terminal,
                // model badge, tool cards). It owns its own header, so the
                // session tabs sit in a slim strip above it.
                if (activeCcTab.sessionId) {
                  return (
                    <div className="notes-chat notes-session-host">
                      <div className="notes-chat-header notes-session-host-tabs">{tabs}</div>
                      <div className="notes-session-host-panel">
                        <SessionPanel
                          key={activeCcTab.sessionId}
                          sessionId={activeCcTab.sessionId}
                          onClose={() => handleCcClose(activeCcTab.key)}
                          onSessionReplaced={(_oldId, newId) => handleCcResolved(activeCcTab.key, newId)}
                        />
                      </div>
                    </div>
                  );
                }
                // Still linking → the slim pending shell; hands off to the
                // panel via onResolved the moment the sessionId materializes.
                return (
                  <NotesSessionChat
                    key={activeCcTab.key}
                    taskId={activeCcTab.taskId}
                    onResolved={(sid) => handleCcResolved(activeCcTab.key, sid)}
                    headerLeft={tabs}
                  />
                );
              }
              // Walnut Agent — either the main chat ('assistant') or a named
              // side chat (chatMode = its conversation id). key remounts the
              // pane on switch so useChat reloads the right history.
              const agentConvId = chatMode.startsWith('conv-') ? chatMode : mainConvId;
              return <NotesChat key={agentConvId ?? 'main'} activeNotePath={activeNotePath} headerLeft={tabs} conversationId={agentConvId} />;
            })()}
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
