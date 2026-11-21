import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
import { useNotesTree, isNotesTreeCacheCurrent } from '@/hooks/useNotesTree';
import { useNoteContent } from '@/hooks/useNoteContent';
import { prefetchNoteOnHover } from '@/stores/note-content-cache';
import { useFavorites } from '@/hooks/useFavorites';
import { useDragGesture } from '@/hooks/useDragGesture';
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
import { createNote, moveNote, treeFilePaths, fetchNoteContent, type NoteTreeNode } from '@/api/notes-v2';
import { quickStartSession, fetchSession } from '@/api/sessions';
import { fetchNotesDir } from '@/api/config';
import { log } from '@/utils/log';
import { claimPrefKey } from '@/utils/ui-prefs-sync';
import { usePhoneNoteLayer, replaceUrlKeepingState } from '@/components/notes/usePhoneNoteLayer';
import { NoteMissingState } from '@/components/notes/NoteMissingState';
import { hasHeldText } from '@/hooks/useNoteGone';
import { primaryDoc, requestPageFind } from '@/utils/find-doc';
import { useAlert } from '@/hooks/useConfirm';
import { useNoteAutoName } from '@/hooks/useNoteAutoName';
import { fileBaseFromTitle, followAutoName, forgetAutoName, markAutoNamed, pickUntitledPath } from '@/components/notes/note-auto-name';

const LS_WIDTH_KEY = 'open-walnut-notes-tree-width';
const LS_TABS_KEY = 'open-walnut-notes-tabs';
/**
 * The history state the page's own URL mirror writes (`?path=` follows the active tab). The
 * router applies a URL change as a transition, so under load the page's own write of an earlier
 * tab can land after the tabs moved on; this marks it as the page's, never a navigation.
 */
const NOTES_URL_MIRROR = { notesUrlMirror: true } as const;
function isNotesUrlMirror(state: unknown): boolean {
  return !!state && typeof state === 'object' && (state as Record<string, unknown>).notesUrlMirror === true;
}
/**
 * The person changed the open tabs (opened, closed, created, renamed, deleted): from now on the
 * saved workspace is their choice, not the page's default, so the server's prefs read late (the
 * first read timed out) keep it instead of putting an older workspace back (ui-prefs-sync.ts
 * claimPrefKey). Called by the person's own actions only: the restore checks that close a gone
 * note's tab, and other writes nobody made, never claim.
 */
function choseTabs(): void { claimPrefKey(LS_TABS_KEY); }
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
  /** Hydration only: the note tabs that came from the saved workspace (they existed once). */
  restored?: string[];
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
 * `restored` lists only the saved workspace's notes: those wait for the tree to
 * list them before they open. A URL note that is not among them (a deep link, a
 * pop-out, or a reload of a URL the mirror had not rewritten yet) opens at once;
 * if it is gone, its read answers 404 and the editor shows it as deleted
 * (useNoteContent `missing`), never as an empty note that typing would recreate.
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
  let restored: string[] = [];
  try {
    const raw = localStorage.getItem(LS_TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedTabs>;
      tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isValidTab) : [];
      restored = tabs.filter((t) => t.kind === 'note').map((t) => t.path);
      const wanted = typeof parsed.activePath === 'string' ? parsed.activePath : null;
      activePath = tabs.some((t) => t.path === wanted) ? wanted : (tabs[0]?.path ?? null);
    }
  } catch { /* malformed / disabled storage — start from the URL tab alone */ }

  if (urlTab) {
    if (!tabs.some((t) => t.path === urlTab.path)) tabs = [...tabs, urlTab];
    activePath = urlTab.path;
  }
  return { tabs, activePath, restored };
}

/** Every note path in the tree. */
function notePathsOf(nodes: NoteTreeNode[], out = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.type === 'folder') notePathsOf(node.children ?? [], out);
    else if (node.kind !== 'attachment') out.add(node.path);
  }
  return out;
}

/**
 * Find the first candidate needle in the rendered editor DOM and return the
 * innermost BLOCK element containing it.
 *
 * Block-level (not per-text-node): editor text nodes are split by inline marks
 * (bold, links), so any needle longer than one run of plain text could never
 * match a single node — which silently downgraded every jump to its
 * longest-single-word fallback and landed on the first occurrence anywhere
 * (usually the title). Matching against each block's whitespace-normalized
 * textContent makes long, near-unique context needles actually work.
 */
const JUMP_BLOCK_SEL = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre';

function findTextInDom(root: HTMLElement, needles: string[]): HTMLElement | null {
  const blockText = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ').toLowerCase();
  const tryFind = (n: string): HTMLElement | null => {
    if (n.length < 2) return null;
    let el = [...root.querySelectorAll<HTMLElement>(JUMP_BLOCK_SEL)]
      .find((b) => blockText(b).includes(n)) ?? null;
    // Descend to the innermost matching block (a p inside a li inside a td).
    while (el) {
      const inner = [...el.querySelectorAll<HTMLElement>(JUMP_BLOCK_SEL)]
        .find((b) => blockText(b).includes(n));
      if (!inner) break;
      el = inner;
    }
    return el;
  };
  // A context needle routinely CROSSES a block boundary (the snippet window
  // doesn't know where the note's heading ends and its paragraph begins), so
  // no single block can contain the whole thing. Shrink from the right one
  // word at a time until it fits inside one block — e.g. "Non-Resident Rental
  // Income (Section 216) Non-residents can elect…" shrinks to exactly the
  // heading's own text and lands on the heading. Without this, a cross-block
  // needle fell through to a single-word fallback whose FIRST occurrence in
  // the document is usually an unrelated early paragraph.
  const tryShrinking = (raw: string): HTMLElement | null => {
    let words = raw.replace(/\s+/g, ' ').trim().toLowerCase().split(' ');
    for (let step = 0; step < 16 && words.length >= 2; step++) {
      const el = tryFind(words.join(' '));
      if (el) return el;
      words = words.slice(0, -1);
      if (words.join(' ').length < 8) break;
    }
    return words.length === 1 ? tryFind(words[0]) : null;
  };
  for (const raw of needles) {
    const el = tryShrinking(raw);
    if (el) return el;
  }
  // Last resort: the longest single word of the final (loosest) candidate.
  const longest = (needles[needles.length - 1] ?? '').trim().toLowerCase().split(/\s+/)
    .sort((a, b) => b.length - a.length)[0] ?? '';
  return longest.length >= 2 ? tryFind(longest) : null;
}

/** Flash-highlight class applied to the jumped-to element (defined in globals.css). */
const JUMP_FLASH_CLASS = 'notes-jump-flash';

export function NotesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigationType = useNavigationType();
  const location = useLocation();
  // A link followed inside a note adds a history entry, so Back returns to the note it was in
  // (every other tab change replaces the entry). 2026-11-04: imported notes are read by following
  // links, and Back left Notes.
  const followedLinkRef = useRef(false);
  const { tree, loading: treeLoading, fetched: treeFetched, error: treeError, refresh: refreshTree, addFolder, removeNote, removeFolder, removeAttachment, renameNote } = useNotesTree();
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
  // A tab from the saved workspace opens once a tree says its note is still there (an organize
  // Undo, an agent or another window may have removed it while this page was closed): a note
  // that is gone closes its tab without being asked for (2026-11-04: a reload asked for it, 404).
  // Only a tree that lists the note lets it open: the render in which a fetched tree without it
  // arrives (the effect below closes the tab right after) used to open it for that one render, so
  // the note was asked for, and an empty editor for it was one step from saving it back.
  const unconfirmedRef = useRef(new Set(initial.current.restored ?? []));
  // Notes the person set out to make by opening them (a link followed, a capture whose create
  // failed): only these open empty when not found; any other missing note shows as deleted.
  const createPathsRef = useRef(new Set<string>());
  const [cacheCurrentAtMount] = useState(isNotesTreeCacheCurrent);
  const holding = activeTab?.kind === 'note' && unconfirmedRef.current.has(activeTab.path) && !hasHeldText(activeTab.path)
    && !((treeFetched || cacheCurrentAtMount) && notePathsOf(tree).has(activeTab.path));
  const activeNotePath = activeTab?.kind === 'note' && !holding ? activeTab.path : null;

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
    renameOpenNote,
    remountKey,
    ownSave,
    hasUnsavedEdits,
    missing,
    createMissing,
  } = useNoteContent(activeNotePath, {
    mayCreate: (p) => createPathsRef.current.has(p),
    // Held text of a deleted note saved beside a note made meanwhile: its tab follows it there.
    onSavedAs: (from, to) => { retargetTab(from, to); void refreshTree(); },
  });
  // Phone: the open note is a layer (Back = the tree) and reads until Edit. A note
  // renamed after its title is the same note (its editor's remount key), so Edit stays on.
  const noteLayer = usePhoneNoteLayer(
    activeTab ? activePath : null,
    // Back is the person's; leaving the phone layout (a resize) is nobody's choice.
    ({ breakpoint }) => { if (!breakpoint) choseTabs(); setActivePath(null); },
    activeNotePath ? remountKey : activePath,
  );

  // ── Persist {tabs, activePath} (mirrors the tree-width persistence) ──
  useEffect(() => {
    try {
      localStorage.setItem(LS_TABS_KEY, JSON.stringify({ tabs, activePath }));
    } catch { /* ignore quota / disabled storage */ }
  }, [tabs, activePath]);

  // Jump-to-match request state: {path, needles} of the search hit to scroll
  // to (set by handleSelect below); the nonce re-fires the effect when the
  // target note is ALREADY open (content/path unchanged → effect wouldn't rerun).
  const pendingJumpRef = useRef<{ path: string; needles: string[]; findQueries: string[] } | null>(null);
  const [jumpNonce, setJumpNonce] = useState(0);

  // ── Jump-to-match: after a search-result open renders, scroll to the hit. ──
  // Retries briefly because tiptap paints async after `content` lands; gives up
  // quietly if the text isn't found (e.g. match was in frontmatter/OCR only).
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending || pending.path !== activeNotePath || content === null) return;
    pendingJumpRef.current = null;
    let cancelled = false;
    let attempts = 0;
    let rescrolls = 0;
    const inView = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    };
    // After scrolling, verify the target STAYED in view: the editor's autoFocus
    // (fired async on mount) moves the caret to the doc start and yanks the
    // scroll back to the top — re-scroll until it sticks (bounded).
    const settle = (el: HTMLElement) => {
      if (cancelled) return;
      if (!inView(el) && rescrolls < 4) {
        rescrolls++;
        el.scrollIntoView({ block: 'center' });
        setTimeout(() => settle(el), 250);
        return;
      }
      el.classList.add(JUMP_FLASH_CLASS);
      setTimeout(() => el.classList.remove(JUMP_FLASH_CLASS), 1600);
    };
    // The find bar opens on the searched word with every match painted and the
    // one in the hit's paragraph chosen (2026-11-04, the user: clicking a hit
    // showed "?/5", nothing highlighted in the note; the five were the sidebar's).
    // The find's own reveal then brings the chosen match into view (and keeps
    // it there through the editor's autofocus), so the block is not scrolled.
    const finds = pending.findQueries.length > 0;
    // The reader moved on (clicked or typed) while the note loaded: never open
    // the bar over them then, it would take their keys.
    let acted = false;
    const onAct = () => { acted = true; };
    // Focus moving into another field (the search box, by any means) counts too;
    // the note's own editor taking focus as it loads does not.
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || primaryDoc()?.contains(t)) return;
      if (t.matches('input, textarea, [contenteditable="true"]') && !t.closest('.page-find')) acted = true;
    };
    document.addEventListener('keydown', onAct, true);
    document.addEventListener('pointerdown', onAct, true);
    document.addEventListener('focusin', onFocusIn, true);
    const openFind = (doc: Element | null, near: HTMLElement | null) => {
      if (!finds || acted) return;
      requestPageFind({ queries: pending.findQueries, near, doc, context: pending.needles[0] });
    };
    const tryJump = () => {
      if (cancelled) return;
      // This page's note only: Home's Scratchpad editor stays mounted, hidden,
      // earlier in the document, and a page-wide query found it first.
      const doc = primaryDoc();
      const tiptap = doc?.querySelector<HTMLElement>('.notes-editor .tiptap') ?? null;
      const root = tiptap && tiptap.getClientRects().length ? tiptap : null;
      // The raw view shows instead: the find picks the hit's text in its source.
      if (!root && doc?.querySelector('.notes-raw-view .cm-editor')) { openFind(doc, null); return; }
      const el = root && findTextInDom(root, pending.needles);
      if (el) {
        if (finds) {
          openFind(doc, el);
          el.classList.add(JUMP_FLASH_CLASS);
          setTimeout(() => el.classList.remove(JUMP_FLASH_CLASS), 1600);
          return;
        }
        el.scrollIntoView({ block: 'center' });
        setTimeout(() => settle(el), 250);
        return;
      }
      // ~3s of retries: tiptap mounts after the loading spinner clears, and on
      // a loaded machine that can take well over the old 1.2s budget.
      // Not located (the word is only in the title, a link's URL or the
      // frontmatter): no bar, the note shows nothing to step through.
      if (++attempts < 25) setTimeout(tryJump, 120);
    };
    setTimeout(tryJump, 80);
    return () => {
      cancelled = true;
      document.removeEventListener('keydown', onAct, true);
      document.removeEventListener('pointerdown', onAct, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [activeNotePath, content, jumpNonce]);

  // ── Auto-locate (#2): whenever the active tab changes, reveal it in the tree
  //    (expand its folders + scroll into view). Only for note/attachment paths. ──
  useEffect(() => {
    if (activePath) revealInTree(activePath);
  }, [activePath, revealInTree]);

  // ── URL sync: mirror the active tab into ?path= / ?attachment= (replace, never push) ──
  // Judged against the address bar itself, never the router's `searchParams`: the router applies
  // a URL write as a transition, so under load its value still names a tab the page already
  // closed (a restored note found deleted), and a mirror that read it saw no notes param to clear
  // and left `?path=<deleted note>` in the address bar, where a reload opened it as a deep link.
  const mirrorUrl = useLeanCallback(() => {
    const urlNow = new URLSearchParams(window.location.search);
    if (!activeTab) {
      // Only clear if a notes param is present (avoid clobbering unrelated params).
      if (noteLayer.phone) { replaceUrlKeepingState({}); return; }
      if (urlNow.get('path') || urlNow.get('attachment')) {
        setSearchParams({}, { replace: true, state: NOTES_URL_MIRROR });
      }
      return;
    }
    const next: Record<string, string> =
      activeTab.kind === 'attachment' ? { attachment: activeTab.path } : { path: activeTab.path };
    const followed = followedLinkRef.current;
    followedLinkRef.current = false;
    // A phone layer's history entry carries its marker: keep that state.
    if (noteLayer.phone) { replaceUrlKeepingState(next); return; }
    const already = activeTab.kind === 'attachment' ? urlNow.get('attachment') === activeTab.path : urlNow.get('path') === activeTab.path;
    setSearchParams(next, { replace: !followed || already || (!urlNow.get('path') && !urlNow.get('attachment')), state: NOTES_URL_MIRROR });
  }, [activeTab, noteLayer.phone, setSearchParams]);
  // Intentionally not on searchParams, to avoid a sync loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { mirrorUrl(); }, [activeTab]);

  // ── Inbound URL navigation while already MOUNTED: hydrateTabs only runs once,
  //    so a navigate('/notes?path=…') fired from inside this page (note link
  //    clicked in a chat-column session panel) must be handled here. The mirror
  //    effect above keeps the URL equal to the active tab, so only a param that
  //    points elsewhere is a real navigation. Not the mirror's own write coming back, though: the
  //    router applies it as a transition, and under load it landed after the tabs had moved on (a
  //    restored tab closed as gone, a New note opened), so the old note opened again and the next
  //    keystrokes were saved into it, writing a deleted note back (2026-11-16, CI). Back and
  //    Forward (POP) still open the entry they reach. ──
  useEffect(() => {
    const urlAttachment = searchParams.get('attachment');
    const urlPath = searchParams.get('path');
    const target = urlAttachment ?? urlPath;
    if (navigationType !== 'POP' && isNotesUrlMirror(location.state)) {
      // An older write: the tab it named is gone or no longer active, so the URL is written again
      // (left as it was, a reload opened that note as a deep link).
      if (target !== (activeTab?.path ?? null)) mirrorUrl();
      return;
    }
    if (target && target !== activePath) {
      // Back or Forward through followed links opens the note where the reader is.
      openInTab(target, urlAttachment ? 'attachment' : 'note', { newTab: navigationType !== 'POP' });
    }
  // Only react to URL changes — activePath churn is the mirror effect's domain.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── Single source of truth for opening a path (§1.3). All programmatic opens
  //    (tree click, Cmd+K, bookmark click, create, rename follow) funnel here. ──
  const openInTab = useCallback((path: string, kind: TabKind, opts?: { newTab?: boolean }) => {
    choseTabs();
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
  const handleSelect = useCallback((path: string, opts?: { newTab?: boolean; scrollToText?: string | string[]; findQueries?: string[] }) => {
    const needles = (Array.isArray(opts?.scrollToText) ? opts.scrollToText : [opts?.scrollToText])
      .filter((t): t is string => !!t && !!t.trim());
    pendingJumpRef.current = needles.length ? { path, needles, findQueries: opts?.findQueries ?? [] } : null;
    if (needles.length) setJumpNonce((n) => n + 1);
    // A search hit: a bar left open from before goes now, not once the note
    // loaded (it would search the new note for the old word meanwhile); the
    // hit opens its own when its word is in the note.
    if (opts?.findQueries?.length) requestPageFind({ queries: [] });
    openInTab(path, 'note', opts);
  }, [openInTab]);
  // A search hit's word rides along, so a PDF opens searched for it (AttachmentPreview).
  const [attachmentFind, setAttachmentFind] = useState<{ path: string; query: string } | null>(null);
  const handlePreviewAttachment = useCallback((path: string, opts?: { findQueries?: string[] }) => {
    // The word the search marked: the typed words may not be in the PDF verbatim.
    const q = opts?.findQueries?.[opts.findQueries.length - 1] ?? '';
    setAttachmentFind(q ? { path, query: q } : null);
    openInTab(path, 'attachment');
  }, [openInTab]);
  const handleFollowLink = useLeanCallback((path: string) => {
    if (path !== activePath) followedLinkRef.current = true;
    // A link to a note not written yet opens it to write (the wiki way).
    createPathsRef.current.add(path);
    handleSelect(path);
  }, [handleSelect, activePath]);

  const handleActivateTab = useCallback((path: string) => { choseTabs(); setActivePath(path); }, []);

  // Drop every tab `gone` matches (a closed tab, a deleted note, attachment or folder). If the
  // active tab goes, the right neighbor of the first dropped tab takes the slot, else the left,
  // else none (empty state); otherwise the active tab stays.
  const dropTabs = useLeanCallback((gone: (tab: OpenTab) => boolean) => {
    setTabs((prev) => {
      const idx = prev.findIndex(gone);
      if (idx === -1) return prev;
      const next = prev.filter((t) => !gone(t));
      setActivePath((cur) => {
        const active = prev.find((t) => t.path === cur);
        if (!active || !gone(active)) return cur;
        const neighbor = next[idx] ?? next[idx - 1] ?? next[0];
        return neighbor ? neighbor.path : null;
      });
      return next;
    });
  }, []);
  const handleCloseTab = useLeanCallback((path: string) => {
    choseTabs();
    dropTabs((t) => t.path === path);
  }, [dropTabs]);

  // A note removed outside this page (an organize Undo, an agent, another window) closes its
  // tab, as deleting it in the tree does: an open tab used to show it as an empty note to type
  // into, and a reload kept asking for it (2026-11-04). Only a tab whose note existed (it loaded
  // from disk, or came back from the saved workspace) is closed, and only once the server says
  // the note is gone, so a tab opened for a note not written yet (a new link) stays, and a tree
  // a moment behind a save never closes one.
  const existedRef = useRef(new Set(initial.current.restored ?? []));
  // `updatedAt` still holds the previous note's in the render that switches notes, so only a
  // note shown loaded counts (a note opened by Back after it was deleted was counted as having
  // loaded, and its tab closed under the person writing it again).
  useEffect(() => {
    if (activeNotePath && updatedAt && !contentLoading && !missing) {
      existedRef.current.add(activeNotePath);
      // Made (or found): from now on a 404 for it means deleted, never "open it empty".
      createPathsRef.current.delete(activeNotePath);
    }
  }, [activeNotePath, updatedAt, contentLoading, missing]);
  // A note the person set out to make and left before it was: no longer theirs to make.
  useEffect(() => {
    for (const p of [...createPathsRef.current]) if (p !== activeNotePath) createPathsRef.current.delete(p);
  }, [activeNotePath]);
  useEffect(() => {
    if (!treeFetched) return;
    const present = notePathsOf(tree);
    // The saved workspace's tabs, checked against the first tree of this visit.
    if (unconfirmedRef.current.size) {
      for (const path of [...unconfirmedRef.current]) {
        unconfirmedRef.current.delete(path);
        // A note deleted under text this page still holds keeps its tab: the text is shown there.
        if (!present.has(path) && !hasHeldText(path) && tabs.some((t) => t.kind === 'note' && t.path === path)) {
          existedRef.current.delete(path);
          dropTabs((t) => t.path === path);
        }
      }
      return;
    }
    const gone = tabs.filter((t) => t.kind === 'note' && existedRef.current.has(t.path) && !present.has(t.path) && !hasHeldText(t.path));
    if (!gone.length) return;
    let cancelled = false;
    for (const tab of gone) {
      fetchNoteContent(tab.path).then(() => undefined, (err) => {
        if (cancelled || err?.status !== 404) return;
        // Held meanwhile, or a save of it still out (refused, 410, it holds its text): the tab stays.
        if (hasHeldText(tab.path)) return;
        // Words typed into it and not saved yet stay on screen: their save is refused (410), and
        // the editor offers to save them as a new note.
        if (tab.path === activeNotePath && hasUnsavedEdits()) return;
        existedRef.current.delete(tab.path);
        dropTabs((t) => t.path === tab.path);
      });
    }
    return () => { cancelled = true; };
  // Tabs and save state are read as of the tree that changed; a new tree runs it again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, treeFetched]);

  // Tab right-click: keep only the clicked tab / drop the whole workspace. Both
  // go through the same setTabs+setActivePath pair as handleCloseTab so the
  // active slot can never point at a tab that is gone.
  const handleCloseOtherTabs = useCallback((path: string) => {
    choseTabs();
    setTabs((prev) => prev.filter((t) => t.path === path));
    setActivePath(path);
  }, []);

  const handleCloseAllTabs = useCallback(() => {
    choseTabs();
    setTabs([]);
    setActivePath(null);
  }, []);

  // Context-menu "Start Claude Code session": quick-start in the notes vault
  // (cwd = the vault root so the CLI's native CLAUDE.md discovery picks up the vault
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
    choseTabs();
    setActivePath(null);
    // Defer so the empty state renders before the palette steals focus.
    setTimeout(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    }, 0);
  }, []);

  // Resizable left pane. Both dividers here sit beside the editor pane, which
  // renders PDF <iframe>s (attachment preview / wiki embeds) — the reason these
  // drags used to stick. useDragGesture captures the pointer, so move/up always
  // come back to the handle, and it persists once on release instead of writing
  // localStorage synchronously on every frame.
  const [listWidth, setListWidth] = useState(readWidth);
  const listWidthRef = useRef(listWidth);
  listWidthRef.current = listWidth;
  const startWidthRef = useRef(listWidth);
  const listPaneRef = useRef<HTMLDivElement>(null);

  const { onPointerDown: treeResizePointerDown } = useDragGesture({
    cursor: 'col-resize',
    onStart: () => {
      startWidthRef.current = listWidthRef.current;
      listPaneRef.current?.classList.add('resizing');
    },
    onMove: ({ dx }) => {
      listWidthRef.current = clampWidth(startWidthRef.current + dx);
      setListWidth(listWidthRef.current);
    },
    onEnd: () => {
      listPaneRef.current?.classList.remove('resizing');
      try { localStorage.setItem(LS_WIDTH_KEY, String(listWidthRef.current)); } catch { /* ignore */ }
    },
  });

  // Resizable chat column — the divider between editor and chat pane is a drag
  // handle (mirrors the tree resize). Width persists; dragging LEFT widens.
  const [chatWidth, setChatWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(LS_CHAT_WIDTH_KEY);
      if (stored) return clampChatWidth(Number(stored));
    } catch { /* ignore */ }
    return CHAT_WIDTH_DEFAULT;
  });
  const chatWidthRef = useRef(chatWidth);
  chatWidthRef.current = chatWidth;
  const startChatWidthRef = useRef(chatWidth);

  const { onPointerDown: chatResizePointerDown } = useDragGesture({
    cursor: 'col-resize',
    onStart: () => { startChatWidthRef.current = chatWidthRef.current; },
    // The pane is on the RIGHT: dragging the divider left grows it.
    onMove: ({ dx }) => {
      chatWidthRef.current = clampChatWidth(startChatWidthRef.current - dx);
      setChatWidth(chatWidthRef.current);
    },
    onEnd: () => {
      try { localStorage.setItem(LS_CHAT_WIDTH_KEY, String(chatWidthRef.current)); } catch { /* ignore */ }
    },
  });

  // Every file in the vault: where New note finds a free name, and what an
  // auto-named note's new name must not collide with.
  const filePaths = useMemo(() => treeFilePaths(tree), [tree]);
  const alert = useAlert();

  // A note renamed or moved: its open tab follows in place (position and active
  // state kept), so flush-on-switch is not triggered spuriously (§1.6).
  const retargetTab = useLeanCallback((from: string, to: string) => {
    choseTabs();
    setTabs((prev) => prev.map((t) => (t.path === from ? { ...t, path: to } : t)));
    setActivePath((cur) => (cur === from ? to : cur));
  }, []);

  /**
   * New note (2026-11-11, the user: "When we new a file please immediately new the
   * file"): the file exists at once, `Untitled.md` (`Untitled 1.md`, ... when taken) in
   * `folder` ('' = vault root), opened ready to type, and its name then follows the
   * title written into it (useNoteAutoName). Create-only, so a name another writer took
   * since the tree loaded moves on to the next number instead of overwriting that note.
   * The tree's New note, the empty state and the palette's blank capture all land here.
   */
  const handleNewNote = useLeanCallback(async (folder: string) => {
    const taken = new Set(filePaths);
    let made: string | null = null;
    for (let tries = 0; tries < 5 && !made; tries++) {
      const candidate = pickUntitledPath(folder, taken);
      try {
        made = (await createNote(candidate)).path || candidate;
      } catch (err) {
        if ((err as { status?: number } | null)?.status === 409) { taken.add(candidate); continue; }
        log.warn('notes', 'New note failed', { folder, path: candidate, error: err instanceof Error ? err.message : String(err) });
        await alert({ title: 'Could not create the note', message: err instanceof Error ? err.message : 'The note could not be created.' });
        return;
      }
    }
    if (!made) {
      await alert({ title: 'Could not create the note', message: 'Every Untitled name tried is taken. Refresh the notes and try again.' });
      void refreshTree();
      return;
    }
    const notePath = made;
    markAutoNamed(notePath);
    handleSelect(notePath);
    // Opened first, so the editor never waits on the tree; its row is shown once the tree has it.
    void refreshTree().then(() => revealInTree(notePath));
  }, [filePaths, alert, handleSelect, refreshTree, revealInTree]);

  /**
   * Quick capture from the Cmd+K palette: a title names the note (create-only, so a
   * title that is already a note's name opens that note and never empties it); an
   * empty one (⌘↵) is a New note at the vault root. The server stamps the frontmatter
   * `id` on the create (§2 identity contract).
   */
  const handleQuickCreate = useCallback(
    async (title: string) => {
      const base = fileBaseFromTitle(title);
      if (!base) { await handleNewNote(''); return; }
      const notePath = `${base}.md`;
      try {
        await createNote(notePath);
      } catch (err) {
        // Taken: open the note that has the name. Anything else still opens the
        // path (the editor's first save creates it) rather than dropping capture.
        if ((err as { status?: number } | null)?.status !== 409) {
          log.warn('notes', 'Quick-capture create failed (opening anyway)', {
            notePath, error: err instanceof Error ? err.message : String(err),
          });
          createPathsRef.current.add(notePath);
        }
      }
      await refreshTree();
      handleSelect(notePath);
    },
    [refreshTree, handleSelect, handleNewNote],
  );

  // An auto-named note follows its title: renamed in place, so the editor, its caret
  // and its unsaved text carry on under the new name (useNoteContent.renameOpenNote).
  const renameAutoNamed = useLeanCallback((from: string, to: string) => renameOpenNote(
    from,
    to,
    () => moveNote(from, to),
    (moved) => {
      followAutoName(from, moved);
      retargetTab(from, moved);
      pushRecent(moved);
      void refreshTree();
    },
  ), [renameOpenNote, retargetTab, refreshTree]);
  const handleAutoNameFailed = useLeanCallback((from: string, to: string, err: unknown) => {
    // Most likely the name was taken since the tree loaded: a fresh tree picks the next free one.
    log.warn('notes', 'Naming a note after its title failed', { from, to, error: err instanceof Error ? err.message : String(err) });
    void refreshTree();
  }, [refreshTree]);
  useNoteAutoName({
    path: activeNotePath, body: content, ownSave, existing: filePaths, rename: renameAutoNamed, onFailed: handleAutoNameFailed,
  });

  // Deleted note open in a tab → drop every matching tab (§1.6). Neighbor rule
  // matches close: if the deleted tab was active, activate a neighbor / empty.
  const handleDeleteNote = useCallback(
    async (notePath: string) => {
      forgetAutoName(notePath);
      // Cancel any pending debounced save targeting the doomed note — an
      // in-flight PUT after the rm would re-create it (same resurrection bug
      // markMovedAway kills for the move path).
      if (notePath === activeNotePath) {
        await markMovedAway(notePath);
      }
      await removeNote(notePath);
      choseTabs();
      dropTabs((t) => t.path === notePath);
    },
    [removeNote, activeNotePath, markMovedAway, dropTabs],
  );

  // Deleted attachment open in a preview tab → same tab-drop rule as notes.
  const handleDeleteAttachment = useCallback(
    async (attachmentPath: string) => {
      await removeAttachment(attachmentPath);
      choseTabs();
      dropTabs((t) => t.path === attachmentPath);
    },
    [removeAttachment, dropTabs],
  );

  // Deleted folder → drop EVERY tab living under it (notes and attachments alike).
  const handleDeleteFolder = useCallback(
    async (folderPath: string) => {
      const prefix = folderPath.replace(/\/+$/, '') + '/';
      // Kill any pending save for an active note inside the doomed folder —
      // an in-flight PUT after the rm would re-create the note AND its parents.
      if (activeNotePath && activeNotePath.startsWith(prefix)) {
        await markMovedAway(activeNotePath);
      }
      await removeFolder(folderPath);
      choseTabs();
      dropTabs((t) => t.path.startsWith(prefix));
    },
    [removeFolder, activeNotePath, markMovedAway, dropTabs],
  );

  // Renamed/moved from the tree: a name the user gave (or a place they chose) ends
  // the note's auto-naming; its open tab follows (retargetTab).
  const handleRenameNote = useCallback(
    async (from: string, to: string) => {
      forgetAutoName(from);
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
      retargetTab(from, to);
    },
    [renameNote, activeNotePath, markMovedAway, retargetTab],
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

  // Phone only (CSS shows it): a phone shows the tree OR the open note, and this
  // is the way from the note back to the tree. The tabs stay open.
  const backToTreeButton = (
    <button
      type="button"
      className="notes-phone-back"
      onClick={noteLayer.close}
      aria-label="All notes"
      title="All notes"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="10 3 5 8 10 13" />
      </svg>
      <span>Notes</span>
    </button>
  );

  if (treeLoading) return <LoadingSpinner />;
  if (treeError && tree.length === 0 && !activeTab) return <div className="empty-state"><p>Error: {treeError}</p><button type="button" onClick={() => void refreshTree()}>Retry</button></div>;

  return (
    <div className={`notes-split-view${activeTab ? ' notes-has-active' : ''}${chatOpen ? ' notes-chat-open' : ''}`}>
      <div
        className="notes-tree-pane"
        ref={listPaneRef}
        style={{ width: listWidth, flex: `0 0 ${listWidth}px` }}
      >
        {treeError && <div role="alert">{treeError} <button type="button" onClick={() => void refreshTree()}>Retry</button></div>}
        <NotesTreePanel
          tree={tree}
          selectedPath={activePath}
          onSelect={handleSelect}
          onPreviewAttachment={handlePreviewAttachment}
          onHoverNote={prefetchNoteOnHover}
          onNewNote={handleNewNote}
          onCreateFolder={addFolder}
          onDeleteNote={handleDeleteNote}
          onDeleteFolder={handleDeleteFolder}
          onDeleteAttachment={handleDeleteAttachment}
          onRenameNote={handleRenameNote}
          onStartRename={forgetAutoName}
          favoriteNotes={favoriteNotes}
          onToggleFavorite={toggleFavoriteNote}
          revealPath={reveal.path}
          revealNonce={reveal.nonce}
          onStartSession={handleStartCcSession}
          onStartAgentChat={handleStartAgentChat}
        />
      </div>
      <div className="notes-resize-handle" onPointerDown={treeResizePointerDown} />
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
            leading={backToTreeButton}
            trailing={aiToggleButton}
            onCloseOthers={handleCloseOtherTabs}
            onCloseAll={handleCloseAllTabs}
            onLocate={revealInTree}
            onOpenInNewWindow={(path) => openPopout('note', { path })}
            isFavorite={isNoteFavorite}
            onToggleFavorite={toggleFavoriteNote}
          />
        ) : (
          <div className="notes-tab-strip notes-tab-strip-empty">
            <div className="notes-tab-leading">{backToTreeButton}</div>
            <div className="notes-tab-trailing">{aiToggleButton}</div>
          </div>
        )}
        <div className="notes-editor-body">
          {activeTab?.kind === 'attachment' ? (
            <AttachmentPreview notePath={activeTab.path} findQuery={attachmentFind?.path === activeTab.path ? attachmentFind.query : undefined} />
          ) : holding ? (
            <LoadingSpinner />
          ) : !activeNotePath ? (
            <NotesEmptyState onNewNote={() => void handleNewNote('')} />
          ) : missing ? (
            <NoteMissingState path={activeNotePath} onCreate={() => { existedRef.current.delete(activeNotePath); createMissing(); }} onClose={() => handleCloseTab(activeNotePath)} />
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
                remountKey={remountKey}
                content={content}
                updatedAt={updatedAt}
                saveStatus={saveStatus}
                onEditorUpdate={onEditorUpdate}
                onNavigate={handleFollowLink}
                onLocate={() => revealInTree(activeNotePath)}
                onBreadcrumbNavigate={revealInTree}
                pendingExternal={pendingExternal}
                onApplyExternal={applyExternalChange}
                onDismissExternal={dismissExternalChange}
                isFavorite={isNoteFavorite(activeNotePath)}
                onToggleFavorite={() => toggleFavoriteNote(activeNotePath)}
                readOnly={noteLayer.readOnly}
              />
            </div>
          )}
        </div>
      </div>
      {chatOpen && (
        <>
          <div className="notes-chat-divider" onPointerDown={chatResizePointerDown} title="Drag to resize" />
          <div className="notes-chat-pane" data-find-region style={{ flex: `0 0 ${chatWidth}px`, width: chatWidth }}>
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
                        <p style={{ color: 'var(--error)' }}>Failed to start session: {activeCcTab.error}</p>
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
                          viewPlace="notes"
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
      <CommandPalette onNavigate={(p, opts) => handleSelect(p, { newTab: true, ...opts })} onCreate={handleQuickCreate} onPreviewAttachment={handlePreviewAttachment} />
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
