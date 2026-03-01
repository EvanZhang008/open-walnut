import { useState, useCallback, useEffect, useRef, memo } from 'react';
import type { Task } from '@walnut/core';
import { compositeColor } from '@/utils/session-status';
import { SessionChatHistory } from '@/components/sessions/SessionChatHistory';
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

// ── Dock height constants ──

const DOCK_HEIGHT_KEY = 'walnut-dock-height';
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
  const sessionId = task.session_id ?? null;
  const isStreaming = task.session_status?.process_status === 'running';

  const statusColor = task.session_status
    ? compositeColor(task.session_status.process_status ?? 'stopped', task.session_status.work_status ?? 'completed')
    : 'var(--fg-muted)';

  const handleClick = useCallback(() => {
    onActivate(task.id, sessionId ?? undefined);
  }, [task.id, sessionId, onActivate]);

  const handleUnpin = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onUnpin(task.id);
  }, [task.id, onUnpin]);

  return (
    <div
      className={`dock-task-card${isActive ? ' dock-task-active' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
    >
      <div className="dock-task-header">
        <span className="dock-task-status-dot" style={{ background: statusColor }} />
        {isStreaming && <span className="dock-task-streaming-dot" />}
        <span className="dock-task-title" title={task.title}>{task.title}</span>
        <button
          className="dock-task-unpin"
          onClick={handleUnpin}
          title="Unpin from Focus Dock"
          aria-label="Unpin task"
        >
          &times;
        </button>
      </div>
      <div className="dock-task-body">
        {sessionId ? (
          <SessionChatHistory sessionId={sessionId} />
        ) : (
          <span className="dock-task-no-session">No active session</span>
        )}
      </div>
    </div>
  );
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

export function FocusDock({ focusBar }: FocusDockProps) {
  const { pinnedTasks, unpin } = focusBar;

  // Self-manage active state by listening to custom events
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  useEffect(() => {
    const onTask = (e: Event) => {
      const { taskId } = (e as CustomEvent).detail as { taskId: string };
      setActiveTaskId(taskId);
    };
    const onChat = () => setActiveTaskId(null);
    window.addEventListener('dock:activate-task', onTask);
    window.addEventListener('dock:activate-chat', onChat);
    return () => {
      window.removeEventListener('dock:activate-task', onTask);
      window.removeEventListener('dock:activate-chat', onChat);
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
        <ChatDockItem isActive={!activeTaskId} />
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
