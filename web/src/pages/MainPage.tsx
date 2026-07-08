import { useState, useCallback, useEffect, useMemo, useRef, Fragment } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { SESSION_MODELS } from '@open-walnut/core';
import { useChat, type TaskContext, type ImageAttachment } from '@/hooks/useChat';
import { useAgentConsole } from '@/hooks/useAgentConsole';
import { useConversations } from '@/hooks/useConversations';
import { usePlanMode } from '@/hooks/usePlanMode';
import { useWebSocket, useEvent } from '@/hooks/useWebSocket';
import { useTasksContext } from '@/contexts/TasksContext';
import { useFavorites } from '@/hooks/useFavorites';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useOrdering } from '@/hooks/useOrdering';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { ChatMessage, type RouteInfo } from '@/components/chat/ChatMessage';
import { ChatInput } from '@/components/chat/ChatInput';
import { TodoPanel } from '@/components/tasks/TodoPanel';
import { RoutinesView } from '@/components/routines/RoutinesView';
import { TaskDetailModal } from '@/components/tasks/TaskDetailModal';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import { PendingSessionPanel } from '@/components/sessions/PendingSessionPanel';
import { SessionPathSelector, type QuickStartPath, type QuickStartTaskMeta } from '@/components/sessions/SessionPathSelector';
import { QuestionPopover, parseAskQuestionInput } from '@/components/chat/QuestionPopover';
import { TriagePanel } from '@/components/triage/TriagePanel';
import { fetchSession, fetchSessionsForTask, quickStartSession } from '@/api/sessions';
import { fetchConfig } from '@/api/config';
import { ContextInspectorPanel } from '@/components/context/ContextInspectorPanel';
import { QuickAccessBar } from '@/components/chat/QuickAccessBar';
import { AgentTabBar, slugifyAgentId } from '@/components/chat/AgentTabBar';
import { createAgentDef, updateAgentDef } from '@/api/agents';
import { useContextInspector } from '@/hooks/useContextInspector';
import { useUrlSync } from '@/hooks/useUrlSync';
import { useSessionPanelMode } from '@/hooks/useSessionPanelMode';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { shouldHideUiOnlyMessage } from '@/hooks/useDeveloperSettings';
import { useUiOnlySettings } from '@/hooks/useDeveloperSettings';
import { resolveTaskSessionId } from '@/utils/session-status';
import { FocusDock } from '@/components/dock/FocusDock';
import { SetupBanner } from '@/components/common/SetupBanner';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { getErrorSuggestion } from '@/utils/error-suggestions';
import { ErrorSuggestionLink } from '@/components/common/ErrorSuggestionLink';
import type { SlashCommand } from '@/commands/types';
import type { CommandContext } from '@/commands/types';
import {
  type SessionSlot,
  trimUnlockedToMax,
  addSessionColumn,
  removeSessionColumn,
  replaceSessionColumn,
  toggleLockSlot,
} from './sessionColumns';
import { useAutoAnimate } from '@formkit/auto-animate/react';

// ── Compact chat header with dropdown menu ──

// Prefill template for "Create by chat" (R2). This is PREFILLED into the chat input
// (visible + editable), NOT auto-sent — the user fills in the purpose/name then presses
// Send. Walnut then designs the agent conversationally and calls the agent_create tool.
const AGENT_BUILDER_PREFILL = `Create an interactive agent that shows up in my console. Help me design it, then create it with the agent_create tool (runner: embedded, console: true).

Purpose:
Name (optional): `;

function ChatHeaderRow({ title, connectionState, inspectorOpen, onToggleInspector, hasMessages, onClear, agentSwitcher }: {
  title: string;
  connectionState: string;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  hasMessages: boolean;
  onClear: () => void;
  agentSwitcher?: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div className="chat-header-row">
      <div className="chat-header-meta">
        {agentSwitcher || <span className="chat-header-title">{title}</span>}
        {connectionState !== 'connected' && (
          <span className="text-xs" style={{ color: 'var(--warning)' }}>({connectionState})</span>
        )}
      </div>
      <div className="chat-header-menu-wrap" ref={menuRef}>
        <button
          className="chat-header-menu-btn"
          onClick={() => setMenuOpen(v => !v)}
          aria-label="Chat options"
        >
          &#x22EF;{/* ⋯ horizontal ellipsis */}
        </button>
        {menuOpen && (
          <div className="chat-header-dropdown">
            <button className="chat-header-dropdown-item" onClick={() => { onToggleInspector(); setMenuOpen(false); }}>
              {inspectorOpen ? 'Hide context' : 'Show context'}
            </button>
            {hasMessages && (
              <button className="chat-header-dropdown-item chat-header-dropdown-danger" onClick={() => { onClear(); setMenuOpen(false); }}>
                Clear chat
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const SS_TASK_KEY = 'open-walnut-home-focused-task';
const SS_SUPPRESS_DETAIL_KEY = 'open-walnut-home-suppress-detail';
const SS_SESSION_COLUMNS_KEY = 'open-walnut-home-session-columns';
const SS_TODO_SCROLL_KEY = 'walnut-home-todo-scroll';
const SS_CHAT_VISIBLE_KEY = 'open-walnut-home-chat-visible';
const SS_TODO_VISIBLE_KEY = 'open-walnut-home-todo-visible';
const SS_ROUTINES_VISIBLE_KEY = 'open-walnut-home-routines-visible';

// Legacy key for migration
const SS_SESSION_KEY_LEGACY = 'open-walnut-home-session-panel';

// ── Session column queue helpers ──
// Pure column-queue operations live in ./sessionColumns.ts so they can be
// unit-tested without React. See that file for the layout invariant rationale.

const SESSION_WIDTH_BY_COUNT = [0, 65, 65]; // 1=65%, 2=65% (max width)

/** Load session columns from sessionStorage, with migration from legacy single-session key */
function loadSessionColumns(): SessionSlot[] {
  const saved = sessionStorage.getItem(SS_SESSION_COLUMNS_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        // Accept legacy string[] and current SessionSlot[].
        return parsed.map((entry: unknown) =>
          typeof entry === 'string'
            ? { id: entry, locked: false }
            : { id: (entry as SessionSlot).id, locked: !!(entry as SessionSlot).locked }
        );
      }
    } catch { /* fall through */ }
  }
  // Migrate from legacy single-session key
  const legacy = sessionStorage.getItem(SS_SESSION_KEY_LEGACY);
  if (legacy) {
    sessionStorage.removeItem(SS_SESSION_KEY_LEGACY);
    return [{ id: legacy, locked: false }];
  }
  return [];
}

interface MainPageProps {
  /** Whether MainPage is currently visible (route is /) */
  visible?: boolean;
  /** Stable ref to navigate function — avoids useNavigate() context dependency */
  navigateRef?: React.RefObject<NavigateFunction>;
}

export function MainPage({ visible = true, navigateRef }: MainPageProps) {
  const agentConsole = useAgentConsole();
  const conversations = useConversations(agentConsole.activeAgentId);
  const chat = useChat(agentConsole.activeAgentId, conversations.activeConversationId);
  const { health, loading: healthLoading } = useSystemHealth();
  const { mode: chatMode, toggleMode, getPlanPayload } = usePlanMode();
  const { connectionState } = useWebSocket();
  const { tasks, loading, toggleComplete, setPhase, star, create, update, reorder, moveTask, reparentTask, deleteTask, bakeOrder, clearOperationError, showOperationError, taskGroups, hiddenGroups, groupTasks, addToGroup, ungroupTasks, renameGroup, setGroupHidden } = useTasksContext();
  const favorites = useFavorites();
  const focusBar = useFocusBarContext();
  const pinnedTaskIdSet = useMemo(() => new Set(focusBar.pinnedIds), [focusBar.pinnedIds]);
  const focusTaskIdSet = useMemo(() => new Set(focusBar.focusIds), [focusBar.focusIds]);
  const waitTaskIdSet = useMemo(() => new Set(focusBar.waitIds), [focusBar.waitIds]);
  const ordering = useOrdering();
  // Configured task defaults (platform/category/project) for quick-add capture. Fetched
  // once; refreshed on config:changed. Quick-add ("Add to Focus") routes to these instead
  // of inheriting the active tab's (possibly external-synced) category/source.
  const [taskDefaults, setTaskDefaults] = useState<{ platform?: string; category?: string; project?: string }>({});
  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => { if (alive) setTaskDefaults({ platform: c.defaults?.platform, category: c.defaults?.category, project: c.defaults?.project }); })
      .catch(() => { /* defaults stay empty — falls back to local/Inbox below */ });
    return () => { alive = false; };
  }, []);
  useEvent('config:changed', () => {
    fetchConfig()
      .then((c) => setTaskDefaults({ platform: c.defaults?.platform, category: c.defaults?.category, project: c.defaults?.project }))
      .catch(() => {});
  });
  const [focusedTask, setFocusedTask] = useState<Task | null>(null);
  // Nonce that increments on every focus action — forces re-scroll even for same task
  const [focusNonce, setFocusNonce] = useState(0);
  const inspector = useContextInspector(agentConsole.activeAgentId, conversations.activeConversationId ?? undefined);
  // Force re-render when UI Only settings change (hook subscribes to localStorage)
  useUiOnlySettings();

  const handleNavigateSettings = useCallback((hash?: string) => {
    navigateRef?.current?.(`/settings${hash ?? ''}`);
  }, [navigateRef]);

  // Create a new console agent from the dropdown's inline form, then refresh the
  // agent list (so it appears without reload) and switch to it.
  const handleCreateAgent = useCallback(async (name: string, description: string, systemPrompt?: string) => {
    const id = slugifyAgentId(name);
    const topic = description.trim() || name;
    const autoPrompt = `You are ${name}. ${description || ''}\n\nHelp the user with ${topic}. Be concise and proactive.`;
    // Explicit prompt wins; blank textarea (→ undefined) falls back to the auto-prompt.
    const prompt = systemPrompt?.trim() || autoPrompt;
    try {
      await createAgentDef({ id, name, description: description || undefined, runner: 'embedded', console: true, system_prompt: prompt });
      agentConsole.refresh();
      agentConsole.switchAgent(id);
    } catch (err) {
      console.error('MainPage: failed to create agent', err);
    }
  }, [agentConsole]);

  // ── "Create by chat" (R2) ──
  // Routes the user into Walnut's own chat with a fresh, isolated conversation seeded
  // with a guide prompt. The agent walks the user through designing + calling agent_create.
  // We seed via an EFFECT (not setTimeout): switching agent/conversation re-mounts useChat
  // with a new conversationId, and its internal sendRpc ref lags one render. Firing into a
  // stale conversationId would land the seed in the wrong (old) conversation. So we stash the
  // seed + target id in a ref and wait for activeConversationId to actually settle.
  // "Create by chat": switch to Walnut and PREFILL the agent-builder template into the
  // input (visible + editable, NOT auto-sent). The user fills in purpose/name and sends.
  // A monotonic nonce drives the prefill so ChatInput re-applies it each time.
  const [agentBuilderPrefillNonce, setAgentBuilderPrefillNonce] = useState(0);
  const handleCreateAgentByChat = useCallback(() => {
    agentConsole.switchAgent('general');
    setAgentBuilderPrefillNonce((n) => n + 1);
  }, [agentConsole]);

  // After the agent calls agent_create, refresh the console list so the new agent
  // appears in the switcher without a reload.
  useEvent('agent:tool-result', (data: unknown) => {
    const toolName = (data as { toolName?: string })?.toolName;
    if (toolName === 'agent_create') agentConsole.refresh();
  });

  // Toggle whether an agent appears in the console (eye toggle in the dropdown).
  const handleToggleAgentVisibility = useCallback(async (agentId: string, visible: boolean) => {
    try {
      await updateAgentDef(agentId, { console: visible });
      agentConsole.refresh();
    } catch (err) {
      console.error('MainPage: failed to toggle agent visibility', err);
    }
  }, [agentConsole]);

  // Chat panel visibility — toggle via Focus Dock "Chat" button or Sidebar toggle
  const [chatVisible, setChatVisible] = useState<boolean>(
    () => sessionStorage.getItem(SS_CHAT_VISIBLE_KEY) !== 'false'
  );

  // Todo panel visibility — toggle via Sidebar toggle button
  const [todoVisible, setTodoVisible] = useState<boolean>(
    () => sessionStorage.getItem(SS_TODO_VISIBLE_KEY) !== 'false'
  );

  // Routines panel visibility — hidden by default, toggle via Sidebar
  const [routinesVisible, setRoutinesVisible] = useState<boolean>(
    () => sessionStorage.getItem(SS_ROUTINES_VISIBLE_KEY) === 'true'
  );

  // Session columns state — up to 2 sessions displayed side by side
  const [sessionColumns, setSessionColumns] = useState<SessionSlot[]>(loadSessionColumns);
  // auto-animate attaches to the sessions container and animates child reorder/add/remove
  // with the FLIP technique — same feel as a drag-drop settle, without the jank of
  // View Transitions snapshotting live chat content at the wrong scale.
  const [sessionsAreaAutoAnimateRef] = useAutoAnimate<HTMLDivElement>({
    // 320ms — long enough to read as a physical slide, short enough that rapid
    // lock/unlock still feels responsive. auto-animate's default (250ms) felt
    // slightly snappy against the panel width; 320 lands closer to macOS window
    // shuffle tempo. Easing is iOS "standard" (soft-start, settle).
    duration: 320,
    easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
  });

  // Active category tab — mirrors TodoPanel's tab for URL sync.
  // Initialize from the same localStorage key so the URL reflects the initial tab.
  const [activeCategory, setActiveCategory] = useState<string | undefined>(() => {
    try { return localStorage.getItem('open-walnut-todo-active-tab') ?? undefined; } catch { return undefined; }
  });
  // String[] projection for URL sync (doesn't need lock state — URL carries ids only).
  const sessionColumnIds = useMemo(() => sessionColumns.map(c => c.id), [sessionColumns]);
  const urlSync = useUrlSync({
    focusedTaskId: focusedTask?.id,
    sessionColumns: sessionColumnIds,
    activeCategory,
    visible,
  });

  // Triage panel state — shares the first column slot with sessions
  const [triagePanelOpen, setTriagePanelOpen] = useState(false);
  const triageOpenRef = useRef(triagePanelOpen);
  triageOpenRef.current = triagePanelOpen;
  // Task ID for filtered triage panel (null = show all)
  const [triageTaskId, setTriageTaskId] = useState<string | null>(null);

  // Measure session area container width for auto mode (ResizeObserver)
  const contentRowRef = useRef<HTMLDivElement>(null);
  const [sessionAreaWidth, setSessionAreaWidth] = useState(0);
  useEffect(() => {
    const el = contentRowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSessionAreaWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Session panel mode (1 / 2 / auto) — controls how many sessions shown side by side
  const { effectiveMaxPanels } = useSessionPanelMode(sessionAreaWidth);
  const maxPanelsRef = useRef(effectiveMaxPanels);
  maxPanelsRef.current = effectiveMaxPanels;

  // Auto-evict excess session columns when effectiveMaxPanels shrinks (e.g. auto mode + window resize).
  useEffect(() => {
    setSessionColumns(prev => {
      const max = triageOpenRef.current ? effectiveMaxPanels - 1 : effectiveMaxPanels;
      return trimUnlockedToMax(prev, max);
    });
  }, [effectiveMaxPanels]);

  // Session quick-start state (opened via /session command)
  const [pathSelectorOpen, setPathSelectorOpen] = useState(false);
  const [quickStartPath, setQuickStartPath] = useState<QuickStartPath | null>(null);
  // Task metadata picked in the launcher footer; applied to the new task on quick-start.
  // Using a ref (not state) for two reasons — same pattern as `quickStartPathRef` above:
  //   (1) Avoid re-renders on every keystroke/toggle inside the popover. Meta lives in
  //       SessionPathSelector's local state; the parent only needs the final snapshot
  //       at send-time.
  //   (2) Avoid stale-closure bugs in the async `handleSendMessage` — a ref always
  //       reads the latest value without needing to be in the effect's dep array.
  const quickStartMetaRef = useRef<QuickStartTaskMeta | null>(null);
  // Display mirror of the chosen model so the collapsed Quick Start bar can show &
  // edit it after the picker closes. The ref above stays the send-time source of
  // truth (read in handleSendMessage); this state only drives the visible <select>.
  const [quickStartModel, setQuickStartModel] = useState<string | undefined>(undefined);

  // Quick-start mode: the chat input behaves like a session (skills/commands for
  // the chosen cwd, and "@" file mentions rooted at that cwd + host).
  const { items: quickStartCommands, search: searchQuickStartCommands } = useSlashCommands(
    quickStartPath?.cwd,
    quickStartPath?.host ?? undefined,
  );

  // Set of session IDs currently open in columns — for active pill indicators
  const openSessionIdSet = useMemo(() => new Set(sessionColumns.map(c => c.id)), [sessionColumns]);

  // Reverse map: task IDs whose session is currently open on the home page, so the
  // Pinned/Recent cards can highlight them. A task may own several session IDs
  // (plan/exec/legacy/array) — highlight if ANY of them is an open column.
  const openSessionTaskIds = useMemo(() => {
    const ids = new Set<string>();
    if (openSessionIdSet.size === 0) return ids;
    for (const t of tasks) {
      if (
        (t.session_id && openSessionIdSet.has(t.session_id)) ||
        (t.exec_session_id && openSessionIdSet.has(t.exec_session_id)) ||
        (t.plan_session_id && openSessionIdSet.has(t.plan_session_id)) ||
        t.session_ids?.some((s) => openSessionIdSet.has(s))
      ) ids.add(t.id);
    }
    return ids;
  }, [tasks, openSessionIdSet]);

  // Detect pending ask_question tool call from chat messages
  const pendingQuestion = useMemo(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const msg = chat.messages[i]
      if (msg.role !== 'assistant' || !msg.blocks) continue
      for (const block of msg.blocks) {
        if (block.type === 'tool_call' && block.name === 'user_ask' && block.status === 'calling') {
          return parseAskQuestionInput((block as { input?: Record<string, unknown> }).input)
        }
      }
    }
    return null
  }, [chat.messages])

  // Task lookup map for resolving task IDs to names in tool call UI
  const taskMap = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  // Ref for taskMap — allows callbacks to read the latest without re-creating
  const taskMapRef = useRef(taskMap);
  taskMapRef.current = taskMap;

  // Resizable panels
  const todoPanel = useResizablePanel('open-walnut-todo-width', 25, 'left');
  const sessionPanel = useResizablePanel('walnut-session-panel-width-v2', 35);

  // Merge sessionPanel.panelRef (for width resize observer) with auto-animate's
  // callback ref on the sessions container. Must be stable — a new function
  // identity on every render would remount the container and wipe animations,
  // and in React 18 a changing ref callback re-runs with null then the element,
  // which has caused infinite loops in the past.
  const sessionsAreaCombinedRef = useCallback((el: HTMLDivElement | null) => {
    (sessionPanel.panelRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    sessionsAreaAutoAnimateRef(el);
  }, [sessionPanel.panelRef, sessionsAreaAutoAnimateRef]);

  // Column split ratio: left column gets splitPct%, right gets (100-splitPct)%
  const [colSplitPct, setColSplitPct] = useState(() => {
    try { const v = parseFloat(localStorage.getItem('open-walnut-col-split') ?? ''); return isNaN(v) ? 50 : Math.min(80, Math.max(20, v)); } catch { return 50; }
  });
  const colSplitRef = useRef(colSplitPct);
  colSplitRef.current = colSplitPct;
  useEffect(() => { try { localStorage.setItem('open-walnut-col-split', String(colSplitPct)); } catch {} }, [colSplitPct]);

  const handleColSplitStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const sessionsEl = sessionPanel.panelRef.current;
    if (!sessionsEl) return;
    const startX = e.clientX;
    const startPct = colSplitRef.current;
    const areaRect = sessionsEl.getBoundingClientRect();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    sessionsEl.classList.add('resizing');
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const deltaPct = (dx / areaRect.width) * 100;
      setColSplitPct(Math.min(80, Math.max(20, startPct + deltaPct)));
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      sessionsEl.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sessionPanel.panelRef]);

  // Graduated session area width — use total session count (not visible) so tabbed
  // sessions still get full width. Only auto-set when count increases.
  const prevColCountRef = useRef(0);
  useEffect(() => {
    const count = sessionColumns.length + (triagePanelOpen ? 1 : 0);
    if (count === prevColCountRef.current) return;
    const prev = prevColCountRef.current;
    prevColCountRef.current = count;
    // Only auto-set width when opening panels (0→1, 1→2), not when closing
    if (count > prev && count > 0) sessionPanel.setPct(SESSION_WIDTH_BY_COUNT[Math.min(count, 2)]);
  }, [sessionColumns.length, triagePanelOpen, sessionPanel.setPct]);

  // Keep focusedTask in sync with latest data from tasks array (handles WS updates from other sources)
  useEffect(() => {
    if (!focusedTask) return;
    const fresh = tasks.find((t) => t.id === focusedTask.id);
    if (!fresh) { setFocusedTask(null); return; }
    if (fresh !== focusedTask && fresh.updated_at !== focusedTask.updated_at) {
      setFocusedTask(fresh);
    }
  }, [tasks, focusedTask]);

  // Restore state once tasks have loaded — URL params take priority over sessionStorage.
  // Also handles popstate events (browser back/forward) that arrive after initial load.
  const restoredTaskRef = useRef(false);
  useEffect(() => {
    // Apply URL pending state (initial load or popstate)
    if (urlSync.pending) {
      // On initial load, wait for tasks to arrive before applying
      if (!restoredTaskRef.current && loading) return;
      restoredTaskRef.current = true;
      const p = urlSync.pending;
      if (p.taskId) {
        const task = tasks.find(t => t.id === p.taskId);
        if (task) setFocusedTask(task);
      }
      if (p.sessionIds.length > 0) {
        // URL carries ids only — preserve lock state from sessionStorage where ids match.
        const saved = loadSessionColumns();
        const lockedById = new Map(saved.map(s => [s.id, s.locked]));
        setSessionColumns(
          p.sessionIds.slice(0, maxPanelsRef.current).map(id => ({ id, locked: lockedById.get(id) ?? false }))
        );
      }
      if (p.category !== null) setActiveCategory(p.category);
      urlSync.clearPending();
      return;
    }

    // No URL params — fallback to sessionStorage restore (once)
    if (loading || restoredTaskRef.current) return;
    restoredTaskRef.current = true;
    const savedTaskId = sessionStorage.getItem(SS_TASK_KEY);
    if (savedTaskId && !focusedTask) {
      const task = tasks.find((t) => t.id === savedTaskId);
      if (task) setFocusedTask(task);
    }
  }, [loading, tasks, focusedTask, urlSync.pending, urlSync.clearPending]);

  // Restore state from sessionStorage when returning from another page.
  // This is a defensive safety net: if React state was somehow lost while hidden,
  // re-read from sessionStorage when becoming visible again.
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    const wasHidden = !prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible || !wasHidden) return;
    // Becoming visible — check if state needs restoration
    if (!focusedTask && tasks.length > 0) {
      const savedTaskId = sessionStorage.getItem(SS_TASK_KEY);
      if (savedTaskId) {
        const task = tasks.find((t) => t.id === savedTaskId);
        if (task) setFocusedTask(task);
      }
    }
    if (sessionColumns.length === 0) {
      const restored = loadSessionColumns();
      if (restored.length > 0) setSessionColumns(restored.slice(0, maxPanelsRef.current));
    }
    // visible/tasks/focusedTask/sessionColumns are intentional — this effect only fires
    // when the page becomes visible again, not on every sessionColumns tick.
  }, [visible, tasks, focusedTask, sessionColumns]);

  // Persist focusedTask.id to sessionStorage
  // Guard: don't clear until restore has run, otherwise the initial null state
  // wipes the saved value before it can be read back.
  useEffect(() => {
    if (focusedTask?.id) sessionStorage.setItem(SS_TASK_KEY, focusedTask.id);
    else if (restoredTaskRef.current) sessionStorage.removeItem(SS_TASK_KEY);
  }, [focusedTask?.id]);

  useEffect(() => {
    // Only persist real session IDs (not pending: placeholders) to sessionStorage
    const persistable = sessionColumns.filter(s => !s.id.startsWith('pending:'));
    if (persistable.length > 0) sessionStorage.setItem(SS_SESSION_COLUMNS_KEY, JSON.stringify(persistable));
    else sessionStorage.removeItem(SS_SESSION_COLUMNS_KEY);
  }, [sessionColumns]);

  // Persist chatVisible + broadcast to FocusDock / Sidebar
  useEffect(() => {
    sessionStorage.setItem(SS_CHAT_VISIBLE_KEY, String(chatVisible));
    window.dispatchEvent(new CustomEvent('main:chat-visible', { detail: { visible: chatVisible } }));
  }, [chatVisible]);

  // Persist todoVisible + broadcast to Sidebar
  useEffect(() => {
    sessionStorage.setItem(SS_TODO_VISIBLE_KEY, String(todoVisible));
    window.dispatchEvent(new CustomEvent('main:todo-visible', { detail: { visible: todoVisible } }));
  }, [todoVisible]);

  // Persist routinesVisible + broadcast to Sidebar
  useEffect(() => {
    sessionStorage.setItem(SS_ROUTINES_VISIBLE_KEY, String(routinesVisible));
    window.dispatchEvent(new CustomEvent('main:routines-visible', { detail: { visible: routinesVisible } }));
  }, [routinesVisible]);

  // ── Listen for FocusDock events ──
  useEffect(() => {
    const handleDockTask = (e: Event) => {
      const { taskId, sessionId } = (e as CustomEvent).detail as { taskId: string; sessionId?: string };
      const task = taskMapRef.current.get(taskId);
      if (task) setFocusedTask(task);
      if (sessionId) openSessionOrToast(sessionId);
    };
    const handleDockChat = () => {
      // Toggle main chat panel visibility
      setChatVisible(prev => !prev);
    };
    const handleSessionLauncher = () => setPathSelectorOpen(true);
    const handleToggleTodo = () => setTodoVisible(prev => !prev);
    const handleToggleRoutines = () => setRoutinesVisible(prev => !prev);
    window.addEventListener('dock:activate-task', handleDockTask);
    window.addEventListener('dock:activate-chat', handleDockChat);
    window.addEventListener('session-launcher:open', handleSessionLauncher);
    window.addEventListener('sidebar:toggle-todo', handleToggleTodo);
    window.addEventListener('sidebar:toggle-routines', handleToggleRoutines);
    return () => {
      window.removeEventListener('dock:activate-task', handleDockTask);
      window.removeEventListener('dock:activate-chat', handleDockChat);
      window.removeEventListener('session-launcher:open', handleSessionLauncher);
      window.removeEventListener('sidebar:toggle-todo', handleToggleTodo);
      window.removeEventListener('sidebar:toggle-routines', handleToggleRoutines);
    };
  }, []);

  // Persist & restore todo panel scroll position (once after initial load)
  const restoredScrollRef = useRef(false);
  useEffect(() => {
    if (loading) return;
    const el = document.querySelector('.todo-panel-list') as HTMLElement | null;
    if (!el) return;
    // Restore saved scroll position (once)
    if (!restoredScrollRef.current) {
      restoredScrollRef.current = true;
      const saved = Number(sessionStorage.getItem(SS_TODO_SCROLL_KEY));
      if (saved > 0) requestAnimationFrame(() => { el.scrollTop = saved; });
    }
    // Save on scroll (debounced)
    let timer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => sessionStorage.setItem(SS_TODO_SCROLL_KEY, String(el.scrollTop)), 150);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); clearTimeout(timer); };
  }, [loading]);

  // Session columns ref — lets handlers peek at current state synchronously
  // (e.g. to decide whether a new-session request should toast instead of commit).
  const sessionColumnsRef = useRef(sessionColumns);
  sessionColumnsRef.current = sessionColumns;

  // ── Session column handlers ──
  // Clicking a session pill always opens/moves to rightmost — use close button to dismiss.
  // Single path for "open a session, with toast if fully locked" — shared by pill
  // clicks, dock events, chat session-link clicks.
  const openSessionOrToast = useCallback((sessionId: string) => {
    const current = sessionColumnsRef.current;
    const next = addSessionColumn(current, sessionId, triageOpenRef.current, maxPanelsRef.current);
    if (next === current && !current.some(c => c.id === sessionId)) {
      showOperationError('All session panels are locked. Unlock one to open a new session.');
      return;
    }
    setSessionColumns(next);
  }, [showOperationError]);

  const handleToggleSession = openSessionOrToast;

  const handleCloseSession = useCallback((sessionId: string) => {
    setSessionColumns(prev => removeSessionColumn(prev, sessionId));
  }, []);

  // Lock toggle — reorders slot; auto-animate handles the smooth slide.
  const handleToggleLockSession = useCallback((sessionId: string) => {
    setSessionColumns(prev => toggleLockSlot(prev, sessionId));
  }, []);

  // Per-column session-replaced handler factory (plan→exec transitions)
  const handleSessionReplaced = useCallback((oldId: string, newId: string) => {
    setSessionColumns(prev => replaceSessionColumn(prev, oldId, newId));
  }, []);

  // Auto-switch session panel when "Clear Context & Execute" creates a new exec session
  useEvent('session:status-changed', (data: unknown) => {
    const d = data as { sessionId?: string; fromPlanSessionId?: string };
    if (d.fromPlanSessionId && d.sessionId) {
      setSessionColumns(prev =>
        prev.some(c => c.id === d.fromPlanSessionId)
          ? replaceSessionColumn(prev, d.fromPlanSessionId!, d.sessionId!)
          : prev
      );
    }
  });

  // ── Quick Start retry handler ──
  const handleQuickStartRetry = useCallback(() => {
    const meta = pendingQuickStartMetaRef.current;
    if (!meta || !meta.message) return;

    // Clear the httpError so panel goes back to spinner
    pendingQuickStartMetaRef.current = { ...meta, httpError: undefined };

    quickStartSession({
      cwd: meta.cwd,
      host: meta.host,
      message: meta.message,
      taskId: meta.realTaskId, // reuse existing task if we have one
    }).then((result) => {
      // Update refs with (possibly new) taskId
      if (pendingQuickStartRef.current) {
        pendingQuickStartRef.current = result.taskId;
      }
      if (pendingQuickStartMetaRef.current?.id === meta.id) {
        pendingQuickStartMetaRef.current = { ...pendingQuickStartMetaRef.current, realTaskId: result.taskId, httpError: undefined };
      }
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (pendingQuickStartMetaRef.current?.id === meta.id) {
        pendingQuickStartMetaRef.current = { ...pendingQuickStartMetaRef.current, httpError: errMsg };
      }
      setSessionColumns(prev => [...prev]); // force re-render (identity change)
    });
  }, []);

  // ── Triage panel handlers ──
  const handleOpenTriageForTask = useCallback((taskId: string) => {
    setTriagePanelOpen(true);
    setTriageTaskId(taskId);
    // Triage consumes one slot — evict unlocked slots first, keep locked.
    setSessionColumns(prev => trimUnlockedToMax(prev, maxPanelsRef.current - 1));
  }, []);

  const handleCloseTriage = useCallback(() => {
    setTriagePanelOpen(false);
    setTriageTaskId(null);
  }, []);

  // Quick-start: track pending taskId, auto-open session panel when it starts
  const pendingQuickStartRef = useRef<string | null>(null);
  // Metadata for the pending session panel (cwd, host, etc.)
  const pendingQuickStartMetaRef = useRef<{ id: string; cwd: string; host?: string; hostLabel?: string; realTaskId?: string; message?: string; httpError?: string } | null>(null);

  // Fork: pending panel metadata (same pattern as quick-start)
  const pendingForkMetaRef = useRef<{ id: string; cwd: string; host?: string; realTaskId?: string; httpError?: string } | null>(null);
  const pendingForkTaskRef = useRef<string | null>(null);

  // Path selector → select handler
  const handlePathSelect = useCallback((path: QuickStartPath, taskMeta: QuickStartTaskMeta) => {
    setQuickStartPath(path);
    quickStartMetaRef.current = taskMeta;
    setQuickStartModel(taskMeta.model);   // mirror for the collapsed bar's <select>
    setPathSelectorOpen(false);
  }, []);

  // Auto-open session panel when a quick-start or fork session resolves.
  // Strategy: listen to task:updated events (fires after linkSession persists the
  // session record). Also poll as fallback in case the WS event is missed.
  const openPendingSession = useCallback((data: unknown) => {
    const d = data as Record<string, unknown>;
    const task = d.task as { id?: string; exec_session_id?: string; plan_session_id?: string } | undefined;
    if (!task?.id) return;
    const sessionId = task.exec_session_id ?? task.plan_session_id;
    if (!sessionId) return;

    // Check quick-start pending
    if (pendingQuickStartRef.current && task.id === pendingQuickStartRef.current) {
      const pendingMeta = pendingQuickStartMetaRef.current;
      pendingQuickStartRef.current = null;
      pendingQuickStartMetaRef.current = null;
      if (pendingPollRef.current) { clearInterval(pendingPollRef.current); pendingPollRef.current = null; }
      if (pendingMeta) {
        setSessionColumns(prev => replaceSessionColumn(prev, pendingMeta.id, sessionId));
      } else {
        setSessionColumns(prev => addSessionColumn(prev, sessionId, triageOpenRef.current, maxPanelsRef.current));
      }
      return;
    }

    // Check fork pending
    if (pendingForkTaskRef.current && task.id === pendingForkTaskRef.current) {
      const meta = pendingForkMetaRef.current;
      pendingForkTaskRef.current = null;
      pendingForkMetaRef.current = null;
      if (pendingPollRef.current) { clearInterval(pendingPollRef.current); pendingPollRef.current = null; }
      if (meta) {
        setSessionColumns(prev => replaceSessionColumn(prev, meta.id, sessionId));
      } else {
        setSessionColumns(prev => addSessionColumn(prev, sessionId, triageOpenRef.current, maxPanelsRef.current));
      }
      return;
    }
  }, []);
  useEvent('task:updated', openPendingSession);

  // Fallback poll: if WS events are missed, poll for the session ID every 2s
  const pendingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    return () => { if (pendingPollRef.current) clearInterval(pendingPollRef.current); };
  }, []);
  // Start polling when a pending column exists
  useEffect(() => {
    const hasPending = sessionColumns.some(s => s.id.startsWith('pending:'));
    if (!hasPending || pendingPollRef.current) return;
    pendingPollRef.current = setInterval(async () => {
      // Try quick-start pending
      const qsTaskId = pendingQuickStartRef.current;
      if (qsTaskId && !qsTaskId.startsWith('pending-')) {
        try {
          const sessions = await fetchSessionsForTask(qsTaskId);
          const active = sessions.find(s => s.claudeSessionId);
          if (active) {
            const pendingMeta = pendingQuickStartMetaRef.current;
            pendingQuickStartRef.current = null;
            pendingQuickStartMetaRef.current = null;
            clearInterval(pendingPollRef.current!);
            pendingPollRef.current = null;
            if (pendingMeta) {
              setSessionColumns(prev => replaceSessionColumn(prev, pendingMeta.id, active.claudeSessionId));
            } else {
              setSessionColumns(prev => addSessionColumn(prev, active.claudeSessionId, triageOpenRef.current, maxPanelsRef.current));
            }
            return;
          }
        } catch { /* retry on next tick */ }
      }
      // Try fork pending
      const forkTaskId = pendingForkTaskRef.current;
      if (forkTaskId) {
        try {
          const sessions = await fetchSessionsForTask(forkTaskId);
          const active = sessions.find(s => s.claudeSessionId);
          if (active) {
            const meta = pendingForkMetaRef.current;
            pendingForkTaskRef.current = null;
            pendingForkMetaRef.current = null;
            clearInterval(pendingPollRef.current!);
            pendingPollRef.current = null;
            if (meta) {
              setSessionColumns(prev => replaceSessionColumn(prev, meta.id, active.claudeSessionId));
            } else {
              setSessionColumns(prev => addSessionColumn(prev, active.claudeSessionId, triageOpenRef.current, maxPanelsRef.current));
            }
            return;
          }
        } catch { /* retry on next tick */ }
      }
    }, 2000);
  }, [sessionColumns]);

  // ── Fork pending handlers ──
  const handleForkPending = useCallback((cwd: string, host?: string) => {
    const pendingColId = `pending:fork-${Date.now()}`;
    pendingForkMetaRef.current = { id: pendingColId, cwd, host };
    setSessionColumns(prev => addSessionColumn(prev, pendingColId, triageOpenRef.current, maxPanelsRef.current));
  }, []);

  const handleForkResolved = useCallback((taskId: string) => {
    // Store the real taskId so WS events + polling can resolve the pending panel
    pendingForkTaskRef.current = taskId;
    if (pendingForkMetaRef.current) {
      pendingForkMetaRef.current = { ...pendingForkMetaRef.current, realTaskId: taskId };
    }
  }, []);

  const handleForkFailed = useCallback((errorMessage?: string) => {
    if (pendingForkMetaRef.current) {
      pendingForkMetaRef.current = {
        ...pendingForkMetaRef.current,
        httpError: errorMessage || 'Fork failed',
      };
      setSessionColumns(prev => [...prev]); // force re-render (identity change)
    }
  }, []);

  // Handle session click from chat: focus the associated task + open session column
  const handleSessionClick = useCallback(async (sessionId: string) => {
    // Add session column
    setSessionColumns(prev => addSessionColumn(prev, sessionId, triageOpenRef.current, maxPanelsRef.current));
    // Fetch session to find its associated task
    try {
      const session = await fetchSession(sessionId);
      if (session?.taskId) {
        const task = taskMapRef.current.get(session.taskId);
        if (task) setFocusedTask(task);
      }
    } catch { /* non-critical */ }
  }, []);

  const handleCreate = useCallback(async (input: { title: string; priority: string; category?: string; project?: string; starred?: boolean; pinnedTier?: 'focus' | 'satellite' | 'wait'; capture?: boolean }) => {
    const tier = input.pinnedTier;
    // Quick-capture ("Add to Focus/Satellite/Wait", Focus Dock) routes to the user's
    // configured Default Platform + Category instead of the active tab's category — so a
    // capture made while viewing an external-synced tab (e.g. personal → MS To-Do) still
    // lands in the fast local Inbox unless the user changed the default. Falls back to
    // local/Inbox if config hasn't loaded. The main Quick Add form (explicit category
    // picker) is NOT a capture and keeps its chosen category/source.
    const captureCategory = taskDefaults.category || 'Inbox';
    const captureSource = taskDefaults.platform || 'local';
    const task = await create(
      {
        title: input.title,
        priority: input.priority as 'high' | 'low' | 'none',
        category: input.capture ? captureCategory : input.category,
        project: input.capture ? taskDefaults.project : input.project,
        ...(input.capture ? { source: captureSource } : {}),
      },
      tier
        ? {
            onOptimistic: (tempId) => focusBar.addLocalPin(tempId, tier),
            onReconcile: (tempId, realId) => {
              focusBar.replaceLocalPinId(tempId, realId);
              // Persist to the server (pin + tier). Optimistic state already shows it,
              // so a failure just rolls the row back out of the tier.
              focusBar.commitPin(realId, tier).catch(() => focusBar.removeLocalPin(realId));
            },
            onError: (tempId) => focusBar.removeLocalPin(tempId),
          }
        : undefined,
    );
    try {
      if (input.starred && task?.id) star(task.id);
      if (tier && task?.id) {
        // Locate the task wherever it landed. Focusing it scrolls the Pinned region to
        // the right tier card. Set focus directly from the returned task object —
        // dispatching the dock event alone is unreliable because the task may not be in
        // the local map yet (arrives via WS).
        setFocusedTask(task);
        setFocusNonce((n) => n + 1);
        window.dispatchEvent(new CustomEvent('dock:activate-task', { detail: { taskId: task.id } }));
      }
    } catch (err) {
      console.warn('Quick add post-create side-effect failed', err);
    }
    return task;
  }, [create, star, focusBar, taskDefaults]);

  // Inline "+" in the Focus Dock — create a task and pin it straight to the Focus tier.
  // capture:true routes it to the configured Default Platform/Category (fast local Inbox
  // by default) rather than the active tab.
  const handleQuickAddToFocus = useCallback(async (title: string) => {
    await handleCreate({ title, priority: 'none', pinnedTier: 'focus', capture: true });
  }, [handleCreate]);

  // Ref to avoid re-creating handleFocusTask on every focus change (which defeats React.memo on TodoPanel)
  const focusedTaskRef = useRef(focusedTask);
  focusedTaskRef.current = focusedTask;

  const [suppressDetail, setSuppressDetail] = useState(() => {
    try { return sessionStorage.getItem(SS_SUPPRESS_DETAIL_KEY) === '1'; } catch { return false; }
  });

  // Persist suppressDetail so the detail panel open/closed state survives refresh.
  useEffect(() => {
    sessionStorage.setItem(SS_SUPPRESS_DETAIL_KEY, suppressDetail ? '1' : '0');
  }, [suppressDetail]);

  const handleFocusTask = useCallback((task: Task, opts?: { openDetail?: boolean }) => {
    const isRefocus = focusedTaskRef.current?.id === task.id;
    // Always focus (never toggle off) — unfocusing is done via detail panel close / Esc.
    // Increment nonce so TodoPanel re-scrolls even when the same task is re-clicked.
    setFocusedTask(task);
    setFocusNonce(n => n + 1);
    setSuppressDetail(opts?.openDetail === false); // Auto-clears on next direct click (opts is undefined → false)
    // Clear attention flag on new focus (not re-focus)
    if (!isRefocus && task.needs_attention) {
      update(task.id, { needs_attention: false });
    }
  }, [update]);

  // Unified task-click: select + scroll + open session (if any). Never open detail panel.
  // Used by chat refs, session panels, triage — must behave identically to TodoPanel/PinnedCard clicks.
  const handleFocusTaskById = useCallback((taskId: string) => {
    const task = taskMapRef.current.get(taskId);
    if (!task) return;
    const sid = resolveTaskSessionId(task);
    if (sid) handleToggleSession(sid);
    handleFocusTask(task, { openDetail: false });
  }, [handleFocusTask, handleToggleSession]);

  const handleClearFocus = useCallback(() => {
    setFocusedTask(null);
    setSuppressDetail(false);
  }, []);

  // Open the full-screen task detail modal for a taskId (used by the Session panel
  // kebab "Task detail"). Unlike handleFocusTaskById this OPENS the detail (no
  // suppressDetail) and does not touch the session panel rotation.
  const handleOpenTaskDetailById = useCallback((taskId: string) => {
    const task = taskMapRef.current.get(taskId);
    if (!task) return;
    setFocusedTask(task);
    setFocusNonce(n => n + 1);
    setSuppressDetail(false);
  }, []);

  // Escape key unfocuses the current task (since clicking no longer toggles off)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && focusedTaskRef.current && !e.defaultPrevented) {
        // Don't unfocus if a modal/dialog/popover is open (they handle Escape themselves)
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).isContentEditable)) return;
        setFocusedTask(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleComplete = useCallback((id: string) => {
    const task = taskMapRef.current.get(id);
    if (task && task.status !== 'done' && focusedTaskRef.current?.id === id) setFocusedTask(null);
    toggleComplete(id);
  }, [toggleComplete]);

  const handleSetPhase = useCallback((id: string, phase: string) => {
    if (phase === 'COMPLETE' && focusedTaskRef.current?.id === id) setFocusedTask(null);
    setPhase(id, phase);
  }, [setPhase]);

  const handleSetPriority = useCallback((id: string, priority: string) => {
    update(id, { priority });
  }, [update]);

  const handleSetDate = useCallback((id: string, date: string | null) => {
    update(id, { due_date: date ?? '' });
  }, [update]);

  const handleUpdate = useCallback((id: string, updates: { title?: string }) => {
    update(id, updates);
  }, [update]);

  // Ref to hold quickStartPath for the async callback (avoids stale closure)
  const quickStartPathRef = useRef(quickStartPath);
  quickStartPathRef.current = quickStartPath;

  const handleSendMessage = useCallback((text: string, images?: ImageAttachment[]) => {
    const qsp = quickStartPathRef.current;

    // Quick-start interception: when a path is selected, create task + start session
    if (qsp) {
      setQuickStartPath(null);
      setQuickStartModel(undefined);   // clear the collapsed-bar model mirror
      // Local echo as a collapsible bubble — auto-collapses to "⚡ Quick Start on <cwd>"
      // with a chevron the user can click to see the full pasted prompt. The agent
      // reorganize message sent later (source: 'quick-start') is suppressed in the UI
      // (see ChatMessage.tsx), so this echo is the single visual confirmation.
      chat.addLocalMessage(
        `Quick Start on \`${qsp.cwd}\`${qsp.host ? ` (${qsp.hostLabel ?? qsp.host})` : ''}:\n> ${text}`,
        'quick-start-echo',
      );

      // Set pending ref BEFORE the async call so WS events that arrive
      // during the HTTP round-trip can still match via taskId
      const tempTaskId = `pending-${Date.now()}`;
      pendingQuickStartRef.current = tempTaskId;

      // Immediately open a pending session column for instant visual feedback
      const pendingColId = `pending:${tempTaskId}`;
      setSessionColumns(prev => addSessionColumn(prev, pendingColId, triageOpenRef.current, maxPanelsRef.current));
      // Store pending metadata for rendering
      pendingQuickStartMetaRef.current = { id: pendingColId, cwd: qsp.cwd, host: qsp.host ?? undefined, hostLabel: qsp.hostLabel ?? undefined, message: text };

      // Snapshot + clear meta ref BEFORE the async call so a subsequent /session
      // doesn't pick up the stale meta while this one is in flight.
      const metaSnapshot = quickStartMetaRef.current;
      quickStartMetaRef.current = null;
      const taskMeta = metaSnapshot ? {
        starred: metaSnapshot.starred,
        needs_attention: metaSnapshot.needs_attention,
        priority: metaSnapshot.priority,
        pinTier: metaSnapshot.pinTier,
      } : undefined;
      // Model is a session arg, not task metadata. undefined = Auto (let the
      // CLI/config default decide) — only forwarded when the user picks one.
      const model = metaSnapshot?.model;

      quickStartSession({
        cwd: qsp.cwd,
        host: qsp.host ?? undefined,
        message: text,
        images,
        taskMeta,
        model,
      }).then((result) => {
        // Update ref with real taskId (WS events use this to match)
        if (pendingQuickStartRef.current === tempTaskId) {
          pendingQuickStartRef.current = result.taskId;
        }
        // Store real taskId so PendingSessionPanel can match error events
        if (pendingQuickStartMetaRef.current?.id === pendingColId) {
          pendingQuickStartMetaRef.current = { ...pendingQuickStartMetaRef.current, realTaskId: result.taskId };
        }
        // Notify main agent to reorganize the task (include user's prompt)
        const agentMsg = [
          `[Quick Start] Session created and running.`,
          `- Task ID: ${result.taskId}`,
          `- Path: ${qsp.cwd}`,
          `- Category: Inbox / Quick Start`,
          `- User prompt: "${text}"`,
          ``,
          `Please update the task:`,
          `1. Set a descriptive title (replace "Session: ...")`,
          `2. Move to the correct category and project if needed`,
        ].join('\n');
        // Images already sent to the session via quickStartSession() — don't duplicate
        chat.sendMessage(agentMsg, undefined, undefined, 'quick-start');
      }).catch((err) => {
        // Keep the pending column visible with error — user can Retry from panel
        const errMsg = err instanceof Error ? err.message : String(err);
        if (pendingQuickStartMetaRef.current?.id === pendingColId) {
          pendingQuickStartMetaRef.current = { ...pendingQuickStartMetaRef.current, httpError: errMsg };
        }
        // Force re-render by updating sessionColumns in-place (identity change)
        setSessionColumns(prev => [...prev]);
        chat.addLocalMessage(`Quick Start failed: ${errMsg}`);
      });
      return;
    }

    if (focusedTask) {
      // Truncate large text fields before sending over WebSocket to avoid
      // serializing multi-KB payloads — backend truncates too, but this saves wire bytes.
      const truncate = (s: string | undefined, max: number) =>
        s && s.length > max ? s.slice(0, max) : s;

      const taskContext: TaskContext = {
        id: focusedTask.id,
        title: focusedTask.title,
        category: focusedTask.category,
        project: focusedTask.project,
        status: focusedTask.status,
        phase: focusedTask.phase,
        priority: focusedTask.priority,
        starred: focusedTask.starred,
        due_date: focusedTask.due_date,
        source: focusedTask.source,
        description: truncate(focusedTask.description, 350) ?? focusedTask.description,
        summary: truncate(focusedTask.summary, 250) ?? focusedTask.summary,
        note: truncate(focusedTask.note, 550) ?? focusedTask.note,
        conversation_log: focusedTask.conversation_log && focusedTask.conversation_log.length > 500
          ? focusedTask.conversation_log.slice(-500)
          : focusedTask.conversation_log,
        created_at: focusedTask.created_at,
        plan_session_id: focusedTask.plan_session_id,
        plan_session_status: focusedTask.plan_session_status,
        exec_session_id: focusedTask.exec_session_id,
        exec_session_status: focusedTask.exec_session_status,
        subtasks: focusedTask.subtasks?.map(s => ({ id: s.id, title: s.title, done: s.done })),
      };
      const plan = getPlanPayload();
      chat.sendMessage(text, taskContext, images, undefined, plan.mode, plan.planModeFirst, plan.planModeOff);
      // Clear task quote after sending — quote is bound to the message, not persistent
      setFocusedTask(null);
    } else {
      const plan = getPlanPayload();
      chat.sendMessage(text, undefined, images, undefined, plan.mode, plan.planModeFirst, plan.planModeOff);
    }
  }, [chat, focusedTask, getPlanPayload]);

  const handleCommand = useCallback((cmd: SlashCommand, args?: string) => {
    const ctx: CommandContext = {
      sendMessage: (text: string) => handleSendMessage(text),
      clearMessages: () => chat.clearMessages(),
      addLocalMessage: (content: string) => chat.addLocalMessage(content),
      navigate: navigateRef?.current ?? (() => {}),
      args,
      agentId: agentConsole.activeAgentId,
      conversationId: conversations.activeConversationId ?? undefined,
    };
    cmd.execute(ctx);
  }, [handleSendMessage, chat, navigateRef, agentConsole.activeAgentId, conversations.activeConversationId]);

  const chatTitle = focusedTask
    ? `Chat — ${focusedTask.title}`
    : 'Chat';

  return (
    <div className="main-page" style={{ position: 'relative' }}>

      {/* Todo Panel (LEFT — collapsible via Sidebar toggle) */}
      <div
        ref={todoPanel.panelRef}
        className={`main-page-todo${todoVisible ? '' : ' collapsed'}`}
        style={todoVisible ? { width: todoPanel.width } : undefined}
      >
        <TodoPanel
          tasks={tasks}
          loading={loading}
          onComplete={handleComplete}
          onSetPhase={handleSetPhase}
          onCreate={handleCreate}
          onUpdate={handleUpdate}
          onStar={star}
          onDelete={deleteTask}
          onSetPriority={handleSetPriority}
          onSetDate={handleSetDate}
          onFocusTask={handleFocusTask}
          onClearFocus={handleClearFocus}
          focusedTaskId={focusedTask?.id}
          focusNonce={focusNonce}
          favorites={favorites}
          ordering={ordering}
          onReorder={reorder}
          onMoveTask={moveTask}
          onReparentTask={reparentTask}
          onBakeOrder={bakeOrder}
          taskGroups={taskGroups}
          hiddenGroups={hiddenGroups}
          onGroupTasks={groupTasks}
          onAddToGroup={addToGroup}
          onUngroupTask={(taskId) => ungroupTasks([taskId])}
          onUngroupTasks={ungroupTasks}
          onRenameGroup={renameGroup}
          onSetGroupHidden={setGroupHidden}
          onOpenSession={handleToggleSession}
          onTaskClick={handleFocusTaskById}
          openSessionIds={openSessionIdSet}
          openSessionTaskIds={openSessionTaskIds}
          onOpenTriageForTask={handleOpenTriageForTask}
          onPinTask={focusBar.pin}
          onUnpinTask={focusBar.unpin}
          onReorderPinned={focusBar.reorder}
          onSetTier={focusBar.setTier}
          pinnedTaskIds={pinnedTaskIdSet}
          focusTaskIds={focusTaskIdSet}
          waitTaskIds={waitTaskIdSet}
          suppressDetail={suppressDetail}
          onClearOperationError={clearOperationError}
          onOperationError={showOperationError}
          externalCategory={activeCategory}
          onCategoryChange={setActiveCategory}
        />
      </div>

      {/* Todo Resize Handle — only shown when todo is visible */}
      {todoVisible && <div className="todo-resize-handle" onMouseDown={todoPanel.handleResizeStart} />}

      {/* Routines Panel (slide-out, toggled via Sidebar) */}
      {routinesVisible && (
        <div className="main-page-routines">
          <div className="routines-panel-header">
            <span className="routines-panel-title">&#9889; Routines</span>
            <button
              className="btn btn-sm"
              onClick={() => setRoutinesVisible(false)}
              title="Close routines"
            >
              &#10005;
            </button>
          </div>
          <div className="routines-panel-body">
            <RoutinesView compact />
          </div>
        </div>
      )}

      {/* Right column: Chat + Sessions + FocusDock */}
      <div className="main-page-right">
      <div className="main-page-content-row" ref={contentRowRef}>

      {/* Chat Panel — collapsible via Sidebar / Focus Dock toggle */}
      <div className={`main-page-chat${chatVisible ? '' : ' collapsed'}`}>
        <div className="chat-page">
          <ChatHeaderRow
            title={chatTitle}
            connectionState={connectionState}
            inspectorOpen={inspector.isOpen}
            onToggleInspector={inspector.toggle}
            hasMessages={chat.messages.length > 0}
            onClear={chat.clearMessages}
            agentSwitcher={(
              <AgentTabBar
                agents={agentConsole.agents}
                activeAgentId={agentConsole.activeAgentId}
                onSwitchAgent={agentConsole.switchAgent}
                conversations={conversations.conversations}
                activeConversationId={conversations.activeConversationId}
                onSwitchConversation={conversations.switchTo}
                onNewConversation={() => { void conversations.create(); }}
                onDeleteConversation={(cid) => { void conversations.remove(cid); }}
                onRenameConversation={(cid, title) => { void conversations.rename(cid, title); }}
                onCreateAgent={handleCreateAgent}
                onCreateAgentByChat={handleCreateAgentByChat}
                onToggleAgentVisibility={handleToggleAgentVisibility}
              />
            )}
          />

          {inspector.isOpen && (
            <ContextInspectorPanel
              data={inspector.data}
              loading={inspector.loading}
              error={inspector.error}
              onRefresh={inspector.refresh}
            />
          )}

          {/* SetupBanner decides internally what to show: full onboarding when no provider,
              a small "auto-detected" note when a non-config source was used, or nothing when
              fully configured. So mount it unconditionally rather than gating on setupComplete
              (which is true once auto-detected and would hide the auto-detect note). */}
          <SetupBanner health={health} loading={healthLoading} onNavigateSettings={handleNavigateSettings} />

          <ChatPanel messageCount={chat.messages.length} prependedRef={chat.prependedRef}>
            {chat.hasMore && (
              <div className="chat-load-more">
                <button
                  className="btn btn-sm"
                  onClick={chat.loadOlderMessages}
                  disabled={chat.isLoadingOlder}
                >
                  {chat.isLoadingOlder ? 'Loading...' : 'Load older messages'}
                </button>
              </div>
            )}
            {chat.messages.length === 0 && !chat.isStreaming && (
              <div className="empty-state">
                <p>{focusedTask
                  ? `Chatting about "${focusedTask.title}". The agent can see this task's details and take actions on it.`
                  : 'Start a conversation with Walnut. Ask about your tasks, get help with planning, or just chat.'
                }</p>
              </div>
            )}
            {chat.messages
              .filter((msg) => !shouldHideUiOnlyMessage(msg.source, msg.notification))
              .map((msg) => (
              <ChatMessage
                key={msg.key}
                role={msg.role}
                content={msg.content}
                blocks={'blocks' in msg ? msg.blocks : undefined}
                images={'images' in msg ? msg.images : undefined}
                taskContext={'taskContext' in msg ? msg.taskContext : undefined}
                routeInfo={'routeInfo' in msg ? msg.routeInfo as RouteInfo : undefined}
                timestamp={'timestamp' in msg ? msg.timestamp : undefined}
                source={'source' in msg ? msg.source : undefined}
                cronJobName={'cronJobName' in msg ? msg.cronJobName : undefined}
                notification={'notification' in msg ? msg.notification : undefined}
                queued={'queued' in msg ? msg.queued : undefined}
                onCancel={msg.queued && msg.queueId != null ? () => chat.cancelQueuedMessage(msg.queueId!) : undefined}
                taskLookup={taskMap}
                onTaskClick={handleFocusTaskById}
                onSessionClick={handleSessionClick}
              />
            ))}
            {chat.toolActivity && (
              <div className="chat-tool-activity text-sm text-muted">
                <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2, display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
                {chat.toolActivity.name}...
              </div>
            )}
            {chat.error && (
              <div className="chat-message chat-message-notification chat-message-notification-error">
                <div className="chat-message-header chat-notification-header">
                  <div className="chat-message-role">Error</div>
                </div>
                <div className="chat-message-content">
                  <div className="markdown-body">
                    <p>{chat.error}</p>
                  </div>
                  {(() => {
                    const sug = getErrorSuggestion(chat.error);
                    return sug ? <ErrorSuggestionLink {...sug} /> : null;
                  })()}
                </div>
              </div>
            )}
          </ChatPanel>

          {/* Quick Start Bar — context pill when path is selected */}
          {quickStartPath && (
            <div className="quick-start-bar">
              <div className="qsb-top">
                <span className="qsb-label">Quick Start</span>
                {quickStartPath.host && <span className="qsb-host">{quickStartPath.hostLabel ?? quickStartPath.host}</span>}
                {/* Compact, read-only model chip. Click it (or /session) to re-open the
                    picker and edit ALL launch settings (model / star / pin / priority) —
                    the picker restores the prior choice via initialMeta. Keeping the
                    collapsed bar chip-only (no inline <select>) fixes the narrow-view
                    overflow and saves a row of controls. */}
                <button
                  className="qsb-model-chip"
                  onClick={() => setPathSelectorOpen(true)}
                  title="Edit launch settings (model, star, pin, priority)"
                >
                  {SESSION_MODELS.find(sm => sm.id === quickStartModel)?.label ?? 'Auto'}
                </button>
                <button className="qsb-close" onClick={() => { setQuickStartPath(null); quickStartMetaRef.current = null; setQuickStartModel(undefined); }} aria-label="Cancel quick start">&times;</button>
              </div>
              <span className="qsb-path" title={quickStartPath.cwd}>{quickStartPath.cwd}</span>
            </div>
          )}

          <div style={{ position: 'relative' }}>
            {/* Session path selector popover (above the input) */}
            <SessionPathSelector
              open={pathSelectorOpen && !pendingQuestion}
              onClose={() => setPathSelectorOpen(false)}
              onSelect={handlePathSelect}
              // Re-opening to edit an already-confirmed Quick Start keeps the prior
              // footer choices (incl. model) instead of resetting to Auto/defaults,
              // and pre-fills the path so it opens as an "edit this selection" view.
              initialMeta={quickStartPath ? quickStartMetaRef.current ?? undefined : undefined}
              initialPath={quickStartPath ? { cwd: quickStartPath.cwd, host: quickStartPath.host } : undefined}
            />

            {/* Ask Question popover (above the input, mutually exclusive with path selector) */}
            <QuestionPopover
              open={!!pendingQuestion}
              questions={pendingQuestion ?? []}
              onClose={() => {/* closed automatically when tool result arrives */}}
            />

            <QuickAccessBar onSessionClick={() => setPathSelectorOpen(true)} mode={chatMode} onModeToggle={toggleMode} stats={chat.stats} />

            <ChatInput
              onSend={handleSendMessage}
              onCommand={handleCommand}
              onStop={chat.stopGeneration}
              onClearQueue={chat.clearQueue}
              disabled={connectionState !== 'connected'}
              isStreaming={chat.isStreaming}
              focusedTaskTitle={quickStartPath ? `Session on ${quickStartPath.cwd.split('/').pop()}` : focusedTask?.title}
              focusedTask={quickStartPath ? null : focusedTask}
              onClearFocus={handleClearFocus}
              queueCount={chat.queueCount}
              draftKey="draft:main-chat"
              prefillText={AGENT_BUILDER_PREFILL}
              prefillNonce={agentBuilderPrefillNonce}
              onToggleMode={toggleMode}
              sessionCommands={quickStartPath ? quickStartCommands : undefined}
              searchSessionCommands={quickStartPath ? searchQuickStartCommands : undefined}
              // Quick-start: "@" roots at the chosen cwd + host (like a session).
              // Plain main chat has no cwd, so "@" roots at "~" — backend expands it.
              // (?? undefined: QuickStartPath.host is string|null; coerce null→undefined.)
              mentionCwd={quickStartPath?.cwd ?? '~'}
              mentionHost={quickStartPath?.host ?? undefined}
            />
          </div>
        </div>
      </div>

      {/* Sessions Area Resize Handle */}
      {(sessionColumns.length > 0 || triagePanelOpen) && (
        <div className="session-resize-handle" onMouseDown={sessionPanel.handleResizeStart} />
      )}

      {/* Sessions Area — triage (first slot) + session columns.
          Combined ref: sessionPanel.panelRef (width resize observer) + auto-animate
          (FLIP reorder on lock/unlock/close/evict). */}
      <div
        ref={sessionsAreaCombinedRef}
        className={`main-page-sessions-area${sessionColumns.length === 0 && !triagePanelOpen ? ' collapsed' : ''}`}
        style={sessionColumns.length > 0 || triagePanelOpen ? { width: sessionPanel.width } : undefined}
      >
        {triagePanelOpen && (
          <div className="main-page-session-column" key="__triage__">
            <TriagePanel
              onClose={handleCloseTriage}
              taskId={triageTaskId ?? undefined}
              onTaskClick={handleFocusTaskById}
              onSessionClick={handleSessionClick}
            />
          </div>
        )}
        {/* Note: key={sid} means a pending→real id swap (quick-start/fork) remounts
            the column, which auto-animate will show as a remove+insert. Harmless
            visually (the panel swaps from PendingSessionPanel → SessionPanel anyway)
            but worth knowing if someone later investigates "panel pops on session start". */}
        {sessionColumns.map((slot, idx) => {
          const sid = slot.id;
          const needsDivider = idx > 0 || triagePanelOpen;
          const isPending = sid.startsWith('pending:');
          const qsMeta = isPending ? pendingQuickStartMetaRef.current : null;
          const forkMeta = isPending ? pendingForkMetaRef.current : null;
          const pendingMeta = (qsMeta?.id === sid ? qsMeta : null) ?? (forkMeta?.id === sid ? forkMeta : null);
          const isForkPending = forkMeta?.id === sid;
          // Column split: when 2+ columns, first gets splitPct%, rest share remainder
          const totalCols = sessionColumns.length + (triagePanelOpen ? 1 : 0);
          const colIdx = idx + (triagePanelOpen ? 1 : 0);
          const colStyle: React.CSSProperties = totalCols >= 2
            ? { flex: `0 0 ${colIdx === 0 ? colSplitPct : (100 - colSplitPct)}%` }
            : {};
          return (<Fragment key={sid}>
            {needsDivider && <div className="session-col-resize-handle" onMouseDown={handleColSplitStart} />}
            <div className={`main-page-session-column${slot.locked ? ' is-locked' : ''}`} style={colStyle}>
              {isPending && pendingMeta ? (
                <PendingSessionPanel
                  taskId={sid}
                  realTaskId={'realTaskId' in pendingMeta ? (pendingMeta as { realTaskId?: string }).realTaskId : undefined}
                  cwd={pendingMeta.cwd}
                  host={pendingMeta.host}
                  hostLabel={'hostLabel' in pendingMeta ? (pendingMeta as { hostLabel?: string }).hostLabel : undefined}
                  label={isForkPending ? 'Forking session...' : undefined}
                  initialError={'httpError' in pendingMeta ? (pendingMeta as { httpError?: string }).httpError : undefined}
                  onRetry={!isForkPending ? handleQuickStartRetry : undefined}
                  onClose={() => handleCloseSession(sid)}
                />
              ) : (
                <SessionPanel
                  sessionId={sid}
                  locked={slot.locked}
                  onToggleLock={handleToggleLockSession}
                  onClose={handleCloseSession}
                  onTaskClick={handleFocusTaskById}
                  onOpenTaskDetail={handleOpenTaskDetailById}
                  onSessionClick={handleSessionClick}
                  onSessionReplaced={handleSessionReplaced}
                  onForkPending={handleForkPending}
                  onForkResolved={handleForkResolved}
                  onForkFailed={handleForkFailed}
                />
              )}
            </div>
          </Fragment>);
        })}
      </div>

      </div>{/* end .main-page-content-row */}

      {/* FocusDock — inside right column, below chat+sessions */}
      {focusBar.visible && <FocusDock focusBar={focusBar} onQuickAddToFocus={handleQuickAddToFocus} />}

      </div>{/* end .main-page-right */}

      {/* Full-screen task detail — shared by TodoPanel clicks AND the Session panel
          kebab "Task detail" item (both drive focusedTask). suppressDetail (set by
          openDetail:false focus calls, e.g. locating a task) keeps it closed. */}
      {focusedTask && !suppressDetail && (
        <TaskDetailModal
          task={focusedTask}
          allTasks={tasks}
          onClose={handleClearFocus}
          onOpenSession={handleToggleSession}
          onOpenTriageForTask={handleOpenTriageForTask}
          onFocusChild={handleFocusTask}
        />
      )}

    </div>
  );
}
