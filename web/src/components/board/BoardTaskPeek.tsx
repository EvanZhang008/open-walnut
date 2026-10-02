/**
 * A task opened beside a session panel's chat: a chip clicked on its Board, or a
 * task clicked in the chat while the panel is full screen. It takes the chat
 * column below the column's tab bar (PeekTabBar.tsx, usePeekTabs.ts), in place of
 * the panel's own chat, one tab per task.
 *
 * "Own" is the session panel's task, not the board's: a worker's Board tab shows
 * its leader's board, and there the leader's chip opens the leader here while the
 * worker's own chip goes back to the worker's chat.
 *
 * The own chat is not unmounted. SessionPanel keeps it laid out under this
 * overlay (visibility only, `.is-board-peek` in task-board.css), so the Chat tab
 * returns it with the same scroll, the same draft and the same live stream. The
 * board on the left is a sibling column and never re-renders its frame for this.
 * Only the active tab's task is mounted; another tab mounts when it is chosen.
 *
 * The header says, before anything else, that this is ANOTHER task and that a
 * message typed here goes to it, not to the chat it came from. The task's session is the
 * real SessionPanel in its `inset` mode, rendered by the host (`renderSession`)
 * so this module does not import SessionPanel back. A task with no session, or
 * one the task store does not have, gets a card whose "Open task" is the old
 * jump to the task on Home.
 */
import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStoreTask, useTasksContextSafe } from '@/contexts/TasksContext';
import { hasActiveModalOverlay } from '@/hooks/useModalOverlay';
import { keyTargetClaimsEscape } from '@/hooks/usePanelKeyRouter';
import { escapeWasConsumedByOthers } from '@/utils/escape-beep-guard';
import { log } from '@/utils/log';
import { locateTaskOnHome } from '@/utils/open-session';
import { resolveTaskSessionId } from '@/utils/session-status';
import { boardPeekExcerpt, boardPeekView, boardPhaseLabel } from './board-peek-model';
import '@/styles/task-board.css';

export interface BoardTaskPeekProps {
  /** The session panel's task (see the header). */
  ownTaskId: string;
  targetTaskId: string;
  /** Escape: back to the own chat (the tab stays open). */
  onEscape: () => void;
  /** The old jump to the task on Home (its own column). Absent off Home: the task is located there. */
  onJump?: (taskId: string) => void;
  /** The target's session as a real chat. `jump` is the same jump the card's button does. */
  renderSession: (sessionId: string, jump: (taskId: string) => void) => ReactNode;
}

/** An open menu, palette or picker owns Esc before the peek does. */
function escapeHasAnotherOwner(e: ReactKeyboardEvent, root: HTMLElement | null): boolean {
  const native = e.nativeEvent;
  if (native.isComposing || native.keyCode === 229) return true;
  if (escapeWasConsumedByOthers(native) || hasActiveModalOverlay() || keyTargetClaimsEscape()) return true;
  const target = e.target as HTMLElement;
  if (!root || !root.contains(target)) return true; // a portal of something inside: its own owner
  if (document.querySelector('.task-kebab-menu, [role="menu"], [role="listbox"]')) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return target.value.trim() !== '';
  if (target.isContentEditable) return (target.textContent ?? '').trim() !== '';
  return false;
}

export function BoardTaskPeek({ ownTaskId, targetTaskId, onEscape, onJump, renderSession }: BoardTaskPeekProps) {
  const navigate = useNavigate();
  const store = useTasksContextSafe();
  const task = useStoreTask(targetTaskId);
  const view = boardPeekView(targetTaskId, ownTaskId, task);
  const rootRef = useRef<HTMLDivElement>(null);

  const latest = useRef({ onJump, store });
  latest.current = { onJump, store };
  const jump = useCallback((taskId: string) => {
    const l = latest.current;
    log.info('board', 'task opened from the board peek', { taskId: ownTaskId, targetTaskId: taskId });
    if (l.onJump) { l.onJump(taskId); return; }
    const row = l.store?.tasks.find((t) => t.id === taskId);
    const sid = row ? resolveTaskSessionId(row) : null;
    locateTaskOnHome(taskId, navigate, sid ? { sessionId: sid } : undefined);
  }, [ownTaskId, navigate]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || escapeHasAnotherOwner(e, rootRef.current)) return;
    e.preventDefault();
    e.stopPropagation();
    onEscape();
  };

  const title = task?.title || targetTaskId;
  const phase = boardPhaseLabel(task?.phase);

  return (
    <div
      ref={rootRef}
      className="board-task-peek"
      data-testid="board-task-peek"
      data-task-id={targetTaskId}
      role="region"
      aria-label={`Another task: ${title}`}
      onKeyDown={onKeyDown}
    >
      <div className="board-task-peek-context" data-testid="board-peek-context">
        <div className="board-task-peek-kicker">Another task</div>
        <div className="board-task-peek-heading">
          <span className="board-task-peek-title" title={title} data-testid="board-peek-title">{title}</span>
          {phase && (
            <span className="board-task-peek-phase" data-phase={task?.phase} data-testid="board-peek-phase">{phase}</span>
          )}
        </div>
        {view.kind === 'session' && (
          <p className="board-task-peek-note" data-testid="board-peek-note">
            Messages you send here go to this task, not to the chat you came from.
          </p>
        )}
      </div>
      <div className="board-task-peek-body">
        {view.kind === 'session'
          ? renderSession(view.sessionId, jump)
          : <BoardTaskPeekCard taskId={targetTaskId} known={view.kind === 'card' && view.known} excerpt={boardPeekExcerpt(task)} onOpen={jump} />}
      </div>
    </div>
  );
}

function BoardTaskPeekCard({ taskId, known, excerpt, onOpen }: {
  taskId: string; known: boolean; excerpt: string; onOpen: (taskId: string) => void;
}) {
  return (
    <div className="board-task-peek-card-wrap">
      <div className="board-task-peek-card" data-testid="board-peek-card" data-known={known ? 'true' : 'false'}>
        <div className="board-task-peek-card-title">{known ? 'No session yet' : 'Not in your task list here'}</div>
        {known ? (
          excerpt && <p className="board-task-peek-card-text" data-testid="board-peek-excerpt">{excerpt}</p>
        ) : (
          <p className="board-task-peek-card-text">
            No task on this page has the id <code>{taskId}</code>. It may be deleted or not loaded yet.
          </p>
        )}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onOpen(taskId)}
          data-testid="board-peek-open-task"
        >Open task</button>
      </div>
    </div>
  );
}
