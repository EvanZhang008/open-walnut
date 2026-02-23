import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Task } from '@walnut/core';
import { useChat, type TaskContext, type ImageAttachment } from '@/hooks/useChat';
import { useWebSocket, useEvent } from '@/hooks/useWebSocket';
import { useTasks } from '@/hooks/useTasks';
import { useFavorites } from '@/hooks/useFavorites';
import { useOrdering } from '@/hooks/useOrdering';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { ChatMessage, type RouteInfo } from '@/components/chat/ChatMessage';
import { ChatInput } from '@/components/chat/ChatInput';
import { TodoPanel } from '@/components/tasks/TodoPanel';
import { TaskContextBar } from '@/components/tasks/TaskContextBar';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import { TriagePanel } from '@/components/triage/TriagePanel';
import { fetchSession } from '@/api/sessions';
import { ContextInspectorPanel } from '@/components/context/ContextInspectorPanel';
import { useContextInspector } from '@/hooks/useContextInspector';
import type { SlashCommand } from '@/commands/types';
import type { CommandContext } from '@/commands/types';

const PRIORITY_CYCLE: Record<string, 'immediate' | 'important' | 'backlog' | 'none'> = { none: 'backlog', backlog: 'important', important: 'immediate', immediate: 'none', high: 'none', low: 'important', medium: 'important' };

const SS_TASK_KEY = 'walnut-home-focused-task';
const SS_SESSION_KEY = 'walnut-home-session-panel';
const SS_TODO_SCROLL_KEY = 'walnut-home-todo-scroll';

interface MainPageProps {
  /** Whether MainPage is currently visible (route is /) */
  visible?: boolean;
  /** Stable ref to navigate function — avoids useNavigate() context dependency */
  navigateRef?: React.RefObject<NavigateFunction>;
}

export function MainPage({ visible = true, navigateRef }: MainPageProps) {
  const chat = useChat();
  const { connectionState } = useWebSocket();
  const { tasks, loading, toggleComplete, setPhase, star, create, update, reorder, moveTask, operationError, clearOperationError, showOperationError } = useTasks();
  const favorites = useFavorites();
  const ordering = useOrdering();
  const [focusedTask, setFocusedTask] = useState<Task | null>(null);
  const inspector = useContextInspector();

  // Session panel state — restore from sessionStorage
  const [sessionPanelId, setSessionPanelId] = useState<string | null>(
    () => sessionStorage.getItem(SS_SESSION_KEY)
  );

  // Triage panel state — shares the middle slot with session panel
  const [triagePanelOpen, setTriagePanelOpen] = useState(false);
  // Task ID for filtered triage panel (null = show all)
  const [triageTaskId, setTriageTaskId] = useState<string | null>(null);

  // Task lookup map for resolving task IDs to names in tool call UI
  const taskMap = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  // Ref for taskMap — allows callbacks to read the latest without re-creating
  const taskMapRef = useRef(taskMap);
  taskMapRef.current = taskMap;

  // Resizable panels
  const todoPanel = useResizablePanel('walnut-todo-width', 25);
  const sessionPanel = useResizablePanel('walnut-session-panel-width-v2', 35);

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
    if (!sessionPanelId) {
      const savedSession = sessionStorage.getItem(SS_SESSION_KEY);
      if (savedSession) setSessionPanelId(savedSession);
    }
  }, [visible, tasks, focusedTask, sessionPanelId]);

  // Persist focusedTask.id and sessionPanelId to sessionStorage
  // Guard: don't clear until restore has run, otherwise the initial null state
  // wipes the saved value before it can be read back.
  useEffect(() => {
    if (focusedTask?.id) sessionStorage.setItem(SS_TASK_KEY, focusedTask.id);
    else if (restoredTaskRef.current) sessionStorage.removeItem(SS_TASK_KEY);
  }, [focusedTask?.id]);

  useEffect(() => {
    if (sessionPanelId) sessionStorage.setItem(SS_SESSION_KEY, sessionPanelId);
    else sessionStorage.removeItem(SS_SESSION_KEY);
  }, [sessionPanelId]);

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

  // ── Session panel handlers ──
  const handleToggleSession = useCallback((sessionId: string) => {
    setSessionPanelId((prev) => prev === sessionId ? null : sessionId);
    setTriagePanelOpen(false); // Close triage when opening session
  }, []);

  const handleSessionReplaced = useCallback((newSessionId: string) => {
    setSessionPanelId(newSessionId);
  }, []);

  // Auto-switch session panel when "Clear Context & Execute" creates a new exec session
  useEvent('session:status-changed', (data: unknown) => {
    const d = data as { sessionId?: string; fromPlanSessionId?: string };
    if (d.fromPlanSessionId && d.sessionId && d.fromPlanSessionId === sessionPanelId) {
      setSessionPanelId(d.sessionId);
    }
  });

  const handleCloseSession = useCallback(() => {
    setSessionPanelId(null);
  }, []);

  // ── Triage panel handlers ──
  const handleToggleTriage = useCallback(() => {
    setTriagePanelOpen((prev) => {
      if (!prev) {
        setSessionPanelId(null); // Close session when opening triage
        setTriageTaskId(null); // Show all when toggling from header button
      }
      return !prev;
    });
  }, []);

  const handleOpenTriageForTask = useCallback((taskId: string) => {
    setTriagePanelOpen(true);
    setTriageTaskId(taskId);
    setSessionPanelId(null); // Close session when opening triage
  }, []);

  const handleCloseTriage = useCallback(() => {
    setTriagePanelOpen(false);
    setTriageTaskId(null);
  }, []);

  // Handle session click from chat: focus the associated task + open session panel
  const handleSessionClick = useCallback(async (sessionId: string) => {
    // Open the session panel
    setSessionPanelId(sessionId);
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
    // Clear attention flag on focus (not on unfocus)
    if (!isUnfocusing && task.needs_attention) {
      update(task.id, { needs_attention: false }).catch(() => { /* best-effort */ });
    }
  }, [focusedTask, update]);

  const handleFocusTaskById = useCallback((taskId: string) => {
    const task = taskMapRef.current.get(taskId);
    if (task) handleFocusTask(task);
  }, [handleFocusTask]);

  const handleClearFocus = useCallback(() => {
    setFocusedTask(null);
  }, []);

  const handleComplete = useCallback(async (id: string) => {
    try {
      const updated = await toggleComplete(id);
      if (updated.status === 'done' && focusedTask?.id === id) setFocusedTask(null);
    } catch (err) {
      showOperationError(err instanceof Error ? err.message : 'Failed to toggle completion');
    }
  }, [toggleComplete, focusedTask, showOperationError]);

  const handleSetPhase = useCallback(async (id: string, phase: string) => {
    try {
      const updated = await setPhase(id, phase);
      if (updated.status === 'done' && focusedTask?.id === id) setFocusedTask(null);
      if (focusedTask?.id === id && updated.status !== 'done') setFocusedTask(updated);
    } catch (err) {
      showOperationError(err instanceof Error ? err.message : 'Failed to set phase');
    }
  }, [setPhase, focusedTask, showOperationError]);

  const handleStar = useCallback(async (id: string) => {
    const updated = await star(id);
    if (focusedTask?.id === id) setFocusedTask(updated);
  }, [star, focusedTask]);

  const handleCyclePriority = useCallback(async (id: string) => {
    const current = tasks.find((t) => t.id === id);
    if (!current) return;
    const next = PRIORITY_CYCLE[current.priority] ?? 'none';
    const updated = await update(id, { priority: next });
    if (focusedTask?.id === id) setFocusedTask(updated);
  }, [tasks, update, focusedTask]);

  const handleUpdate = useCallback(async (id: string, updates: { title?: string }) => {
    const updated = await update(id, updates);
    if (focusedTask?.id === id) setFocusedTask(updated);
  }, [update, focusedTask]);

  const handleSendMessage = useCallback((text: string, images?: ImageAttachment[]) => {
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

      {/* Chat Panel (left, flex) */}
      <div className="main-page-chat">
        <div className="chat-page">
          <div className="page-header flex justify-between items-center">
            <div>
              <h1 className="page-title">{chatTitle}</h1>
              <p className="page-subtitle">
                {chatSubtitle}
                {chat.stats && (
                  <span className="chat-stats-badge" style={{ marginLeft: 8 }}>
                    {chat.stats.apiMessageCount} msgs · ~{Math.round((chat.stats.estimatedTotalTokens ?? chat.stats.estimatedTokens) / 1000)}K tokens
                    {chat.stats.compacted && ' · compacted'}
                  </span>
                )}
                {connectionState !== 'connected' && (
                  <span className="text-xs" style={{ color: 'var(--warning)', marginLeft: 8 }}>
                    ({connectionState})
                  </span>
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                className={`btn btn-sm${inspector.isOpen ? ' btn-primary' : ''}`}
                onClick={inspector.toggle}
                aria-label="Toggle context inspector"
              >
                Context
              </button>
              {chat.messages.length > 0 && (
                <button className="btn btn-sm" onClick={chat.clearMessages}>Clear</button>
              )}
            </div>
          </div>

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
            {chat.messages.map((msg) => (
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

          {focusedTask && (
            <TaskContextBar
              task={focusedTask}
              onComplete={handleComplete}
              onStar={handleStar}
              onClear={handleClearFocus}
            />
          )}

          <ChatInput
            onSend={handleSendMessage}
            onCommand={handleCommand}
            onStop={chat.stopGeneration}
            onClearQueue={chat.clearQueue}
            disabled={connectionState !== 'connected'}
            isStreaming={chat.isStreaming}
            focusedTaskTitle={focusedTask?.title}
            queueCount={chat.queueCount}
          />
        </div>
      </div>

      {/* Middle Panel Resize Handle (session or triage) */}
      {(sessionPanelId || triagePanelOpen) && (
        <div className="session-resize-handle" onMouseDown={sessionPanel.handleResizeStart} />
      )}

      {/* Middle Panel — session OR triage (between chat and todo) */}
      <div
        ref={sessionPanel.panelRef}
        className={`main-page-session${!sessionPanelId && !triagePanelOpen ? ' collapsed' : ''}`}
        style={sessionPanelId || triagePanelOpen ? { width: sessionPanel.width } : undefined}
      >
        {sessionPanelId && (
          <SessionPanel
            sessionId={sessionPanelId}
            onClose={handleCloseSession}
            onTaskClick={handleFocusTaskById}
            onSessionClick={handleSessionClick}
            onSessionReplaced={handleSessionReplaced}
          />
        )}
        {!sessionPanelId && triagePanelOpen && (
          <TriagePanel
            onClose={handleCloseTriage}
            taskId={triageTaskId ?? undefined}
            onTaskClick={handleFocusTaskById}
            onSessionClick={handleSessionClick}
          />
        )}
      </div>

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
          onOpenSession={handleToggleSession}
          onToggleTriage={handleToggleTriage}
          onOpenTriageForTask={handleOpenTriageForTask}
          triagePanelOpen={triagePanelOpen}
          operationError={operationError}
          onClearOperationError={clearOperationError}
          onOperationError={showOperationError}
        />
      </div>
    </div>
  );
}
