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
import { useTasksContext } from '@/contexts/TasksContext';
import { ICON_CHAT } from '@/components/common/Icons';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { useDragGesture } from '@/hooks/useDragGesture';

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
// Cap the dock at 70% of the viewport so it scales with screen size instead of a
// flat pixel ceiling (was 500px — too small on tall displays). Recomputed on each
// read/drag so it tracks window resizes; floored at DOCK_HEIGHT_MIN for safety
// (e.g. tiny windows) and guarded for non-browser/SSR contexts.
function dockHeightMax(): number {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
  return Math.max(DOCK_HEIGHT_MIN, Math.round(vh * 0.7));
}

function readDockHeight(): number {
  try {
    const stored = localStorage.getItem(DOCK_HEIGHT_KEY);
    if (stored) {
      const v = parseInt(stored, 10);
      if (!isNaN(v)) return Math.min(dockHeightMax(), Math.max(DOCK_HEIGHT_MIN, v));
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
  const storedStatus = useSessionStatus(sessionId);
  const effectiveStatus = storedStatus ?? task.session_status;
  const isStreaming = effectiveStatus?.process_status === 'running';

  // Scroll the card into view when it becomes active (e.g. just added to Focus),
  // so the user sees where the task landed even if the dock scrolls horizontally.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isActive) cardRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  }, [isActive]);

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
  const { optimisticMsgs, send, handleMessagesDelivered, handleBatchCompleted } = useSessionSend(sessionId);

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
      ref={cardRef}
      className={`dock-task-card${isActive ? ' dock-task-active' : ''}${needsAttention ? ' dock-task-attention' : ''}${fullscreenClass}`}
      data-task-id={task.id}
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
            engine={effectiveStatus?.engine}
            optimisticMessages={optimisticMsgs}
            onMessagesDelivered={handleMessagesDelivered}
            onBatchCompleted={handleBatchCompleted}
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
            draftKey={`draft:session:${sessionId}`}
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
      <span className="dock-chat-icon">{ICON_CHAT}</span>
      <span className="dock-chat-label">Chat</span>
      {isActive && <span className="dock-chat-active-dot" />}
    </div>
  );
});

// ── DockQuickAdd — inline "+" to add a task straight into the Focus tier ──

interface DockQuickAddProps {
  onAdd: (title: string) => Promise<void>;
}

const DockQuickAdd = memo(function DockQuickAdd({ onAdd }: DockQuickAddProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const submit = useCallback(async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await onAdd(t);
      setTitle('');
      setOpen(false);
    } catch {
      // onAdd rethrows after reporting the failure (useTasks.create → onOpError →
      // toast). Swallow it here so the keydown handler's un-awaited submit() call
      // doesn't surface as an [unhandledrejection]; the form stays open with the
      // title intact so the user can retry.
    } finally {
      setBusy(false);
    }
  }, [title, busy, onAdd]);

  if (!open) {
    return (
      <button
        className="dock-quick-add-btn"
        onClick={() => setOpen(true)}
        title="Add a task to Focus"
        aria-label="Add a task to Focus"
      >
        +
      </button>
    );
  }

  return (
    <div className="dock-quick-add-form">
      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add to Focus…"
        aria-label="New focus task title"
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          if (e.key === 'Escape') { setTitle(''); setOpen(false); }
        }}
        onBlur={() => { if (!title.trim()) setOpen(false); }}
      />
    </div>
  );
});

// ── FocusDock (container) ──

interface FocusDockProps {
  focusBar: UseFocusBarReturn;
  onQuickAddToFocus?: (title: string) => Promise<void>;
}

const FOCUS_DOCK_MAX_VISIBLE = 3;

export function FocusDock({ focusBar, onQuickAddToFocus }: FocusDockProps) {
  const { unpin, focusIds, pinnedIds } = focusBar;
  // Resolve tasks from TasksContext directly (FocusBarContext no longer triggers
  // on task data changes — only on ID changes — to prevent double-trigger cascade).
  const { tasks } = useTasksContext();
  const taskMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  // Show Focus tier tasks (max 3) in the dock — semantically correct: dock = current focus.
  // Falls back to first 3 pinned if no focus tasks set (backward compat).
  const pinnedTasks = useMemo(() => {
    const ids = focusIds.length > 0 ? focusIds : pinnedIds;
    return ids
      .slice(0, FOCUS_DOCK_MAX_VISIBLE)
      .map((id) => taskMap.get(id))
      .filter((t): t is Task => !!t);
  }, [focusIds, pinnedIds, taskMap]);

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
  const startHeightRef = useRef(dockHeight);

  // Re-clamp to the 70%-of-viewport cap when the window shrinks, so a height saved
  // on a large window doesn't overflow a smaller one. (Persisted value is untouched —
  // only the live height is clamped, so it restores if the window grows back.)
  useEffect(() => {
    const onResize = () => {
      const max = dockHeightMax();
      if (dockHeightRef.current > max) setDockHeight(max);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const { onPointerDown: resizePointerDown } = useDragGesture({
    cursor: 'row-resize',
    onStart: () => { startHeightRef.current = dockHeightRef.current; },
    // Dock grows upward, so an upward drag (negative dy) increases the height.
    // Cap at 70% of the viewport (dockHeightMax) rather than a fixed pixel max.
    onMove: ({ dy }) => {
      setDockHeight(Math.min(dockHeightMax(), Math.max(DOCK_HEIGHT_MIN, startHeightRef.current - dy)));
    },
    onEnd: () => {
      try { localStorage.setItem(DOCK_HEIGHT_KEY, String(dockHeightRef.current)); } catch { /* ignore */ }
    },
  });

  const hasPinnedTasks = pinnedTasks.length > 0;

  return (
    <div
      className={`focus-dock${hasPinnedTasks ? '' : ' focus-dock-empty'}`}
      style={hasPinnedTasks ? { height: dockHeight } : undefined}
    >
      {hasPinnedTasks && (
        <div className="dock-resize-handle" onPointerDown={resizePointerDown} />
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
        {onQuickAddToFocus && <DockQuickAdd onAdd={onQuickAddToFocus} />}
      </div>
    </div>
  );
}
