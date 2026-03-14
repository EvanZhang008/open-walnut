import { useState, useCallback, useEffect, useRef, memo, useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import { resolveTaskSessionId } from '@/utils/session-status';
import { SessionChatHistory } from '@/components/sessions/SessionChatHistory';
import { ChatInput } from '@/components/chat/ChatInput';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useFullscreen } from '@/hooks/useFullscreen';
import type { ImageAttachment } from '@/api/chat';
import type { UseFocusBarReturn } from '@/hooks/useFocusBar';

// ── Custom events for Dock ↔ MainPage communication ──

function emitDockActivateTask(taskId: string, sessionId?: string) {
  window.dispatchEvent(new CustomEvent('dock:activate-task', {
    detail: { taskId, sessionId },
  }));
}

function emitDockActivateChat() {
  window.dispatchEvent(new CustomEvent('dock:activate-chat'));
}

// ── Human-readable status labels ──

const PHASE_LABELS: Record<string, string> = {
  TODO: 'To Do', IN_PROGRESS: 'In Progress', BLOCKED: 'Blocked',
  AGENT_COMPLETE: 'Agent Complete', AWAIT_HUMAN: 'Await Human',
  COMPLETE: 'Complete',
};

// ── Dock height constants ──

const DOCK_HEIGHT_KEY = 'open-walnut-dock-height';
const DOCK_HEIGHT_DEFAULT = 200;
const DOCK_HEIGHT_MIN = 120;
const DOCK_HEIGHT_MAX = 500;

function readDockHeight(): number {
  try {
    const stored = localStorage.getItem(DOCK_HEIGHT_KEY);
    if (stored) {
      const v = parseInt(stored, 10);
      if (!isNaN(v)) return Math.min(DOCK_HEIGHT_MAX, Math.max(DOCK_HEIGHT_MIN, v));
    }
  } catch { /* ignore */ }
  return DOCK_HEIGHT_DEFAULT;
}

// ── DockTaskCard ──

interface DockTaskCardProps {
  task: Task;
  isActive: boolean;
  onActivate: (taskId: string, sessionId?: string) => void;
  onUnpin: (taskId: string) => void;
}

const DockTaskCard = memo(function DockTaskCard({ task, isActive, onActivate, onUnpin }: DockTaskCardProps) {
  const sessionId = resolveTaskSessionId(task);
  const isStreaming = task.session_status?.process_status === 'running';

  // Red highlight for phases that need human attention
  const needsAttention = task.phase === 'AGENT_COMPLETE' || task.phase === 'AWAIT_HUMAN_ACTION';

  const handleClick = useCallback(() => {
    if (isActive) {
      emitDockActivateChat();
    } else {
      onActivate(task.id, sessionId ?? undefined);
    }
  }, [task.id, sessionId, onActivate, isActive]);

  const handleUnpin = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onUnpin(task.id);
  }, [task.id, onUnpin]);

  // Reuse the same send hook as SessionPanel — optimistic messages + delivery tracking
  const { optimisticMsgs, send, handleMessagesDelivered, handleBatchCompleted, clearCommitted } = useSessionSend(sessionId);

  // CSS-promotion fullscreen (same instance, no remount)
  const { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen();

  // Slash command autocomplete (same as SessionPanel)
  const { items: slashCommands, search: searchSlashCommands } = useSlashCommands();

  const handleSend = useCallback((text: string, images?: ImageAttachment[]) => {
    if (!sessionId || !text.trim()) return;
    send(sessionId, text.trim(), images);
  }, [sessionId, send]);

  return (<>
    {FullscreenBackdrop}
    <div
      className={`dock-task-card${isActive ? ' dock-task-active' : ''}${needsAttention ? ' dock-task-attention' : ''}${fullscreenClass}`}
      onClick={(e) => { if (!isFullscreen && (e.target === e.currentTarget || (e.target as HTMLElement).closest('.dock-task-header'))) handleClick(); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); handleClick(); } }}
    >
      <div className="dock-task-header">
        <div className="dock-task-header-top">
          <span className="dock-task-title" title={task.title}>{task.title}</span>
          <span className={`dock-task-phase-badge${needsAttention ? ' dock-task-phase-attention' : ''}${isStreaming ? ' dock-task-phase-streaming' : ''}`}>
            {PHASE_LABELS[task.phase ?? ''] ?? task.phase ?? 'To Do'}
          </span>
          {sessionId && (
            <button
              className="dock-task-expand"
              onClick={(e) => { e.stopPropagation(); isFullscreen ? exitFullscreen() : enterFullscreen(); }}
              title={isFullscreen ? 'Collapse back' : 'Expand session'}
              aria-label={isFullscreen ? 'Collapse session' : 'Expand session to full screen'}
            >
              {isFullscreen ? (
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 4 10 0 10" />
                  <polyline points="12 2 12 6 16 6" />
                  <line x1="0" y1="10" x2="5" y2="5" />
                  <line x1="16" y1="6" x2="11" y2="11" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="10 2 14 2 14 6" />
                  <polyline points="6 14 2 14 2 10" />
                  <line x1="14" y1="2" x2="9" y2="7" />
                  <line x1="2" y1="14" x2="7" y2="9" />
                </svg>
              )}
            </button>
          )}
          <button
            className="dock-task-unpin"
            onClick={handleUnpin}
            title="Unpin from Focus Dock"
            aria-label="Unpin task"
          >
            &times;
          </button>
        </div>
      </div>
      <div className="dock-task-body">
        {sessionId ? (
          <SessionChatHistory
            key={sessionId}
            sessionId={sessionId}
            optimisticMessages={optimisticMsgs}
            onMessagesDelivered={handleMessagesDelivered}
            onBatchCompleted={handleBatchCompleted}
            onClearCommitted={clearCommitted}
          />
        ) : (
          <span className="dock-task-no-session">No active session</span>
        )}
      </div>
      {sessionId && (
        <div className="dock-task-input" onClick={(e) => e.stopPropagation()}>
          <ChatInput
            onSend={handleSend}
            placeholder="Send message... (/ for commands)"
            sessionCommands={slashCommands}
            searchSessionCommands={searchSlashCommands}
          />
        </div>
      )}
    </div>
  </>);
});

// ── ChatDockItem ──

interface ChatDockItemProps {
  isActive: boolean;
}

const ChatDockItem = memo(function ChatDockItem({ isActive }: ChatDockItemProps) {
  return (
    <div
      className={`dock-chat-item${isActive ? ' dock-chat-active' : ''}`}
      onClick={emitDockActivateChat}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emitDockActivateChat(); } }}
      title="Main Chat"
    >
      <span className="dock-chat-icon">&#x1F4AC;</span>
      <span className="dock-chat-label">Chat</span>
      {isActive && <span className="dock-chat-active-dot" />}
    </div>
  );
});

// ── FocusDock (container) ──

interface FocusDockProps {
  focusBar: UseFocusBarReturn;
}

const FOCUS_DOCK_MAX_VISIBLE = 3;

export function FocusDock({ focusBar }: FocusDockProps) {
  const { pinnedTasks: allPinnedTasks, unpin } = focusBar;
  // Sort: attention-needed tasks (AGENT_COMPLETE, AWAIT_HUMAN_ACTION) first,
  // then take the first N visible (UI space limited).
  const pinnedTasks = useMemo(() => {
    const sorted = [...allPinnedTasks].sort((a, b) => {
      const aAttn = a.phase === 'AGENT_COMPLETE' || a.phase === 'AWAIT_HUMAN_ACTION' ? 0 : 1;
      const bAttn = b.phase === 'AGENT_COMPLETE' || b.phase === 'AWAIT_HUMAN_ACTION' ? 0 : 1;
      return aAttn - bAttn;
    });
    return sorted.slice(0, FOCUS_DOCK_MAX_VISIBLE);
  }, [allPinnedTasks]);

  // Self-manage active state by listening to custom events
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // Track main chat panel visibility (toggled via Chat button)
  const [chatVisible, setChatVisible] = useState<boolean>(
    () => sessionStorage.getItem('open-walnut-home-chat-visible') !== 'false'
  );

  useEffect(() => {
    const onTask = (e: Event) => {
      const { taskId } = (e as CustomEvent).detail as { taskId: string };
      setActiveTaskId(taskId);
    };
    const onChat = () => setActiveTaskId(null);
    const onChatVisibility = (e: Event) => {
      const { visible } = (e as CustomEvent).detail as { visible: boolean };
      setChatVisible(visible);
    };
    window.addEventListener('dock:activate-task', onTask);
    window.addEventListener('dock:activate-chat', onChat);
    window.addEventListener('main:chat-visible', onChatVisibility);
    return () => {
      window.removeEventListener('dock:activate-task', onTask);
      window.removeEventListener('dock:activate-chat', onChat);
      window.removeEventListener('main:chat-visible', onChatVisibility);
    };
  }, []);

  // Resizable dock height — all refs for stable drag closure
  const [dockHeight, setDockHeight] = useState(readDockHeight);
  const dockHeightRef = useRef(dockHeight);
  dockHeightRef.current = dockHeight;
  const resizingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = dockHeightRef.current;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = startYRef.current - ev.clientY;
      setDockHeight(Math.min(DOCK_HEIGHT_MAX, Math.max(DOCK_HEIGHT_MIN, startHeightRef.current + delta)));
    };

    const onMouseUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem(DOCK_HEIGHT_KEY, String(dockHeightRef.current)); } catch { /* ignore */ }
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []); // stable — uses only refs

  const hasPinnedTasks = pinnedTasks.length > 0;

  return (
    <div
      className={`focus-dock${hasPinnedTasks ? '' : ' focus-dock-empty'}`}
      style={hasPinnedTasks ? { height: dockHeight } : undefined}
    >
      {hasPinnedTasks && (
        <div className="dock-resize-handle" onMouseDown={handleResizeStart} />
      )}
      <div className="dock-content">
        <ChatDockItem isActive={chatVisible} />
        {hasPinnedTasks && <div className="dock-divider" />}
        {pinnedTasks.map((task) => (
          <DockTaskCard
            key={task.id}
            task={task}
            isActive={activeTaskId === task.id}
            onActivate={emitDockActivateTask}
            onUnpin={unpin}
          />
        ))}
      </div>
    </div>
  );
}
