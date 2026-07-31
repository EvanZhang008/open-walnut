/**
 * Tier card components and drop zone for Focus / Next / Satellite.
 * Each tier gets a SortableTierCard with a kebab menu (same as regular task items).
 */
import { useState, useRef, useCallback, useEffect, memo, type CSSProperties, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import { useSortable } from '@dnd-kit/sortable';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { TaskKebabMenu } from './TaskKebabMenu';
import { PersonIcon } from '../common/PersonIcon';
import * as ICONS from '../common/Icons';

/** Sortable id for a group's chip in a tier — encodes the tier so a group split
 *  across tiers renders distinct chips without an id collision. Kept in sync with
 *  the parser in TodoPanel (`group:<gid>:<tier>`). */
export function groupSortableId(groupId: string, tier: FocusTier): string {
  return `group:${groupId}:${tier}`;
}

/**
 * Group header chip (Focus area). The chip represents the WHOLE cluster: grabbing its
 * grip (⣿) drags the entire group as a unit.
 *
 * It's a `useSortable` unit (not a bare `useDraggable`) so that DURING its own drag —
 * when TodoPanel collapses the group's member ids in the tier's SortableContext.items
 * down to this chip's single id — `verticalListSortingStrategy` gives it a real
 * activeIndex and pushes the sibling cards away, opening an empty slot exactly like a
 * regular task drag. At rest the chip's id is NOT in items (index -1, inert), which is
 * harmless: it just renders as a static header above its lead member. Droppable is
 * disabled so the chip never becomes a collision target for single-card drags.
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
    disabled: { droppable: true, draggable: false },
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
      className={`task-group-chip${isDragging ? ' task-group-chip-dragging' : ''}`}
      title="Grouped tasks — drag the grip to move the whole group"
    >
      {/* Grip = the whole-group drag handle. Kept distinct from the label (rename) and
          the ⊘/✕ buttons so those gestures never conflict with the drag. */}
      <span className="task-group-chip-grip" {...attributes} {...listeners} title="Drag to move the whole group" aria-label="Drag group">⣿</span>
      <span className="task-group-chip-icon" aria-hidden="true">⑂</span>
      <span
        className="task-group-chip-label"
        onClick={(e) => { e.stopPropagation(); onRename?.(groupId, label); }}
        title="Rename group"
      >
        {label}
      </span>
      {onHide && (
        <button
          className="task-group-chip-hide"
          onClick={(e) => { e.stopPropagation(); onHide(groupId); }}
          aria-label="Hide this group from Focus"
          title="Hide from Focus — collapse this group (unhide from the strip below)"
        >
          ⊘
        </button>
      )}
      {onDissolve && (
        <button
          className="task-group-chip-dissolve"
          onClick={(e) => { e.stopPropagation(); onDissolve(groupId); }}
          aria-label="Ungroup these tasks"
          title="Ungroup — dissolve this group"
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
  AWAIT_HUMAN_ACTION: <PersonIcon />,
  HUMAN_VERIFIED: ICONS.ICON_PHASE_HUMAN_VERIFIED,
  POST_WORK_COMPLETED: ICONS.ICON_PHASE_POST_WORK,
  COMPLETE: ICONS.ICON_PHASE_COMPLETE,
};

const PHASE_LABEL: Record<string, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'Agent Complete',
  AWAIT_HUMAN_ACTION: 'Await Human Action',
  HUMAN_VERIFIED: 'Human Verified',
  POST_WORK_COMPLETED: 'Post-Work Done',
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
  onStar?: (id: string) => void;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onOpenSession?: (sessionId: string) => void;
  onSetPhase?: (id: string, phase: string) => void;
  onUpdateTitle?: (id: string, title: string) => void;
  onDelete?: (id: string) => void;
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

export const SortableTierCard = memo(function SortableTierCard({ task, tier, isFocused, isVanishing, isSessionOpen, isDetailOpen, onClick, onSetTier, onUnpinTask, onPinTask, onSetPriority, onSetDate, onSetStartDate, onStar, onExpandDetail, onClearFocus, onOpenSession, onSetPhase, onUpdateTitle, onDelete, groupInfo, selectMode, isSelected, onSelectToggle, onStartSelect, isGroupTarget }: SortableTierCardProps) {
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
    if (!isEditing && titleRef.current && titleRef.current.textContent !== task.title) {
      titleRef.current.textContent = task.title;
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

  const needsAttention = task.phase === 'AGENT_COMPLETE' || task.phase === 'AWAIT_HUMAN_ACTION';
  const isDone = task.status === 'done' || task.phase === 'COMPLETE';
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
      className={`${cardClass}${groupClass}${isFocused ? ' todo-pinned-card-active' : ''}${needsAttention ? ' todo-pinned-card-attention' : ''}${isSessionOpen ? ' todo-pinned-card-session-open' : ''}${isSelected ? ' task-multi-selected' : ''}${isGroupTarget ? ' todo-panel-item-group-target' : ''}${isDone ? ' todo-pinned-card-done' : ''}${isVanishing ? ' todo-card-vanishing' : ''}`}
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
      {/* Phase icon — one click toggles To Do ↔ Complete */}
      <button
        className={`task-phase-icon-btn pinned-phase-picker task-status-${task.status} task-phase-${task.phase?.toLowerCase()}`}
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
        className={`todo-pinned-title${isEditing ? ' editing' : ''}`}
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
        onStar={onStar}
        onPinTask={onPinTask}
        onUnpinTask={onUnpinTask}
        onSetTier={onSetTier}
        onOpenSession={onOpenSession}
        onStartSelect={onStartSelect}
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
