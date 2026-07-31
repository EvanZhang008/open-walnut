import { useState, useMemo, useCallback, useEffect, useRef, memo, Fragment, type FormEvent, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task as CoreTask, SessionRecord } from '@open-walnut/core';
import { renderNoteMarkdown } from '@/utils/markdown';
import { fetchSessionsForTask } from '@/api/sessions';
import { fetchTask, updateTask as apiUpdateTask, type BatchTaskOutcome } from '@/api/tasks';
import { SprintPicker } from '@/components/tasks/SprintPicker';
import { fetchTriageHistory } from '@/api/chat';
import { useEvent } from '@/hooks/useWebSocket';
import { useConfirm, usePrompt } from '@/hooks/useConfirm';
import { useNotifications } from '@/contexts/notifications';
import { timeAgo } from '@/utils/time';
import { scrollLog } from '@/utils/scroll-debug';
import type { ProcessStatus } from '@open-walnut/core';
import type { TaskPhase } from '@/types/session';
import { PHASE_LABELS, PHASE_COLORS, PROCESS_COLORS, resolveTaskSessionId, phasePickerChoices, matchesPhaseFilter } from '@/utils/session-status';
import type { UseFavoritesReturn } from '@/hooks/useFavorites';
import type { UseOrderingReturn } from '@/hooks/useOrdering';
import * as ICONS from '../common/Icons';
import type { TaskPriority } from '@open-walnut/core';
import { TodoSearchBar } from './TodoSearchBar';
import { NewLauncherButton } from './NewLauncherButton';
import {
  mapServerTaskSearchResults,
  taskReferenceMatchField,
} from './search-results';
import { useTaskSearch } from '@/hooks/useTaskSearch';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCenter,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type CollisionDetection,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  defaultAnimateLayoutChanges,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskKebabMenu } from './TaskKebabMenu';
import { TaskBatchMenu } from './TaskBatchMenu';
import { ViewDropdown, type SortBy, type GroupBy, type DateFilter } from './ViewDropdown';
import { DatePicker, formatDateDisplay, formatDateTimeDisplay, isOverdue, parseDateLocal } from '../common/DatePicker';
import { PersonIcon } from '../common/PersonIcon';
import { useVerticalSplitter } from '@/hooks/useVerticalSplitter';
import { useResizableHeight } from '@/hooks/useResizableHeight';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';
import { ProjectDetailPane } from './ProjectDetailPane';
import { CategoryDetailPane } from './CategoryDetailPane';
import { GlobalNotesSection } from '../notes/GlobalNotesSection';
import { useGlobalNotes } from '@/hooks/useGlobalNotes';
import { SortableTierCard, TierDropZone, GroupChip, groupSortableId } from './FocusSatelliteCards';
import { TodoSectionTabs, TODO_SECTIONS, type TodoSection } from './TodoSectionTabs';
import type { FocusTier } from '@/api/focus';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import {
  resolveSessionRecordStatus,
  sessionStatusStore,
} from '@/stores/session-status-store';

type Task = CoreTask & {
  has_description?: boolean;
  has_summary?: boolean;
  has_ext?: boolean;
  has_note?: boolean;
  is_blocked?: boolean;
};

const DATE_LABELS: Record<string, string> = { now: 'Now', overdue: 'Overdue', 'this-week': 'This Week', 'no-date': 'No Date' } as const;

type DetailTarget =
  | { type: 'project'; category: string; project: string }
  | { type: 'category'; category: string }
  | null;

interface TodoPanelProps {
  tasks: Task[];
  loading: boolean;
  onComplete: (id: string) => void;
  onSetPhase?: (id: string, phase: string) => void;
  onCreate: (input: { title: string; priority: string; category?: string; project?: string; starred?: boolean; pinnedTier?: FocusTier; capture?: boolean }) => Promise<Task | unknown>;
  onUpdate?: (id: string, updates: { title?: string }) => void;
  onStar?: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Multi-select batch ops — ONE round-trip for the whole selection (a fan-out over
   *  onSetPhase/onDelete would rewrite the store N times and flicker the list row by
   *  row). Resolve with the per-task failures so the bar can warn. */
  onBatchSetPhase?: (ids: string[], phase: string) => Promise<BatchTaskOutcome[]>;
  onBatchDelete?: (ids: string[], opts?: { force?: boolean }) => Promise<BatchTaskOutcome[]>;
  onSetPriority?: (id: string, priority: string) => void;
  onFocusTask?: (task: Task, opts?: { openDetail?: boolean }) => void;
  onClearFocus?: () => void;
  focusedTaskId?: string;
  /** Increments on every focus action — forces re-scroll even for same task */
  focusNonce?: number;
  /** Locate scope for the current focus action. 'pinned' (tier quick-adds) scrolls
   *  the Pinned region only — no TASKS tab switch, no category/project expansion.
   *  'all' (default) = full locate incl. tab switch. */
  focusScope?: 'all' | 'pinned';
  favorites?: UseFavoritesReturn;
  ordering?: UseOrderingReturn;
  onReorder?: (category: string, project: string, taskIds: string[]) => void;
  onMoveTask?: (taskId: string, category: string, project: string, insertNearTaskId?: string) => void;
  onReparentTask?: (taskId: string, newParentId: string | null, opts?: { insertAfterId?: string }) => void;
  /** Called when switching to manual sort — baker freezes current displayed order into the store. */
  onBakeOrder?: (orderedIds: string[]) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenTriageForTask?: (taskId: string) => void;
  onPinTask?: (taskId: string) => void;
  onUnpinTask?: (taskId: string) => void;
  onReorderPinned?: (newIds: string[]) => void;
  onSetTier?: (taskId: string, tier: FocusTier, newPinnedOrder?: string[]) => void;
  onSetDate?: (taskId: string, date: string | null) => void;
  onSetStartDate?: (taskId: string, date: string | null) => void;
  pinnedTaskIds?: Set<string>;
  focusTaskIds?: Set<string>;
  waitTaskIds?: Set<string>;
  /** When true, suppress opening the detail panel for the focused task (e.g. chat task-ref clicks). */
  suppressDetail?: boolean;
  /** Set of session IDs currently displayed in session columns. */
  openSessionIds?: Set<string>;
  /** Set of task IDs whose session is open on the home page — highlights their cards. */
  openSessionTaskIds?: Set<string>;
  // operationError VALUE is surfaced globally via the unified notification toaster
  // (AppShell), so TodoPanel only needs the callbacks to report/clear, not the value.
  onClearOperationError?: () => void;
  onOperationError?: (msg: string) => void;
  /** Externally-set category (e.g. from URL deep link). When it changes from undefined to a value, the tab switches. */
  externalCategory?: string;
  /** Fires whenever the active category tab changes (for URL sync). */
  onCategoryChange?: (cat: string) => void;
  /** Toolbar "+" — opens the todo-anchored launcher popover (Session | Task
   *  tabs, Session default) rendered by MainPage inside the task panel. */
  onOpenLauncher?: () => void;
  /** Virtual-group name registry: group_id → label. */
  taskGroups?: Record<string, string>;
  /** Group ids hidden from the Focus (pinned) area — their cards are skipped there. */
  hiddenGroups?: Set<string>;
  /** Create a virtual group from ≥2 task ids (label AI-generated if omitted). */
  onGroupTasks?: (taskIds: string[], label?: string) => void;
  /** Add task(s) to an existing group — used when dragging a task onto a grouped one. */
  onAddToGroup?: (groupId: string, taskIds: string[]) => void;
  /** Remove a single task from its virtual group. */
  onUngroupTask?: (taskId: string) => void;
  /** Remove several tasks from their group(s) in one call (used to dissolve a whole cluster). */
  onUngroupTasks?: (taskIds: string[]) => void;
  /** Rename a virtual group. */
  onRenameGroup?: (groupId: string, label: string) => void;
  /** Show/hide a group in the Focus (pinned) area (membership untouched). */
  onSetGroupHidden?: (groupId: string, hidden: boolean) => void;
}

const STARRED_TAB = '\u2605';

/**
 * Freeze a derived value while `frozen` is true: returns the last value computed
 * while NOT frozen. Invariant #5 of the pinned-drag stability contract (see the
 * drag-freeze comment above handlePinnedDragStart): during a pinned drag the
 * DndContext subtree's render model must be immune to EXTERNAL store churn
 * (task:updated WS echoes, refetches, last_session_update touches) \u2014 otherwise
 * cards remount/re-sort mid-drag, dnd-kit's useRect sees a new element identity
 * every commit, and its layout-effect setState loops into React #185. The
 * previous invariants (8ac5bb7) froze only the tier ORDER refs; every new
 * derived layer added downstream (visibleTaskIds filter, recentTasks sort)
 * silently escaped the freeze \u2014 this hook freezes at the model level instead.
 */
function useFrozenWhile<T>(value: T, frozen: boolean): T {
  const ref = useRef(value);
  if (!frozen) ref.current = value;
  return ref.current;
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

const PHASE_ORDER: string[] = [
  'TODO', 'IN_PROGRESS', 'AGENT_COMPLETE', 'AWAIT_HUMAN_ACTION',
  'HUMAN_VERIFIED', 'POST_WORK_COMPLETED', 'COMPLETE',
];

const PRIORITY_ICON: Record<string, string> = {
  immediate: '!!',
  important: '!',
  backlog: '~',
  none: '--',
};

const PRIORITY_LABEL: Record<string, string> = {
  immediate: 'Immediate',
  important: 'Important',
  backlog: 'Backlog',
  none: 'None',
};

const CHEVRON_ICON = '\u25B6'; // ▶ — used by all collapse-chevron buttons (CSS rotation handles expanded state)

// Action icons: imported from shared Icons.tsx via ICONS.*

/** Normalize legacy priority values to current 4-tier system. */
function effectivePriority(p: string): string {
  if (p === 'high') return 'immediate';
  if (p === 'medium') return 'important';
  if (p === 'low') return 'backlog';
  return p;
}

// ── LocalStorage persistence helpers ──

const LS_TAB_KEY = 'walnut-todo-active-tab';
const LS_COLLAPSED_SECTIONS_KEY = 'walnut-todo-collapsed-sections';
const LS_COLLAPSED_CATS_KEY = 'walnut-todo-collapsed-cats';
const LS_COLLAPSED_PROJS_KEY = 'walnut-todo-collapsed-projs';
const LS_EXPANDED_PARENTS_KEY = 'walnut-todo-expanded-parents';
// LS_FILTERS_COLLAPSED_KEY removed — filters now inside ViewDropdown
const LS_SORT_KEY = 'walnut-todo-sortBy';
const LS_GROUP_KEY = 'walnut-todo-groupBy';
const LS_DATE_FILTER_KEY = 'walnut-todo-dateFilter';
const LS_SECTION_KEY = 'walnut-todo-active-section';

function readSetFromStorage(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch { /* ignore */ }
  return new Set();
}

function persistSet(key: string, set: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
}

function readTab(): string {
  try { return localStorage.getItem(LS_TAB_KEY) ?? STARRED_TAB; } catch { return STARRED_TAB; }
}

function persistTab(tab: string) {
  try { localStorage.setItem(LS_TAB_KEY, tab); } catch { /* ignore */ }
}

/** Active section tab. Defaults to 'focus' — the panel's whole point is that you
 *  open it already looking at what you're working on, not at 7 cramped regions. */
function readSection(): TodoSection {
  try {
    const v = localStorage.getItem(LS_SECTION_KEY);
    if (v && (TODO_SECTIONS as readonly string[]).includes(v)) return v as TodoSection;
  } catch { /* ignore */ }
  return 'focus';
}

function persistSection(section: TodoSection) {
  try { localStorage.setItem(LS_SECTION_KEY, section); } catch { /* ignore */ }
}

// Disable layout animation for items that were just dragged to prevent
// the "flash" where both old and new position are briefly visible.
const noAnimateAfterDrag: AnimateLayoutChanges = (args) => {
  const { isSorting, wasDragging } = args;
  if (isSorting || wasDragging) return false;
  return defaultAnimateLayoutChanges(args);
};

// ── SortableTaskItem ──

interface SortableTaskItemProps {
  task: Task;
  isFocused: boolean;
  isDetailOpen?: boolean;
  isRecentlyDone?: boolean;
  /** True when the completion grace period will end in the item being hidden — plays the fade+collapse exit animation. */
  isVanishing?: boolean;
  /** True when a drag over this task's RIGHT indent zone would nest it as a subtask. */
  isNestTarget?: boolean;
  /** True when a drag over this task's LEFT zone would group the two together. */
  isGroupTarget?: boolean;
  depth?: number;               // Nesting depth (0 = top-level, 1 = child, 2 = grandchild, etc.)
  childCount?: number;
  isExpanded?: boolean;           // Whether children are visible (only for parents)
  onToggleExpand?: () => void;    // Toggle children visibility
  /** Receives the mouse event so callers can detect Cmd/Ctrl/Shift multi-select. */
  onClick: (e?: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  /** True when this task is part of the current multi-select set (group-building). */
  isSelected?: boolean;
  /** When true, the panel is in explicit select mode: show a leading checkbox and a
   *  plain click toggles selection (no navigation). */
  selectMode?: boolean;
  /** Toggle this task in/out of the multi-selection (checkbox + select-mode clicks). */
  onSelectToggle?: (taskId: string) => void;
  /** Enter multi-select mode with this task picked (kebab "Select…" entry). */
  onStartSelect?: (taskId: string) => void;
  onSetPhase: (id: string, phase: string) => void;
  onStar?: (id: string) => void;
  onDelete?: (id: string) => void;
  onSetPriority?: (id: string, priority: string) => void;
  onUpdateTitle?: (id: string, title: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onPinTask?: (taskId: string) => void;
  onUnpinTask?: (taskId: string) => void;
  onSetTier?: (taskId: string, tier: FocusTier, newPinnedOrder?: string[]) => void;
  onSetDate?: (taskId: string, date: string | null) => void;
  onSetStartDate?: (taskId: string, date: string | null) => void;
  onUnparent?: (taskId: string) => void;  // Remove parent_task_id (promote to top-level)
  onMoveUp?: (taskId: string) => void;    // Swap with previous sibling
  isPinned?: boolean;
  pinnedTier?: FocusTier;
  searchContext?: string; // Category/Project context pill shown in search mode
  filterOverrideReason?: string;  // Why this task is outside current filters (focus override)
  isFadingOverride?: boolean;     // Task is fading out after focus moved away
  /** Virtual-group rendering: present when this task is part of a multi-member group. */
  groupInfo?: GroupRenderInfo;
  onRenameGroup?: (groupId: string, currentLabel: string) => void;  // Rename the whole group
  onUngroupTask?: (taskId: string) => void;                          // Remove this task from its group
  onDissolveGroup?: (groupId: string) => void;                       // Ungroup ALL members (dissolve the cluster)
  isGroupHidden?: boolean;                                           // This task's group is hidden from Focus
  onUnhideGroup?: (groupId: string) => void;                         // Restore a Focus-hidden group
}

/** Per-task virtual-group render metadata (computed in TodoPanel, consumed by SortableTaskItem). */
interface GroupRenderInfo {
  groupId: string;
  label: string;
  isLead: boolean;   // first member in sorted order — chip + top rounding go here
  isLast: boolean;   // last member — bottom rounding goes here
}

/**
 * Cluster a tier's tasks so same-group members are contiguous, anchored at the
 * group's first member in the given order. Flat (no parent/child nesting) version
 * of the main list's computeSortOrder clustering. Only groups with ≥2 members IN
 * THIS tier cluster — a lone pinned member of a group stays in place. Pure and
 * order-stable, so re-running on already-clustered input is a no-op. Returns ids.
 */
function clusterTierByGroup(tasks: Task[]): string[] {
  const byGroup = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.group_id) {
      let arr = byGroup.get(t.group_id);
      if (!arr) { arr = []; byGroup.set(t.group_id, arr); }
      arr.push(t.id);
    }
  }
  const emitted = new Set<string>();
  const out: string[] = [];
  for (const t of tasks) {
    const members = t.group_id ? byGroup.get(t.group_id) : undefined;
    if (t.group_id && members && members.length >= 1) {
      if (emitted.has(t.group_id)) continue; // already flushed at the lead
      emitted.add(t.group_id);
      out.push(...members);
    } else {
      out.push(t.id);
    }
  }
  return out;
}

/**
 * Per-tier virtual-group render metadata: taskId → { groupId, label, isLead, isLast }.
 * Mirrors the main list's groupRenderMap but scoped to a single tier's displayed
 * tasks (already clustered). A group renders its chip/box down to a SINGLE member
 * (a 1-member group is valid — it acts like a tag and stays visible until the user
 * dissolves it). For a lone member isLead and isLast both hold → chip on top +
 * rounded bottom = a complete one-card box. `displayed` must be in clustered order.
 */
function buildTierGroupMeta(displayed: Task[], labels?: Record<string, string>): Map<string, GroupRenderInfo> {
  const map = new Map<string, GroupRenderInfo>();
  const counts = new Map<string, number>();
  for (const t of displayed) if (t.group_id) counts.set(t.group_id, (counts.get(t.group_id) ?? 0) + 1);
  const firstSeen = new Set<string>();
  const lastIdxByGroup = new Map<string, number>();
  displayed.forEach((t, i) => { if (t.group_id && (counts.get(t.group_id) ?? 0) >= 1) lastIdxByGroup.set(t.group_id, i); });
  displayed.forEach((t, i) => {
    const gid = t.group_id;
    if (!gid || (counts.get(gid) ?? 0) < 1) return;
    const isLead = !firstSeen.has(gid);
    if (isLead) firstSeen.add(gid);
    map.set(t.id, {
      groupId: gid,
      label: labels?.[gid] ?? '',
      isLead,
      isLast: lastIdxByGroup.get(gid) === i,
    });
  });
  return map;
}

function SortableTaskItem({ task, isFocused, isDetailOpen, isRecentlyDone, isVanishing, isNestTarget, isGroupTarget, depth = 0, childCount, isExpanded, onToggleExpand, onClick, isSelected, selectMode, onSelectToggle, onStartSelect, onSetPhase, onStar, onDelete, onSetPriority, onUpdateTitle, onOpenSession, onExpandDetail, onClearFocus, onPinTask, onUnpinTask, onSetTier, onSetDate, onSetStartDate, onUnparent, onMoveUp, isPinned, pinnedTier, searchContext, filterOverrideReason, isFadingOverride, groupInfo, onRenameGroup, onUngroupTask, onDissolveGroup, isGroupHidden, onUnhideGroup }: SortableTaskItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { type: 'task' }, animateLayoutChanges: noAnimateAfterDrag });

  // Combined ref for sortable
  const setNodeRef = useCallback((node: HTMLDivElement | null) => {
    setSortableRef(node);
  }, [setSortableRef]);

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
    // Subtasks indent: 22px = phase-icon(18px) + gap(4px), aligns with parent's first letter
    ...(depth > 0 ? { marginLeft: `${depth * 22}px` } : {}),
  };

  const isDone = task.status === 'done' || task.phase === 'COMPLETE';

  const className = [
    'todo-panel-item',
    isDone ? 'todo-panel-item-done' : '',
    isRecentlyDone ? 'todo-panel-item-recently-done' : '',
    isVanishing ? 'todo-panel-item-vanishing' : '',
    isFocused ? 'task-focused' : '',
    filterOverrideReason ? 'task-filter-override' : '',
    isFadingOverride ? 'task-filter-override-fading' : '',
    isNestTarget ? 'todo-panel-item-nest-target' : '',
    isGroupTarget ? 'todo-panel-item-group-target' : '',
    groupInfo ? 'task-grouped' : '',
    groupInfo?.isLead ? 'task-group-lead' : '',
    groupInfo?.isLast ? 'task-group-last' : '',
    isSelected ? 'task-multi-selected' : '',
  ].filter(Boolean).join(' ');

  const dueDateLabel = formatDateDisplay(task.due_date);
  const dueDateOverdue = isOverdue(task.due_date);
  // Start pill only matters while the task is still deferred (future start).
  // Deliberately checks the task's OWN start_date, not the parent-inherited
  // effective start used by the Now filter — the pill marks where the defer
  // was set, and this row component has no access to the full task list.
  const startMs = task.start_date ? parseDateLocal(task.start_date).getTime() : NaN;
  const startDeferred = Number.isFinite(startMs) && startMs > Date.now();
  const startDateLabel = startDeferred ? formatDateDisplay(task.start_date) : '';

  // Inline title editing via contentEditable (preserves wrapping/layout)
  const [isEditing, setIsEditing] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const clickPosRef = useRef<{ x: number; y: number } | null>(null);
  const isCommittingRef = useRef(false); // one-shot guard against double-fire (pointerdown + blur)

  // Sync DOM text when task.title changes externally (e.g. WS push) while not editing
  useEffect(() => {
    if (!isEditing && titleRef.current && titleRef.current.textContent !== task.title) {
      titleRef.current.textContent = task.title;
    }
  }, [task.title, isEditing]);

  useEffect(() => {
    if (isEditing && titleRef.current) {
      titleRef.current.focus();
      // Place cursor at click position (not select-all)
      if (clickPosRef.current) {
        const { x, y } = clickPosRef.current;
        clickPosRef.current = null;
        // Use caretRangeFromPoint (WebKit/Blink) or caretPositionFromPoint (Firefox)
        if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(x, y);
          if (range) {
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            return;
          }
        } else if ((document as unknown as { caretPositionFromPoint: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint) {
          const pos = (document as unknown as { caretPositionFromPoint: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint(x, y);
          if (pos) {
            const range = document.createRange();
            range.setStart(pos.offsetNode, pos.offset);
            range.collapse(true);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            return;
          }
        }
      }
      // Fallback: place cursor at end
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
      // Revert to original if title is empty or unchanged
      titleRef.current.textContent = task.title;
    }
    isCommittingRef.current = false;
  }, [isEditing, task.title, task.id, onUpdateTitle]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    if (titleRef.current) titleRef.current.textContent = task.title;
  }, [task.title]);

  const handleTitleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Select mode: a click on the title toggles selection (never edits/navigates).
    if (selectMode) { onSelectToggle?.(task.id); return; }
    // Modifier-click on the title must still toggle multi-selection (the title is
    // the natural click target) — forward the event so the row handler sees the
    // metaKey/ctrlKey/shiftKey instead of treating it as a plain focus click.
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      onClick(e);
      return;
    }
    // First click on an unfocused task → focus it (open detail panel).
    // Only enter editing mode when task is already focused.
    if (!isFocused) {
      onClick();
      return;
    }
    if (!onUpdateTitle) return;
    clickPosRef.current = { x: e.clientX, y: e.clientY };
    setIsEditing(true);
  }, [isFocused, onClick, onUpdateTitle, selectMode, onSelectToggle, task.id]);

  // Click-outside handler: exits editing when clicking outside the title span.
  // Also serves as a fallback when blur doesn't fire (e.g. click on non-focusable element).
  useEffect(() => {
    if (!isEditing) return;
    const handleOutsidePointerDown = (e: PointerEvent) => {
      if (titleRef.current && !titleRef.current.contains(e.target as Node)) {
        commitEdit();
      }
    };
    document.addEventListener('pointerdown', handleOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown);
  }, [isEditing, commitEdit]);

  // Disable DnD listeners & sortable attributes while editing to prevent
  // drag from hijacking text selection and focus inside the contentEditable
  const activeAttributes = isEditing ? {} : attributes;
  const activeListeners = isEditing ? {} : listeners;

  return (
    <>
    {/* Group header chip — only above the lead member; names the whole cluster. */}
    {groupInfo?.isLead && (
      <div
        className="task-group-chip"
        style={depth > 0 ? { marginLeft: `${depth * 22}px` } : undefined}
        title="Forked / grouped tasks — independent tasks shown together"
      >
        <span className="task-group-chip-icon" aria-hidden="true">⑂</span>
        <span
          className="task-group-chip-label"
          onClick={(e) => { e.stopPropagation(); onRenameGroup?.(groupInfo.groupId, groupInfo.label); }}
          title="Rename group"
        >
          {groupInfo.label}
        </span>
        {/* Dissolve the whole group — the discoverable counterpart to grouping. */}
        {onDissolveGroup && (
          <button
            className="task-group-chip-dissolve"
            onClick={(e) => { e.stopPropagation(); onDissolveGroup(groupInfo.groupId); }}
            aria-label="Ungroup these tasks"
            title="Ungroup — dissolve this group"
          >
            ✕
          </button>
        )}
      </div>
    )}
    <div
      ref={setNodeRef}
      style={style}
      className={className}
      data-task-id={task.id}
      data-group-id={groupInfo?.groupId}
      onClick={(e) => {
        if (isEditing) return;
        // Select mode: a plain click anywhere toggles selection (no navigation/edit).
        if (selectMode) { onSelectToggle?.(task.id); return; }
        // Title has its own click handler (focus first, edit on second click)
        if ((e.target as HTMLElement).closest('.todo-item-title')) return;
        onClick(e);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter' && !isEditing) onClick(); }}
      {...activeAttributes}
      {...activeListeners}
    >
      {/* Select-mode checkbox — explicit multi-select affordance (leading the row). */}
      {selectMode && (
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
      )}

      {/* Chevron — absolutely positioned in left padding area (only for parent tasks) */}
      {(childCount ?? 0) > 0 && (
        <button
          className={`collapse-chevron${isExpanded ? ' expanded' : ''}`}
          title={isExpanded ? 'Collapse child tasks' : `Expand ${childCount} child task(s)`}
          onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
        >
          {CHEVRON_ICON}
        </button>
      )}

      {/* — content area: single-line [attention] [phase] [title] [badges] [⋮] — */}
      <div className="todo-item-content">
        <div className="todo-item-title-row">
          {/* Attention dot — leftmost, keeps everything on one line */}
          {task.needs_attention && !isDone && (
            <span className="task-attention-dot" role="img" aria-label="Needs your attention" title="Needs your attention" />
          )}
          {/* Phase icon — one click toggles To Do ↔ Complete */}
          <button
            className={`task-phase-icon-btn task-status-${task.status} task-phase-${task.phase?.toLowerCase()}`}
            onClick={(e) => {
              e.stopPropagation();
              onSetPhase(task.id, isDone ? 'TODO' : 'COMPLETE');
            }}
            aria-label={isDone ? 'Reopen (mark To Do)' : 'Mark complete'}
            title={isDone ? 'Done — click to reopen' : 'Click to complete'}
          >
            {ICONS.binaryPhaseIcon(isDone)}
          </button>
          <span
            ref={titleRef}
            className={`todo-item-title${isEditing ? ' editing' : ''}`}
            contentEditable={isEditing}
            suppressContentEditableWarning
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
          {/* Info pills + kebab — same line as title, no second row */}
          {startDateLabel && (
            <span className="todo-item-due-pill todo-item-start-pill" title={`Starts: ${task.start_date}`}>
              ▶ {startDateLabel}
            </span>
          )}
          {dueDateLabel && (
            <span className={`todo-item-due-pill${dueDateOverdue ? ' todo-item-due-overdue' : ''}`} title={task.due_date ? `Due: ${task.due_date}` : undefined}>
              {dueDateLabel}
            </span>
          )}
          {!!task.is_blocked && !isDone && (
            <span className="task-blocked-badge" title="Blocked by dependencies">
              blocked
            </span>
          )}
          {!!childCount && (
            <span className="task-children-badge">{childCount} sub</span>
          )}
          {isDone && task.completed_at && (
            <span className="task-completed-time">{timeAgo(task.completed_at)}</span>
          )}
          {/* Kebab menu — all actions consolidated */}
          <TaskKebabMenu
            task={task}
            isFocused={isFocused}
            isDetailOpen={isDetailOpen}
            isPinned={!!isPinned}
            pinnedTier={pinnedTier}
            isDone={isDone}
            onExpandDetail={onExpandDetail}
            onClearFocus={onClearFocus}
            onSetPriority={onSetPriority}
            onStar={onStar}
            onPinTask={onPinTask}
            onUnpinTask={onUnpinTask}
            onSetTier={onSetTier}
            onOpenSession={onOpenSession}
            onSetDate={onSetDate}
            onSetStartDate={onSetStartDate}
            onUnparent={onUnparent}
            onMoveUp={onMoveUp}
            onUngroup={onUngroupTask}
            isGroupHidden={isGroupHidden}
            onUnhideGroup={onUnhideGroup}
            onStartSelect={onStartSelect}
            onDelete={onDelete}
          />
        </div>
        {/* Filter override reason — shown below title when task is outside current filters */}
        {filterOverrideReason && (
          <div className="task-filter-override-row">
            <span className="task-filter-override-badge" title="This task is outside your current filters and is shown temporarily because you navigated to it. It will fade away when you select another task.">
              {filterOverrideReason}
            </span>
          </div>
        )}
        {searchContext && (
          <div className="todo-item-meta-row">
            <span className="todo-search-context-pill" title={searchContext}>
              {searchContext}
            </span>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

// ── Static task item for DragOverlay ──

function TaskItemOverlay({ task }: { task: Task }) {
  return (
    <div className="todo-panel-item drag-overlay-item">
      <div className="todo-item-content">
        <span className="todo-item-title">{task.title}</span>
      </div>
      <span className={`badge badge-${task.priority}`}>{task.priority === 'immediate' ? '!!' : task.priority === 'important' ? '!' : task.priority === 'backlog' ? '~' : '--'}</span>
    </div>
  );
}

// ── SortableGroupItem (for category/project group drag) ──
// Dragged item: collapsed (height 0). Other items: shift via transform to show a gap.

interface SortableGroupItemProps {
  id: string;
  children: (props: { dragHandleProps: Record<string, unknown> }) => React.ReactNode;
}

function SortableGroupItem({ id, children }: SortableGroupItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, data: { type: id.startsWith('cat:') ? 'category-group' : 'project-group' } });

  const style: CSSProperties = isDragging
    ? { opacity: 0, pointerEvents: 'none' }
    : { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={style}>
      {children({ dragHandleProps: { ...attributes, ...listeners } })}
    </div>
  );
}

// ── DroppableHeader (drop zone for cross-group task moves) ──

interface DroppableHeaderProps {
  id: string;
  category: string;
  project: string;
  disabled: boolean;
  children: (props: { isOver: boolean; setNodeRef: (node: HTMLElement | null) => void }) => React.ReactNode;
}

function DroppableHeader({ id, category, project, disabled, children }: DroppableHeaderProps) {
  const { isOver, setNodeRef } = useDroppable({
    id,
    data: { type: 'header-drop', category, project },
    disabled,
  });
  return <>{children({ isOver, setNodeRef })}</>;
}

// ── Order-aware sort comparator ──

function orderedSort(items: string[], orderList: string[]): string[] {
  const indexMap = new Map(orderList.map((name, i) => [name, i]));
  return [...items].sort((a, b) => {
    const ai = indexMap.get(a);
    const bi = indexMap.get(b);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.localeCompare(b);
  });
}

// ── Sort comparators ──

// SortBy and GroupBy types imported from ViewDropdown

const PRIORITY_RANK: Record<string, number> = { immediate: 0, important: 1, backlog: 2, none: 3 };

function readSortBy(): SortBy {
  try {
    const v = localStorage.getItem(LS_SORT_KEY);
    if (v === 'manual' || v === 'priority' || v === 'date' || v === 'updated') return v;
  } catch { /* ignore */ }
  return 'priority';
}

function persistSortBy(v: SortBy) {
  try { localStorage.setItem(LS_SORT_KEY, v); } catch { /* ignore */ }
}

function readGroupBy(): GroupBy {
  try {
    const v = localStorage.getItem(LS_GROUP_KEY);
    if (v === 'category' || v === 'none') return v;
  } catch { /* ignore */ }
  return 'category';
}

function persistGroupBy(v: GroupBy) {
  try { localStorage.setItem(LS_GROUP_KEY, v); } catch { /* ignore */ }
}

function readDateFilter(): DateFilter {
  try {
    const v = localStorage.getItem(LS_DATE_FILTER_KEY);
    if (v === 'now' || v === 'overdue' || v === 'this-week' || v === 'no-date' || v === '') return v as DateFilter;
  } catch { /* ignore */ }
  return 'now'; // default: only show tasks that need attention
}

function persistDateFilter(v: DateFilter) {
  try { localStorage.setItem(LS_DATE_FILTER_KEY, v); } catch { /* ignore */ }
}

/**
 * Resolve an effective date field for a task: if the task has no value,
 * walk up the parent chain and inherit the first ancestor's value.
 */
function getEffectiveDateField(task: Task, allTasks: Task[], field: 'due_date' | 'start_date'): string | undefined {
  if (task[field]) return task[field];
  if (!task.parent_task_id) return undefined;
  // Walk up parent chain (max 10 depth to avoid infinite loops)
  let current: Task | undefined = task;
  for (let i = 0; i < 10 && current?.parent_task_id; i++) {
    const parent = allTasks.find(t => t.id.startsWith(current!.parent_task_id!));
    if (!parent) break;
    if (parent[field]) return parent[field];
    current = parent;
  }
  return undefined;
}

function getEffectiveDueDate(task: Task, allTasks: Task[]): string | undefined {
  return getEffectiveDateField(task, allTasks, 'due_date');
}

function getEffectiveStartDate(task: Task, allTasks: Task[]): string | undefined {
  return getEffectiveDateField(task, allTasks, 'start_date');
}

/** True when the task's (inherited) start_date is still in the future —
 *  i.e. the task is deferred and not yet actionable. Day-level start dates
 *  activate at local midnight of that day. */
function isDeferredByStart(task: Task, allTasks: Task[], now = Date.now()): boolean {
  const effectiveStart = getEffectiveStartDate(task, allTasks);
  if (!effectiveStart) return false;
  const startMs = parseDateLocal(effectiveStart).getTime();
  return Number.isFinite(startMs) && startMs > now;
}

/** Match task against dateFilter. Uses time-level precision for "now".
 *  Child tasks inherit parent's due_date/start_date for filtering if they
 *  have none.
 *
 *  "Now" is START-time driven: it answers "what should I look at now", so a
 *  task is shown unless its start_date says the work begins later. Due dates
 *  are deadlines — they mark Overdue but never hide a task from Now. */
function matchesDateFilter(task: Task, filter: DateFilter, allTasks: Task[]): boolean {
  if (!filter) return true; // "All"
  const now = Date.now();
  switch (filter) {
    case 'now':
      // Everything actionable now: no start date, or start time has arrived.
      return !isDeferredByStart(task, allTasks, now);
    case 'overdue': {
      const effectiveDue = getEffectiveDueDate(task, allTasks);
      const dueMs = effectiveDue ? parseDateLocal(effectiveDue).getTime() : null;
      if (!dueMs) return false;
      // Time-level dates: overdue if past now; Day-level: overdue if before start of today
      if (effectiveDue!.includes('T')) return dueMs < now;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      return dueMs < todayStart.getTime();
    }
    case 'this-week': {
      // Same start-driven semantics with a 7-day horizon: hide only tasks
      // whose start is beyond this week.
      const effectiveStart = getEffectiveStartDate(task, allTasks);
      const startMs = effectiveStart ? parseDateLocal(effectiveStart).getTime() : null;
      return !startMs || startMs <= now + 7 * 86_400_000;
    }
    case 'no-date':
      // no-date means the task itself is unscheduled (not inherited)
      return !task.due_date && !task.start_date;
    default:
      return true;
  }
}

/** Sort tasks by priority (Immediate → Important → Backlog → None), then by created_at descending within same priority */
function comparePriority(a: Task, b: Task): number {
  const pa = PRIORITY_RANK[effectivePriority(a.priority)] ?? 3;
  const pb = PRIORITY_RANK[effectivePriority(b.priority)] ?? 3;
  if (pa !== pb) return pa - pb;
  // Same priority: newest first
  return compareDate(a, b);
}

/** Sort tasks by created_at descending (newest first) */
function compareDate(a: Task, b: Task): number {
  const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
  const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
  return tb - ta; // newest first
}

/** Sort tasks by updated_at descending (most recently modified first) */
function compareUpdated(a: Task, b: Task): number {
  const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
  const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
  return tb - ta; // most recently updated first
}

// ── Type-aware collision detection ──
// Only considers droppable items of the same type as the active drag item.
// This prevents category drags from colliding with tasks or project headers.

const typeAwareCollision: CollisionDetection = (args) => {
  const activeType = (args.active.data?.current as { type?: string })?.type ?? 'task';
  const activeId = String(args.active.id);

  const filtered = args.droppableContainers.filter((container) => {
    const cType = (container.data?.current as { type?: string })?.type ?? 'task';

    // Tasks can collide with all tasks (cross-group) and header drop zones
    if (activeType === 'task') {
      return cType === 'task' || cType === 'header-drop';
    }

    // Category/project group drags: same-type only
    if (cType !== activeType) return false;

    // For project groups, only match projects in the same parent category
    if (activeType === 'project-group' && activeId.startsWith('proj:') && String(container.id).startsWith('proj:')) {
      const activeCat = activeId.slice(5).split('/')[0];
      const containerCat = String(container.id).slice(5).split('/')[0];
      return activeCat === containerCat;
    }

    return true;
  });

  if (filtered.length === 0) return [];
  return closestCenter({ ...args, droppableContainers: filtered });
};

// ── Modifier: snap overlay to cursor for group drags ──
// The drag handle is small but the sortable element is the full-width header,
// so the default overlay position can be far from the cursor. This modifier
// adjusts the overlay so its top-left is near the initial click point.

const snapToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform;
  const event = activatorEvent as PointerEvent;
  if (!event.clientX) return transform;
  const offsetX = event.clientX - draggingNodeRect.left - 16;
  const offsetY = event.clientY - draggingNodeRect.top - 12;
  return { ...transform, x: transform.x + offsetX, y: transform.y + offsetY };
};

// ── Live pointer tracker for drop-intent detection ──────────────────────────
// dnd-kit's DragOverEvent does NOT carry the live cursor position (only the
// activatorEvent at drag START). To decide whether a drop on a task card means
// "join its group" (left side) vs "become its subtask" (right indent zone) vs
// "reorder" (gap), we need where the pointer is RIGHT NOW. A single passive
// window pointermove listener (installed on drag start, removed on end) keeps the
// latest coords in a module ref the drag handlers read. Module-level (not React
// state) so it never triggers a re-render — the React #185 loop guard the DnD
// code is littered with depends on dragOver NOT churning state.
const livePointer = { x: 0, y: 0 };
function trackPointer(e: PointerEvent) { livePointer.x = e.clientX; livePointer.y = e.clientY; }

// left 2/3 of a card = group zone, right 1/3 = subtask (indent) zone.
export const GROUP_ZONE_RATIO = 2 / 3;

/**
 * Pure threshold: given the cursor's horizontal fraction within a card (0 = left
 * edge, 1 = right edge), return the drop intent. `frac >= GROUP_ZONE_RATIO` (right
 * indent zone) → 'subtask', else → 'group'. Out-of-range/NaN falls back to 'group'
 * (the safe default — grouping is non-destructive and works in every surface).
 * Exported for unit testing the zone boundary.
 */
export function classifyDropFraction(frac: number): 'group' | 'subtask' {
  if (!Number.isFinite(frac)) return 'group';
  return frac >= GROUP_ZONE_RATIO ? 'subtask' : 'group';
}

/**
 * Classify a drop on a task card by the live pointer's horizontal position within
 * it. Caller decides whether 'subtask' is allowed (Main list yes, Pin tiers no —
 * they have no subtasks). Falls back to 'group' if the card rect can't be measured.
 */
function classifyDropOnCard(cardEl: Element | null): 'group' | 'subtask' {
  if (!cardEl) return 'group';
  const r = cardEl.getBoundingClientRect();
  if (r.width <= 0) return 'group';
  return classifyDropFraction((livePointer.x - r.left) / r.width);
}

// Session info colors — imported from single source of truth.
// Re-exported as local aliases for backwards compat with type signature.
const processDotColors = PROCESS_COLORS as Record<ProcessStatus, string>;
const phaseColors = PHASE_COLORS as Record<TaskPhase, string>;


function truncateCwd(p: string): string {
  const segments = p.split('/').filter(Boolean);
  return segments.length > 0 ? segments.slice(-2).join('/') : p;
}

// ── TaskDetailPane ──
// Exported so it can be hosted in a full-screen modal (TaskDetailModal) rather than
// only the cramped inline split-pane. The home page renders it via the modal; the
// dedicated /tasks page still embeds it inline.

export function TaskDetailPane({ task, allTasks, onClose, onOpenSession, onOpenTriageForTask, onFocusChild, style }: { task: Task; allTasks?: Task[]; onClose?: () => void; onOpenSession?: (sessionId: string) => void; onOpenTriageForTask?: (taskId: string) => void; onFocusChild?: (task: Task) => void; style?: CSSProperties }) {
  const navigate = useNavigate();
  const integrations = useIntegrations();
  const statusEpoch = useSessionStatusEpoch();
  // Support slim/minimal mode: has_* flags are set when content was stripped
  // server-side. The minimal home-list payload drops summary/description/ext
  // too, so derive presence from the flag OR the inlined value.
  const hasDescription = !!task.description || !!task.has_description;
  const hasSummary = !!task.summary || !!task.has_summary;
  const hasExt = !!(task.ext && Object.keys(task.ext).length > 0) || !!task.has_ext;
  const hasNote = !!task.note || !!task.has_note;

  // Lazy-load full task when any stripped field's content is needed (slim or
  // minimal mode). One fetchTask(id) call rehydrates summary/description/ext/note
  // together.
  const [fullTask, setFullTask] = useState<Task | null>(null);
  useEffect(() => { setFullTask(null); }, [task.id]); // Reset on task change
  const needsFullLoad =
    (hasNote && !task.note) ||
    (hasSummary && !task.summary) ||
    (hasDescription && !task.description) ||
    (hasExt && !task.ext);
  useEffect(() => {
    if (!needsFullLoad || fullTask) return;
    let cancelled = false;
    fetchTask(task.id).then((t) => { if (!cancelled) setFullTask(t); }).catch(() => {});
    return () => { cancelled = true; };
  }, [needsFullLoad, fullTask, task.id]);
  // Use full task data when available for stripped-field rendering
  const noteContent = task.note ?? fullTask?.note;
  const descriptionContent = task.description ?? fullTask?.description;
  const handleSprintChange = async (sprintName: string | null) => {
    await apiUpdateTask(task.id, { sprint: sprintName ?? '' });
  };

  const handleDateChange = async (date: string | null) => {
    await apiUpdateTask(task.id, { due_date: date ?? '' });
  };

  const handleStartDateChange = async (date: string | null) => {
    await apiUpdateTask(task.id, { start_date: date ?? '' });
  };

  // Child tasks — tasks whose parent_task_id matches this task (handles prefix parent IDs)
  const childTasks = useMemo(() => {
    if (!allTasks) return [];
    return allTasks.filter((t) => t.parent_task_id && task.id.startsWith(t.parent_task_id));
  }, [allTasks, task.id]);

  // Parent task — resolve parent_task_id (may be a prefix) to the actual parent
  const parentTask = useMemo(() => {
    if (!allTasks || !task.parent_task_id) return null;
    return allTasks.find((t) => t.id.startsWith(task.parent_task_id!)) ?? null;
  }, [allTasks, task.parent_task_id]);

  // Build a comprehensive set of all session IDs from both session_ids array and slot fields.
  // This prevents the Sessions section from disappearing when session_ids is stale but slots are set.
  const allSessionIds = useMemo(() => {
    const ids = new Set<string>(task.session_ids ?? []);
    if (task.session_id) ids.add(task.session_id);
    if (task.plan_session_id) ids.add(task.plan_session_id);
    if (task.exec_session_id) ids.add(task.exec_session_id);
    return Array.from(ids);
  }, [task.session_ids, task.session_id, task.plan_session_id, task.exec_session_id]);

  // Fetch session records for title resolution (API filters out embedded agent runs)
  const [sessionRecords, setSessionRecords] = useState<Map<string, SessionRecord>>(new Map());
  const [sessionsLoading, setSessionsLoading] = useState(false);
  // Separate archived from visible sessions once records are loaded.
  // Before records load, we can't know which are archived — show all as placeholder.
  const { visibleSessionIds, archivedCount } = useMemo(() => {
    if (sessionRecords.size === 0) return { visibleSessionIds: allSessionIds, archivedCount: 0 };
    const visible: string[] = [];
    let archived = 0;
    for (const sid of allSessionIds) {
      const baseRecord = sessionRecords.get(sid);
      const rec = baseRecord ? resolveSessionRecordStatus(baseRecord) : undefined;
      if (rec?.archived) { archived++; continue; }
      // Keep IDs that either have a non-archived record or haven't been fetched yet
      if (rec || !sessionRecords.size) visible.push(sid);
    }
    // Also include API-returned non-archived sessions not in allSessionIds (e.g. embedded)
    for (const [sid, baseRecord] of sessionRecords) {
      const rec = resolveSessionRecordStatus(baseRecord);
      if (rec.archived) continue;
      if (!allSessionIds.includes(sid)) visible.push(sid);
    }
    return { visibleSessionIds: visible, archivedCount: archived };
  }, [allSessionIds, sessionRecords, statusEpoch]);

  // Show sessions section based on task data (allSessionIds) — not on the async API result.
  // This prevents the section from disappearing/flickering when the fetch is in progress or fails.
  // After fetch completes, refine to only show if API returned actual records (filters embedded runs).
  const hasSessions = sessionsLoading ? allSessionIds.length > 0 : (visibleSessionIds.length > 0 || allSessionIds.length > 0);
  useEffect(() => {
    if (!allSessionIds.length) { setSessionRecords(new Map()); setSessionsLoading(false); return; }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setSessionsLoading(true);

    const applyResults = (sessions: SessionRecord[]) => {
      if (cancelled) return;
      const map = new Map<string, SessionRecord>();
      for (const s of sessions) map.set(s.claudeSessionId, s);
      setSessionRecords(map);
      setSessionsLoading(false);
    };

    fetchSessionsForTask(task.id).then(applyResults).catch(() => {
      // Retry once after 1s — transient errors shouldn't hide sessions
      if (cancelled) return;
      retryTimer = setTimeout(() => {
        if (cancelled) return;
        fetchSessionsForTask(task.id).then(applyResults).catch(() => {
          if (!cancelled) setSessionsLoading(false);
        });
      }, 1000);
    });
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [task.id, allSessionIds.join(',')]);

  // Fetch triage count for this task
  const [triageTotal, setTriageTotal] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchTriageHistory(1, task.id).then((resp) => {
      if (cancelled) return;
      setTriageTotal(resp.total);
    }).catch(() => { /* non-critical */ });
    return () => { cancelled = true; };
  }, [task.id]);

  return (
    <div className="todo-detail-pane" style={style}>
      <div className="todo-detail-header">
        <span className="todo-detail-category">
          {task.category}{task.project && task.project !== task.category ? ` / ${task.project}` : ''}
        </span>
        <DatePicker date={task.start_date} onChange={handleStartDateChange} label="Start" />
        <DatePicker date={task.due_date} onChange={handleDateChange} label="Due" />
        {task.external_url && (
          <a
            className="todo-detail-external-link"
            href={task.external_url}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open in ${getIntegrationMeta(integrations, task.source)?.externalLinkLabel ?? getIntegrationMeta(integrations, task.source)?.name ?? 'external'}`}
          >
            {getIntegrationMeta(integrations, task.source)?.name ?? 'Link'} &#x2197;
          </a>
        )}
        {onClose && (
          <button className="todo-detail-close" onClick={onClose} aria-label="Close detail panel" title="Close">&times;</button>
        )}
      </div>

      {/* Task metadata — always visible */}
      <div className="todo-detail-meta">
        <div className="todo-detail-title">{task.title}</div>
        <div className="todo-detail-badges">
          <span className={`badge-phase badge-phase-${task.phase?.toLowerCase()}`}>
            {PHASE_ICON[task.phase] ?? '○'} {PHASE_LABEL[task.phase] ?? task.phase}
          </span>
          {task.priority && task.priority !== 'none' && (
            <span className={`todo-detail-priority-pill priority-${task.priority}`}>
              {PRIORITY_ICON[task.priority]} {PRIORITY_LABEL[task.priority]}
            </span>
          )}
          <SprintPicker sprint={task.sprint} onSprintChange={handleSprintChange} />
        </div>
        <div className="todo-detail-dates text-xs text-muted">
          {task.created_at && <span>Created {timeAgo(task.created_at)}</span>}
          {task.updated_at && <span> · Updated {timeAgo(task.updated_at)}</span>}
          {task.start_date && (
            <span> · Starts {formatDateTimeDisplay(task.start_date)}</span>
          )}
          {task.due_date && (
            <span style={isOverdue(task.due_date) ? { color: 'var(--error)' } : undefined}>
              {' '}· Due {formatDateTimeDisplay(task.due_date)}
            </span>
          )}
        </div>
      </div>

      {parentTask && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Parent Task</div>
          <div
            className="todo-detail-child-item"
            role="button"
            tabIndex={0}
            onClick={() => onFocusChild ? onFocusChild(parentTask) : navigate(`/tasks/${parentTask.id}`)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocusChild ? onFocusChild(parentTask) : navigate(`/tasks/${parentTask.id}`); } }}
          >
            <span
              className="todo-detail-child-dot"
              style={{
                background: parentTask.status === 'done' ? '#34c759'
                  : parentTask.phase === 'IN_PROGRESS' ? '#007aff'
                  : parentTask.phase === 'AGENT_COMPLETE' ? 'var(--error)'
                  : parentTask.phase === 'AWAIT_HUMAN_ACTION' ? 'var(--error)'
                  : 'var(--fg-muted)',
              }}
            />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {parentTask.title}
            </span>
            <span className="text-xs text-muted">{PHASE_LABEL[parentTask.phase] ?? parentTask.phase}</span>
          </div>
        </div>
      )}

      {hasSessions && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Sessions ({sessionsLoading && !sessionRecords.size ? allSessionIds.length : visibleSessionIds.length})</div>
          <div className="todo-detail-sessions">
            {sessionsLoading && sessionRecords.size === 0 ? (
              // While loading, show a placeholder using task-level session status (available immediately)
              allSessionIds.map((sid) => {
                const taskStatus = sessionStatusStore.getStatus(sid) ?? task.session_status;
                const processStatus = taskStatus?.process_status || 'stopped';
                const taskPhase = (task.phase || 'TODO') as TaskPhase;
                const isPlan = taskStatus?.mode === 'plan' || !!taskStatus?.planCompleted;
                const statusLabel = PHASE_LABELS[taskPhase] ?? taskPhase;
                return (
                  <div
                    key={sid}
                    className="todo-detail-session-item"
                    title={sid}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenSession ? onOpenSession(sid) : navigate(`/sessions?id=${sid}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenSession ? onOpenSession(sid) : navigate(`/sessions?id=${sid}`); } }}
                  >
                    <div className="todo-detail-session-row1">
                      <span className="todo-detail-session-dot" style={{ background: processDotColors[processStatus] ?? 'var(--fg-muted)' }} />
                      {isPlan && <span className="todo-detail-plan-badge">Plan</span>}
                      <span className="todo-detail-session-title text-muted">Loading…</span>
                      <span className="session-id-mono text-xs" title={`Session ID: ${sid}`}>{sid.slice(0, 8)} &#x2197;</span>
                    </div>
                    <div className="todo-detail-session-meta">
                      <span className="todo-detail-ws-pill" style={{ color: phaseColors[taskPhase] ?? 'var(--fg-muted)', borderColor: phaseColors[taskPhase] ?? 'var(--fg-muted)' }}>
                        {statusLabel}
                      </span>
                    </div>
                  </div>
                );
              })
            ) : (
              visibleSessionIds.filter((sid) => sessionRecords.has(sid)).map((sid) => {
                const baseRecord = sessionRecords.get(sid);
                const record = baseRecord ? resolveSessionRecordStatus(baseRecord) : undefined;
                const processStatus = record?.process_status || 'stopped';
                const sessionPhase = (task.phase || 'TODO') as TaskPhase;
                const label = record?.title || 'Untitled session';
                const ago = timeAgo(record?.lastActiveAt || record?.startedAt || '');
                const isPlan = record?.mode === 'plan' || !!record?.planCompleted;
                const modeLabel = record?.mode && record.mode !== 'default' && record.mode !== 'plan' && !record?.planCompleted ? record.mode : null;
                const statusLabel = (PHASE_LABELS[sessionPhase] ?? sessionPhase) + (modeLabel ? ` · ${modeLabel}` : '');
                return (
                  <div
                    key={sid}
                    className="todo-detail-session-item"
                    title={sid}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (onOpenSession) {
                        onOpenSession(sid);
                      } else {
                        navigate(`/sessions?id=${sid}`);
                      }
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenSession ? onOpenSession(sid) : navigate(`/sessions?id=${sid}`); } }}
                  >
                    {/* Row 1: process dot + title + time + open-tab */}
                    <div className="todo-detail-session-row1">
                      <span
                        className="todo-detail-session-dot"
                        style={{ background: processDotColors[processStatus] ?? 'var(--fg-muted)' }}
                      />
                      {isPlan && (
                        <span className="todo-detail-plan-badge">Plan</span>
                      )}
                      <span className="todo-detail-session-title">{label}</span>
                      {ago && <span className="todo-detail-session-time">{ago}</span>}
                      <span
                        className="session-id-mono text-xs"
                        role="button"
                        title={`Session ID: ${sid}\nClick to open in Sessions page`}
                        onClick={(e) => { e.stopPropagation(); onOpenSession ? onOpenSession(sid) : navigate(`/sessions?id=${sid}`); }}
                      >
                        {sid.slice(0, 8)} &#x2197;
                      </span>
                    </div>
                    {/* Row 2: phase pill + activity */}
                    <div className="todo-detail-session-meta">
                      <span
                        className="todo-detail-ws-pill"
                        style={{
                          color: phaseColors[sessionPhase] ?? 'var(--fg-muted)',
                          borderColor: phaseColors[sessionPhase] ?? 'var(--fg-muted)',
                        }}
                      >
                        {statusLabel}
                      </span>
                      {record?.activity && processStatus === 'running' && (
                        <span className="text-xs text-muted" style={{ fontStyle: 'italic' }}>
                          — {record.activity}
                        </span>
                      )}
                    </div>
                    {/* Recap tip — one line "what just happened" (self-report); hidden
                        while running (live activity above covers that state). */}
                    {record?.recap && processStatus !== 'running' && (
                      <div
                        className="text-xs truncate"
                        style={{ color: 'var(--fg-muted)', marginTop: '2px' }}
                        title={record.recap}
                      >
                        💬 {record.recap}
                      </div>
                    )}
                    {/* Row 3: cwd (conditional) */}
                    {record?.cwd && (
                      <div className="todo-detail-session-cwd">
                        &#x1F4C1; {truncateCwd(record.cwd)}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {childTasks.length > 0 && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Child Tasks ({childTasks.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {childTasks.map((child) => (
              <div
                key={child.id}
                className="todo-detail-child-item"
                role="button"
                tabIndex={0}
                onClick={() => onFocusChild ? onFocusChild(child) : navigate(`/tasks/${child.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocusChild ? onFocusChild(child) : navigate(`/tasks/${child.id}`); } }}
              >
                <span
                  className="todo-detail-child-dot"
                  style={{
                    background: child.status === 'done' ? '#34c759'
                      : child.phase === 'IN_PROGRESS' ? '#007aff'
                      : child.phase === 'AGENT_COMPLETE' ? 'var(--error)'
                      : child.phase === 'AWAIT_HUMAN_ACTION' ? 'var(--error)'
                      : 'var(--fg-muted)',
                    opacity: child.status === 'done' ? 0.5 : 1,
                  }}
                />
                <span style={{
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  textDecoration: child.status === 'done' ? 'line-through' : 'none',
                  opacity: child.status === 'done' ? 0.5 : 1,
                }}>
                  {child.title}
                </span>
                <span className="text-xs text-muted">{PHASE_LABEL[child.phase] ?? child.phase}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary (AI) + Milestones sections retired 2026-07-18 — the Note below is
          the single AI-maintained living document; task.summary is derived from
          its Executive Summary (list views only). */}

      {triageTotal > 0 && onOpenTriageForTask && (
        <div className="todo-detail-section">
          <button
            className="todo-detail-triage-btn"
            onClick={() => onOpenTriageForTask(task.id)}
          >
            View Triage History ({triageTotal}) &#x2192;
          </button>
        </div>
      )}

      {hasDescription && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Description</div>
          {descriptionContent
            ? <div className="todo-detail-note markdown-body" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(descriptionContent) }} />
            : <div className="text-sm text-muted">Loading...</div>
          }
        </div>
      )}

      {hasNote && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Note</div>
          {noteContent
            ? <div className="todo-detail-note markdown-body" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(noteContent) }} />
            : <div className="text-sm text-muted">Loading...</div>
          }
        </div>
      )}

      {!hasDescription && !hasSummary && !hasNote && childTasks.length === 0 && !hasSessions && triageTotal === 0 && (
        <div className="todo-detail-empty text-sm text-muted">No details</div>
      )}
    </div>
  );
}

const RECENT_VISIBLE_MAX = 3;

// ── InlineAdd — "+" row at the bottom of a tier or project group to add a task
// directly into that context. Reuses the parent onCreate (optimistic + tier-correct path). ──
function InlineAdd({ onAdd, label = 'Add to Focus…' }: { onAdd: (title: string) => void | Promise<unknown>; label?: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const submit = () => {
    const title = value.trim();
    if (!title) { setOpen(false); return; }
    // Clear optimistically (rapid multi-add is the common case) but PUT THE TEXT
    // BACK if the create rejects. onAdd is async and useTasks.create() rethrows
    // after reporting, so an unawaited call here both lost the user's typing and
    // produced an [unhandledrejection] in the console — the create failed, the
    // optimistic row rolled back, and the row just vanished with the title gone.
    setValue('');
    Promise.resolve(onAdd(title)).catch(() => {
      setValue(title);
      setOpen(true);
      inputRef.current?.focus();
    });
    // Keep open for rapid multi-add; input stays focused.
  };

  if (!open) {
    return (
      <button type="button" className="focus-inline-add-trigger" onClick={() => setOpen(true)} title={label}>
        <span className="focus-inline-add-plus">+</span>
        <span>{label}</span>
      </button>
    );
  }

  return (
    <div className="focus-inline-add">
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder="Task title — Enter to add, Esc to close"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          if (e.key === 'Escape') { e.preventDefault(); setValue(''); setOpen(false); }
        }}
        onBlur={() => { if (!value.trim()) setOpen(false); }}
      />
    </div>
  );
}

interface RecentCardProps {
  task: Task;
  isFocused: boolean;
  /** Completion grace period is ending in removal — play the fade+collapse exit. */
  isVanishing?: boolean;
  isSessionOpen?: boolean;
  isDetailOpen?: boolean;
  onClick?: (task: Task) => void;
  onPinTask?: (taskId: string) => void;
  onUnpinTask?: (taskId: string) => void;
  isPinned?: boolean;
  pinnedTier?: FocusTier;
  onSetPriority?: (id: string, priority: string) => void;
  onSetDate?: (id: string, date: string | null) => void;
  onSetStartDate?: (id: string, date: string | null) => void;
  onStar?: (id: string) => void;
  onSetTier?: (id: string, tier: FocusTier) => void;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onOpenSession?: (sessionId: string) => void;
  onSetPhase?: (id: string, phase: string) => void;
  onUpdateTitle?: (id: string, title: string) => void;
  onDelete?: (id: string) => void;
}

// ── SortableRecentCard — draggable recent-activity card with kebab menu ──

function SortableRecentCard({ task, isFocused, isVanishing, isSessionOpen, isDetailOpen, onClick, onPinTask, onUnpinTask, isPinned, pinnedTier, onSetPriority, onSetDate, onSetStartDate, onStar, onSetTier, onExpandDetail, onClearFocus, onOpenSession, onSetPhase, onUpdateTitle, onDelete }: RecentCardProps) {
  // Static cards: done (tiers filter them out — a drag would silently vanish) and
  // pinned (already placed in a tier; that tier card is the draggable one). Static
  // cards register under a NAMESPACED sortable id — the raw task.id is already
  // registered by the tier's card in this same DndContext, and duplicate ids make
  // dnd-kit's registry clobber the tier card's node.
  const isDoneStatic = task.status === 'done' || task.phase === 'COMPLETE';
  const isStatic = isDoneStatic || !!isPinned;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: isStatic ? `recent-static:${task.id}` : task.id, data: { source: 'recent' }, disabled: isStatic });

  // Editable title state
  const [isEditing, setIsEditing] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const isCommittingRef = useRef(false);
  const clickPosRef = useRef<{ x: number; y: number } | null>(null);
  const titleClickedRef = useRef(false);

  useEffect(() => {
    if (!isEditing && titleRef.current && titleRef.current.textContent !== task.title) {
      titleRef.current.textContent = task.title;
    }
  }, [task.title, isEditing]);

  useEffect(() => {
    if (isEditing && titleRef.current) {
      titleRef.current.focus();
      if (clickPosRef.current) {
        const { x, y } = clickPosRef.current;
        clickPosRef.current = null;
        if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(x, y);
          if (range) { const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range); return; }
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
    clickPosRef.current = { x: e.clientX, y: e.clientY };
    setIsEditing(true);
  }, [onUpdateTitle]);

  const isDone = task.status === 'done' || task.phase === 'COMPLETE';
  const needsAttention = !isDone && (task.phase === 'AGENT_COMPLETE' || task.phase === 'AWAIT_HUMAN_ACTION');
  // Done cards show completion time (that's what "recently completed" means here)
  const ago = timeAgo((isDone && task.completed_at) || task.last_session_update || task.created_at);

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-task-id={task.id}
      className={`todo-pinned-card${isFocused ? ' todo-pinned-card-active' : ''}${needsAttention ? ' todo-pinned-card-attention' : ''}${isSessionOpen ? ' todo-pinned-card-session-open' : ''}${isDone ? ' todo-pinned-card-done' : ''}${isVanishing ? ' todo-card-vanishing' : ''}`}
      onClick={(e) => {
        if (isEditing) return;
        if ((e.target as HTMLElement).closest('.pinned-phase-picker')) return;
        onClick?.(task);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && !isEditing) { e.preventDefault(); onClick?.(task); } }}
    >
      {/* Static cards (done / already pinned): no drag grip. Pinned ones show
          their tier dot instead \u2014 "already placed" at a glance. */}
      {!isStatic && <span className="todo-pinned-drag-handle" {...attributes} {...listeners}>{'\u2261'}</span>}
      {isPinned && pinnedTier && (
        <span
          className={`todo-recent-tier-dot todo-tier-icon-${pinnedTier}`}
          title={`Pinned \u2014 ${pinnedTier === 'focus' ? 'Focus' : pinnedTier === 'wait' ? 'Wait' : 'Satellite'}`}
        >
          {ICONS.tierIcon(pinnedTier)}
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
      {ago && <span className="todo-recent-ago" title={(isDone && task.completed_at) || task.last_session_update}>{ago}</span>}
      <TaskKebabMenu
        task={task}
        isFocused={isFocused}
        isDetailOpen={isDetailOpen}
        isPinned={!!isPinned}
        pinnedTier={pinnedTier}
        isDone={isDone}
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
        onDelete={onDelete}
      />
    </div>
  );
}

// ── TodoPanel ──

export const TodoPanel = memo(function TodoPanel({ tasks: rawTasks, loading, onComplete, onSetPhase, onCreate, onUpdate, onStar, onDelete, onBatchSetPhase, onBatchDelete, onSetPriority, onFocusTask, onClearFocus, focusedTaskId, focusNonce, focusScope, favorites, ordering, onReorder, onMoveTask, onReparentTask, onBakeOrder, onOpenSession, onOpenTriageForTask, onPinTask, onUnpinTask, onReorderPinned, onSetTier, onSetDate, onSetStartDate, pinnedTaskIds, focusTaskIds, waitTaskIds, suppressDetail, openSessionIds, openSessionTaskIds, onClearOperationError, onOperationError, externalCategory, onCategoryChange, onOpenLauncher, taskGroups, hiddenGroups, onGroupTasks, onAddToGroup, onUngroupTask, onUngroupTasks, onRenameGroup, onSetGroupHidden }: TodoPanelProps) {
  // TEMP drag-flash trace — remove after diagnosis
  const __renderCountRef = useRef(0);
  __renderCountRef.current += 1;
  scrollLog('drag-trace-TodoPanel-render', { n: __renderCountRef.current, tasks: rawTasks.length });
  // Hide .metadata* tasks (project/category configuration tasks, not user-visible)
  const tasks = useMemo(() => rawTasks.filter((t) => !t.title.startsWith('.metadata')), [rawTasks]);
  const navigate = useNavigate();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const [showCompleted, setShowCompleted] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState('');
  const [phaseFilter, setPhaseFilter] = useState('');
  const [sessionFilter, setSessionFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilter>(readDateFilter);
  const [sortBy, setSortBy] = useState<SortBy>(readSortBy);
  // Ephemeral toast shown when a manual action (drag / move up / move left)
  // auto-switches the sort mode to 'manual'. Routed through the unified toaster
  // (kind:'sort', non-persistent, 3s lifetime) — no local toast state needed.
  const { notify } = useNotifications();
  const showSortToast = useCallback((msg: string) => {
    notify({ kind: 'sort', severity: 'info', title: 'Sort', body: msg, persistent: false, dedupKey: 'sort' });
  }, [notify]);
  const [groupBy, setGroupBy] = useState<GroupBy>(readGroupBy);
  const [activeCategory, setActiveCategory] = useState(readTab);

  // Focus override: when a focused task would be hidden by filters, store its ID here
  // instead of clearing filters. The filtered useMemo exempts this task from all filter checks.
  // When focus moves away, the task fades out (fadingOverrideRef) before being removed.
  const focusOverrideRef = useRef<string | null>(null);
  const fadingOverrideRef = useRef<string | null>(null);
  const fadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [_overrideTick, setOverrideTick] = useState(0);
  const clearFocusOverride = useCallback(() => {
    if (focusOverrideRef.current) {
      const fadingId = focusOverrideRef.current;
      focusOverrideRef.current = null;
      // Start fade-out: keep in list briefly with fading style
      fadingOverrideRef.current = fadingId;
      setOverrideTick(n => n + 1);
      if (fadingTimerRef.current) clearTimeout(fadingTimerRef.current);
      fadingTimerRef.current = setTimeout(() => {
        fadingOverrideRef.current = null;
        fadingTimerRef.current = null;
        setOverrideTick(n => n + 1);
      }, 600); // 600ms — must match CSS .task-filter-override-fading animation duration
    } else if (fadingOverrideRef.current) {
      // Cancel in-progress fade immediately (e.g. when filter changes during fade)
      if (fadingTimerRef.current) { clearTimeout(fadingTimerRef.current); fadingTimerRef.current = null; }
      fadingOverrideRef.current = null;
      setOverrideTick(n => n + 1);
    }
  }, []);

  // Cleanup fadingTimerRef on unmount
  useEffect(() => {
    return () => { if (fadingTimerRef.current) clearTimeout(fadingTimerRef.current); };
  }, []);

  // Apply externally-set category (e.g. from URL deep link)
  const prevExternalCatRef = useRef(externalCategory);
  useEffect(() => {
    if (externalCategory !== undefined && externalCategory !== prevExternalCatRef.current) {
      setActiveCategory(externalCategory);
      persistTab(externalCategory);
    }
    prevExternalCatRef.current = externalCategory;
  }, [externalCategory]);

  // Auto-refresh tick: bump every 60s so time-dependent UI re-evaluates —
  // the date filter (deferred tasks appear on time) AND the per-row ▶ start
  // pill, which renders in the "All" view too, so the timer runs always.
  const [_tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const integrations = useIntegrations();
  const [newTitle, setNewTitle] = useState('');
  const [quickCategory, setQuickCategory] = useState<string>(''); // '' = use default
  const [quickProject, setQuickProject] = useState<string>('');
  const [quickStarred, setQuickStarred] = useState(false);
  const [quickPinnedTier, setQuickPinnedTier] = useState<FocusTier | null>(null);
  const [quickMoreOpen, setQuickMoreOpen] = useState(false);
  const quickMoreBtnRef = useRef<HTMLButtonElement | null>(null);
  const quickMoreMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!quickMoreOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (quickMoreBtnRef.current?.contains(e.target as Node)) return;
      if (quickMoreMenuRef.current?.contains(e.target as Node)) return;
      setQuickMoreOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [quickMoreOpen]);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_SECTIONS_KEY));
  const toggleSection = useCallback((id: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      persistSet(LS_COLLAPSED_SECTIONS_KEY, next);
      return next;
    });
  }, []);

  // ── Section tabs ──
  // Which of Focus / Satellite / Wait / Recent / Tasks / Notes owns the panel
  // right now ('all' = the legacy stacked view, kept for cross-tier drag).
  // `collapsedSections` is still the *within-a-view* chevron state; these two are
  // independent — in single-section mode the region renders regardless of its
  // collapse flag (a tab you just picked must never show up already folded).
  const [activeSection, setActiveSection] = useState<TodoSection>(readSection);
  // Mirror in a ref: the focus/locate effect reads the current section but must NOT
  // list it as a dependency (a tab switch would re-run the whole locate pass).
  const activeSectionRef = useRef(activeSection);
  activeSectionRef.current = activeSection;
  const handleSectionChange = useCallback((section: TodoSection) => {
    setActiveSection(section);
    persistSection(section);
  }, []);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_CATS_KEY));
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_PROJS_KEY));
  // Tracks which parent tasks the user has EXPANDED (default = all collapsed)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => readSetFromStorage(LS_EXPANDED_PARENTS_KEY));
  // Auto-expand parents with active (non-completed) children on initial load.
  // Handles edge case: fork created while page was closed (task:created WS never received).
  const didAutoExpandRef = useRef(false);
  useEffect(() => {
    if (loading || tasks.length === 0 || didAutoExpandRef.current) return;
    didAutoExpandRef.current = true;
    const parentsToExpand: string[] = [];
    for (const t of tasks) {
      if (!t.parent_task_id || t.status === 'done') continue;
      const parent = tasks.find((p) => p.id.startsWith(t.parent_task_id!));
      if (parent && !expandedParents.has(parent.id)) {
        parentsToExpand.push(parent.id);
      }
    }
    if (parentsToExpand.length === 0) return;
    setExpandedParents((prev) => {
      const next = new Set(prev);
      for (const id of parentsToExpand) next.add(id);
      persistSet(LS_EXPANDED_PARENTS_KEY, next);
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once after initial load
  }, [loading, tasks]);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragType, setActiveDragType] = useState<string | null>(null);
  // Position-based drop intent (replaces the old dwell-to-nest timer): while a task
  // is dragged OVER another task card, the pointer's horizontal position decides the
  // intent and we highlight the target accordingly —
  //   • cursor in the LEFT ~2/3 of the card → `groupTargetId` lit ("join its group")
  //   • cursor in the RIGHT ~1/3 indent zone → `nestTargetId` lit ("become subtask",
  //     Main list only; Pin tiers have no subtasks so they always read as group)
  // Only one is ever set at a time. A ref mirrors the current over-target so rapid
  // onDragOver events that don't change the (target, intent) pair skip setState
  // (React #185 guard — dragOver must not churn SortableContext-affecting state).
  const [nestTargetId, setNestTargetId] = useState<string | null>(null);
  const [groupTargetId, setGroupTargetId] = useState<string | null>(null);
  // Collapse-on-drag bookkeeping: when a whole group is dragged, its member ids in the
  // frozen tier refs are collapsed to a single sentinel (= the chip's id) so the group
  // becomes ONE atomic sortable unit and the strategy pushes siblings aside / opens a
  // slot exactly like a task drag. We remember the sentinel id + the ordered members it
  // stands for so drag end/cancel can expand it back to the real member ids.
  const collapsedGroupRef = useRef<{ sentinel: string; gid: string; members: string[] } | null>(null);
  // ref holds `${overId}:${intent}` of the last applied highlight, to dedupe.
  const dropIntentRef = useRef<string | null>(null);
  // Remove the live-pointer listener if the panel unmounts mid-drag (prevents a
  // leaked window listener on route change during a drag).
  useEffect(() => () => { window.removeEventListener('pointermove', trackPointer); }, []);
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);

  // Search state
  const { query: searchQuery, setQuery: setSearchQuery, results: searchResults, isSearching, clearSearch } = useTaskSearch();

  // Global notes
  const globalNotes = useGlobalNotes();

  // Vertical splitter for list/detail ratio
  const { ratio: detailRatio, containerRef: splitterContainerRef, handleProps: splitterHandleProps, isResizing: splitterResizing } = useVerticalSplitter();
  // Splitter between the PINNED+RECENT region and the main task list.
  // ratio = bottom (main list) share, matching the hook's drag direction
  // (drag divider down → list shrinks → ratio decreases). Default 0.4 = list ~40%.
  // minRatio 0 lets the main list collapse fully — pinned tiers have no per-tier
  // visible cap, so this drag is the one control for how many pinned cards show.
  const { ratio: listRatio, handleProps: pinnedSplitterHandleProps } = useVerticalSplitter({ storageKey: 'open-walnut-todo-pinned-ratio', defaultRatio: 0.4, minRatio: 0, maxRatio: 0.8, containerRef: splitterContainerRef });
  const listCollapsed = listRatio <= 0.02;

  // Per-tier resize: each of Focus/Satellite/Wait gets its own drag handle at the
  // bottom of its card list, independent of the other two and of the overall
  // Pinned/list splitter above. Height is `null` (auto) until the user drags.
  const focusResize = useResizableHeight('open-walnut-focus-tier-height-focus', { min: 60, max: 1200 });
  const satelliteResize = useResizableHeight('open-walnut-focus-tier-height-satellite', { min: 60, max: 1200 });
  const waitResize = useResizableHeight('open-walnut-focus-tier-height-wait', { min: 60, max: 1200 });
  // Recent gets the same treatment — before this it was hard-capped at ~3 rows
  // (RECENT_VISIBLE_MAX * 30) with no way to pull it taller.
  const recentResize = useResizableHeight('open-walnut-focus-tier-height-recent', { min: 60, max: 1200 });

  // Determine if search mode is active (query entered)
  const isSearchMode = searchQuery.trim().length > 0;

  // ── Section-tab view resolution ──
  // Search results only ever render in the main-list region, so a query typed
  // while a tier tab is active would look like the search did nothing. Searching
  // therefore FORCES the tasks view (without touching the persisted tab — clearing
  // the query drops you back where you were).
  const effectiveSection: TodoSection = isSearchMode && activeSection !== 'all' ? 'tasks' : activeSection;
  const isAll = effectiveSection === 'all';
  /** True when `section` should be mounted: either we're in the stacked view or it IS the active tab. */
  const showSection = useCallback(
    (section: Exclude<TodoSection, 'all'>) => isAll || effectiveSection === section,
    [isAll, effectiveSection],
  );
  /** Within the active view, is this region folded? Only the stacked view honors chevrons. */
  const isFolded = useCallback(
    (id: string) => isAll && collapsedSections.has(id),
    [isAll, collapsedSections],
  );

  // Track previous focusedTaskId to detect new focus (not re-renders)
  const prevFocusedRef = useRef<string | undefined>(undefined);
  // Track whether the focused task was already handled (prevents re-running on unrelated tasks changes)
  const focusHandledRef = useRef(false);
  // Track previous focusNonce to detect re-focus on same task
  const prevNonceRef = useRef(focusNonce ?? 0);
  // True while a user-initiated locate (nonce bump) is waiting to be handled —
  // survives the task-not-loaded-yet retry. Page-load restores never set it.
  const pendingLocateRef = useRef(false);
  // RAF handle for cancellation on unmount / new focus
  const scrollRafRef = useRef<number>(0);

  // When set, a useEffect watching `tasks` scrolls this task into view after
  // the next render. Used to preserve scroll position after reparent / move-up
  // triggers a refetch (otherwise the list jumps to top).
  const scrollAfterReparentRef = useRef<string | null>(null);

  // Pulse a card so a "locate" jump (e.g. session panel → task) is visible:
  // scrolling alone leaves the user unsure which card was the target, especially
  // when several pinned cards look alike. Re-triggers cleanly on repeat locates.
  const flashCard = useCallback((el: Element) => {
    el.classList.remove('todo-card-locate-flash');
    void (el as HTMLElement).offsetWidth; // reflow so the animation restarts
    el.classList.add('todo-card-locate-flash');
    setTimeout(() => el.classList.remove('todo-card-locate-flash'), 1500);
  }, []);

  // Scroll to a task by ID inside .todo-panel-list.
  // Uses double-RAF + retry to wait for React commit + browser paint + layout settle
  // after state changes (expand/filter-clear, detail panel open).
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollToTask = useCallback((taskId: string) => {
    cancelAnimationFrame(scrollRafRef.current);
    clearTimeout(scrollTimerRef.current);
    scrollLog('focus-scroll-start', { taskId: taskId.substring(0, 12) });

    const doScroll = (flash = false) => {
      const listContainer = document.querySelector('.todo-panel-list');
      if (!listContainer) {
        scrollLog('focus-scroll-MISS', { reason: 'no-list-container' });
        return;
      }
      const el = listContainer.querySelector(`[data-task-id="${window.CSS.escape(taskId)}"]`);
      if (!el) {
        scrollLog('focus-scroll-MISS', { reason: 'element-not-found', taskId: taskId.substring(0, 12) });
        return;
      }
      const elRect = el.getBoundingClientRect();
      const containerRect = listContainer.getBoundingClientRect();
      const outOfView = elRect.top < containerRect.top || elRect.bottom > containerRect.bottom;
      if (outOfView) {
        const elTopInContainer = elRect.top - containerRect.top + listContainer.scrollTop;
        listContainer.scrollTop = elTopInContainer - containerRect.height / 3;
        scrollLog('focus-scroll-done', { taskId: taskId.substring(0, 12), scrollTo: Math.round(listContainer.scrollTop) });
      } else {
        scrollLog('focus-scroll-skip', { reason: 'already-visible', taskId: taskId.substring(0, 12) });
      }
      if (flash) flashCard(el);
    };

    // Phase 1: double-RAF (React commit + paint) — handles expand/filter DOM changes
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = requestAnimationFrame(() => {
        doScroll(true);
        // Phase 2: re-scroll after 150ms to handle layout shifts from the detail
        // panel opening (flex ratio change on .todo-panel-list). No CSS transition
        // is involved — the flex change is instant — but React may batch the
        // focusedTask state update (which controls the flex style) separately from
        // the focusedTaskId update that triggers this effect. 150ms is generous
        // enough to cover any batched re-renders on slow machines.
        scrollTimerRef.current = setTimeout(() => {
          scrollLog('focus-scroll-phase2', { taskId: taskId.substring(0, 12) });
          doScroll();
        }, 150);
      });
    });
  }, [flashCard]);

  // Scroll a pinned task into view inside the top Pinned region (Focus/Next/Satellite/Wait).
  // Separate from scrollToTask (which targets the lower .todo-panel-list) so the PIN region
  // jumps + highlights too — not just the list below. Double-RAF waits for tier re-render.
  const pinnedScrollRafRef = useRef<number>(0);
  const pinnedScrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollToPinnedTask = useCallback((taskId: string) => {
    cancelAnimationFrame(pinnedScrollRafRef.current);
    clearTimeout(pinnedScrollTimerRef.current);
    const tryScroll = () => {
      const wrapper = document.querySelector('.todo-pinned-wrapper');
      const el = wrapper?.querySelector(`[data-task-id="${window.CSS.escape(taskId)}"]`);
      if (el) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); flashCard(el); return true; }
      return false;
    };
    pinnedScrollRafRef.current = requestAnimationFrame(() => {
      pinnedScrollRafRef.current = requestAnimationFrame(() => {
        // Retry at 150ms: expanding a collapsed pinned section/tier (see focus
        // effect) mounts the card one render later, so the first double-RAF may
        // fire before it exists in the DOM.
        if (!tryScroll()) pinnedScrollTimerRef.current = setTimeout(tryScroll, 150);
      });
    });
  }, [flashCard]);

  // Cleanup RAF + timer on unmount
  useEffect(() => {
    return () => { cancelAnimationFrame(scrollRafRef.current); clearTimeout(scrollTimerRef.current); cancelAnimationFrame(pinnedScrollRafRef.current); clearTimeout(pinnedScrollTimerRef.current); };
  }, []);

  // Scroll the just-moved task back into view after reparent / move-up causes
  // the tasks array to refresh. Watches `tasks` so it fires after the refetch
  // completes and React has re-rendered the new positions.
  useEffect(() => {
    const taskId = scrollAfterReparentRef.current;
    if (!taskId) return;
    scrollAfterReparentRef.current = null;
    scrollToTask(taskId);
  }, [tasks, scrollToTask]);

  // Auto-switch tab, expand groups, and scroll to task when focusedTaskId changes
  useEffect(() => {
    if (!focusedTaskId) {
      prevFocusedRef.current = focusedTaskId;
      focusHandledRef.current = false;
      clearFocusOverride();
      return;
    }
    const isNewFocus = focusedTaskId !== prevFocusedRef.current;
    const nonceChanged = (focusNonce ?? 0) !== prevNonceRef.current;
    prevNonceRef.current = focusNonce ?? 0;
    if (!isNewFocus && !nonceChanged && focusHandledRef.current) return; // already handled
    prevFocusedRef.current = focusedTaskId;

    // Only an explicit user locate action (task click, dock activate, session
    // click, quick-add) bumps focusNonce. A page-load restore (sessionStorage /
    // URL param) re-fires this effect with the nonce unchanged — it must NOT
    // switch tabs or un-collapse sections the user collapsed, or every refresh
    // would re-expand (and re-persist) them. The ref survives the task-not-in-
    // list-yet retry, where the effect re-runs with the nonce already consumed.
    if (nonceChanged) pendingLocateRef.current = true;

    const task = tasks.find((t) => t.id === focusedTaskId);
    if (!task) {
      scrollLog('focus-effect-SKIP', { taskId: focusedTaskId.substring(0, 12), reason: 'task-not-in-list' });
      return; // task not yet in list (e.g. waiting for WebSocket) — will retry when tasks update
    }
    focusHandledRef.current = true;
    const isUserLocate = pendingLocateRef.current;
    pendingLocateRef.current = false;
    // 'pinned' scope (tier quick-adds): the new card is already visible in its tier —
    // scroll the Pinned region only. Switching the TASKS tab to the capture category
    // (e.g. Personal) filtered the list below down to ~1 task and read as data loss.
    const pinnedOnly = focusScope === 'pinned';
    scrollLog('focus-effect-run', { taskId: focusedTaskId.substring(0, 12), isNewFocus, cat: task.category, proj: task.project, activeTab: activeCategory, scope: focusScope ?? 'all' });

    // Switch to the correct category tab (unless already showing All or Starred with this task visible)
    const cat = task.category || 'Uncategorized';
    if (isUserLocate && !pinnedOnly) {
      if (activeCategory !== '' && activeCategory !== cat && activeCategory !== STARRED_TAB) {
        setActiveCategory(cat);
        persistTab(cat);
        onCategoryChange?.(cat);
      } else if (activeCategory === STARRED_TAB) {
        // If task isn't visible under starred tab, switch to its category
        const isStarred = !!task.starred;
        const isCatFav = favorites?.isCategoryFavorite(cat) ?? false;
        const isProjFav = favorites?.isProjectFavorite(task.project) ?? false;
        if (!isStarred && !isCatFav && !isProjFav && !isDescendantVisibleInStarred(task)) {
          setActiveCategory(cat);
          persistTab(cat);
          onCategoryChange?.(cat);
        }
      }

      // Expand collapsed category
      if (collapsedCategories.has(cat)) {
        setCollapsedCategories((prev) => {
          const next = new Set(prev);
          next.delete(cat);
          persistSet(LS_COLLAPSED_CATS_KEY, next);
          return next;
        });
      }

      // Expand collapsed project
      const hasDistinctProject = task.project && task.project !== task.category;
      if (hasDistinctProject) {
        const projKey = `${cat}/${task.project}`;
        if (collapsedProjects.has(projKey)) {
          setCollapsedProjects((prev) => {
            const next = new Set(prev);
            next.delete(projKey);
            persistSet(LS_COLLAPSED_PROJS_KEY, next);
            return next;
          });
        }
      }

      // Expand collapsed parent if focused task is a child (temporary — not persisted,
      // so parents collapse back on page reload unless user manually expanded them)
      if (task.parent_task_id) {
        const parentTask = tasks.find((t) => t.id.startsWith(task.parent_task_id!));
        if (parentTask && !expandedParents.has(parentTask.id)) {
          setExpandedParents((prev) => {
            const next = new Set(prev);
            next.add(parentTask.id);
            // Don't persist — only manual chevron clicks save to localStorage
            return next;
          });
        }
      }
    }

    // Focus override: instead of clearing filters, temporarily inject the task
    // into the filtered list. It fades out when focus moves away.
    // Note: activeCategory is NOT checked here — tab-switching above (lines ~1682-1698)
    // already ensures the task's category is visible. Override only handles toolbar filters.
    // SYNC: these conditions must match the filter logic in the `filtered` useMemo
    const isDone = task.status === 'done';
    const wouldBeHidden =
      (isDone && !showCompleted && phaseFilter !== 'COMPLETE') ||
      (!!priorityFilter && effectivePriority(task.priority) !== priorityFilter) ||
      (!!phaseFilter && !matchesPhaseFilter(phaseFilter, task.phase)) ||
      (!!sessionFilter && task.phase !== sessionFilter) ||
      (sourceFilter !== 'all' && (task.source || 'ms-todo') !== sourceFilter) ||
      (!!dateFilter && !isDone && !matchesDateFilter(task, dateFilter, tasks)) ||
      (!!tagFilter && (!task.tags || !task.tags.includes(tagFilter)));

    if (wouldBeHidden && !pinnedOnly) {
      // Cancel any in-progress fade-out from a previous override
      if (fadingTimerRef.current) { clearTimeout(fadingTimerRef.current); fadingTimerRef.current = null; }
      fadingOverrideRef.current = null;
      focusOverrideRef.current = focusedTaskId;
      setOverrideTick(n => n + 1);
    } else if (focusOverrideRef.current) {
      // Task is visible normally — clear stale override
      focusOverrideRef.current = null;
      setOverrideTick(n => n + 1);
    }

    // If the focused task is pinned, expand the Pinned section AND its tier subgroup
    // before scrolling — a collapsed section/tier keeps the card out of the DOM, so
    // scrollToPinnedTask would silently find nothing and never jump there.
    // User-locate only: the refresh restore path must respect collapsed state.
    if (isUserLocate && pinnedTaskIds?.has(focusedTaskId)) {
      const tierKey = focusTaskIds?.has(focusedTaskId) ? 'focus'
        : waitTaskIds?.has(focusedTaskId) ? 'wait'
        : 'satellite';
      if (collapsedSections.has('pinned') || collapsedSections.has(tierKey)) {
        setCollapsedSections((prev) => {
          const next = new Set(prev);
          next.delete('pinned');
          next.delete(tierKey);
          persistSet(LS_COLLAPSED_SECTIONS_KEY, next);
          return next;
        });
      }
      // Section tabs make "unmounted" a second way the target can be missing:
      // a locate into Wait while the Focus tab is showing would scroll to nothing.
      // Switch to the task's own tier (no-op in the stacked view).
      const cur = activeSectionRef.current;
      if (cur !== 'all' && cur !== tierKey) handleSectionChange(tierKey);
    } else if (isUserLocate && !pinnedOnly && activeSectionRef.current !== 'all' && activeSectionRef.current !== 'tasks') {
      // Unpinned task located from outside (chat ref, session panel, search): it
      // only exists in the main list, so that's the tab that must be showing.
      handleSectionChange('tasks');
    }

    // Scroll to the focused task after state changes (expand/filter) have flushed to DOM.
    // scrollToTask uses double-RAF + retry to wait for React commit + browser paint.
    // pinned scope skips the main-list scroll — the tab wasn't switched, so the task
    // may not even be in the list below; only the Pinned region jump applies.
    if (!pinnedOnly) scrollToTask(focusedTaskId);
    // Also jump the top Pinned region (no-op if the task isn't pinned — the DOM
    // query simply finds nothing). Keeps the PIN row in sync with the list below.
    scrollToPinnedTask(focusedTaskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedTaskId, focusNonce, tasks, activeCategory, collapsedCategories, collapsedProjects, favorites]);

  // Auto-expand parent when a child task is created (via WS event)
  // Persist to localStorage so expansion survives page refresh (fork subtask bug fix)
  useEvent('task:created', (data) => {
    const { task } = data as { task: { parent_task_id?: string } };
    if (!task?.parent_task_id) return;
    // Resolve full parent ID (parent_task_id may be a prefix)
    const parentTask = tasks.find((t) => t.id.startsWith(task.parent_task_id!));
    if (parentTask) {
      setExpandedParents((prev) => {
        if (prev.has(parentTask.id)) return prev;
        const next = new Set(prev);
        next.add(parentTask.id);
        persistSet(LS_EXPANDED_PARENTS_KEY, next);
        return next;
      });
    }
  });

  // ── Completion grace period (3s "done, then vanish") ──
  // Declared BEFORE every task-visibility memo below (pinned tiers, Recent, the main
  // list): each of those filters drops done tasks, so they ALL must consult the grace
  // window or a completed task disappears instantly in that surface.
  // 3s still + 150ms slack so the 450ms exit animation (delay 2550ms, see
  // .todo-panel-item-vanishing) finishes BEFORE the row unmounts — otherwise the
  // fade-out is cut off mid-way and the removal still reads as a pop.
  const GRACE_MS = 3_150;
  const recentlyCompletedRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [recentTick, setRecentTick] = useState(0);

  /** True while `completed_at` is inside the grace window. Checked INLINE during
   *  render (not only via recentlyCompletedRef): the ref is populated by an effect
   *  AFTER the completion render commits, so without this the optimistic-complete
   *  render would hide the row for one frame (or forever — the memos don't re-run on
   *  ref writes). completed_at-based, so it needs no state at all. */
  const isInCompletionGrace = useCallback((t: Task): boolean => {
    if (t.status !== 'done' && t.phase !== 'COMPLETE') return false;
    if (!t.completed_at) return false;
    const elapsed = Date.now() - new Date(t.completed_at).getTime();
    return elapsed >= 0 && elapsed < GRACE_MS;
  }, []);

  /** A done task is still rendered while it's inside the grace window. */
  const keepWhileCompleting = useCallback(
    (t: Task): boolean => recentlyCompletedRef.current.has(t.id) || isInCompletionGrace(t),
    [isInCompletionGrace],
  );

  useEffect(() => {
    let added = false;
    for (const task of tasks) {
      if (task.status === 'done' && task.completed_at && !recentlyCompletedRef.current.has(task.id)) {
        const elapsed = Date.now() - new Date(task.completed_at).getTime();
        if (elapsed >= 0 && elapsed < GRACE_MS) {
          recentlyCompletedRef.current.add(task.id);
          added = true;
          const timerId = setTimeout(() => {
            recentlyCompletedRef.current.delete(task.id);
            timersRef.current.delete(task.id);
            setRecentTick((n) => n + 1);
          }, GRACE_MS - elapsed);
          timersRef.current.set(task.id, timerId);
        }
      }
    }
    // Trigger re-render so the filters re-run with the new grace entries
    if (added) setRecentTick((n) => n + 1);
    // Clean up timers for tasks that are no longer done (reopened)
    for (const [taskId, timerId] of timersRef.current) {
      const task = tasks.find((t) => t.id === taskId);
      if (!task || task.status !== 'done') {
        clearTimeout(timerId);
        timersRef.current.delete(taskId);
        recentlyCompletedRef.current.delete(taskId);
      }
    }
  }, [tasks]);

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => { for (const id of timers.values()) clearTimeout(id); };
  }, []);

  // ── Sticky pin membership during the grace window ──
  // Completing a task AUTO-UNPINS it server-side (task-manager.ts: "Auto-unpin
  // completed tasks so they don't linger in Focus Bar"), and getPinnedTasks() also
  // filters done tasks defensively. So the id leaves `pinnedTaskIds`/`focusTaskIds`
  // the moment it completes and the Focus/Satellite/Wait card is yanked out of the
  // dataset — the grace filters never even see it, which is why a completed card
  // vanished instantly from Focus while the Recent copy sat there for 3s.
  //
  // Fix: remember the pin membership each task had just BEFORE it completed, and keep
  // serving it for the length of the grace window. The server state is untouched (the
  // auto-unpin is correct); this only defers when the UI stops drawing the card.
  const lastPinStateRef = useRef<Map<string, { pinned: boolean; focus: boolean; wait: boolean }>>(new Map());
  useEffect(() => {
    for (const t of tasks) {
      // Snapshot only while OPEN — once done, the entry must stay frozen at its
      // pre-completion value (the server has already dropped it from the sets).
      if (t.status !== 'done' && t.phase !== 'COMPLETE') {
        lastPinStateRef.current.set(t.id, {
          pinned: pinnedTaskIds?.has(t.id) ?? false,
          focus: focusTaskIds?.has(t.id) ?? false,
          wait: waitTaskIds?.has(t.id) ?? false,
        });
      }
    }
  }, [tasks, pinnedTaskIds, focusTaskIds, waitTaskIds]);

  /** Pin-membership sets widened to include tasks still inside the grace window. */
  const graceUnion = useCallback((live: Set<string> | undefined, which: 'pinned' | 'focus' | 'wait'): Set<string> => {
    const out = new Set(live ?? []);
    for (const t of tasks) {
      if (!keepWhileCompleting(t)) continue;
      if (lastPinStateRef.current.get(t.id)?.[which]) out.add(t.id);
    }
    return out;
  }, [tasks, keepWhileCompleting]);

  const pinnedIdsWithGrace = useMemo(() => graceUnion(pinnedTaskIds, 'pinned'), [graceUnion, pinnedTaskIds, recentTick]);
  const focusIdsWithGrace = useMemo(() => graceUnion(focusTaskIds, 'focus'), [graceUnion, focusTaskIds, recentTick]);
  const waitIdsWithGrace = useMemo(() => graceUnion(waitTaskIds, 'wait'), [graceUnion, waitTaskIds, recentTick]);

  // Active pinned-drag id — declared BEFORE the pinned render-model memos below so
  // they can freeze on it (useFrozenWhile) while a drag is live.
  const [activeDragPinnedId, setActiveDragPinnedId] = useState<string | null>(null);
  const isPinnedDragActive = activeDragPinnedId !== null;

  // Resolve pinned task IDs to Task objects for the pinned section
  // Filter out completed tasks (status=done or phase=COMPLETE) for display, and
  // members of a HIDDEN group — hiding collapses the whole cluster out of the Focus
  // area (membership untouched; unhide via a member's kebab / the /tasks page). This
  // single filter propagates to all three tiers + clustering + drag for free.
  // FROZEN during a pinned drag: external churn must not add/remove/replace pinned
  // Task objects mid-drag (cards would remount → dnd-kit useRect loop → React #185).
  const pinnedTasksLive = useMemo(() => {
    if (pinnedIdsWithGrace.size === 0) return [];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    return [...pinnedIdsWithGrace]
      .map((id) => taskMap.get(id))
      .filter((t): t is Task => !!t
        && ((t.status !== 'done' && t.phase !== 'COMPLETE') || keepWhileCompleting(t))
        && !(t.group_id && hiddenGroups?.has(t.group_id)));
  }, [tasks, pinnedIdsWithGrace, hiddenGroups, keepWhileCompleting, recentTick]);
  const pinnedTasks = useFrozenWhile(pinnedTasksLive, isPinnedDragActive);

  // Hidden groups that HAVE pinned members — these were collapsed out of the tiers
  // above, so we surface them as a compact "hidden" strip at the bottom of the Pinned
  // section with an unhide affordance. Without this the user has no in-Focus way to
  // bring a hidden group back (its cards vanish from every tier). Each entry carries
  // the group's label + live member count (for the chip text).
  // FROZEN during a pinned drag (renders chips inside the pinned DndContext and
  // gates its mount condition — see useFrozenWhile).
  const hiddenPinnedGroupsLive = useMemo(() => {
    if (!pinnedTaskIds || pinnedTaskIds.size === 0 || !hiddenGroups || hiddenGroups.size === 0) return [];
    const counts = new Map<string, number>();
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    for (const id of pinnedTaskIds) {
      const t = taskMap.get(id);
      if (!t || t.status === 'done' || t.phase === 'COMPLETE') continue;
      if (t.group_id && hiddenGroups.has(t.group_id)) {
        counts.set(t.group_id, (counts.get(t.group_id) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([groupId, count]) => ({
      groupId,
      count,
      label: taskGroups?.[groupId] ?? 'Hidden group',
    }));
  }, [tasks, pinnedTaskIds, hiddenGroups, taskGroups]);
  const hiddenPinnedGroups = useFrozenWhile(hiddenPinnedGroupsLive, isPinnedDragActive);

  // Split pinned into Focus / Next / Satellite
  const focusTasksLocal = useMemo(() => {
    if (focusIdsWithGrace.size === 0) return [];
    return pinnedTasks.filter((t) => focusIdsWithGrace.has(t.id));
  }, [pinnedTasks, focusIdsWithGrace]);

  const satelliteTasksLocal = useMemo(() =>
    pinnedTasks.filter((t) => !focusIdsWithGrace.has(t.id) && !waitIdsWithGrace.has(t.id)),
  [pinnedTasks, focusIdsWithGrace, waitIdsWithGrace]);

  const waitTasksLocal = useMemo(() => {
    if (waitIdsWithGrace.size === 0) return [];
    return pinnedTasks.filter((t) => waitIdsWithGrace.has(t.id));
  }, [pinnedTasks, waitIdsWithGrace]);

  // Helper: resolve a task's current tier
  const getTier = useCallback((taskId: string): FocusTier | undefined => {
    if (!pinnedIdsWithGrace.has(taskId)) return undefined;
    if (focusIdsWithGrace.has(taskId)) return 'focus';
    if (waitIdsWithGrace.has(taskId)) return 'wait';
    return 'satellite';
  }, [pinnedIdsWithGrace, focusIdsWithGrace, waitIdsWithGrace]);

  // Recent tasks: an ACTIVITY FEED — every recently created/updated task pops up
  // here, INCLUDING pinned ones (they render in their tier AND here; the Recent
  // card shows a tier dot and isn't draggable — it's already placed). When "Show
  // completed" is on, recently completed tasks surface too, ranked by completion.
  // FROZEN during a pinned drag: Recent sorts by last_session_update/updated_at and
  // shares the pinned DndContext — a mid-drag re-sort moves/remounts cards and
  // feeds the useRect #185 loop. Converges to live order on drop.
  const recentTasksLive = useMemo(() => {
    // Most recent of creation / any update / session activity / completion
    const recentTime = (t: Task) => {
      let m = t.created_at ?? '';
      if (t.updated_at && t.updated_at > m) m = t.updated_at;
      if (t.last_session_update && t.last_session_update > m) m = t.last_session_update;
      if (t.completed_at && t.completed_at > m) m = t.completed_at;
      return m;
    };
    return tasks
      .filter(t => {
        const isDone = t.status === 'done' || t.phase === 'COMPLETE';
        return isDone ? (showCompleted || keepWhileCompleting(t)) : true;
      })
      .sort((a, b) => recentTime(b).localeCompare(recentTime(a)))
      .slice(0, 50);
  }, [tasks, showCompleted, keepWhileCompleting, recentTick]);
  const recentTasks = useFrozenWhile(recentTasksLive, isPinnedDragActive);

  // Stable sensor config — inline objects in useSensor destabilize dnd-kit's internal
  // memoization (Object.values({distance:5}) produces new ref each render → sensors
  // re-register on every render → cascading re-renders during drag-end transition).
  const pointerConstraint = useRef({ distance: 5 }).current;
  const pointerOpts = useMemo(() => ({ activationConstraint: pointerConstraint }), [pointerConstraint]);
  const keyboardOpts = useMemo(() => ({ coordinateGetter: sortableKeyboardCoordinates }), []);

  const sensors = useSensors(
    useSensor(PointerSensor, pointerOpts),
    useSensor(KeyboardSensor, keyboardOpts),
  );

  // Sensors for pinned section DnD (separate from main task DnD)
  const pinnedSensors = useSensors(
    useSensor(PointerSensor, pointerOpts),
    useSensor(KeyboardSensor, keyboardOpts),
  );

  const pinnedTaskIds_arr = useMemo(() => pinnedTasks.map((t) => t.id), [pinnedTasks]);

  // ── Live cross-container DnD ──
  // During drag, we maintain local overrides of tier arrays so items appear in the
  // target section in real-time. On drop we commit to the server; on cancel we revert.
  //
  // Four invariants prevent React error #185 (Maximum update depth exceeded):
  //  1. RAF-batch all setState in the drag hot path (bumpDragTick via requestAnimationFrame)
  //  2. Freeze tier refs at drag start to isolate from external task updates
  //  3. Never mutate SortableContext items for same-tier moves in onDragOver
  //     (DnD Kit handles visual reorder via CSS transforms; final position resolved in onDragEnd)
  //  4. React.memo on card components to prevent re-render cascades

  const DROP_ZONE_TIERS: Record<string, FocusTier> = { 'focus-drop-zone': 'focus', 'satellite-drop-zone': 'satellite', 'wait-drop-zone': 'wait' };

  // Local tier arrays that can be overridden during drag
  // Drag overlay arrays stored as refs (NOT state) to avoid triggering React re-renders
  // during DnD Kit's rapid onDragOver events. A single tick counter forces a re-render
  // when we explicitly want the UI to update (during over + on end).
  const dragFocusIdsRef = useRef<string[] | null>(null);
  const dragSatelliteIdsRef = useRef<string[] | null>(null);
  const dragWaitIdsRef = useRef<string[] | null>(null);
  const [, setDragTick] = useState(0);
  const dragRafRef = useRef(0);
  const bumpDragTick = useCallback(() => {
    if (dragRafRef.current) return; // already scheduled this frame
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = 0;
      setDragTick(n => n + 1);
    });
  }, []);
  // Convenience getters for the current render
  const dragFocusIds = dragFocusIdsRef.current;
  const dragSatelliteIds = dragSatelliteIdsRef.current;
  const dragWaitIds = dragWaitIdsRef.current;

  // Active arrays: use drag overrides when dragging, else the source-of-truth
  // (clustered so grouped pins sit together). MUST be memoized — .map() creates a
  // new array on every render, which makes SortableContext receive new `items` each
  // time → internal re-registration → state update → re-render → infinite loop
  // (React #185) during drag-end.
  //
  // clusterTierByGroup keeps same-group members contiguous within a tier, anchored
  // at the group's first member in the tier's current order. It mirrors the main
  // list's computeSortOrder clustering but flat (tiers have no parent/child nesting).
  // Pure + order-stable → idempotent. We do NOT cluster mid-drag (dragXxxIds present):
  // during a drag the user's live order is authority and clustering would fight it;
  // it re-applies once the drag lands.
  const focusIds_arr = useMemo(() => dragFocusIds ?? clusterTierByGroup(focusTasksLocal), [dragFocusIds, focusTasksLocal]);
  const satelliteIds_arr = useMemo(() => dragSatelliteIds ?? clusterTierByGroup(satelliteTasksLocal), [dragSatelliteIds, satelliteTasksLocal]);
  const waitIds_arr = useMemo(() => dragWaitIds ?? clusterTierByGroup(waitTasksLocal), [dragWaitIds, waitTasksLocal]);

  const pinnedTaskMap = useMemo(() => new Map(pinnedTasks.map((t) => [t.id, t])), [pinnedTasks]);

  // Snapshot of original tier arrays at drag start (for revert on cancel)
  // (activeDragPinnedId state lives above the pinned render-model memos — they
  // freeze on it via useFrozenWhile.)
  const dragStartSnapshot = useRef<{ focus: string[]; satellite: string[]; wait: string[]; recent?: string[] } | null>(null);
  const activeDragPinnedTask = useMemo(
    () => {
      if (!activeDragPinnedId || activeDragPinnedId.startsWith('group:')) return null;
      return pinnedTasks.find((t) => t.id === activeDragPinnedId)
        ?? recentTasks.find((t) => t.id === activeDragPinnedId)
        ?? null;
    },
    [activeDragPinnedId, pinnedTasks, recentTasks],
  );

  // When the active drag is a whole-group chip (`group:<gid>:<tier>`), resolve the
  // group's label + member titles so the DragOverlay can render a floating preview
  // that follows the cursor — otherwise dragging a group showed nothing under the
  // pointer and the user couldn't tell where it was going.
  const activeDragGroup = useMemo(() => {
    if (!activeDragPinnedId?.startsWith('group:')) return null;
    const gid = activeDragPinnedId.slice('group:'.length).replace(/:(focus|satellite|wait)$/, '');
    const members = pinnedTasks.filter((t) => t.group_id === gid);
    if (members.length === 0) return null;
    return { label: taskGroups?.[gid] ?? 'Group', titles: members.map((t) => t.title), count: members.length };
  }, [activeDragPinnedId, pinnedTasks, taskGroups]);

  // Recent card ids for SortableContext — must mirror SortableRecentCard's id
  // choice exactly: pinned/done cards register namespaced (static, the raw id
  // already belongs to their tier card in this DndContext), others raw.
  const recentStaticId = useCallback((t: Task) =>
    (t.status === 'done' || t.phase === 'COMPLETE' || pinnedTaskIds?.has(t.id)) ? `recent-static:${t.id}` : t.id,
  [pinnedTaskIds]);
  // Only genuinely draggable Recent ids — feeds the drag-start snapshot and
  // pinnedCardIds. A pinned task now ALSO appears in Recent; if its raw id were in
  // snap.recent, dragging its TIER card would be misrouted through the
  // "from Recent" pin+setTier path instead of the normal tier reorder.
  const recentDraggableIds = useMemo(
    () => recentTasks.filter((t) => recentStaticId(t) === t.id).map((t) => t.id),
    [recentTasks, recentStaticId],
  );

  // Set of every real task card id in the pinned area (pinned tiers + Recent).
  // The pinned DnD handlers use this to tell a real card apart from a tier
  // drop-zone id ("tier-*"). MUST be declared before the handlePinned* callbacks:
  // a callback's deps array is evaluated synchronously at render time, so
  // referencing the main-list `taskGroupMap` (declared far below) from there would
  // hit its temporal dead zone and crash the whole panel on first render. It's also
  // more correct here — `taskGroupMap` is the filtered main-list grouping, so a
  // pinned task hidden by an active filter would be missing from it.
  const pinnedCardIds = useMemo(
    () => new Set<string>([...pinnedTaskIds_arr, ...recentDraggableIds]),
    [pinnedTaskIds_arr, recentDraggableIds],
  );

  // Stable fallback for onSetPhase — avoids creating a new arrow function every render
  // which would defeat React.memo on SortableTierCard and other memoized task items.
  // Signature matches onSetPhase (id, phase) but only forwards id to onComplete.
  const setPhaseOrComplete = useCallback(
    (id: string, _phase: string) => onSetPhase ? onSetPhase(id, _phase) : onComplete(id),
    [onSetPhase, onComplete],
  );

  const handlePinnedDragStart = useCallback((event: DragStartEvent) => {
    // Freeze the CLUSTERED order (what's on screen) — not the raw pin order — so the
    // frozen refs match the rendered list and grouped members sit contiguously (a
    // prerequisite for the collapse below).
    const fArr = clusterTierByGroup(focusTasksLocal);
    const sArr = clusterTierByGroup(satelliteTasksLocal);
    const wArr = clusterTierByGroup(waitTasksLocal);
    const rArr = recentDraggableIds;
    dragStartSnapshot.current = { focus: fArr, satellite: sArr, wait: wArr, recent: rArr };
    // Freeze tier state — SortableContext items won't change from external events during drag
    dragFocusIdsRef.current = fArr;
    dragSatelliteIdsRef.current = sArr;
    dragWaitIdsRef.current = wArr;
    const activeId = event.active.id as string;

    // ── Collapse-on-drag ── When a whole group is grabbed (`group:<gid>:<tier>`),
    // replace that group's member run in the frozen refs with a SINGLE sentinel id
    // (the chip's id). The group then behaves as one atomic sortable unit: the
    // strategy gives the sentinel a real activeIndex, so sibling cards push away and
    // an empty slot opens — exactly like dragging a task. Members are hidden for the
    // duration (renderTierItems draws the chip for the sentinel) and restored on end.
    collapsedGroupRef.current = null;
    if (activeId.startsWith('group:')) {
      const gid = activeId.slice('group:'.length).replace(/:(focus|satellite|wait)$/, '');
      // Members in on-screen order (focus → satellite → wait) so the restored block
      // preserves how the user saw them.
      const orderedMembers = [...fArr, ...sArr, ...wArr].filter((id) => pinnedTaskMap.get(id)?.group_id === gid);
      if (orderedMembers.length > 0) {
        const memberSet = new Set(orderedMembers);
        const collapse = (arr: string[]): string[] => {
          const out: string[] = [];
          let placed = false;
          for (const id of arr) {
            if (memberSet.has(id)) {
              // Drop the members; drop the sentinel in at the FIRST member's slot only.
              if (!placed) { out.push(activeId); placed = true; }
            } else {
              out.push(id);
            }
          }
          return out;
        };
        dragFocusIdsRef.current = collapse(fArr);
        dragSatelliteIdsRef.current = collapse(sArr);
        dragWaitIdsRef.current = collapse(wArr);
        collapsedGroupRef.current = { sentinel: activeId, gid, members: orderedMembers };
      }
    }

    setActiveDragPinnedId(activeId);
    // Track the live cursor so dragOver/End can highlight "join group" when hovering
    // a card (Pin tiers have no subtasks → the whole card is the group zone).
    window.addEventListener('pointermove', trackPointer, { passive: true });
    dropIntentRef.current = null;
    setGroupTargetId(null);
  }, [focusTasksLocal, satelliteTasksLocal, waitTasksLocal, recentDraggableIds, pinnedTaskMap]);

  // Live movement: when hovering over a different tier, move item between arrays
  // Also handles items dragged FROM Recent into a tier zone
  const handlePinnedDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeId = active.id as string;
    const overId = over.id as string;

    // Whole-group drag (chip grip): the active id is the `group:<gid>:<tier>` sentinel,
    // now a real sortable unit in the tier refs (collapsed at drag start). Same-tier
    // reordering is handled automatically by verticalListSortingStrategy (siblings
    // shift, an empty slot opens — just like a task). Here we only move the sentinel
    // BETWEEN tiers so the slot opens in the hovered tier. Never light a per-card
    // "join group" target for a group drag. Clear any stale single-card highlight.
    if (activeId.startsWith('group:')) {
      if (dropIntentRef.current !== null) { dropIntentRef.current = null; setGroupTargetId((prev) => (prev === null ? prev : null)); }
      const snap = dragStartSnapshot.current;
      if (!snap) return;
      // Target tier from the hovered drop-zone or the tier the over-card lives in now.
      const targetTier: FocusTier | undefined = DROP_ZONE_TIERS[overId]
        ?? ((dragFocusIdsRef.current ?? snap.focus).includes(overId) ? 'focus' : undefined)
        ?? ((dragSatelliteIdsRef.current ?? snap.satellite).includes(overId) ? 'satellite' : undefined)
        ?? ((dragWaitIdsRef.current ?? snap.wait).includes(overId) ? 'wait' : undefined);
      if (!targetTier || activeId === overId) return;
      const currentTier: FocusTier =
        (dragFocusIdsRef.current ?? snap.focus).includes(activeId) ? 'focus' :
        (dragWaitIdsRef.current ?? snap.wait).includes(activeId) ? 'wait' : 'satellite';
      if (currentTier === targetTier) return; // same tier — strategy handles the visual
      const getArr = (t: FocusTier) => t === 'focus' ? (dragFocusIdsRef.current ?? snap.focus) : t === 'wait' ? (dragWaitIdsRef.current ?? snap.wait) : (dragSatelliteIdsRef.current ?? snap.satellite);
      const setArr = (t: FocusTier, v: string[]) => { if (t === 'focus') dragFocusIdsRef.current = v; else if (t === 'wait') dragWaitIdsRef.current = v; else dragSatelliteIdsRef.current = v; };
      const addAt = (arr: string[], ovId: string) => {
        const idx = arr.indexOf(ovId);
        if (idx === -1) return [...arr, activeId];
        const copy = [...arr];
        copy.splice(idx, 0, activeId);
        return copy;
      };
      setArr(currentTier, getArr(currentTier).filter((id) => id !== activeId));
      setArr(targetTier, addAt(getArr(targetTier), overId));
      bumpDragTick();
      return;
    }

    // Skip when hovering over the dragged item itself — its tier is determined
    // by where we already placed it, not by where it was at drag start.
    // Without this guard, the frozen snapshot says the item belongs to its
    // original tier, causing it to be moved back → collision recalculates →
    // oscillation → React #185 (infinite re-render loop).
    if (activeId === overId) return;

    const snap = dragStartSnapshot.current;
    if (!snap) return;

    // Check if this item came from Recent
    const isFromRecent = snap.recent?.includes(activeId) ?? false;

    // Drop-into-group highlight: hovering another task card (drop zones have ids like
    // "tier-*", real cards are task ids in pinnedCardIds) lights it as a group target.
    // Pin tiers have no subtasks, so the WHOLE card is the group zone (no left/right
    // split). Dedupe via dropIntentRef so we don't churn state every dragOver tick.
    // GROUPED-MEMBER EXEMPTION: if the dragged card is ALREADY in a group, NEVER light
    // the group target. A grouped member has two valid outcomes only: drop on a
    // neighbor → reorder; drop elsewhere → pull OUT (handled at drag end). Lighting
    // "join group" here caused the reported bug — groupTasks() ABSORBS, so grouping a
    // member with an outside card merged its whole group + the target into a new group
    // instead of just popping the member out.
    const activeGroupId = tasks.find((t) => t.id === activeId)?.group_id;
    if (overId !== activeId && pinnedCardIds.has(overId) && !activeGroupId) {
      const key = `${overId}:group`;
      if (dropIntentRef.current !== key) {
        dropIntentRef.current = key;
        setGroupTargetId(overId);
      }
    } else if (dropIntentRef.current !== null) {
      dropIntentRef.current = null;
      setGroupTargetId((prev) => (prev === null ? prev : null));
    }

    // Determine target tier from drop zone or the CURRENT position of the over-card.
    // Use drag refs (live state during drag) with snapshot as fallback.
    // IMPORTANT: only check drag refs, not raw snapshot, for non-drop-zone items —
    // the snapshot is frozen at drag start and doesn't reflect cross-tier moves.
    const targetTier = DROP_ZONE_TIERS[overId]
      ?? ((dragFocusIdsRef.current ?? snap.focus).includes(overId) ? 'focus' : undefined)
      ?? ((dragSatelliteIdsRef.current ?? snap.satellite).includes(overId) ? 'satellite' : undefined)
      ?? ((dragWaitIdsRef.current ?? snap.wait).includes(overId) ? 'wait' : undefined);
    if (!targetTier) return;

    // For items from Recent: check if already placed in a tier during this drag
    if (isFromRecent) {
      const getRef = (tier: FocusTier) => tier === 'focus' ? (dragFocusIdsRef.current ?? snap.focus) : tier === 'wait' ? (dragWaitIdsRef.current ?? snap.wait) : (dragSatelliteIdsRef.current ?? snap.satellite);
      const setRef = (tier: FocusTier, val: string[]) => { if (tier === 'focus') dragFocusIdsRef.current = val; else if (tier === 'wait') dragWaitIdsRef.current = val; else dragSatelliteIdsRef.current = val; };
      const currentPlacement =
        getRef('focus').includes(activeId) ? 'focus' as FocusTier :
        getRef('wait').includes(activeId) ? 'wait' as FocusTier :
        getRef('satellite').includes(activeId) ? 'satellite' as FocusTier : null;
      if (currentPlacement === targetTier) return;
      const remove = (arr: string[]) => arr.filter((id) => id !== activeId);
      if (currentPlacement) {
        setRef(currentPlacement, remove(getRef(currentPlacement)));
      }
      const targetArr = getRef(targetTier);
      setRef(targetTier, [...remove(targetArr), activeId]);
      bumpDragTick();
      return;
    }

    // Existing pinned-to-pinned cross-tier logic
    // Read directly from refs (live drag state) rather than memoized arrays that close
    // over render-time values. With RAF batching, refs can be mutated multiple times
    // between renders; reading stale tier data would duplicate the item across two
    // tier arrays.
    const currentTier: FocusTier =
      (dragFocusIdsRef.current ?? snap.focus).includes(activeId) ? 'focus' :
      (dragWaitIdsRef.current ?? snap.wait).includes(activeId) ? 'wait' : 'satellite';
    // Same tier — skip (invariant #3: never mutate SortableContext items for same-tier
    // reorders in onDragOver). DnD Kit handles visual reorder via CSS transforms;
    // final position is resolved in handlePinnedDragEnd using the `over` target.
    // Mutating items here would cause SortableContext to re-register → setState → re-render
    // loop → React #185.
    if (currentTier === targetTier) return;

    // Move activeId from current to target tier arrays
    const remove = (arr: string[]) => arr.filter((id) => id !== activeId);
    const addAt = (arr: string[], ovId: string) => {
      const idx = arr.indexOf(ovId);
      if (idx === -1) return [...arr, activeId];
      const copy = [...arr];
      copy.splice(idx, 0, activeId);
      return copy;
    };

    const getArr = (tier: FocusTier) => tier === 'focus' ? (dragFocusIdsRef.current ?? snap.focus) : tier === 'wait' ? (dragWaitIdsRef.current ?? snap.wait) : (dragSatelliteIdsRef.current ?? snap.satellite);
    const setArr = (tier: FocusTier, val: string[]) => { if (tier === 'focus') dragFocusIdsRef.current = val; else if (tier === 'wait') dragWaitIdsRef.current = val; else dragSatelliteIdsRef.current = val; };

    setArr(currentTier, remove(getArr(currentTier)));
    setArr(targetTier, addAt(getArr(targetTier), overId));
    bumpDragTick(); // trigger visual update
  }, [bumpDragTick, pinnedCardIds, tasks]);

  const clearDragState = useCallback(() => {
    if (dragRafRef.current) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = 0; }
    dragFocusIdsRef.current = null;
    dragSatelliteIdsRef.current = null;
    dragWaitIdsRef.current = null;
    dragStartSnapshot.current = null;
    collapsedGroupRef.current = null;
    setActiveDragPinnedId(null);
    // Tear down the drop-intent highlight + live-pointer listener started in
    // handlePinnedDragStart.
    window.removeEventListener('pointermove', trackPointer);
    dropIntentRef.current = null;
    setGroupTargetId((prev) => (prev === null ? prev : null));
  }, []);

  const handlePinnedDragCancel = useCallback(() => {
    clearDragState();
  }, [clearDragState]);

  const handlePinnedDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    const snap = dragStartSnapshot.current;

    // Capture live tier positions BEFORE clearing — handlePinnedDragOver may have
    // moved the active item cross-tier during drag. We need these to persist the
    // final position when dnd-kit reports over === active (common after cross-tier
    // moves, since the dragged card's center follows the pointer).
    const liveFocus = dragFocusIdsRef.current;
    const liveSatellite = dragSatelliteIdsRef.current;
    const liveWait = dragWaitIdsRef.current;
    const collapsed = collapsedGroupRef.current;

    clearDragState();

    if (!over || !snap) return;
    const activeId = active.id as string;
    const overId = over.id as string;

    // ── Whole-group drag (chip grip) ── The active id is the `group:<gid>:<tier>`
    // sentinel that stood in for the collapsed cluster. Its FINAL tier is simply the
    // tier ref that now holds it (dragOver moved it cross-tier; same-tier position was
    // reflected by the strategy's slot). Expand the sentinel back to the ordered
    // members at its landing spot, retier any member whose tier changed, and persist.
    if (activeId.startsWith('group:')) {
      if (!collapsed || collapsed.members.length === 0) return;
      const orderedMembers = collapsed.members;
      const memberSet = new Set(orderedMembers);

      // The sentinel's final tier = whichever live ref contains it.
      const overTier: FocusTier =
        (liveFocus ?? snap.focus).includes(activeId) ? 'focus' :
        (liveWait ?? snap.wait).includes(activeId) ? 'wait' : 'satellite';

      // Live global order (sentinel present once, members already collapsed out).
      const liveGlobal = [...(liveFocus ?? snap.focus), ...(liveSatellite ?? snap.satellite), ...(liveWait ?? snap.wait)];

      // Same-tier drop onto a real card: reposition the sentinel just before that card
      // (mirrors the task same-tier reorder). Drop-zone or self → keep dragOver's spot.
      let ordered = liveGlobal;
      if (overId !== activeId && !DROP_ZONE_TIERS[overId] && !memberSet.has(overId) && liveGlobal.includes(overId)) {
        ordered = liveGlobal.filter((id) => id !== activeId);
        ordered.splice(ordered.indexOf(overId), 0, activeId);
      }

      // Retier members whose ORIGINAL tier differs from the drop tier.
      for (const mid of orderedMembers) {
        const cur: FocusTier = snap.focus.includes(mid) ? 'focus' : snap.wait.includes(mid) ? 'wait' : 'satellite';
        if (cur !== overTier) onSetTier?.(mid, overTier);
      }

      // Expand: swap the sentinel for the ordered member block; drop any stray member.
      const newOrder = ordered.flatMap((id) => id === activeId ? orderedMembers : (memberSet.has(id) ? [] : [id]));
      onReorderPinned?.(newOrder);
      return;
    }

    // Check if item came from Recent section
    const isFromRecent = snap.recent?.includes(activeId) ?? false;

    // ── Drag-into-group ── A drop onto ANOTHER task card (not a tier drop-zone)
    // means "group these together" — the whole card is the group zone in the pinned
    // area (no subtasks here). If the target is already in a group, join it; else
    // create a new group from the two. Takes precedence over tier-move/reorder
    // (those still apply for drops onto a tier drop-zone). A task from Recent is
    // pinned to the target's tier first so it shows up inside the cluster.
    // GUARD: only an UNGROUPED active card can join here. If the dragged card is
    // already in a group, dropping it on an outside card must NOT group-merge (that
    // ABSORBED the member's whole group + the target — the reported bug); instead it
    // falls through to the drag-OUT logic below, which pops just this member out.
    if (activeId !== overId && pinnedCardIds.has(overId)) {
      const overTask = tasks.find((t) => t.id === overId);
      const activeTask = tasks.find((t) => t.id === activeId);
      if (overTask && activeTask && !activeTask.group_id && activeTask.group_id !== overTask.group_id) {
        if (isFromRecent) {
          const overTier: FocusTier =
            (liveFocus ?? snap.focus).includes(overId) ? 'focus' :
            (liveWait ?? snap.wait).includes(overId) ? 'wait' : 'satellite';
          onPinTask?.(activeId);
          setTimeout(() => onSetTier?.(activeId, overTier), 100);
        }
        if (overTask.group_id && onAddToGroup) {
          onAddToGroup(overTask.group_id, [activeId]);
          return;
        }
        if (!overTask.group_id && onGroupTasks) {
          onGroupTasks([overTask.id, activeId]);
          return;
        }
      }
    }

    // ── Drag OUT of a group (pinned area) ── The dragged card is a group member and
    // this drop is NOT a "join group" (those return above), i.e. it landed on a tier
    // drop-zone, empty space, or a card in a DIFFERENT group (same-group hovers are
    // exempted in dragOver so they never light the target). Pull it out of its
    // cluster, then FALL THROUGH to the tier-move / reorder logic so it also lands
    // where it was dropped. Mirrors the Main list's drag-out.
    if (onUngroupTask && !isFromRecent) {
      const activeTask = tasks.find((t) => t.id === activeId);
      const overTask = tasks.find((t) => t.id === overId);
      if (activeTask?.group_id && activeTask.group_id !== overTask?.group_id) {
        onUngroupTask(activeId);
        // fall through — the tier-move / reorder logic below repositions it
      }
    }

    // Build global pinned order from live tier refs, optionally adjusting the
    // active item's position within a tier to match the final drop target.
    const buildOrderFromRefs = (adjustInTier?: FocusTier) => {
      const focus = [...(liveFocus ?? snap.focus)];
      const satellite = [...(liveSatellite ?? snap.satellite)];
      const wait = [...(liveWait ?? snap.wait)];
      if (adjustInTier && activeId !== overId) {
        const arr = adjustInTier === 'focus' ? focus : adjustInTier === 'wait' ? wait : satellite;
        const ai = arr.indexOf(activeId);
        const oi = arr.indexOf(overId);
        if (ai !== -1 && oi !== -1 && ai !== oi) {
          arr.splice(ai, 1);
          arr.splice(oi, 0, activeId);
        }
      }
      return [...focus, ...satellite, ...wait];
    };

    // When over === active, collision detected the dragged card itself (its center
    // follows the pointer). handlePinnedDragOver may have moved it cross-tier —
    // check live refs to persist that move.
    if (activeId === overId) {
      const currentTier: FocusTier | undefined =
        (liveFocus ?? snap.focus).includes(activeId) ? 'focus' :
        (liveWait ?? snap.wait).includes(activeId) ? 'wait' :
        (liveSatellite ?? snap.satellite).includes(activeId) ? 'satellite' : undefined;
      if (isFromRecent) {
        if (currentTier) {
          const order = buildOrderFromRefs();
          onPinTask?.(activeId);
          setTimeout(() => onSetTier?.(activeId, currentTier, order), 100);
        }
      } else {
        const origTier: FocusTier = snap.focus.includes(activeId) ? 'focus' : snap.wait.includes(activeId) ? 'wait' : 'satellite';
        if (currentTier && origTier !== currentTier) {
          onSetTier?.(activeId, currentTier, buildOrderFromRefs());
        }
      }
      return;
    }

    if (isFromRecent) {
      // Determine target tier from drop zone or card
      const targetTier = DROP_ZONE_TIERS[overId]
        ?? (snap.focus.includes(overId) ? 'focus' : undefined)
        ?? (snap.satellite.includes(overId) ? 'satellite' : undefined)
        ?? (snap.wait.includes(overId) ? 'wait' : undefined);
      if (!targetTier) return;
      // Pin first, then set tier. setFocusTier requires task.pinned===true in the
      // store, so we delay to let the pin write complete before changing tier.
      const order = buildOrderFromRefs();
      onPinTask?.(activeId);
      setTimeout(() => onSetTier?.(activeId, targetTier, order), 100);
      return;
    }

    // Existing pinned-to-pinned logic
    const origTier: FocusTier = snap.focus.includes(activeId) ? 'focus' : snap.wait.includes(activeId) ? 'wait' : 'satellite';
    const targetTier = DROP_ZONE_TIERS[overId]
      ?? (snap.focus.includes(overId) ? 'focus' : undefined)
      ?? (snap.wait.includes(overId) ? 'wait' : undefined)
      ?? 'satellite';

    if (origTier !== targetTier) {
      onSetTier?.(activeId, targetTier, buildOrderFromRefs(targetTier));
      return;
    }

    // Same-container reorder. DnD Kit exposes the rendered subset; replace only
    // those slots so a filter cannot silently move hidden pins.
    const visibleIds = (active.data.current?.sortable as { items?: string[] } | undefined)?.items;
    if (!visibleIds) return;
    const oldIndex = visibleIds.indexOf(activeId);
    const newIndex = visibleIds.indexOf(overId);
    if (oldIndex === -1 || newIndex === -1) return;
    const reorderedVisible = [...visibleIds];
    reorderedVisible.splice(oldIndex, 1);
    reorderedVisible.splice(newIndex, 0, activeId);

    const completeTier = origTier === 'focus'
      ? snap.focus
      : origTier === 'wait'
        ? snap.wait
        : snap.satellite;
    const visibleSet = new Set(visibleIds);
    let visibleIndex = 0;
    const reorderedTier = completeTier.map((id) =>
      visibleSet.has(id) ? reorderedVisible[visibleIndex++] : id
    );
    const newOrder = [
      ...(origTier === 'focus' ? reorderedTier : snap.focus),
      ...(origTier === 'satellite' ? reorderedTier : snap.satellite),
      ...(origTier === 'wait' ? reorderedTier : snap.wait),
    ];
    onReorderPinned?.(newOrder);
  }, [pinnedTaskIds_arr, onReorderPinned, onSetTier, onPinTask, clearDragState, onAddToGroup, onGroupTasks, onUngroupTask, pinnedCardIds, tasks]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.category) set.add(t.category);
    const names = Array.from(set);
    return orderedSort(names, ordering?.categoryOrder ?? []);
  }, [tasks, ordering?.categoryOrder]);



  // Show starred tab when there are starred tasks or favorited categories/projects
  const hasStarredContent = useMemo(() => {
    const hasStarredTasks = tasks.some((t) => t.starred);
    const hasFavorites = favorites?.hasFavorites ?? false;
    return hasStarredTasks || hasFavorites;
  }, [tasks, favorites?.hasFavorites]);

  // Category counts for ViewDropdown
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) {
      if (t.status !== 'done' || showCompleted) {
        const cat = t.category || 'Uncategorized';
        counts[cat] = (counts[cat] ?? 0) + 1;
      }
    }
    return counts;
  }, [tasks, showCompleted]);

  // Available tags for ViewDropdown
  const availableTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const t of tasks) {
      if (t.tags) for (const tag of t.tags) tagSet.add(tag);
    }
    return Array.from(tagSet).sort();
  }, [tasks]);

  // Helper: check if a task is visible in starred view via its ancestor chain.
  // Walks up parent_task_id links (max 10 depth) checking if any ancestor is starred
  // or belongs to a favorited category/project.
  const isDescendantVisibleInStarred = useCallback((t: Task): boolean => {
    if (!t.parent_task_id) return false;
    const parent = tasks.find(p => p.id.startsWith(t.parent_task_id!));
    if (!parent) return false;
    if (parent.starred) return true;
    if (favorites?.isCategoryFavorite(parent.category)) return true;
    if (favorites?.isProjectFavorite(parent.project)) return true;
    return isDescendantVisibleInStarred(parent);
  }, [tasks, favorites]);

  const filtered = useMemo(() => {
    // First pass: apply all filters to get directly-matching tasks
    // SYNC: keep in sync with wouldBeHidden in focus effect
    const directList = tasks.filter((t) => {
      // Focus override: always include the focused/fading task regardless of filters
      if (focusOverrideRef.current === t.id || fadingOverrideRef.current === t.id) return true;

      if (!showCompleted && t.status === 'done' && phaseFilter !== 'COMPLETE') {
        // Keep recently-completed tasks visible for the grace period (visual feedback
        // + exit animation) before hiding them.
        if (!keepWhileCompleting(t)) return false;
      }
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (phaseFilter && !matchesPhaseFilter(phaseFilter, t.phase)) return false;
      if (sessionFilter) {
        if (t.phase !== sessionFilter) return false;
      }

      // Source/provider filter (treat undefined as 'ms-todo')
      if (sourceFilter !== 'all') {
        const taskSource = t.source || 'ms-todo';
        if (taskSource !== sourceFilter) return false;
      }

      // Tag filter
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;

      // Date filter (skip for completed tasks — they don't need date filtering)
      // Child tasks inherit parent's due_date if they have none.
      if (dateFilter && t.status !== 'done' && !matchesDateFilter(t, dateFilter, tasks)) return false;

      // Starred tab: show starred tasks + tasks in favorited categories/projects
      // Also include children of starred parents (handles prefix parent_task_id)
      if (activeCategory === STARRED_TAB) {
        const isStarred = !!t.starred;
        const isCatFavorite = favorites?.isCategoryFavorite(t.category) ?? false;
        const isProjFavorite = favorites?.isProjectFavorite(t.project) ?? false;
        return isStarred || isCatFavorite || isProjFavorite || isDescendantVisibleInStarred(t);
      }

      if (activeCategory && t.category !== activeCategory) return false;
      return true;
    });
    // Build included-ID set from first pass results
    const directlyMatched = new Set<string>(directList.map(t => t.id));

    // Second pass (iterative): include child tasks at any depth whose ancestor passed
    // the first-pass filter. Category and other filters are relaxed for children —
    // only the completed-hiding rule is enforced. Repeat until no new tasks are added
    // so that grandchildren (and deeper) are also included.
    const result = [...directList];
    let added = true;
    while (added) {
      added = false;
      for (const t of tasks) {
        if (directlyMatched.has(t.id)) continue; // already included
        if (!t.parent_task_id) continue; // not a child task
        // Respect completed filter even for children (but keep recently-completed visible)
        if (!showCompleted && t.status === 'done' && phaseFilter !== 'COMPLETE' && !keepWhileCompleting(t)) continue;
        // parent_task_id uses a prefix convention: check if any visible task's id
        // starts with this task's parent_task_id (handles composite/prefixed IDs)
        const parentVisible = result.some(p => p.id.startsWith(t.parent_task_id!));
        if (parentVisible) {
          result.push(t);
          directlyMatched.add(t.id);
          added = true;
        }
      }
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isDescendantVisibleInStarred is stable (useCallback); focusOverrideRef/fadingOverrideRef read via _overrideTick
  }, [tasks, showCompleted, priorityFilter, phaseFilter, sessionFilter, sourceFilter, tagFilter, dateFilter, _tick, _overrideTick, recentTick, activeCategory, favorites, isDescendantVisibleInStarred]);

  // Whether a completed task will actually disappear after the grace period —
  // mirrors the visibility filter (`isDone && !showCompleted && phaseFilter !== 'COMPLETE'`).
  // Drives the exit animation: only play fade+collapse when the item WILL be removed.
  // Search mode keeps completed tasks visible, so no exit animation there either
  // (otherwise the row fades out then pops back when the grace timer clears).
  const completedWillHide = !showCompleted && phaseFilter !== 'COMPLETE' && !isSearchMode;

  const filterOverrideId = focusOverrideRef.current;
  const fadingOverrideId = fadingOverrideRef.current;
  const overrideReasonTaskId = filterOverrideId || fadingOverrideId;

  // Compute descriptive reason for focus-override badge (e.g. "outside Now filter").
  // Only computed for the single override task (at most one at a time), not per-task.
  const filterOverrideReason = useMemo(() => {
    if (!overrideReasonTaskId) return undefined;
    const task = tasks.find(t => t.id === overrideReasonTaskId);
    if (!task) return undefined;
    const reasons: string[] = [];
    const isDone = task.status === 'done';
    if (isDone && !showCompleted && phaseFilter !== 'COMPLETE') reasons.push('hidden by completed filter');
    if (priorityFilter && effectivePriority(task.priority) !== priorityFilter) reasons.push(`priority ≠ ${priorityFilter}`);
    if (phaseFilter && !matchesPhaseFilter(phaseFilter, task.phase)) reasons.push(`phase ≠ ${phaseFilter}`);
    if (sessionFilter && task.phase !== sessionFilter) reasons.push(`session ≠ ${sessionFilter}`);
    if (sourceFilter !== 'all' && (task.source || 'ms-todo') !== sourceFilter) reasons.push(`source ≠ ${sourceFilter}`);
    if (dateFilter && !isDone && !matchesDateFilter(task, dateFilter, tasks)) reasons.push(`outside "${DATE_LABELS[dateFilter] || dateFilter}" date filter`);
    if (tagFilter && (!task.tags || !task.tags.includes(tagFilter))) reasons.push(`missing tag "${tagFilter}"`);
    return reasons.length > 0 ? reasons.join(' · ') : undefined;
  }, [overrideReasonTaskId, tasks, showCompleted, phaseFilter, priorityFilter, sessionFilter, sourceFilter, dateFilter, tagFilter]);

  // Explicit toolbar filters ONLY (priority, phase, session, source, tag, date) —
  // deliberately excludes the category and Starred tabs, which are navigation
  // affordances rather than refinement choices. Used by both search (which spans
  // all categories) and the Pinned/Recent visibility set below, so a pin/recent
  // card is never hidden merely because the user navigated to a different category
  // tab — pins are a cross-category focus view by design.
  const passesExplicitFilters = useCallback((t: Task): boolean => {
    if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
    if (phaseFilter && !matchesPhaseFilter(phaseFilter, t.phase)) return false;
    if (sessionFilter && t.phase !== sessionFilter) return false;
    if (sourceFilter !== 'all' && (t.source || 'ms-todo') !== sourceFilter) return false;
    if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
    if (dateFilter && t.status !== 'done' && !matchesDateFilter(t, dateFilter, tasks)) return false;
    return true;
  }, [priorityFilter, phaseFilter, sessionFilter, sourceFilter, tagFilter, dateFilter, tasks]);

  // --- Search filtering: intersect search results with active filters ---
  // Search bypasses category tab so results span ALL categories (the whole
  // point of search is to find things you can't see in the current view).
  // Explicit toolbar filters (priority, phase, source, tag, session, date) are
  // still respected because the user toggled those intentionally.
  const searchMatches = useMemo(() => {
    if (!isSearchMode) return filtered;

    // In search mode always show completed tasks (the user is explicitly searching)
    // — passesExplicitFilters intentionally omits showCompleted for that reason.
    const eligibleTasks = tasks.filter(passesExplicitFilters);
    const lowerQuery = searchQuery.trim().toLowerCase();
    // Keep the urgent pass on small metadata fields; descriptions and summaries can
    // contain enough text to block an input frame across a large task collection.
    const metadataMatches = eligibleTasks.filter((t) =>
      t.title.toLowerCase().includes(lowerQuery) ||
      t.category.toLowerCase().includes(lowerQuery) ||
      t.project.toLowerCase().includes(lowerQuery) ||
      (t.tags && t.tags.some(tag => tag.toLowerCase().includes(lowerQuery)))
    );

    if (!searchResults) {
      const metadataTaskIds = new Set(metadataMatches.map((task) => task.id));
      return [
        ...metadataMatches,
        ...eligibleTasks.filter((task) =>
          !metadataTaskIds.has(task.id)
          && taskReferenceMatchField(task, searchQuery) !== null
        ),
      ];
    }

    // Direct metadata matches (literal substring of what the user typed) rank BEFORE
    // the semantic pass: the search service caps its global candidate pool before these
    // client-only filters run, so an appended exact-title hit could land past the
    // slice(0,40) render cap and never mount. Metadata-first also matches the
    // no-server fallback above, so arriving semantic results refine the tail instead
    // of reshuffling the head. Reference ownership remains server-authoritative
    // because local session fields can be stale.
    const serverMatches = mapServerTaskSearchResults(
      eligibleTasks,
      searchResults.map((result) => result.taskId),
    );
    const metadataTaskIds = new Set(metadataMatches.map((task) => task.id));
    return [
      ...metadataMatches,
      ...serverMatches.filter((task) => !metadataTaskIds.has(task.id)),
    ];
  }, [tasks, filtered, isSearchMode, searchQuery, searchResults, passesExplicitFilters]);

  // Counts and cross-section visibility use the complete match set, but the main
  // list mounts a bounded number of rows so neither search phase can stall typing.
  const searchFiltered = useMemo(
    () => searchMatches.slice(0, 40),
    [searchMatches],
  );

  // Count of search results (for display)
  const searchResultCount = isSearchMode ? searchMatches.length : null;

  // Pinned membership and ordering stay based on the complete tier arrays. Filters only
  // constrain the rendered IDs so hidden cards keep their stable pin position.
  //
  // Crucially, the NON-search set here applies ONLY the explicit toolbar filters
  // (passesExplicitFilters) and NOT the category tab — Pinned/Recent are a
  // cross-category focus view: pinning a task means "keep this in front of me no
  // matter which category tab I'm on". Reusing `filtered` (which scopes to
  // activeCategory) would make pins/recent vanish whenever the user navigated off
  // the "All" tab, then reappear on search (which already bypasses the tab). The
  // main task list below still uses `filtered`/`searchFiltered` and stays tab-scoped.
  // FROZEN during a pinned drag: this membership set derives from the live
  // `tasks` array, so external churn (WS echoes / refetches) would otherwise
  // change the SortableContext items / remount cards mid-drag (→ React #185 via
  // dnd-kit useRect). Tier ORDER is separately frozen by the drag refs
  // (dragFocusIdsRef etc.) — freezing membership here completes the invariant.
  const visibleTaskIdsLive = useMemo(
    () => new Set(
      (isSearchMode ? searchMatches : tasks.filter(passesExplicitFilters)).map((task) => task.id),
    ),
    [tasks, isSearchMode, searchMatches, passesExplicitFilters],
  );
  const visibleTaskIds = useFrozenWhile(visibleTaskIdsLive, isPinnedDragActive);
  const visiblePinnedTasks = useMemo(
    () => pinnedTasks.filter((task) => visibleTaskIds.has(task.id)),
    [pinnedTasks, visibleTaskIds],
  );
  const visibleRecentTasks = useMemo(
    () => recentTasks.filter((task) => visibleTaskIds.has(task.id)),
    [recentTasks, visibleTaskIds],
  );
  const visibleRecentIds = useMemo(
    () => visibleRecentTasks.map(recentStaticId),
    [recentStaticId, visibleRecentTasks],
  );
  const visibleFocusIds = useMemo(
    () => focusIds_arr.filter((id) => id.startsWith('group:') || visibleTaskIds.has(id)),
    [focusIds_arr, visibleTaskIds],
  );
  const visibleSatelliteIds = useMemo(
    () => satelliteIds_arr.filter((id) => id.startsWith('group:') || visibleTaskIds.has(id)),
    [satelliteIds_arr, visibleTaskIds],
  );
  const visibleWaitIds = useMemo(
    () => waitIds_arr.filter((id) => id.startsWith('group:') || visibleTaskIds.has(id)),
    [waitIds_arr, visibleTaskIds],
  );
  const focusTasksDisplay = useMemo(
    () => visibleFocusIds.map((id) => pinnedTaskMap.get(id)).filter((task): task is Task => !!task),
    [pinnedTaskMap, visibleFocusIds],
  );
  const satelliteTasksDisplay = useMemo(
    () => visibleSatelliteIds.map((id) => pinnedTaskMap.get(id)).filter((task): task is Task => !!task),
    [pinnedTaskMap, visibleSatelliteIds],
  );
  const waitTasksDisplay = useMemo(
    () => visibleWaitIds.map((id) => pinnedTaskMap.get(id)).filter((task): task is Task => !!task),
    [pinnedTaskMap, visibleWaitIds],
  );
  const focusGroupMeta = useMemo(
    () => buildTierGroupMeta(focusTasksDisplay, taskGroups),
    [focusTasksDisplay, taskGroups],
  );
  const satelliteGroupMeta = useMemo(
    () => buildTierGroupMeta(satelliteTasksDisplay, taskGroups),
    [satelliteTasksDisplay, taskGroups],
  );
  const waitGroupMeta = useMemo(
    () => buildTierGroupMeta(waitTasksDisplay, taskGroups),
    [waitTasksDisplay, taskGroups],
  );

  // --- Parent-anchored sort with child grouping ---
  // Produces a sorted ID order where children always follow their parent.
  const computeSortOrder = useCallback((items: Task[]): string[] => {
    // Partition tasks into top-level (+ orphans) vs children-of-visible-parent
    const topLevel: Task[] = [];
    const childrenOf = new Map<string, Task[]>();

    // Build a prefix→fullId lookup so parent_task_id (short prefix) resolves to the actual parent
    const fullIds = items.map((t) => t.id);
    const resolveParent = (prefix: string): string | undefined =>
      fullIds.find((id) => id.startsWith(prefix));

    for (const task of items) {
      if (!task.parent_task_id) {
        topLevel.push(task);
        continue;
      }
      // parent_task_id may be a short prefix (e.g. "mlk71mm5") — resolve via prefix match
      const parentFullId = resolveParent(task.parent_task_id);
      if (parentFullId) {
        let siblings = childrenOf.get(parentFullId);
        if (!siblings) { siblings = []; childrenOf.set(parentFullId, siblings); }
        siblings.push(task);
      } else {
        // Orphan: parent not in filtered set — render as top-level
        topLevel.push(task);
      }
    }

    // Manual mode: keep store order as-is. Priority/date/updated: re-sort siblings.
    if (sortBy !== 'manual') {
      const cmpMap: Record<Exclude<SortBy, 'manual'>, (a: Task, b: Task) => number> = { priority: comparePriority, date: compareDate, updated: compareUpdated };
      const cmp = cmpMap[sortBy] ?? compareDate;
      topLevel.sort(cmp);
      for (const children of childrenOf.values()) children.sort(cmp);
    }

    // Virtual-group clustering: top-level members sharing a group_id are kept
    // contiguous, anchored at the group's LEAD (the first member in sorted
    // topLevel order). The lead keeps its natural sort position; the other
    // members are pulled up right after it. Only top-level tasks cluster —
    // a grouped task that is also someone's child stays under its parent.
    const groupTopMembers = new Map<string, Task[]>();
    for (const task of topLevel) {
      if (task.group_id) {
        let arr = groupTopMembers.get(task.group_id);
        if (!arr) { arr = []; groupTopMembers.set(task.group_id, arr); }
        arr.push(task);
      }
    }
    const emittedGroups = new Set<string>();

    // Recursive interleave: parent → children → grandchildren
    const order: string[] = [];
    const visited = new Set<string>();
    function emitWithChildren(task: Task) {
      if (visited.has(task.id)) return; // cycle guard
      visited.add(task.id);
      order.push(task.id);
      const children = childrenOf.get(task.id);
      if (children) for (const child of children) emitWithChildren(child);
    }
    for (const task of topLevel) {
      if (visited.has(task.id)) continue;
      // Group lead: emit the whole cluster contiguously, then mark it done so
      // later members (already visited) are skipped in place.
      const members = task.group_id && !emittedGroups.has(task.group_id)
        ? groupTopMembers.get(task.group_id)
        : undefined;
      if (members && members.length >= 1) {
        emittedGroups.add(task.group_id!);
        for (const m of members) emitWithChildren(m);
      } else {
        emitWithChildren(task);
      }
    }
    return order;
  }, [sortBy]);

  // --- Debounced sort order ---
  // Badge/data updates instantly (always use latest `filtered` task objects).
  // Only the POSITION (sort order) is debounced by 3s on reorder-only changes.
  const [sortOrder, setSortOrder] = useState<string[]>(() => computeSortOrder(filtered));
  const sortByRef = useRef(sortBy);
  const prevFilteredIdsRef = useRef<Set<string>>(new Set(filtered.map((t) => t.id)));
  // Equality check for sort order — prevents no-op re-renders when task data changes
  // but the sorted order is identical (e.g. focus_tier change doesn't affect sort position).
  const stableSortUpdate = useCallback((newOrder: string[]) => {
    setSortOrder(prev => {
      if (prev.length === newOrder.length && prev.every((id, i) => id === newOrder[i])) return prev;
      return newOrder;
    });
  }, []);

  useEffect(() => {
    const newOrder = computeSortOrder(filtered);

    // sortBy toggle or structural change (IDs added/removed): flush immediately
    const currIds = new Set(filtered.map((t) => t.id));
    const prevIds = prevFilteredIdsRef.current;
    const structural = currIds.size !== prevIds.size || !filtered.every((t) => prevIds.has(t.id));
    if (sortByRef.current !== sortBy || structural) {
      sortByRef.current = sortBy;
      prevFilteredIdsRef.current = currIds;
      stableSortUpdate(newOrder);
      return;
    }
    prevFilteredIdsRef.current = currIds;

    // Manual mode: store order IS the truth — flush immediately, no debounce.
    // This prevents a stray debounced re-sort from overriding the user's drag result.
    if (sortBy === 'manual') {
      stableSortUpdate(newOrder);
      return;
    }

    // Same set of tasks, just reordered (e.g. priority change): debounce 3s
    const timer = setTimeout(() => stableSortUpdate(newOrder), 3000);
    return () => clearTimeout(timer);
  }, [filtered, sortBy, computeSortOrder, stableSortUpdate]);

  // --- Combine: latest task data arranged in deferred sort order ---
  // This ensures badges/fields update INSTANTLY while position delays.
  const sorted = useMemo(() => {
    const taskById = new Map(filtered.map((t) => [t.id, t]));
    const result: Task[] = [];
    const emitted = new Set<string>();
    // Emit tasks in deferred sort order (stale position), using fresh task objects
    for (const id of sortOrder) {
      const task = taskById.get(id);
      if (task) { result.push(task); emitted.add(id); }
    }
    // Append any new tasks not yet in sortOrder (just added)
    for (const task of filtered) {
      if (!emitted.has(task.id)) result.push(task);
    }
    return result;
  }, [filtered, sortOrder]);

  // Cross-filter counts: each dimension counts tasks matching all OTHER active filters
  const filterCounts = useMemo(() => {
    // Shared predicates to avoid duplication across filter dimensions.
    const matchesCategory = (t: Task) => {
      if (activeCategory === STARRED_TAB) {
        return !!t.starred || (favorites?.isCategoryFavorite(t.category) ?? false) || (favorites?.isProjectFavorite(t.project) ?? false) || isDescendantVisibleInStarred(t);
      }
      return !activeCategory || t.category === activeCategory;
    };
    const matchesPrioritySessionSource = (t: Task) => {
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (sessionFilter && t.phase !== sessionFilter) return false;
      if (sourceFilter !== 'all' && (t.source || 'ms-todo') !== sourceFilter) return false;
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
      return true;
    };

    // baseTasks: respects showCompleted (used for "All" counts and most dimensions)
    const baseTasks = tasks.filter((t) => {
      if (!showCompleted && t.status === 'done' && phaseFilter !== 'COMPLETE') {
        return false;
      }
      return matchesCategory(t);
    });

    // Priority counts (apply phase + session + source + tag filters)
    const forPriority = baseTasks.filter((t) => {
      if (phaseFilter && !matchesPhaseFilter(phaseFilter, t.phase)) return false;
      if (sessionFilter && t.phase !== sessionFilter) return false;
      if (sourceFilter !== 'all' && (t.source || 'ms-todo') !== sourceFilter) return false;
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
      return true;
    });
    const priority: Record<string, number> = { immediate: 0, important: 0, backlog: 0, none: 0 };
    for (const t of forPriority) {
      const p = effectivePriority(t.priority); // legacy fallback
      if (p && priority[p] !== undefined) priority[p]++;
    }

    // Phase counts: include all done tasks so COMPLETE count is accurate even when
    // showCompleted is off. Clicking COMPLETE overrides showCompleted (line ~1055),
    // so the count must reflect what the user would see after clicking.
    // Note: sum(phase counts) > totalForPhase when showCompleted=false — this is intentional.
    const forPhase = tasks.filter((t) => matchesCategory(t) && matchesPrioritySessionSource(t));
    const phase: Record<string, number> = {};
    for (const p of PHASE_ORDER) phase[p] = 0;
    for (const t of forPhase) if (t.phase && phase[t.phase] !== undefined) phase[t.phase]++;

    // totalForPhase: "All" chip count respects showCompleted so it matches visible tasks
    const totalForPhase = baseTasks.filter(matchesPrioritySessionSource).length;

    // Session counts (apply priority + phase + source + tag filters)
    const forSession = baseTasks.filter((t) => {
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (phaseFilter && !matchesPhaseFilter(phaseFilter, t.phase)) return false;
      if (sourceFilter !== 'all' && (t.source || 'ms-todo') !== sourceFilter) return false;
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
      return true;
    });
    const session: Record<string, number> = {};
    for (const p of PHASE_ORDER) session[p] = 0;
    for (const t of forSession) {
      if (t.phase && session[t.phase] !== undefined) session[t.phase]++;
    }

    // Source counts (apply priority + phase + session + tag filters)
    const forSource = baseTasks.filter((t) => {
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (phaseFilter && !matchesPhaseFilter(phaseFilter, t.phase)) return false;
      if (sessionFilter && t.phase !== sessionFilter) return false;
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
      return true;
    });
    // Build source counts dynamically from registered integrations
    const source: Record<string, number> = { all: forSource.length };
    for (const integ of integrations) source[integ.id] = 0;
    source['local'] = 0;
    for (const t of forSource) {
      const s = t.source || 'ms-todo';
      if (source[s] === undefined) source[s] = 0;
      source[s]++;
    }

    // Tag counts (apply priority + phase + session + source filters)
    const forTags = baseTasks.filter((t) => {
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (phaseFilter && !matchesPhaseFilter(phaseFilter, t.phase)) return false;
      if (sessionFilter && t.phase !== sessionFilter) return false;
      if (sourceFilter !== 'all' && (t.source || 'ms-todo') !== sourceFilter) return false;
      return true;
    });
    const tagCounts: Record<string, number> = {};
    for (const t of forTags) {
      if (t.tags) for (const tag of t.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }

    return { priority, phase, session, source, tagCounts, totalForPriority: forPriority.length, totalForPhase, totalForSession: forSession.length, totalForTags: forTags.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, showCompleted, priorityFilter, phaseFilter, sessionFilter, sourceFilter, tagFilter, activeCategory, favorites, isDescendantVisibleInStarred]);

  // Build category -> project -> tasks hierarchy (skipped in flat mode)
  const grouped = useMemo(() => {
    if (groupBy === 'none') return [];
    const map = new Map<string, { direct: Task[]; projects: Map<string, Task[]> }>();
    for (const task of sorted) {
      const cat = task.category || 'Uncategorized';
      const hasDistinctProject = task.project && task.project !== task.category;
      if (!map.has(cat)) map.set(cat, { direct: [], projects: new Map() });
      const entry = map.get(cat)!;
      if (hasDistinctProject) {
        const proj = task.project!;
        if (!entry.projects.has(proj)) entry.projects.set(proj, []);
        entry.projects.get(proj)!.push(task);
      } else {
        entry.direct.push(task);
      }
    }
    const catOrder = ordering?.categoryOrder ?? [];
    const projOrder = ordering?.projectOrder ?? {};
    const catNames = orderedSort(Array.from(map.keys()), catOrder);
    return catNames.map((cat) => {
      const entry = map.get(cat)!;
      const projNames = orderedSort(Array.from(entry.projects.keys()), projOrder[cat] ?? []);
      return {
        category: cat,
        directTasks: entry.direct,
        projects: projNames.map((proj) => ({ project: proj, tasks: entry.projects.get(proj)! })),
      };
    });
  }, [sorted, groupBy, ordering?.categoryOrder, ordering?.projectOrder]);

  // Child task maps: parentId → count, set of child task IDs, and child→parent mapping
  // Only tasks whose parent is VISIBLE in the current list are treated as children.
  // Orphans (parent hidden/completed/filtered out) render as normal top-level tasks.
  // True child count from the FULL task list (unfiltered) — used for chevron + "N sub" badge
  // so the user always sees that children exist, even when they're filtered out.
  const trueChildCountMap = useMemo(() => {
    const countMap = new Map<string, number>();
    for (const task of tasks) {
      if (task.parent_task_id) {
        const parent = tasks.find((t) => t.id.startsWith(task.parent_task_id!));
        if (parent) countMap.set(parent.id, (countMap.get(parent.id) ?? 0) + 1);
      }
    }
    return countMap;
  }, [tasks]);

  const { childTaskIds, childParentMap, depthMap } = useMemo(() => {
    const childIds = new Set<string>();
    const parentMap = new Map<string, string>(); // childId → parentFullId
    for (const task of sorted) {
      if (task.parent_task_id) {
        // Find parent — match by prefix (parent_task_id may be a short prefix)
        const parentId = task.parent_task_id;
        const parent = sorted.find((t) => t.id.startsWith(parentId));
        if (parent) {
          childIds.add(task.id);
          parentMap.set(task.id, parent.id);
        }
        // If parent not visible → orphan: no childIds entry, renders as top-level
      }
    }
    // Compute depth for each task by walking the parent chain (supports unlimited nesting)
    const depths = new Map<string, number>();
    const MAX_DEPTH = 10; // Safety cap against unexpected cycles
    const getDepth = (id: string): number => {
      if (depths.has(id)) return depths.get(id)!;
      const pid = parentMap.get(id);
      const d = pid ? Math.min(getDepth(pid) + 1, MAX_DEPTH) : 0;
      depths.set(id, d);
      return d;
    };
    for (const task of sorted) getDepth(task.id);
    return { childTaskIds: childIds, childParentMap: parentMap, depthMap: depths };
  }, [sorted]);

  // Virtual-group render metadata: taskId → { groupId, label, isLead, isLast }.
  // computeSortOrder already clusters group members contiguously, so we just walk
  // `sorted` and mark the first occurrence of each group as the lead (chip + top
  // rounding) and the last as the tail (bottom rounding). A group renders down to a
  // SINGLE member — a 1-member group is valid (acts like a tag) and stays boxed
  // until the user dissolves it; a lone member is both lead and last (chip on top +
  // rounded bottom = a complete one-card box).
  const groupRenderMap = useMemo(() => {
    const map = new Map<string, GroupRenderInfo>();
    // Count members per group from the *displayed* set (`sorted`), not the full task
    // list. A group boxes with ≥1 *visible* member. computeSortOrder clusters members
    // contiguously, so counting occurrences in `sorted` == counting contiguous visible
    // members.
    const counts = new Map<string, number>();
    for (const t of sorted) if (t.group_id) counts.set(t.group_id, (counts.get(t.group_id) ?? 0) + 1);
    const firstSeen = new Set<string>();
    const lastIdxByGroup = new Map<string, number>();
    sorted.forEach((t, i) => { if (t.group_id && (counts.get(t.group_id) ?? 0) >= 1) lastIdxByGroup.set(t.group_id, i); });
    sorted.forEach((t, i) => {
      const gid = t.group_id;
      if (!gid || (counts.get(gid) ?? 0) < 1) return;
      const isLead = !firstSeen.has(gid);
      if (isLead) firstSeen.add(gid);
      map.set(t.id, {
        groupId: gid,
        label: taskGroups?.[gid] ?? '',
        isLead,
        isLast: lastIdxByGroup.get(gid) === i,
      });
    });
    return map;
  }, [sorted, taskGroups]);

  // Determine if a child task should be hidden (any ancestor is collapsed — walks full chain)
  const isChildHidden = useCallback((taskId: string) => {
    let currentId: string | undefined = taskId;
    while (currentId) {
      const parentId = childParentMap.get(currentId);
      if (!parentId) return false; // reached a root task
      if (!expandedParents.has(parentId)) return true; // ancestor collapsed
      currentId = parentId;
    }
    return false;
  }, [childParentMap, expandedParents]);

  // Full (unfiltered) group map — needed so task reorder sends ALL IDs to the backend
  const fullGrouped = useMemo(() => {
    const map = new Map<string, { direct: Task[]; projects: Map<string, Task[]> }>();
    for (const task of tasks) {
      const cat = task.category || 'Uncategorized';
      const hasDistinctProject = task.project && task.project !== task.category;
      if (!map.has(cat)) map.set(cat, { direct: [], projects: new Map() });
      const entry = map.get(cat)!;
      if (hasDistinctProject) {
        const proj = task.project!;
        if (!entry.projects.has(proj)) entry.projects.set(proj, []);
        entry.projects.get(proj)!.push(task);
      } else {
        entry.direct.push(task);
      }
    }
    return map;
  }, [tasks]);

  // Build a lookup: taskId → { category, project } for drag end
  // Normalize project: direct tasks use category as project (matches DroppableHeader data)
  const taskGroupMap = useMemo(() => {
    const m = new Map<string, { category: string; project: string }>();
    for (const g of grouped) {
      for (const t of g.directTasks) m.set(t.id, { category: g.category, project: g.category });
      for (const p of g.projects) {
        for (const t of p.tasks) m.set(t.id, { category: g.category, project: p.project });
      }
    }
    return m;
  }, [grouped]);

  const quickAddCategories = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.category) set.add(t.category);
    if (!set.has('Inbox')) set.add('Inbox');
    return [...set].sort((a, b) => (a === 'Inbox' ? -1 : b === 'Inbox' ? 1 : a.localeCompare(b)));
  }, [tasks]);

  const quickAddProjectsByCategory = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const t of tasks) {
      if (!t.category || !t.project) continue;
      if (!m.has(t.category)) m.set(t.category, new Set());
      m.get(t.category)!.add(t.project);
    }
    return m;
  }, [tasks]);

  const effectiveDefaultCategory = useMemo(() => {
    if (quickCategory) return quickCategory;
    if (activeCategory && activeCategory !== STARRED_TAB) return activeCategory;
    return 'Inbox';
  }, [quickCategory, activeCategory]);

  const handleAdd = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    const category = effectiveDefaultCategory;
    const project = quickProject.trim() || undefined;
    try {
      const result = await onCreate({
        title,
        priority: 'none',
        category,
        project,
        starred: quickStarred,
        pinnedTier: quickPinnedTier ?? undefined,
      });
      setNewTitle('');
      setQuickCategory('');
      setQuickProject('');
      setQuickStarred(false);
      setQuickPinnedTier(null);
      if (onClearOperationError) onClearOperationError();
      const newTask = result as Task | undefined;
      if (newTask?.id) {
        // Jump to the category where the task actually landed
        if (activeCategory !== '' && activeCategory !== category) {
          setActiveCategory(category);
          persistTab(category);
          onCategoryChange?.(category);
        }
        // Auto-focus triggers scroll-into-view via SortableTaskItem
        onFocusTask?.(newTask);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to add task';
      if (onOperationError) onOperationError(msg);
    }
  }, [newTitle, quickProject, quickStarred, quickPinnedTier, effectiveDefaultCategory, onCreate, onClearOperationError, onOperationError, onFocusTask, activeCategory, onCategoryChange]);

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      persistSet(LS_COLLAPSED_CATS_KEY, next);
      return next;
    });
  };

  const toggleProject = (key: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persistSet(LS_COLLAPSED_PROJS_KEY, next);
      return next;
    });
  };

  // Toggle child task visibility for a parent task (default: collapsed)
  const toggleParentExpand = useCallback((parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      persistSet(LS_EXPANDED_PARENTS_KEY, next);
      return next;
    });
  }, []);

  const isParentExpanded = useCallback((parentId: string) => {
    return expandedParents.has(parentId);
  }, [expandedParents]);

  // Collapse all / expand all
  const allGroupKeys = useMemo(() => {
    const catNames = grouped.map((g) => g.category);
    const projKeys: string[] = [];
    for (const g of grouped) {
      for (const p of g.projects) {
        projKeys.push(`${g.category}/${p.project}`);
      }
    }
    return { catNames, projKeys };
  }, [grouped]);

  const allCollapsed = allGroupKeys.catNames.length > 0 &&
    allGroupKeys.catNames.every((c) => collapsedCategories.has(c));

  const handleCollapseExpandAll = useCallback(() => {
    if (allCollapsed) {
      // Expand all
      setCollapsedCategories(new Set());
      setCollapsedProjects(new Set());
      persistSet(LS_COLLAPSED_CATS_KEY, new Set());
      persistSet(LS_COLLAPSED_PROJS_KEY, new Set());
    } else {
      // Collapse all — also collapse child tasks
      const nextCats = new Set(allGroupKeys.catNames);
      const nextProjs = new Set(allGroupKeys.projKeys);
      setCollapsedCategories(nextCats);
      setCollapsedProjects(nextProjs);
      setExpandedParents(new Set());
      persistSet(LS_COLLAPSED_CATS_KEY, nextCats);
      persistSet(LS_COLLAPSED_PROJS_KEY, nextProjs);
      persistSet(LS_EXPANDED_PARENTS_KEY, new Set());
    }
  }, [allCollapsed, allGroupKeys]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveDragId(id);
    const type = (event.active.data?.current as { type?: string })?.type ?? 'task';
    setActiveDragType(type);
    // Start tracking the live cursor so handleDragOver/End can read horizontal
    // position within the over-card (group vs subtask vs reorder).
    window.addEventListener('pointermove', trackPointer, { passive: true });
    dropIntentRef.current = null;
    setNestTargetId(null);
    setGroupTargetId(null);
  }, []);

  /** Clear all drop-intent highlights + stop pointer tracking — on drag end/cancel. */
  const clearDropIntent = useCallback(() => {
    window.removeEventListener('pointermove', trackPointer);
    dropIntentRef.current = null;
    setNestTargetId((prev) => (prev === null ? prev : null));
    setGroupTargetId((prev) => (prev === null ? prev : null));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const activeType = (event.active.data?.current as { type?: string })?.type ?? 'task';
    // Drop-intent highlighting only applies to task drags (not cat/proj group drags).
    if (activeType !== 'task') { clearDropIntent(); return; }

    const activeId = String(event.active.id);
    const overId = event.over?.id ? String(event.over.id) : null;

    // Only over another task card — not headers, not the dragged task itself.
    if (!overId || overId === activeId || !taskGroupMap.has(overId)) {
      if (dropIntentRef.current !== null) clearDropIntent();
      return;
    }

    // Prevent cycle: target can't be the dragged task or any of its descendants.
    let walk: string | undefined = overId;
    for (let i = 0; i < 32 && walk; i++) {
      if (walk === activeId) { if (dropIntentRef.current !== null) clearDropIntent(); return; }
      walk = childParentMap.get(walk);
    }

    // Classify by the live cursor's horizontal position within the over-card:
    // right indent zone → subtask (Main only), else → group. The Pin/Focus tiers
    // have their own DnD handler (handlePinnedDragOver); this one is the Main list,
    // which supports subtasks, so both intents are live here.
    const cardEl = document.querySelector(`.todo-panel-item[data-task-id="${overId}"]`);
    let intent = classifyDropOnCard(cardEl); // 'group' | 'subtask'

    // ── Grouped-member exemption ── If the dragged task is ALREADY in a group, a
    // group-zone hover must NEVER light "join group". A member being dragged has only
    // two valid outcomes: drop on a same-group neighbor → intra-group reorder; drop
    // anywhere else → pull OUT of the group (handled at drag end). Lighting the group
    // target while dragging a grouped member is exactly what caused the reported bug:
    // groupTasks() has ABSORB semantics, so "grouping" a member with an outside card
    // merged the member's WHOLE group plus the target into a new group instead of just
    // popping the member out. Suppress the highlight; a right-zone subtask nest is
    // still allowed (that's a reparent, independent of grouping).
    const activeGroup = tasks.find((t) => t.id === activeId)?.group_id;
    if (intent === 'group' && activeGroup) {
      if (dropIntentRef.current !== null) clearDropIntent();
      return;
    }

    // "subtask" onto the active task's CURRENT parent is a confusing no-op — fall
    // back to 'group' there (drop-on-own-parent = unparent still works at drag end).
    const activeParentId = childParentMap.get(activeId);
    if (intent === 'subtask' && activeParentId && activeParentId === overId) intent = 'group';

    const key = `${overId}:${intent}`;
    if (dropIntentRef.current === key) return; // same target+intent — no state churn
    dropIntentRef.current = key;
    if (intent === 'subtask') {
      setGroupTargetId((prev) => (prev === null ? prev : null));
      setNestTargetId(overId);
    } else {
      setNestTargetId((prev) => (prev === null ? prev : null));
      setGroupTargetId(overId);
    }
  }, [taskGroupMap, childParentMap, clearDropIntent, tasks]);

  // Auto-switch to manual sort when the user performs a manual action (drag
  // reorder / Move up / Move left). If a priority/date/updated sort is active,
  // the manual change would immediately be overridden by re-sort — instead we
  // silently switch to manual and toast the user so they understand why.
  //
  // Before switching, bake the current displayed `sortOrder` into the tasks
  // store so manual mode renders the SAME order the user was looking at. Without
  // this step the entire list re-shuffles from priority/date order to raw store
  // order — which is the "flash + I lost my task" feeling.
  const ensureManualSort = useCallback(() => {
    if (sortBy !== 'manual') {
      if (onBakeOrder && sortOrder.length > 0) onBakeOrder(sortOrder);
      setSortBy('manual');
      persistSortBy('manual');
      showSortToast('Switched to Manual sort');
    }
  }, [sortBy, sortOrder, onBakeOrder, showSortToast]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    // Capture the drop intent BEFORE clearing. Position-based (set in handleDragOver
    // from the cursor's horizontal position over the target card):
    //   • nestTarget  → dropped in the right indent zone → nest as subtask
    //   • groupTarget → dropped in the left zone of a card → join/create a group
    const dwellNest = nestTargetId;
    const groupDrop = groupTargetId;
    setActiveDragId(null);
    setActiveDragType(null);
    clearDropIntent();
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // ── Drag-into-group (Main list) ── A left-zone drop on a task card means
    // "group these together". If the target is already in a group, join it; else
    // create a new group from the two. This takes precedence over reparent/reorder
    // (which only run for gap drops or right-zone subtask drops). Grouping has no
    // scope rule, so cross-category/project drops are fine.
    // GUARD: only an UNGROUPED active can join here. A grouped member dropped on an
    // outside card must NOT group-merge (groupTasks ABSORBS the member's whole group +
    // the target — the reported bug); it falls through to the drag-OUT block below.
    if (groupDrop && String(over.id) === groupDrop && groupDrop !== String(active.id)) {
      const activeId = String(active.id);
      const overTask = tasks.find((t) => t.id === groupDrop);
      const activeTask = tasks.find((t) => t.id === activeId);
      if (overTask && activeTask && !activeTask.group_id && activeTask.group_id !== overTask.group_id) {
        if (overTask.group_id && onAddToGroup) {
          onAddToGroup(overTask.group_id, [activeId]);
          return;
        }
        if (!overTask.group_id && onGroupTasks) {
          onGroupTasks([overTask.id, activeId]);
          return;
        }
      }
    }

    // ── Drag OUT of a group ── The dragged task is a group member, this drop is NOT
    // a "join group" action (those return above), and it landed somewhere that is
    // NOT a same-group member (a header, the gap, or an unrelated task — same-group
    // hovers are exempted in dragOver so they never light the group target). That
    // means the user is pulling the member OUT of its cluster: clear its group_id,
    // then FALL THROUGH to the normal reorder/reparent/move below so it also lands
    // where it was dropped. Without this a grouped member can't leave by dragging —
    // clusterByGroup keeps snapping it back into the contiguous cluster.
    if (onUngroupTask) {
      const activeId = String(active.id);
      const activeTask = tasks.find((t) => t.id === activeId);
      const overTask = tasks.find((t) => t.id === String(over.id));
      if (activeTask?.group_id && activeTask.group_id !== overTask?.group_id) {
        onUngroupTask(activeId);
        // fall through — the reorder/reparent/move logic below repositions it
      }
    }

    const activeType = (active.data?.current as { type?: string })?.type ?? 'task';

    // Category group reorder (collision is type-aware, so over.id is always cat:*)
    if (activeType === 'category-group' && ordering) {
      const overId = String(over.id);
      if (!overId.startsWith('cat:')) return;
      const activeId = String(active.id).slice(4); // strip 'cat:'
      const targetCat = overId.slice(4);
      if (targetCat === activeId) return;
      const catNames = grouped.map((g) => g.category);
      const oldIndex = catNames.indexOf(activeId);
      const newIndex = catNames.indexOf(targetCat);
      if (oldIndex === -1 || newIndex === -1) return;
      const newOrder = [...catNames];
      newOrder.splice(oldIndex, 1);
      newOrder.splice(newIndex, 0, activeId);
      ordering.reorderCategories(newOrder);
      return;
    }

    // Project group reorder (collision is type-aware, so over.id is always proj:*)
    if (activeType === 'project-group' && ordering) {
      const overId = String(over.id);
      if (!overId.startsWith('proj:')) return;
      const activeRest = String(active.id).slice(5); // strip 'proj:'
      const slashIdx = activeRest.indexOf('/');
      if (slashIdx === -1) return;
      const activeCat = activeRest.slice(0, slashIdx);
      const activeProj = activeRest.slice(slashIdx + 1);
      const overRest = overId.slice(5);
      const overSlashIdx = overRest.indexOf('/');
      if (overSlashIdx === -1) return;
      const targetProj = overRest.slice(overSlashIdx + 1);
      if (targetProj === activeProj) return;
      const group = grouped.find((g) => g.category === activeCat);
      if (!group) return;
      const projNames = group.projects.map((p) => p.project);
      const oldIndex = projNames.indexOf(activeProj);
      const newIndex = projNames.indexOf(targetProj);
      if (oldIndex === -1 || newIndex === -1) return;
      const newOrder = [...projNames];
      newOrder.splice(oldIndex, 1);
      newOrder.splice(newIndex, 0, activeProj);
      ordering.reorderProjects(activeCat, newOrder);
      return;
    }

    // Task reorder or cross-group move
    const activeId = String(active.id);
    const overId = String(over.id);
    const activeInfo = taskGroupMap.get(activeId);
    if (!activeInfo) return;

    // Determine target group: from task or from header drop zone
    let targetCategory: string;
    let targetProject: string;
    let insertNearTaskId: string | undefined;

    if (taskGroupMap.has(overId)) {
      // Dropped on a task
      const overInfo = taskGroupMap.get(overId)!;
      targetCategory = overInfo.category;
      targetProject = overInfo.project;
      insertNearTaskId = overId;
    } else if (overId.startsWith('hdr-cat:') || overId.startsWith('hdr-proj:')) {
      // Dropped on a header
      const overData = over.data?.current as { category?: string; project?: string } | undefined;
      if (!overData?.category) return;
      targetCategory = overData.category;
      targetProject = overData.project ?? overData.category;
      insertNearTaskId = undefined; // append to end
    } else {
      return;
    }

    // ── Reparent detection ──
    // When dragging a task, check if the drop target implies a parent change.
    // Rules (prioritized so "drag out of parent" is always reachable):
    //   - Drop on own parent or own sibling (if dragged is a subtask) → unparent
    //     (most intuitive "drag out" gesture — otherwise every nearby target
    //     would just re-nest the task under the same parent)
    //   - Drop on another child task (not same parent) → adopt that parent
    //   - Drop on a parent task (has children, not own parent) → become its child
    //   - Drop on a header → unparent
    //   - Drop on a regular top-level task (no children, no parent) → unparent
    const activeTask = sorted.find((t) => t.id === activeId);
    if (activeTask && onReparentTask) {
      // Resolve the dragged task's current parent (full id) up-front so we can
      // detect "drop on own parent/sibling" as an unparent gesture.
      const currentParentFullId = activeTask.parent_task_id
        ? (sorted.find((t) => t.id.startsWith(activeTask.parent_task_id!))?.id ?? null)
        : null;

      let newParentId: string | null = null;
      if (insertNearTaskId) {
        const targetTask = sorted.find((t) => t.id === insertNearTaskId);
        if (targetTask) {
          // Apple Reminders–style explicit nest: user dwelled on this task
          // long enough to light the nest ring. Force nest regardless of
          // the usual heuristics (parent vs sibling vs plain target).
          if (dwellNest && dwellNest === targetTask.id) {
            newParentId = targetTask.id;
          } else {
            const targetParent = childParentMap.get(targetTask.id) ?? null;
            if (currentParentFullId && (
                targetTask.id === currentParentFullId ||
                targetParent === currentParentFullId
              )) {
              // Dropped on own parent or own sibling → user wants OUT. Unparent.
              newParentId = null;
            } else if (targetParent) {
              // Target is someone else's child → adopt that parent
              newParentId = targetParent;
            } else if ((trueChildCountMap.get(targetTask.id) ?? 0) > 0) {
              // Target is a different parent (has children) → become its child
              newParentId = targetTask.id;
            }
            // else: target is a plain top-level task → newParentId stays null (unparent)
          }
        }
      }
      // Dropped on header: newParentId stays null (unparent)

      // Prevent cycles: don't allow reparenting to self or to a descendant
      if (newParentId === activeId) return;
      let walkId: string | undefined = newParentId ?? undefined;
      while (walkId) {
        const nextParent = childParentMap.get(walkId);
        if (nextParent === activeId) return; // would create a cycle
        walkId = nextParent;
      }

      // Already resolved above as currentParentFullId
      const currentParentId = currentParentFullId;

      if (newParentId !== currentParentId) {
        // Auto-expand new parent so the moved task is visible
        if (newParentId) {
          setExpandedParents((prev) => {
            if (prev.has(newParentId!)) return prev;
            const next = new Set(prev);
            next.add(newParentId!);
            return next;
          });
        }
        // Preserve scroll position: mark the moved task so the post-refetch
        // useEffect scrolls it back into view (otherwise list jumps to top).
        scrollAfterReparentRef.current = activeId;
        ensureManualSort();
        // Pass the drag drop target so reparent places the task where the
        // user actually dropped it — not some arbitrary fallback position.
        onReparentTask(activeId, newParentId, insertNearTaskId ? { insertAfterId: insertNearTaskId } : undefined);
        return;
      }
    }

    const sameGroup = activeInfo.category === targetCategory && activeInfo.project === targetProject;

    if (sameGroup) {
      // Same group: existing reorder logic
      if (!onReorder) return;
      if (!insertNearTaskId) return; // dropped on own header, nothing to do
      ensureManualSort();

      const { category, project } = activeInfo;
      const group = grouped.find((g) => g.category === category);
      if (!group) return;

      const hasDistinctProject = project && project !== category;
      const visibleTasks = hasDistinctProject
        ? group.projects.find((p) => p.project === project)?.tasks
        : group.directTasks;
      if (!visibleTasks) return;

      const visibleIds = visibleTasks.map((t) => t.id);
      const oldIndex = visibleIds.indexOf(activeId);
      const newIndex = visibleIds.indexOf(insertNearTaskId);
      if (oldIndex === -1 || newIndex === -1) return;

      const newVisibleIds = [...visibleIds];
      newVisibleIds.splice(oldIndex, 1);
      newVisibleIds.splice(newIndex, 0, activeId);

      // Get the FULL (unfiltered) task list so the backend gets all IDs
      const fullEntry = fullGrouped.get(category);
      if (!fullEntry) return;
      const fullTasks = hasDistinctProject
        ? fullEntry.projects.get(project!)
        : fullEntry.direct;
      if (!fullTasks) return;

      // Merge reordered visible tasks back into the full list,
      // preserving positions of hidden (e.g. completed) tasks
      const fullIds = fullTasks.map((t) => t.id);
      const visibleSet = new Set(visibleIds);
      const result: string[] = [];
      let vi = 0;
      for (const id of fullIds) {
        if (visibleSet.has(id)) {
          result.push(newVisibleIds[vi++]);
        } else {
          result.push(id);
        }
      }

      onReorder(category, project, result);
    } else {
      // Cross-group move
      if (!onMoveTask) return;
      ensureManualSort();
      onMoveTask(activeId, targetCategory, targetProject, insertNearTaskId);
    }
  }, [onReorder, onMoveTask, onReparentTask, ordering, taskGroupMap, grouped, fullGrouped, sorted, childParentMap, trueChildCountMap, ensureManualSort, nestTargetId, groupTargetId, clearDropIntent, tasks, onAddToGroup, onGroupTasks]);

  // Kebab "Move left" — promote subtask to top-level via onReparentTask(id, null).
  // Also primes scroll restoration so the task stays visible after refetch.
  const handleUnparent = useCallback((taskId: string) => {
    if (!onReparentTask) return;
    ensureManualSort();
    scrollAfterReparentRef.current = taskId;
    onReparentTask(taskId, null);
  }, [onReparentTask, ensureManualSort]);

  // Group chip click → rename the group via the app's own prompt dialog (never the
  // browser-native prompt). Cancel/empty/unchanged keeps the name.
  const handleRenameGroup = useCallback(async (groupId: string, currentLabel: string) => {
    if (!onRenameGroup) return;
    const next = await prompt({ title: 'Rename group', defaultValue: currentLabel, confirmLabel: 'Rename' });
    if (next == null) return; // cancelled or left empty
    const trimmed = next.trim();
    if (!trimmed || trimmed === currentLabel) return;
    onRenameGroup(groupId, trimmed);
  }, [onRenameGroup, prompt]);

  // Group chip ✕ → dissolve the whole cluster (ungroup every member at once). The
  // backend dissolves a group once it drops below 2 members, so removing all members
  // tears it down cleanly. This is the discoverable inverse of grouping.
  const handleDissolveGroup = useCallback((groupId: string) => {
    const memberIds = tasks.filter((t) => t.group_id === groupId).map((t) => t.id);
    if (memberIds.length === 0) return;
    // Prefer the single batch call (one API round-trip + one refetch). The per-task
    // fallback exists only for a consumer that wires onUngroupTask but not onUngroupTasks
    // (today MainPage passes both); it would fan out into N calls, so it's a safety net,
    // not the hot path.
    if (onUngroupTasks) onUngroupTasks(memberIds);
    else if (onUngroupTask) memberIds.forEach((id) => onUngroupTask(id));
  }, [onUngroupTasks, onUngroupTask, tasks]);

  // Group chip ⊘ → hide the whole cluster from the Focus area. Unlike dissolve this
  // keeps the group + membership intact — only the pinned rendering collapses it.
  // Unhide from a member's kebab ("Unhide group") or the /tasks page.
  const handleHideGroup = useCallback((groupId: string) => {
    onSetGroupHidden?.(groupId, true);
  }, [onSetGroupHidden]);

  // Kebab "Unhide group in Focus" → restore a Focus-hidden group.
  const handleUnhideGroup = useCallback((groupId: string) => {
    onSetGroupHidden?.(groupId, false);
  }, [onSetGroupHidden]);

  // Kebab "Move up" — map of taskId → handler that swaps the task with the
  // previous sibling in its group. Siblings are grouped by parent_task_id so
  // child tasks only move among their own siblings. Tasks that are already
  // first among their siblings have no handler (button auto-hides).
  const moveUpMap = useMemo((): Map<string, () => void> => {
    const map = new Map<string, () => void>();
    if (!onReorder) return map;

    const processGroup = (groupTasks: Task[], fullGroupTasks: Task[], category: string, project: string) => {
      // Group visible tasks by sibling-key (parent_task_id, resolved to full id)
      const siblingGroups = new Map<string, Task[]>();
      for (const t of groupTasks) {
        const parentKey = t.parent_task_id
          ? (groupTasks.find((p) => p.id.startsWith(t.parent_task_id!))?.id ?? `__orphan:${t.parent_task_id}`)
          : '__root__';
        if (!siblingGroups.has(parentKey)) siblingGroups.set(parentKey, []);
        siblingGroups.get(parentKey)!.push(t);
      }
      for (const siblings of siblingGroups.values()) {
        for (let i = 1; i < siblings.length; i++) {
          const task = siblings[i];
          const prev = siblings[i - 1];
          map.set(task.id, () => {
            // Work on the FULL (unfiltered) order so hidden tasks keep their slots
            const fullIds = fullGroupTasks.map((t) => t.id);
            const a = fullIds.indexOf(task.id);
            const b = fullIds.indexOf(prev.id);
            if (a === -1 || b === -1) return;
            const newOrder = [...fullIds];
            [newOrder[a], newOrder[b]] = [newOrder[b], newOrder[a]];
            ensureManualSort();
            scrollAfterReparentRef.current = task.id;
            onReorder(category, project, newOrder);
          });
        }
      }
    };

    for (const { category, directTasks, projects } of grouped) {
      const fullEntry = fullGrouped.get(category);
      if (fullEntry) {
        processGroup(directTasks, fullEntry.direct, category, category);
        for (const { project, tasks: projTasks } of projects) {
          const fullProj = fullEntry.projects.get(project);
          if (fullProj) processGroup(projTasks, fullProj, category, project);
        }
      }
    }
    return map;
  }, [grouped, fullGrouped, onReorder, ensureManualSort]);

  const draggedTask = activeDragId ? sorted.find((t) => t.id === activeDragId) : null;

  // User-controlled collapse only — no auto-collapse during drag
  const isCategoryCollapsed = useCallback((cat: string) => {
    return collapsedCategories.has(cat);
  }, [collapsedCategories]);

  const isProjectCollapsed = useCallback((projKey: string) => {
    return collapsedProjects.has(projKey);
  }, [collapsedProjects]);

  // Click task row (or pinned card) = select + scroll + open session (if any). Never open detail panel.
  // Pinned cards and list rows share identical behavior — single handler, one alias.
  // Multi-select for grouping: Cmd/Ctrl-click (or Shift-click) toggles a task
  // into the selection instead of opening it. A plain click clears the selection
  // and behaves normally. ≥2 same-scope selected tasks reveal a "Group" action bar.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Explicit select mode (toolbar "Select" toggle): every row shows a checkbox and a
  // plain click toggles selection. The modifier-click path keeps working independently.
  const [selectMode, setSelectMode] = useState(false);

  const onSelectToggle = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
      return next;
    });
  }, []);

  // Kebab "Select…" entry — enter select mode with this task already picked.
  const onStartSelect = useCallback((taskId: string) => {
    setSelectMode(true);
    setSelectedIds(new Set([taskId]));
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const handleTaskClick = useCallback((task: Task, e?: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
        return next;
      });
      return; // don't open/focus while building a selection
    }
    if (selectedIds.size > 0) setSelectedIds(new Set()); // plain click clears selection
    const sid = resolveTaskSessionId(task);
    if (sid) onOpenSession?.(sid);
    // Always scroll to position; suppress detail panel (ⓘ button is the only way to open detail)
    onFocusTask?.(task, { openDetail: false });
  }, [onFocusTask, onOpenSession, selectedIds]);

  // Resolve the current selection to actual tasks. Grouping has NO scope rule
  // anymore — any ≥2 tasks can be grouped regardless of category/project (a group
  // is a pure visual cluster). `canGroup` is therefore just "≥2 selected"; it
  // drives the floating action bar's Group enabled/disabled state.
  const selectionInfo = useMemo(() => {
    const picked = tasks.filter((t) => selectedIds.has(t.id));
    // doneCount drives which lifecycle rows the batch menu offers: all-done hides
    // "Complete", none-done hides "Reopen", a mix shows both with counts.
    const doneCount = picked.filter((t) => t.status === 'done' || t.phase === 'COMPLETE').length;
    return { tasks: picked, canGroup: picked.length >= 2, doneCount };
  }, [tasks, selectedIds]);

  const handleGroupSelected = useCallback(() => {
    if (!onGroupTasks || selectionInfo.tasks.length < 2) return;
    onGroupTasks(selectionInfo.tasks.map((t) => t.id));
    exitSelectMode();
  }, [onGroupTasks, selectionInfo, exitSelectMode]);

  // Batch operations from the "Group ▾" side dropdown — apply one action to every
  // selected task, then exit select mode (the action is the user's intent, done).
  const batchSetPriority = useCallback((priority: string) => {
    selectionInfo.tasks.forEach((t) => { if (t.priority !== priority) onSetPriority?.(t.id, priority); });
    exitSelectMode();
  }, [selectionInfo, onSetPriority, exitSelectMode]);

  const batchSetDate = useCallback((date: string | null) => {
    selectionInfo.tasks.forEach((t) => onSetDate?.(t.id, date));
    exitSelectMode();
  }, [selectionInfo, onSetDate, exitSelectMode]);

  const batchSetStartDate = useCallback((date: string | null) => {
    selectionInfo.tasks.forEach((t) => onSetStartDate?.(t.id, date));
    exitSelectMode();
  }, [selectionInfo, onSetStartDate, exitSelectMode]);

  /** Report what a batch op could NOT do. Successes are silent — the rows already
   *  moved. Two distinct outcomes, worded honestly:
   *   - rejected (active children / active session / gone) → "Could not <verb> N"
   *   - `syncOnly` (applied locally, external push failed) → "<verb>d, but N not synced"
   *  Conflating them told the user their tasks weren't completed when they were. */
  const reportBatchFailures = useCallback((outcomes: BatchTaskOutcome[], verb: string) => {
    if (outcomes.length === 0) return;
    const rejected = outcomes.filter((o) => !o.syncOnly);
    const syncOnly = outcomes.filter((o) => o.syncOnly);
    if (rejected.length > 0) {
      notify({
        kind: 'sort',
        severity: 'warning',
        title: `Could not ${verb} ${rejected.length} task${rejected.length === 1 ? '' : 's'}`,
        body: rejected[0].error ?? undefined,
        persistent: false,
        dedupKey: `batch-${verb}`,
      });
    }
    if (syncOnly.length > 0) {
      notify({
        kind: 'sort',
        severity: 'warning',
        title: `${syncOnly.length} task${syncOnly.length === 1 ? '' : 's'} not synced externally`,
        body: syncOnly[0].error ?? undefined,
        persistent: false,
        dedupKey: `batch-${verb}-sync`,
      });
    }
  }, [notify]);

  const batchSetPhase = useCallback(async (phase: string) => {
    const ids = selectionInfo.tasks.map((t) => t.id);
    if (ids.length === 0) return;
    exitSelectMode();
    if (onBatchSetPhase) {
      reportBatchFailures(await onBatchSetPhase(ids, phase), phase === 'COMPLETE' ? 'complete' : 'reopen');
      return;
    }
    // Fallback for a consumer that wires onSetPhase but not the batch prop.
    ids.forEach((id) => setPhaseOrComplete(id, phase));
  }, [selectionInfo, onBatchSetPhase, setPhaseOrComplete, exitSelectMode, reportBatchFailures]);

  const batchDelete = useCallback(async () => {
    const picked = selectionInfo.tasks;
    if (picked.length === 0) return;
    const ok = await confirm({
      title: picked.length === 1
        ? `Delete “${picked[0].title}”?`
        : `Delete ${picked.length} tasks?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const ids = picked.map((t) => t.id);
    exitSelectMode();
    if (onBatchDelete) {
      reportBatchFailures(await onBatchDelete(ids), 'delete');
      return;
    }
    ids.forEach((id) => onDelete?.(id));
  }, [selectionInfo, confirm, onBatchDelete, onDelete, exitSelectMode, reportBatchFailures]);

  const batchPinToTier = useCallback((tier: FocusTier) => {
    // Pin any unpinned task first, then set its tier. The 100ms gap is the same race
    // guard documented in TaskKebabMenu's tier buttons: the pin must register before
    // setTier targets it, or the tier is dropped. Already-pinned tasks need no pin and
    // no delay, so set their tier synchronously.
    selectionInfo.tasks.forEach((t) => {
      const alreadyPinned = pinnedTaskIds?.has(t.id);
      if (alreadyPinned) {
        onSetTier?.(t.id, tier);
      } else {
        onPinTask?.(t.id);
        setTimeout(() => onSetTier?.(t.id, tier), 100);
      }
    });
    exitSelectMode();
  }, [selectionInfo, pinnedTaskIds, onPinTask, onSetTier, exitSelectMode]);

  const handlePinnedCardClick = handleTaskClick;

  const handleExpandDetail = useCallback((task: Task) => {
    setDetailTarget(null);
    onFocusTask ? onFocusTask(task) : navigate(`/tasks/${task.id}`);
  }, [onFocusTask, navigate]);

  const showProjectDetail = useCallback((category: string, project: string) => {
    setDetailTarget({ type: 'project', category, project });
    onClearFocus?.();
  }, [onClearFocus]);

  const showCategoryDetail = useCallback((category: string) => {
    setDetailTarget({ type: 'category', category });
    onClearFocus?.();
  }, [onClearFocus]);

  const handleUpdateTitle = useCallback((id: string, title: string) => {
    if (onUpdate) onUpdate(id, { title });
  }, [onUpdate]);

  // Render one tier's items from its ID array (NOT its Task array): a `group:*`
  // sentinel id — present only while that group is being dragged (the drag start
  // collapses its member run to this single id) — has no Task in the map, so we must
  // walk ids and branch. For a real task id we emit the standalone group chip just
  // before the group's LEAD member (static header at rest); the sentinel emits the
  // chip alone (it IS the whole cluster mid-drag). The chip's key is stable across
  // both states (`group:<gid>:<tier>`) so React keeps the same drag node through the
  // idle→collapsed handoff — dnd-kit's active node must not remount mid-drag.
  const renderTierItems = useCallback((ids: string[], tier: FocusTier, groupMeta: Map<string, GroupRenderInfo>) => {
    const out: ReactNode[] = [];
    for (const id of ids) {
      if (id.startsWith('group:')) {
        const gid = id.slice('group:'.length).replace(/:(focus|satellite|wait)$/, '');
        out.push(
          <GroupChip key={groupSortableId(gid, tier)} groupId={gid} tier={tier}
            label={taskGroups?.[gid] ?? ''} onRename={handleRenameGroup}
            onDissolve={handleDissolveGroup} onHide={handleHideGroup} />
        );
        continue;
      }
      const task = pinnedTaskMap.get(id);
      if (!task) continue;
      const gi = groupMeta.get(id);
      if (gi?.isLead) {
        out.push(
          <GroupChip key={groupSortableId(gi.groupId, tier)} groupId={gi.groupId} tier={tier}
            label={gi.label} onRename={handleRenameGroup}
            onDissolve={handleDissolveGroup} onHide={handleHideGroup} />
        );
      }
      out.push(
        <SortableTierCard key={task.id} task={task} tier={tier} isFocused={focusedTaskId === task.id}
          isVanishing={keepWhileCompleting(task)}
          isSessionOpen={openSessionTaskIds?.has(task.id) ?? false}
          isDetailOpen={focusedTaskId === task.id && !suppressDetail}
          onClick={handlePinnedCardClick} onSetTier={onSetTier} onUnpinTask={onUnpinTask}
          onPinTask={onPinTask} onSetPriority={onSetPriority} onSetDate={onSetDate} onSetStartDate={onSetStartDate} onStar={onStar}
          onExpandDetail={handleExpandDetail} onClearFocus={onClearFocus} onOpenSession={onOpenSession}
          onSetPhase={setPhaseOrComplete} onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
          onDelete={onDelete} groupInfo={gi} selectMode={selectMode}
          isSelected={selectedIds.has(task.id)} onSelectToggle={onSelectToggle}
          onStartSelect={onStartSelect} isGroupTarget={groupTargetId === task.id} />
      );
    }
    return out;
  }, [pinnedTaskMap, taskGroups, focusedTaskId, openSessionTaskIds, suppressDetail, handlePinnedCardClick, onSetTier, onUnpinTask, onPinTask, onSetPriority, onSetDate, onStar, handleExpandDetail, onClearFocus, onOpenSession, setPhaseOrComplete, onUpdate, handleUpdateTitle, onDelete, selectMode, selectedIds, onSelectToggle, onStartSelect, groupTargetId, handleRenameGroup, handleDissolveGroup, handleHideGroup, keepWhileCompleting, recentTick]);

  // The regular task list gets its own PINNED/RECENT-style collapsible bar.
  // Outside the stacked view the Tasks tab IS the list — it can't be folded away.
  const tasksCollapsed = isAll && collapsedSections.has('tasks');
  const tasksVisible = showSection('tasks');
  // Any pinned tier showing? Drives whether the pinned wrapper mounts at all.
  const anyTierVisible = showSection('focus') || showSection('satellite') || showSection('wait');
  const recentVisible = showSection('recent');
  // When both Pinned and Recent are collapsed (or absent), the pinned wrapper
  // shrink-wraps its header rows instead of holding the splitter ratio — no
  // dead blank region pushing the task list down. In a single-section view the
  // region always owns the full panel, so it's never "collapsed" in this sense.
  const pinnedAreaCollapsed = isAll
    && (visiblePinnedTasks.length === 0 || collapsedSections.has('pinned'))
    && (visibleRecentTasks.length === 0 || collapsedSections.has('recent'));
  // Section counts for the tab badges. `focus`/`satellite`/`wait`/`recent` come
  // from the already-computed display arrays, so the badges track exactly what
  // the tab would render (incl. category/filter scoping).
  const sectionCounts: Partial<Record<TodoSection, number>> = {
    focus: focusTasksDisplay.length,
    satellite: satelliteTasksDisplay.length,
    wait: waitTasksDisplay.length,
    recent: visibleRecentTasks.length,
    tasks: isSearchMode ? searchMatches.length : filtered.length,
  };
  // In a single-tier view the tier fills the panel: the persisted per-tier drag
  // height (a cap sized for the old cramped stack) would leave dead space below.
  const tierHeight = (h: number | null) => (isAll && h != null ? { maxHeight: h } : undefined);

  return (
    <div className={`todo-panel${splitterResizing ? ' splitter-resizing' : ''}`} ref={splitterContainerRef}>
      {/* Search bar + View dropdown — single row replaces old tabs + filters + sort */}
      <div className="todo-panel-toolbar">
        <TodoSearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onClear={clearSearch}
          isSearching={isSearching}
          resultCount={searchResultCount}
        />
        {onOpenLauncher && <NewLauncherButton onOpen={onOpenLauncher} />}
        <ViewDropdown
          categories={categories}
          activeCategory={activeCategory}
          onCategoryChange={(cat) => { setActiveCategory(cat); persistTab(cat); onCategoryChange?.(cat); }}
          categoryCounts={categoryCounts}
          hasStarredContent={hasStarredContent}
          phaseFilter={phaseFilter}
          onPhaseFilterChange={(v) => { setPhaseFilter(v); clearFocusOverride(); }}
          priorityFilter={priorityFilter}
          onPriorityFilterChange={(v) => { setPriorityFilter(v); clearFocusOverride(); }}
          tagFilter={tagFilter}
          onTagFilterChange={(v) => { setTagFilter(v); clearFocusOverride(); }}
          availableTags={availableTags}
          dateFilter={dateFilter}
          onDateFilterChange={(v) => { setDateFilter(v); persistDateFilter(v); clearFocusOverride(); }}
          sortBy={sortBy}
          onSortByChange={(v) => { setSortBy(v); persistSortBy(v); }}
          groupBy={groupBy}
          onGroupByChange={(v) => { setGroupBy(v); persistGroupBy(v); }}
          showCompleted={showCompleted}
          onShowCompletedChange={(v) => { setShowCompleted(v); clearFocusOverride(); }}
          onClearAll={() => {
            setActiveCategory(''); persistTab(''); onCategoryChange?.('');
            setPhaseFilter('');
            setPriorityFilter('');
            setTagFilter('');
            setDateFilter(''); persistDateFilter('');
            setSessionFilter('');
            setSourceFilter('all');
            clearFocusOverride();
          }}
        />
        {/* Multi-select grouping is entered from each task's ⋮ menu ("Select…") or
            Cmd/Ctrl/Shift-click — no separate toolbar button (keeps the bar clean). */}
      </div>

      {/* Section tabs — one section owns the panel at a time (see TodoSectionTabs). */}
      <TodoSectionTabs active={effectiveSection} onChange={handleSectionChange} counts={sectionCounts} />

      {/* Unified DndContext wrapping both Pinned + Recent — enables drag from Recent to Pin */}
      {(anyTierVisible || recentVisible) && (visiblePinnedTasks.length > 0 || visibleRecentTasks.length > 0 || hiddenPinnedGroups.length > 0) && (
        <DndContext sensors={pinnedSensors} collisionDetection={closestCenter} onDragStart={handlePinnedDragStart} onDragOver={handlePinnedDragOver} onDragEnd={handlePinnedDragEnd} onDragCancel={handlePinnedDragCancel}>
          <div
            className={`todo-pinned-wrapper${isAll ? '' : ' todo-pinned-wrapper-solo'}`}
            style={
              // Single-section view: this region IS the panel — take all the height.
              // Stacked view: Pinned+Recent both collapsed → shrink-wrap to the header
              // rows (no dead blank region below them). Tasks section collapsed →
              // pinned area takes the freed space. Otherwise honor the splitter ratio.
              !isAll ? { flex: '1 1 auto' }
              : pinnedAreaCollapsed ? { flex: '0 0 auto' }
              : tasksCollapsed ? { flex: '1 1 auto' }
              : { flex: `${1 - listRatio} 1 0%` }
            }
          >
          {/* PINNED section — Focus + Satellite + Wait sub-groups. In a single-tier
              view the "Pinned" wrapper header is dropped (the tab already names the
              tier) and only that tier's subgroup renders. */}
          {anyTierVisible && (visiblePinnedTasks.length > 0 || !isAll) && (
            <div className={`todo-pinned-section${isAll ? '' : ' todo-pinned-section-solo'}`}>
              {isAll && (
              <div className="todo-pinned-header" onClick={() => toggleSection('pinned')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSection('pinned'); }} style={{ cursor: 'pointer' }}>
                <span className={`todo-pinned-chevron${collapsedSections.has('pinned') ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                <span className="todo-pinned-label">Pinned</span>
                <span className="todo-pinned-count">{visiblePinnedTasks.length}</span>
              </div>
              )}
              {!isFolded('pinned') && (
                <>
                  {/* Focus sub-group */}
                  {showSection('focus') && (
                  <div className="todo-pinned-subgroup">
                    {isAll && (
                    <div className="todo-pinned-sublabel" onClick={() => toggleSection('focus')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSection('focus'); }} style={{ cursor: 'pointer' }} title="Current sprint — finish these first">
                      <span className={`todo-pinned-chevron todo-pinned-sub-chevron${collapsedSections.has('focus') ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                      <span className="todo-pinned-sublabel-icon todo-tier-icon-focus">{ICONS.ICON_TIER_FOCUS}</span>
                      <span className="todo-pinned-sublabel-text">Focus</span>
                      <span className="todo-pinned-sublabel-count">{focusTasksDisplay.length}</span>
                    </div>
                    )}
                    {!isFolded('focus') && (
                      <SortableContext items={visibleFocusIds} strategy={verticalListSortingStrategy}>
                        <div className="todo-pinned-list-scroll" style={tierHeight(focusResize.height)}>
                          <TierDropZone id="focus-drop-zone" isEmpty={focusTasksDisplay.length === 0}>
                            {renderTierItems(visibleFocusIds, 'focus', focusGroupMeta)}
                          </TierDropZone>
                          <InlineAdd label="Add to Focus…" onAdd={async (title) => {
                            // capture:true → routes to configured Default Platform/Category (fast local Inbox by default).
                            // No onFocusTask here: handleCreate already locates the new card with
                            // scope 'pinned' (Pinned-region scroll only). Calling onFocusTask would
                            // reset the scope to 'all' and switch the TASKS tab to the capture
                            // category — the "all my tasks disappeared" bug.
                            await onCreate({ title, priority: 'none', pinnedTier: 'focus', capture: true });
                          }} />
                        </div>
                        {/* Per-tier drag handle only makes sense when tiers share the
                            panel; a solo tier already owns the full height. */}
                        {isAll && (
                        <div
                          className={`todo-tier-resize-handle${focusResize.isDragging ? ' dragging' : ''}`}
                          onPointerDown={(e) => focusResize.handlePointerDown(e, e.currentTarget.previousElementSibling as HTMLElement | null)}
                          title="Drag to resize Focus"
                        />
                        )}
                      </SortableContext>
                    )}
                  </div>
                  )}

                  {/* Satellite sub-group */}
                  {showSection('satellite') && (satelliteTasksDisplay.length > 0 || !isAll) && (
                    <div className="todo-pinned-subgroup">
                      {isAll && (
                      <div className="todo-pinned-sublabel" onClick={() => toggleSection('satellite')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSection('satellite'); }} style={{ cursor: 'pointer' }} title="Backlog — other pinned tasks">
                        <span className={`todo-pinned-chevron todo-pinned-sub-chevron${collapsedSections.has('satellite') ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                        <span className="todo-pinned-sublabel-icon todo-tier-icon-satellite">{ICONS.ICON_TIER_SATELLITE}</span>
                        <span className="todo-pinned-sublabel-text">Satellite</span>
                        <span className="todo-pinned-sublabel-count">{satelliteTasksDisplay.length}</span>
                      </div>
                      )}
                      {!isFolded('satellite') && (
                        <SortableContext items={visibleSatelliteIds} strategy={verticalListSortingStrategy}>
                          <div className="todo-pinned-list todo-pinned-list-scroll" style={tierHeight(satelliteResize.height)}>
                            {/* Solo view needs the drop zone so an empty Satellite tab is
                                still a valid drag target — the stacked view can skip it
                                because the tier only renders when non-empty. */}
                            {isAll ? renderTierItems(visibleSatelliteIds, 'satellite', satelliteGroupMeta) : (
                              <TierDropZone id="satellite-drop-zone" isEmpty={satelliteTasksDisplay.length === 0}>
                                {renderTierItems(visibleSatelliteIds, 'satellite', satelliteGroupMeta)}
                              </TierDropZone>
                            )}
                            <InlineAdd label="Add to Satellite…" onAdd={async (title) => {
                              // handleCreate locates with scope 'pinned' — see the Focus InlineAdd note.
                              await onCreate({ title, priority: 'none', pinnedTier: 'satellite', capture: true });
                            }} />
                          </div>
                          {isAll && (
                          <div
                            className={`todo-tier-resize-handle${satelliteResize.isDragging ? ' dragging' : ''}`}
                            onPointerDown={(e) => satelliteResize.handlePointerDown(e, e.currentTarget.previousElementSibling as HTMLElement | null)}
                            title="Drag to resize Satellite"
                          />
                          )}
                        </SortableContext>
                      )}
                    </div>
                  )}

                  {/* Wait sub-group — parked tasks pinned but deprioritized */}
                  {showSection('wait') && (
                  <div className="todo-pinned-subgroup">
                    {isAll && (
                    <div className="todo-pinned-sublabel" onClick={() => toggleSection('wait')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSection('wait'); }} style={{ cursor: 'pointer' }} title="Wait — parked tasks, pinned but not actively worked on">
                      <span className={`todo-pinned-chevron todo-pinned-sub-chevron${collapsedSections.has('wait') ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                      <span className="todo-pinned-sublabel-icon todo-tier-icon-wait">{ICONS.ICON_TIER_WAIT}</span>
                      <span className="todo-pinned-sublabel-text">Wait</span>
                      <span className="todo-pinned-sublabel-count">{waitTasksDisplay.length}</span>
                    </div>
                    )}
                    {!isFolded('wait') && (
                      <SortableContext items={visibleWaitIds} strategy={verticalListSortingStrategy}>
                        <div className="todo-pinned-list-scroll" style={tierHeight(waitResize.height)}>
                          <TierDropZone id="wait-drop-zone" isEmpty={waitTasksDisplay.length === 0}>
                            {renderTierItems(visibleWaitIds, 'wait', waitGroupMeta)}
                          </TierDropZone>
                          <InlineAdd label="Add to Wait…" onAdd={async (title) => {
                            // handleCreate locates with scope 'pinned' — see the Focus InlineAdd note.
                            await onCreate({ title, priority: 'none', pinnedTier: 'wait', capture: true });
                          }} />
                        </div>
                        {isAll && (
                        <div
                          className={`todo-tier-resize-handle${waitResize.isDragging ? ' dragging' : ''}`}
                          onPointerDown={(e) => waitResize.handlePointerDown(e, e.currentTarget.previousElementSibling as HTMLElement | null)}
                          title="Drag to resize Wait"
                        />
                        )}
                      </SortableContext>
                    )}
                  </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Hidden-groups strip — compact chips for groups collapsed out of the tiers
              above, each with an unhide (⊙) affordance. Rendered as a sibling of the
              Pinned section so it shows even when every pinned task is in a hidden
              group (pinnedTasks would be empty then). This is the in-Focus way back —
              without it a hidden group's cards vanish with no local restore point.
              Tier tabs only — unhiding puts cards back into a tier, so the strip
              belongs with the tiers, not with Recent. */}
          {anyTierVisible && hiddenPinnedGroups.length > 0 && (
            <div className="todo-pinned-hidden-strip">
              {hiddenPinnedGroups.map((g) => (
                <button
                  key={g.groupId}
                  className="todo-pinned-hidden-chip"
                  onClick={() => handleUnhideGroup(g.groupId)}
                  title={`Unhide "${g.label}" (${g.count} task${g.count === 1 ? '' : 's'}) back into Focus`}
                >
                  <span className="todo-pinned-hidden-chip-icon" aria-hidden="true">⊙</span>
                  <span className="todo-pinned-hidden-chip-label">{g.label}</span>
                  <span className="todo-pinned-hidden-chip-count">{g.count}</span>
                </button>
              ))}
            </div>
          )}

          {/* Recent tasks section — draggable cards, drop on Pinned tiers to pin.
              When expanded it flex-grows to fill the wrapper's leftover space (no
              dead gap above TASKS); the list scrolls once items exceed that space. */}
          {recentVisible && visibleRecentTasks.length > 0 && (
            <div className={`todo-pinned-section${!isFolded('recent') ? ' todo-pinned-section-recent' : ''}${isAll ? '' : ' todo-pinned-section-solo'}`}>
              {isAll && (
              <div className="todo-pinned-header" onClick={() => toggleSection('recent')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSection('recent'); }} style={{ cursor: 'pointer' }}>
                <span className={`todo-pinned-chevron${collapsedSections.has('recent') ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                <span className="todo-pinned-label">Recent</span>
                <span className="todo-pinned-count">{visibleRecentTasks.length}</span>
              </div>
              )}
              {!isFolded('recent') && (
                <SortableContext items={visibleRecentIds} strategy={verticalListSortingStrategy}>
                  {/* Undragged: flex-grow fills the wrapper's leftover space (no dead gap
                      above TASKS), with a ~3-row min so it stays compact when there's
                      little room. Once dragged, an explicit maxHeight pins the height and
                      the list scrolls past it (persisted via recentResize). The solo tab
                      ignores the dragged cap — that height was picked for the cramped
                      stack and would strand empty space below. */}
                  <div
                    className="todo-pinned-list todo-pinned-list-scroll todo-pinned-list-recent"
                    style={isAll && recentResize.height != null
                      ? { maxHeight: recentResize.height, flex: 'none' }
                      : { minHeight: RECENT_VISIBLE_MAX * 30 }}
                  >
                    {visibleRecentTasks.map((task) => (
                      <SortableRecentCard
                        key={task.id}
                        task={task}
                        isFocused={focusedTaskId === task.id}
                        isVanishing={keepWhileCompleting(task) && !showCompleted}
                        isSessionOpen={openSessionTaskIds?.has(task.id) ?? false}
                        isDetailOpen={focusedTaskId === task.id && !suppressDetail}
                        onClick={handlePinnedCardClick}
                        onPinTask={onPinTask}
                        onUnpinTask={onUnpinTask}
                        isPinned={pinnedTaskIds?.has(task.id)}
                        pinnedTier={getTier(task.id)}
                        onSetPriority={onSetPriority}
                        onSetDate={onSetDate}
                        onSetStartDate={onSetStartDate}
                        onStar={onStar}
                        onSetTier={onSetTier}
                        onExpandDetail={handleExpandDetail}
                        onClearFocus={onClearFocus}
                        onOpenSession={onOpenSession}
                        onSetPhase={setPhaseOrComplete}
                        onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                        onDelete={onDelete}
                      />
                    ))}
                  </div>
                  {isAll && (
                  <div
                    className={`todo-tier-resize-handle${recentResize.isDragging ? ' dragging' : ''}`}
                    onPointerDown={(e) => recentResize.handlePointerDown(e, e.currentTarget.previousElementSibling as HTMLElement | null)}
                    title="Drag to resize Recent"
                  />
                  )}
                </SortableContext>
              )}
            </div>
          )}

          </div>
          {/* Floating preview card during cross-container drag */}
          <DragOverlay dropAnimation={null}>
            {activeDragPinnedTask && (
              <div className="todo-pinned-card todo-pinned-card-dragging">
                <span className="todo-pinned-title" title={activeDragPinnedTask.title}>{activeDragPinnedTask.title}</span>
              </div>
            )}
            {/* Whole-group drag: a stacked preview naming the group + its members so
                the cursor always carries a visible payload while moving a cluster. */}
            {activeDragGroup && (
              <div className="todo-pinned-group-drag-preview">
                <div className="todo-pinned-group-drag-header">
                  <span className="task-group-chip-icon" aria-hidden="true">⑂</span>
                  <span className="todo-pinned-group-drag-label">{activeDragGroup.label}</span>
                  <span className="todo-pinned-group-drag-count">{activeDragGroup.count}</span>
                </div>
                {activeDragGroup.titles.slice(0, 3).map((t, i) => (
                  <div key={i} className="todo-pinned-group-drag-row" title={t}>{t}</div>
                ))}
                {activeDragGroup.titles.length > 3 && (
                  <div className="todo-pinned-group-drag-more">+{activeDragGroup.titles.length - 3} more</div>
                )}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {/* Draggable divider between PINNED+RECENT and the main task list.
          Task detail now opens in a full-screen modal (hosted by MainPage), so only
          the inline project/category pane (detailTarget) compresses the list here. */}
      {isAll && (visiblePinnedTasks.length > 0 || visibleRecentTasks.length > 0) && !detailTarget && !tasksCollapsed && !pinnedAreaCollapsed && (
        <div className="todo-pinned-splitter" {...pinnedSplitterHandleProps} />
      )}

      {/* TASKS header bar — the stacked view's collapsible affordance, matching
          PINNED / RECENT / Notes. The Tasks TAB doesn't get one: the tab strip
          already labels the region, and folding the only visible section away
          would leave an empty panel with no way back except another tab. */}
      {isAll && (
      <div className="todo-pinned-header todo-tasks-header" onClick={() => toggleSection('tasks')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSection('tasks'); }} style={{ cursor: 'pointer' }}>
        <span className={`todo-pinned-chevron${tasksCollapsed ? '' : ' todo-pinned-chevron-open'}`}>{'▸'}</span>
        <span className="todo-pinned-label">Tasks</span>
        <span className="todo-pinned-count">{isSearchMode ? searchMatches.length : filtered.length}</span>
      </div>
      )}

      {tasksVisible && !tasksCollapsed && (
      <div className={`todo-panel-list${!detailTarget && listCollapsed ? ' todo-panel-list-collapsed' : ''}`} style={detailTarget ? { flex: `${1 - detailRatio} 1 0%` } : isAll && (visiblePinnedTasks.length > 0 || visibleRecentTasks.length > 0) && !pinnedAreaCollapsed ? { flex: `${listRatio} 1 0%` } : undefined}>
        {loading && (
          <div className="empty-state" style={{ padding: '24px 8px' }}>
            <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2, margin: '0 auto' }} />
          </div>
        )}
        {!loading && isSearchMode && searchFiltered.length === 0 && (
          <div className="empty-state" style={{ padding: '24px 8px' }}>
            <p className="text-sm">No tasks match &lsquo;{searchQuery}&rsquo;</p>
          </div>
        )}
        {!loading && !isSearchMode && filtered.length === 0 && (
          <div className="empty-state" style={{ padding: '24px 8px' }}>
            <p className="text-sm">No tasks found</p>
          </div>
        )}
        {/* Search mode: flat, score-sorted list (no category/project grouping) */}
        {!loading && isSearchMode && searchFiltered.length > 0 && (
          <div className="todo-search-results">
            {(() => {
              // Compute child maps from searchFiltered (cross-category)
              const searchChildIds = new Set<string>();
              const searchChildCount = new Map<string, number>();
              const searchChildParent = new Map<string, string>();
              for (const task of searchFiltered) {
                if (task.parent_task_id) {
                  const parent = searchFiltered.find(t => t.id.startsWith(task.parent_task_id!));
                  if (parent) {
                    searchChildIds.add(task.id);
                    searchChildParent.set(task.id, parent.id);
                    searchChildCount.set(parent.id, (searchChildCount.get(parent.id) ?? 0) + 1);
                  }
                }
              }
              // Sort: parents first, children right after their parent
              const ordered: typeof searchFiltered = [];
              const emitted = new Set<string>();
              for (const task of searchFiltered) {
                if (emitted.has(task.id)) continue;
                if (searchChildIds.has(task.id)) continue; // skip children on first pass
                emitted.add(task.id);
                ordered.push(task);
                // Insert children right after parent
                for (const child of searchFiltered) {
                  if (!emitted.has(child.id) && child.parent_task_id && task.id.startsWith(child.parent_task_id)) {
                    emitted.add(child.id);
                    ordered.push(child);
                  }
                }
              }
              // Append any remaining (orphan children whose parent wasn't found)
              for (const task of searchFiltered) {
                if (!emitted.has(task.id)) ordered.push(task);
              }
              return ordered.map((task) => {
                // Hide children of collapsed parents
                const searchParentId = searchChildParent.get(task.id);
                if (searchParentId && !expandedParents.has(searchParentId)) return null;
                return (
                  <Fragment key={task.id}>
                  <SortableTaskItem
                    key={task.id}
                    task={task}
                    isFocused={focusedTaskId === task.id}
                    isDetailOpen={focusedTaskId === task.id && !suppressDetail}
                    isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                    isVanishing={recentlyCompletedRef.current.has(task.id) && completedWillHide}
                    isNestTarget={nestTargetId === task.id} isGroupTarget={groupTargetId === task.id}
                    depth={depthMap.get(task.id) ?? 0}
                    childCount={searchChildCount.get(task.id)}
                    isExpanded={expandedParents.has(task.id)}
                    onToggleExpand={() => toggleParentExpand(task.id)}
                    onClick={(e) => handleTaskClick(task, e)}
                  isSelected={selectedIds.has(task.id)}
                  selectMode={selectMode}
                  onSelectToggle={onSelectToggle}
                  onStartSelect={onStartSelect}
                    onSetPhase={setPhaseOrComplete}
                    onStar={onStar}
                    onDelete={onDelete}
                    onSetPriority={onSetPriority}
                    onSetDate={onSetDate}
                    onSetStartDate={onSetStartDate}
                    onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                    onOpenSession={onOpenSession}
                    onExpandDetail={handleExpandDetail}
                    onClearFocus={onClearFocus}
                    onPinTask={onPinTask}
                    onUnpinTask={onUnpinTask}
                    onSetTier={onSetTier}
                    onUnparent={onReparentTask ? handleUnparent : undefined}
                    onMoveUp={moveUpMap.get(task.id)}
                    isPinned={pinnedTaskIds?.has(task.id)}
                    pinnedTier={getTier(task.id)}
                    searchContext={`${task.category}${task.project && task.project !== task.category ? ` / ${task.project}` : ''}`}
                    filterOverrideReason={(task.id === filterOverrideId || task.id === fadingOverrideId) ? filterOverrideReason : undefined}
                    isFadingOverride={fadingOverrideId === task.id}
                  />
                  </Fragment>
                );
              });
            })()}
          </div>
        )}
        {/* Flat mode: ungrouped list sorted by selected sort option */}
        {!loading && !isSearchMode && groupBy === 'none' && sorted.length > 0 && (
          <div className="todo-flat-results">
            {sorted.map((task) => {
              if (isChildHidden(task.id)) return null;
              return (
                <SortableTaskItem
                  key={task.id}
                  task={task}
                  isFocused={focusedTaskId === task.id}
                  isDetailOpen={focusedTaskId === task.id && !suppressDetail}
                  isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                  isVanishing={recentlyCompletedRef.current.has(task.id) && completedWillHide}
                  isNestTarget={nestTargetId === task.id} isGroupTarget={groupTargetId === task.id}
                  depth={depthMap.get(task.id) ?? 0}
                  childCount={trueChildCountMap.get(task.id)}
                  isExpanded={expandedParents.has(task.id)}
                  onToggleExpand={() => toggleParentExpand(task.id)}
                  onClick={(e) => handleTaskClick(task, e)}
                  isSelected={selectedIds.has(task.id)}
                  selectMode={selectMode}
                  onSelectToggle={onSelectToggle}
                  onStartSelect={onStartSelect}
                  onSetPhase={setPhaseOrComplete}
                  onStar={onStar}
                  onDelete={onDelete}
                  onSetPriority={onSetPriority}
                  onSetDate={onSetDate}
                  onSetStartDate={onSetStartDate}
                  onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                  onOpenSession={onOpenSession}
                  onExpandDetail={handleExpandDetail}
                  onClearFocus={onClearFocus}
                  onPinTask={onPinTask}
                  onUnpinTask={onUnpinTask}
                  onUnparent={onReparentTask ? handleUnparent : undefined}
                  onMoveUp={moveUpMap.get(task.id)}
                  isPinned={pinnedTaskIds?.has(task.id)}
                  searchContext={`${task.category}${task.project && task.project !== task.category ? ` / ${task.project}` : ''}`}
                  filterOverrideReason={(task.id === filterOverrideId || task.id === fadingOverrideId) ? filterOverrideReason : undefined}
                  isFadingOverride={fadingOverrideId === task.id}
                  groupInfo={groupRenderMap.get(task.id)}
                  onRenameGroup={handleRenameGroup}
                  onUngroupTask={onUngroupTask}
                  isGroupHidden={!!(task.group_id && hiddenGroups?.has(task.group_id))}
                  onUnhideGroup={handleUnhideGroup}
                  onDissolveGroup={handleDissolveGroup}
                />
              );
            })}
          </div>
        )}
        {/* Normal mode: grouped hierarchy */}
        {!loading && !isSearchMode && groupBy !== 'none' && (
          <DndContext
            sensors={sensors}
            collisionDetection={typeAwareCollision}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={clearDropIntent}
          >
            <SortableContext items={grouped.map((g) => `cat:${g.category}`)} strategy={verticalListSortingStrategy}>
              {grouped.map(({ category, directTasks, projects }) => (
                <SortableGroupItem key={`cat:${category}`} id={`cat:${category}`}>
                  {({ dragHandleProps }: { dragHandleProps: Record<string, unknown> }) => (
                    <div className="todo-group-category">
                      <DroppableHeader id={`hdr-cat:${category}`} category={category} project={category} disabled={activeDragType !== 'task'}>
                        {({ isOver: isHeaderOver, setNodeRef: setHeaderRef }) => (
                          <div ref={setHeaderRef} className={`todo-group-category-header${isHeaderOver ? ' header-drop-active' : ''}`} {...dragHandleProps}>
                            <div className="todo-group-header-controls">
                              <button className={`collapse-chevron${!isCategoryCollapsed(category) ? ' expanded' : ''}`} onClick={(e) => { e.stopPropagation(); toggleCategory(category); }} title="Collapse/Expand">
                                {CHEVRON_ICON}
                              </button>
                              <button className="todo-group-name-btn" onClick={() => showCategoryDetail(category)} title="View category details">
                                <span className="todo-group-category-name">{category}</span>
                                <span className="todo-group-count text-xs text-muted">
                                  {directTasks.length + projects.reduce((sum, p) => sum + p.tasks.length, 0)}
                                </span>
                              </button>
                            </div>
                            {favorites && (
                              <button
                                className="todo-group-fav-btn"
                                onClick={(e) => { e.stopPropagation(); favorites.toggleFavoriteCategory(category); }}
                                title={favorites.isCategoryFavorite(category) ? 'Unfavorite category' : 'Favorite category'}
                              >
                                {favorites.isCategoryFavorite(category) ? '\u2605' : '\u2606'}
                              </button>
                            )}
                          </div>
                        )}
                      </DroppableHeader>
                      {!isCategoryCollapsed(category) && (
                        <>
                          <SortableContext items={directTasks.filter((t) => !isChildHidden(t.id)).map((t) => t.id)} strategy={verticalListSortingStrategy}>
                            {directTasks.map((task) => {
                              if (isChildHidden(task.id)) return null;
                              return (
                                <SortableTaskItem
                                  key={task.id}
                                  task={task}
                                  isFocused={focusedTaskId === task.id}
                                  isDetailOpen={focusedTaskId === task.id && !suppressDetail}
                                  isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                                  isVanishing={recentlyCompletedRef.current.has(task.id) && completedWillHide}
                                  isNestTarget={nestTargetId === task.id} isGroupTarget={groupTargetId === task.id}
                                  depth={depthMap.get(task.id) ?? 0}
                                  childCount={trueChildCountMap.get(task.id)}
                                  isExpanded={expandedParents.has(task.id)}
                                  onToggleExpand={() => toggleParentExpand(task.id)}
                                  onClick={(e) => handleTaskClick(task, e)}
                  isSelected={selectedIds.has(task.id)}
                  selectMode={selectMode}
                  onSelectToggle={onSelectToggle}
                  onStartSelect={onStartSelect}
                                  onSetPhase={setPhaseOrComplete}
                                  onStar={onStar}
                                  onDelete={onDelete}
                                  onSetPriority={onSetPriority}
                                  onSetDate={onSetDate}
                                  onSetStartDate={onSetStartDate}
                                  onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                                  onOpenSession={onOpenSession}
                                  onExpandDetail={handleExpandDetail}
                                  onClearFocus={onClearFocus}
                                  onPinTask={onPinTask}
                                  onUnpinTask={onUnpinTask}
                                  onSetTier={onSetTier}
                                  onUnparent={onReparentTask ? handleUnparent : undefined}
                                  onMoveUp={moveUpMap.get(task.id)}
                    isPinned={pinnedTaskIds?.has(task.id)}
                    pinnedTier={getTier(task.id)}
                                  filterOverrideReason={(task.id === filterOverrideId || task.id === fadingOverrideId) ? filterOverrideReason : undefined}
                                  isFadingOverride={fadingOverrideId === task.id}
                                  groupInfo={groupRenderMap.get(task.id)}
                                  onRenameGroup={handleRenameGroup}
                                  onUngroupTask={onUngroupTask}
                  isGroupHidden={!!(task.group_id && hiddenGroups?.has(task.group_id))}
                  onUnhideGroup={handleUnhideGroup}
                  onDissolveGroup={handleDissolveGroup}
                                />
                              );
                            })}
                            <InlineAdd label={`Add to ${category}…`} onAdd={async (title) => {
                              const result = await onCreate({ title, priority: 'none', category });
                              const newTask = result as Task | undefined;
                              // openDetail:false — quick-add just scrolls to the new card; don't pop the detail panel.
                              if (newTask?.id) onFocusTask?.(newTask, { openDetail: false });
                            }} />
                          </SortableContext>
                          <SortableContext items={projects.map((p) => `proj:${category}/${p.project}`)} strategy={verticalListSortingStrategy}>
                            {projects.map(({ project, tasks: projTasks }) => {
                              const projKey = `${category}/${project}`;
                              return (
                                <SortableGroupItem key={`proj:${projKey}`} id={`proj:${projKey}`}>
                                  {({ dragHandleProps: projDragProps }: { dragHandleProps: Record<string, unknown> }) => (
                                    <div className="todo-group-project">
                                      <DroppableHeader id={`hdr-proj:${category}/${project}`} category={category} project={project} disabled={activeDragType !== 'task'}>
                                        {({ isOver: isProjHeaderOver, setNodeRef: setProjHeaderRef }) => (
                                          <div ref={setProjHeaderRef} className={`todo-group-project-header${isProjHeaderOver ? ' header-drop-active' : ''}`} {...projDragProps}>
                                            <div className="todo-group-header-controls">
                                              <button className={`collapse-chevron${!isProjectCollapsed(projKey) ? ' expanded' : ''}`} onClick={(e) => { e.stopPropagation(); toggleProject(projKey); }} title="Collapse/Expand">
                                                {CHEVRON_ICON}
                                              </button>
                                              <button className="todo-group-name-btn" onClick={() => showProjectDetail(category, project)} title="View project details">
                                                <span className="todo-group-project-name">{project}</span>
                                                <span className="todo-group-count text-xs text-muted">{projTasks.length}</span>
                                              </button>
                                            </div>
                                            {favorites && (
                                              <button
                                                className="todo-group-fav-btn"
                                                onClick={(e) => { e.stopPropagation(); favorites.toggleFavoriteProject(project); }}
                                                title={favorites.isProjectFavorite(project) ? 'Unfavorite project' : 'Favorite project'}
                                              >
                                                {favorites.isProjectFavorite(project) ? '\u2605' : '\u2606'}
                                              </button>
                                            )}
                                          </div>
                                        )}
                                      </DroppableHeader>
                                      {!isProjectCollapsed(projKey) && (
                                        <SortableContext items={projTasks.filter((t) => !isChildHidden(t.id)).map((t) => t.id)} strategy={verticalListSortingStrategy}>
                                          {projTasks.map((task) => {
                                            if (isChildHidden(task.id)) return null;
                                            return (
                                              <SortableTaskItem
                                                key={task.id}
                                                task={task}
                                                isFocused={focusedTaskId === task.id}
                                                isDetailOpen={focusedTaskId === task.id && !suppressDetail}
                                                isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                                                isVanishing={recentlyCompletedRef.current.has(task.id) && completedWillHide}
                                                isNestTarget={nestTargetId === task.id} isGroupTarget={groupTargetId === task.id}
                                                depth={depthMap.get(task.id) ?? 0}
                                                childCount={trueChildCountMap.get(task.id)}
                                                isExpanded={expandedParents.has(task.id)}
                                                onToggleExpand={() => toggleParentExpand(task.id)}
                                                onClick={(e) => handleTaskClick(task, e)}
                  isSelected={selectedIds.has(task.id)}
                  selectMode={selectMode}
                  onSelectToggle={onSelectToggle}
                  onStartSelect={onStartSelect}
                                                onSetPhase={setPhaseOrComplete}
                                                onStar={onStar}
                                                onDelete={onDelete}
                                                onSetPriority={onSetPriority}
                                                onSetDate={onSetDate}
                                                onSetStartDate={onSetStartDate}
                                                onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                                                onOpenSession={onOpenSession}
                                                onExpandDetail={handleExpandDetail}
                                                onClearFocus={onClearFocus}
                                                onPinTask={onPinTask}
                                                onUnpinTask={onUnpinTask}
                                                onSetTier={onSetTier}
                                                onUnparent={onReparentTask ? handleUnparent : undefined}
                                                onMoveUp={moveUpMap.get(task.id)}
                    isPinned={pinnedTaskIds?.has(task.id)}
                    pinnedTier={getTier(task.id)}
                                                filterOverrideReason={(task.id === filterOverrideId || task.id === fadingOverrideId) ? filterOverrideReason : undefined}
                                                isFadingOverride={fadingOverrideId === task.id}
                                                groupInfo={groupRenderMap.get(task.id)}
                                                onRenameGroup={handleRenameGroup}
                                                onUngroupTask={onUngroupTask}
                  isGroupHidden={!!(task.group_id && hiddenGroups?.has(task.group_id))}
                  onUnhideGroup={handleUnhideGroup}
                  onDissolveGroup={handleDissolveGroup}
                                              />
                                            );
                                          })}
                                          <InlineAdd label={`Add to ${project}…`} onAdd={async (title) => {
                                            const result = await onCreate({ title, priority: 'none', category, project });
                                            const newTask = result as Task | undefined;
                                            // openDetail:false — quick-add just scrolls to the new card; don't pop the detail panel.
                                            if (newTask?.id) onFocusTask?.(newTask, { openDetail: false });
                                          }} />
                                        </SortableContext>
                                      )}
                                    </div>
                                  )}
                                </SortableGroupItem>
                              );
                            })}
                          </SortableContext>
                        </>
                      )}
                    </div>
                  )}
                </SortableGroupItem>
              ))}
            </SortableContext>

            <DragOverlay
              modifiers={activeDragType === 'category-group' || activeDragType === 'project-group' ? [snapToCursor] : undefined}
            >
              {activeDragType === 'category-group' && activeDragId ? (
                <div className="drag-overlay-group">
                  {activeDragId.replace('cat:', '')}
                </div>
              ) : activeDragType === 'project-group' && activeDragId ? (
                <div className="drag-overlay-group drag-overlay-group-project">
                  {activeDragId.replace(/^proj:[^/]+\//, '')}
                </div>
              ) : draggedTask ? (
                <TaskItemOverlay task={draggedTask} />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>
      )}

      {/* Detail pane: project or category (inline split-pane). Task detail now
          opens in a full-screen modal hosted by MainPage, not inline here. */}
      {detailTarget && <div className="todo-detail-splitter" {...splitterHandleProps} />}
      {detailTarget?.type === 'project' ? (
        <ProjectDetailPane
          category={detailTarget.category}
          project={detailTarget.project}
          tasks={tasks}
          onClose={() => setDetailTarget(null)}
          style={{ flex: `${detailRatio} 1 0%` }}
        />
      ) : detailTarget?.type === 'category' ? (
        <CategoryDetailPane
          category={detailTarget.category}
          tasks={tasks}
          onClose={() => setDetailTarget(null)}
          onShowProject={(cat, proj) => setDetailTarget({ type: 'project', category: cat, project: proj })}
          style={{ flex: `${detailRatio} 1 0%` }}
        />
      ) : null}

      {/* operationError is surfaced globally via the unified notification toaster (AppShell). */}
      {/* Quick add belongs to the Tasks section — folds away with it, and is absent
          from the other tabs (each tier has its own "Add to <tier>…" inline row). */}
      {tasksVisible && !tasksCollapsed && (
      <form className="todo-panel-add" onSubmit={handleAdd}>
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Quick add task..."
          aria-label="New task title"
        />
        <div className="quick-add-more-wrap">
          <button
            ref={quickMoreBtnRef}
            type="button"
            className={`task-kebab-btn quick-add-more-btn${quickStarred || quickPinnedTier || quickCategory || quickProject ? ' has-selections' : ''}`}
            onClick={() => setQuickMoreOpen(v => !v)}
            aria-label="More options"
            aria-expanded={quickMoreOpen}
            title="More options"
          >
            ⋮
          </button>
          {quickMoreOpen && (
            <div ref={quickMoreMenuRef} className="task-kebab-menu quick-add-menu" role="menu">
              <div className="task-kebab-tier">
                <span className="task-kebab-tier-label">Category</span>
                <select
                  className="quick-add-menu-select"
                  value={quickCategory}
                  onChange={(e) => { setQuickCategory(e.target.value); setQuickProject(''); }}
                  aria-label="Category"
                >
                  <option value="">{effectiveDefaultCategory} (default)</option>
                  {quickAddCategories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="task-kebab-divider" />
              <div className="task-kebab-tier">
                <span className="task-kebab-tier-label">Project</span>
                <select
                  className="quick-add-menu-select"
                  value={quickProject}
                  onChange={(e) => setQuickProject(e.target.value)}
                  aria-label="Project"
                >
                  <option value="">None</option>
                  {[...(quickAddProjectsByCategory.get(effectiveDefaultCategory) ?? [])].map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div className="task-kebab-divider" />
              <button
                type="button"
                className={`task-kebab-item${quickStarred ? ' task-kebab-item-active' : ''}`}
                onClick={() => setQuickStarred(v => !v)}
              >
                <span className="task-kebab-icon">{quickStarred ? '★' : '☆'}</span>
                <span>{quickStarred ? 'Starred' : 'Star'}</span>
              </button>
              <div className="task-kebab-divider" />
              <div className="task-kebab-tier">
                <span className="task-kebab-tier-label">Pin to</span>
                <div className="task-kebab-tier-options">
                  {(['focus', 'satellite', 'wait'] as FocusTier[]).map((t) => {
                    const colors: Record<FocusTier, string> = { focus: 'var(--accent)', satellite: 'var(--fg-muted)', wait: '#8e8e93' };
                    const label = t.charAt(0).toUpperCase() + t.slice(1);
                    return (
                      <button
                        key={t}
                        type="button"
                        className={`task-kebab-tier-btn${quickPinnedTier === t ? ' active' : ''}`}
                        style={{ color: colors[t] }}
                        title={label}
                        onClick={() => setQuickPinnedTier(quickPinnedTier === t ? null : t)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!newTitle.trim()}>
          Add
        </button>
      </form>
      )}
      {/* Notes — a bottom drawer in the stacked view, the whole panel on its own tab
          (`fill`: no header row, no drag handle, editor takes the remaining height). */}
      {showSection('notes') && (
        <GlobalNotesSection
          {...globalNotes}
          fill={!isAll}
          tasks={tasks}
          focusedTaskId={focusedTaskId ?? undefined}
          onTaskClick={(taskId) => {
            const task = tasks.find(t => t.id === taskId);
            if (task) handleTaskClick(task);
          }}
        />
      )}

      {/* Multi-select action bar — shown in explicit select mode, or whenever ≥2 tasks
          are selected (incl. the Cmd/Ctrl-click path). "Group" is enabled once ≥2 tasks
          are picked (no category/project scope rule). "Cancel" abandons the selection and
          leaves select mode (it used to be a confusing "Done"). */}
      {onGroupTasks && (selectMode || selectionInfo.tasks.length >= 2) && (
        <div className="task-selection-bar">
          <span className="task-selection-count">
            {selectionInfo.tasks.length > 0
              ? `${selectionInfo.tasks.length} selected`
              : 'Select tasks to group'}
          </span>
          {/* Group split-button + side dropdown of batch actions (reuses the kebab panel). */}
          <TaskBatchMenu
            count={selectionInfo.tasks.length}
            canGroup={selectionInfo.canGroup}
            onGroup={handleGroupSelected}
            onSetPriorityAll={batchSetPriority}
            onPinAllToTier={batchPinToTier}
            onSetDateAll={batchSetDate}
            onSetStartDateAll={batchSetStartDate}
            onCompleteAll={() => batchSetPhase('COMPLETE')}
            onReopenAll={() => batchSetPhase('TODO')}
            doneCount={selectionInfo.doneCount}
            onDeleteAll={batchDelete}
          />
          <button
            className="task-selection-clear-btn"
            onClick={() => (selectMode ? exitSelectMode() : setSelectedIds(new Set()))}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
});
