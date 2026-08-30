/**
 * Tier card components and drop zone for Focus / Satellite / Backlog / Wait / custom tiers.
 * Each tier gets a SortableTierCard with a kebab menu (same as regular task items).
 */
import { useState, useRef, useCallback, useEffect, memo, type CSSProperties, type ReactNode } from 'react';
import { useTaskCircle } from '@/hooks/useSessionStatus';
import { taskNeedsAction } from '@/utils/session-status';
import type { Task } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import { useSortable } from '@dnd-kit/sortable';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { groupSortableId } from './tier-group-sentinels';
import { TaskKebabMenu } from './TaskKebabMenu';
import { TaskStartButton } from './TaskStartButton';
import * as ICONS from '../common/Icons';


// The sentinel id scheme (`group:<gid>:<tier>`) and its helpers live in
// tier-group-sentinels.ts, next to the items-building logic that depends on them.
export { groupSortableId } from './tier-group-sentinels';

/**
 * Group header chip (Focus area). The chip represents the WHOLE cluster: grabbing its
 * grip (⣿) drags the entire group as a unit.
 *
 * It's a full `useSortable` unit (not a bare `useDraggable`), and its id is ALWAYS in
 * the tier's SortableContext.items — inserted right before its member run. Both halves
 * matter:
 *
 *  • In items → `verticalListSortingStrategy` displaces the chip along with its own
 *    cards during any drag. While the chip sat outside items it stayed pinned to its
 *    original y while the cards it heads slid away, so the header visibly detached
 *    from its cluster.
 *  • Droppable ENABLED → the chip has a measured rect. dnd-kit only keeps rects for
 *    enabled droppables, and the strategy reads `rects[activeIndex]` to size the slot
 *    it opens. With no rect it fell back to the raw drag node and mis-measured every
 *    gap, which is why dragging a whole group used to open no visible slot at all.
 *    Being a collision target is also correct: dropping on a chip means "land above
 *    this group", and it's the natural target when swapping two groups.
 */
export function GroupChip({ groupId, tier, label, onRename, onDissolve, onHide }: {
  groupId: string;
  tier: FocusTier;
  label: string;
  onRename?: (groupId: string, label: string) => void;
  onDissolve?: (groupId: string) => void;
  onHide?: (groupId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: groupSortableId(groupId, tier),
    data: { type: 'group', groupId, tier },
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // While collapsed-and-dragging the chip stands in for the whole cluster; dim it
    // like a dragged card. (The floating DragOverlay carries the visible payload.)
    opacity: isDragging ? 0.5 : undefined,
    position: 'relative',
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-group-id={groupId}
      className={`task-group-chip${isDragging ? ' task-group-chip-dragging' : ''}`}
      title="Folder — drag the grip to move the whole folder"
    >
      {/* Grip = the whole-folder drag handle. Kept distinct from the label (rename) and
          the ⊘/✕ buttons so those gestures never conflict with the drag. */}
      <span className="task-group-chip-grip" {...attributes} {...listeners} title="Drag to move the whole folder" aria-label="Drag folder">⣿</span>
      <span className="task-group-chip-icon" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" /></svg>
      </span>
      <span
        className="task-group-chip-label"
        onClick={(e) => { e.stopPropagation(); onRename?.(groupId, label); }}
        title="Rename folder"
      >
        {label}
      </span>
      {onHide && (
        <button
          className="task-group-chip-hide"
          onClick={(e) => { e.stopPropagation(); onHide(groupId); }}
          aria-label="Hide this folder from Focus"
          title="Hide from Focus — collapse this folder (unhide from the strip below)"
        >
          ⊘
        </button>
      )}
      {onDissolve && (
        <button
          className="task-group-chip-dissolve"
          onClick={(e) => { e.stopPropagation(); onDissolve(groupId); }}
          aria-label="Delete this folder"
          title="Delete folder — tasks stay, back in the project"
        >
          ✕
        </button>
      )}
    </div>
  );
}

const PHASE_ICON: Record<string, ReactNode> = {
  TODO: ICONS.ICON_PHASE_TODO,
  IN_PROGRESS: ICONS.ICON_PHASE_IN_PROGRESS,
  AGENT_COMPLETE: ICONS.ICON_PHASE_AGENT_COMPLETE,
  COMPLETE: ICONS.ICON_PHASE_COMPLETE,
};

const PHASE_LABEL: Record<string, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'Agent Complete',
  COMPLETE: 'Complete',
};

// ── SortableTierCard — unified draggable card for any tier ──
// Wrapped in React.memo (invariant #4) to prevent re-render cascades during drag.
// Without memo, every RAF tick from bumpDragTick would re-render all cards in all tiers,
// compounding into the React #185 maximum update depth error.

/** Per-tier virtual-group render info — same shape as the main list's GroupRenderInfo. */
export interface TierGroupRenderInfo {
  groupId: string;
  label: string;
  isLead: boolean;
  isLast: boolean;
}

interface SortableTierCardProps {
  task: Task;
  tier: FocusTier;
  isFocused: boolean;
  /** Completion grace period is ending in removal — play the fade+collapse exit. */
  isVanishing?: boolean;
  isSessionOpen?: boolean;
  isDetailOpen?: boolean;
  onClick?: (task: Task) => void;
  onSetTier?: (taskId: string, tier: FocusTier) => void;
  onUnpinTask?: (taskId: string) => void;
  onPinTask?: (taskId: string) => void;
  onSetPriority?: (id: string, priority: string) => void;
  onSetDate?: (id: string, date: string | null) => void;
  onSetStartDate?: (id: string, date: string | null) => void;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onOpenSession?: (sessionId: string) => void;
  /** One-click ▶ — launch a session for this task. SAME handler the list rows get
   *  (MainPage.handleStartSessionForTask), so a pinned card behaves identically:
   *  title-only → a bound draft, described task → a direct launch. */
  onStartSession?: (task: Task) => void;
  onSetPhase?: (id: string, phase: string) => void;
  onUpdateTitle?: (id: string, title: string) => void;
  onDelete?: (id: string) => void;
  /** Move this task to another project ('' = Inbox) — kebab "Project" select. */
  onMoveToProject?: (taskId: string, project: string) => void;
  /** Virtual-group cluster info for this card — drives the rail/rounding on every
   *  member. The header chip itself is now rendered standalone by TodoPanel (see
   *  GroupChip), so the rename/dissolve/hide callbacks live there, not here. */
  groupInfo?: TierGroupRenderInfo;
  /** Multi-select (shared with the main list): in select mode a click toggles
   *  selection instead of opening the card; a leading checkbox + highlight show state. */
  selectMode?: boolean;
  isSelected?: boolean;
  onSelectToggle?: (taskId: string) => void;
  /** Enter select mode with this task pre-picked (kebab "Select…"). */
  onStartSelect?: (taskId: string) => void;
  /** True when a drag is hovering this card and dropping would group the two. */
  isGroupTarget?: boolean;
}

export const SortableTierCard = memo(function SortableTierCard({ task, tier, isFocused, isVanishing, isSessionOpen, isDetailOpen, onClick, onSetTier, onUnpinTask, onPinTask, onSetPriority, onSetDate, onSetStartDate, onExpandDetail, onClearFocus, onOpenSession, onStartSession, onSetPhase, onUpdateTitle, onDelete, onMoveToProject, groupInfo, selectMode, isSelected, onSelectToggle, onStartSelect, isGroupTarget }: SortableTierCardProps) {
  // Live circle: error red / waiting red-pulse / running green-pulse.
  const circleClass = useTaskCircle(task);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    // Disable drag in select mode so a press toggles selection instead of starting a
    // drag (mirrors the main list — drag + multi-select gestures otherwise conflict).
  } = useSortable({ id: task.id, disabled: selectMode });

  // Editable title state
  const [isEditing, setIsEditing] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const isCommittingRef = useRef(false);
  const clickPosRef = useRef<{ x: number; y: number } | null>(null);
  const titleClickedRef = useRef(false);

  // Sync title text when task.title changes externally while not editing
  useEffect(() => {
    if (!isEditing && titleRef.current) {
      if (titleRef.current.textContent !== task.title) {
        titleRef.current.textContent = task.title;
      }
      // Editing auto-scrolls the overflow:hidden span to keep the caret visible;
      // a leftover scrollLeft on a nowrap+ellipsis span paints as a BLANK title.
      titleRef.current.scrollLeft = 0;
    }
  }, [task.title, isEditing]);

  // Focus + cursor placement when entering edit mode
  useEffect(() => {
    if (isEditing && titleRef.current) {
      titleRef.current.focus();
      if (clickPosRef.current) {
        const { x, y } = clickPosRef.current;
        clickPosRef.current = null;
        if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(x, y);
          if (range) {
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            return;
          }
        }
      }
      const range = document.createRange();
      range.selectNodeContents(titleRef.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [isEditing]);

  const commitEdit = useCallback(() => {
    if (!isEditing || isCommittingRef.current) return;
    isCommittingRef.current = true;
    setIsEditing(false);
    const trimmed = (titleRef.current?.textContent ?? '').trim();
    if (trimmed && trimmed !== task.title && onUpdateTitle) {
      onUpdateTitle(task.id, trimmed);
    } else if (titleRef.current) {
      titleRef.current.textContent = task.title;
    }
    isCommittingRef.current = false;
  }, [isEditing, task.title, task.id, onUpdateTitle]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    if (titleRef.current) titleRef.current.textContent = task.title;
  }, [task.title]);

  const handleTitleClick = useCallback((e: React.MouseEvent) => {
    if (!onUpdateTitle) return;
    // Don't stop propagation — let card onClick fire too (opens session)
    clickPosRef.current = { x: e.clientX, y: e.clientY };
    setIsEditing(true);
  }, [onUpdateTitle]);

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  const isDone = task.status === 'done' || task.phase === 'COMPLETE';
  // Two red affordances, two semantics (2026-08-14 regression: the tint had been
  // moved onto `unread`, which clears on OPEN — so a task still sitting at
  // AGENT_COMPLETE went quiet after one glance and nothing flagged it needed
  // action). The tint follows the PHASE (clears only when the human acts); the
  // dot follows the stored marker (clears on open).
  const needsAction = taskNeedsAction(task);
  const unread = !isDone && Boolean(task.unread);
  const cardClass = tier === 'focus' ? 'todo-focus-card' : 'todo-pinned-card';
  // Virtual-group cluster classes — reuse the main list's rail/rounding styling.
  const groupClass = groupInfo
    ? ` task-grouped${groupInfo.isLead ? ' task-group-lead' : ''}${groupInfo.isLast ? ' task-group-last' : ''}`
    : '';

  // NOTE: the group header chip is rendered STANDALONE by TodoPanel's tier loop (keyed
  // `group:<gid>:<tier>`), not here — it must outlive its lead member card so the
  // collapse-on-drag handoff (members → single sentinel) keeps the same drag node.
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-task-id={task.id}
      data-group-id={groupInfo?.groupId}
      className={`${cardClass}${groupClass}${isFocused ? ' todo-pinned-card-active' : ''}${needsAction ? ' todo-pinned-card-needs-action' : ''}${isSessionOpen ? ' todo-pinned-card-session-open' : ''}${isSelected ? ' task-multi-selected' : ''}${isGroupTarget ? ' todo-panel-item-group-target' : ''}${isDone ? ' todo-pinned-card-done' : ''}${isVanishing ? ' todo-card-vanishing' : ''}`}
      onClick={(e) => {
        if (isEditing) return;
        // Select mode: a click anywhere toggles selection (no navigation/edit).
        if (selectMode) { onSelectToggle?.(task.id); return; }
        if ((e.target as HTMLElement).closest('.pinned-phase-picker')) return;
        onClick?.(task);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && !isEditing) { e.preventDefault(); selectMode ? onSelectToggle?.(task.id) : onClick?.(task); } }}
    >
      {/* Select-mode checkbox — leading affordance, same as the main list rows. */}
      {selectMode ? (
        <button
          className={`todo-item-select-checkbox${isSelected ? ' checked' : ''}`}
          onClick={(e) => { e.stopPropagation(); onSelectToggle?.(task.id); }}
          role="checkbox"
          aria-checked={!!isSelected}
          aria-label={isSelected ? 'Deselect task' : 'Select task'}
          title={isSelected ? 'Deselect' : 'Select'}
        >
          {isSelected ? '✓' : ''}
        </button>
      ) : (
        <span className="todo-pinned-drag-handle" {...attributes} {...listeners} title="Drag to reorder">
          &#x2630;
        </span>
      )}
      {/* Unread dot — same affordance as the main list row, so the Focus and
          Satellite strips read the same way as the list. */}
      {unread && (
        <span className="task-unread-dot" role="img" aria-label="Unread — agent output you haven't seen" title="Unread — click to open and mark read" />
      )}
      {/* Phase icon — one click toggles To Do ↔ Complete */}
      <button
        className={`task-phase-icon-btn pinned-phase-picker ${circleClass}`}
        onClick={(e) => {
          e.stopPropagation();
          onSetPhase?.(task.id, isDone ? 'TODO' : 'COMPLETE');
        }}
        aria-label={isDone ? 'Reopen (mark To Do)' : 'Mark complete'}
        title={isDone ? 'Done — click to reopen' : 'Click to complete'}
      >
        {ICONS.binaryPhaseIcon(isDone)}
      </button>
      {/* Editable title */}
      <span
        ref={titleRef}
        className={`todo-pinned-title${isEditing ? ' editing' : ''}${task.walnut_agent ? ' walnut-task-title' : ''}`}
        contentEditable={isEditing}
        suppressContentEditableWarning
        title={task.title}
        onClick={isEditing ? (e) => e.stopPropagation() : handleTitleClick}
        onBlur={isEditing ? commitEdit : undefined}
        onKeyDown={isEditing ? (e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        } : undefined}
      >
        {task.title}
      </span>
      {/* ▶ — hover-revealed, immediately before the kebab, exactly as on the list
          rows. Hidden in select mode: a press there means "toggle selection", so a
          launch button would be a mis-click trap. */}
      {!selectMode && (
        <TaskStartButton task={task} isDone={isDone} onStartSession={onStartSession} />
      )}
      <TaskKebabMenu
        task={task}
        isFocused={isFocused}
        isDetailOpen={isDetailOpen}
        isPinned={true}
        pinnedTier={tier}
        isDone={task.status === 'done'}
        onExpandDetail={onExpandDetail}
        onClearFocus={onClearFocus}
        onSetPriority={onSetPriority}
        onSetDate={onSetDate}
        onSetStartDate={onSetStartDate}
        onPinTask={onPinTask}
        onUnpinTask={onUnpinTask}
        onSetTier={onSetTier}
        onOpenSession={onOpenSession}
        onStartSelect={onStartSelect}
        onMoveToProject={onMoveToProject}
        onDelete={onDelete}
      />
    </div>
  );
});

// ── TierDropZone — droppable target for any tier section ──

export function TierDropZone({ id, isEmpty, children }: { id: string; isEmpty: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  // isOver lights the zone only when it is itself the closest drop target — i.e. the
  // cursor is over empty space in the tier, not over a card (closestCenter picks the
  // card in that case). Groups now drag exactly like a task (the collapsed sentinel
  // opens a real empty slot), so the old always-on group-drag tint is gone.
  return (
    <div
      ref={setNodeRef}
      // `id` is dnd-kit's droppable id (not a DOM id) — mirror it onto an attribute
      // so tests and DOM debugging can tell one tier's zone from another's.
      data-drop-zone={id}
      className={`todo-pinned-list todo-focus-drop-zone${isEmpty ? ' todo-focus-drop-zone-empty' : ''}${isOver ? ' todo-focus-drop-zone-over' : ''}`}
    >
      {children}
      {isEmpty && (
        <div className="todo-focus-placeholder">Drag tasks here</div>
      )}
    </div>
  );
}
