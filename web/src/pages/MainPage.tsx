import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Task } from '@walnut/core';
import { useChat, type TaskContext, type ImageAttachment } from '@/hooks/useChat';
import type { ChatStats } from '@/api/chat';
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
import { TaskContextBar } from '@/components/tasks/TaskContextBar';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import { SessionPathSelector, type QuickStartPath } from '@/components/sessions/SessionPathSelector';
import { QuestionPopover, parseAskQuestionInput } from '@/components/chat/QuestionPopover';
import { TriagePanel } from '@/components/triage/TriagePanel';
import { fetchSession, quickStartSession } from '@/api/sessions';
import { ContextInspectorPanel } from '@/components/context/ContextInspectorPanel';
import { useContextInspector } from '@/hooks/useContextInspector';
import { shouldHideUiOnlyMessage } from '@/hooks/useDeveloperSettings';
import { useUiOnlySettings } from '@/hooks/useDeveloperSettings';
import { FocusDock } from '@/components/dock/FocusDock';
import type { SlashCommand } from '@/commands/types';
import type { CommandContext } from '@/commands/types';

// ── Compact chat header with dropdown menu ──

const CONTEXT_WINDOW_DEFAULT = 200_000; // fallback when backend doesn't provide contextWindow

function ChatHeaderRow({ title, stats, connectionState, inspectorOpen, onToggleInspector, hasMessages, onClear }: {
  title: string;
  stats: ChatStats | null;
  connectionState: string;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  hasMessages: boolean;
  onClear: () => void;
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

  const contextWindow = stats?.contextWindow ?? CONTEXT_WINDOW_DEFAULT;
  const pct = stats ? Math.round((stats.estimatedTotalTokens ?? stats.estimatedTokens) / contextWindow * 100) : null;
  const pctColor = pct != null && pct > 80 ? 'var(--error)' : pct != null && pct > 50 ? 'var(--warning)' : 'var(--fg-muted)';

  return (
    <div className="chat-header-row">
      <div className="chat-header-meta">
        <span className="chat-header-title">{title}</span>
        {pct != null && (
          <span className="chat-header-pct" style={{ color: pctColor }} title={`${stats!.apiMessageCount} msgs · ~${Math.round((stats!.estimatedTotalTokens ?? stats!.estimatedTokens) / 1000)}K tokens${stats!.compacted ? ' · compacted' : ''}`}>
            {pct}%
          </span>
        )}
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

const PRIORITY_CYCLE: Record<string, 'immediate' | 'important' | 'backlog' | 'none'> = { none: 'backlog', backlog: 'important', important: 'immediate', immediate: 'none', high: 'none', low: 'important', medium: 'important' };

const SS_TASK_KEY = 'walnut-home-focused-task';
const SS_SESSION_COLUMNS_KEY = 'walnut-home-session-columns';
const SS_TODO_SCROLL_KEY = 'walnut-home-todo-scroll';
const SS_CHAT_VISIBLE_KEY = 'walnut-home-chat-visible';

// Legacy key for migration
const SS_SESSION_KEY_LEGACY = 'walnut-home-session-panel';

// ── Session column queue helpers (max 2, or max 1 if triage open) ──

const MAX_COLUMNS = 2;
const SESSION_WIDTH_BY_COUNT = [0, 40, 65]; // 1=40%, 2=65% (max width)

function addSessionColumn(cols: string[], id: string, triageOpen: boolean): string[] {
  const max = triageOpen ? MAX_COLUMNS - 1 : MAX_COLUMNS;
  // Deduplicate: remove existing, then push to rightmost
  const filtered = cols.filter(c => c !== id);
  const next = [...filtered, id];
  // Evict leftmost if over max
  return next.length > max ? next.slice(next.length - max) : next;
}

function removeSessionColumn(cols: string[], id: string): string[] {
  return cols.filter(c => c !== id);
}

function replaceSessionColumn(cols: string[], oldId: string, newId: string): string[] {
  const idx = cols.indexOf(oldId);
  if (idx === -1) return cols;
  const next = [...cols];
  next[idx] = newId;
  return next;
}

/** Load session columns from sessionStorage, with migration from legacy single-session key */
function loadSessionColumns(): string[] {
  const saved = sessionStorage.getItem(SS_SESSION_COLUMNS_KEY);
  if (saved) {
    try { return JSON.parse(saved); } catch { /* fall through */ }
  }
  // Migrate from legacy single-session key
  const legacy = sessionStorage.getItem(SS_SESSION_KEY_LEGACY);
  if (legacy) {
    sessionStorage.removeItem(SS_SESSION_KEY_LEGACY);
    return [legacy];
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
  const chat = useChat();
  const { connectionState } = useWebSocket();
  const { tasks, loading, toggleComplete, setPhase, star, create, update, reorder, moveTask, reparentTask, operationError, clearOperationError, showOperationError } = useTasksContext();
  const favorites = useFavorites();
  const focusBar = useFocusBarContext();
  const pinnedTaskIdSet = useMemo(() => new Set(focusBar.pinnedIds), [focusBar.pinnedIds]);
  const ordering = useOrdering();
  const [focusedTask, setFocusedTask] = useState<Task | null>(null);
  const inspector = useContextInspector();
  // Force re-render when UI Only settings change (hook subscribes to localStorage)
  useUiOnlySettings();

  // Chat panel visibility — toggle via Focus Dock "Chat" button
  const [chatVisible, setChatVisible] = useState<boolean>(
    () => sessionStorage.getItem(SS_CHAT_VISIBLE_KEY) !== 'false'
  );

  // Session columns state — up to 2 sessions displayed side by side
  const [sessionColumns, setSessionColumns] = useState<string[]>(loadSessionColumns);

  // Triage panel state — shares the first column slot with sessions
  const [triagePanelOpen, setTriagePanelOpen] = useState(false);
  const triageOpenRef = useRef(triagePanelOpen);
  triageOpenRef.current = triagePanelOpen;
  // Task ID for filtered triage panel (null = show all)
  const [triageTaskId, setTriageTaskId] = useState<string | null>(null);

  // Session quick-start state (opened via /session command)
  const [pathSelectorOpen, setPathSelectorOpen] = useState(false);
  const [quickStartPath, setQuickStartPath] = useState<QuickStartPath | null>(null);

  // Set of session IDs currently open in columns — for active pill indicators
  const openSessionIdSet = useMemo(() => new Set(sessionColumns), [sessionColumns]);

  // Detect pending ask_question tool call from chat messages
  const pendingQuestion = useMemo(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const msg = chat.messages[i]
      if (msg.role !== 'assistant' || !msg.blocks) continue
      for (const block of msg.blocks) {
        if (block.type === 'tool_call' && block.name === 'ask_question' && block.status === 'calling') {
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
  const todoPanel = useResizablePanel('walnut-todo-width', 25);
  const sessionPanel = useResizablePanel('walnut-session-panel-width-v2', 35);

  // Graduated session area width — only auto-set when column count increases
  // (don't override user's manual drag on decrease or same count)
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

  // Restore focusedTask from sessionStorage once tasks have loaded
  const restoredTaskRef = useRef(false);
  useEffect(() => {
    if (loading || restoredTaskRef.current) return;
    restoredTaskRef.current = true;
    const savedTaskId = sessionStorage.getItem(SS_TASK_KEY);
    if (savedTaskId && !focusedTask) {
      const task = tasks.find((t) => t.id === savedTaskId);
      if (task) setFocusedTask(task);
    }
  }, [loading, tasks, focusedTask]);

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
      if (restored.length > 0) setSessionColumns(restored);
    }
  }, [visible, tasks, focusedTask, sessionColumns]);

  // Persist focusedTask.id to sessionStorage
  // Guard: don't clear until restore has run, otherwise the initial null state
  // wipes the saved value before it can be read back.
  useEffect(() => {
    if (focusedTask?.id) sessionStorage.setItem(SS_TASK_KEY, focusedTask.id);
    else if (restoredTaskRef.current) sessionStorage.removeItem(SS_TASK_KEY);
  }, [focusedTask?.id]);

  useEffect(() => {
    if (sessionColumns.length > 0) sessionStorage.setItem(SS_SESSION_COLUMNS_KEY, JSON.stringify(sessionColumns));
    else sessionStorage.removeItem(SS_SESSION_COLUMNS_KEY);
  }, [sessionColumns]);

  // Persist chatVisible + broadcast to FocusDock
  useEffect(() => {
    sessionStorage.setItem(SS_CHAT_VISIBLE_KEY, String(chatVisible));
    window.dispatchEvent(new CustomEvent('main:chat-visible', { detail: { visible: chatVisible } }));
  }, [chatVisible]);

  // ── Listen for FocusDock events ──
  useEffect(() => {
    const handleDockTask = (e: Event) => {
      const { taskId, sessionId } = (e as CustomEvent).detail as { taskId: string; sessionId?: string };
      const task = taskMapRef.current.get(taskId);
      if (task) setFocusedTask(task);
      if (sessionId) setSessionColumns(prev => addSessionColumn(prev, sessionId, triageOpenRef.current));
    };
    const handleDockChat = () => {
      // Toggle main chat panel visibility
      setChatVisible(prev => !prev);
    };
    const handleSessionLauncher = () => setPathSelectorOpen(true);
    window.addEventListener('dock:activate-task', handleDockTask);
    window.addEventListener('dock:activate-chat', handleDockChat);
    window.addEventListener('session-launcher:open', handleSessionLauncher);
    return () => {
      window.removeEventListener('dock:activate-task', handleDockTask);
      window.removeEventListener('dock:activate-chat', handleDockChat);
      window.removeEventListener('session-launcher:open', handleSessionLauncher);
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

  // ── Session column handlers ──
  // Clicking a session pill always opens/moves to rightmost — use close button to dismiss
  const handleToggleSession = useCallback((sessionId: string) => {
    setSessionColumns(prev => addSessionColumn(prev, sessionId, triageOpenRef.current));
  }, []);

  // Per-column close handler factory
  const handleCloseSession = useCallback((sessionId: string) => {
    setSessionColumns(prev => removeSessionColumn(prev, sessionId));
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
        prev.includes(d.fromPlanSessionId!)
          ? replaceSessionColumn(prev, d.fromPlanSessionId!, d.sessionId!)
          : prev
      );
    }
  });

  // ── Triage panel handlers ──
  const handleOpenTriageForTask = useCallback((taskId: string) => {
    setTriagePanelOpen(true);
    setTriageTaskId(taskId);
    // Trim sessions to max-1 if triage is opening
    setSessionColumns(prev => prev.length > MAX_COLUMNS - 1 ? prev.slice(prev.length - (MAX_COLUMNS - 1)) : prev);
  }, []);

  const handleCloseTriage = useCallback(() => {
    setTriagePanelOpen(false);
    setTriageTaskId(null);
  }, []);

  // Quick-start: track pending taskId, auto-open session panel when it starts
  const pendingQuickStartRef = useRef<string | null>(null);

  // Path selector → select handler
  const handlePathSelect = useCallback((path: QuickStartPath) => {
    setQuickStartPath(path);
    setPathSelectorOpen(false);
  }, []);

  // Auto-open session panel when a quick-start session fires
  // Listen to both session:started and session:status-changed to catch the sessionId
  const openQuickStartSession = useCallback((data: Record<string, unknown>) => {
    const sessionId = (data.claudeSessionId ?? data.sessionId) as string | undefined;
    const taskId = data.taskId as string | undefined;
    if (pendingQuickStartRef.current && taskId === pendingQuickStartRef.current && sessionId) {
      pendingQuickStartRef.current = null;
      setSessionColumns(prev => addSessionColumn(prev, sessionId, triageOpenRef.current));
    }
  }, []);
  useEvent('session:started', openQuickStartSession);
  useEvent('session:status-changed', openQuickStartSession);

  // Handle session click from chat: focus the associated task + open session column
  const handleSessionClick = useCallback(async (sessionId: string) => {
    // Add session column
    setSessionColumns(prev => addSessionColumn(prev, sessionId, triageOpenRef.current));
    // Fetch session to find its associated task
    try {
      const session = await fetchSession(sessionId);
      if (session?.taskId) {
        const task = taskMapRef.current.get(session.taskId);
        if (task) setFocusedTask(task);
      }
    } catch { /* non-critical */ }
  }, []);

  const handleCreate = useCallback(async (input: { title: string; priority: string }) => {
    await create({
      title: input.title,
      priority: input.priority as 'high' | 'low' | 'none',
    });
  }, [create]);

  const handleFocusTask = useCallback((task: Task) => {
    const isUnfocusing = focusedTask?.id === task.id;
    setFocusedTask(isUnfocusing ? null : task);
    // Clear attention flag on focus (not on unfocus) — fire-and-forget
    if (!isUnfocusing && task.needs_attention) {
      update(task.id, { needs_attention: false });
    }
  }, [focusedTask, update]);

  const handleFocusTaskById = useCallback((taskId: string) => {
    const task = taskMapRef.current.get(taskId);
    if (task) handleFocusTask(task);
  }, [handleFocusTask]);

  const handleClearFocus = useCallback(() => {
    setFocusedTask(null);
  }, []);

  const handleComplete = useCallback((id: string) => {
    const task = taskMapRef.current.get(id);
    if (task && task.status !== 'done' && focusedTask?.id === id) setFocusedTask(null);
    toggleComplete(id);
  }, [toggleComplete, focusedTask]);

  const handleSetPhase = useCallback((id: string, phase: string) => {
    if (phase === 'COMPLETE' && focusedTask?.id === id) setFocusedTask(null);
    setPhase(id, phase);
  }, [setPhase, focusedTask]);

  const handleStar = useCallback((id: string) => {
    star(id);
  }, [star]);

  const handleCyclePriority = useCallback((id: string) => {
    const current = taskMapRef.current.get(id);
    if (!current) return;
    update(id, { priority: (PRIORITY_CYCLE[current.priority] ?? 'none') });
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
      // Show the user's message as a local chat entry immediately
      chat.addLocalMessage(`Quick Start on \`${qsp.cwd}\`${qsp.host ? ` (${qsp.hostLabel ?? qsp.host})` : ''}:\n> ${text}`);

      // Set pending ref BEFORE the async call so WS events that arrive
      // during the HTTP round-trip can still match via taskId
      const tempTaskId = `pending-${Date.now()}`;
      pendingQuickStartRef.current = tempTaskId;

      quickStartSession({
        cwd: qsp.cwd,
        host: qsp.host ?? undefined,
        message: text,
        category: qsp.category,
      }).then((result) => {
        // Update ref with real taskId (WS events use this to match)
        if (pendingQuickStartRef.current === tempTaskId) {
          pendingQuickStartRef.current = result.taskId;
        }
        // Notify main agent to reorganize the task
        const agentMsg = [
          `[Quick Start] Session created and running.`,
          `- Task ID: ${result.taskId}`,
          `- Path: ${qsp.cwd}`,
          `- Category: ${qsp.category} / Quick Start`,
          ``,
          `Please update the task:`,
          `1. Set a descriptive title (replace "Session: ...")`,
          `2. Move from "Quick Start" to the correct project if needed`,
        ].join('\n');
        chat.sendMessage(agentMsg);
      }).catch((err) => {
        setQuickStartPath(qsp); // Restore so user can retry
        chat.addLocalMessage(`Quick Start failed: ${err instanceof Error ? err.message : String(err)}`);
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
      chat.sendMessage(text, taskContext, images);
      // Clear task quote after sending — quote is bound to the message, not persistent
      setFocusedTask(null);
    } else {
      chat.sendMessage(text, undefined, images);
    }
  }, [chat, focusedTask]);

  const handleCommand = useCallback((cmd: SlashCommand, args?: string) => {
    const ctx: CommandContext = {
      sendMessage: (text: string) => handleSendMessage(text),
      clearMessages: () => chat.clearMessages(),
      addLocalMessage: (content: string) => chat.addLocalMessage(content),
      navigate: navigateRef?.current ?? (() => {}),
      args,
    };
    cmd.execute(ctx);
  }, [handleSendMessage, chat, navigateRef]);

  const chatTitle = focusedTask
    ? `Chat — ${focusedTask.title}`
    : 'Chat';
  const chatSubtitle = focusedTask
    ? `Chatting about task in ${focusedTask.category}${focusedTask.project && focusedTask.project !== focusedTask.category ? ` / ${focusedTask.project}` : ''}`
    : 'Chat with Walnut';

  return (
    <div className="main-page" style={{ position: 'relative' }}>

      {/* Left column: Chat + Sessions + FocusDock (sidebar excluded) */}
      <div className="main-page-left">
      <div className="main-page-content-row">

      {/* Chat Panel (left, flex) — collapsible via Focus Dock toggle */}
      <div className={`main-page-chat${chatVisible ? '' : ' collapsed'}`}>
        <div className="chat-page">
          <ChatHeaderRow
            title={chatTitle}
            stats={chat.stats}
            connectionState={connectionState}
            inspectorOpen={inspector.isOpen}
            onToggleInspector={inspector.toggle}
            hasMessages={chat.messages.length > 0}
            onClear={chat.clearMessages}
          />

          {inspector.isOpen && (
            <ContextInspectorPanel
              data={inspector.data}
              loading={inspector.loading}
              error={inspector.error}
              onRefresh={inspector.refresh}
            />
          )}

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
              <div className="text-sm" style={{ color: 'var(--error)', padding: '8px 12px' }}>Error: {chat.error}</div>
            )}
          </ChatPanel>

          {/* Quick Start Bar — context pill when path is selected */}
          {quickStartPath && (
            <div className="quick-start-bar">
              <span className="qsb-label">Quick Start</span>
              <span className="qsb-path" title={quickStartPath.cwd}>{quickStartPath.cwd}</span>
              {quickStartPath.host && <span className="qsb-host">{quickStartPath.hostLabel ?? quickStartPath.host}</span>}
              <button className="qsb-close" onClick={() => setQuickStartPath(null)} aria-label="Cancel quick start">&times;</button>
            </div>
          )}

          {focusedTask && (
            <TaskContextBar
              task={focusedTask}
              onComplete={handleComplete}
              onStar={handleStar}
              onClear={handleClearFocus}
            />
          )}

          <div style={{ position: 'relative' }}>
            {/* Session path selector popover (above the input) */}
            <SessionPathSelector
              open={pathSelectorOpen && !pendingQuestion}
              onClose={() => setPathSelectorOpen(false)}
              onSelect={handlePathSelect}
            />

            {/* Ask Question popover (above the input, mutually exclusive with path selector) */}
            <QuestionPopover
              open={!!pendingQuestion}
              questions={pendingQuestion ?? []}
              onClose={() => {/* closed automatically when tool result arrives */}}
            />

            <ChatInput
              onSend={handleSendMessage}
              onCommand={handleCommand}
              onStop={chat.stopGeneration}
              onClearQueue={chat.clearQueue}
              disabled={connectionState !== 'connected'}
              isStreaming={chat.isStreaming}
              focusedTaskTitle={quickStartPath ? `Session on ${quickStartPath.cwd.split('/').pop()}` : focusedTask?.title}
              queueCount={chat.queueCount}
            />
          </div>
        </div>
      </div>

      {/* Sessions Area Resize Handle */}
      {(sessionColumns.length > 0 || triagePanelOpen) && (
        <div className="session-resize-handle" onMouseDown={sessionPanel.handleResizeStart} />
      )}

      {/* Sessions Area — triage (first slot) + up to 2 session columns */}
      <div
        ref={sessionPanel.panelRef}
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
        {sessionColumns.map((sid, idx) => {
          const needsDivider = idx > 0 || triagePanelOpen;
          return (
            <div className="main-page-session-column" key={sid} style={needsDivider ? { borderLeft: '1px solid var(--border)' } : undefined}>
              <SessionPanel
                sessionId={sid}
                onClose={() => handleCloseSession(sid)}
                onTaskClick={handleFocusTaskById}
                onSessionClick={handleSessionClick}
                onSessionReplaced={(newId) => handleSessionReplaced(sid, newId)}
              />
            </div>
          );
        })}
      </div>

      </div>{/* end .main-page-content-row */}

      {/* FocusDock — inside left column, below chat+sessions */}
      <FocusDock focusBar={focusBar} />

      </div>{/* end .main-page-left */}

      {/* Todo Resize Handle */}
      <div className="todo-resize-handle" onMouseDown={todoPanel.handleResizeStart} />

      {/* Todo Panel (right) */}
      <div
        ref={todoPanel.panelRef}
        className="main-page-todo"
        style={{ width: todoPanel.width }}
      >
        <TodoPanel
          tasks={tasks}
          loading={loading}
          onComplete={handleComplete}
          onSetPhase={handleSetPhase}
          onCreate={handleCreate}
          onUpdate={handleUpdate}
          onStar={handleStar}
          onCyclePriority={handleCyclePriority}
          onFocusTask={handleFocusTask}
          onClearFocus={handleClearFocus}
          focusedTaskId={focusedTask?.id}
          favorites={favorites}
          ordering={ordering}
          onReorder={reorder}
          onMoveTask={moveTask}
          onReparentTask={reparentTask}
          onOpenSession={handleToggleSession}
          openSessionIds={openSessionIdSet}
          onOpenTriageForTask={handleOpenTriageForTask}
          onPinTask={focusBar.pin}
          onUnpinTask={focusBar.unpin}
          onReorderPinned={focusBar.reorder}
          pinnedTaskIds={pinnedTaskIdSet}
          operationError={operationError}
          onClearOperationError={clearOperationError}
          onOperationError={showOperationError}
        />
      </div>

    </div>
  );
}
