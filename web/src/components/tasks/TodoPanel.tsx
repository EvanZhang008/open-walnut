import { useState, useMemo, useCallback, useEffect, useRef, memo, Fragment, type FormEvent, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@walnut/core';
import type { SessionRecord } from '@walnut/core';
import { renderNoteMarkdown, renderMarkdownWithRefs } from '@/utils/markdown';
import { fetchSessionsForTask } from '@/api/sessions';
import { fetchTask } from '@/api/tasks';
import { fetchTriageHistory } from '@/api/chat';
import { useEvent } from '@/hooks/useWebSocket';
import { timeAgo } from '@/utils/time';
import type { ProcessStatus, WorkStatus } from '@walnut/core';
import { WORK_LABELS, WORK_COLORS, PROCESS_COLORS, PROCESS_LABELS, compositeColor, resolveTaskSessionId } from '@/utils/session-status';
import type { UseFavoritesReturn } from '@/hooks/useFavorites';
import type { UseOrderingReturn } from '@/hooks/useOrdering';
import { PriorityBadge } from '../common/PriorityBadge';
import { TodoSearchBar } from './TodoSearchBar';
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
  type DragEndEvent,
  type CollisionDetection,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  defaultAnimateLayoutChanges,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SessionPill } from './SessionPill';
import { PersonIcon } from '../common/PersonIcon';
import { useVerticalSplitter } from '@/hooks/useVerticalSplitter';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';
import { ProjectDetailPane } from './ProjectDetailPane';
import { CategoryDetailPane } from './CategoryDetailPane';

type DetailTarget =
  | { type: 'project'; category: string; project: string }
  | { type: 'category'; category: string }
  | null;

interface TodoPanelProps {
  tasks: Task[];
  loading: boolean;
  onComplete: (id: string) => void;
  onSetPhase?: (id: string, phase: string) => void;
  onCreate: (input: { title: string; priority: string }) => Promise<unknown>;
  onUpdate?: (id: string, updates: { title?: string }) => Promise<unknown>;
  onStar?: (id: string) => void;
  onCyclePriority?: (id: string) => void;
  onFocusTask?: (task: Task) => void;
  onClearFocus?: () => void;
  focusedTaskId?: string;
  favorites?: UseFavoritesReturn;
  ordering?: UseOrderingReturn;
  onReorder?: (category: string, project: string, taskIds: string[]) => void;
  onMoveTask?: (taskId: string, category: string, project: string, insertNearTaskId?: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenTriageForTask?: (taskId: string) => void;
  onPinTask?: (taskId: string) => void;
  onUnpinTask?: (taskId: string) => void;
  pinnedTaskIds?: Set<string>;
  /** Set of session IDs currently displayed in session columns. */
  openSessionIds?: Set<string>;
  operationError?: string | null;
  onClearOperationError?: () => void;
  onOperationError?: (msg: string) => void;
}

const STARRED_TAB = '\u2605';

const PHASE_ICON: Record<string, ReactNode> = {
  TODO: '\u25CB',                    // ○ hollow circle
  IN_PROGRESS: '\u25D0',            // ◐ half-filled
  AGENT_COMPLETE: '\u2713',          // ✓ single check
  AWAIT_HUMAN_ACTION: <PersonIcon />,
  PEER_CODE_REVIEW: '\u22C8',       // ⋈ bowtie
  RELEASE_IN_PIPELINE: '\u25B7',    // ▷ open triangle
  COMPLETE: '\u2713\u2713',          // ✓✓ double check
};

const PHASE_LABEL: Record<string, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'Agent Complete',
  AWAIT_HUMAN_ACTION: 'Await Human Action',
  PEER_CODE_REVIEW: 'Peer Code Review',
  RELEASE_IN_PIPELINE: 'Release in Pipeline',
  COMPLETE: 'Complete',
};

const PHASE_ORDER: string[] = [
  'TODO', 'IN_PROGRESS', 'AGENT_COMPLETE', 'AWAIT_HUMAN_ACTION',
  'PEER_CODE_REVIEW', 'RELEASE_IN_PIPELINE', 'COMPLETE',
];

// ── Session filter icons + labels ──

const SESSION_ICON: Record<string, ReactNode> = {
  in_progress: '\u25D0',             // ◐ half-filled
  agent_complete: '\u23F8',          // ⏸ pause
  await_human_action: <PersonIcon />,
  completed: '\u2713\u2713',         // ✓✓ double check
  error: '\u2716',                   // ✖ cross
};

// Session filter labels — use canonical labels from the single source of truth.
const SESSION_LABEL = WORK_LABELS as Record<string, string>;

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

/** Normalize legacy priority values to current 4-tier system. */
function effectivePriority(p: string): string {
  if (p === 'high') return 'immediate';
  if (p === 'medium') return 'important';
  if (p === 'low') return 'backlog';
  return p;
}

// ── MoreDropdown — inline dropdown for overflow filter chips ──

interface MoreDropdownItem {
  value: string;
  icon: ReactNode;
  label: string;
  count: number;
}

function MoreDropdown({ items, active, onSelect }: { items: MoreDropdownItem[]; active: string; onSelect: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const hasActive = items.some((i) => i.value === active);

  return (
    <div className="filter-more-wrapper" ref={ref}>
      <button
        className={`filter-more-btn${hasActive ? ' has-active' : ''}`}
        onClick={() => setOpen(!open)}
      >
        {hasActive ? items.find((i) => i.value === active)!.icon : 'More'} &#x25BE;
      </button>
      {open && (
        <div className="filter-more-menu">
          {items.map((item) => (
            <button
              key={item.value}
              className={`filter-more-menu-item${active === item.value ? ' active' : ''}`}
              onClick={() => { onSelect(active === item.value ? '' : item.value); setOpen(false); }}
            >
              <span className="filter-more-icon">{item.icon}</span>
              <span>{item.label}</span>
              <span className="filter-more-count">{item.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Due date formatter ──

function formatDueDate(iso: string): { label: string; overdue: boolean } {
  const now = new Date();
  const due = new Date(iso);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.floor((dueDay.getTime() - todayStart.getTime()) / 86400000);
  if (diffDays < 0) return { label: 'Overdue', overdue: true };
  if (diffDays === 0) return { label: 'Today', overdue: false };
  if (diffDays === 1) return { label: 'Tomorrow', overdue: false };
  return { label: `${due.getMonth() + 1}/${due.getDate()}/${String(due.getFullYear()).slice(2)}`, overdue: false };
}

// ── LocalStorage persistence helpers ──

const LS_TAB_KEY = 'walnut-todo-active-tab';
const LS_COLLAPSED_CATS_KEY = 'walnut-todo-collapsed-cats';
const LS_COLLAPSED_PROJS_KEY = 'walnut-todo-collapsed-projs';
const LS_EXPANDED_PARENTS_KEY = 'walnut-todo-expanded-parents';
const LS_FILTERS_COLLAPSED_KEY = 'walnut-todo-filters-collapsed';
const LS_SORT_KEY = 'walnut-todo-sortBy';
const LS_GROUP_KEY = 'walnut-todo-groupBy';

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
  isRecentlyDone?: boolean;
  depth?: number;               // Nesting depth (0 = top-level, 1 = child, 2 = grandchild, etc.)
  childCount?: number;
  isExpanded?: boolean;           // Whether children are visible (only for parents)
  onToggleExpand?: () => void;    // Toggle children visibility
  onClick: () => void;
  onSetPhase: (id: string, phase: string) => void;
  onStar?: (id: string) => void;
  onCyclePriority?: (id: string) => void;
  onUpdateTitle?: (id: string, title: string) => void;
  onOpenSession?: (sessionId: string) => void;
  openSessionIds?: Set<string>;
  onPinTask?: (taskId: string) => void;
  onUnpinTask?: (taskId: string) => void;
  isPinned?: boolean;
  searchContext?: string; // Category/Project context pill shown in search mode
  searchMatchField?: string;  // Best keyword field ('title','note',etc.) or 'semantic'
  searchScore?: number;       // Combined normalized score [0,1]
  searchKeywordScore?: number;  // Normalized keyword contribution [0,1]
  searchSemanticScore?: number; // Normalized semantic contribution [0,1]
}

function SortableTaskItem({ task, isFocused, isRecentlyDone, depth = 0, childCount, isExpanded, onToggleExpand, onClick, onSetPhase, onStar, onCyclePriority, onUpdateTitle, onOpenSession, openSessionIds, onPinTask, onUnpinTask, isPinned, searchContext, searchMatchField, searchScore, searchKeywordScore, searchSemanticScore }: SortableTaskItemProps) {
  const integrations = useIntegrations();
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { type: 'task' }, animateLayoutChanges: noAnimateAfterDrag });

  // Combined ref: sortable + scroll-into-view on focus
  const itemRef = useRef<HTMLDivElement | null>(null);
  const wasFocusedRef = useRef(false);
  const setNodeRef = useCallback((node: HTMLDivElement | null) => {
    setSortableRef(node);
    itemRef.current = node;
  }, [setSortableRef]);

  // Scroll this item into view when it becomes focused (scoped to .todo-panel-list only)
  useEffect(() => {
    if (isFocused && !wasFocusedRef.current && itemRef.current) {
      const el = itemRef.current;
      const listContainer = el.closest('.todo-panel-list');
      if (listContainer) {
        const elRect = el.getBoundingClientRect();
        const containerRect = listContainer.getBoundingClientRect();
        if (elRect.top < containerRect.top || elRect.bottom > containerRect.bottom) {
          // Calculate absolute position within scroll container, center it
          const elTopInContainer = elRect.top - containerRect.top + listContainer.scrollTop;
          listContainer.scrollTop = elTopInContainer - containerRect.height / 3;
        }
      }
    }
    wasFocusedRef.current = isFocused;
  }, [isFocused]);

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
    ...(depth > 0 ? { paddingLeft: `${depth * 20}px` } : {}),
  };

  const isDone = task.phase === 'COMPLETE';

  // Phase picker dropdown state
  const [phaseMenuOpen, setPhaseMenuOpen] = useState(false);
  const phaseWrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!phaseMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (phaseWrapperRef.current && !phaseWrapperRef.current.contains(e.target as Node)) {
        setPhaseMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [phaseMenuOpen]);

  const className = [
    'todo-panel-item',
    isDone ? 'todo-panel-item-done' : '',
    isRecentlyDone ? 'todo-panel-item-recently-done' : '',
    isFocused ? 'task-focused' : '',
  ].filter(Boolean).join(' ');

  const dueDateInfo = task.due_date ? formatDueDate(task.due_date) : null;

  // Inline title editing via contentEditable (preserves wrapping/layout)
  const [isEditing, setIsEditing] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const clickPosRef = useRef<{ x: number; y: number } | null>(null);

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
    if (!isEditing) return;
    setIsEditing(false);
    const trimmed = (titleRef.current?.textContent ?? '').trim();
    if (trimmed && trimmed !== task.title && onUpdateTitle) {
      onUpdateTitle(task.id, trimmed);
    } else if (titleRef.current) {
      titleRef.current.textContent = task.title;
    }
  }, [isEditing, task.title, task.id, onUpdateTitle]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    if (titleRef.current) titleRef.current.textContent = task.title;
  }, [task.title]);

  const handleTitleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!onUpdateTitle) return;
    clickPosRef.current = { x: e.clientX, y: e.clientY };
    setIsEditing(true);
  }, [onUpdateTitle]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={className}
      data-task-id={task.id}
      onClick={(e) => {
        if (isEditing) return;
        // Ignore clicks on the title text (handled by its own click for inline editing)
        if ((e.target as HTMLElement).closest('.todo-item-title')) return;
        onClick();
      }}
      onKeyDown={(e) => { if (e.key === 'Enter' && !isEditing) onClick(); }}
      {...attributes}
      {...listeners}
    >
      {childCount > 0 ? (
        <button
          className={`collapse-chevron task-collapse-chevron${isExpanded ? ' expanded' : ''}`}
          title={isExpanded ? 'Collapse child tasks' : `Expand ${childCount} child task(s)`}
          onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
        >
          {CHEVRON_ICON}
        </button>
      ) : (
        <span className="collapse-chevron-spacer" />
      )}
      <div className="phase-picker-wrapper" ref={phaseWrapperRef}>
        <button
          className={`task-status-btn task-status-${task.status} task-phase-${task.phase?.toLowerCase()}`}
          onClick={(e) => {
            e.stopPropagation();
            setPhaseMenuOpen(!phaseMenuOpen);
          }}
          aria-label={PHASE_LABEL[task.phase] ?? 'Change phase'}
          title={PHASE_LABEL[task.phase] ?? 'Change phase'}
        >
          {PHASE_ICON[task.phase] ?? '\u25CB'}
        </button>
        {phaseMenuOpen && (
          <div className="phase-picker-menu">
            {PHASE_ORDER.map((phase) => (
              <button
                key={phase}
                className={`phase-picker-item${task.phase === phase ? ' active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (task.phase !== phase) onSetPhase(task.id, phase);
                  setPhaseMenuOpen(false);
                }}
              >
                <span className={`phase-picker-icon task-phase-${phase.toLowerCase()}`}>
                  {PHASE_ICON[phase]}
                </span>
                <span>{PHASE_LABEL[phase]}</span>
                {task.phase === phase && <span className="phase-picker-check">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="todo-item-content">
        <div className="todo-item-title-row">
          <span
            ref={titleRef}
            className={`todo-item-title${isEditing ? ' editing' : ''}`}
            contentEditable={isEditing}
            suppressContentEditableWarning
            onClick={isEditing ? (e) => e.stopPropagation() : handleTitleClick}
            onBlur={isEditing ? commitEdit : undefined}
            onKeyDown={isEditing ? (e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
              if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
            } : undefined}
          >
            {task.title}
          </span>
          {task.needs_attention && !isDone && (
            <span className="task-attention-dot" title="Needs your attention" role="img" aria-label="Needs your attention" />
          )}
        </div>
        <div className="todo-item-meta-row">
          <SessionPill
            sessionId={task.session_id}
            sessionStatus={task.session_status}
            planSessionId={task.plan_session_id}
            execSessionId={task.exec_session_id}
            planStatus={task.plan_session_status}
            execStatus={task.exec_session_status}
            sessionIds={task.session_ids}
            mode={task.session_status?.mode ?? task.exec_session_status?.mode ?? task.plan_session_status?.mode}
            isActive={openSessionIds ? !!(
              (task.session_id && openSessionIds.has(task.session_id)) ||
              (task.exec_session_id && openSessionIds.has(task.exec_session_id)) ||
              (task.plan_session_id && openSessionIds.has(task.plan_session_id)) ||
              (task.session_ids?.some(sid => openSessionIds.has(sid)))
            ) : false}
            onClick={onOpenSession ? () => {
              const sid = resolveTaskSessionId(task);
              if (sid) onOpenSession(sid);
              onClick(); // Also select the task
            } : undefined}
          />
          {dueDateInfo && (
            <span className={`todo-item-due-pill${dueDateInfo.overdue ? ' todo-item-due-overdue' : ''}`}>
              {dueDateInfo.label}
            </span>
          )}
          {task.sprint && (
            <span className="todo-item-sprint-pill" title={`Sprint: ${task.sprint}`}>
              {task.sprint}
            </span>
          )}
          {!!(task as Record<string, unknown>).is_blocked && !isDone && (
            <span className="task-blocked-badge" title="Blocked by dependencies">
              blocked
            </span>
          )}
          {!!childCount && (
            <span className="task-children-badge">{childCount} sub</span>
          )}
          {task.source && (() => {
            const meta = getIntegrationMeta(integrations, task.source);
            const badge = task.source === 'local' ? 'L' : (meta?.badge ?? task.source.charAt(0).toUpperCase());
            const integrationName = task.source === 'local' ? 'Local' : (meta?.name ?? task.source);
            const badgeColor = meta?.badgeColor;
            const synced = task.source !== 'local' && (!!task.ext?.[task.source] || !!((task as unknown as Record<string, unknown>)[({ 'ms-todo': 'ms_todo_id' } as Record<string, string>)[task.source] ?? '']));
            const errorClass = task.sync_error ? ' task-source-badge-error' : '';
            const unsyncedClass = !task.sync_error && task.source !== 'local' && !synced ? ' task-source-badge-unsynced' : '';
            return (
              <span
                className={`task-source-badge${errorClass}${unsyncedClass}`}
                style={!task.sync_error && !unsyncedClass && badgeColor ? { background: badgeColor, color: 'white' } : task.source === 'local' ? { background: '#8E8E93', color: 'white' } : undefined}
                title={
                  task.sync_error
                    ? `Sync error: ${task.sync_error}`
                    : task.source === 'local'
                      ? 'Local only — not synced'
                      : synced ? `Synced to ${integrationName}` : `Not synced to ${integrationName} — will retry`
                }
              >
                {task.sync_error ? '!' : badge}
              </span>
            );
          })()}
          {task.external_url && (() => {
            const meta = getIntegrationMeta(integrations, task.source);
            const label = meta?.externalLinkLabel ?? meta?.name ?? 'external';
            return (
              <a
                className="task-external-link"
                href={task.external_url}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open in ${label}`}
                onClick={(e) => e.stopPropagation()}
              >
                &#x2197;
              </a>
            );
          })()}
          {isDone && task.completed_at && (
            <span className="task-completed-time">{timeAgo(task.completed_at)}</span>
          )}
          {searchScore != null && (() => {
            const kwW = (searchKeywordScore ?? 0) * 0.4;
            const semW = (searchSemanticScore ?? 0) * 0.6;
            const kwDominant = kwW >= semW;
            return (
              <span className={`todo-search-score-pill todo-search-score-${kwDominant ? 'keyword' : 'semantic'}`}>
                {searchScore.toFixed(2)}
                <span className="todo-search-score-tooltip">
                  <span className={`todo-search-score-row${kwDominant ? ' is-dominant' : ''}`}>
                    <span className="todo-search-score-label keyword-label">Keyword</span>
                    {kwW > 0
                      ? <><span className="todo-search-score-val">{kwW.toFixed(2)}</span><span className="todo-search-score-field">{searchMatchField && searchMatchField !== 'semantic' ? searchMatchField : ''}</span></>
                      : <span className="todo-search-score-none">—</span>
                    }
                  </span>
                  <span className={`todo-search-score-row${!kwDominant ? ' is-dominant' : ''}`}>
                    <span className="todo-search-score-label semantic-label">Semantic</span>
                    {semW > 0
                      ? <span className="todo-search-score-val">{semW.toFixed(2)}</span>
                      : <span className="todo-search-score-none">—</span>
                    }
                  </span>
                </span>
              </span>
            );
          })()}
          {searchContext && (
            <span className="todo-search-context-pill" title={searchContext}>
              {searchContext}
            </span>
          )}
        </div>
      </div>
      <div className="todo-item-actions">
        <PriorityBadge
          priority={task.priority}
          onClick={onCyclePriority ? (e) => { e.stopPropagation(); onCyclePriority(task.id); } : undefined}
        />
        {onStar && (
          <button
            className={`task-star-btn${task.starred ? ' starred' : ''}`}
            onClick={(e) => { e.stopPropagation(); onStar(task.id); }}
            title={task.starred ? 'Unstar' : 'Star'}
          >
            {task.starred ? '\u2605' : '\u2606'}
          </button>
        )}
        {onPinTask && !isPinned && (
          <button
            className="task-pin-btn"
            onClick={(e) => { e.stopPropagation(); onPinTask(task.id); }}
            title="Pin to Focus Dock"
          >
            &#x1F4CC;
          </button>
        )}
        {isPinned && onUnpinTask && (
          <button
            className="task-pin-btn task-pinned-indicator"
            onClick={(e) => { e.stopPropagation(); onUnpinTask(task.id); }}
            title="Unpin from Focus Dock"
          >
            &#x1F4CC;
          </button>
        )}
      </div>
    </div>
  );
}

// ── Static task item for DragOverlay ──

function TaskItemOverlay({ task }: { task: Task }) {
  return (
    <div className="todo-panel-item drag-overlay-item">
      <span className={`task-status-btn task-status-${task.status} task-phase-${task.phase?.toLowerCase()}`}>
        {PHASE_ICON[task.phase] ?? '\u25CB'}
      </span>
      <div className="todo-item-content">
        <span className="todo-item-title">{task.title}</span>
      </div>
      <PriorityBadge priority={task.priority} />
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

// ── SortableCategoryTab ──

interface SortableCategoryTabProps {
  id: string;
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
  isLocal?: boolean;
}

function SortableCategoryTab({ id, active, children, onClick, isLocal }: SortableCategoryTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, data: { type: 'category-tab' } });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  return (
    <button
      ref={setNodeRef}
      style={style}
      className={`todo-panel-tab${active ? ' todo-panel-tab-active' : ''}`}
      onClick={onClick}
      {...attributes}
      {...listeners}
    >
      {children}
      {isLocal && <span className="todo-panel-tab-source-badge" title="Local only — not synced">L</span>}
    </button>
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

type SortBy = 'priority' | 'date' | 'updated';
type GroupBy = 'category' | 'none';

const PRIORITY_RANK: Record<string, number> = { immediate: 0, important: 1, backlog: 2, none: 3 };

function readSortBy(): SortBy {
  try {
    const v = localStorage.getItem(LS_SORT_KEY);
    if (v === 'priority' || v === 'date' || v === 'updated') return v;
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

// Session info colors — imported from single source of truth.
// Re-exported as local aliases for backwards compat with type signature.
const processDotColors = PROCESS_COLORS as Record<ProcessStatus, string>;
const workStatusColors = WORK_COLORS as Record<WorkStatus, string>;


function truncateCwd(p: string): string {
  const segments = p.split('/').filter(Boolean);
  return segments.length > 0 ? segments.slice(-2).join('/') : p;
}

/**
 * Reverse conversation log entries so newest appear first.
 * Splits on `### YYYY-MM-DD HH:MM` headings (one per entry), reverses, and rejoins.
 * Storage stays append-only — reversal is render-time only.
 */
function reverseConversationLogEntries(log: string): string {
  const entries = log.split(/(?=^### \d{4}-\d{2}-\d{2} \d{2}:\d{2})/m).filter(Boolean);
  if (entries.length <= 1) return log;
  return entries.reverse().join('\n\n');
}

// ── TaskDetailPane ──

function TaskDetailPane({ task, allTasks, onClose, onOpenSession, onOpenTriageForTask, onFocusChild, style }: { task: Task; allTasks?: Task[]; onClose?: () => void; onOpenSession?: (sessionId: string) => void; onOpenTriageForTask?: (taskId: string) => void; onFocusChild?: (task: Task) => void; style?: CSSProperties }) {
  const navigate = useNavigate();
  const integrations = useIntegrations();
  const hasDescription = !!task.description;
  const hasSummary = !!task.summary;
  // Support slim mode: has_note/has_conversation_log are set when content was stripped
  const hasNote = !!task.note || !!(task as Record<string, unknown>).has_note;
  const hasConversationLog = !!task.conversation_log || !!(task as Record<string, unknown>).has_conversation_log;

  // Lazy-load full task when note/conversation_log content is needed but stripped (slim mode)
  const [fullTask, setFullTask] = useState<Task | null>(null);
  useEffect(() => { setFullTask(null); }, [task.id]); // Reset on task change
  const needsFullLoad = (hasNote && !task.note) || (hasConversationLog && !task.conversation_log);
  useEffect(() => {
    if (!needsFullLoad || fullTask) return;
    let cancelled = false;
    fetchTask(task.id).then((t) => { if (!cancelled) setFullTask(t); }).catch(() => {});
    return () => { cancelled = true; };
  }, [needsFullLoad, fullTask, task.id]);
  // Use full task data when available for note/conversation_log rendering
  const noteContent = task.note ?? fullTask?.note;
  const conversationLogContent = task.conversation_log ?? fullTask?.conversation_log;
  const hasSubtasks = task.subtasks && task.subtasks.length > 0;
  const dueDateInfo = task.due_date ? formatDueDate(task.due_date) : null;

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
      const rec = sessionRecords.get(sid);
      if (rec?.archived) { archived++; continue; }
      // Keep IDs that either have a non-archived record or haven't been fetched yet
      if (rec || !sessionRecords.size) visible.push(sid);
    }
    // Also include API-returned non-archived sessions not in allSessionIds (e.g. embedded)
    for (const [sid, rec] of sessionRecords) {
      if (rec.archived) continue;
      if (!allSessionIds.includes(sid)) visible.push(sid);
    }
    return { visibleSessionIds: visible, archivedCount: archived };
  }, [allSessionIds, sessionRecords]);

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

  // Live-update session records when status/mode changes via WebSocket
  useEvent('session:status-changed', (data) => {
    const { sessionId, taskId, mode, work_status, process_status, planCompleted } = data as {
      sessionId?: string; taskId?: string; mode?: string;
      work_status?: string; process_status?: string; planCompleted?: boolean;
    };
    if (taskId !== task.id || !sessionId) return;
    setSessionRecords((prev) => {
      const record = prev.get(sessionId);
      if (!record) return prev;
      const updated = new Map(prev);
      const patched = { ...record };
      if (mode !== undefined) patched.mode = mode as SessionRecord['mode'];
      if (work_status !== undefined) patched.work_status = work_status as SessionRecord['work_status'];
      if (process_status !== undefined) patched.process_status = process_status as SessionRecord['process_status'];
      if (planCompleted !== undefined) patched.planCompleted = planCompleted;
      updated.set(sessionId, patched);
      return updated;
    });
  });

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
        {dueDateInfo && (
          <span className={`todo-item-due-pill${dueDateInfo.overdue ? ' todo-item-due-overdue' : ''}`}>
            {dueDateInfo.label}
          </span>
        )}
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
          {task.sprint && (
            <span className="todo-detail-sprint-pill">{task.sprint}</span>
          )}
        </div>
        <div className="todo-detail-dates text-xs text-muted">
          {task.created_at && <span>Created {timeAgo(task.created_at)}</span>}
          {task.updated_at && <span> · Updated {timeAgo(task.updated_at)}</span>}
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
                const taskStatus = task.session_status;
                const processStatus = taskStatus?.process_status || 'stopped';
                const workStatus = taskStatus?.work_status || 'agent_complete';
                const isPlan = taskStatus?.mode === 'plan';
                const statusLabel = WORK_LABELS[workStatus] ?? workStatus;
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
                      <span className="todo-detail-ws-pill" style={{ color: workStatusColors[workStatus] ?? 'var(--fg-muted)', borderColor: workStatusColors[workStatus] ?? 'var(--fg-muted)' }}>
                        {statusLabel}
                      </span>
                    </div>
                  </div>
                );
              })
            ) : (
              visibleSessionIds.filter((sid) => sessionRecords.has(sid)).map((sid) => {
                const record = sessionRecords.get(sid);
                const processStatus = record?.process_status || 'stopped';
                const workStatus = record?.work_status || 'agent_complete';
                const label = record?.title || 'Untitled session';
                const ago = timeAgo(record?.lastActiveAt || record?.startedAt || '');
                const isPlan = record?.mode === 'plan';
                const modeLabel = record?.mode && record.mode !== 'default' && record.mode !== 'plan' && !record?.planCompleted ? record.mode : null;
                const statusLabel = (WORK_LABELS[workStatus] ?? workStatus) + (modeLabel ? ` · ${modeLabel}` : '');
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
                    {/* Row 2: work_status pill + activity */}
                    <div className="todo-detail-session-meta">
                      <span
                        className="todo-detail-ws-pill"
                        style={{
                          color: workStatusColors[workStatus] ?? 'var(--fg-muted)',
                          borderColor: workStatusColors[workStatus] ?? 'var(--fg-muted)',
                        }}
                      >
                        {statusLabel}
                      </span>
                      {record?.activity && workStatus === 'in_progress' && (
                        <span className="text-xs text-muted" style={{ fontStyle: 'italic' }}>
                          — {record.activity}
                        </span>
                      )}
                    </div>
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

      {hasSummary && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Summary <span className="text-xs text-muted">(AI)</span></div>
          <div className="todo-detail-note markdown-body" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(task.summary) }} />
        </div>
      )}

      {hasConversationLog && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Conversation Log</div>
          {conversationLogContent
            ? <div className="todo-detail-note markdown-body conversation-log" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(reverseConversationLogEntries(conversationLogContent)) }} />
            : <div className="text-sm text-muted">Loading...</div>
          }
        </div>
      )}

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
          <div className="todo-detail-note markdown-body" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(task.description) }} />
        </div>
      )}

      {hasSubtasks && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Subtasks ({task.subtasks!.filter(s => s.done).length}/{task.subtasks!.length})</div>
          <ul className="todo-detail-subtasks">
            {task.subtasks!.map((st) => (
              <li key={st.id} className={st.done ? 'done' : ''}>
                <span className="todo-detail-subtask-check">{st.done ? '\u2713' : '\u25CB'}</span>
                {st.title}
              </li>
            ))}
          </ul>
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

      {!hasDescription && !hasSummary && !hasNote && !hasConversationLog && !hasSubtasks && !hasSessions && triageTotal === 0 && (
        <div className="todo-detail-empty text-sm text-muted">No details</div>
      )}
    </div>
  );
}

// ── TodoPanel ──

export const TodoPanel = memo(function TodoPanel({ tasks: rawTasks, loading, onComplete, onSetPhase, onCreate, onUpdate, onStar, onCyclePriority, onFocusTask, onClearFocus, focusedTaskId, favorites, ordering, onReorder, onMoveTask, onOpenSession, onOpenTriageForTask, onPinTask, onUnpinTask, pinnedTaskIds, openSessionIds, operationError, onClearOperationError, onOperationError }: TodoPanelProps) {
  // Hide .metadata* tasks (project/category configuration tasks, not user-visible)
  const tasks = useMemo(() => rawTasks.filter((t) => !t.title.startsWith('.metadata')), [rawTasks]);
  const navigate = useNavigate();
  const [showCompleted, setShowCompleted] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState('');
  const [phaseFilter, setPhaseFilter] = useState('');
  const [sessionFilter, setSessionFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>(readSortBy);
  const [groupBy, setGroupBy] = useState<GroupBy>(readGroupBy);
  const [filtersCollapsed, setFiltersCollapsed] = useState(() => {
    try { return localStorage.getItem(LS_FILTERS_COLLAPSED_KEY) !== '0'; } catch { return true; }
  });
  const [activeCategory, setActiveCategory] = useState(readTab);
  const integrations = useIntegrations();
  const [newTitle, setNewTitle] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_CATS_KEY));
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_PROJS_KEY));
  // Tracks which parent tasks the user has EXPANDED (default = all collapsed)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => readSetFromStorage(LS_EXPANDED_PARENTS_KEY));
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragType, setActiveDragType] = useState<string | null>(null);
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);

  // Search state
  const { query: searchQuery, setQuery: setSearchQuery, results: searchResults, isSearching, clearSearch } = useTaskSearch();

  // Vertical splitter for list/detail ratio
  const { ratio: detailRatio, containerRef: splitterContainerRef, handleMouseDown: splitterMouseDown, isResizing: splitterResizing } = useVerticalSplitter();

  // Determine if search mode is active (query entered)
  const isSearchMode = searchQuery.trim().length > 0;

  // Track previous focusedTaskId to detect new focus (not re-renders)
  const prevFocusedRef = useRef<string | undefined>(undefined);

  // Auto-switch tab, expand groups, and scroll to task when focusedTaskId changes
  useEffect(() => {
    if (!focusedTaskId || focusedTaskId === prevFocusedRef.current) {
      prevFocusedRef.current = focusedTaskId;
      return;
    }
    prevFocusedRef.current = focusedTaskId;

    const task = tasks.find((t) => t.id === focusedTaskId);
    if (!task) return;

    // Switch to the correct category tab (unless already showing All or Starred with this task visible)
    const cat = task.category || 'Uncategorized';
    if (activeCategory !== '' && activeCategory !== cat && activeCategory !== STARRED_TAB) {
      setActiveCategory(cat);
      persistTab(cat);
    } else if (activeCategory === STARRED_TAB) {
      // If task isn't visible under starred tab, switch to its category
      const isStarred = !!task.starred;
      const isCatFav = favorites?.isCategoryFavorite(cat) ?? false;
      const isProjFav = favorites?.isProjectFavorite(task.project) ?? false;
      if (!isStarred && !isCatFav && !isProjFav && !isChildOfStarredParent(task)) {
        setActiveCategory(cat);
        persistTab(cat);
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

    // Auto-reveal: adjust filters if the focused task is hidden by current filters
    const isDone = task.status === 'done';
    if (isDone && !showCompleted && phaseFilter !== 'COMPLETE') {
      setShowCompleted(true);
    }
    if (priorityFilter && effectivePriority(task.priority) !== priorityFilter) {
      setPriorityFilter('');
    }
    if (phaseFilter && task.phase !== phaseFilter) {
      setPhaseFilter('');
    }
    if (sessionFilter && (!task.session_work_statuses || !task.session_work_statuses.includes(sessionFilter as typeof task.session_work_statuses[number]))) {
      setSessionFilter('');
    }
    if (sourceFilter !== 'all' && (task.source || 'ms-todo') !== sourceFilter) {
      setSourceFilter('all');
    }

    // Note: actual scroll-into-view is handled by SortableTaskItem itself
    // when isFocused transitions to true (scoped to .todo-panel-list only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedTaskId, tasks, activeCategory, collapsedCategories, collapsedProjects, favorites]);

  const focusedTask = useMemo(() => {
    if (!focusedTaskId) return null;
    return tasks.find((t) => t.id === focusedTaskId) ?? null;
  }, [tasks, focusedTaskId]);

  // Resolve pinned task IDs to Task objects for the pinned section
  const pinnedTasks = useMemo(() => {
    if (!pinnedTaskIds || pinnedTaskIds.size === 0) return [];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    return [...pinnedTaskIds].map((id) => taskMap.get(id)).filter(Boolean) as Task[];
  }, [tasks, pinnedTaskIds]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const tabSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Recently completed: tracks tasks completed in the last 10s for visual styling
  // (isRecentlyDone green tint). NOT used for filtering — the filter unconditionally
  // hides done tasks when showCompleted is false.
  const recentlyCompletedRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [, setRecentTick] = useState(0);

  useEffect(() => {
    const GRACE_MS = 10_000;
    for (const task of tasks) {
      if (task.status === 'done' && task.completed_at && !recentlyCompletedRef.current.has(task.id)) {
        const elapsed = Date.now() - new Date(task.completed_at).getTime();
        if (elapsed >= 0 && elapsed < GRACE_MS) {
          recentlyCompletedRef.current.add(task.id);
          const timerId = setTimeout(() => {
            recentlyCompletedRef.current.delete(task.id);
            timersRef.current.delete(task.id);
            setRecentTick((n) => n + 1);
          }, GRACE_MS - elapsed);
          timersRef.current.set(task.id, timerId);
        }
      }
    }
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

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.category) set.add(t.category);
    const names = Array.from(set);
    return orderedSort(names, ordering?.categoryOrder ?? []);
  }, [tasks, ordering?.categoryOrder]);

  // Map category → source (derived from first task in each category)
  const localCategories = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) {
      if (t.source === 'local') s.add(t.category);
    }
    return s;
  }, [tasks]);

  // Show starred tab when there are starred tasks or favorited categories/projects
  const hasStarredContent = useMemo(() => {
    const hasStarredTasks = tasks.some((t) => t.starred);
    const hasFavorites = favorites?.hasFavorites ?? false;
    return hasStarredTasks || hasFavorites;
  }, [tasks, favorites?.hasFavorites]);

  // Precompute: IDs of starred tasks (used to auto-include their children in starred view)
  const starredTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tasks) { if (t.starred) ids.add(t.id); }
    return ids;
  }, [tasks]);

  // Stable array for iteration (avoids Array.from inside filter loops)
  const starredIdsArr = useMemo(() => Array.from(starredTaskIds), [starredTaskIds]);

  // Helper: check if a task is a child of a starred parent (handles prefix parent_task_id)
  const isChildOfStarredParent = useCallback((t: Task) => {
    return !!t.parent_task_id && starredIdsArr.some(sid => sid.startsWith(t.parent_task_id!));
  }, [starredIdsArr]);

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (!showCompleted && t.status === 'done' && phaseFilter !== 'COMPLETE') {
        return false;
      }
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (sessionFilter) {
        if (!t.session_work_statuses || !t.session_work_statuses.includes(sessionFilter as typeof t.session_work_statuses[number])) return false;
      }

      // Source/provider filter (treat undefined as 'ms-todo')
      if (sourceFilter !== 'all') {
        const taskSource = t.source || 'ms-todo';
        if (taskSource !== sourceFilter) return false;
      }

      // Tag filter
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;

      // Starred tab: show starred tasks + tasks in favorited categories/projects
      // Also include children of starred parents (handles prefix parent_task_id)
      if (activeCategory === STARRED_TAB) {
        const isStarred = !!t.starred;
        const isCatFavorite = favorites?.isCategoryFavorite(t.category) ?? false;
        const isProjFavorite = favorites?.isProjectFavorite(t.project) ?? false;
        return isStarred || isCatFavorite || isProjFavorite || isChildOfStarredParent(t);
      }

      if (activeCategory && t.category !== activeCategory) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, showCompleted, priorityFilter, phaseFilter, sessionFilter, sourceFilter, tagFilter, activeCategory, favorites, isChildOfStarredParent]);

  // --- Search filtering: intersect search results with active filters ---
  // Search respects ALL current filters (show/hide completed, category tab,
  // priority, phase, source, tag, session) so results stay consistent with
  // the visible task list context.
  const searchFiltered = useMemo(() => {
    if (!isSearchMode) return filtered;

    // Same filter logic as `filtered` — search results are a subset of what's visible.
    const applySearchFilters = (t: Task): boolean => {
      // Show/hide completed
      if (!showCompleted && t.status === 'done' && phaseFilter !== 'COMPLETE') return false;
      // Priority
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      // Phase
      if (phaseFilter && t.phase !== phaseFilter) return false;
      // Session work status
      if (sessionFilter) {
        if (!t.session_work_statuses || !t.session_work_statuses.includes(sessionFilter as typeof t.session_work_statuses[number])) return false;
      }
      // Source/provider
      if (sourceFilter !== 'all') {
        const taskSource = t.source || 'ms-todo';
        if (taskSource !== sourceFilter) return false;
      }
      // Tag
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
      // Category tab
      if (activeCategory === STARRED_TAB) {
        const isStarred = !!t.starred;
        const isCatFavorite = favorites?.isCategoryFavorite(t.category) ?? false;
        const isProjFavorite = favorites?.isProjectFavorite(t.project) ?? false;
        if (!(isStarred || isCatFavorite || isProjFavorite || isChildOfStarredParent(t))) return false;
      } else if (activeCategory && t.category !== activeCategory) {
        return false;
      }
      return true;
    };

    // While API results haven't arrived yet, show client-side matches as a placeholder.
    if (!searchResults) {
      const lowerQuery = searchQuery.toLowerCase();
      return tasks.filter((t) =>
        applySearchFilters(t) && (
          t.title.toLowerCase().includes(lowerQuery) ||
          (t.description && t.description.toLowerCase().includes(lowerQuery)) ||
          (t.summary && t.summary.toLowerCase().includes(lowerQuery)) ||
          t.category.toLowerCase().includes(lowerQuery) ||
          t.project.toLowerCase().includes(lowerQuery) ||
          (t.tags && t.tags.some(tag => tag.toLowerCase().includes(lowerQuery)))
        )
      );
    }

    // Server-side results: filter to respect active view context.
    const taskMap = new Map(tasks.map((t) => [t.id, t]));

    return searchResults
      .map((r) => taskMap.get(r.taskId))
      .filter((t): t is NonNullable<typeof t> => {
        if (!t) return false;
        return applySearchFilters(t);
      });
  }, [tasks, filtered, isSearchMode, searchQuery, searchResults, showCompleted, priorityFilter, phaseFilter, sessionFilter, sourceFilter, tagFilter, activeCategory, favorites, isChildOfStarredParent]);

  // Count of search results (for display)
  const searchResultCount = isSearchMode ? searchFiltered.length : null;

  // --- Parent-anchored sort with child grouping ---
  // Produces a sorted ID order where children always follow their parent.
  const computeSortOrder = useCallback((items: Task[]): string[] => {
    const cmpMap: Record<SortBy, (a: Task, b: Task) => number> = { priority: comparePriority, date: compareDate, updated: compareUpdated };
    const cmp = cmpMap[sortBy] ?? compareDate;

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

    topLevel.sort(cmp);
    for (const children of childrenOf.values()) children.sort(cmp);

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
    for (const task of topLevel) emitWithChildren(task);
    return order;
  }, [sortBy]);

  // --- Debounced sort order ---
  // Badge/data updates instantly (always use latest `filtered` task objects).
  // Only the POSITION (sort order) is debounced by 3s on reorder-only changes.
  const [sortOrder, setSortOrder] = useState<string[]>(() => computeSortOrder(filtered));
  const sortByRef = useRef(sortBy);
  const prevFilteredIdsRef = useRef<Set<string>>(new Set(filtered.map((t) => t.id)));
  useEffect(() => {
    const newOrder = computeSortOrder(filtered);

    // sortBy toggle or structural change (IDs added/removed): flush immediately
    const currIds = new Set(filtered.map((t) => t.id));
    const prevIds = prevFilteredIdsRef.current;
    const structural = currIds.size !== prevIds.size || !filtered.every((t) => prevIds.has(t.id));
    if (sortByRef.current !== sortBy || structural) {
      sortByRef.current = sortBy;
      prevFilteredIdsRef.current = currIds;
      setSortOrder(newOrder);
      return;
    }
    prevFilteredIdsRef.current = currIds;

    // Same set of tasks, just reordered (e.g. priority change): debounce 3s
    const timer = setTimeout(() => setSortOrder(newOrder), 3000);
    return () => clearTimeout(timer);
  }, [filtered, sortBy, computeSortOrder]);

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
        return !!t.starred || (favorites?.isCategoryFavorite(t.category) ?? false) || (favorites?.isProjectFavorite(t.project) ?? false) || isChildOfStarredParent(t);
      }
      return !activeCategory || t.category === activeCategory;
    };
    const matchesPrioritySessionSource = (t: Task) => {
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (sessionFilter && (!t.session_work_statuses || !t.session_work_statuses.includes(sessionFilter as typeof t.session_work_statuses[number]))) return false;
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
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (sessionFilter && (!t.session_work_statuses || !t.session_work_statuses.includes(sessionFilter as typeof t.session_work_statuses[number]))) return false;
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
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (sourceFilter !== 'all' && (t.source || 'ms-todo') !== sourceFilter) return false;
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
      return true;
    });
    const session: Record<string, number> = { in_progress: 0, agent_complete: 0, await_human_action: 0, completed: 0, error: 0 };
    for (const t of forSession) {
      if (t.session_work_statuses) {
        for (const ws of t.session_work_statuses) {
          if (session[ws] !== undefined) session[ws]++;
        }
      }
    }

    // Source counts (apply priority + phase + session + tag filters)
    const forSource = baseTasks.filter((t) => {
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (sessionFilter && (!t.session_work_statuses || !t.session_work_statuses.includes(sessionFilter as typeof t.session_work_statuses[number]))) return false;
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
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (sessionFilter && (!t.session_work_statuses || !t.session_work_statuses.includes(sessionFilter as typeof t.session_work_statuses[number]))) return false;
      if (sourceFilter !== 'all' && (t.source || 'ms-todo') !== sourceFilter) return false;
      return true;
    });
    const tagCounts: Record<string, number> = {};
    for (const t of forTags) {
      if (t.tags) for (const tag of t.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }

    return { priority, phase, session, source, tagCounts, totalForPriority: forPriority.length, totalForPhase, totalForSession: forSession.length, totalForTags: forTags.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, showCompleted, priorityFilter, phaseFilter, sessionFilter, sourceFilter, tagFilter, activeCategory, favorites, isChildOfStarredParent]);

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
  const { childCountMap, childTaskIds, childParentMap, depthMap } = useMemo(() => {
    const countMap = new Map<string, number>();
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
          countMap.set(parent.id, (countMap.get(parent.id) ?? 0) + 1);
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
    return { childCountMap: countMap, childTaskIds: childIds, childParentMap: parentMap, depthMap: depths };
  }, [sorted]);

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

  const handleAdd = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    try {
      await onCreate({ title, priority: 'none' });
      setNewTitle('');
      if (onClearOperationError) onClearOperationError();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to add task';
      if (onOperationError) onOperationError(msg);
    }
  }, [newTitle, onCreate, onClearOperationError, onOperationError]);

  const handleTabDragEnd = useCallback((event: DragEndEvent) => {
    setActiveTabId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (!ordering) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const oldIndex = categories.indexOf(activeId);
    const newIndex = categories.indexOf(overId);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = [...categories];
    newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, activeId);
    ordering.reorderCategories(newOrder);
  }, [ordering, categories]);

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

  const toggleFiltersCollapsed = useCallback(() => {
    setFiltersCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(LS_FILTERS_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (showCompleted) count++;
    if (priorityFilter) count++;
    if (phaseFilter) count++;
    if (sessionFilter) count++;
    if (sourceFilter !== 'all') count++;
    if (tagFilter) count++;
    return count;
  }, [showCompleted, priorityFilter, phaseFilter, sessionFilter, sourceFilter, tagFilter]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveDragId(id);
    const type = (event.active.data?.current as { type?: string })?.type ?? 'task';
    setActiveDragType(type);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null);
    setActiveDragType(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

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

    const sameGroup = activeInfo.category === targetCategory && activeInfo.project === targetProject;

    if (sameGroup) {
      // Same group: existing reorder logic
      if (!onReorder) return;
      if (!insertNearTaskId) return; // dropped on own header, nothing to do

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
      onMoveTask(activeId, targetCategory, targetProject, insertNearTaskId);
    }
  }, [onReorder, onMoveTask, ordering, taskGroupMap, grouped, fullGrouped]);

  const draggedTask = activeDragId ? sorted.find((t) => t.id === activeDragId) : null;

  // User-controlled collapse only — no auto-collapse during drag
  const isCategoryCollapsed = useCallback((cat: string) => {
    return collapsedCategories.has(cat);
  }, [collapsedCategories]);

  const isProjectCollapsed = useCallback((projKey: string) => {
    return collapsedProjects.has(projKey);
  }, [collapsedProjects]);

  const handleTaskClick = useCallback((task: Task) => {
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

  return (
    <div className={`todo-panel${splitterResizing ? ' splitter-resizing' : ''}`} ref={splitterContainerRef}>
      {/* Category tabs */}
      <div className="todo-panel-tabs-row">
        <div className="todo-panel-tabs">
          {hasStarredContent && (
            <button
              className={`todo-panel-tab todo-panel-tab-starred${activeCategory === STARRED_TAB ? ' todo-panel-tab-active' : ''}`}
              onClick={() => { const next = activeCategory === STARRED_TAB ? '' : STARRED_TAB; setActiveCategory(next); persistTab(next); }}
            >
              {STARRED_TAB}
            </button>
          )}
          <button
            className={`todo-panel-tab${activeCategory === '' ? ' todo-panel-tab-active' : ''}`}
            onClick={() => { setActiveCategory(''); persistTab(''); }}
          >
            All
          </button>
          <DndContext
            sensors={tabSensors}
            collisionDetection={closestCenter}
            onDragStart={(event) => setActiveTabId(String(event.active.id))}
            onDragEnd={handleTabDragEnd}
          >
            <SortableContext items={categories} strategy={horizontalListSortingStrategy}>
              {categories.map((cat) => (
                <SortableCategoryTab
                  key={cat}
                  id={cat}
                  active={activeCategory === cat}
                  onClick={() => { setActiveCategory(cat); persistTab(cat); }}
                  isLocal={localCategories.has(cat)}
                >
                  {cat}
                </SortableCategoryTab>
              ))}
            </SortableContext>
            <DragOverlay>
              {activeTabId ? <div className="todo-panel-tab todo-panel-tab-overlay">{activeTabId}</div> : null}
            </DragOverlay>
          </DndContext>
        </div>
      </div>

      {/* Search bar */}
      <TodoSearchBar
        query={searchQuery}
        onQueryChange={setSearchQuery}
        onClear={clearSearch}
        isSearching={isSearching}
        resultCount={searchResultCount}
      />

      {/* Filter toolbar: always visible, compact single row */}
      <div className="todo-panel-filter-toolbar">
        <button
          className={`filter-toolbar-toggle${activeFilterCount > 0 ? ' has-active' : ''}`}
          onClick={toggleFiltersCollapsed}
          title={filtersCollapsed ? 'Show filters' : 'Hide filters'}
        >
          {filtersCollapsed ? '\u25B8' : '\u25BE'} Filters
          {activeFilterCount > 0 && <span className="filter-active-count">{activeFilterCount}</span>}
        </button>
        <div className="filter-toolbar-actions">
          <button
            className={`filter-chip-standalone${groupBy === 'none' ? ' active' : ''}`}
            onClick={() => { const v = groupBy === 'none' ? 'category' : 'none'; setGroupBy(v); persistGroupBy(v); }}
            title={groupBy === 'none' ? 'Switch to grouped view' : 'Switch to flat list'}
          >
            Flat
          </button>
          <div className="sort-toggle" title="Sort order">
            <button
              className={`sort-toggle-btn${sortBy === 'priority' ? ' active' : ''}`}
              onClick={() => { setSortBy('priority'); persistSortBy('priority'); }}
            >
              P&#x2193;
            </button>
            <button
              className={`sort-toggle-btn${sortBy === 'date' ? ' active' : ''}`}
              onClick={() => { setSortBy('date'); persistSortBy('date'); }}
            >
              C&#x2193;
            </button>
            <button
              className={`sort-toggle-btn${sortBy === 'updated' ? ' active' : ''}`}
              onClick={() => { setSortBy('updated'); persistSortBy('updated'); }}
            >
              U&#x2193;
            </button>
          </div>
          <button
            className={`filter-chip-standalone${showCompleted ? ' active' : ''}`}
            onClick={() => setShowCompleted((p) => !p)}
            title={showCompleted ? 'Hide completed' : 'Show completed'}
          >
            {showCompleted ? 'Hide \u2713' : 'Show \u2713'}
          </button>
          {groupBy !== 'none' && grouped.length > 0 && (
            <button
              className="filter-chip-standalone"
              onClick={handleCollapseExpandAll}
              title={allCollapsed ? 'Expand all groups' : 'Collapse all groups'}
            >
              {allCollapsed ? '\u25BC' : '\u25B6'}
            </button>
          )}
        </div>
      </div>

      {/* Expandable filter rows */}
      {!filtersCollapsed && (
        <div className="todo-panel-filters">
          {/* Row 1: Priority segment */}
          <div className="filter-bar">
            <span className="filter-bar-label">Priority</span>
            <div className="filter-segment">
              <button
                className={`filter-chip${!priorityFilter ? ' active' : ''}`}
                onClick={() => setPriorityFilter('')}
                title="All priorities"
              >
                <span className="filter-chip-text">All</span>
                <span className="filter-chip-count">{filterCounts.totalForPriority}</span>
              </button>
              {(['immediate', 'important', 'backlog', 'none'] as const).map((p) => (
                <button
                  key={p}
                  className={`filter-chip${priorityFilter === p ? ' active' : ''}${filterCounts.priority[p] === 0 ? ' dimmed' : ''}`}
                  onClick={() => setPriorityFilter(priorityFilter === p ? '' : p)}
                  title={PRIORITY_LABEL[p]}
                >
                  <span className="filter-chip-text">{PRIORITY_ICON[p]}</span>
                  <span className="filter-chip-count">{filterCounts.priority[p]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Row 2: Phase segment + More dropdown */}
          <div className="filter-bar">
            <span className="filter-bar-label">Phase</span>
            <div className="filter-segment">
              <button
                className={`filter-chip${!phaseFilter ? ' active' : ''}`}
                onClick={() => setPhaseFilter('')}
                title="All phases"
              >
                <span className="filter-chip-text">All</span>
                <span className="filter-chip-count">{filterCounts.totalForPhase}</span>
              </button>
              {(['TODO', 'IN_PROGRESS', 'AGENT_COMPLETE', 'AWAIT_HUMAN_ACTION'] as const).map((p) => (
                <button
                  key={p}
                  className={`filter-chip${phaseFilter === p ? ' active' : ''}${filterCounts.phase[p] === 0 ? ' dimmed' : ''}`}
                  onClick={() => setPhaseFilter(phaseFilter === p ? '' : p)}
                  title={PHASE_LABEL[p]}
                >
                  <span className="filter-chip-text">{PHASE_ICON[p]}</span>
                  <span className="filter-chip-count">{filterCounts.phase[p]}</span>
                </button>
              ))}
              <MoreDropdown
                items={[
                  { value: 'PEER_CODE_REVIEW', icon: PHASE_ICON.PEER_CODE_REVIEW, label: PHASE_LABEL.PEER_CODE_REVIEW, count: filterCounts.phase.PEER_CODE_REVIEW },
                  { value: 'RELEASE_IN_PIPELINE', icon: PHASE_ICON.RELEASE_IN_PIPELINE, label: PHASE_LABEL.RELEASE_IN_PIPELINE, count: filterCounts.phase.RELEASE_IN_PIPELINE },
                  { value: 'COMPLETE', icon: PHASE_ICON.COMPLETE, label: PHASE_LABEL.COMPLETE, count: filterCounts.phase.COMPLETE },
                ]}
                active={phaseFilter}
                onSelect={setPhaseFilter}
              />
            </div>
          </div>

          {/* Row 3: Session segment + More dropdown */}
          <div className="filter-bar">
            <span className="filter-bar-label">Session</span>
            <div className="filter-segment">
              <button
                className={`filter-chip${!sessionFilter ? ' active' : ''}`}
                onClick={() => setSessionFilter('')}
                title="All sessions"
              >
                <span className="filter-chip-text">All</span>
                <span className="filter-chip-count">{filterCounts.totalForSession}</span>
              </button>
              {(['in_progress', 'agent_complete', 'await_human_action'] as const).map((s) => (
                <button
                  key={s}
                  className={`filter-chip${sessionFilter === s ? ' active' : ''}${filterCounts.session[s] === 0 ? ' dimmed' : ''}`}
                  onClick={() => setSessionFilter(sessionFilter === s ? '' : s)}
                  title={SESSION_LABEL[s]}
                >
                  <span className="filter-chip-text">{SESSION_ICON[s]}</span>
                  <span className="filter-chip-count">{filterCounts.session[s]}</span>
                </button>
              ))}
              <MoreDropdown
                items={[
                  { value: 'completed', icon: SESSION_ICON.completed, label: SESSION_LABEL.completed, count: filterCounts.session.completed },
                  { value: 'error', icon: SESSION_ICON.error, label: SESSION_LABEL.error, count: filterCounts.session.error },
                ]}
                active={sessionFilter}
                onSelect={setSessionFilter}
              />
            </div>
          </div>

          {/* Row 4: Source segment — data-driven from integration plugins */}
          <div className="filter-bar">
            <span className="filter-bar-label">Source</span>
            <div className="filter-segment">
              {['all', ...integrations.map(i => i.id), 'local'].map((s) => {
                const meta = s !== 'all' && s !== 'local' ? getIntegrationMeta(integrations, s) : undefined;
                const label = s === 'all' ? 'All' : s === 'local' ? 'Local' : (meta?.name ?? s);
                const count = filterCounts.source[s] ?? 0;
                return (
                  <button
                    key={s}
                    className={`filter-chip${sourceFilter === s ? ' active' : ''}${s !== 'all' && count === 0 ? ' dimmed' : ''}`}
                    onClick={() => setSourceFilter(s)}
                    title={s === 'all' ? 'All sources' : label}
                  >
                    <span className="filter-chip-text">{label}</span>
                    <span className="filter-chip-count">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Row 5: Tags segment (only show if there are any tags) */}
          {Object.keys(filterCounts.tagCounts).length > 0 && (
            <div className="filter-bar">
              <span className="filter-bar-label">Tags</span>
              <div className="filter-segment">
                <button
                  className={`filter-chip${!tagFilter ? ' active' : ''}`}
                  onClick={() => setTagFilter('')}
                  title="All tags"
                >
                  <span className="filter-chip-text">All</span>
                  <span className="filter-chip-count">{filterCounts.totalForTags}</span>
                </button>
                {Object.entries(filterCounts.tagCounts)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 8)
                  .map(([tag, count]) => (
                    <button
                      key={tag}
                      className={`filter-chip${tagFilter === tag ? ' active' : ''}${count === 0 ? ' dimmed' : ''}`}
                      onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
                      title={tag}
                    >
                      <span className="filter-chip-text">{tag.length > 12 ? tag.slice(0, 12) + '\u2026' : tag}</span>
                      <span className="filter-chip-count">{count}</span>
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Pinned tasks section — shows between filters and task list */}
      {pinnedTasks.length > 0 && (
        <div className="todo-pinned-section">
          <div className="todo-pinned-header">
            <span className="todo-pinned-icon">{'\uD83D\uDCCC'}</span>
            <span className="todo-pinned-label">Pinned</span>
            <span className="todo-pinned-count">{pinnedTasks.length}</span>
          </div>
          <div className="todo-pinned-list">
            {pinnedTasks.map((task) => {
              const ps = task.session_status?.process_status ?? 'stopped';
              const ws = task.session_status?.work_status ?? null;
              const statusColor = task.session_status
                ? compositeColor(ps as Parameters<typeof compositeColor>[0], (ws ?? 'completed') as Parameters<typeof compositeColor>[1])
                : 'var(--fg-muted)';
              const statusLabel = ps === 'running' ? 'Running'
                : ps === 'idle' ? 'Idle'
                : ws ? (WORK_LABELS as Record<string, string>)[ws] ?? ws
                : null;
              return (
                <div
                  key={task.id}
                  className={`todo-pinned-card${focusedTaskId === task.id ? ' todo-pinned-card-active' : ''}`}
                  onClick={() => onFocusTask?.(task)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocusTask?.(task); } }}
                >
                  <span className="todo-pinned-dot" style={{ background: statusColor }} />
                  <span className="todo-pinned-title" title={task.title}>{task.title}</span>
                  {statusLabel && (
                    <span className="todo-pinned-status" style={{ color: statusColor }}>{statusLabel}</span>
                  )}
                  <button
                    className="todo-pinned-unpin"
                    onClick={(e) => { e.stopPropagation(); onUnpinTask?.(task.id); }}
                    title="Unpin"
                    aria-label="Unpin task"
                  >
                    &times;
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="todo-panel-list" style={(focusedTask || detailTarget) ? { flex: `${1 - detailRatio} 1 0%` } : undefined}>
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
              const searchMeta = new Map(searchResults?.map(r => [r.taskId, r]) ?? []);
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
              let relevanceDividerShown = false;
              return ordered.map((task) => {
                // Hide children of collapsed parents
                const searchParentId = searchChildParent.get(task.id);
                if (searchParentId && !expandedParents.has(searchParentId)) return null;
                // Relevance divider: show once when score drops below 0.4
                const score = searchMeta.get(task.id)?.score;
                let divider: ReactNode = null;
                if (!relevanceDividerShown && score != null && score < 0.4 && !searchChildIds.has(task.id)) {
                  relevanceDividerShown = true;
                  divider = (
                    <div key="__relevance-divider" className="search-relevance-divider">
                      <span>Less relevant</span>
                    </div>
                  );
                }
                return (
                  <Fragment key={task.id}>
                  {divider}
                  <SortableTaskItem
                    key={task.id}
                    task={task}
                    isFocused={focusedTaskId === task.id}
                    isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                    depth={depthMap.get(task.id) ?? 0}
                    childCount={searchChildCount.get(task.id)}
                    isExpanded={expandedParents.has(task.id)}
                    onToggleExpand={() => toggleParentExpand(task.id)}
                    onClick={() => handleTaskClick(task)}
                    onSetPhase={onSetPhase ?? ((id) => onComplete(id))}
                    onStar={onStar}
                    onCyclePriority={onCyclePriority}
                    onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                    onOpenSession={onOpenSession}
                    openSessionIds={openSessionIds}
                    onPinTask={onPinTask}
                    onUnpinTask={onUnpinTask}
                    isPinned={pinnedTaskIds?.has(task.id)}
                    searchContext={`${task.category}${task.project && task.project !== task.category ? ` / ${task.project}` : ''}`}
                    searchMatchField={searchMeta.get(task.id)?.matchField}
                    searchScore={searchMeta.get(task.id)?.score}
                    searchKeywordScore={searchMeta.get(task.id)?.keywordScore}
                    searchSemanticScore={searchMeta.get(task.id)?.semanticScore}
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
                  isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                  depth={depthMap.get(task.id) ?? 0}
                  childCount={childCountMap.get(task.id)}
                  isExpanded={expandedParents.has(task.id)}
                  onToggleExpand={() => toggleParentExpand(task.id)}
                  onClick={() => handleTaskClick(task)}
                  onSetPhase={onSetPhase ?? ((id) => onComplete(id))}
                  onStar={onStar}
                  onCyclePriority={onCyclePriority}
                  onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                  onOpenSession={onOpenSession}
                  openSessionIds={openSessionIds}
                  onPinTask={onPinTask}
                  onUnpinTask={onUnpinTask}
                  isPinned={pinnedTaskIds?.has(task.id)}
                  searchContext={`${task.category}${task.project && task.project !== task.category ? ` / ${task.project}` : ''}`}
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
            onDragEnd={handleDragEnd}
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
                                  isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                                  depth={depthMap.get(task.id) ?? 0}
                                  childCount={childCountMap.get(task.id)}
                                  isExpanded={expandedParents.has(task.id)}
                                  onToggleExpand={() => toggleParentExpand(task.id)}
                                  onClick={() => handleTaskClick(task)}
                                  onSetPhase={onSetPhase ?? ((id) => onComplete(id))}
                                  onStar={onStar}
                                  onCyclePriority={onCyclePriority}
                                  onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                                  onOpenSession={onOpenSession}
                                  openSessionIds={openSessionIds}
                                  onPinTask={onPinTask}
                                  onUnpinTask={onUnpinTask}
                                  isPinned={pinnedTaskIds?.has(task.id)}
                                />
                              );
                            })}
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
                                                isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                                                depth={depthMap.get(task.id) ?? 0}
                                                childCount={childCountMap.get(task.id)}
                                                isExpanded={expandedParents.has(task.id)}
                                                onToggleExpand={() => toggleParentExpand(task.id)}
                                                onClick={() => handleTaskClick(task)}
                                                onSetPhase={onSetPhase ?? ((id) => onComplete(id))}
                                                onStar={onStar}
                                                onCyclePriority={onCyclePriority}
                                                onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                                                onOpenSession={onOpenSession}
                                                openSessionIds={openSessionIds}
                                                onPinTask={onPinTask}
                                                onUnpinTask={onUnpinTask}
                                                isPinned={pinnedTaskIds?.has(task.id)}
                                              />
                                            );
                                          })}
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

      {/* Detail pane: task, project, or category */}
      {(focusedTask || detailTarget) && <div className="todo-detail-splitter" onMouseDown={splitterMouseDown} />}
      {focusedTask ? (
        <TaskDetailPane task={focusedTask} allTasks={tasks} onClose={onClearFocus} onOpenSession={onOpenSession} onOpenTriageForTask={onOpenTriageForTask} onFocusChild={onFocusTask} style={{ flex: `${detailRatio} 1 0%` }} />
      ) : detailTarget?.type === 'project' ? (
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

      {operationError && (
        <div className="todo-panel-add-error" role="alert">
          {operationError}
          {onClearOperationError && <button className="todo-panel-error-dismiss" onClick={onClearOperationError} aria-label="Dismiss">&times;</button>}
        </div>
      )}
      <form className="todo-panel-add" onSubmit={handleAdd}>
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Quick add task..."
          aria-label="New task title"
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!newTitle.trim()}>
          Add
        </button>
      </form>
    </div>
  );
});
