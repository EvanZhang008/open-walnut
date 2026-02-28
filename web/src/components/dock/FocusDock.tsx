import { useCallback, memo } from 'react';
import type { Task } from '@walnut/core';
import { useSessionStream, type StreamingBlock } from '@/hooks/useSessionStream';
import { compositeColor } from '@/utils/session-status';
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

// ── DockTaskCard ──

interface DockTaskCardProps {
  task: Task;
  isActive: boolean;
  onActivate: (taskId: string, sessionId?: string) => void;
  onUnpin: (taskId: string) => void;
}

const DockTaskCard = memo(function DockTaskCard({ task, isActive, onActivate, onUnpin }: DockTaskCardProps) {
  const sessionId = task.session_id || null;
  const { blocks, isStreaming } = useSessionStream(sessionId);

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

  // Extract preview text: last text block, last ~4 lines
  const previewText = getPreviewText(blocks);

  const truncatedTitle = task.title.length > 22 ? task.title.slice(0, 20) + '\u2026' : task.title;

  return (
    <div
      className={`dock-task-card${isActive ? ' dock-task-active' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') handleClick(); }}
    >
      <div className="dock-task-header">
        <span className="dock-task-status-dot" style={{ background: statusColor }} />
        {isStreaming && <span className="dock-task-streaming-dot" />}
        <span className="dock-task-title" title={task.title}>{truncatedTitle}</span>
        <button
          className="dock-task-unpin"
          onClick={handleUnpin}
          title="Unpin from Focus Dock"
          aria-label="Unpin task"
        >
          &times;
        </button>
      </div>
      <div className="dock-task-preview">
        {previewText ? (
          <pre className="dock-task-preview-text">{previewText}</pre>
        ) : (
          <span className="dock-task-no-session">No active session</span>
        )}
      </div>
    </div>
  );
});

/** Extract the last ~4 lines from the last text block for preview. */
function getPreviewText(blocks: StreamingBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'text' && b.content.trim()) {
      const lines = b.content.trimEnd().split('\n');
      return lines.slice(-4).join('\n');
    }
  }
  return null;
}

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
      onKeyDown={(e) => { if (e.key === 'Enter') emitDockActivateChat(); }}
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
  activeDockTaskId?: string | null;
  isChatActive?: boolean;
}

export function FocusDock({ focusBar, activeDockTaskId, isChatActive = true }: FocusDockProps) {
  const { pinnedTasks, unpin } = focusBar;

  const handleActivate = useCallback((taskId: string, sessionId?: string) => {
    emitDockActivateTask(taskId, sessionId);
  }, []);

  const handleUnpin = useCallback((taskId: string) => {
    unpin(taskId);
  }, [unpin]);

  const hasPinnedTasks = pinnedTasks.length > 0;

  return (
    <div className={`focus-dock${hasPinnedTasks ? '' : ' focus-dock-empty'}`}>
      <ChatDockItem isActive={!!isChatActive && !activeDockTaskId} />
      {hasPinnedTasks && <div className="dock-divider" />}
      {pinnedTasks.map((task) => (
        <DockTaskCard
          key={task.id}
          task={task}
          isActive={activeDockTaskId === task.id}
          onActivate={handleActivate}
          onUnpin={handleUnpin}
        />
      ))}
    </div>
  );
}
