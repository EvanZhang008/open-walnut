import { useState, useCallback, useEffect, useMemo, useRef, Fragment } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { SESSION_MODELS } from '@open-walnut/core';
import { getHostCatalog } from '@/hooks/useModelCatalog';
import { useChat, mergeAdjacentErrors, type TaskContext, type ImageAttachment } from '@/hooks/useChat';
import { useAgentConsole } from '@/hooks/useAgentConsole';
import { useConversations, ACTIVE_CONV_KEY } from '@/hooks/useConversations';
import { createConversation, forkConversation, promoteConversationToTask } from '@/api/conversations';
import { FileViewer } from '@/components/common/FileViewer';
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
import { DraftSessionPanel } from '@/components/sessions/DraftSessionPanel';
import {
  applyDraftParse, clearAiFields, draftComposerKey, withDirLaunchMemory,
  launchDivergesFromDirMemory, type DraftColumn,
} from '@/components/sessions/draft-column';
import { SessionPathSelector, type QuickStartPath, type QuickStartTaskMeta } from '@/components/sessions/SessionPathSelector';
import { SessionSearchPanel } from '@/components/sessions/SessionSearchPanel';
import { freshLauncherMeta, readLastLaunchPath, rememberLaunchPath } from '@/components/sessions/task-meta-constants';
import { QuestionPopover, parseAskQuestionInput } from '@/components/chat/QuestionPopover';
import { PromoteTaskPopover, type PromoteToTaskInput } from '@/components/chat/PromoteToTaskMenu';
import { TriagePanel } from '@/components/triage/TriagePanel';
import { fetchSession, fetchSessionsForTask, fetchWorkingDirs, forkSessionInWalnut, quickStartSession } from '@/api/sessions';
import { fetchProjectDetail } from '@/api/projects';
import { deleteTask as deleteTaskApi, fetchTask, type QuickTaskParse } from '@/api/tasks';
import { fetchConfig, fetchInstallDir } from '@/api/config';
import { ContextInspectorPanel } from '@/components/context/ContextInspectorPanel';
import { QuickAccessBar } from '@/components/chat/QuickAccessBar';
import { AgentTabBar, slugifyAgentId } from '@/components/chat/AgentTabBar';
import { useChatEngine } from '@/components/chat/EngineBadge';
import { LaneComposerControls } from '@/components/chat/LaneComposerControls';
import { SessionChatHistory } from '@/components/sessions/SessionChatHistory';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useLaneSession } from '@/hooks/useLaneSession';
import { createAgentDef, updateAgentDef } from '@/api/agents';
import { log } from '@/utils/log';
import { visibleInterval } from '@/utils/page-visibility';
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
  forceAddSessionColumn,
  removeSessionColumn,
  replaceSessionColumn,
  toggleLockSlot,
} from './sessionColumns';
import { isDraftColumnId, isPendingColumnId, isPlaceholderColumnId, DRAFT_COL_PREFIX } from '@/utils/column-ids';
import { loadColWeights, saveColWeights, resizeAtBoundary } from './columnSizing';
import { useAutoAnimate } from '@formkit/auto-animate/react';

// ── Compact chat header with dropdown menu ──

// Prefill template for "Create by chat" (R2). This is PREFILLED into the chat input
// (visible + editable), NOT auto-sent — the user fills in the purpose/name then presses
// Send. Walnut then designs the agent conversationally and calls the agent_create tool.
const AGENT_BUILDER_PREFILL = `Create an interactive agent that shows up in my console. Help me design it, then create it with the agent_create tool (runner: embedded, console: true).

Purpose:
Name (optional): `;

function ChatHeaderRow({ title, connectionState, inspectorOpen, onToggleInspector, hasMessages, onClear, onOpenFiles, onFork, onPromoteToTask, promoteDefaultTitle, onCloseChat, agentSwitcher }: {
  title: string;
  connectionState: string;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  hasMessages: boolean;
  onClear: () => void;
  /** Lane engine only: browse the main AI's working directory (Files split). */
  onOpenFiles?: () => void;
  /** Lane engine only: fork this conversation (history rides --fork-session). */
  onFork?: () => void;
  /** Lane engine only: turn this WHOLE conversation into a task (creates the
   *  task + links the lane session; the chat stays right here). */
  onPromoteToTask?: (input: PromoteToTaskInput) => Promise<unknown>;
  /** Prefill for the promote form — the conversation's auto title. */
  promoteDefaultTitle?: string;
  /** Collapse the chat column — same affordance a session panel's × has. */
  onCloseChat?: () => void;
  agentSwitcher?: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
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
            {onOpenFiles && (
              <button className="chat-header-dropdown-item" onClick={() => { onOpenFiles(); setMenuOpen(false); }}>
                Files
              </button>
            )}
            {onFork && (
              <button className="chat-header-dropdown-item" onClick={() => { onFork(); setMenuOpen(false); }}>
                Fork conversation
              </button>
            )}
            {onPromoteToTask && hasMessages && (
              <button className="chat-header-dropdown-item" onClick={() => { setPromoteOpen(true); setMenuOpen(false); }}>
                Create task from chat
              </button>
            )}
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
        {onPromoteToTask && (
          <PromoteTaskPopover
            open={promoteOpen}
            anchorRef={menuRef}
            defaultTitle={promoteDefaultTitle ?? ''}
            onClose={() => setPromoteOpen(false)}
            onSubmit={onPromoteToTask}
          />
        )}
      </div>
      {onCloseChat && (
        <button
          className="chat-header-menu-btn"
          onClick={onCloseChat}
          title="Hide chat"
          aria-label="Hide chat"
        >
          &#x2715;
        </button>
      )}
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

/** Optional seeds for a new draft column.
 *
 *  `cwd`/`host` apply verbatim — a draft NO LONGER inherits the last-launch path
 *  (readLastLaunchPath): a fresh "+" opens with no folder chosen, and the
 *  quick-access chips in its launch bar cover the folders the user actually works
 *  in. A sticky path meant every draft silently pointed at wherever the previous
 *  launch happened to be, which is the one thing the chips make unnecessary. */
interface DraftSeed {
  project?: string;
  cwd?: string;
  host?: string | null;
  hostLabel?: string;
  /**
   * Pin tier the new task should land in — a pin-tier group header's "+" (R8).
   *
   * A SEED, not a user edit: it is written into `meta.pinTier` WITHOUT setting
   * `metaTouched`, because that flag is also the per-directory launch-memory
   * switch — latching it here would freeze the model at whatever folder the draft
   * opened on and make every later folder change launch with the wrong one.
   */
  pinTier?: string;
  /** This `cwd` is an explicit PIN (a task's own folder), not a suggestion — a
   *  later async seed (e.g. a project's default dir) must not move it. A
   *  memory-derived cwd deliberately leaves this false: nobody chose it. */
  cwdPinned?: boolean;
  /** Bind the draft to an existing task (task row ▶ Start on a title-only task):
   *  Start reuses that task instead of minting a new one. */
  taskId?: string;
  boundTaskTitle?: string;
  /** Fork draft (session Fork button): Start calls the fork API on this session
   *  instead of quick-start. Seeded WITH the source's cwd/host/project, all
   *  pinned/final — a fork resumes the source conversation in place. */
  forkOf?: { sessionId: string; title?: string };
  /** Preselect this model (fork: the source session's). Applied like pinTier —
   *  WITHOUT metaTouched, so it reads as a default, not a user edit. */
  model?: string;
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

  // ── Thin-layer lane chat (config.agent.provider='claude-code') ──
  // The main AI IS a Claude Code session: the chat panel mounts the session
  // timeline (SessionChatHistory — tool cards, collapse, diffs, the works)
  // directly on the conversation's lane session, and sends ride the ordinary
  // session queue. The old chat framework (useChat streaming + ChatMessage)
  // stays byte-identical for the in-process engine and non-general agents.
  const chatEngine = useChatEngine();
  const [laneResetNonce, setLaneResetNonce] = useState(0);
  // Every console agent runs on the lane engine — same session timeline, same
  // composer, per-agent persona (consoleAgentProfile server-side).
  const laneActive = chatEngine === 'claude-code';
  const lane = useLaneSession(
    laneActive, agentConsole.activeAgentId, conversations.activeConversationId, laneResetNonce,
  );
  const laneSend = useSessionSend(laneActive ? lane.sessionId : null);
  const [laneStreaming, setLaneStreaming] = useState(false);
  const { health, loading: healthLoading } = useSystemHealth();
  const { connectionState } = useWebSocket();
  const { notify } = useNotifications();
  const { tasks, loading, refreshing: tasksRefreshing, error: tasksError, toggleComplete, setPhase, create, update, reorder, moveTask, reparentTask, deleteTask, batchSetPhase, batchDelete, bakeOrder, showOperationError, taskGroups, hiddenGroups, groupTasks, addToGroup, ungroupTasks, renameGroup, setGroupHidden } = useTasksContext();
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
  const { projectByCwd, projectDefaults } = projectRegistry;
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

  // Agent dropdown's per-row ＋: open a NEW conversation under that agent. For the
  // active agent this is just create(); for another agent, create server-side first
  // (the server marks it active), then switch — useConversations' remount fetch
  // picks the fresh conversation up as active.
  const handleNewConversationForAgent = useCallback(async (agentId: string) => {
    try {
      if (agentId === agentConsole.activeAgentId) {
        await conversations.create();
        return;
      }
      const meta = await createConversation(agentId);
      try { localStorage.setItem(ACTIVE_CONV_KEY(agentId), meta.id); } catch { /* hint only */ }
      agentConsole.switchAgent(agentId);
    } catch (err) {
      log.warn('frontend', 'MainPage: new conversation for agent failed', { agentId, error: String(err) });
    }
  }, [agentConsole, conversations]);

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
  // Ref mirror for the []-dep handlers (openDraftColumn, the dock toggle).
  const chatVisibleRef = useRef(chatVisible);
  chatVisibleRef.current = chatVisible;
  // The draft column that BORROWED the main chat's spot: a "+" while the chat is
  // open hides the chat for the draft's lifetime (the draft takes its place)
  // instead of stacking a column beside it. Whoever borrowed gives it back —
  // every draft exit funnels through forgetDraft, which restores the chat iff
  // this ref names that draft. EXPLICITLY re-opening the chat (sidebar/dock
  // toggle) while borrowed CANCELS the borrow: the user clearly wants both, so
  // the draft demotes to a plain extra column and closing it later must not
  // touch the chat again.
  const chatBorrowedByDraftRef = useRef<string | null>(null);

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

  // ── Draft session columns ("+" → an empty column, zero network) ──
  // The DraftColumn rows are the ONLY home of a draft's cwd/host/project/meta;
  // sessionColumns just carries the `draft:` id that keys the strip slot. Both
  // must be mutated together (open / close / Start).
  const [draftColumns, setDraftColumns] = useState<DraftColumn[]>([]);
  // Ref mirror so handlers can read the current drafts synchronously without
  // being re-created on every draft edit (same pattern as sessionColumnsRef).
  const draftColumnsRef = useRef(draftColumns);
  draftColumnsRef.current = draftColumns;
  // Monotonic suffix: two "+" clicks inside the same millisecond would otherwise
  // mint the SAME id, and forceAddSessionColumn would treat the second as "move
  // the existing column" — one visible column for two drafts.
  const draftSeqRef = useRef(0);
  // Tasks with a ▶ Start launch currently in flight (see handleStartSessionForTask).
  const startingTaskIdsRef = useRef(new Set<string>());
  // Which draft should take the caret. A bump (new id, or the same id again via
  // the anti-spam valve) re-runs DraftSessionPanel's focus effect.
  const [focusDraftId, setFocusDraftId] = useState<string | null>(null);
  const draftById = useMemo(() => new Map(draftColumns.map(d => [d.id, d])), [draftColumns]);
  // Stable handle for the mount-time window listeners below (they run with `[]`
  // deps and must not capture the first render's callback).
  const openDraftColumnRef = useRef<(seed?: DraftSeed) => string>(() => '');
  // Same reason as above: the mount-time `session-launcher:open` listener needs the
  // project-seeded route (a /tasks group header "+" arrives through that event).
  const openLauncherForProjectRef = useRef<(project: string) => void>(() => {});

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
  // sentinel: INBOX_TAB). Initialized from the SAME localStorage key
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

  // How many columns are placeholders (`draft:`/`pending:`) right now. Only used
  // to RE-KEY the eviction effect below — see the license note there.
  const placeholderCount = useMemo(
    () => sessionColumns.reduce((n, s) => n + (isPlaceholderColumnId(s.id) ? 1 : 0), 0),
    [sessionColumns],
  );

  // Auto-evict excess session columns when effectiveMaxPanels shrinks (e.g. auto mode + window resize).
  // Gated on `panelModeLoaded`: until the config fetch settles the hook reports the
  // '2' DEFAULT, and evicting on that would silently drop a 3rd restored column
  // (sessionStorage/deep link) before the user's real '3' arrives — eviction is
  // one-way, so the column never comes back.
  //
  // OVERFLOW LICENSE: "+" inserts unconditionally (forceAddSessionColumn), and
  // placeholders are EXTRA in trimUnlockedToMax — they neither count toward max
  // nor get evicted, so the strip legitimately sits above max while a
  // draft/pending column is open and the REAL columns behave exactly as if it
  // weren't there ("draft 是单独额外的,不去争抢现有的"). `placeholderCount` in
  // the deps is what makes the license SELF-EXPIRING: draft→pending keeps the
  // count (still free), while pending→real converts the free column into a
  // budget-counting one — this re-run is the trim that resolves the overflow.
  // Count, not the array: a mere reorder/lock toggle must not re-fire an
  // eviction.
  //
  // The RISING edge is still skipped: with placeholders outside the budget the
  // trim would be a no-op there anyway, but skipping keeps a simultaneous
  // real-overflow race from evicting on the exact commit the user pressed "+".
  const trimGuardRef = useRef({ placeholders: placeholderCount, max: effectiveMaxPanels });
  useEffect(() => {
    const prev = trimGuardRef.current;
    trimGuardRef.current = { placeholders: placeholderCount, max: effectiveMaxPanels };
    if (!panelModeLoaded) return;
    // A placeholder appeared and nothing else changed → license granted, hands off.
    // (A simultaneous max change still trims: that's a real capacity shrink.)
    if (placeholderCount > prev.placeholders && effectiveMaxPanels === prev.max) return;
    setSessionColumns(prev2 => {
      const max = triageOpenRef.current ? effectiveMaxPanels - 1 : effectiveMaxPanels;
      return trimUnlockedToMax(prev2, max);
    });
  }, [effectiveMaxPanels, panelModeLoaded, placeholderCount]);

  // Session/task quick-entry popovers above the chat input. There is only ONE
  // anchor left (the chat composer): the todo-panel launcher popover and its
  // `launcherAnchor` discriminator were replaced by draft session columns.
  const [pathSelectorOpen, setPathSelectorOpen] = useState(false);
  const [quickTaskOpen, setQuickTaskOpen] = useState(false);
  // Session finder — search existing sessions by title/task/cwd/host and open
  // one as a column. Toggled by the QuickAccessBar pill or ⌘⇧O.
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [quickStartPath, setQuickStartPath] = useState<QuickStartPath | null>(null);
  // Walnut's own source checkout (null on npm installs / cloud) — drives the
  // fix-walnut pill. Fetched once; the API layer caches for the page lifetime.
  const [walnutInstallDir, setWalnutInstallDir] = useState<string | null>(null);
  useEffect(() => { fetchInstallDir().then(setWalnutInstallDir); }, []);
  // Warm the working-dirs module cache ONCE, so that by the time a draft column
  // opens, its recent-folder chips and its per-directory launch memory can be read
  // SYNCHRONOUSLY (peekWorkingDirs) — the draft-OPEN path itself is contractually
  // network-free, so a cold cache there means "no chips", never "fetch now".
  //
  // Fired on mount rather than on a timer, deliberately: it must land inside the
  // page's initial load window. A deferred fetch could otherwise be issued
  // moments AFTER load settles — i.e. exactly while a user (or the zero-network
  // acceptance spec) is watching the "+" click, where a working-dirs request is
  // indistinguishable from the draft path fetching. This is one small GET, not the
  // per-host SSH fan-out that `prewarmWorkingDirs` still keeps behind a real open.
  // Fire-and-forget; the API layer dedupes and caches for the page lifetime.
  useEffect(() => { void fetchWorkingDirs().catch(() => { /* offline → chips stay hidden */ }); }, []);
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

  // On phones only ONE column is displayed (`.is-mobile-active`; every sibling is
  // display:none). The rule used to be "the last column", which broke "+": drafts
  // insert LEFTMOST, so on a phone the new composer was the one hidden column and
  // the tap looked like it did nothing. Prefer the first draft, else keep the old
  // rightmost default (a launch/open still lands on the newest real session).
  const mobileActiveIdx = useMemo(() => {
    const draftIdx = sessionColumns.findIndex(s => isDraftColumnId(s.id));
    return draftIdx >= 0 ? draftIdx : sessionColumns.length - 1;
  }, [sessionColumns]);

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
    // Only persist real session IDs (draft:/pending: placeholders resolve to
    // nothing after a reload) to sessionStorage
    const persistable = sessionColumns.filter(s => !isPlaceholderColumnId(s.id));
    if (persistable.length > 0) sessionStorage.setItem(SS_SESSION_COLUMNS_KEY, JSON.stringify(persistable));
    else sessionStorage.removeItem(SS_SESSION_COLUMNS_KEY);
  }, [sessionColumns]);

  // Persist chatVisible + broadcast to FocusDock / Sidebar
  useEffect(() => {
    // Persist the user's PREFERENCE, not the borrow: a draft hiding the chat is
    // transient (drafts don't survive a reload), so a reload must bring the chat
    // back rather than leave it hidden with no draft to give it back. The
    // broadcast stays the ACTUAL state so the sidebar/dock toggles read true.
    sessionStorage.setItem(SS_CHAT_VISIBLE_KEY, String(chatBorrowedByDraftRef.current ? true : chatVisible));
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
      // Toggle main chat panel visibility. Turning it ON while a draft has
      // borrowed its spot is an EXPLICIT ask for both — cancel the borrow, so
      // closing that draft later leaves the chat where the user put it.
      if (!chatVisibleRef.current) chatBorrowedByDraftRef.current = null;
      setChatVisible(prev => !prev);
    };
    // `/session` (src/commands/session.ts) — one verb "New": grow a draft column
    // instead of opening the chat-anchored picker. Via the ref because this
    // listener is installed once (`[]` deps) and must not capture a stale
    // callback. Note: the picker still exists for the fix-walnut / chat pill
    // flows; this entry just no longer routes through it.
    //
    // A `project` in the detail is the CROSS-PAGE project "+" (the /tasks group
    // header, via openDraftSessionOnHome): route it through the same handler the
    // home panel's header uses, so the folder-patching half of the seed comes along
    // instead of just the pill.
    const handleSessionLauncher = (e: Event) => {
      const project = (e as CustomEvent<{ project?: string } | undefined>).detail?.project;
      if (project) openLauncherForProjectRef.current(project);
      else openDraftColumnRef.current();
    };
    const handleTaskComposer = () => {
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

  // ── Draft column handlers ──

  /**
   * "+" → a new empty session column, RIGHT NOW.
   *
   * Synchronous and network-free by contract (hard requirement of the design):
   * cwd/host come from the seed only, task meta from the sticky launcher
   * defaults. Nothing is created server-side — the draft is 0 bytes until Start.
   * Returns the draft id so callers can patch it asynchronously.
   *
   * NO STICKY PATH: an unseeded draft opens with cwd '' — the neutral state the
   * rest of the app already models (the pill reads "Choose folder…", and a Start
   * with no cwd opens the folder picker rather than launching somewhere
   * arbitrary; there is no "default cwd" anywhere in the launch path — quick-start
   * rejects a missing one). The launch bar's quick-access chips are what make the
   * common folders one click away, which is why inheriting the previous launch's
   * path is no longer worth the surprise of a draft silently pointing elsewhere.
   */
  const openDraftColumn = useCallback((seed?: DraftSeed): string => {
    // Anti-spam valve: repeated "+" on an untouched empty draft just refocuses it
    // instead of stacking another. Only the LEFTMOST column counts — drafts are
    // PINNED to the far left (sessionColumns.ts insertLeftmost: real inserts land
    // beside a draft, never in front), so an open draft is reliably at index 0.
    const leftmost = sessionColumnsRef.current[0];
    const leftmostDraft = leftmost && isDraftColumnId(leftmost.id)
      ? draftColumnsRef.current.find(d => d.id === leftmost.id)
      : undefined;
    // A SEEDED open (task ▶ Start, fork, project "+") rewrites the reused
    // draft's folder/project/binding. The rule (user-stated): a draft the user
    // has EDITED BY HAND — folder pick, project pick, any meta edit, or typed
    // text (checked below) — must never be overridden; the seed opens its own
    // fresh column instead. A draft only SEEDS have written (e.g. bound by a
    // previous task ▶) is fair game: picking a new task rebinds it rather than
    // leaving the stale binding there forever. `userTouched` (not `cwdPinned`/
    // `taskId`, which seeds also set) is exactly that by-hand distinction. An
    // UNSEEDED "+" overrides nothing, so it may still refocus a touched-but-
    // empty draft.
    if (leftmostDraft && !(seed && leftmostDraft.userTouched)) {
      // "Untouched" is read off the LIVE textarea first, with the persisted draft
      // as the fallback. localStorage alone would lie for 300ms after a keystroke
      // (ChatInput's save is debounced), and inside that window a "+" would refuse
      // to open a second column and instead bounce the caret back into text the
      // user had already started.
      const textarea = document.querySelector<HTMLTextAreaElement>(
        `[data-draft-id="${CSS.escape(leftmostDraft.id)}"] .chat-input-textarea`,
      );
      let composed = textarea?.value ?? '';
      if (!composed && !textarea) {
        try { composed = localStorage.getItem(draftComposerKey(leftmostDraft.id)) ?? ''; } catch { /* storage off → treat as empty */ }
      }
      if (!composed.trim()) {
        // Refocus IMPERATIVELY, not via focusDraftId: the panel's focus effect is
        // keyed on `autoFocus`, and re-setting the same id is a no-op React
        // (batched null→id collapses, and an unchanged value can't flip a bool
        // prop). Scoped by data-draft-id so it lands in THIS column even with
        // several drafts open.
        requestAnimationFrame(() => {
          document.querySelector<HTMLTextAreaElement>(
            `[data-draft-id="${CSS.escape(leftmostDraft.id)}"] .chat-input-textarea`,
          )?.focus();
        });
        // Seeds still apply — "+ Add session" on a project must land its project
        // on the draft the user is looking at, not silently do nothing. A BOUND
        // seed (task ▶ Start) additionally rebinds the reused column, cwd
        // included: a task carrying its own folder outranks the memory the draft
        // opened on, and dropping the binding here would launch a second task.
        // A seed only reaches this block on a PRISTINE draft (leftmostTouched
        // gated above) — the per-field guards below are belt-and-braces.
        if (seed) {
          setDraftColumns(prev => prev.map(d => {
            if (d.id !== leftmostDraft.id) return d;
            const next = { ...d };
            if (seed.project !== undefined) {
              next.project = seed.project;
              // A "+" seed outranks a previous AI guess but NOT the user's own
              // pick — otherwise reusing the column would silently move a project
              // they chose by hand.
              if (d.projectSource !== 'user') next.projectSource = 'seed';
            }
            // Tier/model seed (pin-tier header "+", fork), again without
            // metaTouched — see DraftSeed.pinTier. Skipped once the user edited.
            if (seed.pinTier && !d.metaTouched) next.meta = { ...next.meta, pinTier: seed.pinTier };
            if (seed.model && !d.metaTouched) next.meta = { ...next.meta, model: seed.model };
            if (seed.taskId || seed.forkOf) {
              if (seed.taskId) {
                next.taskId = seed.taskId;
                next.boundTaskTitle = seed.boundTaskTitle;
              }
              // Rebinding as a fork drops any previous task binding (and vice
              // versa via the assignments above) — the two are exclusive exits.
              if (seed.forkOf) { next.forkOf = seed.forkOf; delete next.taskId; delete next.boundTaskTitle; }
              if (seed.cwd) {
                next.cwd = seed.cwd;
                next.host = seed.host ?? null;
                next.hostLabel = seed.hostLabel;
                // Only a TASK's/fork-source's own folder is a pin. A ▶ that fell
                // back to the launch memory hands the folder over as a mere
                // starting point, so a project default may still refine it.
                next.cwdPinned = seed.cwdPinned === true;
                if (!next.metaTouched) next.meta = withDirLaunchMemory(next.meta, next.cwd, next.host);
              }
            }
            return next;
          }));
        }
        return leftmostDraft.id;
      }
    }

    const id = `${DRAFT_COL_PREFIX}${Date.now()}-${draftSeqRef.current++}`;
    // The seed is the ONLY path source now (a task's own cwd, or a project's
    // default patched in asynchronously). Unseeded → '' = "choose a folder".
    const pinnedSeed = !!(seed?.cwd && seed.cwdPinned);
    const cwd = seed?.cwd ?? '';
    const host = seed?.host ?? null;
    const hostLabel = seed?.hostLabel;
    setDraftColumns(prev => [
      ...prev,
      {
        id, cwd, host,
        ...(hostLabel ? { hostLabel } : {}),
        // 'seed' (not 'user'): a project "+" pre-fills the pill, but the user
        // hasn't chosen anything yet. Both are FINAL against the AI backfill —
        // the distinction exists so a future rule can tell them apart.
        ...(seed?.project ? { project: seed.project, projectSource: 'seed' as const } : {}),
        ...(seed?.taskId ? { taskId: seed.taskId, boundTaskTitle: seed.boundTaskTitle } : {}),
        ...(seed?.forkOf ? { forkOf: seed.forkOf } : {}),
        ...(pinnedSeed ? { cwdPinned: true } : {}),
        // Per-directory launch memory, applied at OPEN time: the bar shows the
        // model/engine this folder actually launches with, instead of "Auto" that
        // silently becomes something else at Start. metaTouched is false here by
        // construction, so there is no user pick to overwrite. Synchronous (module
        // cache only) — a cold cache just leaves the launcher defaults. A tier/model
        // seed rides on top WITHOUT metaTouched (see DraftSeed.pinTier/model).
        meta: {
          ...withDirLaunchMemory(freshLauncherMeta(), cwd, host),
          ...(seed?.pinTier ? { pinTier: seed.pinTier } : {}),
          ...(seed?.model ? { model: seed.model } : {}),
        },
      },
    ]);
    setSessionColumns(prev => forceAddSessionColumn(prev, id));
    setFocusDraftId(id);
    // BORROW the main chat's spot when it is open: the user is composing NEW
    // work, so the draft takes the chat's place instead of stacking a column
    // beside it ("如果 main chat 开着,优先 override 它"). The chat comes back
    // when this draft leaves (forgetDraft) — or immediately if the user re-opens
    // it by hand, which cancels the borrow (see chatBorrowedByDraftRef). Chat
    // already hidden → nothing to borrow; the draft is a plain extra column.
    // Only a NEW draft borrows: the refocus valve above never touches the chat,
    // so a cancelled borrow stays cancelled across repeated "+".
    if (chatVisibleRef.current) {
      chatBorrowedByDraftRef.current = id;
      setChatVisible(false);
    }
    return id;
    // Stable identity (refs only, no state deps) — TodoPanel is React.memo'd and
    // takes this as a prop; a new arrow per render would re-render the task list
    // on every draft keystroke.
  }, []);
  openDraftColumnRef.current = openDraftColumn;

  /** Drop a draft's client-side state: the row, its persisted composer text and
   *  its focus claim. The strip SLOT is handled by the caller, because the two
   *  exits differ there — closing removes the column, Start morphs it into the
   *  `pending:` one. */
  const forgetDraft = useCallback((draftId: string) => {
    setDraftColumns(prev => prev.filter(d => d.id !== draftId));
    setFocusDraftId(prev => (prev === draftId ? null : prev));
    try { localStorage.removeItem(draftComposerKey(draftId)); } catch { /* storage disabled */ }
    // Give the main chat its spot back if THIS draft borrowed it. Both exits
    // funnel here (✕ close and Start), so the borrow can never outlive the
    // draft; a borrow the user already cancelled (ref cleared on explicit
    // re-open) is left alone.
    if (chatBorrowedByDraftRef.current === draftId) {
      chatBorrowedByDraftRef.current = null;
      setChatVisible(true);
    }
  }, []);

  /** Discard a draft: column + row + persisted composer text. Close = no trace. */
  const closeDraftColumn = useCallback((draftId: string) => {
    setSessionColumns(prev => removeSessionColumn(prev, draftId));
    forgetDraft(draftId);
  }, [forgetDraft]);

  /**
   * A cwd/host pick landed on this draft (folder picker, or a recent-dir chip in
   * the draft body).
   *
   * `meta` is stored VERBATIM — every caller has already resolved the
   * launch-memory question for the directory it is handing over, and re-resolving
   * it here would undo the answer: the picker suppresses memory once the user
   * touches its model/engine controls during that open, so re-applying would
   * silently restore the folder's remembered model over the user's explicit Auto.
   *
   * `metaTouched` therefore STICKS once the confirmed meta diverges from the
   * picked directory's memory — that divergence is the only thing that can mean
   * "the user chose this" (see launchDivergesFromDirMemory), and without latching
   * it here a later cwd change would refresh model/engine right back over the
   * choice they just made inside the picker.
   */
  const handleDraftPathChange = useCallback((draftId: string, path: QuickStartPath, meta: QuickStartTaskMeta) => {
    setDraftColumns(prev => prev.map(d => (d.id === draftId
      // `createCwd` is always REWRITTEN (never merged) so re-picking an existing
      // folder clears a stale "create it" flag from an earlier pick.
      ? {
          // The folder is now the user's own pick (`cwdPinned`), so any ✦ the AI
          // put on it is no longer true — drop the badge with the same write.
          ...clearAiFields(d, ['cwd']),
          cwd: path.cwd, host: path.host, hostLabel: path.hostLabel, meta, cwdPinned: true,
          userTouched: true,
          createCwd: path.createCwd === true,
          metaTouched: d.metaTouched || launchDivergesFromDirMemory(meta, path.cwd, path.host),
        }
      : d)));
  }, []);

  /** Project pill / quick-access chip → an EXPLICIT project choice. `projectSource:
   *  'user'` is what makes it final: the background parse (handleDraftAiParse) will
   *  never write over it again, however the sentence changes. */
  const handleDraftProjectChange = useCallback((draftId: string, project: string) => {
    setDraftColumns(prev => prev.map(d => (d.id === draftId
      ? { ...clearAiFields(d, ['project']), project, projectSource: 'user' as const, userTouched: true }
      : d)));
  }, []);

  /**
   * A background parse of a draft's composer text landed (R9).
   *
   * Purely additive back-fill of the launch pills — which fields it MAY write is
   * `applyDraftParse`'s rule, not this handler's: project only while unclaimed,
   * tier/priority only while `metaTouched` is false, and NEITHER may latch an
   * authority flag (an AI value must not masquerade as a user pick, or it would
   * switch off per-directory launch memory). Registry lookup only — no fetch.
   */
  const projectDefaultsRef = useRef(projectDefaults);
  projectDefaultsRef.current = projectDefaults;
  const handleDraftAiParse = useCallback((draftId: string, parse: QuickTaskParse) => {
    setDraftColumns(prev => prev.map(d => (d.id === draftId
      ? applyDraftParse(d, parse, (name) => projectDefaultsRef.current.get(name.trim().toLowerCase()))
      : d)));
  }, []);

  /** Which registry project OWNS this folder (its `default_cwd`), so a draft's
   *  quick-access chip sets folder + project in one click. '' = no project
   *  declares it, in which case the caller leaves the project alone rather than
   *  clearing a seeded one. Reads the already-loaded registry — no fetch, which
   *  the draft path requires. */
  const projectForDir = useCallback(
    (cwd: string) => projectByCwd.get(cwd.replace(/\/+$/, '')) ?? '',
    [projectByCwd],
  );

  /** A launch-meta edit from the draft's launch bar (model / engine / pin tier /
   *  unread / priority). Every route in is a USER action, so this is also
   *  the one place that flips `metaTouched` — from then on the row's meta is
   *  authoritative and per-directory launch memory stops overwriting it (same
   *  contract as SessionPathSelector's `launchTouchedRef`). */
  const handleDraftMetaChange = useCallback((
    draftId: string,
    updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta,
  ) => {
    setDraftColumns(prev => prev.map(d => (d.id === draftId
      // metaTouched already stops the AI from writing these — dropping the ✦
      // badges keeps the display honest about who chose what.
      ? {
          ...clearAiFields(d, ['pinTier', 'priority', 'dueDate', 'startDate', 'endDate']),
          meta: updater(d.meta), metaTouched: true, userTouched: true,
        }
      : d)));
  }, []);

  // One-time sweep of orphaned composer drafts. Draft ids are timestamped, so a
  // key from a previous page load can never be reached again — without this the
  // user's unsent text would accumulate in localStorage forever.
  useEffect(() => {
    try {
      const prefix = draftComposerKey('');
      const stale: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) stale.push(key);
      }
      for (const key of stale) localStorage.removeItem(key);
    } catch { /* storage disabled — nothing to sweep */ }
  }, []);

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

  // ⌘⇧Enter opens a new draft session column — the keyboard twin of "+".
  // NOT ⌘N / ⌘⇧N: those are reserved by the browser (new window / new private
  // window) and cannot be preventDefault'd from a page, so binding them would
  // "work" in tests and silently lose to the browser for real users. Same
  // input-focus guard and `visible` gate as the ⌘⇧O listener above.
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).isContentEditable)) return;
        e.preventDefault();
        openDraftColumnRef.current();
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
  // Fallback poll canceller for pending columns (used by promoteToRealSession
  // below and armed by the effect further down; declared here so both can see
  // it). Holds visibleInterval's cancel fn — hidden tabs skip poll ticks.
  const pendingPollRef = useRef<(() => void) | null>(null);

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
    if (pendingPollRef.current) { pendingPollRef.current(); pendingPollRef.current = null; }
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

  // TodoPanel toolbar "+" — one verb "New": grow an empty draft session column.
  // No popover, no tabs, no network; the draft's own composer row covers what the
  // old Session|Task tab pair did ("◌ Create task for later" is the Task half).
  const handleToolbarOpenLauncher = useCallback(() => {
    openDraftColumn();
  }, [openDraftColumn]);

  // Project header "+ → Add session": open the draft IMMEDIATELY with the project
  // pill pre-filled, then patch in the project's default cwd/host when the detail
  // fetch lands. Opening first is the point — the old flow awaited the fetch
  // before showing anything, which is exactly the delay this design removes.
  const handleOpenLauncherForProject = useCallback((project: string) => {
    const draftId = openDraftColumn({ project });
    fetchProjectDetail(project).then((detail) => {
      const cwd = detail.metadata?.default_cwd;
      if (!cwd) return;
      setDraftColumns(prev => prev.map(d => {
        // Only patch while this draft is still open AND the user hasn't picked a
        // path themselves — a late async seed must never move a chosen folder.
        if (d.id !== draftId || d.cwdPinned) return d;
        const host = detail.metadata?.default_host ?? null;
        return {
          ...d, cwd, host, hostLabel: undefined,
          // The launch bar now SHOWS the model/engine, so a cwd move has to move
          // them with it (unless the user already edited them) — otherwise the bar
          // would keep displaying the previous folder's remembered model while the
          // launch used this one's.
          meta: d.metaTouched ? d.meta : withDirLaunchMemory(d.meta, cwd, host),
        };
      }));
    }).catch(() => { /* no defaults → the draft keeps the launch-memory path */ });
  }, [openDraftColumn]);
  openLauncherForProjectRef.current = handleOpenLauncherForProject;

  // Pin-tier header "+" (R8) — the same one-click-to-a-draft gesture as a project
  // header's "+", with the tier pre-selected instead of the project. Network-free:
  // a tier is a local value, so there is nothing to fetch (contrast the project
  // path above, which patches in a default_cwd when its detail lands).
  const handleOpenLauncherForTier = useCallback((tier: string) => {
    openDraftColumn({ pinTier: tier });
  }, [openDraftColumn]);

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

  // NOTE: there is deliberately no draft-column "Fix Walnut" chip. The repair
  // entry point is the CHAT pill (handleFixWalnut above) only — inside a draft the
  // chip was one more thing between the user and the folder they actually wanted,
  // and a quick-access chip for Walnut's own checkout does the same job. The
  // DraftColumn.intent plumbing (handleDraftStart forwards it to quick-start)
  // stays wired but no draft UI sets it any more.

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
      if (pendingPollRef.current) { pendingPollRef.current(); pendingPollRef.current = null; }
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
      if (pendingPollRef.current) { pendingPollRef.current(); pendingPollRef.current = null; }
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
    return () => { pendingPollRef.current?.(); };
  }, []);
  // Start polling when a pending column exists. Deliberately PENDING-only: a
  // `draft:` column has no in-flight launch to resolve, so polling for it would
  // be a 2s timer with nothing to find.
  useEffect(() => {
    const hasPending = sessionColumns.some(s => isPendingColumnId(s.id));
    if (!hasPending || pendingPollRef.current) return;
    pendingPollRef.current = visibleInterval(async () => {
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
            pendingPollRef.current!();
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
            pendingPollRef.current!();
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
  const handleForkPending = useCallback((cwd: string, host?: string, opts?: { columnId?: string }) => {
    const pendingColId = `pending:fork-${Date.now()}`;
    pendingForkMetaRef.current = { id: pendingColId, cwd, host };
    // From a fork DRAFT the column morphs in place (same one-commit swap Start
    // does for quick-start drafts); the button path inserts a new column.
    setSessionColumns(prev => (opts?.columnId
      ? replaceSessionColumn(prev, opts.columnId, pendingColId)
      : addSessionColumn(prev, pendingColId, triageOpenRef.current, maxPanelsRef.current)));
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

  /** Session panel "Fork" → a pre-bound fork DRAFT column (the shared "+"
   *  surface). Folder/host/project ride in pinned; the model is a changeable
   *  preselect. The composer, slash palette and AI backfill all come free. */
  const handleOpenForkDraft = useCallback((seed: {
    forkOf: { sessionId: string; title?: string };
    cwd: string; host: string | null; hostLabel?: string;
    project?: string; model?: string; cwdPinned: true;
  }) => {
    openDraftColumn(seed);
  }, [openDraftColumn]);

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

  const handleCreate = useCallback(async (input: { title: string; priority: string; project?: string; description?: string; due_date?: string; start_date?: string; end_date?: string; pinnedTier?: string; capture?: boolean }) => {
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
        // Long-form body (a draft column's "Create task for later": everything
        // after the first line). Passed straight through — POST /api/tasks → addTask.
        description: input.description,
        due_date: input.due_date,
        start_date: input.start_date,
        end_date: input.end_date,
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
  }, [create, focusBar, taskDefaults]);

  // Inline "+" in the Focus Dock — create a task and pin it straight to the Focus tier.
  // capture:true routes it to the configured Default Platform/Project (fast local Inbox
  // by default) rather than the active tab.
  const handleQuickAddToFocus = useCallback(async (title: string) => {
    await handleCreate({ title, priority: 'none', pinnedTier: 'focus', capture: true });
  }, [handleCreate]);

  // Read the current focus without re-creating callbacks on every focus change
  // (that would defeat React.memo on TodoPanel). Used by the Esc handler and the
  // "focused task went away" effects below.
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
    // Always focus (never toggle off) — unfocusing is done via detail panel close / Esc.
    // Increment nonce so TodoPanel re-scrolls even when the same task is re-clicked.
    setFocusScope('all'); // explicit user locate — full behavior incl. tab switch
    setFocusedTask(task);
    setFocusNonce(n => n + 1);
    setSuppressDetail(opts?.openDetail === false); // Auto-clears on next direct click (opts is undefined → false)
    // THE read event: opening a task marks it read. Deliberately NOT gated on
    // "is this a new focus" — a task can go unread again while it is still the
    // focused one (the agent finishes another turn), and under the old
    // !isRefocus gate re-clicking it left the dot stuck on forever. Guarded on
    // task.unread so a read task issues no write at all.
    if (task.unread) {
      update(task.id, { unread: false });
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

  // "Create task from chat" — promotes the WHOLE active conversation. The server
  // creates the task and links the conversation's lane session to it; the chat
  // stays right here in Main Chat, and the task's session circle routes back to
  // this same transcript (dual visibility, deliberately). Locate + toast + Undo
  // mirror handleQuickTaskCreate; Undo deletes with force (the task holds a live
  // session slot, which a plain delete correctly 409s on).
  const handlePromoteChatToTask = useCallback(async (input: PromoteToTaskInput) => {
    const cid = conversations.activeConversationId;
    if (!cid) throw new Error('No active conversation');
    const { task } = await promoteConversationToTask(agentConsole.activeAgentId, cid, input);
    setTodoVisible(true);
    const known = taskMapRef.current.get(task.id);
    handleFocusTask(known ?? task, { openDetail: false });
    notify({
      kind: 'sort',
      severity: 'success',
      title: `Task created: ${task.title}`,
      body: `${input.project?.trim() || 'Inbox'} · linked to this chat`,
      dedupKey: task.id,
      persistent: false,
      action: { label: 'Undo', kind: 'callback' },
      onAction: () => { deleteTaskApi(task.id, { force: true }).catch(() => {}); },
    });
    return task;
  }, [agentConsole.activeAgentId, conversations.activeConversationId, handleFocusTask, notify]);

  // Core quick-start launcher — creates the pending session column and fires the
  // API call. Deliberately does NOT touch chat state/visibility: the todo-panel
  // "+" entry point starts sessions while the chat column stays hidden (the CLI
  // spawns with an empty first message and idles on stdin).
  const launchQuickStart = useCallback((
    qsp: QuickStartPath,
    metaSnapshot: QuickStartTaskMeta | null,
    text: string,
    images?: ImageAttachment[],
    project?: string,
    opts?: {
      /** Existing column to MORPH into the pending column (a `draft:` id) instead
       *  of inserting a new one — keeps the draft's index and lock state. */
      columnId?: string;
      /** Reuse this task instead of letting the server create one (task ▶ Start). */
      taskId?: string;
    },
  ) => {
      // Set pending ref BEFORE the async call so WS events that arrive
      // during the HTTP round-trip can still match via taskId. With a real
      // taskId in hand (▶ Start on an existing task) that IS the match key —
      // the server won't mint a new one to swap in later.
      const tempTaskId = `pending-${Date.now()}`;
      pendingQuickStartRef.current = opts?.taskId ?? tempTaskId;

      // Immediately open a pending session column for instant visual feedback.
      // Morph in place when a draft asked for it; otherwise force-insert.
      // forceAddSessionColumn, NOT addSessionColumn: the old insert silently
      // returned `prev` when every panel was locked, so the launch proceeded into
      // a column that never existed (invisible session, no error). There is no
      // rejection path left, hence no toast.
      const pendingColId = `pending:${tempTaskId}`;
      setSessionColumns(prev => {
        if (opts?.columnId) {
          const morphed = replaceSessionColumn(prev, opts.columnId, pendingColId);
          if (morphed !== prev) return morphed;   // draft column found → morphed in place
        }
        return forceAddSessionColumn(prev, pendingColId);
      });
      // Store pending metadata for rendering. `realTaskId` is seeded up front for
      // the reuse case so the error banner + Retry (which reuses the task rather
      // than creating a second one) work before the HTTP response lands.
      pendingQuickStartMetaRef.current = {
        id: pendingColId,
        cwd: qsp.cwd,
        host: qsp.host ?? undefined,
        hostLabel: qsp.hostLabel ?? undefined,
        message: text,
        ...(opts?.taskId ? { realTaskId: opts.taskId } : {}),
      };

      // `pinTier: null` — NOT undefined — is how an explicit "don't pin this"
      // reaches the server: undefined is dropped by JSON.stringify, and the
      // fix-walnut branch treats an absent pinTier as "client didn't choose" and
      // applies its own default tier. Without the null, unpinning inside a
      // fix-walnut re-edit was silently overridden back to the server default.
      const taskMeta = metaSnapshot ? {
        unread: metaSnapshot.unread,
        priority: metaSnapshot.priority,
        pinTier: metaSnapshot.pinTier ?? null,
        ...(metaSnapshot.dueDate ? { due_date: metaSnapshot.dueDate } : {}),
        ...(metaSnapshot.startDate ? { start_date: metaSnapshot.startDate } : {}),
        ...(metaSnapshot.endDate ? { end_date: metaSnapshot.endDate } : {}),
      } : undefined;
      // Model is a session arg, not task metadata. undefined = Auto (let the
      // CLI/config default decide) — only forwarded when the user picks one.
      const model = metaSnapshot?.model;
      // Codex is local-only: if the user flipped to Codex and then confirmed a
      // remote-host path (toggle disables but meta keeps the stale value), fall
      // back to Claude instead of letting the server reject the quick-start.
      const engine = qsp.host && qsp.host !== '__local__' ? undefined : metaSnapshot?.engine;

      const settled = quickStartSession({
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
        taskId: opts?.taskId,
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
        // RE-WARM the working-dirs cache this launch just invalidated (a new
        // session = a new/updated path entry, so quickStartSession drops it).
        // Without this the cache stays cold for the rest of the page's life and
        // every later draft loses its recent-folder chips + per-directory launch
        // memory — both of which read the cache SYNCHRONOUSLY and never fetch.
        // Fired here, well before any draft opens, so the open path stays
        // network-free; failure just leaves the chips hidden.
        void fetchWorkingDirs().catch(() => { /* chips stay hidden until the next launch */ });
        // No Personal AI notification here anymore. Title AND project are both
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

      // THE single write point of the launch memory — every entry point funnels
      // through here. Still read by ▶ Start on a task with no folder of its own
      // (the only remaining reader; a plain "+" draft is deliberately
      // path-neutral). Written on dispatch (not on success): the intent is what
      // matters, and a failed launch still tells us where they were aiming.
      rememberLaunchPath({ cwd: qsp.cwd, host: qsp.host ?? null, ...(qsp.hostLabel ? { hostLabel: qsp.hostLabel } : {}) });

      // For ▶ Start's in-flight latch: the launch is only "settled" once the HTTP
      // round-trip lands (both branches above already handled their own effects —
      // this resolves either way and never rejects).
      return settled.then(() => undefined, () => undefined);
  }, [notify]);

  // ── Draft column → session / task ──

  /**
   * "Start ↵" in a draft column. Returns a PROMISE always (never a bare `false`):
   * ChatInput restores the composer only for a promise resolving false — a sync
   * false takes its other branch and CLEARS the persisted draft, losing the text.
   */
  const handleDraftStart = useCallback(async (draftId: string, text: string, images?: ImageAttachment[]): Promise<boolean> => {
    const draft = draftColumnsRef.current.find(d => d.id === draftId);
    // Gone (double-send, closed mid-flight): report success so ChatInput doesn't
    // resurrect text into a composer that no longer exists.
    if (!draft) return true;
    if (!draft.cwd) {
      // No folder yet → ask for one and keep the text. The panel self-guards this
      // case before ever calling us; this is the belt-and-braces path (state
      // divergence), so drive the picker through the nonce rather than dead-ending.
      setDraftColumns(prev => prev.map(d => (d.id === draftId ? { ...d, openPickerNonce: (d.openPickerNonce ?? 0) + 1 } : d)));
      return false;
    }
    // FORK draft: Start continues the source conversation via the fork API
    // instead of quick-start. Same one-commit morph (draft: → pending:fork-…)
    // and the same pending/promote machinery the Fork button already uses.
    if (draft.forkOf) {
      const src = draft.forkOf.sessionId;
      forgetDraft(draftId);
      handleForkPending(draft.cwd, draft.host ?? undefined, { columnId: draftId });
      forkSessionInWalnut(src, {
        ...(text.trim() ? { message: text.trim() } : {}),
        ...(images?.length ? { images } : {}),
        // Only pass a model the user actually chose over the seeded default —
        // the fork inherits the source session's model server-side otherwise.
        ...(draft.metaTouched && draft.meta.model ? { model: draft.meta.model } : {}),
      }).then((result) => {
        handleForkResolved(result.taskId, result.sessionId);
      }).catch((err) => {
        handleForkFailed(err instanceof Error ? err.message : 'Fork failed');
      });
      return true;
    }
    // A BOUND draft (task ▶ Start on a title-only task) with an empty composer
    // still has something to say: the task's own title. Without this the CLI
    // would spawn and idle on a task the user explicitly asked to work on.
    const message = text.trim() || (draft.taskId ? draft.boundTaskTitle ?? '' : text);
    // ONE commit: the strip slot morphs draft:→pending: (inside launchQuickStart)
    // while the draft row + its composer key disappear. Splitting these would
    // render either a `pending:` column still holding a DraftSessionPanel, or a
    // draft row with no column — both flash visibly.
    forgetDraft(draftId);
    launchQuickStart(
      // createCwd must ride along: the picker's "Create folder & start" row
      // confirms a path that does not exist yet, and only this flag makes
      // quick-start mkdir it before spawning. `intent` likewise: it is what turns
      // the launch into a repair (server-side briefing + task title/project).
      {
        cwd: draft.cwd, host: draft.host, hostLabel: draft.hostLabel,
        ...(draft.createCwd ? { createCwd: true } : {}),
        ...(draft.intent ? { intent: draft.intent } : {}),
      },
      draft.meta,
      message,
      images,
      draft.project || undefined,
      // `taskId` on a bound draft REUSES that task (server's existingTaskId
      // branch) instead of minting a second one for the same work.
      { columnId: draftId, ...(draft.taskId ? { taskId: draft.taskId } : {}) },
    );
    return true;
  }, [forgetDraft, launchQuickStart, handleForkPending, handleForkResolved, handleForkFailed]);

  /** "◌ Create task for later": the composed text becomes a task, no session. First
   *  line = title, the rest = description. Images are dropped (text-only by design). */
  const handleDraftSaveAsTask = useCallback(async (draftId: string, text: string) => {
    const draft = draftColumnsRef.current.find(d => d.id === draftId);
    const [firstLine, ...rest] = text.split('\n');
    const title = firstLine.trim();
    if (!title) return;   // button is disabled on empty, but a whitespace-only body can still reach here
    const description = rest.join('\n').trim();
    // Optimistic: the column vanishes on click, before the POST. handleQuickTaskCreate
    // owns the outcome UI (toast + Undo, or the shared operation-error banner).
    closeDraftColumn(draftId);
    try {
      await handleQuickTaskCreate({
        title,
        // The launch bar's meta applies to the TASK exit too — tier, priority and
        // dates were picked (or ✦-suggested) for this work item, not for the
        // session transport. Same fields quick-start would have written.
        priority: draft?.meta.priority ?? 'none',
        ...(draft?.project ? { project: draft.project } : {}),
        ...(description ? { description } : {}),
        ...(draft?.meta.pinTier ? { pinnedTier: draft.meta.pinTier } : {}),
        ...(draft?.meta.dueDate ? { due_date: draft.meta.dueDate } : {}),
        ...(draft?.meta.startDate ? { start_date: draft.meta.startDate } : {}),
        ...(draft?.meta.endDate ? { end_date: draft.meta.endDate } : {}),
      });
    } catch {
      // The create rejected (useTasks already showed the operation-error banner and
      // rolled its optimistic row back). Put the column BACK with the text intact —
      // an optimistic close must never be the reason a user's writing disappears.
      // Same id on purpose: it's timestamped so it can't collide, and remounting
      // under it makes ChatInput's mount-time draft read restore the text. The key
      // is written BEFORE the state commit for exactly that reason.
      if (draft) {
        try { localStorage.setItem(draftComposerKey(draft.id), text); } catch { /* quota */ }
        setDraftColumns(prev => (prev.some(d => d.id === draft.id) ? prev : [...prev, draft]));
        setSessionColumns(prev => forceAddSessionColumn(prev, draft.id));
        setFocusDraftId(draft.id);
      }
    }
  }, [closeDraftColumn, handleQuickTaskCreate]);

  /**
   * "▶ Start" on a task row — one click from a task to a working session.
   *
   * Four outcomes, in priority order:
   *  1. The task already HAS a session → just show it (never launch a second one).
   *  2. No cwd known anywhere → open a draft column seeded with the task's project
   *     so the user picks a folder; the ▶ is intentionally not a dead end.
   *  3. TITLE-ONLY task → open a BOUND draft instead of launching. A bare title is
   *     not a brief: launching straight away spends a session on "do this thing"
   *     with no context, so the user gets a composer (pre-pointed at the task's
   *     folder/project, headed "for: <title>") to write the actual instruction.
   *     The draft carries `taskId`, so Start reuses this task rather than minting
   *     a second one — and an empty composer falls back to the title, i.e. the old
   *     behavior is still one keystroke away.
   *  4. Task WITH a description → launch directly, reusing THIS task (`taskId`),
   *     with title + description as the first message. The brief already exists.
   */
  const handleStartSessionForTask = useCallback(async (task: Task) => {
    const existing = resolveTaskSessionId(task);
    if (existing) { openSessionOrToast(existing); return; }

    // In-flight latch. `resolveTaskSessionId` above can't gate a SECOND click:
    // the task's session_id only lands after the launch round-trips (~270ms
    // measured), well inside a double-click, and each unguarded pass spawned a
    // real duplicate CLI session burning tokens against the same brief. The
    // draft paths below don't strictly need it (openDraftColumn has its own
    // refocus valve) but they clear it on their synchronous exit anyway —
    // cheaper than proving which branch a given task takes before latching.
    if (startingTaskIdsRef.current.has(task.id)) return;
    startingTaskIdsRef.current.add(task.id);
    let unlatchDeferred = false;
    try {
      const last = readLastLaunchPath();
      const cwd = task.cwd || last?.cwd;
      if (!cwd) {
        openDraftColumn({
          project: task.project || undefined,
          taskId: task.id, boundTaskTitle: task.title,
        });
        return;
      }

      // The home list payload (`fields=list`) DROPS description and keeps only the
      // `has_description` flag, so the full task has to be fetched to build the
      // first message. Best-effort: a failed fetch still launches with the title.
      // Typed as optional even though core Task declares `description: string` —
      // that projection genuinely omits the field at runtime.
      let description: string | undefined = task.description;
      if (!description && (task as { has_description?: boolean }).has_description) {
        const full = await fetchTask(task.id).catch(() => null);
        description = full?.description;
      }

      // Title-only → hand the user a bound draft, don't launch. Read AFTER the lazy
      // fetch above so a list-payload row (description dropped, `has_description`
      // true) isn't mistaken for title-only.
      if (!description?.trim()) {
        openDraftColumn({
          project: task.project || undefined,
          taskId: task.id, boundTaskTitle: task.title,
          // A task's own cwd is a PIN; otherwise the folder this ▶ would have
          // launched in (`cwd`, resolved from the launch memory above) rides along
          // as a mere starting point (no pin — a project default may still refine
          // it). Spelled out HERE rather than inherited from openDraftColumn, which
          // is deliberately path-neutral now: a plain "+" must not inherit the last
          // launch, but a ▶ that already decided it has somewhere to run should hand
          // the bound draft that same folder.
          ...(task.cwd
            ? { cwd: task.cwd, host: null, cwdPinned: true }
            : { cwd, host: last?.host ?? null, ...(last?.hostLabel ? { hostLabel: last.hostLabel } : {}) }),
        });
        return;
      }

      const message = `${task.title}\n\n${description}`;

      // Host rides ONLY with a memory-derived cwd. A task carrying its own cwd is
      // pinned to that path — pairing it with the last remembered host would launch
      // a local folder on whatever remote box was used last.
      const fromMemory = !task.cwd;
      // Awaited so the latch holds through the whole HTTP round-trip — the
      // window in which a second click still sees a session-less task.
      await launchQuickStart(
        {
          cwd,
          host: fromMemory ? (last?.host ?? null) : null,
          ...(fromMemory && last?.hostLabel ? { hostLabel: last.hostLabel } : {}),
        },
        freshLauncherMeta(),
        message,
        undefined,
        task.project || undefined,
        { taskId: task.id },
      );
      // HTTP settling is NOT the end of the race: `task.session_id` only reaches
      // this row via the task:updated broadcast, so `resolveTaskSessionId` at the
      // top still answers null for a beat after the await. Hold the latch a few
      // seconds longer — long past any broadcast, short enough that a genuinely
      // failed launch (whose notification the user just read) can be retried.
      unlatchDeferred = true;
      setTimeout(() => startingTaskIdsRef.current.delete(task.id), 5000);
    } finally {
      if (!unlatchDeferred) startingTaskIdsRef.current.delete(task.id);
    }
  }, [launchQuickStart, openDraftColumn, openSessionOrToast]);

  // Lane stop: interrupt the CLI turn through the session path (chat:stop's
  // AbortController means nothing to a lane turn).
  const handleLaneStop = useCallback(() => {
    if (lane.sessionId) void laneSend.stopTurn(lane.sessionId);
  }, [lane.sessionId, laneSend]);

  // Lane clear: the existing clear endpoint archives the lane server-side
  // (archiveLaneForConversation), so afterwards force a re-resolve — the next
  // resolve mints a fresh session.
  const handleClearChat = useCallback(() => {
    chat.clearMessages();
    if (laneActive) setLaneResetNonce((n) => n + 1);
  }, [chat, laneActive]);

  // Lane file viewing — a clicked file path in the timeline, or the ⋯ menu's
  // "Files" (browse the main AI's working directory). One overlay serves both:
  // the chat column has no split-view chrome, so the full-screen FileViewer
  // (explorer + preview) is the right surface here.
  const [laneFileView, setLaneFileView] = useState<{ path: string; line?: number } | null>(null);
  const handleLaneFileOpen = useCallback((path: string, line?: number) => {
    setLaneFileView({ path, line });
  }, []);
  const handleLaneOpenFiles = useCallback(() => {
    // Root at the lane's cwd (~/.open-walnut — memory, notes, config all live there).
    if (lane.cwd) setLaneFileView({ path: lane.cwd });
  }, [lane.cwd]);

  // Lane fork: server creates the conversation + forked session (history rides
  // --fork-session) and sets the new conversation active; refresh + switch to it.
  const handleLaneFork = useCallback(() => {
    const cid = conversations.activeConversationId;
    if (!cid) return;
    forkConversation(agentConsole.activeAgentId, cid)
      .then((r) => { conversations.switchTo(r.conversation.id); conversations.refresh(); })
      .catch((err) => {
        notify({
          kind: 'operation-error', severity: 'error', title: 'Fork failed',
          body: String(err instanceof Error ? err.message : err), persistent: true,
          dedupKey: `lane-fork:${cid}`,
        });
      });
  }, [agentConsole.activeAgentId, conversations, notify]);

  // Provider switch (claude ⇄ codex) — legal only while the conversation is
  // EMPTY (no messages yet): the server archives the just-minted lane session
  // and re-mints one on the requested engine. The pill's picker only offers
  // this while `laneConversationEmpty` below, so the 409 path is a race guard.
  const laneConversationEmpty = (conversations.conversations.find(
    (c) => c.id === conversations.activeConversationId,
  )?.messageCount ?? 0) === 0;
  const handleLaneProviderSwitch = useCallback((provider: 'claude' | 'codex') => {
    lane.swapEngine(provider).catch((err) => {
      notify({
        kind: 'operation-error', severity: 'error', title: 'Provider switch failed',
        body: String(err instanceof Error ? err.message : err), persistent: true,
        dedupKey: `lane-engine:${conversations.activeConversationId ?? 'unknown'}`,
      });
    });
  }, [lane, notify, conversations.activeConversationId]);

  // Lane send: through the ordinary session queue (session:send), exactly like
  // any session composer. ensure() covers the send-before-resolve window (the
  // eager resolve usually wins). No task-context / plan-mode prefixes here —
  // the lane persona carries its own instructions; those extras stay with the
  // in-process engine.
  const handleLaneSend = useCallback((text: string, images?: ImageAttachment[]) => {
    const trimmed = text.trim();
    if (!trimmed && !(images?.length)) return;
    if (lane.sessionId) {
      void laneSend.send(lane.sessionId, trimmed, images);
    } else {
      lane.ensure()
        .then((sid) => laneSend.send(sid, trimmed, images))
        .catch((err) => {
          notify({
            kind: 'operation-error', severity: 'error', title: 'Main AI unavailable',
            body: String(err instanceof Error ? err.message : err), persistent: true,
            dedupKey: `lane-resolve:${conversations.activeConversationId ?? 'unknown'}`,
          });
        });
    }
  }, [lane, laneSend, notify, conversations.activeConversationId]);

  const handleSendMessage = useCallback((text: string, images?: ImageAttachment[]) => {
    const qsp = quickStartPathRef.current;

    // Quick-start interception: when a path is selected, create task + start session
    if (qsp) {
      setQuickStartPath(null);
      setQuickStartModel(undefined);   // clear the collapsed-bar model mirror
      // Local echo as a collapsible bubble — auto-collapses to "⚡ Quick Start on <cwd>"
      // with a chevron the user can click to see the full pasted prompt. This echo
      // is the single visual confirmation (no Personal AI message is sent anymore —
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

    // Lane engine: the session queue is the send path. A focused task rides as
    // a task-ref tag (renders as a clickable pill in the bubble, and the lane
    // persona reads the id from it) — never a raw bracketed text dump.
    if (laneActive) {
      // Same attr contract as server taskRefTag: escape ONLY `"` — the
      // renderer's decodeRefAttr undoes only &quot;, so escaping & here
      // would double-render as a literal &amp; in the pill.
      const esc = (s: string) => s.replace(/"/g, '&quot;');
      const laneText = focusedTask
        ? `Re: <task-ref id="${esc(focusedTask.id)}" label="${esc(focusedTask.title)}"/>\n${text}`
        : text;
      handleLaneSend(laneText, images);
      if (focusedTask) setFocusedTask(null);
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
      chat.sendMessage(text, taskContext, images);
      // Clear task quote after sending — quote is bound to the message, not persistent
      setFocusedTask(null);
    } else {
      chat.sendMessage(text, undefined, images);
    }
  }, [chat, focusedTask, launchQuickStart, tasks, laneActive, handleLaneSend]);

  const handleCommand = useCallback((cmd: SlashCommand, args?: string) => {
    const ctx: CommandContext = {
      sendMessage: (text: string) => handleSendMessage(text),
      clearMessages: () => handleClearChat(),
      addLocalMessage: (content: string) => chat.addLocalMessage(content),
      navigate: navigateRef?.current ?? (() => {}),
      args,
      agentId: agentConsole.activeAgentId,
      conversationId: conversations.activeConversationId ?? undefined,
    };
    cmd.execute(ctx);
  }, [handleSendMessage, handleClearChat, chat, navigateRef, agentConsole.activeAgentId, conversations.activeConversationId]);

  const chatTitle = focusedTask
    ? `Chat — ${focusedTask.title}`
    : 'Chat';

  // The active conversation's auto title — prefill for "Create task from chat".
  // 'New Conversation' is the placeholder before auto-titling; an empty prefill
  // reads better in the form than that.
  const activeConversationTitle = (() => {
    const meta = conversations.conversations.find((c) => c.id === conversations.activeConversationId);
    const t = meta?.title?.trim() ?? '';
    return t === 'New Conversation' ? '' : t;
  })();

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
          onStartSession={handleStartSessionForTask}
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
          onOpenLauncherForTier={handleOpenLauncherForTier}
        />
        {/* The todo-anchored launcher popover (Session | Task tabs) is GONE — the
            toolbar "+" now grows a draft session column in the sessions strip
            instead of dropping a popover here. The chat-anchored instances of
            both components remain (fix-walnut + the chat "+" pills). */}
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
            hasMessages={laneActive ? !!lane.sessionId : chat.messages.length > 0}
            onClear={handleClearChat}
            onOpenFiles={laneActive && lane.cwd ? handleLaneOpenFiles : undefined}
            onFork={laneActive && lane.sessionId ? handleLaneFork : undefined}
            onPromoteToTask={laneActive && lane.sessionId ? handlePromoteChatToTask : undefined}
            promoteDefaultTitle={activeConversationTitle}
            onCloseChat={() => setChatVisible(false)}
            agentSwitcher={(
              <AgentTabBar
                agents={agentConsole.agents}
                activeAgentId={agentConsole.activeAgentId}
                onSwitchAgent={agentConsole.switchAgent}
                conversations={conversations.conversations}
                activeConversationId={conversations.activeConversationId}
                onSwitchConversation={conversations.switchTo}
                onNewConversation={() => { void conversations.create(); }}
                onNewConversationForAgent={handleNewConversationForAgent}
                onDeleteConversation={(cid) => { void conversations.remove(cid); }}
                onRenameConversation={(cid, title) => { void conversations.rename(cid, title); }}
                onTogglePin={(cid) => { void conversations.togglePin(cid); }}
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
            onStartSession={() => setPathSelectorOpen(true)}
          />

          {laneActive && lane.sessionId ? (
            /* Thin layer: the conversation IS a Claude Code session — render its
               JSONL timeline with the full session component set (tool cards,
               collapse, diffs). Keyed by session id so a conversation switch or
               clear (new lane) remounts cleanly. The composer overlay below is
               shared; .chat-panel supplies the same scroll + bottom padding. */
            <div className="chat-panel chat-lane-history">
              <SessionChatHistory
                key={lane.sessionId}
                sessionId={lane.sessionId}
                sessionCwd={lane.cwd}
                optimisticMessages={laneSend.optimisticMsgs}
                onMessagesDelivered={laneSend.handleMessagesDelivered}
                onBatchCompleted={laneSend.handleBatchCompleted}
                onBatchFailed={laneSend.handleBatchFailed}
                onEditQueued={(queueId, newText) => { if (lane.sessionId) laneSend.handleEditQueued(lane.sessionId, queueId, newText); }}
                onDeleteQueued={(queueId) => { if (lane.sessionId) laneSend.handleDeleteQueued(lane.sessionId, queueId); }}
                onRetryFailed={(queueId) => { if (lane.sessionId) laneSend.retryFailed(queueId, lane.sessionId); }}
                onDismissFailed={laneSend.dismissFailed}
                onAgentQueued={laneSend.addExternalQueued}
                onStreamingChange={setLaneStreaming}
                onTaskClick={handleFocusTaskById}
                onSessionClick={handleSessionClick}
                onFileOpen={handleLaneFileOpen}
              />
              {laneFileView && (
                <FileViewer
                  path={laneFileView.path}
                  line={laneFileView.line}
                  onClose={() => setLaneFileView(null)}
                />
              )}
            </div>
          ) : laneActive ? (
            <div className="chat-panel chat-lane-history">
              {lane.error ? (
                <div className="empty-state">
                  <p style={{ color: 'var(--color-error, #ff3b30)' }}>Main AI session unavailable: {lane.error}</p>
                </div>
              ) : (
                <div className="empty-state">
                  <p>
                    <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2, display: 'inline-block', marginRight: 8, verticalAlign: '-2px' }} />
                    Connecting to the main AI session…
                  </p>
                </div>
              )}
            </div>
          ) : (
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
          )}

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
                    picker and edit ALL launch settings (model / pin / priority) —
                    the picker restores the prior choice via initialMeta. Keeping the
                    collapsed bar chip-only (no inline <select>) fixes the narrow-view
                    overflow and saves a row of controls. */}
                <button
                  className="qsb-model-chip"
                  onClick={() => { setPathSelectorOpen(true); setQuickTaskOpen(false); }}
                  title="Edit launch settings (engine, model, pin, priority)"
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
              open={pathSelectorOpen && !pendingQuestion}
              onClose={() => setPathSelectorOpen(false)}
              onSelect={handlePathSelect}
              // Re-opening to edit an already-confirmed Quick Start keeps the prior
              // footer choices (incl. model) instead of resetting to Auto/defaults,
              // and pre-fills the path so it opens as an "edit this selection" view.
              initialMeta={quickStartPath ? quickStartMetaRef.current ?? undefined : undefined}
              initialPath={quickStartPath ? { cwd: quickStartPath.cwd, host: quickStartPath.host } : undefined}
            />

            <QuickTaskComposer
              open={quickTaskOpen && !pendingQuestion}
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
                setQuickTaskOpen(true);
                setPathSelectorOpen(false);
              }}
              // "+ Session" — the LAST entry point to switch to one verb "New":
              // grow a draft column instead of opening the chat-anchored picker.
              // That picker stays mounted (fix-walnut and the model chip re-open
              // it), so this only changes the route in, not the plumbing.
              // Quick-task still closes: the two pills remain mutually exclusive.
              onSessionClick={() => {
                openDraftColumn();
                setQuickTaskOpen(false);
              }}
              onFixWalnutClick={walnutInstallDir ? handleFixWalnut : undefined}
              // Lane engine: chat.stats reads the OLD chat-history store, which
              // lane turns never touch — its % is a frozen lie (reported: stuck
              // 3% next to the model pill's real 18%). The composer's model pill
              // shows the session's true context %; hide this one.
              stats={laneActive ? null : chat.stats}
            />

            <ChatInput
              onSend={handleSendMessage}
              onCommand={handleCommand}
              onStop={laneActive ? handleLaneStop : chat.stopGeneration}
              onClearQueue={chat.clearQueue}
              disabled={connectionState !== 'connected'}
              isStreaming={laneActive ? laneStreaming : chat.isStreaming}
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
              sessionCommands={quickStartPath ? quickStartCommands : undefined}
              searchSessionCommands={quickStartPath ? searchQuickStartCommands : undefined}
              // Lane engine: same controls row a session composer has — mode
              // pill + model pill (NO btw / notes, deliberately minimal).
              // Provider switching unlocks ONLY while the conversation is empty.
              controlsSlot={laneActive && lane.sessionId
                ? <LaneComposerControls
                    sessionId={lane.sessionId}
                    engine={lane.engine}
                    onProviderSwitch={laneConversationEmpty ? handleLaneProviderSwitch : undefined}
                  />
                : undefined}
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
          const isDraft = isDraftColumnId(sid);
          const draft = isDraft ? draftById.get(sid) : undefined;
          const isPending = isPendingColumnId(sid);
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
              className={`main-page-session-column${slot.locked ? ' is-locked' : ''}${idx === mobileActiveIdx ? ' is-mobile-active' : ''}`}
              style={colStyle}
            >
              {isDraft ? (
                // A `draft:` id resolves to NOTHING server-side, so it must never
                // reach SessionPanel (which would fetch it and render "session not
                // found"). Missing row = the draft was just consumed/closed while
                // the column lingers for a tick → render nothing, not a fallback.
                draft ? (
                  <DraftSessionPanel
                    draft={draft}
                    autoFocus={sid === focusDraftId}
                    onStart={handleDraftStart}
                    onSaveAsTask={handleDraftSaveAsTask}
                    onClose={closeDraftColumn}
                    onPathChange={handleDraftPathChange}
                    onProjectChange={handleDraftProjectChange}
                    onMetaChange={handleDraftMetaChange}
                    // Lets a quick-access chip set folder + project together.
                    projectForDir={projectForDir}
                    // Back-fills the launch pills from what the user types (R9).
                    onAiParse={handleDraftAiParse}
                  />
                ) : null
              ) : isPending && pendingMeta ? (
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
                  onOpenForkDraft={handleOpenForkDraft}
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
