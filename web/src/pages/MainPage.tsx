import { useState, useCallback, useEffect, useMemo, useRef, Fragment } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { SESSION_MODELS } from '@open-walnut/core';
import { getHostCatalog } from '@/hooks/useModelCatalog';
import { useChat, mergeAdjacentErrors, type TaskContext, type ImageAttachment } from '@/hooks/useChat';
import { useAgentConsole } from '@/hooks/useAgentConsole';
import { useConversations } from '@/hooks/useConversations';
import { usePlanMode } from '@/hooks/usePlanMode';
import { useWebSocket, useEvent } from '@/hooks/useWebSocket';
import { useTasksContext } from '@/contexts/TasksContext';
import { useNotifications } from '@/contexts/notifications';
import { useFavorites } from '@/hooks/useFavorites';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useOrdering } from '@/hooks/useOrdering';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { useDragGesture } from '@/hooks/useDragGesture';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { useOverlayHeightVar } from '@/hooks/useHeightVar';
import { ChatMessage, type RouteInfo } from '@/components/chat/ChatMessage';
import { ChatInput } from '@/components/chat/ChatInput';
import { TodoPanel } from '@/components/tasks/TodoPanel';
import { LS_TAB_KEY } from '@/components/tasks/task-tabs';
import { QuickTaskComposer } from '@/components/tasks/QuickTaskComposer';
import { RoutinesView } from '@/components/routines/RoutinesView';
import { CalendarSidePanel } from '@/components/calendar/CalendarSidePanel';
import { TaskDetailModal } from '@/components/tasks/TaskDetailModal';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import { PendingSessionPanel } from '@/components/sessions/PendingSessionPanel';
import { SessionPathSelector, type QuickStartPath, type QuickStartTaskMeta } from '@/components/sessions/SessionPathSelector';
import { SessionSearchPanel } from '@/components/sessions/SessionSearchPanel';
import { freshLauncherMeta } from '@/components/sessions/task-meta-constants';
import { QuestionPopover, parseAskQuestionInput } from '@/components/chat/QuestionPopover';
import { TriagePanel } from '@/components/triage/TriagePanel';
import { fetchSession, fetchSessionsForTask, fetchWorkingDirs, quickStartSession } from '@/api/sessions';
import { fetchProjectDetail } from '@/api/projects';
import { deleteTask as deleteTaskApi } from '@/api/tasks';
import { fetchConfig, fetchInstallDir } from '@/api/config';
import { ContextInspectorPanel } from '@/components/context/ContextInspectorPanel';
import { QuickAccessBar } from '@/components/chat/QuickAccessBar';
import { AgentTabBar, slugifyAgentId } from '@/components/chat/AgentTabBar';
import { EngineBadge } from '@/components/chat/EngineBadge';
import { createAgentDef, updateAgentDef } from '@/api/agents';
import { log } from '@/utils/log';
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
import { loadColWeights, saveColWeights, resizeAtBoundary } from './columnSizing';
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
        <EngineBadge />
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
const SS_CALENDAR_VISIBLE_KEY = 'open-walnut-home-calendar-visible';

// Legacy key for migration
const SS_SESSION_KEY_LEGACY = 'open-walnut-home-session-panel';

// ── Session column queue helpers ──
// Pure column-queue operations live in ./sessionColumns.ts so they can be
// unit-tested without React. See that file for the layout invariant rationale.

// Session-area width as % of the viewport, by column count. 65% is the practical
// max alongside a readable chat column; from 3 columns up we take the whole 70% the
// resizable panel allows (useResizablePanel's PANEL_PCT_MAX) or each column is
// unreadably thin. Indexes past the end clamp to the last entry, so a custom count
// of 4-6 gets the same 70% rather than falling back to a narrower 2-column width.
const SESSION_WIDTH_BY_COUNT = [0, 65, 65, 70];
const sessionWidthForCount = (count: number): number =>
  SESSION_WIDTH_BY_COUNT[Math.min(Math.max(count, 0), SESSION_WIDTH_BY_COUNT.length - 1)];

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

/** The one Quick Start failure notification shape — used by both the retry
 *  path and the initial-launch path so the copy/dedup key can't drift apart. */
function quickStartFailedNotification(host: string | null | undefined, cwd: string, errMsg: string) {
  return {
    kind: 'operation-error' as const,
    severity: 'error' as const,
    title: 'Quick Start Failed',
    body: errMsg,
    persistent: true,
    dedupKey: `quick-start:${host ?? '__local__'}:${cwd}:${errMsg}`,
  };
}

function formatQuickTaskDate(iso: string): string {
  const dateOnly = !iso.includes('T');
  const [year, month, day] = dateOnly ? iso.split('-').map(Number) : [];
  const date = dateOnly ? new Date(year, month - 1, day) : new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((dueDay.getTime() - today.getTime()) / 86_400_000);
  const dayLabel = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${date.getMonth() + 1}-${date.getDate()}`;
  if (dateOnly) return dayLabel;
  return `${dayLabel} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
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
  const { notify } = useNotifications();
  const { tasks, loading, refreshing: tasksRefreshing, error: tasksError, toggleComplete, setPhase, star, create, update, reorder, moveTask, reparentTask, deleteTask, batchSetPhase, batchDelete, bakeOrder, showOperationError, taskGroups, hiddenGroups, groupTasks, addToGroup, ungroupTasks, renameGroup, setGroupHidden } = useTasksContext();
  const favorites = useFavorites();
  const focusBar = useFocusBarContext();
  const pinnedTaskIdSet = useMemo(() => new Set(focusBar.pinnedIds), [focusBar.pinnedIds]);
  const focusTaskIdSet = useMemo(() => new Set(focusBar.focusIds), [focusBar.focusIds]);
  const backlogTaskIdSet = useMemo(() => new Set(focusBar.backlogIds), [focusBar.backlogIds]);
  const waitTaskIdSet = useMemo(() => new Set(focusBar.waitIds), [focusBar.waitIds]);
  const customTierIdSets = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const [tid, ids] of Object.entries(focusBar.customTierIds)) map[tid] = new Set(ids);
    return map;
  }, [focusBar.customTierIds]);
  // Display label for a tier value (built-in name capitalized, custom id → its label).
  const tierLabel = useCallback((tier: string): string => {
    const custom = focusBar.customTiers.find((t) => t.id === tier);
    return custom ? custom.label : `${tier[0]?.toUpperCase() ?? ''}${tier.slice(1)}`;
  }, [focusBar.customTiers]);
  // Flat project picker options — Project is the single grouping layer.
  // Sourced from the REGISTRY first (so an existing but empty project is listed,
  // and quick-capture doesn't badge it as "new"), then unioned with names seen on
  // the loaded tasks as a fallback for when that fetch hasn't landed / failed.
  // Deduped case-insensitively — project identity is NOCASE — registry spelling
  // wins since it's the canonical one.
  const projectRegistry = useProjectRegistry();
  const quickTaskProjectOptions = useMemo(() => {
    const byLower = new Map<string, string>();
    for (const name of projectRegistry.projectNames) {
      const project = name.trim();
      if (project) byLower.set(project.toLowerCase(), project);
    }
    for (const task of tasks) {
      if (task.title.startsWith('.metadata')) continue;
      const project = (task.project || '').trim();
      if (!project) continue;   // Inbox is the absence of a project, never an option
      const key = project.toLowerCase();
      if (!byLower.has(key)) byLower.set(key, project);
    }
    return [...byLower.values()].sort((a, b) => a.localeCompare(b));
  }, [tasks, projectRegistry.projectNames]);
  const ordering = useOrdering();
  // Configured task defaults (platform/project) for quick-add capture. Fetched once;
  // refreshed on config:changed. Quick-add ("Add to Focus") routes to these instead of
  // inheriting the active tab's (possibly provider-claimed) project/source.
  const [taskDefaults, setTaskDefaults] = useState<{ platform?: string; project?: string }>({});
  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => { if (alive) setTaskDefaults({ platform: c.defaults?.platform, project: c.defaults?.project }); })
      .catch(() => { /* defaults stay empty — falls back to local/Inbox below */ });
    return () => { alive = false; };
  }, []);
  useEvent('config:changed', () => {
    fetchConfig()
      .then((c) => setTaskDefaults({ platform: c.defaults?.platform, project: c.defaults?.project }))
      .catch(() => {});
  });
  const [focusedTask, setFocusedTask] = useState<Task | null>(null);
  // Nonce that increments on every focus action — forces re-scroll even for same task
  const [focusNonce, setFocusNonce] = useState(0);
  // Locate scope for the current focus action. 'pinned' = only scroll/expand the
  // Pinned region (tier quick-adds — the new card is already visible in its tier);
  // 'all' additionally switches the TASKS project tab to the task's project.
  // Tier quick-adds routed to the capture project used to switch the tab to e.g.
  // "Personal", filtering the whole task list down to 1 — read as "all my tasks
  // disappeared".
  const [focusScope, setFocusScope] = useState<'all' | 'pinned'>('all');
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

  // Calendar day-agenda panel — hidden by default, toggle via Sidebar
  const [calendarVisible, setCalendarVisible] = useState<boolean>(
    () => sessionStorage.getItem(SS_CALENDAR_VISIBLE_KEY) === 'true'
  );

  // Session columns state — up to 2 sessions displayed side by side
  const [sessionColumns, setSessionColumns] = useState<SessionSlot[]>(loadSessionColumns);
  const sessionOpenersRef = useRef(new Map<string, HTMLElement>());
  const pendingSessionFocusRef = useRef<{
    opener?: HTMLElement;
    taskId?: string;
  } | null>(null);
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

  // Active project tab — mirrors TodoPanel's tab for URL sync (may be a tab
  // sentinel: STARRED_TAB / INBOX_TAB). Initialized from the SAME localStorage key
  // TodoPanel writes, imported rather than re-spelled: this used to read
  // 'open-walnut-todo-active-tab' while TodoPanel wrote 'walnut-todo-active-tab',
  // so the initial URL never reflected the restored tab.
  const [activeProject, setActiveProject] = useState<string | undefined>(() => {
    try { return localStorage.getItem(LS_TAB_KEY) ?? undefined; } catch { return undefined; }
  });
  // String[] projection for URL sync (doesn't need lock state — URL carries ids only).
  const sessionColumnIds = useMemo(() => sessionColumns.map(c => c.id), [sessionColumns]);
  const urlSync = useUrlSync({
    focusedTaskId: focusedTask?.id,
    sessionColumns: sessionColumnIds,
    activeProject,
    visible,
  });

  // Triage panel state — shares the first column slot with sessions
  const [triagePanelOpen, setTriagePanelOpen] = useState(false);
  const triageOpenRef = useRef(triagePanelOpen);
  triageOpenRef.current = triagePanelOpen;
  // Task ID for filtered triage panel (null = show all)
  const [triageTaskId, setTriageTaskId] = useState<string | null>(null);

  // G4 glass: track the chat composer overlay's height into --chat-composer-h
  // on .chat-page so the message scroller pads itself (content scrolls under
  // the glass). Height is dynamic: quick-start bar, pills wrap, textarea grow.
  const chatComposerRef = useOverlayHeightVar('--chat-composer-h', '.chat-panel');

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
  const { effectiveMaxPanels, loaded: panelModeLoaded } = useSessionPanelMode(sessionAreaWidth);
  const maxPanelsRef = useRef(effectiveMaxPanels);
  maxPanelsRef.current = effectiveMaxPanels;
  const panelModeLoadedRef = useRef(panelModeLoaded);
  panelModeLoadedRef.current = panelModeLoaded;

  // Auto-evict excess session columns when effectiveMaxPanels shrinks (e.g. auto mode + window resize).
  // Gated on `panelModeLoaded`: until the config fetch settles the hook reports the
  // '2' DEFAULT, and evicting on that would silently drop a 3rd restored column
  // (sessionStorage/deep link) before the user's real '3' arrives — eviction is
  // one-way, so the column never comes back.
  useEffect(() => {
    if (!panelModeLoaded) return;
    setSessionColumns(prev => {
      const max = triageOpenRef.current ? effectiveMaxPanels - 1 : effectiveMaxPanels;
      return trimUnlockedToMax(prev, max);
    });
  }, [effectiveMaxPanels, panelModeLoaded]);

  // Session/task quick-entry popovers above the chat input.
  const [pathSelectorOpen, setPathSelectorOpen] = useState(false);
  const [quickTaskOpen, setQuickTaskOpen] = useState(false);
  // Session finder — search existing sessions by title/task/cwd/host and open
  // one as a column. Toggled by the QuickAccessBar pill or ⌘⇧O.
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  // Where the launcher popover is anchored: 'chat' = above the chat input
  // (message-first flow), 'todo' = dropdown inside the task panel (path-first
  // flow that NEVER touches chat visibility — sessions can start with the chat
  // column hidden; the CLI spawns with an empty first message and idles).
  const [launcherAnchor, setLauncherAnchor] = useState<'chat' | 'todo'>('chat');
  const [quickStartPath, setQuickStartPath] = useState<QuickStartPath | null>(null);
  // Project header "+ → Add session" seed: the new task is filed under this
  // project, and the launcher's path prefills from the project's default
  // cwd/host (when set). Cleared on every launcher open/select so a stale seed
  // never leaks into an unrelated launch.
  const [launcherProject, setLauncherProject] = useState<{ project: string; path?: { cwd: string; host: string | null } } | null>(null);
  // Ref mirror for async/select callbacks (same pattern as quickStartPathRef).
  const launcherProjectRef = useRef(launcherProject);
  launcherProjectRef.current = launcherProject;
  // Walnut's own source checkout (null on npm installs / cloud) — drives the
  // fix-walnut pill. Fetched once; the API layer caches for the page lifetime.
  const [walnutInstallDir, setWalnutInstallDir] = useState<string | null>(null);
  useEffect(() => { fetchInstallDir().then(setWalnutInstallDir); }, []);
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
  const calendarPanel = useResizablePanel('open-walnut-calendar-width', 20, 'left');

  // Merge sessionPanel.panelRef (for width resize observer) with auto-animate's
  // callback ref on the sessions container. Must be stable — a new function
  // identity on every render would remount the container and wipe animations,
  // and in React 18 a changing ref callback re-runs with null then the element,
  // which has caused infinite loops in the past.
  const sessionsAreaCombinedRef = useCallback((el: HTMLDivElement | null) => {
    (sessionPanel.panelRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    sessionsAreaAutoAnimateRef(el);
  }, [sessionPanel.panelRef, sessionsAreaAutoAnimateRef]);

  // Column widths: one WEIGHT per column, summing to 100. This replaced a single
  // `colSplitPct` scalar (col 0 = pct%, "the rest" = 100-pct% each) that only made
  // sense for exactly 2 columns — with 3 it handed every non-first column the same
  // remainder and the strip summed past 100%. See ./columnSizing.ts.
  const [colWeights, setColWeights] = useState<number[]>(() => loadColWeights(1, localStorage));
  const colWeightsRef = useRef(colWeights);
  colWeightsRef.current = colWeights;

  // Column split drag. Persists on release only — it used to write localStorage
  // from a `useEffect` keyed on the per-frame value, i.e. a synchronous disk write
  // on every mousemove. Pointer capture (useDragGesture) keeps the drag alive when
  // the cursor crosses a session column's HTML-preview iframe.
  //
  // ONE gesture instance serves every divider (hooks can't be called in a loop):
  // the handle records which boundary it is into `dragBoundaryRef` on pointerdown,
  // before delegating. Deltas are applied to the weights captured at grab time, so
  // a drag is never a running sum of per-frame deltas.
  const dragBoundaryRef = useRef(0);
  const colSplitStartRef = useRef<{ weights: number[]; width: number }>({ weights: [], width: 1 });
  const { onPointerDown: colSplitPointerDown } = useDragGesture({
    cursor: 'col-resize',
    onStart: () => {
      const el = sessionPanel.panelRef.current;
      colSplitStartRef.current = {
        weights: colWeightsRef.current,
        width: el?.getBoundingClientRect().width || 1,
      };
      el?.classList.add('resizing');
    },
    onMove: ({ dx }) => {
      const { weights, width } = colSplitStartRef.current;
      setColWeights(resizeAtBoundary(weights, dragBoundaryRef.current, (dx / width) * 100));
    },
    onEnd: () => {
      sessionPanel.panelRef.current?.classList.remove('resizing');
      saveColWeights(colWeightsRef.current, localStorage);
    },
  });
  const colSplitHandleProps = useCallback((boundary: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      dragBoundaryRef.current = boundary;
      colSplitPointerDown(e);
    },
  }), [colSplitPointerDown]);

  // Graduated session area width — use total session count (not visible) so tabbed
  // sessions still get full width. Only auto-set when count increases.
  const prevColCountRef = useRef(0);
  useEffect(() => {
    const count = sessionColumns.length + (triagePanelOpen ? 1 : 0);
    if (count === prevColCountRef.current) return;
    const prev = prevColCountRef.current;
    prevColCountRef.current = count;
    // Only auto-set width when opening panels (0→1, 1→2, 2→3), not when closing
    if (count > prev && count > 0) {
      sessionPanel.setPct(sessionWidthForCount(count));
    }
  }, [sessionColumns.length, triagePanelOpen, sessionPanel.setPct]);

  // Swap in the layout saved for THIS column count. Layouts are stored per count,
  // so opening a 3rd panel doesn't destroy the 2-column split the user tuned —
  // closing it restores the old one verbatim instead of leaving a stretched guess.
  const colCount = sessionColumns.length + (triagePanelOpen ? 1 : 0);
  useEffect(() => {
    setColWeights(prev => (prev.length === colCount ? prev : loadColWeights(colCount, localStorage)));
  }, [colCount]);

  // Weights ACTUALLY rendered. Derived rather than read straight from state so the
  // weight count can never disagree with the column count for even one frame — the
  // effect above lands a tick later, and a mismatch would size N columns with N∓1
  // weights. Cheap: the common in-sync path returns the state array untouched.
  const renderWeights = useMemo(
    () => (colWeights.length === colCount ? colWeights : loadColWeights(colCount, localStorage)),
    [colWeights, colCount],
  );

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
      const p = urlSync.pending;
      const task = p.taskId ? tasks.find(t => t.id === p.taskId) : undefined;
      if (p.taskId && !task && (loading || tasksRefreshing || tasksError)) {
        // A transient list failure is not evidence that the deep-linked task is
        // gone. Keep both pending state and the browser URL for the retry.
        return;
      }

      restoredTaskRef.current = true;
      if (p.taskId) {
        if (task) setFocusedTask(task);
      }
      if (p.sessionIds.length > 0) {
        // URL carries ids only — preserve lock state from sessionStorage where ids match.
        const saved = loadSessionColumns();
        const lockedById = new Map(saved.map(s => [s.id, s.locked]));
        // Same rationale as the visibility restore below: don't truncate a deep
        // link against the pre-config default panel count.
        const ids = panelModeLoadedRef.current ? p.sessionIds.slice(0, maxPanelsRef.current) : p.sessionIds;
        setSessionColumns(ids.map(id => ({ id, locked: lockedById.get(id) ?? false })));
      }
      if (p.project !== null) setActiveProject(p.project);
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
  }, [loading, tasksRefreshing, tasksError, tasks, focusedTask, urlSync.pending, urlSync.clearPending]);

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
      // Truncate only once the real panel setting is known — see the eviction
      // effect. Restoring un-truncated is safe: that effect trims as soon as the
      // config settles, whereas truncating early loses a column permanently.
      if (restored.length > 0) {
        setSessionColumns(panelModeLoadedRef.current ? restored.slice(0, maxPanelsRef.current) : restored);
      }
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

  useEffect(() => {
    sessionStorage.setItem(SS_CALENDAR_VISIBLE_KEY, String(calendarVisible));
    window.dispatchEvent(new CustomEvent('main:calendar-visible', { detail: { visible: calendarVisible } }));
  }, [calendarVisible]);

  // ── Listen for FocusDock events ──
  useEffect(() => {
    const handleDockTask = (e: Event) => {
      const { taskId, sessionId, scope } = (e as CustomEvent).detail as { taskId: string; sessionId?: string; scope?: 'all' | 'pinned' };
      const task = taskMapRef.current.get(taskId);
      // Nonce bump marks this as a user locate action — TodoPanel only
      // auto-expands collapsed sections for those (never on refresh restore).
      if (task) { setFocusScope(scope ?? 'all'); setFocusedTask(task); setFocusNonce((n) => n + 1); }
      if (sessionId) openSessionOrToast(sessionId);
    };
    const handleDockChat = () => {
      // Toggle main chat panel visibility
      setChatVisible(prev => !prev);
    };
    const handleSessionLauncher = () => {
      setLauncherAnchor('chat');
      setPathSelectorOpen(true);
      setQuickTaskOpen(false);
    };
    const handleTaskComposer = () => {
      setLauncherAnchor('chat');
      setQuickTaskOpen(true);
      setPathSelectorOpen(false);
    };
    const handleToggleTodo = () => setTodoVisible(prev => !prev);
    const handleToggleRoutines = () => setRoutinesVisible(prev => !prev);
    const handleToggleCalendar = () => setCalendarVisible(prev => !prev);
    // openSessionOnHome (utils/open-session.ts) — deep links (e.g. notification
    // cards) open the session as a home-page column instead of /sessions.
    const handleOpenSession = (e: Event) => {
      const { sessionId } = (e as CustomEvent).detail as { sessionId?: string };
      if (sessionId) openSessionOrToast(sessionId);
    };
    window.addEventListener('dock:activate-task', handleDockTask);
    window.addEventListener('dock:activate-chat', handleDockChat);
    window.addEventListener('session-launcher:open', handleSessionLauncher);
    window.addEventListener('task-composer:open', handleTaskComposer);
    window.addEventListener('sidebar:toggle-todo', handleToggleTodo);
    window.addEventListener('sidebar:toggle-routines', handleToggleRoutines);
    window.addEventListener('sidebar:toggle-calendar', handleToggleCalendar);
    window.addEventListener('main:open-session', handleOpenSession);
    return () => {
      window.removeEventListener('dock:activate-task', handleDockTask);
      window.removeEventListener('dock:activate-chat', handleDockChat);
      window.removeEventListener('session-launcher:open', handleSessionLauncher);
      window.removeEventListener('task-composer:open', handleTaskComposer);
      window.removeEventListener('sidebar:toggle-todo', handleToggleTodo);
      window.removeEventListener('sidebar:toggle-routines', handleToggleRoutines);
      window.removeEventListener('sidebar:toggle-calendar', handleToggleCalendar);
      window.removeEventListener('main:open-session', handleOpenSession);
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
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      sessionOpenersRef.current.set(sessionId, active);
    }
    setSessionColumns(next);
  }, [showOperationError]);

  const handleToggleSession = openSessionOrToast;

  // ⌘⇧O opens the session finder from anywhere on the home page (no mouse
  // needed). Plain ⌘K stays with the task search (TodoSearchBar) — don't
  // collide. Shortcut choice: ⌘⇧K is Firefox's Web Console, ⌘J is Chrome's
  // Downloads, ⌘⇧S is Firefox's screenshot — ⌘⇧O is free in this app (only
  // ⌘K / ⌘E / ⌘S are taken) and browsers let pages intercept it. Gated on
  // `visible`: MainPage stays mounted behind other routes, where the shortcut
  // must not silently toggle a hidden overlay.
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
        // Match the file's other shortcut guards: never hijack the combo while
        // the user is typing in an input/textarea/contentEditable.
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).isContentEditable)) return;
        e.preventDefault();
        // Mirror the QuickAccessBar pill handler: close the launcher popovers
        // so the finder overlay can't stack on an open path-selector/quick-task.
        setPathSelectorOpen(false);
        setQuickTaskOpen(false);
        setSessionSearchOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible]);

  const handleCloseSession = useCallback((sessionId: string) => {
    const opener = sessionOpenersRef.current.get(sessionId);
    sessionOpenersRef.current.delete(sessionId);
    const task = [...taskMapRef.current.values()].find((candidate) =>
      candidate.session_id === sessionId
      || candidate.exec_session_id === sessionId
      || candidate.plan_session_id === sessionId
      || candidate.session_ids?.includes(sessionId));
    pendingSessionFocusRef.current = {
      opener,
      taskId: task?.id,
    };
    setSessionColumns(prev => removeSessionColumn(prev, sessionId));
  }, []);

  useEffect(() => {
    const pending = pendingSessionFocusRef.current;
    if (!pending) return;
    pendingSessionFocusRef.current = null;
    const frame = requestAnimationFrame(() => {
      const fallback = pending.taskId
        ? [...document.querySelectorAll<HTMLElement>(
          `[data-task-id="${CSS.escape(pending.taskId)}"]`,
        )].find((element) => element.getClientRects().length > 0)
        : null;
      const target = pending.opener?.isConnected ? pending.opener : fallback;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionColumns]);

  useEffect(() => {
    if (sessionColumns.length === 0 || !window.matchMedia('(max-width: 768px)').matches) return;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(
        '.main-page-session-column.is-mobile-active .session-panel-close',
      )?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionColumns]);

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
    const d = data as {
      sessionId?: string;
      previousSessionId?: string;
      fromPlanSessionId?: string;
      status?: { sessionId?: string };
    };
    const nextSessionId = d.status?.sessionId ?? d.sessionId;
    const previousSessionId = d.previousSessionId ?? d.fromPlanSessionId;
    if (previousSessionId && nextSessionId) {
      setSessionColumns(prev =>
        prev.some(c => c.id === previousSessionId)
          ? replaceSessionColumn(prev, previousSessionId, nextSessionId)
          : prev
      );
    }
  });

  // ── Quick Start retry handler ──
  const handleQuickStartRetry = useCallback(() => {
    const meta = pendingQuickStartMetaRef.current;
    // Empty string is a VALID message (todo-launcher path-first launch spawns
    // the CLI with no first turn) — only bail when there's no meta at all.
    if (!meta || typeof meta.message !== 'string') return;

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
      notify(quickStartFailedNotification(meta.host, meta.cwd, errMsg));
    });
  }, [notify]);

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
  // Fallback poll handle for pending columns (used by promoteToRealSession below
  // and armed by the effect further down; declared here so both can see it).
  const pendingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Swap a `pending:*` placeholder column for its real session id and clear the
  // pending bookkeeping, so the event/poll fallbacks can't fire a second swap.
  //
  // The server now pre-assigns session ids (CLI `--session-id`), so this runs on
  // the quick-start / fork HTTP response — before the CLI has even finished
  // booting. SessionPanel is fine mounting "early": its metadata fetch already
  // retries transient failures, and the record is written at spawn confirmation.
  const promoteToRealSession = useCallback((pendingColId: string, sessionId: string, taskId?: string) => {
    if (pendingQuickStartMetaRef.current?.id === pendingColId) {
      pendingQuickStartMetaRef.current = null;
      pendingQuickStartRef.current = null;
    }
    if (pendingForkMetaRef.current?.id === pendingColId) {
      pendingForkMetaRef.current = null;
      pendingForkTaskRef.current = null;
    }
    if (pendingPollRef.current) { clearInterval(pendingPollRef.current); pendingPollRef.current = null; }
    setSessionColumns(prev => replaceSessionColumn(prev, pendingColId, sessionId));
    log.info('session', 'promoted pending column to real session', { sessionId, taskId });
  }, []);

  // Path selector → select handler
  const handlePathSelect = useCallback((path: QuickStartPath, taskMeta: QuickStartTaskMeta) => {
    // Re-editing a fix-walnut launch (e.g. via the model chip) must not silently
    // drop the repair intent — keep it as long as the target stays the checkout.
    setQuickStartPath(prev =>
      prev?.intent === 'fix-walnut' && path.cwd === prev.cwd ? { ...path, intent: prev.intent } : path);
    quickStartMetaRef.current = taskMeta;
    setQuickStartModel(taskMeta.model);   // mirror for the collapsed bar's <select>
    setPathSelectorOpen(false);
  }, []);

  // TodoPanel toolbar "+" launcher — opens the SAME SessionPathSelector /
  // QuickTaskComposer components, but anchored INSIDE the task panel with a
  // Session | Task tab header (Session default). Never touches chat
  // visibility: the whole point of this entry is starting a session while
  // the chat column stays hidden.
  const handleToolbarOpenLauncher = useCallback(() => {
    setLauncherAnchor('todo');
    setLauncherProject(null);    // plain "+" carries no project seed
    setQuickTaskOpen(false);
    setPathSelectorOpen(true);   // Session tab is the default
  }, []);
  // Project header "+ → Add session (with task)": same todo-anchored launcher,
  // but the resulting task files under the project and the path picker seeds
  // from the project's default cwd/host. The detail fetch is best-effort — no
  // defaults just means the picker opens on its usual recents.
  const handleOpenLauncherForProject = useCallback(async (project: string) => {
    setLauncherAnchor('todo');
    setQuickTaskOpen(false);
    // Resolve the project's default cwd/host BEFORE opening: the picker reads
    // initialPath only in its open effect, so seeding after open would need a
    // remount that discards whatever the user typed meanwhile. The fetch is one
    // small metadata read — a beat of delay beats losing in-flight state.
    let path: { cwd: string; host: string | null } | undefined;
    try {
      const detail = await fetchProjectDetail(project);
      const cwd = detail.metadata?.default_cwd;
      if (cwd) path = { cwd, host: detail.metadata?.default_host ?? null };
    } catch { /* no defaults → picker opens on recents */ }
    setLauncherProject({ project, ...(path ? { path } : {}) });
    setPathSelectorOpen(true);
  }, []);
  // fix-walnut pill → skip the path picker entirely: the target is Walnut's own
  // checkout (server-authoritative), the user only describes what's broken.
  const walnutInstallDirRef = useRef(walnutInstallDir);
  walnutInstallDirRef.current = walnutInstallDir;
  const handleFixWalnut = useCallback(() => {
    const dir = walnutInstallDirRef.current;
    if (!dir) return; // pill is hidden when null; belt-and-braces
    setPathSelectorOpen(false);
    setQuickTaskOpen(false); // launcher popovers are mutually exclusive
    setQuickStartPath({ cwd: dir, host: null, intent: 'fix-walnut' });
    // The pill skips the path picker, so nothing else ever produces the launcher's
    // task meta — seed it explicitly with the SAME settings a regular quick session
    // would get: the sticky pin tier (freshLauncherMeta; a hardcoded 'focus' here
    // used to override the user's remembered tier on every repair), then the
    // checkout dir's remembered model/engine merged in below once working-dirs
    // resolve (usually instant — the API layer caches for the page lifetime).
    const seeded = freshLauncherMeta();
    quickStartMetaRef.current = seeded;
    setQuickStartModel(undefined);
    fetchWorkingDirs().then(({ dirs }) => {
      // Stale guard: only merge while THIS fix-walnut compose is still the active
      // meta (user may have cancelled, re-edited via the picker, or re-clicked).
      // Fail-safe trade-off: if the user re-opens the picker or fires the send
      // before this (page-lifetime-cached, usually instant) fetch resolves, the
      // dir's model memory loses and the launch goes out as Auto — never the
      // other way around (memory must not clobber an explicit user edit).
      if (quickStartMetaRef.current !== seeded) return;
      const launch = dirs.find(d => d.cwd === dir && (d.host ?? null) === null)?.lastLaunch;
      if (!launch || launch.engine === 'codex') return; // repair briefing is written for the native CLI — don't inherit a Codex memory (or its model)
      quickStartMetaRef.current = { ...seeded, model: launch.model };
      setQuickStartModel(launch.model);
    }).catch(() => { /* no memory → keep Auto/Claude, same as the launcher */ });
    // Land the cursor in the input — the bar + hint + focused caret form one visual path.
    setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('.chat-input-textarea')?.focus();
    }, 50);
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

  const handleForkResolved = useCallback((taskId: string, sessionId?: string) => {
    // The fork route pre-assigns the new session's id, so the response already
    // knows it — swap straight to the real panel instead of showing "Forking
    // session..." until task:updated / the poll lands.
    const pendingColId = pendingForkMetaRef.current?.id;
    if (sessionId && pendingColId) {
      promoteToRealSession(pendingColId, sessionId, taskId);
      return;
    }
    // Store the real taskId so WS events + polling can resolve the pending panel
    pendingForkTaskRef.current = taskId;
    if (pendingForkMetaRef.current) {
      pendingForkMetaRef.current = { ...pendingForkMetaRef.current, realTaskId: taskId };
    }
  }, [promoteToRealSession]);

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
    openSessionOrToast(sessionId);
    // Fetch session to find its associated task
    try {
      const session = await fetchSession(sessionId);
      if (session?.taskId) {
        const task = taskMapRef.current.get(session.taskId);
        // User locate action — bump nonce so TodoPanel auto-expands to it.
        if (task) { setFocusScope('all'); setFocusedTask(task); setFocusNonce((n) => n + 1); }
      }
    } catch { /* non-critical */ }
  }, [openSessionOrToast]);

  const handleCreate = useCallback(async (input: { title: string; priority: string; project?: string; due_date?: string; start_date?: string; starred?: boolean; pinnedTier?: string; capture?: boolean }) => {
    const tier = input.pinnedTier;
    // Quick-capture ("Add to <tier>…" inline rows, Focus Dock) routes to the user's
    // configured Default Platform + Project instead of the active tab's project — so a
    // capture made while viewing a provider-claimed tab (e.g. an MS To-Do project) still
    // lands in the fast local Inbox unless the user changed the default. An unset default
    // project ('' / undefined) IS Inbox — never substitute a literal group name. The main
    // Quick Add form (explicit project picker) is NOT a capture and keeps its choice.
    const captureProject = taskDefaults.project ?? '';
    const captureSource = taskDefaults.platform || 'local';
    const task = await create(
      {
        title: input.title,
        priority: input.priority,
        project: input.capture ? captureProject : input.project,
        due_date: input.due_date,
        start_date: input.start_date,
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
        // Locate the task in the PINNED region only. The new card already renders in
        // its tier (optimistic pin), so scroll there — but do NOT let TodoPanel switch
        // the TASKS project tab: a capture routes to the default capture project
        // (e.g. Personal), and switching to it filters the list below down to almost
        // nothing ("all my tasks disappeared"). Set focus directly from the returned
        // task object — dispatching the dock event alone is unreliable because the
        // task may not be in the local map yet (arrives via WS).
        setFocusScope('pinned');
        setFocusedTask(task);
        setFocusNonce((n) => n + 1);
        setSuppressDetail(true); // quick-add scrolls to the card; never pops the detail panel
        window.dispatchEvent(new CustomEvent('dock:activate-task', { detail: { taskId: task.id, scope: 'pinned' } }));
      }
    } catch (err) {
      console.warn('Quick add post-create side-effect failed', err);
    }
    return task;
  }, [create, star, focusBar, taskDefaults]);

  // Inline "+" in the Focus Dock — create a task and pin it straight to the Focus tier.
  // capture:true routes it to the configured Default Platform/Project (fast local Inbox
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
    setFocusScope('all'); // explicit user locate — full behavior incl. tab switch
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
    setFocusScope('all');
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

  // Batch complete/reopen from the multi-select bar. Mirrors handleSetPhase's detail-pane
  // cleanup: completing the focused task must drop the detail pane, and in a batch the
  // focused task can be ANY member of the selection.
  const handleBatchSetPhase = useCallback((ids: string[], phase: string) => {
    const focusedId = focusedTaskRef.current?.id;
    if (phase === 'COMPLETE' && focusedId && ids.includes(focusedId)) setFocusedTask(null);
    return batchSetPhase(ids, phase);
  }, [batchSetPhase]);

  // Batch delete — a deleted task must not stay in the detail pane (it would render
  // a task that no longer exists). Same cleanup as complete, applied to any member.
  const handleBatchDelete = useCallback((ids: string[], opts?: { force?: boolean }) => {
    const focusedId = focusedTaskRef.current?.id;
    if (focusedId && ids.includes(focusedId)) setFocusedTask(null);
    return batchDelete(ids, opts);
  }, [batchDelete]);

  const handleSetPriority = useCallback((id: string, priority: string) => {
    update(id, { priority });
  }, [update]);

  const handleSetDate = useCallback((id: string, date: string | null) => {
    update(id, { due_date: date ?? '' });
  }, [update]);

  const handleSetStartDate = useCallback((id: string, date: string | null) => {
    update(id, { start_date: date ?? '' });
  }, [update]);

  const handleUpdate = useCallback((id: string, updates: { title?: string }) => {
    update(id, updates);
  }, [update]);

  // Ref to hold quickStartPath for the async callback (avoids stale closure)
  const quickStartPathRef = useRef(quickStartPath);
  quickStartPathRef.current = quickStartPath;

  // Shared QuickTaskComposer create handler (chat-anchored AND todo-anchored
  // composer instances): create → locate the new row → success toast w/ Undo.
  const handleQuickTaskCreate = useCallback(async (input: Parameters<typeof handleCreate>[0]) => {
    const created = await handleCreate(input);
    // LOCATE the new task: open the todo panel if hidden and select+scroll
    // to the row. Without this the task lands invisibly ("where did it
    // go?") — and it also puts the late AI backfill (title cleanup, due
    // badge) right where the user is already looking.
    setTodoVisible(true);
    if (!input.pinnedTier) {
      // Pinned creates already locate via handleCreate's dock:activate-task
      // path (scope 'pinned'); calling handleFocusTask here would clobber
      // that scope back to 'all'.
      handleFocusTask(created, { openDetail: false });
    }
    const summary = [
      input.pinnedTier ? tierLabel(input.pinnedTier) : undefined,
      input.due_date ? `Due ${formatQuickTaskDate(input.due_date)}` : undefined,
      input.start_date ? `Starts ${formatQuickTaskDate(input.start_date)}` : undefined,
      input.priority !== 'none' ? `${input.priority[0].toUpperCase()}${input.priority.slice(1)}` : undefined,
      // No project = Inbox; say so rather than leaving the summary silent about placement.
      input.project?.trim() || 'Inbox',
    ].filter((value): value is string => !!value);
    notify({
      kind: 'sort',
      severity: 'success',
      title: `Task created: ${created.title}`,
      ...(summary.length > 0 ? { body: summary.join(' · ') } : {}),
      dedupKey: created.id,
      persistent: false,
      action: { label: 'Undo', kind: 'callback' },
      onAction: () => { deleteTaskApi(created.id).catch(() => {}); },
    });
    return created;
  }, [handleCreate, handleFocusTask, notify, tierLabel]);

  // Core quick-start launcher — creates the pending session column and fires the
  // API call. Deliberately does NOT touch chat state/visibility: the todo-panel
  // "+" entry point starts sessions while the chat column stays hidden (the CLI
  // spawns with an empty first message and idles on stdin).
  const launchQuickStart = useCallback((qsp: QuickStartPath, metaSnapshot: QuickStartTaskMeta | null, text: string, images?: ImageAttachment[], project?: string) => {
      // Set pending ref BEFORE the async call so WS events that arrive
      // during the HTTP round-trip can still match via taskId
      const tempTaskId = `pending-${Date.now()}`;
      pendingQuickStartRef.current = tempTaskId;

      // Immediately open a pending session column for instant visual feedback
      const pendingColId = `pending:${tempTaskId}`;
      setSessionColumns(prev => addSessionColumn(prev, pendingColId, triageOpenRef.current, maxPanelsRef.current));
      // Store pending metadata for rendering
      pendingQuickStartMetaRef.current = { id: pendingColId, cwd: qsp.cwd, host: qsp.host ?? undefined, hostLabel: qsp.hostLabel ?? undefined, message: text };

      // `pinTier: null` — NOT undefined — is how an explicit "don't pin this"
      // reaches the server: undefined is dropped by JSON.stringify, and the
      // fix-walnut branch treats an absent pinTier as "client didn't choose" and
      // applies its own default tier. Without the null, unpinning inside a
      // fix-walnut re-edit was silently overridden back to the server default.
      const taskMeta = metaSnapshot ? {
        starred: metaSnapshot.starred,
        needs_attention: metaSnapshot.needs_attention,
        priority: metaSnapshot.priority,
        pinTier: metaSnapshot.pinTier ?? null,
      } : undefined;
      // Model is a session arg, not task metadata. undefined = Auto (let the
      // CLI/config default decide) — only forwarded when the user picks one.
      const model = metaSnapshot?.model;
      // Codex is local-only: if the user flipped to Codex and then confirmed a
      // remote-host path (toggle disables but meta keeps the stale value), fall
      // back to Claude instead of letting the server reject the quick-start.
      const engine = qsp.host && qsp.host !== '__local__' ? undefined : metaSnapshot?.engine;

      quickStartSession({
        cwd: qsp.cwd,
        host: qsp.host ?? undefined,
        message: text,
        images,
        taskMeta,
        model,
        engine,
        project,
        intent: qsp.intent,
        createCwd: qsp.createCwd,
      }).then((result) => {
        // Update ref with real taskId (WS events use this to match)
        if (pendingQuickStartRef.current === tempTaskId) {
          pendingQuickStartRef.current = result.taskId;
        }
        // Store real taskId so PendingSessionPanel can match error events
        if (pendingQuickStartMetaRef.current?.id === pendingColId) {
          pendingQuickStartMetaRef.current = { ...pendingQuickStartMetaRef.current, realTaskId: result.taskId };
        }
        // Native starts return the session id up front (server pre-assigns it and
        // passes it to the CLI as --session-id). Swap the placeholder for the real
        // panel NOW rather than waiting on task:updated / the 2s poll — that wait
        // was the multi-second "starting session…" spinner. Codex omits sessionId,
        // so those keep the event/poll path below.
        if (result.sessionId) {
          promoteToRealSession(pendingColId, result.sessionId, result.taskId);
        }
        // No butler notification here anymore. Title AND project are both
        // server-side now: the session-auto-title hook titles from the
        // user's first message (CLI generate_session_title), and quick-start
        // fires a fast-model organizer (session-organize.ts) for placement.
        // The old "[Quick Start] …move the task" chat message woke the MAIN
        // agent (full model + context) for a one-field decision on every
        // launch — deliberately removed; don't reintroduce it.
      }).catch((err) => {
        // Keep the pending column visible with error — user can Retry from panel
        const errMsg = err instanceof Error ? err.message : String(err);
        if (pendingQuickStartMetaRef.current?.id === pendingColId) {
          pendingQuickStartMetaRef.current = { ...pendingQuickStartMetaRef.current, httpError: errMsg };
        }
        // Force re-render by updating sessionColumns in-place (identity change)
        setSessionColumns(prev => [...prev]);
        notify(quickStartFailedNotification(qsp.host, qsp.cwd, errMsg));
      });
  }, [notify]);

  // Todo-anchored select = path-first flow: no chat input to type a first
  // message into, so start the session immediately with an empty message —
  // the CLI spawns, initializes, and idles; the user talks to it in the
  // session column that opens.
  const handleTodoPathSelect = useCallback((path: QuickStartPath, taskMeta: QuickStartTaskMeta) => {
    setPathSelectorOpen(false);
    // Consume the project-header seed (if any) — the launched task files under
    // that project. Clear it so the next plain launch doesn't inherit it.
    const seededProject = launcherProjectRef.current?.project;
    setLauncherProject(null);
    launchQuickStart(path, taskMeta, '', undefined, seededProject);
  }, [launchQuickStart]);

  const handleSendMessage = useCallback((text: string, images?: ImageAttachment[]) => {
    const qsp = quickStartPathRef.current;

    // Quick-start interception: when a path is selected, create task + start session
    if (qsp) {
      setQuickStartPath(null);
      setQuickStartModel(undefined);   // clear the collapsed-bar model mirror
      // Local echo as a collapsible bubble — auto-collapses to "⚡ Quick Start on <cwd>"
      // with a chevron the user can click to see the full pasted prompt. This echo
      // is the single visual confirmation (no butler message is sent anymore —
      // titling and project placement both happen server-side).
      chat.addLocalMessage(
        `${qsp.intent === 'fix-walnut' ? 'Fix Walnut' : 'Quick Start'} on \`${qsp.cwd}\`${qsp.host ? ` (${qsp.hostLabel ?? qsp.host})` : ''}:\n> ${text}`,
        'quick-start-echo',
      );
      // Snapshot + clear meta ref BEFORE the async call so a subsequent /session
      // doesn't pick up the stale meta while this one is in flight.
      const metaSnapshot = quickStartMetaRef.current;
      quickStartMetaRef.current = null;
      launchQuickStart(qsp, metaSnapshot, text, images);
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
        project: focusedTask.project || '',
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
        subtasks: tasks
          .filter((candidate) => candidate.parent_task_id && focusedTask.id.startsWith(candidate.parent_task_id))
          .map((child) => ({
            id: child.id,
            title: child.title,
            done: child.status === 'done' || child.phase === 'COMPLETE',
          })),
      };
      const plan = getPlanPayload();
      chat.sendMessage(text, taskContext, images, undefined, plan.mode, plan.planModeFirst, plan.planModeOff);
      // Clear task quote after sending — quote is bound to the message, not persistent
      setFocusedTask(null);
    } else {
      const plan = getPlanPayload();
      chat.sendMessage(text, undefined, images, undefined, plan.mode, plan.planModeFirst, plan.planModeOff);
    }
  }, [chat, focusedTask, getPlanPayload, launchQuickStart, tasks]);

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
    <div
      className={`main-page${sessionColumns.length > 0 ? ' has-mobile-session' : ''}`}
      style={{ position: 'relative' }}
    >

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
          onBatchSetPhase={handleBatchSetPhase}
          onBatchDelete={handleBatchDelete}
          onSetPriority={handleSetPriority}
          onSetDate={handleSetDate}
          onSetStartDate={handleSetStartDate}
          onFocusTask={handleFocusTask}
          onClearFocus={handleClearFocus}
          focusedTaskId={focusedTask?.id}
          focusNonce={focusNonce}
          focusScope={focusScope}
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
          openSessionIds={openSessionIdSet}
          openSessionTaskIds={openSessionTaskIds}
          onOpenTriageForTask={handleOpenTriageForTask}
          onPinTask={focusBar.pin}
          onUnpinTask={focusBar.unpin}
          onReorderPinned={focusBar.reorder}
          onSetTier={focusBar.setTier}
          pinnedTaskIds={pinnedTaskIdSet}
          focusTaskIds={focusTaskIdSet}
          backlogTaskIds={backlogTaskIdSet}
          waitTaskIds={waitTaskIdSet}
          customTiers={focusBar.customTiers}
          customTiersLoaded={focusBar.customTiersLoaded}
          customTierIds={customTierIdSets}
          suppressDetail={suppressDetail}
          onOperationError={showOperationError}
          externalProject={activeProject}
          onProjectChange={setActiveProject}
          onOpenLauncher={handleToolbarOpenLauncher}
          onOpenLauncherForProject={handleOpenLauncherForProject}
        />
        {/* Todo-anchored launcher popover — the SAME components as the chat
            column's, wrapped in a Session | Task tab header and dropping DOWN
            from the toolbar (todo-launcher-popover flips the bottom:100%
            anchoring). Session select starts the session immediately (empty
            first message) — chat stays hidden. */}
        {launcherAnchor === 'todo' && (pathSelectorOpen || quickTaskOpen) && (
          <div className="todo-launcher-popover">
            {/* stopPropagation: the hosted components' document-level outside-click
                handlers would treat a tab mousedown as "outside" and close the
                popover before the tab's click ever fires. */}
            <div className="todo-launcher-tabs" onMouseDown={(e) => e.stopPropagation()}>
              <button
                className={`todo-launcher-tab${pathSelectorOpen ? ' active' : ''}`}
                onClick={() => { setQuickTaskOpen(false); setPathSelectorOpen(true); }}
              >
                Session
              </button>
              <button
                className={`todo-launcher-tab${quickTaskOpen ? ' active' : ''}`}
                onClick={() => { setPathSelectorOpen(false); setQuickTaskOpen(true); }}
              >
                Task
              </button>
            </div>
            {/* Project seed (initialPath) is resolved BEFORE open (see
                handleOpenLauncherForProject), so the open effect reads it — no
                remount, no lost in-flight state. */}
            <SessionPathSelector
              open={pathSelectorOpen}
              onClose={() => { setPathSelectorOpen(false); setLauncherProject(null); }}
              onSelect={handleTodoPathSelect}
              initialPath={launcherProject?.path}
              confirmOnDismiss={false}
            />
            <QuickTaskComposer
              open={quickTaskOpen}
              onClose={() => setQuickTaskOpen(false)}
              projectOptions={quickTaskProjectOptions}
              onCreate={handleQuickTaskCreate}
            />
          </div>
        )}
      </div>

      {/* Todo Resize Handle — only shown when todo is visible */}
      {todoVisible && <div className="todo-resize-handle" {...todoPanel.handleProps} />}

      {/* Calendar day-agenda panel (slide-out, toggled via Sidebar) */}
      {calendarVisible && (
        <>
          <CalendarSidePanel
            onClose={() => setCalendarVisible(false)}
            width={calendarPanel.width}
            panelRef={calendarPanel.panelRef}
          />
          <div className="cal-side-resize-handle" {...calendarPanel.handleProps} />
        </>
      )}

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
          <SetupBanner
            health={health}
            loading={healthLoading}
            onNavigateSettings={handleNavigateSettings}
            onStartSession={() => { setLauncherAnchor('chat'); setPathSelectorOpen(true); }}
          />

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
            {mergeAdjacentErrors(chat.messages
              .filter((msg) => !shouldHideUiOnlyMessage(msg.source, msg.notification, msg.content)))
              .map((msg) => (
              <ChatMessage
                key={msg.key}
                role={msg.role}
                content={msg.content}
                errorCount={msg.errorCount}
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
          </ChatPanel>

          {/* G4 glass composer overlay — QuickAccessBar pills + quick-start bar +
              ChatInput ride together on one glass surface floating over the chat
              scroll area (.chat-panel pads by the tracked --chat-composer-h).
              Also the positioned ancestor for the launcher/question popovers. */}
          <div className="chat-composer-overlay" ref={chatComposerRef}>

          {/* Quick Start Bar — context pill when path is selected */}
          {quickStartPath && (
            <div className="quick-start-bar">
              <div className="qsb-top">
                <span className="qsb-label">{quickStartPath.intent === 'fix-walnut' ? '\u{1F527} Fix Walnut' : 'Quick Start'}</span>
                {quickStartPath.host && <span className="qsb-host">{quickStartPath.hostLabel ?? quickStartPath.host}</span>}
                {/* Compact, read-only model chip. Click it (or /session) to re-open the
                    picker and edit ALL launch settings (model / star / pin / priority) —
                    the picker restores the prior choice via initialMeta. Keeping the
                    collapsed bar chip-only (no inline <select>) fixes the narrow-view
                    overflow and saves a row of controls. */}
                <button
                  className="qsb-model-chip"
                  onClick={() => { setLauncherAnchor('chat'); setPathSelectorOpen(true); setQuickTaskOpen(false); }}
                  title="Edit launch settings (engine, model, star, pin, priority)"
                >
                  {/* Chip label: codex engine → "Codex" (its models are discovered at
                      session start, no pre-start pick); legacy alias → static label;
                      catalog value (full provider ID) → the catalog row's displayName. */}
                  {quickStartMetaRef.current?.engine === 'codex'
                    ? 'Codex'
                    : SESSION_MODELS.find(sm => sm.id === quickStartModel)?.label
                      ?? getHostCatalog(quickStartPath.host)?.models.find(m => m.value === quickStartModel)?.displayName
                      ?? (quickStartModel || 'Auto')}
                </button>
                <button className="qsb-close" onClick={() => { setQuickStartPath(null); quickStartMetaRef.current = null; setQuickStartModel(undefined); }} aria-label="Cancel quick start">&times;</button>
              </div>
              <span className="qsb-path" title={quickStartPath.cwd}>{quickStartPath.cwd}</span>
              {/* Persistent guidance — the input placeholder vanishes on first keystroke,
                  this line stays visible for the whole compose. */}
              {quickStartPath.intent === 'fix-walnut' && (
                <span className="qsb-hint">
                  Tell me what's broken — paste a screenshot (⌘V) if you have one, and I'll open a session to fix it.
                </span>
              )}
            </div>
          )}

          <div style={{ position: 'relative' }}>
            {/* Session path selector popover (above the input) */}
            <SessionPathSelector
              open={pathSelectorOpen && launcherAnchor === 'chat' && !pendingQuestion}
              onClose={() => setPathSelectorOpen(false)}
              onSelect={handlePathSelect}
              // Re-opening to edit an already-confirmed Quick Start keeps the prior
              // footer choices (incl. model) instead of resetting to Auto/defaults,
              // and pre-fills the path so it opens as an "edit this selection" view.
              initialMeta={quickStartPath ? quickStartMetaRef.current ?? undefined : undefined}
              initialPath={quickStartPath ? { cwd: quickStartPath.cwd, host: quickStartPath.host } : undefined}
            />

            <QuickTaskComposer
              open={quickTaskOpen && launcherAnchor === 'chat' && !pendingQuestion}
              onClose={() => setQuickTaskOpen(false)}
              projectOptions={quickTaskProjectOptions}
              onCreate={handleQuickTaskCreate}
            />

            {/* Ask Question popover (above the input, mutually exclusive with path selector) */}
            <QuestionPopover
              open={!!pendingQuestion}
              questions={pendingQuestion ?? []}
              onClose={() => {/* closed automatically when tool result arrives */}}
            />

            <QuickAccessBar
              onTaskClick={() => {
                setLauncherAnchor('chat');
                setQuickTaskOpen(true);
                setPathSelectorOpen(false);
              }}
              onSessionClick={() => {
                setLauncherAnchor('chat');
                setPathSelectorOpen(true);
                setQuickTaskOpen(false);
              }}
              onSessionSearchClick={() => {
                setSessionSearchOpen(true);
                setPathSelectorOpen(false);
                setQuickTaskOpen(false);
              }}
              onFixWalnutClick={walnutInstallDir ? handleFixWalnut : undefined}
              mode={chatMode}
              onModeToggle={toggleMode}
              stats={chat.stats}
            />

            <ChatInput
              onSend={handleSendMessage}
              onCommand={handleCommand}
              onStop={chat.stopGeneration}
              onClearQueue={chat.clearQueue}
              disabled={connectionState !== 'connected'}
              isStreaming={chat.isStreaming}
              placeholder={quickStartPath?.intent === 'fix-walnut'
                ? 'Describe what’s wrong — e.g. "sessions panel keeps spinning". Paste a screenshot (⌘V) to help.'
                : undefined}
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
          </div>{/* .chat-composer-overlay */}
        </div>
      </div>

      {/* Sessions Area Resize Handle — only when chat is visible: with chat
          collapsed the sessions area is flex:1 (fills the row), so this handle
          can't resize anything and would just double the todo↔sessions gutter. */}
      {chatVisible && (sessionColumns.length > 0 || triagePanelOpen) && (
        <div className="session-resize-handle" {...sessionPanel.handleProps} />
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
          <div
            className="main-page-session-column"
            key="__triage__"
            style={colCount >= 2 ? { flex: `0 0 ${renderWeights[0] ?? 0}%` } : undefined}
          >
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
          // Column widths: one weight per column (summing to 100). A single column
          // stays on the CSS default (flex:1) so it fills the strip.
          const colIdx = idx + (triagePanelOpen ? 1 : 0);
          const colStyle: React.CSSProperties = colCount >= 2
            ? { flex: `0 0 ${renderWeights[colIdx] ?? 0}%` }
            : {};
          return (<Fragment key={sid}>
            {/* This divider trades width between colIdx-1 and colIdx only. */}
            {needsDivider && <div className="session-col-resize-handle" {...colSplitHandleProps(colIdx - 1)} />}
            <div
              className={`main-page-session-column${slot.locked ? ' is-locked' : ''}${idx === sessionColumns.length - 1 ? ' is-mobile-active' : ''}`}
              style={colStyle}
            >
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

      {/* Session finder — page-level overlay so ⌘⇧O works even with the chat
          column collapsed. Opens the picked session as a home column. */}
      <SessionSearchPanel
        open={sessionSearchOpen}
        onClose={() => setSessionSearchOpen(false)}
        onOpenSession={handleToggleSession}
      />

    </div>
  );
}
