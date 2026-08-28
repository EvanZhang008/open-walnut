import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef, memo, Fragment, startTransition, type CSSProperties, type DragEvent as ReactDragEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { SESSION_MODE_LABELS } from '@open-walnut/core';
import type { Task as CoreTask, SessionRecord } from '@open-walnut/core';
import { renderNoteMarkdown } from '@/utils/markdown';
import { fetchSessionsForTask } from '@/api/sessions';
import { fetchTask, updateTask as apiUpdateTask, type BatchTaskOutcome } from '@/api/tasks';
import { PluginFieldPills } from '@/components/tasks/PluginFieldPicker';
import { fetchTriageHistory } from '@/api/chat';
import { useEvent } from '@/hooks/useWebSocket';
import { useConfirm, usePrompt } from '@/hooks/useConfirm';
import { useNotifications } from '@/contexts/notifications';
import { timeAgo } from '@/utils/time';
import { scrollLog } from '@/utils/scroll-debug';
import type { ProcessStatus } from '@open-walnut/core';
import type { TaskPhase } from '@/types/session';
import { PHASE_LABELS, PHASE_COLORS, PROCESS_COLORS, resolveTaskSessionId, phasePickerChoices, matchesPhaseFilter, taskNeedsAction } from '@/utils/session-status';
import type { UseFavoritesReturn } from '@/hooks/useFavorites';
import type { UseOrderingReturn } from '@/hooks/useOrdering';
import * as ICONS from '../common/Icons';
import type { TaskPriority } from '@open-walnut/core';
import { TodoSearchBar } from './TodoSearchBar';
import { AgentSearchPanel } from './AgentSearchPanel';
import { NewLauncherButton } from './NewLauncherButton';
import { ProjectPlusMenu, ProjectKebabMenu, TierPlusButton } from './ProjectHeaderMenus';
import { TierSeparatorRow, SortableTierSeparatorRow } from './TierSeparatorRow';
import {
  anchorsForSlot,
  isSeparatorId,
  newSeparatorId,
  placeSeparators,
  projectAnchorsForSlot,
  reanchorSeparatorsAfterMove,
  removeSeparator,
  snapSlotOutOfGroup,
  syncSeparatorAnchorsFromArr,
  upsertSeparator,
  withSeparatorSentinels,
  type SeparatorMode,
  type TierSeparator,
} from './tier-separators';
import { TaskStartButton } from './TaskStartButton';
import { ProjectSourceBadge } from './ProjectSourceBadge';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { createProject } from '@/api/projects';
import { ProjectSourcePicker } from './ProjectSourcePicker';
import { log } from '@/utils/log';
import { visibleInterval } from '@/utils/page-visibility';
import {
  mapServerTaskSearchResults,
  rankOpenTasksFirst,
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
  type DragMoveEvent,
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
import { dragBus } from '@/utils/drag-bus';
import { TaskKebabMenu } from './TaskKebabMenu';
import { TaskBatchMenu } from './TaskBatchMenu';
import {
  ViewDropdown,
  DEFAULT_TASK_QUERY_FILTER_STATE,
  hasActiveTaskQuery,
  isPinnedFiltered,
  logTaskQueryChange,
  timeWindowLabel,
  toTaskQuery,
  type SortBy,
  type GroupBy,
  type DateFilter,
  type TaskQueryFilterState,
} from './ViewDropdown';
import { TaskFilterChips } from './TaskFilterChips';
import {
  buildTaskQueryContext,
  deriveSourceOptions,
  deriveSprintOptions,
  safeNormalizeTaskQuery,
} from './task-query-state';
import {
  matchesTaskQuery,
  type NormalizedTaskQuery,
  type TaskQuery,
  type TaskQueryContext,
} from '@open-walnut/task-query';
import { INBOX_TAB, LS_TAB_KEY } from './task-tabs';
import { DatePicker, formatDateDisplay, formatDateTimeDisplay, isOverdue, parseDateLocal } from '../common/DatePicker';
import { useVerticalSplitter } from '@/hooks/useVerticalSplitter';
import { useResizableHeight } from '@/hooks/useResizableHeight';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';
import { ProjectDetailPane } from './ProjectDetailPane';
import { GlobalNotesSection } from '../notes/GlobalNotesSection';
import { useGlobalNotes } from '@/hooks/useGlobalNotes';
import { SortableTierCard, TierDropZone, GroupChip } from './FocusSatelliteCards';
import {
  groupSortableId, parseGroupSentinelGid, isGroupSentinel, taskIdsOnly, withGroupSentinels,
  pruneOrphanSentinels,
} from './tier-group-sentinels';
import { inferTierDropProject, resolveMoveMigration, sourceDisplayName } from './task-move-project';
import { TodoSectionTabs, TODO_SECTIONS, type TodoSection } from './TodoSectionTabs';
import { isBuiltinTier, type FocusTier, type CustomTierDef } from '@/api/focus';
import { useSessionStatusEpoch, useTaskCircle } from '@/hooks/useSessionStatus';
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

/** Inline split-pane target. Project is the single grouping layer, so 'project' is
 *  the only kind; Inbox ('') has no registry row and therefore no detail pane. */
type DetailTarget =
  | { type: 'project'; project: string }
  | null;

interface TodoPanelProps {
  tasks: Task[];
  loading: boolean;
  onComplete: (id: string) => void;
  onSetPhase?: (id: string, phase: string) => void;
  onCreate: (input: { title: string; priority: string; project?: string; pinnedTier?: FocusTier; capture?: boolean }) => Promise<Task | unknown>;
  onUpdate?: (id: string, updates: { title?: string }) => void;
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
   *  the Pinned region only — no TASKS tab switch, no project expansion.
   *  'all' (default) = full locate incl. tab switch. */
  focusScope?: 'all' | 'pinned';
  favorites?: UseFavoritesReturn;
  ordering?: UseOrderingReturn;
  /** `project` is '' for Inbox. */
  onReorder?: (project: string, taskIds: string[]) => void;
  onMoveTask?: (taskId: string, project: string, insertNearTaskId?: string) => void;
  onReparentTask?: (taskId: string, newParentId: string | null, opts?: { insertAfterId?: string }) => void;
  /** Called when switching to manual sort — baker freezes current displayed order into the store. */
  onBakeOrder?: (orderedIds: string[]) => void;
  onOpenSession?: (sessionId: string) => void;
  /** One-click "▶ Start": launch a session FOR this task (reusing it, never
   *  creating a second one). Only offered for tasks that don't already own a
   *  session — those get the open-session affordances instead. */
  onStartSession?: (task: Task) => void;
  onOpenTriageForTask?: (taskId: string) => void;
  onPinTask?: (taskId: string) => void;
  onUnpinTask?: (taskId: string) => void;
  onReorderPinned?: (newIds: string[]) => void;
  onSetTier?: (taskId: string, tier: FocusTier, newPinnedOrder?: string[]) => void;
  onSetDate?: (taskId: string, date: string | null) => void;
  onSetStartDate?: (taskId: string, date: string | null) => void;
  pinnedTaskIds?: Set<string>;
  focusTaskIds?: Set<string>;
  backlogTaskIds?: Set<string>;
  waitTaskIds?: Set<string>;
  /** User-defined tier registry (Settings → Focus Tiers), registry order. */
  customTiers?: CustomTierDef[];
  /** False until the registry's first fetch resolves — gates stale-tab self-heal. */
  customTiersLoaded?: boolean;
  /** Per custom-tier-id membership sets (mirrors focusTaskIds/waitTaskIds). */
  customTierIds?: Record<string, Set<string>>;
  /** When true, suppress opening the detail panel for the focused task (e.g. chat task-ref clicks). */
  suppressDetail?: boolean;
  /** Set of session IDs currently displayed in session columns. */
  openSessionIds?: Set<string>;
  /** Set of task IDs whose session is open on the home page — highlights their cards. */
  openSessionTaskIds?: Set<string>;
  // operationError VALUE is surfaced globally via the unified notification toaster
  // (AppShell), so TodoPanel only needs the report callback, not the value.
  onOperationError?: (msg: string) => void;
  /** Externally-set project (e.g. from URL deep link). When it changes from undefined to a value, the tab switches. */
  externalProject?: string;
  /** Fires whenever the active project tab changes (for URL sync). */
  onProjectChange?: (project: string) => void;
  /** Toolbar "+" — opens the todo-anchored launcher popover (Session | Task
   *  tabs, Session default) rendered by MainPage inside the task panel. */
  onOpenLauncher?: () => void;
  /** Project header "+": open a draft session column seeded with this project
   *  (path prefilled from the project's default cwd/host). */
  onOpenLauncherForProject?: (project: string) => void;
  /** Pin-tier header "+": open a draft session column with `meta.pinTier` preset
   *  to this tier (built-in name or a `ct_*` custom tier id). */
  onOpenLauncherForTier?: (tier: string) => void;
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
  COMPLETE: ICONS.ICON_PHASE_COMPLETE,
};

const PHASE_LABEL: Record<string, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'Agent Complete',
  COMPLETE: 'Complete',
};

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

// Shared empty set for the tierGraceUnion fast path — one identity so memos
// keyed on the result don't churn. Never mutate.
const EMPTY_ID_SET: Set<string> = new Set<string>();

/** Human label for a tier value — a built-in name capitalized, a custom id (`ct_*`)
 *  resolved through the registry. Same rule as MainPage.tierLabel; kept local
 *  because the panel must not depend on its host page. */
function tierDisplayLabel(tier: string, customTiers?: CustomTierDef[]): string {
  const custom = customTiers?.find((t) => t.id === tier);
  if (custom) return custom.label;
  return `${tier[0]?.toUpperCase() ?? ''}${tier.slice(1)}`;
}

// Action icons: imported from shared Icons.tsx via ICONS.*

/** Normalize legacy priority values to current 4-tier system. */
function effectivePriority(p: string): string {
  if (p === 'high') return 'immediate';
  if (p === 'medium') return 'important';
  if (p === 'low') return 'backlog';
  return p;
}

// ── LocalStorage persistence helpers ──

const LS_COLLAPSED_SECTIONS_KEY = 'walnut-todo-collapsed-sections';
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
  // '' = the All chip. (Before the starred system was retired this defaulted to
  // the ★ tab; a persisted '\u2605' now self-heals to All via the stale-tab effect.)
  try { return localStorage.getItem(LS_TAB_KEY) ?? ''; } catch { return ''; }
}

function persistTab(tab: string) {
  try { localStorage.setItem(LS_TAB_KEY, tab); } catch { /* ignore */ }
}

/** Active section tab. Defaults to 'focus' — the panel's whole point is that you
 *  open it already looking at what you're working on, not at 7 cramped regions. */
function readSection(): TodoSection {
  try {
    const v = localStorage.getItem(LS_SECTION_KEY);
    // Custom tier tabs persist by id. A stale id (tier deleted elsewhere) is
    // accepted here — the stale-tab effect in TodoPanel switches back to
    // 'focus' once the registry loads and the id isn't in it.
    if (v && ((TODO_SECTIONS as readonly string[]).includes(v) || v.startsWith('ct_'))) return v as TodoSection;
  } catch { /* ignore */ }
  return 'focus';
}

function persistSection(section: TodoSection) {
  try { localStorage.setItem(LS_SECTION_KEY, section); } catch { /* ignore */ }
}

/**
 * Per-tier view mode for the pinned tabs:
 *  - 'project' (default): pin order re-clustered into project runs with folder
 *    labels (clusterTierByProject).
 *  - 'custom': the user's raw pin order, no project clustering, no labels.
 * The two underlying orders are SEPARATE persisted stores — pin order lives in
 * the focus store, project order in ordering.projects — so flipping the mode
 * only changes which one drives the render; neither is rewritten. Keyed by tier
 * id ('focus' | ... | ct_*); 'walnut-todo-' prefix rides ui-prefs-sync.
 */
type TierViewMode = 'project' | 'custom';
const LS_TIER_VIEW_KEY = 'walnut-todo-tier-view-modes';

function readTierViewModes(): Record<string, TierViewMode> {
  try {
    const raw = localStorage.getItem(LS_TIER_VIEW_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, TierViewMode> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v === 'project' || v === 'custom') out[k] = v;
      }
      return out;
    }
  } catch { /* ignore */ }
  return {};
}

function persistTierViewModes(modes: Record<string, TierViewMode>) {
  try { localStorage.setItem(LS_TIER_VIEW_KEY, JSON.stringify(modes)); } catch { /* ignore */ }
}

/**
 * Recent tab sort mode — 'updated' (activity feed: latest of update/session/
 * completion, the historical behavior) or 'created' (pure creation time).
 * Sorting only; nothing is rewritten. 'walnut-todo-' prefix rides ui-prefs-sync.
 */
type RecentSortMode = 'updated' | 'created';
const LS_RECENT_SORT_KEY = 'walnut-todo-recent-sort';

function readRecentSortMode(): RecentSortMode {
  try {
    const v = localStorage.getItem(LS_RECENT_SORT_KEY);
    if (v === 'updated' || v === 'created') return v;
  } catch { /* ignore */ }
  return 'updated';
}

function persistRecentSortMode(mode: RecentSortMode) {
  try { localStorage.setItem(LS_RECENT_SORT_KEY, mode); } catch { /* ignore */ }
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
  onDelete?: (id: string) => void;
  onSetPriority?: (id: string, priority: string) => void;
  onUpdateTitle?: (id: string, title: string) => void;
  onOpenSession?: (sessionId: string) => void;
  /** One-click ▶ — launch a session for this task (see TaskStartButton). */
  onStartSession?: (task: Task) => void;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onPinTask?: (taskId: string) => void;
  onUnpinTask?: (taskId: string) => void;
  onSetTier?: (taskId: string, tier: FocusTier, newPinnedOrder?: string[]) => void;
  onSetDate?: (taskId: string, date: string | null) => void;
  onSetStartDate?: (taskId: string, date: string | null) => void;
  onUnparent?: (taskId: string) => void;  // Remove parent_task_id (promote to top-level)
  onMoveUp?: (taskId: string) => void;    // Swap with previous sibling
  onMoveToProject?: (taskId: string, project: string) => void;  // Kebab "Project" select
  isPinned?: boolean;
  pinnedTier?: FocusTier;
  searchContext?: string; // Project context pill shown in search mode
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
 * Cluster a tier's id order into project runs (first-seen anchor order), so the
 * pinned area can render a minimal folder label per project — same folder
 * structure as the main task list. Runs AFTER clusterTierByGroup and treats a
 * contiguous same-group run as ONE atomic block keyed by its lead task's
 * project (a group must never be split across folders). Pure + order-stable
 * (idempotent), and NEVER applied mid-drag — during a drag the user's live
 * order is authority (same contract as group clustering).
 */
function clusterTierByProject(ids: string[], tasks: Task[], projectOrder?: string[]): string[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // 1. Blocks: same-group contiguous runs collapse into one block; everything
  //    else is a single-id block. Unknown ids (group: sentinels shouldn't reach
  //    here outside a drag, but be safe) inherit the previous block's key.
  type Block = { key: string; ids: string[] };
  const blocks: Block[] = [];
  let i = 0;
  while (i < ids.length) {
    const t = taskById.get(ids[i]);
    if (!t) {
      const key = blocks.length > 0 ? blocks[blocks.length - 1].key : '';
      blocks.push({ key, ids: [ids[i]] });
      i++;
      continue;
    }
    if (t.group_id) {
      const run = [ids[i]];
      let j = i + 1;
      while (j < ids.length && taskById.get(ids[j])?.group_id === t.group_id) {
        run.push(ids[j]);
        j++;
      }
      blocks.push({ key: t.project || '', ids: run });
      i = j;
    } else {
      blocks.push({ key: t.project || '', ids: [ids[i]] });
      i++;
    }
  }
  // 2. Stable-partition blocks by key, anchored at each key's first occurrence.
  const byKey = new Map<string, string[]>();
  const keyOrder: string[] = [];
  for (const b of blocks) {
    let arr = byKey.get(b.key);
    if (!arr) { arr = []; byKey.set(b.key, arr); keyOrder.push(b.key); }
    arr.push(...b.ids);
  }
  // 3. Optional global project order (ordering.projects, case-insensitive):
  // listed projects rank by their position, unlisted keep first-occurrence
  // order after them, Inbox ('') stays wherever occurrence put it relative to
  // other unlisted keys. Stable sort → ties keep occurrence order.
  if (projectOrder && projectOrder.length > 0) {
    const rank = new Map(projectOrder.map((name, idx) => [name.toLowerCase(), idx]));
    const occurrence = new Map(keyOrder.map((k, idx) => [k, idx]));
    keyOrder.sort((a, b) => {
      const ra = rank.get(a.toLowerCase());
      const rb = rank.get(b.toLowerCase());
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return occurrence.get(a)! - occurrence.get(b)!;
    });
  }
  return keyOrder.flatMap((k) => byKey.get(k)!);
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

function SortableTaskItem({ task, isFocused, isDetailOpen, isRecentlyDone, isVanishing, isNestTarget, isGroupTarget, depth = 0, childCount, isExpanded, onToggleExpand, onClick, isSelected, selectMode, onSelectToggle, onStartSelect, onSetPhase, onDelete, onSetPriority, onUpdateTitle, onOpenSession, onStartSession, onExpandDetail, onClearFocus, onPinTask, onUnpinTask, onSetTier, onSetDate, onSetStartDate, onUnparent, onMoveUp, onMoveToProject, isPinned, pinnedTier, searchContext, filterOverrideReason, isFadingOverride, groupInfo, onRenameGroup, onUngroupTask, onDissolveGroup, isGroupHidden, onUnhideGroup }: SortableTaskItemProps) {
  // Live circle: error red / waiting red-pulse / running green-pulse.
  const circleClass = useTaskCircle(task);
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
  // Red row tint = "needs human action" (phase-driven, survives opening the
  // task). The unread DOT below is the open-to-clear marker. Same split as the
  // pinned/focus cards — the list rows must flag handed-back work too.
  const needsAction = taskNeedsAction(task);

  const className = [
    'todo-panel-item',
    needsAction ? 'todo-panel-item-needs-action' : '',
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
    if (!isEditing && titleRef.current) {
      if (titleRef.current.textContent !== task.title) {
        titleRef.current.textContent = task.title;
      }
      // Editing auto-scrolls the overflow:hidden span to keep the caret visible;
      // a leftover scrollLeft on a nowrap+ellipsis span paints as a BLANK title.
      titleRef.current.scrollLeft = 0;
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
          {/* Unread dot — leftmost, keeps everything on one line. Clears when the
              user opens the task (MainPage.handleFocusTask marks it read). */}
          {task.unread && !isDone && (
            <span className="task-unread-dot" role="img" aria-label="Unread — agent output you haven't seen" title="Unread — click to open and mark read" />
          )}
          {/* Phase icon — one click toggles To Do ↔ Complete */}
          <button
            className={`task-phase-icon-btn ${circleClass}`}
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
          {/* One-click ▶ Start — hover-revealed, before the kebab */}
          <TaskStartButton task={task} isDone={isDone} onStartSession={onStartSession} />
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
            onPinTask={onPinTask}
            onUnpinTask={onUnpinTask}
            onSetTier={onSetTier}
            onOpenSession={onOpenSession}
            onStartSession={onStartSession}
            onSetDate={onSetDate}
            onSetStartDate={onSetStartDate}
            onUnparent={onUnparent}
            onMoveUp={onMoveUp}
            onMoveToProject={onMoveToProject}
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

// ── SortableGroupItem (for project group drag) ──
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
  } = useSortable({ id, data: { type: 'project-group' } });

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
  /** '' = Inbox. */
  project: string;
  disabled: boolean;
  children: (props: { isOver: boolean; setNodeRef: (node: HTMLElement | null) => void }) => React.ReactNode;
}

function DroppableHeader({ id, project, disabled, children }: DroppableHeaderProps) {
  const { isOver, setNodeRef } = useDroppable({
    id,
    data: { type: 'header-drop', project },
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
    // Legacy stored 'category' maps onto the surviving project grouping.
    if (v === 'category' || v === 'project') return 'project';
    if (v === 'none') return v;
  } catch { /* ignore */ }
  return 'project';
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
// This prevents project-group drags from colliding with task cards.

const typeAwareCollision: CollisionDetection = (args) => {
  const activeType = (args.active.data?.current as { type?: string })?.type ?? 'task';

  const filtered = args.droppableContainers.filter((container) => {
    const cType = (container.data?.current as { type?: string })?.type ?? 'task';

    // Tasks can collide with all tasks (cross-group) and header drop zones
    if (activeType === 'task') {
      return cType === 'task' || cType === 'header-drop';
    }

    // Project group drags: same-type only. Project groups are GLOBALLY sortable
    // now (flat ordering) — there is no parent-scope constraint left.
    return cType === activeType;
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
/** Height of the unpin strip that overlays the bottom of the pinned area during a
 *  card drag. Deep enough to be an easy target, shallow enough that the tier rows
 *  it covers are still readable while aiming. */
const UNPIN_ZONE_H = 46;

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
        <span className="todo-detail-project">
          {task.project || 'Inbox'}
        </span>
        <DatePicker date={task.start_date} onChange={handleStartDateChange} label="Start" />
        {/* Calendar semantics: start is the primary date, the end/due is
            usually empty — collapse it to a "+ Due" ghost until set. */}
        <DatePicker date={task.due_date} onChange={handleDateChange} label="Due" ghostWhenEmpty />
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
          <PluginFieldPills task={task} />
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
                // Registry label, not the raw id — otherwise 'dontAsk' leaks
                // its camelCase id into the UI.
                const modeLabel = record?.mode && record.mode !== 'default' && record.mode !== 'plan' && !record?.planCompleted
                  ? (SESSION_MODE_LABELS[record.mode] ?? record.mode)
                  : null;
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

/** Shared empty separator list — a fresh `[]` per render would invalidate
 *  renderTierItems' memo and re-render every tier card on every render. */
const NO_SEPARATORS: TierSeparator[] = [];

// ── CustomTierSubgroup — one user-defined tier section in the pinned area. ──
// Mirrors the built-in Wait sub-group JSX exactly, but lives in its own component
// because each tier needs its own useResizableHeight hook and the number of custom
// tiers is dynamic (hooks can't run in a loop inside TodoPanel itself).
function CustomTierSubgroup({ def, isAll, folded, collapsed, onToggle, visibleIds, children, isEmpty, count, onAdd, onAddSession, onAddTask, onAddSeparator, dropProps, addOpenSignal, onAddSignalConsumed }: {
  def: CustomTierDef;
  isAll: boolean;
  /** Chevron-folded in the stacked view (content hidden). */
  folded: boolean;
  /** Raw collapsed-set membership (chevron direction). */
  collapsed: boolean;
  onToggle: (id: string) => void;
  /** Sortable ids for this tier's SortableContext (mirrors visibleFocusIds etc.). */
  visibleIds: string[];
  children: ReactNode;
  isEmpty: boolean;
  count: number;
  onAdd: (title: string) => Promise<unknown>;
  /** Header "+" → a draft session pinned to this custom tier (R8). */
  onAddSession?: (tier: string) => void;
  /** Header "+" → open this tier's inline add row. */
  onAddTask?: (tier: string) => void;
  /** Header "+" → drop a divider line at the top of this tier. */
  onAddSeparator?: (tier: string) => void;
  /** Native-drag handlers so a dragged separator can land in this tier. */
  dropProps?: { onDragOver: (e: ReactDragEvent<HTMLDivElement>) => void; onDrop: (e: ReactDragEvent<HTMLDivElement>) => void };
  addOpenSignal?: number;
  onAddSignalConsumed?: () => void;
}) {
  const resize = useResizableHeight(`open-walnut-focus-tier-height-${def.id}`, { min: 60, max: 1200 });
  return (
    <div className="todo-pinned-subgroup">
      {isAll && (
      <div className="todo-pinned-sublabel" onClick={() => onToggle(def.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggle(def.id); }} style={{ cursor: 'pointer' }} title={`${def.label} — custom tier`}>
        <span className={`todo-pinned-chevron todo-pinned-sub-chevron${collapsed ? '' : ' todo-pinned-chevron-open'}`}>{'▸'}</span>
        <span className="todo-pinned-sublabel-icon todo-tier-icon-custom">{ICONS.ICON_TIER_CUSTOM}</span>
        <span className="todo-pinned-sublabel-text">{def.label}</span>
        <span className="todo-pinned-sublabel-count">{count}</span>
        <TierPlusButton tier={def.id} label={def.label} onAddSession={onAddSession}
          onAddTask={onAddTask} onAddSeparator={onAddSeparator} />
      </div>
      )}
      {!folded && (
        <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
          <div className="todo-pinned-list-scroll" style={isAll && resize.height != null ? { maxHeight: resize.height } : undefined} {...dropProps}>
            <TierDropZone id={`${def.id}-drop-zone`} isEmpty={isEmpty}>
              {children}
            </TierDropZone>
            <InlineAdd label={`Add to ${def.label}…`} onAdd={onAdd} openSignal={addOpenSignal} onOpenSignalConsumed={onAddSignalConsumed} />
          </div>
          {/* Per-tier drag handle only makes sense when tiers share the panel. */}
          {isAll && (
          <div
            className={`todo-tier-resize-handle${resize.isDragging ? ' dragging' : ''}`}
            onPointerDown={(e) => resize.handlePointerDown(e, e.currentTarget.previousElementSibling as HTMLElement | null)}
            title={`Drag to resize ${def.label}`}
          />
          )}
        </SortableContext>
      )}
    </div>
  );
}

// ── InlineAdd — "+" row at the bottom of a tier or project group to add a task
// directly into that context. Reuses the parent onCreate (optimistic + tier-correct path).
// `openSignal`: bump to force-open + focus from outside (project header "+ → Add task"). ──
function InlineAdd({ onAdd, label = 'Add to Focus…', openSignal, onOpenSignalConsumed }: { onAdd: (title: string) => void | Promise<unknown>; label?: string; openSignal?: number; onOpenSignalConsumed?: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (openSignal !== undefined && openSignal > 0) {
      setOpen(true);
      // Focus after this render commits the input (the open-effect above only
      // fires on open's false→true edge; a re-signal while already open needs
      // an explicit refocus).
      requestAnimationFrame(() => inputRef.current?.focus());
      // Consume-once: the parent clears the signal so a REMOUNT of this row
      // (collapse/expand toggles the group subtree) doesn't replay it and pop
      // the input open after the user already Escaped out.
      onOpenSignalConsumed?.();
    }
  }, [openSignal, onOpenSignalConsumed]);

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

// ── NewProjectRow — "＋ New Project" at the very bottom of the grouped list.
// Visually separated from task rows (hairline + dashed outline, folder icon):
// this creates a CONTAINER, not a task. On create the caller re-renders the
// group list; the row itself never moves (it's static DOM below the groups), so
// no scroll compensation is needed here — the new empty group appears above it. ──
function NewProjectRow({ onCreated, onError }: { onCreated: (name: string) => void; onError?: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [source, setSource] = useState('local');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const submit = async () => {
    const name = value.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = await createProject(name, source === 'local' ? undefined : source);
      setValue('');
      setSource('local');
      setOpen(false);
      onCreated(res.name); // canonical spelling from the server (NOCASE registry)
    } catch (err) {
      // Keep the input open with the text so the user can fix the name (e.g.
      // path separators are rejected by the registry gate) — and TELL the user
      // why via the panel's operation-error toast, not just a silent log.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('todo', 'create project failed', { name, error: msg });
      onError?.(`Create project failed: ${msg}`);
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="todo-new-project-wrap">
        <button type="button" className="todo-new-project-btn" onClick={() => setOpen(true)}>
          <span className="todo-new-project-icon">{ICONS.ICON_FOLDER}</span>
          <span>New Project</span>
        </button>
      </div>
    );
  }
  return (
    <div className="todo-new-project-wrap">
      <div className="todo-new-project-input-row">
        <span className="todo-new-project-icon">{ICONS.ICON_FOLDER}</span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={busy}
          placeholder="Project name — Enter to create, Esc to cancel"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') { e.preventDefault(); void submit(); }
            if (e.key === 'Escape') { e.preventDefault(); setValue(''); setSource('local'); setOpen(false); }
          }}
          onBlur={() => { if (!value.trim()) setOpen(false); }}
        />
      </div>
      {/* provider claim — default Local; chips preventDefault pointerdown so a
          pick doesn't blur-cancel the empty input */}
      <ProjectSourcePicker value={source} onChange={setSource} />
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
  /** Resolved display label when pinnedTier is a custom id. */
  pinnedTierLabel?: string;
  onSetPriority?: (id: string, priority: string) => void;
  onSetDate?: (id: string, date: string | null) => void;
  onSetStartDate?: (id: string, date: string | null) => void;
  onSetTier?: (id: string, tier: FocusTier) => void;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onOpenSession?: (sessionId: string) => void;
  /** One-click ▶ — launch a session for this task (see TaskStartButton). */
  onStartSession?: (task: Task) => void;
  onSetPhase?: (id: string, phase: string) => void;
  onUpdateTitle?: (id: string, title: string) => void;
  onDelete?: (id: string) => void;
  /** Move this task to another project ('' = Inbox) — kebab "Project" select. */
  onMoveToProject?: (taskId: string, project: string) => void;
}

// ── SortableRecentCard — draggable recent-activity card with kebab menu ──

function SortableRecentCard({ task, isFocused, isVanishing, isSessionOpen, isDetailOpen, onClick, onPinTask, onUnpinTask, isPinned, pinnedTier, pinnedTierLabel, onSetPriority, onSetDate, onSetStartDate, onSetTier, onExpandDetail, onClearFocus, onOpenSession, onStartSession, onSetPhase, onUpdateTitle, onDelete, onMoveToProject }: RecentCardProps) {
  // Live circle: error red / waiting red-pulse / running green-pulse.
  const circleClass = useTaskCircle(task);
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
    if (!isEditing && titleRef.current) {
      if (titleRef.current.textContent !== task.title) {
        titleRef.current.textContent = task.title;
      }
      // Editing auto-scrolls the overflow:hidden span to keep the caret visible;
      // a leftover scrollLeft on a nowrap+ellipsis span paints as a BLANK title.
      titleRef.current.scrollLeft = 0;
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
  // Two red affordances (2026-08-14): the row TINT follows the phase — a task at
  // AGENT_COMPLETE stays red until the human acts (opening it
  // is not acting). The DOT follows the stored unread marker and clears on open.
  const needsAction = taskNeedsAction(task);
  const unread = !isDone && Boolean(task.unread);
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
      className={`todo-pinned-card${isFocused ? ' todo-pinned-card-active' : ''}${needsAction ? ' todo-pinned-card-needs-action' : ''}${isSessionOpen ? ' todo-pinned-card-session-open' : ''}${isDone ? ' todo-pinned-card-done' : ''}${isVanishing ? ' todo-card-vanishing' : ''}`}
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
          className={`todo-recent-tier-dot todo-tier-icon-${isBuiltinTier(pinnedTier) ? pinnedTier : 'custom'}`}
          title={`Pinned \u2014 ${pinnedTierLabel ?? (pinnedTier === 'focus' ? 'Focus' : pinnedTier === 'backlog' ? 'Backlog' : pinnedTier === 'wait' ? 'Wait' : 'Satellite')}`}
        >
          {ICONS.tierIcon(pinnedTier)}
        </span>
      )}
      {/* Unread dot — the tinted background alone was too subtle on a dense
          pinned strip, and the user asked for the dot on these cards too. */}
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
      {/* One-click ▶ Start — hover-revealed, before the kebab */}
      <TaskStartButton task={task} isDone={isDone} onStartSession={onStartSession} />
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
        onPinTask={onPinTask}
        onUnpinTask={onUnpinTask}
        onSetTier={onSetTier}
        onOpenSession={onOpenSession}
        onStartSession={onStartSession}
        onMoveToProject={onMoveToProject}
        onDelete={onDelete}
      />
    </div>
  );
}

// ── TodoPanel ──

export const TodoPanel = memo(function TodoPanel({ tasks: rawTasks, loading, onComplete, onSetPhase, onCreate, onUpdate, onDelete, onBatchSetPhase, onBatchDelete, onSetPriority, onFocusTask, onClearFocus, focusedTaskId, focusNonce, focusScope, favorites, ordering, onReorder, onMoveTask, onReparentTask, onBakeOrder, onOpenSession, onStartSession, onOpenTriageForTask, onPinTask, onUnpinTask, onReorderPinned, onSetTier, onSetDate, onSetStartDate, pinnedTaskIds, focusTaskIds, backlogTaskIds, waitTaskIds, customTiers: customTiersLive, customTiersLoaded, customTierIds, suppressDetail, openSessionIds, openSessionTaskIds, onOperationError, externalProject, onProjectChange, onOpenLauncher, onOpenLauncherForProject, onOpenLauncherForTier, taskGroups, hiddenGroups, onGroupTasks, onAddToGroup, onUngroupTask, onUngroupTasks, onRenameGroup, onSetGroupHidden }: TodoPanelProps) {
  // TEMP drag-flash trace — remove after diagnosis
  const __renderCountRef = useRef(0);
  __renderCountRef.current += 1;
  scrollLog('drag-trace-TodoPanel-render', { n: __renderCountRef.current, tasks: rawTasks.length });
  // Hide .metadata* tasks (legacy project-configuration sentinels, not user-visible)
  const tasks = useMemo(() => rawTasks.filter((t) => !t.title.startsWith('.metadata')), [rawTasks]);
  // Always-current task list for drag closures (drag handlers freeze their deps).
  const tasksRef = useRef<Task[]>(tasks);
  tasksRef.current = tasks;
  const navigate = useNavigate();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const [showCompleted, setShowCompleted] = useState(false);
  const [phaseFilter, setPhaseFilter] = useState('');
  // Canonical composable query (src/core/task-query.ts) — the same model REST
  // and the agent tool use. Starts neutral: the legacy showCompleted toggle
  // still owns "hide done" on this surface, so seeding a completion condition
  // here would double-apply it and fight the toggle.
  const [taskQueryState, setTaskQueryState] = useState<TaskQueryFilterState>(DEFAULT_TASK_QUERY_FILTER_STATE);
  /** An explicit pinned condition (Yes OR No) routes pinned tasks through the
   *  normal filtered list and suppresses the separate Focus/Pinned area — no
   *  duplicate rows, and a completed-but-pinned task becomes reachable. */
  const pinnedQueryActive = isPinnedFiltered(taskQueryState);
  // The focus-override effect (far above the query memos in source order, and
  // deliberately not re-run on filter changes) reads these predicates through
  // refs. Both are published from a post-commit effect below, never during
  // render: a render can be thrown away or replayed (StrictMode, Suspense), so
  // assigning a ref in the render body can leave the ref pointing at a predicate
  // from a render React discarded.
  const matchesQueryRef = useRef<(t: Task) => boolean>(() => true);
  const completedBypassRef = useRef<(t: Task) => boolean>(() => false);
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
  // Active project tab. '' = All, INBOX_TAB = Inbox, else a project name.
  const [activeProject, setActiveProject] = useState(readTab);

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

  // Apply externally-set project (e.g. from URL deep link)
  const prevExternalProjRef = useRef(externalProject);
  useEffect(() => {
    if (externalProject !== undefined && externalProject !== prevExternalProjRef.current) {
      setActiveProject(externalProject);
      persistTab(externalProject);
    }
    prevExternalProjRef.current = externalProject;
  }, [externalProject]);

  // Auto-refresh tick: bump every 60s so time-dependent UI re-evaluates —
  // the date filter (deferred tasks appear on time) AND the per-row ▶ start
  // pill, which renders in the "All" view too, so the timer runs always.
  const [_tick, setTick] = useState(0);
  useEffect(() => {
    // visibleInterval: hidden tabs skip the re-render tick; one catch-up on return.
    return visibleInterval(() => setTick((t) => t + 1), 60_000);
  }, []);

  // Registry projects (incl. zero-task ones) + provider source for the badges.
  const projectRegistry = useProjectRegistry();
  // Project header "+ → Add task": open that group's ghost add row (the group's
  // own inline editor — creation stays physically IN the group, so "where does
  // it land" needs no explanation). Nonce so re-clicks re-open after an Escape.
  const [headerAddSignal, setHeaderAddSignal] = useState<{ project: string; nonce: number } | null>(null);
  const handleHeaderAddTask = useCallback((project: string) => {
    setCollapsedProjects((prev) => {
      if (!prev.has(project)) return prev;
      const next = new Set(prev);
      next.delete(project);
      persistSet(LS_COLLAPSED_PROJS_KEY, next);
      return next;
    });
    setHeaderAddSignal((prev) => ({ project, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  // Consume-once acknowledgment from the target InlineAdd (see its effect).
  const clearHeaderAddSignal = useCallback(() => setHeaderAddSignal(null), []);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_SECTIONS_KEY));
  // True while a search query is active (assigned during render below). A live
  // search force-expands every region, so chevron clicks are ignored — otherwise
  // a click on a visually-open header would silently flip the PERSISTED collapse
  // state with zero visible effect until the query is cleared.
  const isSearchModeRef = useRef(false);
  const toggleSection = useCallback((id: string) => {
    if (isSearchModeRef.current) return;
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      persistSet(LS_COLLAPSED_SECTIONS_KEY, next);
      return next;
    });
  }, []);
  // Prune localStorage orphans of DELETED custom tiers once the registry is
  // known: collapsed-section entries and per-tier resize heights (the latter
  // matter doubly — ui-prefs-sync mirrors `open-walnut-*` keys to the server,
  // so orphans would replicate to every browser forever).
  useEffect(() => {
    if (!customTiersLoaded) return;
    const live = new Set((customTiersLive ?? []).map((t) => t.id));
    setCollapsedSections((prev) => {
      const stale = [...prev].filter((id) => id.startsWith('ct_') && !live.has(id));
      if (stale.length === 0) return prev;
      const next = new Set(prev);
      for (const id of stale) next.delete(id);
      persistSet(LS_COLLAPSED_SECTIONS_KEY, next);
      return next;
    });
    try {
      const HEIGHT_PREFIX = 'open-walnut-focus-tier-height-ct_';
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith(HEIGHT_PREFIX) && !live.has(key.slice('open-walnut-focus-tier-height-'.length))) {
          localStorage.removeItem(key);
        }
      }
    } catch { /* storage disabled */ }
  }, [customTiersLoaded, customTiersLive]);

  // ── Section tabs ──
  // Which of Focus / Satellite / Backlog / Wait / Recent / Tasks / Notes owns the panel
  // right now ('all' = the legacy stacked view, kept for cross-tier drag).
  // `collapsedSections` is still the *within-a-view* chevron state; these two are
  // independent — in single-section mode the region renders regardless of its
  // collapse flag (a tab you just picked must never show up already folded).
  const [activeSection, setActiveSection] = useState<TodoSection>(readSection);
  // Per-tier view mode (project clustering vs raw pin order) — see TierViewMode.
  const [tierViewModes, setTierViewModes] = useState<Record<string, TierViewMode>>(readTierViewModes);
  const tierViewMode = useCallback(
    (tier: string): TierViewMode => tierViewModes[tier] ?? 'project',
    [tierViewModes],
  );
  const setTierViewMode = useCallback((tier: string, mode: TierViewMode) => {
    setTierViewModes((prev) => {
      const next = { ...prev, [tier]: mode };
      persistTierViewModes(next);
      return next;
    });
  }, []);
  // Recent tab sort mode (updated-activity vs creation time) — see RecentSortMode.
  const [recentSortMode, setRecentSortMode] = useState<RecentSortMode>(readRecentSortMode);
  const handleRecentSortChange = useCallback((mode: RecentSortMode) => {
    setRecentSortMode(mode);
    persistRecentSortMode(mode);
  }, []);
  // Ephemeral view override while a search query is active. Search defaults to the
  // stacked All view (every region shows its matches at once); picking a tab during
  // a search narrows the view WITHOUT touching the persisted tab, so clearing the
  // query drops back to wherever the user was before searching.
  const [searchSection, setSearchSection] = useState<TodoSection | null>(null);
  // Mirror in a ref: the focus/locate effect reads the current section but must NOT
  // list it as a dependency (a tab switch would re-run the whole locate pass).
  // Holds the EFFECTIVE section (assigned after search-view resolution below).
  const activeSectionRef = useRef<TodoSection>(activeSection);
  const handleSectionChange = useCallback((section: TodoSection) => {
    if (isSearchModeRef.current) { setSearchSection(section); return; }
    setActiveSection(section);
    persistSection(section);
  }, []);
  // Self-heal a stale custom-tier tab: if the active tab is a deleted tier's id
  // (registry loaded, id absent), fall back to Focus instead of an empty panel.
  // MUST wait for customTiersLoaded: the registry starts as [] while the fetch is
  // in flight, and healing against that empty snapshot would reset (and
  // persistSection-overwrite) the user's ct_* tab on every single page load.
  // Heals BOTH tab states directly (not via handleSectionChange, whose search-mode
  // branch would divert the persisted-tab heal into the ephemeral override and
  // leave the deleted ct_* id to resurface as an empty panel after the search).
  useEffect(() => {
    if (!customTiersLoaded || !customTiersLive) return;
    const isDeleted = (s: TodoSection | null) =>
      !!s && s.startsWith('ct_') && !customTiersLive.some((t) => t.id === s);
    if (isDeleted(activeSection)) { setActiveSection('focus'); persistSection('focus'); }
    if (isDeleted(searchSection)) setSearchSection('focus');
  }, [activeSection, searchSection, customTiersLive, customTiersLoaded]);
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

  // Per-tier resize: each built-in tier (Focus/Satellite/Backlog/Wait) gets its own
  // drag handle at the bottom of its card list, independent of the others and of the overall
  // Pinned/list splitter above. Height is `null` (auto) until the user drags.
  const focusResize = useResizableHeight('open-walnut-focus-tier-height-focus', { min: 60, max: 1200 });
  const satelliteResize = useResizableHeight('open-walnut-focus-tier-height-satellite', { min: 60, max: 1200 });
  const backlogResize = useResizableHeight('open-walnut-focus-tier-height-backlog', { min: 60, max: 1200 });
  const waitResize = useResizableHeight('open-walnut-focus-tier-height-wait', { min: 60, max: 1200 });
  // Recent gets the same treatment — before this it was hard-capped at ~3 rows
  // (RECENT_VISIBLE_MAX * 30) with no way to pull it taller.
  const recentResize = useResizableHeight('open-walnut-focus-tier-height-recent', { min: 60, max: 1200 });

  // Determine if search mode is active (query entered)
  const isSearchMode = searchQuery.trim().length > 0;

  // ── Section-tab view resolution ──
  // Search defaults to the stacked All view so EVERY region (pinned tiers, Recent,
  // Tasks) shows its matches at once — the user finds the hit at a glance no matter
  // where it lives. Tabs stay usable during a search via the ephemeral
  // `searchSection` override; the persisted tab is untouched, so clearing the query
  // restores the pre-search view.
  isSearchModeRef.current = isSearchMode;
  const rawSection: TodoSection = isSearchMode ? (searchSection ?? 'all') : activeSection;
  // A pinned condition empties the tier regions on purpose (dedup — the pins are
  // in the main list now), so a tier TAB would be a blank panel. Show the Tasks
  // list instead. Ephemeral: the persisted tab is untouched, so clearing the
  // condition returns the user to the tier they were on.
  const isTierSection = (s: TodoSection) =>
    s === 'focus' || s === 'satellite' || s === 'backlog' || s === 'wait' || s.startsWith('ct_');
  const effectiveSection: TodoSection = pinnedQueryActive && isTierSection(rawSection) ? 'tasks' : rawSection;
  activeSectionRef.current = effectiveSection;
  // Drop the ephemeral override when the query is cleared, so the next search
  // starts from the All default again.
  useEffect(() => {
    if (!isSearchMode && searchSection !== null) setSearchSection(null);
  }, [isSearchMode, searchSection]);
  const isAll = effectiveSection === 'all';
  /** True when `section` should be mounted: either we're in the stacked view or it IS the active tab. */
  const showSection = useCallback(
    (section: TodoSection) => isAll || effectiveSection === section,
    [isAll, effectiveSection],
  );
  /** Within the active view, is this region folded? Only the stacked view honors
   *  chevrons — and a live search ignores them entirely (a hit hidden inside a
   *  folded region would read as "search found nothing"). The persisted collapse
   *  state is untouched; clearing the query folds things back. */
  const isFolded = useCallback(
    (id: string) => isAll && !isSearchMode && collapsedSections.has(id),
    [isAll, isSearchMode, collapsedSections],
  );
  /** Chevron direction — must track the CONTENT (isFolded), not the raw collapsed
   *  set, or a search's force-expand would show open regions with "collapsed" arrows. */
  const chevronCollapsed = useCallback(
    (id: string) => !isSearchMode && collapsedSections.has(id),
    [isSearchMode, collapsedSections],
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
    // scroll the Pinned region only. Switching the TASKS tab to the capture project
    // filtered the list below down to ~1 task and read as data loss.
    const pinnedOnly = focusScope === 'pinned';
    scrollLog('focus-effect-run', { taskId: focusedTaskId.substring(0, 12), isNewFocus, proj: task.project, activeTab: activeProject, scope: focusScope ?? 'all' });

    // Switch to the task's project tab (unless already showing All). `proj` is the
    // GROUP key ('' = Inbox); `projTab` is the TAB id, where '' is taken by the All
    // chip so Inbox rides the INBOX_TAB sentinel instead.
    const proj = task.project || '';
    const projTab = proj || INBOX_TAB;
    if (isUserLocate && !pinnedOnly) {
      if (activeProject !== '' && activeProject !== projTab) {
        setActiveProject(projTab);
        persistTab(projTab);
        onProjectChange?.(projTab);
      }

      // Expand the collapsed project group (collapse keys are plain project names)
      if (collapsedProjects.has(proj)) {
        setCollapsedProjects((prev) => {
          const next = new Set(prev);
          next.delete(proj);
          persistSet(LS_COLLAPSED_PROJS_KEY, next);
          return next;
        });
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
    // Note: activeProject is NOT checked here — tab-switching above already ensures
    // the task's project is visible. Override only handles toolbar filters.
    // Row conditions go through the SAME shared predicate the list uses (read via
    // a ref: this effect's deps deliberately don't include filter state), so
    // "would the list hide this?" can no longer drift from "does the list hide it".
    const isDone = task.status === 'done';
    const wouldBeHidden =
      (isDone && !completedBypassRef.current(task) && !showCompleted && phaseFilter !== 'COMPLETE') ||
      !matchesQueryRef.current(task) ||
      (!!dateFilter && !isDone && !matchesDateFilter(task, dateFilter, tasks));

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
      let tierKey = focusTaskIds?.has(focusedTaskId) ? 'focus'
        : backlogTaskIds?.has(focusedTaskId) ? 'backlog'
        : waitTaskIds?.has(focusedTaskId) ? 'wait'
        : 'satellite';
      if (tierKey === 'satellite' && customTierIds) {
        for (const [tid, ids] of Object.entries(customTierIds)) {
          if (ids.has(focusedTaskId)) { tierKey = tid; break; }
        }
      }
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
      // STAY PUT whenever the current view already shows the task — the stacked
      // view, the Tasks list (pinned tasks are ordinary rows there), and the
      // task's own tier tab all do. Clicking a card must never yank the user to
      // a different tab (the old "click in Tasks → teleport to its Pin tier"
      // complaint). Only an off-view locate (chat/session ref while some OTHER
      // tier/Recent/Notes tab is showing) switches — to the stacked All view,
      // which shows the task in its tier AND the list at once.
      const cur = activeSectionRef.current;
      if (cur !== 'all' && cur !== 'tasks' && cur !== tierKey) handleSectionChange('all');
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
  }, [focusedTaskId, focusNonce, tasks, activeProject, collapsedProjects, favorites]);

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
  //
  // The window is SHARED, not per-task: completing another task while earlier ones
  // are still in grace pushes ONE deadline forward (latest completion + GRACE_MS) and
  // the whole in-grace batch exits together at that deadline. Per-task timers made
  // rows vanish one by one under the user's cursor while they were still checking off
  // the rest of the list. Timeline per batch: rows sit still (green tint) until
  // deadline − 600ms, fade out over 450ms, then unmount together at the deadline
  // (150ms slack so the exit animation finishes BEFORE the rows unmount — otherwise
  // the removal still reads as a pop).
  const GRACE_MS = 3_150;
  const EXIT_ANIM_MS = 450;
  const EXIT_SLACK_MS = 150;
  const recentlyCompletedRef = useRef<Set<string>>(new Set());
  const graceDeadlineRef = useRef(0);
  const graceExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recentTick, setRecentTick] = useState(0);
  // True only during the batch's final fade window — gates the exit-animation class
  // so a held row doesn't start (and finish) its CSS exit long before the shared
  // deadline when a later completion extended it.
  const [graceExiting, setGraceExiting] = useState(false);

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

  /** (Re)arm the two shared batch timers against the current deadline. Called on
   *  every deadline extension — a batch mid-fade snaps back to fully visible and
   *  holds again, which is exactly the "wait for the latest one" contract. */
  const armGraceTimers = useCallback(() => {
    if (graceExitTimerRef.current) clearTimeout(graceExitTimerRef.current);
    if (graceClearTimerRef.current) clearTimeout(graceClearTimerRef.current);
    const untilDeadline = Math.max(0, graceDeadlineRef.current - Date.now());
    setGraceExiting(false);
    graceExitTimerRef.current = setTimeout(() => {
      setGraceExiting(true);
    }, Math.max(0, untilDeadline - (EXIT_ANIM_MS + EXIT_SLACK_MS)));
    graceClearTimerRef.current = setTimeout(() => {
      recentlyCompletedRef.current.clear();
      graceDeadlineRef.current = 0;
      graceExitTimerRef.current = null;
      graceClearTimerRef.current = null;
      setGraceExiting(false);
      setRecentTick((n) => n + 1);
    }, untilDeadline);
  }, []);

  useEffect(() => {
    let extended = false;
    for (const task of tasks) {
      if (task.status === 'done' && task.completed_at && !recentlyCompletedRef.current.has(task.id)) {
        const completedAt = new Date(task.completed_at).getTime();
        const elapsed = Date.now() - completedAt;
        if (elapsed >= 0 && elapsed < GRACE_MS) {
          recentlyCompletedRef.current.add(task.id);
          // ONE shared deadline for the whole batch: latest completion + GRACE_MS.
          graceDeadlineRef.current = Math.max(graceDeadlineRef.current, completedAt + GRACE_MS);
          extended = true;
        }
      }
    }
    // Reopened tasks leave the batch immediately (they're visible again anyway).
    let removed = false;
    for (const taskId of recentlyCompletedRef.current) {
      const task = tasks.find((t) => t.id === taskId);
      if (!task || task.status !== 'done') {
        recentlyCompletedRef.current.delete(taskId);
        removed = true;
      }
    }
    if (extended) armGraceTimers();
    else if (removed && recentlyCompletedRef.current.size === 0) {
      // Batch emptied by reopens — disarm so the stale timers don't flash graceExiting.
      if (graceExitTimerRef.current) { clearTimeout(graceExitTimerRef.current); graceExitTimerRef.current = null; }
      if (graceClearTimerRef.current) { clearTimeout(graceClearTimerRef.current); graceClearTimerRef.current = null; }
      graceDeadlineRef.current = 0;
      setGraceExiting(false);
    }
    // Trigger re-render so the filters re-run with the new grace entries
    if (extended || removed) setRecentTick((n) => n + 1);
  }, [tasks, armGraceTimers]);

  // Cleanup shared timers on unmount
  useEffect(() => () => {
    if (graceExitTimerRef.current) clearTimeout(graceExitTimerRef.current);
    if (graceClearTimerRef.current) clearTimeout(graceClearTimerRef.current);
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
  const lastPinStateRef = useRef<Map<string, { pinned: boolean; tier: string }>>(new Map());
  useEffect(() => {
    for (const t of tasks) {
      // Snapshot only while OPEN — once done, the entry must stay frozen at its
      // pre-completion value (the server has already dropped it from the sets).
      if (t.status !== 'done' && t.phase !== 'COMPLETE') {
        let tier = 'satellite';
        if (focusTaskIds?.has(t.id)) tier = 'focus';
        else if (backlogTaskIds?.has(t.id)) tier = 'backlog';
        else if (waitTaskIds?.has(t.id)) tier = 'wait';
        else if (customTierIds) {
          for (const [tid, ids] of Object.entries(customTierIds)) {
            if (ids.has(t.id)) { tier = tid; break; }
          }
        }
        lastPinStateRef.current.set(t.id, {
          pinned: pinnedTaskIds?.has(t.id) ?? false,
          tier,
        });
      }
    }
  }, [tasks, pinnedTaskIds, focusTaskIds, backlogTaskIds, waitTaskIds, customTierIds]);

  // Active pinned-drag id — declared BEFORE every pinned render-model memo below so
  // they can freeze on it (useFrozenWhile) while a drag is live.
  const [activeDragPinnedId, setActiveDragPinnedId] = useState<string | null>(null);
  const isPinnedDragActive = activeDragPinnedId !== null;
  // The tier REGISTRY freezes too: a cross-client tier create/delete mid-drag
  // (config:changed{focus_tiers} → refetch) would otherwise swap DROP_ZONE_TIERS,
  // unmount a CustomTierSubgroup's SortableContext inside the active DndContext,
  // and desync dragEnd's snapshot (snap.tiers has no entry for a tier born
  // mid-drag) — the same churn class useFrozenWhile exists to stop.
  const customTiers = useFrozenWhile(customTiersLive, isPinnedDragActive);

  /** Pinned-membership set widened to include tasks still inside the grace window. */
  const pinnedIdsWithGrace = useMemo(() => {
    const out = new Set(pinnedTaskIds ?? []);
    for (const t of tasks) {
      if (keepWhileCompleting(t) && lastPinStateRef.current.get(t.id)?.pinned) out.add(t.id);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recentTick re-runs when a grace window opens/closes
  }, [tasks, keepWhileCompleting, pinnedTaskIds, recentTick]);

  // ONE pass over tasks collecting every tier's in-grace ids — this feeds all
  // 2+N tier sets below. The per-tier variant used to rescan the full task list
  // per tier (O(tasks × tiers)); with custom tiers that multiplied the panel's
  // hottest recompute path by the registry size.
  const graceAdditions = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of tasks) {
      if (!keepWhileCompleting(t)) continue;
      const st = lastPinStateRef.current.get(t.id);
      if (!st?.pinned) continue;
      const arr = map.get(st.tier);
      if (arr) arr.push(t.id); else map.set(st.tier, [t.id]);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recentTick re-runs when a grace window opens/closes
  }, [tasks, keepWhileCompleting, recentTick]);

  /** Per-tier membership set widened to include tasks still inside the grace window.
   *  Grace is empty almost always — the fast path returns `live` unchanged (stable
   *  identity, no allocation; callers treat these sets as read-only). */
  const tierGraceUnion = useCallback((live: Set<string> | undefined, tierKey: string): Set<string> => {
    const extra = graceAdditions.get(tierKey);
    if (!extra || extra.length === 0) return live ?? EMPTY_ID_SET;
    const out = new Set(live ?? []);
    for (const id of extra) out.add(id);
    return out;
  }, [graceAdditions]);

  const focusIdsWithGrace = useMemo(() => tierGraceUnion(focusTaskIds, 'focus'), [tierGraceUnion, focusTaskIds, recentTick]);
  const backlogIdsWithGrace = useMemo(() => tierGraceUnion(backlogTaskIds, 'backlog'), [tierGraceUnion, backlogTaskIds, recentTick]);
  const waitIdsWithGrace = useMemo(() => tierGraceUnion(waitTaskIds, 'wait'), [tierGraceUnion, waitTaskIds, recentTick]);
  // Custom tiers: one grace-widened membership set per registered tier id.
  const customIdsWithGrace = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const def of customTiers ?? []) {
      map[def.id] = tierGraceUnion(customTierIds?.[def.id], def.id);
    }
    return map;
  }, [tierGraceUnion, customTiers, customTierIds, recentTick]);
  // Union of every custom tier's members — the satellite bucket excludes these.
  const customMemberIds = useMemo(() => {
    const s = new Set<string>();
    for (const ids of Object.values(customIdsWithGrace)) for (const id of ids) s.add(id);
    return s;
  }, [customIdsWithGrace]);

  // Resolve pinned task IDs to Task objects for the pinned section
  // Filter out completed tasks (status=done or phase=COMPLETE) for display, and
  // members of a HIDDEN group — hiding collapses the whole cluster out of the Focus
  // area (membership untouched; unhide via a member's kebab / the /tasks page). This
  // single filter propagates to every tier + clustering + drag for free.
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

  // Split pinned into Focus / Satellite / Backlog / Wait / custom tiers
  const focusTasksLocal = useMemo(() => {
    if (focusIdsWithGrace.size === 0) return [];
    return pinnedTasks.filter((t) => focusIdsWithGrace.has(t.id));
  }, [pinnedTasks, focusIdsWithGrace]);

  // Satellite = the default bucket: not focus/backlog/wait, not in any custom tier.
  const satelliteTasksLocal = useMemo(() =>
    pinnedTasks.filter((t) => !focusIdsWithGrace.has(t.id) && !backlogIdsWithGrace.has(t.id) && !waitIdsWithGrace.has(t.id) && !customMemberIds.has(t.id)),
  [pinnedTasks, focusIdsWithGrace, backlogIdsWithGrace, waitIdsWithGrace, customMemberIds]);

  const backlogTasksLocal = useMemo(() => {
    if (backlogIdsWithGrace.size === 0) return [];
    return pinnedTasks.filter((t) => backlogIdsWithGrace.has(t.id));
  }, [pinnedTasks, backlogIdsWithGrace]);

  const waitTasksLocal = useMemo(() => {
    if (waitIdsWithGrace.size === 0) return [];
    return pinnedTasks.filter((t) => waitIdsWithGrace.has(t.id));
  }, [pinnedTasks, waitIdsWithGrace]);

  // Per custom tier: registry order defines section order; membership from grace sets.
  const customTasksLocal = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const def of customTiers ?? []) {
      const ids = customIdsWithGrace[def.id];
      map[def.id] = ids && ids.size > 0 ? pinnedTasks.filter((t) => ids.has(t.id)) : [];
    }
    return map;
  }, [pinnedTasks, customTiers, customIdsWithGrace]);

  // Helper: resolve a task's current tier
  const getTier = useCallback((taskId: string): FocusTier | undefined => {
    if (!pinnedIdsWithGrace.has(taskId)) return undefined;
    if (focusIdsWithGrace.has(taskId)) return 'focus';
    if (backlogIdsWithGrace.has(taskId)) return 'backlog';
    if (waitIdsWithGrace.has(taskId)) return 'wait';
    for (const [tid, ids] of Object.entries(customIdsWithGrace)) {
      if (ids.has(taskId)) return tid;
    }
    return 'satellite';
  }, [pinnedIdsWithGrace, focusIdsWithGrace, backlogIdsWithGrace, waitIdsWithGrace, customIdsWithGrace]);

  // Recent tasks: an ACTIVITY FEED — every recently created/updated task pops up
  // here, INCLUDING pinned ones (they render in their tier AND here; the Recent
  // card shows a tier dot and isn't draggable — it's already placed). When "Show
  // completed" is on, recently completed tasks surface too, ranked by completion.
  // FROZEN during a pinned drag: Recent sorts by last_session_update/updated_at and
  // shares the pinned DndContext — a mid-drag re-sort moves/remounts cards and
  // feeds the useRect #185 loop. Converges to live order on drop.
  const recentTasksLive = useMemo(() => {
    // 'updated': most recent of creation / any update / session activity /
    // completion (the activity feed). 'created': pure creation time.
    const recentTime = (t: Task) => {
      let m = t.created_at ?? '';
      if (recentSortMode === 'created') return m;
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
  }, [tasks, showCompleted, keepWhileCompleting, recentTick, recentSortMode]);
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

  // Every tier key in render order: built-ins then registry-ordered customs.
  // Currently only feeds DROP_ZONE_TIERS — drag-start snapshots and the render
  // loop enumerate built-ins + customTiers themselves (they need per-tier data,
  // not just keys). Keep the orders in sync if you reorder either list.
  const allTierKeys = useMemo<FocusTier[]>(
    () => ['focus', 'satellite', 'backlog', 'wait', ...(customTiers ?? []).map((t) => t.id)],
    [customTiers],
  );
  const DROP_ZONE_TIERS = useMemo<Record<string, FocusTier>>(() => {
    const map: Record<string, FocusTier> = {};
    for (const k of allTierKeys) map[`${k}-drop-zone`] = k;
    return map;
  }, [allTierKeys]);

  // Local tier arrays that can be overridden during drag
  // Drag overlay arrays stored as refs (NOT state) to avoid triggering React re-renders
  // during DnD Kit's rapid onDragOver events. A single tick counter forces a re-render
  // when we explicitly want the UI to update (during over + on end).
  // One Map keyed by tier (built-in name or custom id) replaces the old three
  // fixed refs — null = not dragging.
  const dragTierIdsRef = useRef<Map<FocusTier, string[]> | null>(null);
  const [, setDragTick] = useState(0);
  const dragRafRef = useRef(0);
  const bumpDragTick = useCallback(() => {
    if (dragRafRef.current) return; // already scheduled this frame
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = 0;
      setDragTick(n => n + 1);
    });
  }, []);
  // Convenience getter for the current render
  const dragTierIds = dragTierIdsRef.current;

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
  // Project clustering layers on top of group clustering (folder labels render
  // per project run in renderTierItems). Both skip mid-drag for the same reason.
  // In 'custom' view mode a tier SKIPS project clustering entirely — the raw pin
  // order is the render order (group clustering stays: a group must never split).
  // Separator records — read here (early) because clusterForTier below inserts
  // custom-mode lines into the tier id arrays as REAL sortable units. The rest of
  // the separator machinery (drag state, add/delete/rename) lives further down.
  const separators = ordering?.separators ?? NO_SEPARATORS;
  const clusterForTier = useCallback((tier: string, tierTasks: Task[]): string[] => {
    const grouped = clusterTierByGroup(tierTasks);
    const isCustom = tierViewMode(tier) === 'custom';
    const projected = isCustom
      ? grouped
      : clusterTierByProject(grouped, tierTasks, ordering?.projectOrder);
    // Chip sentinels go in LAST — see withGroupSentinels for why they must not be
    // visible to the project clustering pass.
    const withChips = withGroupSentinels(projected, tierTasks, tier);
    if (!isCustom) return withChips; // project-mode lines anchor folders → plain DOM rows
    // Custom-mode divider lines ride the items array itself (withSeparatorSentinels):
    // in `items`, the strategy displaces a line with the cards around it, so a card
    // can never visually cross it mid-drag (2026-08-25) and a slot can open above a
    // top-anchored line.
    const byId = new Map(tierTasks.map((t) => [t.id, t]));
    return withSeparatorSentinels({
      ids: withChips, separators, tier,
      groupOf: (id) => byId.get(id)?.group_id ?? null,
      isTaskId: (id) => byId.has(id),
    });
  }, [tierViewMode, ordering?.projectOrder, separators]);
  const focusIds_arr = useMemo(() => dragTierIds?.get('focus') ?? clusterForTier('focus', focusTasksLocal), [dragTierIds, focusTasksLocal, clusterForTier]);
  const satelliteIds_arr = useMemo(() => dragTierIds?.get('satellite') ?? clusterForTier('satellite', satelliteTasksLocal), [dragTierIds, satelliteTasksLocal, clusterForTier]);
  const backlogIds_arr = useMemo(() => dragTierIds?.get('backlog') ?? clusterForTier('backlog', backlogTasksLocal), [dragTierIds, backlogTasksLocal, clusterForTier]);
  const waitIds_arr = useMemo(() => dragTierIds?.get('wait') ?? clusterForTier('wait', waitTasksLocal), [dragTierIds, waitTasksLocal, clusterForTier]);
  const customIds_arr = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const def of customTiers ?? []) {
      const tierTasks = customTasksLocal[def.id] ?? [];
      map[def.id] = dragTierIds?.get(def.id) ?? clusterForTier(def.id, tierTasks);
    }
    return map;
  }, [dragTierIds, customTiers, customTasksLocal, clusterForTier]);

  const pinnedTaskMap = useMemo(() => new Map(pinnedTasks.map((t) => [t.id, t])), [pinnedTasks]);

  // ── Separator persistence + move-time anchor maintenance ── Declared up here
  // (not with the rest of the separator UI far below) because the drag handlers
  // need them directly. persistSeparators is the single write path for every
  // separator mutation.
  const persistSeparators = useCallback((next: TierSeparator[]) => {
    if (!ordering?.saveSeparators) return;
    void ordering.saveSeparators(next).catch((err) => {
      onOperationError?.(err instanceof Error ? err.message : String(err));
    });
  }, [ordering, onOperationError]);

  // Rule 5 (tier-separators.ts): a drag that RELOCATES a card must not tow the
  // divider lines anchored to it. Custom mode only: project-mode lines anchor
  // FOLDERS, which stay put when one card moves.
  const sepReanchor = useCallback((tier: string, beforeIds: string[], movedIds: string[]) => {
    if (tierViewMode(tier) !== 'custom') return;
    const next = reanchorSeparatorsAfterMove({
      separators, tier, beforeIds, movedIds,
      groupOf: (id) => pinnedTaskMap.get(id)?.group_id ?? null,
    });
    if (next !== separators) persistSeparators(next);
  }, [tierViewMode, separators, persistSeparators, pinnedTaskMap]);

  /** Rewrite custom-mode line anchors from the FINAL post-drop arrays, one persist
   *  for all affected tiers. With lines living in `items`, the last frame dnd-kit
   *  showed IS the gesture's truth — deriving anchors from it means nothing jumps
   *  after the drop lands. */
  const syncCustomSepAnchors = useCallback((tiers: Array<{ tier: string; arr: string[] }>) => {
    let next = separators;
    for (const { tier, arr } of tiers) {
      if (tierViewMode(tier) !== 'custom') continue;
      next = syncSeparatorAnchorsFromArr({
        separators: next, tier, finalArr: arr,
        isTaskId: (id) => pinnedTaskMap.has(id),
        groupOf: (id) => pinnedTaskMap.get(id)?.group_id ?? null,
        // Hidden ≠ gone: a line anchored to a card that exists but isn't in this
        // frame (completed pin, collapsed group) renders at a fallback slot — a
        // card move must not write that fallback over the durable anchor.
        isKnownTaskId: (id) => tasksRef.current.some((t) => t.id === id),
      });
    }
    if (next !== separators) persistSeparators(next);
  }, [tierViewMode, separators, persistSeparators, pinnedTaskMap]);

  // Snapshot of original tier arrays at drag start (for revert on cancel)
  // (activeDragPinnedId state lives above the pinned render-model memos — they
  // freeze on it via useFrozenWhile.) Keyed by tier like dragTierIdsRef.
  const dragStartSnapshot = useRef<{ tiers: Map<FocusTier, string[]>; recent?: string[] } | null>(null);
  const activeDragPinnedTask = useMemo(
    () => {
      if (!activeDragPinnedId || isGroupSentinel(activeDragPinnedId)) return null;
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
    if (!(activeDragPinnedId && isGroupSentinel(activeDragPinnedId))) return null;
    const gid = parseGroupSentinelGid(activeDragPinnedId);
    const members = pinnedTasks.filter((t) => t.group_id === gid);
    if (members.length === 0) return null;
    return { label: taskGroups?.[gid] ?? 'Group', titles: members.map((t) => t.title), count: members.length };
  }, [activeDragPinnedId, pinnedTasks, taskGroups]);

  // A dragged divider line renders a floating line under the cursor (the in-list
  // row stays as the dimmed slot marker, like a card's).
  const activeDragSep = useMemo(() => {
    if (!(activeDragPinnedId && isSeparatorId(activeDragPinnedId))) return null;
    return separators.find((s) => s.id === activeDragPinnedId) ?? null;
  }, [activeDragPinnedId, separators]);

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

  // Ref indirection ONLY to break a declaration-order cycle: requestMoveTask is
  // defined ~1200 lines below (it needs ensureManualSort), and naming it in this
  // handler's dep array would read a const in its temporal dead zone.
  const requestMoveTaskRef = useRef<typeof requestMoveTask | null>(null);

  // ── Unpin-by-drag ── `unpinZone` drives the portalled strip (null = no strip),
  // `unpinRectRef` is the same rect for the drop test in a handler that runs after
  // state has been torn down, `unpinHot` is the armed look.
  const pinnedWrapperRef = useRef<HTMLDivElement>(null);
  const unpinRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const [unpinZone, setUnpinZone] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [unpinHot, setUnpinHot] = useState(false);
  /** True when a release at (x, y) means "unpin". One place, so the armed look
   *  and the drop decision can never disagree. Two conditions:
   *  1. inside the strip's rect, AND
   *  2. the pointer is NOT over a real row. The strip covers the wrapper's
   *     bottom edge, and in a tier scrolled to its end the last CARDS live
   *     there too — a reorder aimed at one of them must stay a reorder (caught
   *     by e2e 2026-08-25: dropping onto the second-to-last card silently
   *     unpinned it). elementFromPoint sees the row because the strip and the
   *     DragOverlay are both pointer-events: none. */
  const overUnpinZone = useCallback((x: number, y: number) => {
    const r = unpinRectRef.current;
    if (!r || x < r.left || x > r.left + r.width || y < r.top || y > r.top + r.height) return false;
    const el = document.elementFromPoint(x, y);
    return !(el instanceof Element && el.closest('[data-task-id],[data-group-id],[data-separator-id]'));
  }, []);

  // ── Join is a POINTER decision, never a proximity one ── dnd-kit's
  // closestCenter reports the card whose center is NEAREST, which is routinely a
  // group member when the user is merely dragging PAST the cluster — and a drop
  // that lands "next to" a group must not fall into it ("他抓到哪就是哪",
  // reported 2026-08-25). Joining requires the pointer to be inside the over
  // card's rect, and only its MIDDLE band: the edge band always reads as "insert
  // between rows" (reorder), exactly like every list UI the user knows.
  //
  // WHY over.rect and not what's visually under the pointer (both probed
  // 2026-08-25): the sortable strategy previews reorders by CSS-transforming
  // rows away from the insert slot, but collision detection keeps working in
  // the STATIC layout measured at drag start. elementFromPoint always answers
  // "the card you're holding" (the active placeholder is transformed into the
  // slot, i.e. exactly under the pointer), and matching live rects oscillates:
  // pointer touches the target's visual middle → over flips → the target is
  // transformed away from the pointer → over flips back — an unlandable,
  // flickering join. over.rect is the SAME static space the collision answer
  // lives in, so the test is stable: pointer inside the target's at-drag-start
  // rect = join, and the target sliding aside is just the preview animation.
  const pinnedJoinIntent = useCallback((over: DragMoveEvent['over'], activeId: string): { joinId: string | null; chipGid: string | null } => {
    const none = { joinId: null, chipGid: null };
    if (!over) return none;
    const overId = String(over.id);
    const r = over.rect;
    const { x, y } = livePointer;
    if (x < r.left || x > r.left + r.width || y < r.top || y > r.top + r.height) return none;
    // The chip header is the one non-card surface that means "into this group".
    if (isGroupSentinel(overId)) return { joinId: null, chipGid: parseGroupSentinelGid(overId) };
    if (overId === activeId || !pinnedCardIds.has(overId)) return none;
    const band = Math.max(6, r.height * 0.25); // top/bottom quarter = reorder intent
    return y >= r.top + band && y <= r.top + r.height - band
      ? { joinId: overId, chipGid: null }
      : none;
  }, [pinnedCardIds]);

  // The join-target highlight follows the SAME test, driven by onDragMove
  // (onDragOver only fires when `over` CHANGES, but the middle-band edge crosses
  // inside one card). Contract: the blue frame and the drop decision can never
  // disagree — no lit frame, no join.
  const handlePinnedDragMove = useCallback((event: DragMoveEvent) => {
    const activeId = String(event.active.id);
    if (isGroupSentinel(activeId) || isSeparatorId(activeId)) return; // dragOver owns clearing for sentinel drags
    // GROUPED-MEMBER EXEMPTION: a member dragged out has two outcomes only —
    // reorder, or pull OUT. Lighting "join" for it caused the group-absorb bug.
    const activeGid = tasksRef.current.find((t) => t.id === activeId)?.group_id;
    const { joinId, chipGid } = activeGid ? { joinId: null, chipGid: null } : pinnedJoinIntent(event.over, activeId);
    // The chip lights nothing per-card; the frame is only for card-middle joins.
    const valid = chipGid ? null : joinId;
    const key = valid ? `${valid}:group` : null;
    if (dropIntentRef.current !== key) {
      dropIntentRef.current = key;
      setGroupTargetId(valid);
    }
  }, [pinnedJoinIntent]);
  // Arm/disarm from the pointer itself rather than from dnd-kit's collisions: the
  // strip is deliberately NOT a droppable, so closestCenter can never award it a
  // drop the user aimed at a card near the bottom of a tier.
  useEffect(() => {
    if (!unpinZone) return;
    let raf = 0;
    let x = 0;
    let y = 0;
    const apply = () => {
      raf = 0;
      const hot = overUnpinZone(x, y);
      setUnpinHot((prev) => (prev === hot ? prev : hot));
    };
    const onMove = (e: PointerEvent) => {
      x = e.clientX; y = e.clientY;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [unpinZone, overUnpinZone]);

  const handlePinnedDragStart = useCallback((event: DragStartEvent) => {
    // Freeze the CLUSTERED order (what's on screen) — not the raw pin order — so the
    // frozen refs match the rendered list and grouped members sit contiguously (a
    // prerequisite for the collapse below). One entry per tier, render order.
    const tierArrays = new Map<FocusTier, string[]>();
    tierArrays.set('focus', clusterForTier('focus', focusTasksLocal));
    tierArrays.set('satellite', clusterForTier('satellite', satelliteTasksLocal));
    tierArrays.set('backlog', clusterForTier('backlog', backlogTasksLocal));
    tierArrays.set('wait', clusterForTier('wait', waitTasksLocal));
    for (const def of customTiers ?? []) {
      const tierTasks = customTasksLocal[def.id] ?? [];
      tierArrays.set(def.id, clusterForTier(def.id, tierTasks));
    }
    const rArr = recentDraggableIds;
    dragStartSnapshot.current = { tiers: tierArrays, recent: rArr };
    // Freeze tier state — SortableContext items won't change from external events during drag
    dragTierIdsRef.current = new Map(tierArrays);
    const activeId = event.active.id as string;

    // ── Collapse-on-drag ── When a whole group is grabbed (`group:<gid>:<tier>`),
    // drop that group's member ids out of the frozen refs, leaving its sentinel
    // (already sitting immediately before them — see withGroupSentinels) to stand
    // in for the whole cluster. The group then behaves as one atomic sortable unit:
    // the strategy gives the sentinel a real activeIndex, so sibling cards push
    // away and an empty slot opens — exactly like dragging a task. Members are
    // hidden for the duration (renderTierItems draws the chip alone) and restored
    // on end.
    collapsedGroupRef.current = null;
    if (isGroupSentinel(activeId)) {
      const gid = parseGroupSentinelGid(activeId);
      // Members in on-screen order (tier render order) so the restored block
      // preserves how the user saw them.
      const orderedMembers = [...tierArrays.values()].flat().filter((id) => pinnedTaskMap.get(id)?.group_id === gid);
      if (orderedMembers.length > 0) {
        const memberSet = new Set(orderedMembers);
        const collapse = (arr: string[]): string[] => {
          const out: string[] = [];
          for (const id of arr) {
            // Members go; every other id (including this group's own sentinel and
            // OTHER groups' sentinels) stays exactly where it is.
            if (!memberSet.has(id)) out.push(id);
          }
          return out;
        };
        const collapsedMap = new Map<FocusTier, string[]>();
        for (const [tier, arr] of tierArrays) collapsedMap.set(tier, collapse(arr));
        dragTierIdsRef.current = collapsedMap;
        collapsedGroupRef.current = { sentinel: activeId, gid, members: orderedMembers };
      }
    }

    setActiveDragPinnedId(activeId);
    // ── The way OUT of the pinned area ── Dragging a card IN (from Recent, from
    // another tier) had no reverse: unpinning lived only in a card menu. A strip
    // appears over the bottom of the pinned area for the duration of the drag.
    // Its rect is captured ONCE here and the strip is portalled at fixed coords:
    // adding a real element to the wrapper mid-drag would reflow the lists and
    // dnd-kit's measured rects with them, which reads as every card jumping.
    // Only for a single PINNED card — a Recent-origin card isn't pinned yet, and a
    // whole-group sentinel would turn one gesture into N unpins.
    if (!isGroupSentinel(activeId) && pinnedTaskIds?.has(activeId) && onUnpinTask) {
      const r = pinnedWrapperRef.current?.getBoundingClientRect();
      if (r && r.height > UNPIN_ZONE_H * 2) {
        const rect = { left: r.left, top: r.bottom - UNPIN_ZONE_H, width: r.width, height: UNPIN_ZONE_H };
        unpinRectRef.current = rect;
        setUnpinZone(rect);
      }
    }
    // Track the live cursor so dragOver/End can highlight "join group" when hovering
    // a card (Pin tiers have no subtasks → the whole card is the group zone).
    window.addEventListener('pointermove', trackPointer, { passive: true });
    dropIntentRef.current = null;
    setGroupTargetId(null);
    // Cross-panel drag: announce single-task drags on the bus so out-of-context
    // targets (calendar side panel) can accept the drop. Group sentinels stay
    // in-panel — a multi-task cluster has no calendar semantics.
    const busTask = pinnedTaskMap.get(activeId)
      ?? tasksRef.current.find((t) => t.id === activeId);
    if (busTask && !isGroupSentinel(activeId)) {
      const pe = event.activatorEvent as PointerEvent | undefined;
      dragBus.begin({ kind: 'task', task: busTask }, pe?.clientX !== undefined ? { x: pe.clientX, y: pe.clientY } : undefined);
    }
  }, [focusTasksLocal, satelliteTasksLocal, backlogTasksLocal, waitTasksLocal, customTiers, customTasksLocal, recentDraggableIds, pinnedTaskMap, clusterForTier, pinnedTaskIds, onUnpinTask]);

  // Shared live-drag tier accessors: dragTierIdsRef is the live state during a
  // drag with the frozen snapshot as fallback. `findTierOf` answers "which tier
  // array currently holds this id" across built-ins AND custom tiers.
  const getLiveArr = useCallback((tier: FocusTier): string[] => {
    return dragTierIdsRef.current?.get(tier)
      ?? dragStartSnapshot.current?.tiers.get(tier)
      ?? [];
  }, []);
  const setLiveArr = useCallback((tier: FocusTier, val: string[]) => {
    // COPY-ON-WRITE, not in-place .set(): the render-side memos (focusIds_arr /
    // satelliteIds_arr / waitIds_arr / customIds_arr) key on this Map's IDENTITY.
    // The old three-ref model replaced each ref's array per write, so bumpDragTick's
    // re-render saw a new identity and recomputed; mutating one long-lived Map kept
    // the identity stable and froze the mid-drag cross-tier preview entirely.
    const base = dragTierIdsRef.current ?? dragStartSnapshot.current?.tiers ?? [];
    const next = new Map(base);
    next.set(tier, val);
    dragTierIdsRef.current = next;
  }, []);
  const findTierOf = useCallback((id: string): FocusTier | undefined => {
    const tiers = dragTierIdsRef.current ?? dragStartSnapshot.current?.tiers;
    if (!tiers) return undefined;
    for (const [tier, arr] of tiers) {
      if (arr.includes(id)) return tier;
    }
    return undefined;
  }, []);

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
    if (isGroupSentinel(activeId)) {
      if (dropIntentRef.current !== null) { dropIntentRef.current = null; setGroupTargetId((prev) => (prev === null ? prev : null)); }
      if (!dragStartSnapshot.current) return;
      // Target tier from the hovered drop-zone or the tier the over-card lives in now.
      const targetTier: FocusTier | undefined = DROP_ZONE_TIERS[overId] ?? findTierOf(overId);
      if (!targetTier || activeId === overId) return;
      const currentTier: FocusTier = findTierOf(activeId) ?? 'satellite';
      if (currentTier === targetTier) return; // same tier — strategy handles the visual
      const addAt = (arr: string[], ovId: string) => {
        const idx = arr.indexOf(ovId);
        if (idx === -1) return [...arr, activeId];
        const copy = [...arr];
        copy.splice(idx, 0, activeId);
        return copy;
      };
      setLiveArr(currentTier, getLiveArr(currentTier).filter((id) => id !== activeId));
      setLiveArr(targetTier, addAt(getLiveArr(targetTier), overId));
      bumpDragTick();
      return;
    }

    // Divider-line drag: same shape as the group-sentinel branch — the strategy
    // handles the same-tier visual, here we only move the id BETWEEN tiers so the
    // slot opens where the pointer is. A line may only land in another CUSTOM
    // tier (project-mode lines anchor folders, a different coordinate system).
    if (isSeparatorId(activeId)) {
      if (dropIntentRef.current !== null) { dropIntentRef.current = null; setGroupTargetId((prev) => (prev === null ? prev : null)); }
      if (!dragStartSnapshot.current) return;
      const targetTier: FocusTier | undefined = DROP_ZONE_TIERS[overId] ?? findTierOf(overId);
      if (!targetTier || activeId === overId) return;
      if (tierViewMode(targetTier) !== 'custom') return;
      const currentTier: FocusTier | undefined = findTierOf(activeId);
      if (!currentTier || currentTier === targetTier) return;
      const addAt = (arr: string[], ovId: string) => {
        let idx = arr.indexOf(ovId);
        if (idx === -1) return [...arr, activeId];
        // Landing on a group's first member: insert ABOVE its chip sentinel, not
        // between chip and member — pruneOrphanSentinels wants the chip heading
        // its run, and lines draw above chips anyway (withSeparatorSentinels).
        if (idx > 0 && isGroupSentinel(arr[idx - 1])) idx--;
        const copy = [...arr];
        copy.splice(idx, 0, activeId);
        return copy;
      };
      setLiveArr(currentTier, getLiveArr(currentTier).filter((id) => id !== activeId));
      setLiveArr(targetTier, addAt(getLiveArr(targetTier), overId));
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

    // (The join-target highlight is NOT set here: onDragOver only fires when the
    // collision target changes, but the middle-band edge crosses INSIDE one card.
    // handlePinnedDragMove owns the highlight — same test the drop itself uses.)

    // Determine target tier from drop zone or the CURRENT position of the over-card.
    // Use drag refs (live state during drag) with snapshot as fallback.
    // IMPORTANT: only check drag refs, not raw snapshot, for non-drop-zone items —
    // the snapshot is frozen at drag start and doesn't reflect cross-tier moves.
    const targetTier = DROP_ZONE_TIERS[overId] ?? findTierOf(overId);
    if (!targetTier) return;

    // For items from Recent: check if already placed in a tier during this drag
    if (isFromRecent) {
      const currentPlacement = findTierOf(activeId) ?? null;
      if (currentPlacement === targetTier) return;
      const remove = (arr: string[]) => arr.filter((id) => id !== activeId);
      if (currentPlacement) {
        setLiveArr(currentPlacement, remove(getLiveArr(currentPlacement)));
      }
      const targetArr = getLiveArr(targetTier);
      setLiveArr(targetTier, [...remove(targetArr), activeId]);
      bumpDragTick();
      return;
    }

    // Existing pinned-to-pinned cross-tier logic
    // Read directly from refs (live drag state) rather than memoized arrays that close
    // over render-time values. With RAF batching, refs can be mutated multiple times
    // between renders; reading stale tier data would duplicate the item across two
    // tier arrays.
    const currentTier: FocusTier = findTierOf(activeId) ?? 'satellite';
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

    setLiveArr(currentTier, remove(getLiveArr(currentTier)));
    setLiveArr(targetTier, addAt(getLiveArr(targetTier), overId));
    bumpDragTick(); // trigger visual update
  }, [bumpDragTick, pinnedCardIds, tasks, DROP_ZONE_TIERS, findTierOf, getLiveArr, setLiveArr, tierViewMode]);

  const clearDragState = useCallback(() => {
    if (dragRafRef.current) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = 0; }
    dragTierIdsRef.current = null;
    dragStartSnapshot.current = null;
    collapsedGroupRef.current = null;
    setActiveDragPinnedId(null);
    // Tear down the drop-intent highlight + live-pointer listener started in
    // handlePinnedDragStart.
    window.removeEventListener('pointermove', trackPointer);
    dropIntentRef.current = null;
    setGroupTargetId((prev) => (prev === null ? prev : null));
    unpinRectRef.current = null;
    setUnpinZone(null);
    setUnpinHot(false);
  }, []);

  const handlePinnedDragCancel = useCallback(() => {
    dragBus.cancel();
    clearDragState();
  }, [clearDragState]);

  const handlePinnedDragEnd = useCallback((event: DragEndEvent) => {
    // Cross-panel drop first: if a bus target (calendar side panel) consumed
    // the pointer-up, skip ALL in-panel drop semantics — dnd-kit's
    // closestCenter still reports an in-panel `over` even when the pointer is
    // physically outside the panel, and acting on it would reorder/retier.
    if (dragBus.end()) {
      clearDragState();
      return;
    }
    const { active, over } = event;
    const snap = dragStartSnapshot.current;

    // Released on the unpin strip → the card leaves the pinned area, and NOTHING
    // else applies (no retier, no reorder, no group join). Decided from the pointer,
    // for the reason in the effect above; `livePointer` holds the last move, which
    // is where the release happened.
    if (overUnpinZone(livePointer.x, livePointer.y)) {
      const dropped = active.id as string;
      clearDragState();
      if (!isGroupSentinel(dropped)) onUnpinTask?.(dropped);
      return;
    }

    // Capture live tier positions BEFORE clearing — handlePinnedDragOver may have
    // moved the active item cross-tier during drag. We need these to persist the
    // final position when dnd-kit reports over === active (common after cross-tier
    // moves, since the dragged card's center follows the pointer).
    const liveTiers = dragTierIdsRef.current;
    const collapsed = collapsedGroupRef.current;

    clearDragState();

    if (!over || !snap) return;
    const activeId = active.id as string;
    const overId = over.id as string;

    // Post-clear accessors over the captured maps (getLiveArr/findTierOf read the
    // refs, which clearDragState just nulled).
    const finalArr = (tier: FocusTier): string[] => liveTiers?.get(tier) ?? snap.tiers.get(tier) ?? [];
    const finalTierOf = (id: string): FocusTier | undefined => {
      for (const tier of snap.tiers.keys()) {
        if (finalArr(tier).includes(id)) return tier;
      }
      return undefined;
    };
    const snapTierOf = (id: string): FocusTier | undefined => {
      for (const [tier, arr] of snap.tiers) {
        if (arr.includes(id)) return tier;
      }
      return undefined;
    };
    // Global pinned order = tiers concatenated in render order.
    const globalOrder = (arrOf: (t: FocusTier) => string[]): string[] =>
      [...snap.tiers.keys()].flatMap((t) => arrOf(t));

    // Rule 5 (tier-separators.ts): a drag that RELOCATES a card must not tow the
    // divider lines anchored to it — re-anchor them to the neighbours that stay,
    // resolved against the PRE-drag render order. Every path below that persists
    // a move (reorder, retier, group join/leave) calls this first.
    const reanchorSeps = (tier: FocusTier | undefined, movedIds: string[]) => {
      if (!tier) return;
      sepReanchor(tier, taskIdsOnly(snap.tiers.get(tier) ?? []), movedIds);
    };

    // ── Divider-line drag (custom mode) ── The line is a real sortable unit;
    // dragOver may have moved it cross-tier, and a same-tier drop onto another
    // row means "take its slot" (mirrors the card reorder). Nothing but the
    // separator record changes — no pin order is persisted for a line move.
    if (isSeparatorId(activeId)) {
      const sep = separators.find((s) => s.id === activeId);
      if (!sep) return;
      // Landing tier = whichever live array holds the line now. A non-custom
      // tier can't take it (its lines anchor folders, not cards) — dragOver
      // refuses those moves, this is the belt to that suspender.
      let tier: FocusTier = finalTierOf(activeId) ?? (sep.tier as FocusTier);
      if (tierViewMode(tier) !== 'custom') tier = sep.tier as FocusTier;
      const arr = [...finalArr(tier)];
      if (overId !== activeId && !DROP_ZONE_TIERS[overId]) {
        const ai = arr.indexOf(activeId);
        const oi = arr.indexOf(overId);
        if (ai !== -1 && oi !== -1 && ai !== oi) {
          arr.splice(ai, 1);
          arr.splice(oi, 0, activeId);
        }
      }
      // Retier first (a cross-tier landing changes the record's tier), THEN derive
      // anchors from the final array — one persist for both. forceId: the user
      // dragged THIS line, so its gesture always wins over a hidden stored anchor;
      // the tier's other lines still get the hidden-anchor protection.
      const next = syncSeparatorAnchorsFromArr({
        separators: tier === sep.tier ? separators : upsertSeparator(separators, { ...sep, tier }),
        tier, finalArr: arr,
        isTaskId: (id) => pinnedTaskMap.has(id),
        groupOf: (id) => pinnedTaskMap.get(id)?.group_id ?? null,
        isKnownTaskId: (id) => tasksRef.current.some((t) => t.id === id),
        forceId: sep.id,
      });
      if (next !== separators) persistSeparators(next);
      return;
    }

    // In a project-clustered tier view, a drop that lands inside ANOTHER project's
    // run means "move to that project" — without this the reorder persists but the
    // project cluster pass snaps the card straight back (the reported no-op).
    // When the drop displaced a real card (`over` is a task card / group chip),
    // THAT row's project is the answer — the dragged card took its slot, so it is
    // in that run even when the slot sits at a run boundary where the neighbour
    // walk in inferTierDropProject would read the previous folder instead. The
    // walk stays as the fallback for self-drops (over === active after a dragOver
    // relocation), where the only evidence is the landing position itself.
    // allowInference=false for Recent-origin drops: dragOver APPENDS a Recent
    // card at the tier's end regardless of where the pointer hovers, so the
    // landing slot is an artifact — only an explicit over-card carries intent.
    const maybeMoveProject = (tier: FocusTier, tierIds: string[], allowInference = true) => {
      if (tierViewMode(tier) !== 'project') return;
      // A tier drop-zone names a TIER, not a slot inside it — dragOver merely
      // appended the card to the tier's end, so the neighbour walk below would
      // read "last run in the tier" out of an artifact and silently reproject a
      // pure tier-assignment gesture. Tier moves never change projects.
      if (DROP_ZONE_TIERS[overId]) return;
      const activeTask = tasks.find((t) => t.id === activeId);
      if (!activeTask) return;
      const projectOf = (id: string) => {
        const t = pinnedTaskMap.get(id) ?? tasks.find((x) => x.id === id);
        return t ? (t.project || '') : undefined;
      };
      // Only when ≥2 distinct project runs are visible (mirrors renderTierItems'
      // showFolders gate) — with a single invisible folder the gesture is plain
      // reorder. Like showFolders, count PINNED cards only: a Recent-origin card
      // mid-drop isn't pinned yet and must not make a folderless tier pass the
      // gate by bringing its own project along.
      const distinct = new Set<string>();
      for (const id of tierIds) {
        const t = pinnedTaskMap.get(id);
        if (t) distinct.add(t.project || '');
      }
      if (distinct.size < 2) return;
      let landed: string | null = null;
      if (overId !== activeId) {
        if (isGroupSentinel(overId)) {
          // A chip stands in for its whole group. Resolve the run from the id
          // right AFTER the sentinel in this tier (its first member here) — a
          // global tasks.find could hit a member parked in another tier or a
          // mixed-project group's far member.
          const si = tierIds.indexOf(overId);
          if (si !== -1) {
            for (let i = si + 1; i < tierIds.length; i++) {
              if (tierIds[i] === activeId || isGroupSentinel(tierIds[i])) continue;
              landed = projectOf(tierIds[i]) ?? null;
              break;
            }
          }
        } else {
          landed = projectOf(overId) ?? null;
        }
      }
      if (landed === null && allowInference) landed = inferTierDropProject(tierIds, activeId, projectOf);
      if (landed === null || landed === (activeTask.project || '')) return;
      // Fire-and-forget by design: the confirm (if any) resolves after this
      // handler returns, and a CANCEL leaves the already-persisted pin reorder
      // in place — the project cluster pass snaps the card back visually, at
      // the cost of a silently changed raw pin index (visible only if the tier
      // later switches to custom view). Accepted residue.
      requestMoveTaskRef.current?.(activeId, landed).catch((err) => {
        onOperationError?.(err instanceof Error ? err.message : 'Move failed');
      });
    };

    // ── Whole-group drag (chip grip) ── The active id is the `group:<gid>:<tier>`
    // sentinel that stood in for the collapsed cluster. Its FINAL tier is simply the
    // tier ref that now holds it (dragOver moved it cross-tier; same-tier position was
    // reflected by the strategy's slot). Expand the sentinel back to the ordered
    // members at its landing spot, retier any member whose tier changed, and persist.
    // DELIBERATE scope cut: dragging a whole group into another project's folder
    // does NOT reproject its members (this returns before maybeMoveProject). A
    // group can span projects, so "move them all" needs its own batch confirm —
    // use multi-select → Move to project for that today.
    if (isGroupSentinel(activeId)) {
      if (!collapsed || collapsed.members.length === 0) return;
      const orderedMembers = collapsed.members;
      const memberSet = new Set(orderedMembers);

      // The sentinel's final tier = whichever live ref contains it.
      const overTier: FocusTier = finalTierOf(activeId) ?? 'satellite';

      // Live global order (sentinel present once, members already collapsed out).
      const liveGlobal = globalOrder(finalArr);

      // Same-tier drop onto a real card: reposition the sentinel just before that card
      // (mirrors the task same-tier reorder). Drop-zone or self → keep dragOver's spot.
      let ordered = liveGlobal;
      if (overId !== activeId && !DROP_ZONE_TIERS[overId] && !memberSet.has(overId) && liveGlobal.includes(overId)) {
        ordered = liveGlobal.filter((id) => id !== activeId);
        ordered.splice(ordered.indexOf(overId), 0, activeId);
      }

      // Retier members whose ORIGINAL tier differs from the drop tier.
      for (const mid of orderedMembers) {
        const cur: FocusTier = snapTierOf(mid) ?? 'satellite';
        if (cur !== overTier) onSetTier?.(mid, overTier);
      }

      // Expand: swap the sentinel for the ordered member block; drop any stray member.
      // Other groups' sentinels ride along in `ordered` — taskIdsOnly drops them.
      const newOrder = ordered.flatMap((id) => id === activeId ? orderedMembers : (memberSet.has(id) ? [] : [id]));
      // Lines anchored to a member move with the BAND, not the block.
      reanchorSeps(snapTierOf(orderedMembers[0]), orderedMembers);
      onReorderPinned?.(taskIdsOnly(newOrder));
      return;
    }

    // Check if item came from Recent section
    const isFromRecent = snap.recent?.includes(activeId) ?? false;

    // ── Drag-into-group ── Joining a group is decided by the POINTER, never by
    // closestCenter alone: dnd-kit's `over` is the NEAREST card, which is
    // routinely a group member when the user releases beside or between rows —
    // that pulled "明明是拉到外面的" drops into the cluster (2026-08-25).
    // pinnedJoinIntent additionally requires the release point to be inside the
    // over card's rect and its MIDDLE band (the same test that lights the blue
    // frame, so no lit frame = no join); the edge band and the gaps stay plain
    // reorders. If that row is in a group, join it; if it's a loose card, group
    // the two. A chip hit means "into this group" — it used to fall through to
    // the reorder, which parked the card immediately above the cluster with no
    // join ("the whole thing moved outside", 2026-08-25). A task from Recent is
    // pinned to the target's tier first so it shows up in the cluster.
    // GUARD: only an UNGROUPED active card can join here. If the dragged card is
    // already in a group, dropping it on an outside card must NOT group-merge (that
    // ABSORBED the member's whole group + the target — the reported bug); instead it
    // falls through to the drag-OUT logic below, which pops just this member out.
    {
      const { joinId, chipGid } = pinnedJoinIntent(event.over, activeId);
      const joinTask = joinId && joinId !== activeId && pinnedCardIds.has(joinId)
        ? tasks.find((t) => t.id === joinId) : undefined;
      const activeTask = tasks.find((t) => t.id === activeId);
      const targetGid = joinTask?.group_id ?? chipGid ?? null;
      if (activeTask && !activeTask.group_id && (joinTask || chipGid) && activeTask.group_id !== targetGid) {
        if (isFromRecent) {
          const overTier: FocusTier = (joinId ? finalTierOf(joinId) : undefined)
            ?? finalTierOf(overId) ?? 'satellite';
          onPinTask?.(activeId);
          setTimeout(() => onSetTier?.(activeId, overTier), 100);
        }
        if (targetGid && onAddToGroup) {
          // The card teleports into the cluster — free any line anchored to it
          // BEFORE it goes, or the line rides into the group with it.
          reanchorSeps(snapTierOf(activeId), [activeId]);
          onAddToGroup(targetGid, [activeId]);
          return;
        }
        if (joinTask && !targetGid && onGroupTasks) {
          reanchorSeps(snapTierOf(activeId), [activeId]);
          onGroupTasks([joinTask.id, activeId]);
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
      // The target's group: a chip sentinel IS its group, so releasing a member on
      // its OWN header must not read as "left the cluster" and pop it out.
      const overGid = isGroupSentinel(overId)
        ? parseGroupSentinelGid(overId)
        : tasks.find((t) => t.id === overId)?.group_id;
      if (activeTask?.group_id && activeTask.group_id !== overGid) {
        onUngroupTask(activeId);
        // fall through — the tier-move / reorder logic below repositions it
      }
    }

    // Build global pinned order from live tier refs, optionally adjusting the
    // active item's position within a tier to match the final drop target. The tier
    // arrays carry group chip sentinels (they're real SortableContext items) — they
    // take part in the splice so a drop ONTO a chip lands above that group, then
    // taskIdsOnly strips them from what gets persisted.
    const buildOrderFromRefs = (adjustInTier?: FocusTier) => {
      const arrs = new Map<FocusTier, string[]>();
      for (const tier of snap.tiers.keys()) arrs.set(tier, [...finalArr(tier)]);
      if (adjustInTier && activeId !== overId) {
        const arr = arrs.get(adjustInTier) ?? [];
        const ai = arr.indexOf(activeId);
        const oi = arr.indexOf(overId);
        if (ai !== -1 && oi !== -1 && ai !== oi) {
          arr.splice(ai, 1);
          arr.splice(oi, 0, activeId);
        }
      }
      return taskIdsOnly([...arrs.values()].flat());
    };

    // When over === active, collision detected the dragged card itself (its center
    // follows the pointer). handlePinnedDragOver may have moved it cross-tier —
    // check live refs to persist that move.
    if (activeId === overId) {
      const currentTier = finalTierOf(activeId);
      if (isFromRecent) {
        if (currentTier) {
          const order = buildOrderFromRefs();
          onPinTask?.(activeId);
          setTimeout(() => onSetTier?.(activeId, currentTier, order), 100);
          maybeMoveProject(currentTier, finalArr(currentTier), /* allowInference */ false);
        }
      } else {
        const origTier: FocusTier = snapTierOf(activeId) ?? 'satellite';
        if (currentTier && origTier !== currentTier) {
          // Lines live in the tier arrays now — their post-move anchors are read
          // straight off the final frames (both tiers), not rule-5-walked.
          syncCustomSepAnchors([
            { tier: origTier, arr: finalArr(origTier) },
            { tier: currentTier, arr: finalArr(currentTier) },
          ]);
          onSetTier?.(activeId, currentTier, buildOrderFromRefs());
        }
        // Independent of a tier change: a self-drop inside the SAME tier still
        // reports its landing slot, which is where a cross-folder move comes from.
        if (currentTier) maybeMoveProject(currentTier, finalArr(currentTier));
      }
      return;
    }

    if (isFromRecent) {
      // Target tier: explicit drop-zone → over-card's tier → where dragOver last
      // placed the dragged card (see the pinned-to-pinned note below).
      const targetTier = DROP_ZONE_TIERS[overId] ?? snapTierOf(overId) ?? finalTierOf(activeId);
      if (!targetTier) return;
      // Pin first, then set tier. setFocusTier requires task.pinned===true in the
      // store, so we delay to let the pin write complete before changing tier.
      const order = buildOrderFromRefs();
      onPinTask?.(activeId);
      setTimeout(() => onSetTier?.(activeId, targetTier, order), 100);
      maybeMoveProject(targetTier, finalArr(targetTier), /* allowInference */ false);
      return;
    }

    // Existing pinned-to-pinned logic
    const origTier: FocusTier = snapTierOf(activeId) ?? 'satellite';
    // Over-target resolution: explicit drop-zone → the over-card's tier → where
    // dragOver last placed the dragged card. The third leg matters for small
    // targets: over an EMPTY tier's low zone, the release collision can land on
    // a non-tier element just below (e.g. a Recent card) even though the live
    // preview already moved the card into the tier — without the finalTierOf
    // fallback that move silently reverted on drop (mirrors the self-drop branch).
    const targetTier = DROP_ZONE_TIERS[overId] ?? snapTierOf(overId) ?? finalTierOf(activeId) ?? 'satellite';

    if (origTier !== targetTier) {
      onSetTier?.(activeId, targetTier, buildOrderFromRefs(targetTier));
      // Replicate the tier array buildOrderFromRefs persists (same ai/oi splice) so
      // the landing slot can be read. A tiny duplication on purpose: buildOrderFromRefs
      // flattens every tier and strips sentinels, and inference needs one tier's ids
      // WITH its sentinels.
      const arr = [...finalArr(targetTier)];
      const ai = arr.indexOf(activeId);
      const oi = arr.indexOf(overId);
      if (ai !== -1 && oi !== -1 && ai !== oi) {
        arr.splice(ai, 1);
        arr.splice(oi, 0, activeId);
      }
      // Lines in both tiers re-anchor to the final frames (the origin lost a card,
      // the target gained one at the landing slot). The origin filter covers the
      // no-hover drop where dragOver never moved the card out of its live array.
      syncCustomSepAnchors([
        { tier: origTier, arr: finalArr(origTier).filter((id) => id !== activeId) },
        { tier: targetTier, arr },
      ]);
      maybeMoveProject(targetTier, arr);
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

    const completeTier = snap.tiers.get(origTier) ?? [];
    const visibleSet = new Set(visibleIds);
    let visibleIndex = 0;
    const reorderedTier = completeTier.map((id) =>
      visibleSet.has(id) ? reorderedVisible[visibleIndex++] : id
    );
    const newOrder = [...snap.tiers.keys()].flatMap((tier) =>
      tier === origTier ? reorderedTier : (snap.tiers.get(tier) ?? [])
    );
    maybeMoveProject(origTier, reorderedTier);
    // Anchors from the final frame: a card that pushed a line aside really is on
    // the other side of it now (the strategy's preview was the truth).
    syncCustomSepAnchors([{ tier: origTier, arr: reorderedTier }]);
    onReorderPinned?.(taskIdsOnly(newOrder));
  }, [pinnedTaskIds_arr, onReorderPinned, onSetTier, onPinTask, clearDragState, onAddToGroup, onGroupTasks, onUngroupTask, onUnpinTask, overUnpinZone, pinnedJoinIntent, pinnedCardIds, tasks, DROP_ZONE_TIERS, tierViewMode, pinnedTaskMap, onOperationError, separators, persistSeparators, sepReanchor, syncCustomSepAnchors]);

  // Project chips for ViewDropdown, in the flat config order. Inbox rides along as
  // INBOX_TAB (a sentinel chip) whenever any task has no project — '' is the All chip.
  const projectTabs = useMemo(() => {
    const set = new Set<string>();
    let hasInbox = false;
    for (const t of tasks) {
      if (t.project) set.add(t.project); else hasInbox = true;
    }
    const names = orderedSort(Array.from(set), ordering?.projectOrder ?? []);
    return hasInbox ? [...names, INBOX_TAB] : names;
  }, [tasks, ordering?.projectOrder]);

  // Self-heal a stale project tab (same shape as the custom-tier heal above):
  // the persisted tab may name a project that was renamed/deleted/emptied since,
  // and ViewDropdown renders no chip for it — so the list filters to zero with no
  // visible way back. Fall back to All. This is also what retires a persisted ★
  // tab from the removed starred system: it has no chip, so it heals to All.
  // MUST wait for the task list to actually load: healing against the empty
  // pre-fetch snapshot would overwrite the user's tab on every page load.
  useEffect(() => {
    if (loading || tasks.length === 0) return;
    // '' (All) is always legal; everything else must have a chip.
    if (activeProject === '') return;
    if (projectTabs.includes(activeProject)) return;
    setActiveProject('');
    persistTab('');
    onProjectChange?.('');
  }, [loading, tasks.length, activeProject, projectTabs, onProjectChange]);

  /** Every legal `collapsedProjects` key right now: real project names + '' when Inbox exists. */
  const liveGroupKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const t of tasks) keys.add(t.project || '');
    return keys;
  }, [tasks]);

  // Prune orphaned collapse keys (same self-heal shape as the ct_* prune above).
  // Two sources of orphans: keys for projects that were renamed/deleted, and
  // pre-refactor `Category/Project` composite keys that nothing ever cleaned up.
  // They're not just dead weight — `allCollapsed` requires EVERY live group key
  // to be present, and "collapse all" writes only live keys, so a stored orphan
  // was harmless there, but a stale '' (Inbox) key kept Inbox folded even after
  // its tasks moved away and it stopped rendering a header to un-collapse.
  useEffect(() => {
    if (loading || tasks.length === 0) return;
    setCollapsedProjects((prev) => {
      const stale = [...prev].filter((k) => !liveGroupKeys.has(k));
      if (stale.length === 0) return prev;
      const next = new Set(prev);
      for (const k of stale) next.delete(k);
      persistSet(LS_COLLAPSED_PROJS_KEY, next);
      return next;
    });
  }, [loading, tasks.length, liveGroupKeys]);

  // Project counts for ViewDropdown (Inbox counted under the INBOX_TAB sentinel)
  const projectCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) {
      if (t.status !== 'done' || showCompleted) {
        const key = t.project || INBOX_TAB;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }, [tasks, showCompleted]);

  // Value lists for the query panel — derived from the loaded tasks (plus the
  // registry for projects, so a zero-task project is still selectable).
  const queryProjectOptions = useMemo(() => {
    const byLower = new Map<string, string>();
    for (const name of projectRegistry.projectNames) byLower.set(name.toLowerCase(), name);
    for (const t of tasks) {
      const project = t.project || '';
      if (project && !byLower.has(project.toLowerCase())) byLower.set(project.toLowerCase(), project);
    }
    // '' is a REAL selectable value (Inbox), and it must lead: it's where quick
    // capture lands, so it's the most-used bucket.
    return ['', ...[...byLower.values()].sort((a, b) => a.localeCompare(b))];
  }, [tasks, projectRegistry.projectNames]);

  const querySourceOptions = useMemo(() => deriveSourceOptions(tasks), [tasks]);
  const querySprintOptions = useMemo(() => deriveSprintOptions(tasks), [tasks]);

  const handleQueryChange = useCallback((next: TaskQueryFilterState) => {
    setTaskQueryState(next);
    logTaskQueryChange('todo-panel', next);
    clearFocusOverride();
  }, [clearFocusOverride]);

  // ── The ONE task-row predicate ──
  //
  // Row conditions (completion/phase/priority/project/source/sprint/tags/
  // pinned/blocked/time) go through the shared evaluator, so this
  // surface, /tasks, REST and the agent tool cannot drift. What stays local is
  // deliberately NOT expressible as a task-row query: the due-date view filter
  // (ancestor date inheritance + "now" relative to a start_date), the
  // recent-completion grace window, manual ordering, and grouping.

  // The legacy single-value selects still exist in the panel toolbar. They fold
  // into the SAME query object instead of being a second predicate layer —
  // otherwise "AND all active filters" would be two independent code paths again.
  const legacyFolds = useCallback((query: TaskQuery): TaskQuery => {
    const next: TaskQuery = { ...query };
    // Legacy 'TODO' meant "anything not COMPLETE" (matchesPhaseFilter), which is
    // completion todo+in_progress, NOT the exact TODO phase.
    if (phaseFilter === 'TODO') {
      next.completion = ['todo', 'in_progress'];
    } else if (phaseFilter) {
      next.phases = [...(next.phases ?? []), phaseFilter as TaskPhase];
    }
    return next;
  }, [phaseFilter]);

  // ONE `now` for BOTH normalizations: relative windows must not slide mid-pass,
  // and search-mode results must agree with the plain list.
  //
  // `timeTick` gates the 60s timer into this chain ONLY while a relative window
  // is actually set. `_tick` fires unconditionally (the per-row ▶ start pill
  // needs it), and having it as a raw dep re-normalized the query and re-ran the
  // whole filter/sort/tier memo chain every minute on an unfiltered panel, for a
  // guaranteed-identical result.
  //
  // Two normalized forms because they have different audiences:
  //  • queryOnly   — the canonical conditions the user set in the query panel.
  //                  Search results AND with THESE (an active filter is a real
  //                  refinement the chips advertise).
  //  • withLegacy  — plus the legacy toolbar selects. Only the plain list uses
  //                  it; search deliberately bypasses them (2026-08-09 ruling,
  //                  pinned by todo-search-ignores-filters.spec.ts — the Date
  //                  select defaults to "Now", so intersecting made deferred
  //                  tasks unfindable).
  const timeTick = taskQueryState.timePreset === null ? 0 : _tick;
  const { queryOnly, withLegacy } = useMemo<{
    queryOnly: NormalizedTaskQuery | null;
    withLegacy: NormalizedTaskQuery | null;
  }>(() => {
    const now = new Date();
    const canonical = toTaskQuery(taskQueryState);
    return {
      queryOnly: safeNormalizeTaskQuery(canonical, now),
      withLegacy: safeNormalizeTaskQuery(legacyFolds(canonical), now),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- timeTick re-arms relative time windows
  }, [taskQueryState, legacyFolds, timeTick]);

  // Context the pure evaluator can't derive from a task row on its own — shared
  // verbatim with /tasks (see task-query-state.ts).
  const queryContext = useMemo<TaskQueryContext>(
    () => buildTaskQueryContext(tasks, taskQueryState.blocked !== undefined),
    [tasks, taskQueryState.blocked],
  );

  /** Full predicate for the plain list: canonical query AND legacy selects.
   *  Legacy 'high'/'medium'/'low' priorities are folded by the shared evaluator
   *  itself (normalizeTaskPriority), so nothing is rewritten here — task object
   *  identity matters to the pinned-drag freeze memos. */
  const matchesQuery = useCallback((t: Task): boolean => (
    withLegacy === null || matchesTaskQuery(t, withLegacy, queryContext)
  ), [withLegacy, queryContext]);

  /** Canonical conditions only — what search results are intersected with. */
  const matchesCanonicalQuery = useCallback((t: Task): boolean => (
    queryOnly === null || matchesTaskQuery(t, queryOnly, queryContext)
  ), [queryOnly, queryContext]);

  /** With `pinned: true` a completed-BUT-pinned task must be reachable —
   *  otherwise the answer to "show me my pins" is silently truncated, which is
   *  the whole reason pins move into the normal stream. The bypass is scoped to
   *  the rows the condition selects, so `pinned: false` (and every other query)
   *  keeps honoring the showCompleted toggle for ordinary tasks. */
  const completedBypass = useCallback(
    (t: Task): boolean => taskQueryState.pinned === true && !!t.pinned,
    [taskQueryState.pinned],
  );

  // Publish both predicates for the focus-override effect OUTSIDE render: a
  // render can be discarded or replayed (StrictMode, Suspense), so assigning a
  // ref in the render body can leave it pointing at a predicate from a render
  // React threw away.
  //
  // useLayoutEffect, NOT useEffect: the consumer is a passive effect declared
  // EARLIER in this component, and passive effects run in declaration order, so
  // publishing from a passive effect here would hand that consumer the PREVIOUS
  // commit's predicates. Measured: a plain useEffect made
  // pinned-drag-storm.spec.ts fail every run (the one-commit-stale wouldBeHidden
  // verdict flips, the extra setOverrideTick render remounts cards mid-drag, and
  // dnd-kit's measureRect loops into React #185). Layout effects all run before
  // any passive effect, so the consumer still sees this commit's predicates.
  useLayoutEffect(() => {
    matchesQueryRef.current = matchesQuery;
    completedBypassRef.current = completedBypass;
  }, [matchesQuery, completedBypass]);

  const filterResult = useMemo(() => {
    // matchedIds: the REAL hits. Everything the user is told (result count,
    // chips) counts only these.
    // SYNC: keep in sync with wouldBeHidden in focus effect
    const matchedList = tasks.filter((t) => {
      // Focus override: always include the focused/fading task regardless of filters
      if (focusOverrideRef.current === t.id || fadingOverrideRef.current === t.id) return true;

      if (!completedBypass(t) && !showCompleted && t.status === 'done' && phaseFilter !== 'COMPLETE') {
        // Keep recently-completed tasks visible for the grace period (visual feedback
        // + exit animation) before hiding them.
        if (!keepWhileCompleting(t)) return false;
      }

      // Every task-row condition, shared with REST / the agent tool / /tasks.
      if (!matchesQuery(t)) return false;

      // `pinned: true` inherits the tier area's cross-project contract: pinning
      // means "keep this in front of me no matter which project tab I'm on". The
      // tab NAVIGATES and the Date select is a VIEW; neither may silently
      // subtract from the answer to "show me my pins" — Date defaults to "Now",
      // which would otherwise eat the pin list (a pinned task with a deferred
      // due date used to disappear entirely).
      // Checked BEFORE the date filter for exactly that reason.
      if (taskQueryState.pinned === true && t.pinned) return true;

      // Date filter (skip for completed tasks — they don't need date filtering)
      // Child tasks inherit parent's due_date if they have none.
      if (dateFilter && t.status !== 'done' && !matchesDateFilter(t, dateFilter, tasks)) return false;

      // Tab ids: '' = All (no scoping), INBOX_TAB = the no-project bucket.
      if (activeProject && (t.project || INBOX_TAB) !== activeProject) return false;
      return true;
    });
    const matchedIds = new Set<string>(matchedList.map((t) => t.id));

    // contextIds: descendants pulled in for HIERARCHY CONTEXT only, at any
    // depth. They are RENDERED but are not filter hits: a parent matching must
    // never make its whole subtree count as matches, or the result count and the
    // chips would over-report. Only the completed-hiding rule applies to them.
    const result = [...matchedList];
    const included = new Set<string>(matchedIds);
    let added = true;
    while (added) {
      added = false;
      for (const t of tasks) {
        if (included.has(t.id)) continue; // already included
        if (!t.parent_task_id) continue; // not a child task
        // Respect completed filter even for children (but keep recently-completed visible)
        if (!completedBypass(t) && !showCompleted && t.status === 'done' && phaseFilter !== 'COMPLETE' && !keepWhileCompleting(t)) continue;
        // parent_task_id uses a prefix convention: check if any visible task's id
        // starts with this task's parent_task_id (handles composite/prefixed IDs)
        const parentVisible = result.some(p => p.id.startsWith(t.parent_task_id!));
        if (parentVisible) {
          result.push(t);
          included.add(t.id);
          added = true;
        }
      }
    }
    return { list: result, matchedIds };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusOverrideRef/fadingOverrideRef read via _overrideTick
  }, [tasks, showCompleted, phaseFilter, matchesQuery, completedBypass, taskQueryState.pinned, dateFilter, _tick, _overrideTick, recentTick, activeProject]);

  /** Rows to RENDER = real hits + their descendant context. */
  const filtered = filterResult.list;
  /** Real hits only — what counts and chips report. */
  const matchedIds = filterResult.matchedIds;

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
    if (isDone && !completedBypass(task) && !showCompleted && phaseFilter !== 'COMPLETE') reasons.push('hidden by completed filter');
    if (phaseFilter && !matchesPhaseFilter(phaseFilter, task.phase)) reasons.push(`phase ≠ ${phaseFilter}`);
    if (dateFilter && !isDone && !matchesDateFilter(task, dateFilter, tasks)) reasons.push(`outside "${DATE_LABELS[dateFilter] || dateFilter}" date filter`);
    // Canonical query conditions get ONE combined reason: they're composable, so
    // enumerating each mismatch would be a paragraph. The chips above the list
    // already name every active condition.
    if (!matchesCanonicalQuery(task) && hasActiveTaskQuery(taskQueryState)) {
      const window = timeWindowLabel(taskQueryState);
      reasons.push(window ? `outside the active filters (${window})` : 'outside the active filters');
    }
    return reasons.length > 0 ? reasons.join(' · ') : undefined;
  }, [overrideReasonTaskId, tasks, showCompleted, phaseFilter, dateFilter, completedBypass, matchesCanonicalQuery, taskQueryState]);

  // Every REFINEMENT the user set, and nothing that is mere navigation:
  //   • the full canonical query (including its own `projects` condition, which
  //     IS a refinement — the user picked those project chips in the View panel);
  //   • the legacy toolbar selects, folded into that same query (phase, priority,
  //     tag), plus the due-date view filter.
  // What it deliberately does NOT apply is the legacy nav PROJECT TAB: it
  // navigates rather than refines. Used by the Pinned/Recent visibility
  // set below, so a pin/recent card never disappears merely because the user
  // switched project tabs — pins are a cross-project focus view by design. NOT
  // used by search, which ignores all view controls (see `searchMatches`).
  const passesExplicitFilters = useCallback((t: Task): boolean => {
    if (!matchesQuery(t)) return false;
    if (dateFilter && t.status !== 'done' && !matchesDateFilter(t, dateFilter, tasks)) return false;
    return true;
  }, [matchesQuery, dateFilter, tasks]);

  // --- Search filtering: search spans the WHOLE task set ---
  // Search's job is CANDIDATES + RANKING, not view state. It ignores the legacy
  // view controls — the project tab, the completed toggle, and the legacy
  // selects (priority, phase, source, tag, date). Typing a title you know
  // exists must find it, or the feature is untrustworthy: the Date select
  // DEFAULTS to "Now" (which hides any task whose start_date is still in the
  // future), so the old intersect made a deferred task silently unfindable. A
  // row carries its own explanation of why it isn't in the plain list (project
  // context pill + the "▶ <date>" deferred-start pill).
  //
  // The CANONICAL query conditions DO still AND on top, and that asymmetry is
  // the rule: a condition the user just set in the View panel is explicit and
  // chip-advertised, whereas the legacy selects carry shipped defaults nobody
  // chose. Nothing in the canonical query is active by default, so this can't
  // resurrect the unfindable-task bug.
  const searchMatches = useMemo(() => {
    if (!isSearchMode) return filtered;

    const eligibleTasks = hasActiveTaskQuery(taskQueryState)
      ? tasks.filter(matchesCanonicalQuery)
      : tasks;
    const lowerQuery = searchQuery.trim().toLowerCase();
    // Keep the urgent pass on small metadata fields; descriptions and summaries can
    // contain enough text to block an input frame across a large task collection.
    const metadataMatches = eligibleTasks.filter((t) =>
      t.title.toLowerCase().includes(lowerQuery) ||
      (t.project ?? '').toLowerCase().includes(lowerQuery) ||
      (t.tags && t.tags.some(tag => tag.toLowerCase().includes(lowerQuery)))
    );

    if (!searchResults) {
      const metadataTaskIds = new Set(metadataMatches.map((task) => task.id));
      return rankOpenTasksFirst([
        ...metadataMatches,
        ...eligibleTasks.filter((task) =>
          !metadataTaskIds.has(task.id)
          && taskReferenceMatchField(task, searchQuery) !== null
        ),
      ]);
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
    return rankOpenTasksFirst([
      ...metadataMatches,
      ...serverMatches.filter((task) => !metadataTaskIds.has(task.id)),
    ]);
  }, [tasks, filtered, isSearchMode, searchQuery, searchResults, taskQueryState, matchesCanonicalQuery]);

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
  // (passesExplicitFilters) and NOT the project tab — Pinned/Recent are a
  // cross-project focus view: pinning a task means "keep this in front of me no
  // matter which project tab I'm on". Reusing `filtered` (which scopes to
  // activeProject) would make pins/recent vanish whenever the user navigated off
  // the "All" tab, then reappear on search (which already bypasses the tab). The
  // main task list below still uses `filtered`/`searchFiltered` and stays tab-scoped.
  // FROZEN during a pinned drag: this membership set derives from the live
  // `tasks` array, so external churn (WS echoes / refetches) would otherwise
  // change the SortableContext items / remount cards mid-drag (→ React #185 via
  // dnd-kit useRect). Tier ORDER is separately frozen by the drag ref
  // (dragTierIdsRef) — freezing membership here completes the invariant.
  const visibleTaskIdsLive = useMemo(
    () => new Set(
      (isSearchMode ? searchMatches : tasks.filter(passesExplicitFilters)).map((task) => task.id),
    ),
    [tasks, isSearchMode, searchMatches, passesExplicitFilters],
  );
  const visibleTaskIds = useFrozenWhile(visibleTaskIdsLive, isPinnedDragActive);
  // PINNED DEDUP — ONE source for every tier consumer below (tier id lists, the
  // display arrays, the tab badges, the section mount conditions). With an
  // explicit pinned condition the pins already flow through the normal filtered
  // list, so the separate Focus/Pinned area empties out; otherwise every pinned
  // hit would render twice (once per surface) and be double-counted. Recent is
  // untouched: it's an activity feed, not a second copy of the pinned tiers.
  const tierVisibleTaskIds = pinnedQueryActive ? EMPTY_ID_SET : visibleTaskIds;
  const visiblePinnedTasks = useMemo(
    () => pinnedTasks.filter((task) => tierVisibleTaskIds.has(task.id)),
    [pinnedTasks, tierVisibleTaskIds],
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
    () => pruneOrphanSentinels(focusIds_arr.filter((id) => isGroupSentinel(id) || isSeparatorId(id) || tierVisibleTaskIds.has(id)), pinnedTaskMap, activeDragPinnedId),
    [focusIds_arr, tierVisibleTaskIds, pinnedTaskMap, activeDragPinnedId],
  );
  const visibleSatelliteIds = useMemo(
    () => pruneOrphanSentinels(satelliteIds_arr.filter((id) => isGroupSentinel(id) || isSeparatorId(id) || tierVisibleTaskIds.has(id)), pinnedTaskMap, activeDragPinnedId),
    [satelliteIds_arr, tierVisibleTaskIds, pinnedTaskMap, activeDragPinnedId],
  );
  const visibleBacklogIds = useMemo(
    () => pruneOrphanSentinels(backlogIds_arr.filter((id) => isGroupSentinel(id) || isSeparatorId(id) || tierVisibleTaskIds.has(id)), pinnedTaskMap, activeDragPinnedId),
    [backlogIds_arr, tierVisibleTaskIds, pinnedTaskMap, activeDragPinnedId],
  );
  const visibleWaitIds = useMemo(
    () => pruneOrphanSentinels(waitIds_arr.filter((id) => isGroupSentinel(id) || isSeparatorId(id) || tierVisibleTaskIds.has(id)), pinnedTaskMap, activeDragPinnedId),
    [waitIds_arr, tierVisibleTaskIds, pinnedTaskMap, activeDragPinnedId],
  );
  // Per-custom-tier render model: visible ids + display tasks + group meta in one
  // memo (the built-ins keep their three separate memos; a custom tier bundles them
  // because the set of tiers itself is dynamic).
  const customTierRender = useMemo(() => {
    const map: Record<string, { visibleIds: string[]; display: Task[]; groupMeta: Map<string, GroupRenderInfo> }> = {};
    for (const def of customTiers ?? []) {
      const visibleIds = pruneOrphanSentinels(
        (customIds_arr[def.id] ?? []).filter((id) => isGroupSentinel(id) || isSeparatorId(id) || tierVisibleTaskIds.has(id)),
        pinnedTaskMap, activeDragPinnedId,
      );
      const display = visibleIds.map((id) => pinnedTaskMap.get(id)).filter((task): task is Task => !!task);
      map[def.id] = { visibleIds, display, groupMeta: buildTierGroupMeta(display, taskGroups) };
    }
    return map;
  }, [customTiers, customIds_arr, tierVisibleTaskIds, pinnedTaskMap, taskGroups, activeDragPinnedId]);
  // tier id → its visible render ids, for logic that must work for ANY tier
  // (separator placement) instead of naming the four built-ins.
  const tierIdsByTier = useMemo(() => {
    const map = new Map<string, string[]>();
    map.set('focus', visibleFocusIds);
    map.set('satellite', visibleSatelliteIds);
    map.set('backlog', visibleBacklogIds);
    map.set('wait', visibleWaitIds);
    for (const def of customTiers ?? []) map.set(def.id, customTierRender[def.id]?.visibleIds ?? []);
    return map;
  }, [visibleFocusIds, visibleSatelliteIds, visibleBacklogIds, visibleWaitIds, customTiers, customTierRender]);
  const focusTasksDisplay = useMemo(
    () => visibleFocusIds.map((id) => pinnedTaskMap.get(id)).filter((task): task is Task => !!task),
    [pinnedTaskMap, visibleFocusIds],
  );
  const satelliteTasksDisplay = useMemo(
    () => visibleSatelliteIds.map((id) => pinnedTaskMap.get(id)).filter((task): task is Task => !!task),
    [pinnedTaskMap, visibleSatelliteIds],
  );
  const backlogTasksDisplay = useMemo(
    () => visibleBacklogIds.map((id) => pinnedTaskMap.get(id)).filter((task): task is Task => !!task),
    [pinnedTaskMap, visibleBacklogIds],
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
  const backlogGroupMeta = useMemo(
    () => buildTierGroupMeta(backlogTasksDisplay, taskGroups),
    [backlogTasksDisplay, taskGroups],
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

  // Projects created THIS session via the bottom "New Project" row. They have
  // zero tasks so the task-derived grouping below wouldn't show them — surface
  // them as empty groups (with their ghost add row ready) so creation lands
  // exactly where the user is looking. Deliberately session-local: OLD empty
  // registry projects stay hidden (the panel is a work list, not a registry
  // browser — the /tasks rail shows the full registry).
  const [freshProjects, setFreshProjects] = useState<string[]>([]);
  // Prune against the registry: a fresh project later renamed/deleted (kebab)
  // must not resurrect as a phantom empty group. Only after the first fetch
  // resolves — pruning against a still-empty registry would wipe a name the
  // very refresh() that follows createProject is about to confirm.
  const registryLoaded = projectRegistry.loaded;
  const isKnownProject = projectRegistry.isKnownProject;
  useEffect(() => {
    if (!registryLoaded) return;
    setFreshProjects((prev) => {
      const kept = prev.filter((p) => isKnownProject(p));
      return kept.length === prev.length ? prev : kept;
    });
  }, [registryLoaded, isKnownProject]);

  // Flat project groups (skipped in flat mode). '' = Inbox, rendered last so the
  // named projects (the meaningful grouping) lead the list.
  const grouped = useMemo(() => {
    if (groupBy === 'none') return [];
    const map = new Map<string, Task[]>();
    for (const task of sorted) {
      const proj = task.project || '';
      if (!map.has(proj)) map.set(proj, []);
      map.get(proj)!.push(task);
    }
    // Freshly created empty projects (case-insensitive match against real groups).
    const lower = new Set(Array.from(map.keys(), (k) => k.toLowerCase()));
    const freshEmpty: string[] = [];
    for (const fp of freshProjects) {
      if (!lower.has(fp.toLowerCase())) { map.set(fp, []); lower.add(fp.toLowerCase()); freshEmpty.push(fp); }
    }
    const freshSet = new Set(freshEmpty);
    const named = orderedSort(
      Array.from(map.keys()).filter((p) => p !== '' && !freshSet.has(p)),
      ordering?.projectOrder ?? [],
    );
    // Fresh empty groups pin to the END (just above Inbox / the New Project row):
    // the group must appear where the user just typed the name, not jump away to
    // its alphabetical slot. Once it has tasks it leaves freshEmpty and sorts
    // normally on the next mount.
    const order = map.has('') ? [...named, ...freshEmpty, ''] : [...named, ...freshEmpty];
    return order.map((project) => ({ project, tasks: map.get(project)! }));
  }, [sorted, groupBy, ordering?.projectOrder, freshProjects]);

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

  // Full (unfiltered) per-project task lists — so a task reorder sends ALL ids to
  // the backend, not just the ones currently passing the filters. '' = Inbox.
  const fullGrouped = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      const proj = task.project || '';
      if (!map.has(proj)) map.set(proj, []);
      map.get(proj)!.push(task);
    }
    return map;
  }, [tasks]);

  // taskId → its project ('' = Inbox) for drag end.
  const taskGroupMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of grouped) for (const t of g.tasks) m.set(t.id, g.project);
    return m;
  }, [grouped]);

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

  // Collapse all / expand all — collapse keys are plain project names ('' = Inbox)
  const allGroupKeys = useMemo(() => grouped.map((g) => g.project), [grouped]);

  const allCollapsed = allGroupKeys.length > 0 &&
    allGroupKeys.every((p) => collapsedProjects.has(p));

  const handleCollapseExpandAll = useCallback(() => {
    if (allCollapsed) {
      setCollapsedProjects(new Set());
      persistSet(LS_COLLAPSED_PROJS_KEY, new Set());
    } else {
      // Collapse all — also collapse child tasks
      const nextProjs = new Set(allGroupKeys);
      setCollapsedProjects(nextProjs);
      setExpandedParents(new Set());
      persistSet(LS_COLLAPSED_PROJS_KEY, nextProjs);
      persistSet(LS_EXPANDED_PARENTS_KEY, new Set());
    }
  }, [allCollapsed, allGroupKeys]);

  // ── Mini-bar "Running (n)" — tasks whose linked session is actively running.
  // Cycles through them on repeated clicks (focus-scroll each in turn).
  const runningTaskIds = useMemo(() => {
    const ids: string[] = [];
    for (const t of rawTasks) {
      if (t.status === 'done') continue;
      const status = t.session_status?.process_status
        ?? t.exec_session_status?.process_status
        ?? t.plan_session_status?.process_status;
      if (status === 'running') ids.push(t.id);
    }
    return ids;
  }, [rawTasks]);

  const runningJumpCursor = useRef(0);
  const jumpToNextRunning = useCallback(() => {
    if (runningTaskIds.length === 0) return;
    const idx = runningJumpCursor.current % runningTaskIds.length;
    runningJumpCursor.current = idx + 1;
    const id = runningTaskIds[idx];
    // Same entry point a task-ref click uses (expands groups, switches tab,
    // scrolls + flashes); plain scroll as fallback.
    const task = rawTasks.find((t) => t.id === id);
    if (task && onFocusTask) onFocusTask(task, { openDetail: false });
    else scrollToTask(id);
  }, [runningTaskIds, rawTasks, onFocusTask, scrollToTask]);

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
    // Cross-panel drag: single task cards ride the bus (calendar side panel
    // accepts them); project-group headers stay in-panel.
    if (type === 'task') {
      const busTask = tasksRef.current.find((t) => t.id === id);
      if (busTask) {
        const pe = event.activatorEvent as PointerEvent | undefined;
        dragBus.begin({ kind: 'task', task: busTask }, pe?.clientX !== undefined ? { x: pe.clientX, y: pe.clientY } : undefined);
      }
    }
  }, []);

  /** Clear all drop-intent highlights + stop pointer tracking — on drag end/cancel. */
  const clearDropIntent = useCallback(() => {
    window.removeEventListener('pointermove', trackPointer);
    dropIntentRef.current = null;
    setNestTargetId((prev) => (prev === null ? prev : null));
    setGroupTargetId((prev) => (prev === null ? prev : null));
  }, []);

  /** Main-list drag cancel: also retract the cross-panel bus announcement. */
  const handleMainDragCancel = useCallback(() => {
    dragBus.cancel();
    clearDropIntent();
  }, [clearDropIntent]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const activeType = (event.active.data?.current as { type?: string })?.type ?? 'task';
    // Drop-intent highlighting only applies to task drags (not project group drags).
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

  // Cross-project move with a cross-provider gate: when the destination project is
  // claimed by a DIFFERENT provider, the backend migrates the task (old remote twin
  // archived as "[Moved]" + completed) — that is destructive enough to confirm first.
  // Same-provider (and local→provider folder-only) moves go straight through.
  const requestMoveTask = useCallback(async (
    taskId: string,
    project: string,
    opts?: { insertNearTaskId?: string; ensureSort?: boolean },
  ): Promise<boolean> => {
    if (!onMoveTask) return false;
    const task = tasks.find((t) => t.id === taskId);
    const mig = resolveMoveMigration(task?.source, project, projectRegistry.sourceByName);
    // Fail CLOSED while the registry hasn't loaded: with an empty sourceByName
    // every target reads "unknown → no migration", which would silently skip the
    // destructive confirm for provider tasks. Local tasks never migrate, so only
    // provider-sourced ones need the conservative ask.
    const claimUnknown = !projectRegistry.loaded && mig.from !== 'local';
    if (mig.migrates || claimUnknown) {
      const fromName = sourceDisplayName(mig.from);
      const ok = await confirm({
        title: 'Move across providers?',
        message: mig.migrates
          ? `“${task?.title ?? taskId}” moves from ${fromName} to ${sourceDisplayName(mig.to)}. The original ${fromName} task will be archived (renamed “[Moved]” and marked complete). Same-provider subtasks move along with it.`
          : `“${task?.title ?? taskId}” is a ${fromName} task and “${project || 'Inbox'}” may belong to a different provider (the project list hasn't loaded). If it does, the original ${fromName} task will be archived (renamed “[Moved]” and marked complete).`,
        confirmLabel: 'Move',
      });
      if (!ok) return false;
    }
    // Only a CONFIRMED move switches the list to manual sort — a cancelled one must
    // leave the user's sort mode alone.
    if (opts?.ensureSort) ensureManualSort();
    onMoveTask(taskId, project, opts?.insertNearTaskId);
    // A migration rewrites the destination project's claim server-side without a
    // project:created event, so the registry snapshot goes stale — refresh it or
    // the NEXT move's confirm decision can be wrong in either direction.
    if (mig.migrates) projectRegistry.refresh();
    return true;
  }, [onMoveTask, tasks, projectRegistry.sourceByName, projectRegistry.loaded, projectRegistry.refresh, confirm, ensureManualSort]);
  // Published for handlePinnedDragEnd, which is declared above this point. Layout
  // effect, not a render-phase write: this component uses startTransition, and a
  // discarded concurrent render must not leave its abandoned closure in the ref.
  useLayoutEffect(() => { requestMoveTaskRef.current = requestMoveTask; }, [requestMoveTask]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    // Cross-panel drop first (calendar side panel via the drag bus). When a bus
    // target consumed the drop, every in-panel semantic (group/nest/reorder)
    // must be skipped — dnd-kit's collision detection still reports an
    // in-panel `over` while the pointer is physically over another panel.
    const busHandled = dragBus.end();
    // Capture the drop intent BEFORE clearing. Position-based (set in handleDragOver
    // from the cursor's horizontal position over the target card):
    //   • nestTarget  → dropped in the right indent zone → nest as subtask
    //   • groupTarget → dropped in the left zone of a card → join/create a group
    const dwellNest = nestTargetId;
    const groupDrop = groupTargetId;
    setActiveDragId(null);
    setActiveDragType(null);
    clearDropIntent();
    if (busHandled) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // ── Drag-into-group (Main list) ── A left-zone drop on a task card means
    // "group these together". If the target is already in a group, join it; else
    // create a new group from the two. This takes precedence over reparent/reorder
    // (which only run for gap drops or right-zone subtask drops). Grouping has no
    // scope rule, so cross-project drops are fine.
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

    // Project group reorder (collision is type-aware, so over.id is always proj:*).
    // Project groups are globally sortable — one flat `ordering.projects` list.
    // Inbox ('') is pinned last by the grouped memo and never enters the order.
    if (activeType === 'project-group' && ordering) {
      const overId = String(over.id);
      if (!overId.startsWith('proj:')) return;
      const activeProj = String(active.id).slice(5); // strip 'proj:'
      const targetProj = overId.slice(5);
      if (targetProj === activeProj) return;
      // '' = Inbox. It is pinned last by the `grouped` memo and never enters
      // `ordering.projects`, so it is neither draggable nor a drop target —
      // dropping onto its header is an explicit no-op, not a missed case.
      if (activeProj === '' || targetProj === '') return;
      const projNames = grouped.map((g) => g.project).filter((p) => p !== '');
      const oldIndex = projNames.indexOf(activeProj);
      const newIndex = projNames.indexOf(targetProj);
      if (oldIndex === -1 || newIndex === -1) return;
      const newOrder = [...projNames];
      newOrder.splice(oldIndex, 1);
      newOrder.splice(newIndex, 0, activeProj);
      ordering.reorderProjects(newOrder);
      return;
    }

    // Task reorder or cross-group move
    const activeId = String(active.id);
    const overId = String(over.id);
    const activeTaskProject = taskGroupMap.get(activeId);
    if (activeTaskProject === undefined) return;

    // Determine the target project: from a task card or from a header drop zone
    let targetProject: string;
    let insertNearTaskId: string | undefined;

    if (taskGroupMap.has(overId)) {
      // Dropped on a task
      targetProject = taskGroupMap.get(overId)!;
      insertNearTaskId = overId;
    } else if (overId.startsWith('hdr-proj:')) {
      // Dropped on a header. `project` is '' for Inbox, so check presence, not truthiness.
      const overData = over.data?.current as { project?: string } | undefined;
      if (overData?.project === undefined) return;
      targetProject = overData.project;
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

    if (activeTaskProject === targetProject) {
      // Same project: existing reorder logic
      if (!onReorder) return;
      if (!insertNearTaskId) return; // dropped on own header, nothing to do
      ensureManualSort();

      const project = activeTaskProject;
      const visibleTasks = grouped.find((g) => g.project === project)?.tasks;
      if (!visibleTasks) return;

      const visibleIds = visibleTasks.map((t) => t.id);
      const oldIndex = visibleIds.indexOf(activeId);
      const newIndex = visibleIds.indexOf(insertNearTaskId);
      if (oldIndex === -1 || newIndex === -1) return;

      const newVisibleIds = [...visibleIds];
      newVisibleIds.splice(oldIndex, 1);
      newVisibleIds.splice(newIndex, 0, activeId);

      // Get the FULL (unfiltered) task list so the backend gets all IDs
      const fullTasks = fullGrouped.get(project);
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

      onReorder(project, result);
    } else {
      // Cross-project move (may pop a cross-provider confirm before it lands).
      requestMoveTask(activeId, targetProject, { insertNearTaskId, ensureSort: true }).catch((err) => {
        onOperationError?.(err instanceof Error ? err.message : 'Move failed');
      });
    }
  }, [onReorder, onReparentTask, ordering, taskGroupMap, grouped, fullGrouped, sorted, childParentMap, trueChildCountMap, ensureManualSort, requestMoveTask, nestTargetId, groupTargetId, clearDropIntent, tasks, onAddToGroup, onGroupTasks, onOperationError]);

  // Kebab "Move left" — promote subtask to top-level via onReparentTask(id, null).
  // Also primes scroll restoration so the task stays visible after refetch.
  const handleUnparent = useCallback((taskId: string) => {
    if (!onReparentTask) return;
    ensureManualSort();
    scrollAfterReparentRef.current = taskId;
    onReparentTask(taskId, null);
  }, [onReparentTask, ensureManualSort]);

  // Kebab "Project" select — same mutation as dragging the task onto another
  // project group, minus the drag (no insertNearTaskId: append to the target).
  const handleMoveToProject = useCallback((taskId: string, project: string) => {
    requestMoveTask(taskId, project).catch((err) => {
      onOperationError?.(err instanceof Error ? err.message : 'Move failed');
    });
  }, [requestMoveTask, onOperationError]);

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

    const processGroup = (groupTasks: Task[], fullGroupTasks: Task[], project: string) => {
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
            onReorder(project, newOrder);
          });
        }
      }
    };

    for (const { project, tasks: projTasks } of grouped) {
      const fullTasks = fullGrouped.get(project);
      if (fullTasks) processGroup(projTasks, fullTasks, project);
    }
    return map;
  }, [grouped, fullGrouped, onReorder, ensureManualSort]);

  const draggedTask = activeDragId ? sorted.find((t) => t.id === activeDragId) : null;

  // User-controlled collapse only — no auto-collapse during drag.
  // Key = the plain project name ('' = Inbox).
  const isProjectCollapsed = useCallback((project: string) => {
    return collapsedProjects.has(project);
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

  // AI search rows carry only a taskId — resolve to the live Task and route
  // through handleTaskClick so a click behaves exactly like a normal result row.
  const tasksForAgentClickRef = useRef(tasks);
  tasksForAgentClickRef.current = tasks;
  const handleAgentResultClick = useCallback((taskId: string) => {
    const task = tasksForAgentClickRef.current.find((t) => t.id === taskId);
    if (task) handleTaskClick(task);
  }, [handleTaskClick]);

  // Resolve the current selection to actual tasks. Grouping has NO scope rule
  // anymore — any ≥2 tasks can be grouped regardless of project (a group
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

  const batchMoveToProject = useCallback(async (project: string) => {
    if (!onMoveTask) return; // never confirm a destructive move we then can't perform
    const moving = selectionInfo.tasks.filter((t) => (t.project || '') !== project);
    // ONE confirm for the whole batch when any member crosses a provider boundary —
    // per-task requestMoveTask would stack a dialog per task. Same fail-closed rule
    // as requestMoveTask: an unloaded registry must not read as "nothing migrates".
    const migrating = moving.filter(
      (t) => resolveMoveMigration(t.source, project, projectRegistry.sourceByName).migrates
        || (!projectRegistry.loaded && (t.source ?? 'local') !== 'local'),
    ).length;
    if (migrating > 0) {
      const ok = await confirm({
        title: 'Move across providers?',
        message: `${migrating} of the ${moving.length} tasks being moved cross a provider boundary. Their original tasks will be archived (renamed “[Moved]” and marked complete).`,
        confirmLabel: 'Move',
      });
      if (!ok) return; // keep the selection so the user can adjust it
    }
    moving.forEach((t) => onMoveTask(t.id, project));
    exitSelectMode();
  }, [selectionInfo, projectRegistry.sourceByName, projectRegistry.loaded, confirm, onMoveTask, exitSelectMode]);

  const handlePinnedCardClick = handleTaskClick;

  const handleExpandDetail = useCallback((task: Task) => {
    setDetailTarget(null);
    onFocusTask ? onFocusTask(task) : navigate(`/tasks/${task.id}`);
  }, [onFocusTask, navigate]);

  const showProjectDetail = useCallback((project: string) => {
    // Inbox has no registry row, so there is nothing to show for it.
    if (!project) return;
    setDetailTarget({ type: 'project', project });
    onClearFocus?.();
  }, [onClearFocus]);

  const handleUpdateTitle = useCallback((id: string, title: string) => {
    if (onUpdate) onUpdate(id, { title });
  }, [onUpdate]);

  // ── Project label drag-reorder (Pinned tiers) ── Native HTML5 DnD on the
  // folder labels, deliberately OUTSIDE dnd-kit: labels never enter a
  // SortableContext (React #185 history), and drag events don't collide with
  // dnd-kit's PointerSensor. Dropping label A onto label B moves A's project
  // before B in the global `ordering.projects` list — the same list the Tasks
  // tab groups and the /tasks rail use, so all surfaces re-order together.
  const [labelDragProj, setLabelDragProj] = useState<string | null>(null);
  const [labelDropProj, setLabelDropProj] = useState<string | null>(null);
  const handleLabelDrop = useCallback((active: string, target: string) => {
    setLabelDragProj(null);
    setLabelDropProj(null);
    // '' (Inbox) is a legal drag participant: it has no registry row, but its
    // POSITION among the tier's project runs is still user-arrangeable, so it
    // rides ordering.projects as the empty string (user ask 2026-08-13).
    if (!ordering || active === target) return;
    const current = ordering.projectOrder ?? [];
    // Visible projects (this panel's grouped view order) supply names missing
    // from the explicit order — including '' when Inbox tasks exist.
    const visible: string[] = [];
    const seen = new Set<string>();
    for (const t of tasks) {
      const p = t.project || '';
      if (!seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); visible.push(p); }
    }
    const lower = new Set(current.map((n) => n.toLowerCase()));
    const merged = [...current];
    for (const p of visible) {
      if (!lower.has(p.toLowerCase())) { merged.push(p); lower.add(p.toLowerCase()); }
    }
    const from = merged.findIndex((n) => n.toLowerCase() === active.toLowerCase());
    const to = merged.findIndex((n) => n.toLowerCase() === target.toLowerCase());
    if (from === -1 || to === -1 || from === to) return;
    const next = [...merged];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    void ordering.reorderProjects(next);
  }, [ordering, tasks]);

  // ── Separators (divider lines / headings inside a tier) ── Two lives:
  //
  //  • CUSTOM mode: the line is a REAL dnd-kit sortable unit — its id rides the
  //    tier's items (withSeparatorSentinels in clusterForTier), so cards yield
  //    around it during drags and it can be dragged itself. The persist logic
  //    lives with the drag handlers far above (syncCustomSepAnchors).
  //
  //  • PROJECT mode: PLAIN DOM + native HTML5 drag (same call the folder labels
  //    make): folders aren't sortable units, so the line between them can't be
  //    one either. sepDrag/sepPreview/sepDropAt below serve ONLY this mode.
  //
  // Position is stored as the ids of the rows ABOVE and BELOW the line, so a
  // reorder or a completed neighbour moves the line with its band instead of
  // stranding it at a dead index (see tier-separators.ts). `separators` and
  // persistSeparators are declared up next to clusterForTier.
  const [sepDrag, setSepDrag] = useState<string | null>(null);
  // Live drop target while dragging — rendered as the line's real position, so
  // the preview IS the frame that gets committed on drop.
  const [sepPreview, setSepPreview] = useState<TierSeparator | null>(null);
  const clearSepDrag = useCallback(() => { setSepDrag(null); setSepPreview(null); }, []);

  const sepModeFor = useCallback((tier: string): SeparatorMode =>
    (tierViewMode(tier) === 'custom' ? 'custom' : 'project'), [tierViewMode]);

  /** Resolve a pointer position inside a tier list into a separator placement.
   *  Rows are read from the DOM: what the user SEES is the only honest source for
   *  "which two rows did I drop between". */
  const sepDropAt = useCallback((container: HTMLElement, tier: string, clientY: number): Omit<TierSeparator, 'id'> | null => {
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-task-id]'))
      .map((el) => ({ el, id: el.dataset.taskId ?? '' }))
      .filter((r) => r.id);
    if (rows.length === 0) return null;
    const mode = sepModeFor(tier);

    if (mode === 'project') {
      // A folder is ONE unit here, so the only legal spots are the boundaries
      // BETWEEN folders — never between a folder's label and its own cards. Each
      // run's vertical middle picks the side: drop in a folder's top half and the
      // line lands above it, bottom half and it lands below (= above the next).
      const runs: string[] = [];
      const span = new Map<string, { top: number; bottom: number }>();
      for (const r of rows) {
        const proj = pinnedTaskMap.get(r.id)?.project ?? '';
        const rect = r.el.getBoundingClientRect();
        const seen = span.get(proj);
        if (seen) {
          seen.top = Math.min(seen.top, rect.top);
          seen.bottom = Math.max(seen.bottom, rect.bottom);
        } else {
          span.set(proj, { top: rect.top, bottom: rect.bottom });
          runs.push(proj);
        }
      }
      if (runs.length < 2) return null; // one folder = no boundary to sit on
      let slot = runs.length;
      for (let i = 0; i < runs.length; i++) {
        const s = span.get(runs[i])!;
        if (clientY < s.top + (s.bottom - s.top) / 2) { slot = i; break; }
      }
      // Clamped inside the list: a line above the first folder or below the last
      // divides nothing, so a drag to either extreme snaps to the nearest real
      // boundary instead of parking somewhere with no meaning.
      slot = Math.min(Math.max(slot, 1), runs.length - 1);
      return { tier, mode, ...projectAnchorsForSlot(runs, slot) };
    }

    // Custom order: cards are the unit. First row whose vertical middle is below
    // the pointer; past the last row the slot is the end of the list.
    const ids = rows.map((r) => r.id);
    let idx = ids.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { idx = i; break; }
    }
    // A group is one unit here too, so a drop inside a cluster snaps below it. Done
    // on the SLOT (not just at render time) so the stored anchors are already
    // outside the group — otherwise the line's position would depend on the snap
    // forever and would jump the day that group dissolves.
    idx = snapSlotOutOfGroup(ids, idx, (id) => pinnedTaskMap.get(id)?.group_id ?? null);
    return { tier, mode, ...anchorsForSlot(ids, idx) };
  }, [sepModeFor, pinnedTaskMap]);

  /** DnD props for a tier's list container — accepts a dragged separator line. */
  const sepDropProps = useCallback((tier: string) => ({
    onDragOver: (e: ReactDragEvent<HTMLDivElement>) => {
      if (!sepDrag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const spot = sepDropAt(e.currentTarget, tier, e.clientY);
      if (spot) setSepPreview({ id: sepDrag, ...spot });
    },
    onDrop: (e: ReactDragEvent<HTMLDivElement>) => {
      const id = e.dataTransfer.getData('text/walnut-separator') || sepDrag;
      if (!id) return;
      e.preventDefault();
      const spot = sepDropAt(e.currentTarget, tier, e.clientY);
      clearSepDrag();
      if (!spot) return;
      persistSeparators(upsertSeparator(separators, { id, ...spot }));
    },
  }), [sepDrag, sepDropAt, clearSepDrag, persistSeparators, separators]);

  /** "Add separator" from a header "+". An empty list gets no line — it would have
   *  nothing to divide and nowhere to render, and a control that silently does
   *  nothing visible is worse than none. */
  const addSeparator = useCallback((tier: string, project?: string) => {
    const mode = sepModeFor(tier);
    const tierIds = (tierIdsByTier.get(tier) ?? []).filter((id) => pinnedTaskMap.has(id));
    if (tierIds.length === 0) {
      onOperationError?.('Nothing to separate here yet: add a task first.');
      return;
    }
    const add = (sep: Omit<TierSeparator, 'id'>) =>
      persistSeparators([...separators, { id: newSeparatorId(), ...sep }]);

    if (mode === 'project') {
      const runs: string[] = [];
      for (const id of tierIds) {
        const p = pinnedTaskMap.get(id)?.project ?? '';
        if (!runs.includes(p)) runs.push(p);
      }
      // One folder means no boundary between folders. Say which mode does divide
      // inside a folder instead of failing silently.
      if (runs.length < 2) {
        onOperationError?.('Only one folder in this tier: "By project" puts a line BETWEEN folders. Switch to Custom order to divide inside one.');
        return;
      }
      // The line goes on the side of the clicked folder that HAS a neighbour:
      // below by default ("end the band after this folder"), above when it is the
      // last one. Either way it divides something, which a line at the very top or
      // bottom of the tier would not. A tier-level "+" has no folder, so it takes
      // the first boundary and the user drags from there.
      const idx = project !== undefined ? runs.indexOf(project) : 0;
      const slot = idx === -1 ? 1 : Math.min(idx + 1, runs.length - 1);
      add({ tier, mode, ...projectAnchorsForSlot(runs, slot) });
      return;
    }
    // Custom order: land at the TOP of the list, so it appears right where the
    // click was and can be dragged down from there.
    add({ tier, mode, ...anchorsForSlot(tierIds, 0) });
  }, [sepModeFor, tierIdsByTier, pinnedTaskMap, persistSeparators, separators, onOperationError]);

  const deleteSeparator = useCallback((id: string) => {
    persistSeparators(removeSeparator(separators, id));
  }, [persistSeparators, separators]);

  /** Name (or clear the name of) a line — a named line renders as a section
   *  heading. Empty text removes the field so the record stays a plain line. */
  const renameSeparator = useCallback((id: string, label: string) => {
    const sep = separators.find((s) => s.id === id);
    if (!sep || (sep.label ?? '') === label) return;
    const next = { ...sep };
    if (label) next.label = label; else delete next.label;
    persistSeparators(upsertSeparator(separators, next));
  }, [persistSeparators, separators]);

  // ── "+ → New task" targets ── The header "+" doesn't create a titled task by
  // itself; it opens the inline add row in the scope that was clicked (tier
  // bottom, or the end of one project run). Nonce-keyed so clicking "+" again
  // re-focuses an already-open row.
  const [tierAddSignal, setTierAddSignal] = useState<{ tier: string; nonce: number } | null>(null);
  const [runAddSignal, setRunAddSignal] = useState<{ tier: string; project: string; nonce: number } | null>(null);
  const addTaskToTier = useCallback((tier: string) => {
    setTierAddSignal({ tier, nonce: Date.now() });
  }, []);
  const addTaskToRun = useCallback((tier: string, project: string) => {
    setRunAddSignal({ tier, project, nonce: Date.now() });
  }, []);
  const tierAddOpenSignal = useCallback((tier: string) =>
    (tierAddSignal?.tier === tier ? tierAddSignal.nonce : undefined), [tierAddSignal]);
  const consumeTierAddSignal = useCallback(() => setTierAddSignal(null), []);
  /** The inline add row for ONE project run inside a tier. Mounted only while that
   *  run is the "+"-picked target — the tier's own bottom row covers the default
   *  case, and a permanent ghost row per project would triple the list's chrome.
   *  Consuming the signal zeroes the nonce instead of unmounting: dropping the row
   *  the moment it opens would eat the click that asked for it. */
  const runAddRow = useCallback((tier: string, project: string) => (
    <InlineAdd
      key={`runadd:${tier}:${project}`}
      label={`Add to ${project || 'Inbox'}…`}
      openSignal={runAddSignal?.tier === tier && runAddSignal.project === project ? runAddSignal.nonce : undefined}
      onOpenSignalConsumed={() => setRunAddSignal((s) => (s ? { ...s, nonce: 0 } : s))}
      onAdd={(title) => onCreate({ title, priority: 'none', project: project || undefined, pinnedTier: tier as FocusTier })}
    />
  ), [runAddSignal, onCreate]);

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
    // Minimal project folder labels — a slim 📁-style row above each project run
    // (ids are pre-clustered by project). PLAIN DOM, deliberately NOT a sortable
    // item: it never enters the SortableContext ids, so DnD indices/frozen refs
    // are untouched (React #185 history). Suppressed while a pinned drag is live
    // (labels would jump around under the pointer) and when the tier holds fewer
    // than 2 DISTINCT projects — a single label (incl. a lone "Inbox") separates
    // nothing and is pure noise.
    const distinctProjects = new Set<string>();
    for (const id of ids) {
      const t = pinnedTaskMap.get(id);
      if (t) distinctProjects.add(t.project || '');
    }
    // 'custom' view mode = raw pin order: no project runs exist, so no labels.
    // Labels STAY during a card drag (hiding them collapsed the tier into a
    // flat list mid-drag — "我完全懵逼", 2026-08-13) but render INERT: no drag
    // handle, no "+", no hover — read-only separators until the drop lands.
    const showFolders = distinctProjects.size >= 2 && tierViewMode(tier) === 'project';
    const foldersInert = isPinnedDragActive;
    // Project run sequence (first-seen order) — decides which SIDE of the target
    // the drop indicator draws on. handleLabelDrop's splice means the dragged
    // project takes the target's slot: dragging UP lands before the target
    // (line above), dragging DOWN lands after it (line below).
    const projSeq: string[] = [];
    for (const p of distinctProjects) projSeq.push(p);
    const dropSide = (targetProj: string): 'above' | 'below' =>
      // null check, not truthiness — '' (Inbox) is a legal dragged project.
      labelDragProj !== null && projSeq.indexOf(labelDragProj) > projSeq.indexOf(targetProj) ? 'above' : 'below';

    // Divider lines. CUSTOM mode: the lines are already IN `ids` as sortable
    // sentinels (clusterForTier) — the walk below renders them in place, and
    // placeSeparators must not run or every line would draw twice. PROJECT mode:
    // native-drag placement, with the live drag preview substituted for the
    // stored entry so what the user sees mid-drag is literally what gets saved.
    const sepMode: SeparatorMode = tierViewMode(tier) === 'custom' ? 'custom' : 'project';
    const sepList = sepPreview ? upsertSeparator(separators, sepPreview) : separators;
    const sepPlacement = sepMode === 'project' ? placeSeparators({
      ids,
      projectOf: (id) => { const t = pinnedTaskMap.get(id); return t ? (t.project || '') : null; },
      // A group is one unit: without this a line anchored to a card that later
      // joined a cluster ends up between two members and splits it.
      groupOf: (id) => pinnedTaskMap.get(id)?.group_id ?? null,
      tier,
      mode: sepMode,
      separators: sepList,
    }) : null;
    const sepRow = (sep: TierSeparator) => (
      <TierSeparatorRow key={sep.id} id={sep.id} label={sep.label} inert={isPinnedDragActive}
        isDragging={sepDrag === sep.id}
        onDragStart={setSepDrag} onDragEnd={clearSepDrag} onDelete={deleteSeparator}
        onRename={renameSeparator} />
    );
    // A tier whose visible rows are all filtered away draws no lines: nothing to
    // divide (mirrors placeSeparators' empty-tier rule for the sentinel path).
    const anyTaskVisible = ids.some((id) => pinnedTaskMap.has(id));

    let prevProject: string | null = null;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (isSeparatorId(id)) {
        // Custom-mode line: a real sortable unit — the strategy moves it with the
        // rows around it, so it can never be visually crossed mid-drag.
        const sep = separators.find((s) => s.id === id);
        if (sep && anyTaskVisible) {
          out.push(
            <SortableTierSeparatorRow key={id} id={id} tier={tier} label={sep.label}
              onDelete={deleteSeparator} onRename={renameSeparator} />
          );
        }
        continue;
      }
      if (isGroupSentinel(id)) {
        // A sentinel sits immediately before its member run (withGroupSentinels).
        // At rest the chip is emitted by the LEAD MEMBER branch below instead, so
        // it lands after that row's folder label / separator lines — the placement
        // those two features were written around. Only when the run is gone (this
        // group is collapsed mid-drag) does the sentinel draw the chip itself: it
        // IS the whole cluster then. Same key in both states, so React keeps one
        // chip instance and dnd-kit's active node never remounts mid-drag.
        const gid = parseGroupSentinelGid(id);
        const next = ids[i + 1];
        const runFollows = next !== undefined && !isGroupSentinel(next)
          && pinnedTaskMap.get(next)?.group_id === gid;
        if (runFollows) continue;
        out.push(
          <GroupChip key={groupSortableId(gid, tier)} groupId={gid} tier={tier}
            label={taskGroups?.[gid] ?? ''} onRename={handleRenameGroup}
            onDissolve={handleDissolveGroup} onHide={handleHideGroup} />
        );
        continue;
      }
      const task = pinnedTaskMap.get(id);
      if (!task) continue;
      const proj = task.project || '';
      // Leaving a project run: its inline "add task" row belongs to the run above,
      // so it goes out BEFORE the next folder label.
      if (sepMode === 'project' && prevProject !== null && proj !== prevProject) {
        if (runAddSignal?.tier === tier && runAddSignal.project === prevProject) out.push(runAddRow(tier, prevProject));
      }
      // A line placed between folders draws ABOVE this folder's label, outside the
      // folder entirely — a folder is one unit in this mode, and a line between a
      // label and its own cards would read as a split folder, not a band boundary.
      if (sepPlacement && proj !== prevProject) {
        for (const sep of sepPlacement.aboveProject.get(proj) ?? []) out.push(sepRow(sep));
      }
      if (showFolders && proj !== prevProject) {
        out.push(
          <div
            key={`projlabel:${tier}:${proj}`}
            // The REAL project name, which the visible text isn't: Inbox renders as
            // "Inbox" but is stored as ''. Anything matching folders (a separator's
            // boundary, a test) needs the stored value.
            data-project={proj}
            // Inbox ('') drags too — its slot rides ordering.projects as the
            // empty string. '' is falsy, so every gate below checks against
            // null (the "no drag" sentinel), never truthiness.
            className={`tier-project-label${!foldersInert ? ' tier-project-label-draggable' : ''}${foldersInert ? ' tier-project-label-inert' : ''}${labelDropProj === proj && labelDragProj !== proj ? ` tier-project-label-dropover dropover-${dropSide(proj)}` : ''}`}
            draggable={!foldersInert}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/walnut-project', proj);
              e.dataTransfer.effectAllowed = 'move';
              setLabelDragProj(proj);
            }}
            onDragEnd={() => { setLabelDragProj(null); setLabelDropProj(null); }}
            onDragOver={(e) => {
              if (labelDragProj !== null && labelDragProj !== proj) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setLabelDropProj(proj);
              }
            }}
            onDragLeave={() => { if (labelDropProj === proj) setLabelDropProj(null); }}
            onDrop={(e) => {
              e.preventDefault();
              // getData returns '' both for "no payload" AND for an Inbox drag —
              // labelDragProj (state) disambiguates; null means no live drag.
              const fromData = e.dataTransfer.getData('text/walnut-project');
              const active = fromData !== '' ? fromData : labelDragProj;
              if (active !== null) handleLabelDrop(active, proj);
            }}
            title="Drag to reorder projects"
          >
            <span className="tier-project-label-icon">{ICONS.ICON_FOLDER}</span>
            <span className="tier-project-label-name">{proj || 'Inbox'}</span>
            {/* Project "+" (GAP-2) — the same control the All-view project header
                carries, so a by-project tier reads and behaves the same way: new
                task / new task with session / add separator. The SESSION item is
                named-projects-only (a launch seeds the project's default folder and
                Inbox has no registry row to carry one); task + separator work for
                Inbox too, which is why the wrapper no longer gates on `proj`.
                The label is an HTML5 drag handle for project reordering, so a
                dragstart originating on the button is swallowed here — otherwise
                pressing "+" and twitching would arm a project reorder. */}
            <span
                className="tier-project-label-actions"
                draggable={false}
                onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                // Disarm the label's OWN draggability while the pointer is over
                // the "+": `draggable=false` here doesn't stop Chromium's native
                // drag detection on the draggable ANCESTOR, which silently eats
                // the click once the pointer slips ≥3px between press and release
                // (measured; a 16×12 target on a trackpad slips often). Toggled on
                // the DOM node directly — no re-render happens mid-hover, and a
                // re-render outside one re-applies React's value harmlessly.
                onPointerEnter={(e) => { const label = e.currentTarget.parentElement; if (label) label.draggable = false; }}
                onPointerLeave={(e) => { const label = e.currentTarget.parentElement; if (label) label.draggable = true; }}
              >
                <ProjectPlusMenu
                  project={proj}
                  onAddSession={proj && onOpenLauncherForProject ? onOpenLauncherForProject : undefined}
                  onAddTask={(p) => addTaskToRun(tier, p)}
                  onAddSeparator={(p) => addSeparator(tier, p)}
                />
              </span>
          </div>
        );
      }
      prevProject = proj;
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
          isVanishing={keepWhileCompleting(task) && graceExiting}
          isSessionOpen={openSessionTaskIds?.has(task.id) ?? false}
          isDetailOpen={focusedTaskId === task.id && !suppressDetail}
          onClick={handlePinnedCardClick} onSetTier={onSetTier} onUnpinTask={onUnpinTask}
          onPinTask={onPinTask} onSetPriority={onSetPriority} onSetDate={onSetDate} onSetStartDate={onSetStartDate}
          onExpandDetail={handleExpandDetail} onClearFocus={onClearFocus} onOpenSession={onOpenSession}
          onStartSession={onStartSession}
          onSetPhase={setPhaseOrComplete} onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
          onDelete={onDelete} onMoveToProject={onMoveTask ? handleMoveToProject : undefined}
          groupInfo={gi} selectMode={selectMode}
          isSelected={selectedIds.has(task.id)} onSelectToggle={onSelectToggle}
          onStartSelect={onStartSelect} isGroupTarget={groupTargetId === task.id} />
      );
    }
    // Project-mode lines whose neighbours are all gone end up here, at the bottom
    // of the tier: the user placed them, only their neighbourhood moved on. Then
    // the last run's inline "add task" row.
    if (sepPlacement) for (const sep of sepPlacement.tail) out.push(sepRow(sep));
    const lastScope = prevProject ?? '';
    if (sepMode === 'project' && runAddSignal?.tier === tier && runAddSignal.project === lastScope) {
      out.push(runAddRow(tier, lastScope));
    }
    return out;
  }, [pinnedTaskMap, taskGroups, focusedTaskId, openSessionTaskIds, suppressDetail, handlePinnedCardClick, onSetTier, onUnpinTask, onPinTask, onSetPriority, onSetDate, handleExpandDetail, onClearFocus, onOpenSession, onStartSession, setPhaseOrComplete, onUpdate, handleUpdateTitle, onDelete, onMoveTask, handleMoveToProject, selectMode, selectedIds, onSelectToggle, onStartSelect, groupTargetId, handleRenameGroup, handleDissolveGroup, handleHideGroup, keepWhileCompleting, recentTick, graceExiting, isPinnedDragActive, labelDragProj, labelDropProj, handleLabelDrop, tierViewMode, onOpenLauncherForProject, separators, sepPreview, sepDrag, setSepDrag, clearSepDrag, deleteSeparator, renameSeparator, addSeparator, addTaskToRun, runAddRow, runAddSignal]);

  // The regular task list gets its own PINNED/RECENT-style collapsible bar.
  // Outside the stacked view the Tasks tab IS the list — it can't be folded away.
  // A live search also unfolds it (matching isFolded): hits must never hide
  // behind a chevron the user folded before searching.
  const tasksCollapsed = isAll && !isSearchMode && collapsedSections.has('tasks');
  const tasksVisible = showSection('tasks');
  // Any pinned tier showing? Drives whether the pinned wrapper mounts at all.
  const anyTierVisible = showSection('focus') || showSection('satellite') || showSection('backlog') || showSection('wait')
    || (customTiers ?? []).some((t) => showSection(t.id));
  const recentVisible = showSection('recent');
  // When both Pinned and Recent are collapsed (or absent), the pinned wrapper
  // shrink-wraps its header rows instead of holding the splitter ratio — no
  // dead blank region pushing the task list down. In a single-section view the
  // region always owns the full panel, so it's never "collapsed" in this sense.
  const pinnedAreaCollapsed = isAll
    && (visiblePinnedTasks.length === 0 || (!isSearchMode && collapsedSections.has('pinned')))
    && (visibleRecentTasks.length === 0 || (!isSearchMode && collapsedSections.has('recent')));
  // Section counts for the tab badges. `focus`/`satellite`/`backlog`/`wait`/`recent`
  // come from the already-computed display arrays, so the badges track exactly what
  // the tab would render (incl. project/filter scoping).
  const sectionCounts: Partial<Record<TodoSection, number>> = {
    focus: focusTasksDisplay.length,
    satellite: satelliteTasksDisplay.length,
    backlog: backlogTasksDisplay.length,
    wait: waitTasksDisplay.length,
    recent: visibleRecentTasks.length,
    // Real hits only — descendant CONTEXT rows never inflate the badge.
    tasks: isSearchMode ? searchMatches.length : matchedIds.size,
  };
  for (const def of customTiers ?? []) {
    sectionCounts[def.id] = customTierRender[def.id]?.display.length ?? 0;
  }
  // In a single-tier view the tier fills the panel: the persisted per-tier drag
  // height (a cap sized for the old cramped stack) would leave dead space below.
  const tierHeight = (h: number | null) => (isAll && h != null ? { maxHeight: h } : undefined);

  // Date quick chip (tier bar + tasks mini-bar): one click flips between the
  // two everyday values — Now (hide deferred) and All. From a long-tail value
  // (Overdue/Week/No date, set in the View panel) a click lands on Now, so the
  // chip always converges on the everyday pair.
  const dateQuickLabel = dateFilter ? (DATE_LABELS[dateFilter] ?? dateFilter) : 'All';
  const toggleDateQuick = () => {
    const next: DateFilter = dateFilter === 'now' ? '' : 'now';
    setDateFilter(next); persistDateFilter(next); clearFocusOverride();
  };
  const dateQuickChip = (
    <button
      type="button"
      className={`todo-minibar-btn todo-minibar-date${dateFilter ? ' on' : ''}`}
      title={dateFilter === 'now'
        ? 'Date: Now — tasks with a future start date are hidden. Click to show All.'
        : dateFilter === ''
          ? 'Date: All — every task shown, deferred ones included. Click to switch to Now.'
          : `Date: ${dateQuickLabel} (set in the View panel). Click to switch to Now.`}
      onClick={toggleDateQuick}
    >
      ◷ {dateQuickLabel}
    </button>
  );

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
          projects={projectTabs}
          activeProject={activeProject}
          onProjectChange={(p) => { setActiveProject(p); persistTab(p); onProjectChange?.(p); }}
          projectCounts={projectCounts}
          phaseFilter={phaseFilter}
          onPhaseFilterChange={(v) => { setPhaseFilter(v); clearFocusOverride(); }}
          dateFilter={dateFilter}
          onDateFilterChange={(v) => { setDateFilter(v); persistDateFilter(v); clearFocusOverride(); }}
          sortBy={sortBy}
          onSortByChange={(v) => { setSortBy(v); persistSortBy(v); }}
          groupBy={groupBy}
          onGroupByChange={(v) => { setGroupBy(v); persistGroupBy(v); }}
          showCompleted={showCompleted}
          onShowCompletedChange={(v) => { setShowCompleted(v); clearFocusOverride(); }}
          onClearAll={() => {
            setActiveProject(''); persistTab(''); onProjectChange?.('');
            setPhaseFilter('');
            setDateFilter(''); persistDateFilter('');
            setTaskQueryState((prev) => ({ ...DEFAULT_TASK_QUERY_FILTER_STATE, sort: prev.sort }));
            clearFocusOverride();
          }}
          query={taskQueryState}
          onQueryChange={handleQueryChange}
          queryProjectOptions={queryProjectOptions}
          querySourceOptions={querySourceOptions}
          querySprintOptions={querySprintOptions}
        />
        {/* Multi-select grouping is entered from each task's ⋮ menu ("Select…") or
            Cmd/Ctrl/Shift-click — no separate toolbar button (keeps the bar clean). */}
      </div>

      {/* ✦ AI lane: an in-process agent searches tasks AND session transcripts,
          streaming its progress live. Anchored here — directly under the search
          bar, OUTSIDE every scroll container — so it is always visible at the
          very top while searching, wherever the list is scrolled. */}
      {isSearchMode && (
        <AgentSearchPanel query={searchQuery} onOpenTask={handleAgentResultClick} />
      )}

      {/* Active conditions strip: one removable chip per value, above the tabs so
          it reads as "what this whole panel is showing". */}
      <TaskFilterChips
        query={taskQueryState}
        onQueryChange={handleQueryChange}
        onClearAll={clearFocusOverride}
      />

      {/* Section tabs — one section owns the panel at a time (see TodoSectionTabs). */}
      <TodoSectionTabs active={effectiveSection} onChange={handleSectionChange} counts={sectionCounts} customTiers={customTiers} />

      {/* Mini-bar: high-frequency verbs that used to hide in the View dropdown.
          ONLY on the Tasks section view — the pinned tiers and the stacked All
          view keep their clean chrome (user ruling 2026-08-10). */}
      {!isSearchMode && effectiveSection === 'tasks' && (
        <div className="todo-minibar">
          <button
            type="button"
            className="todo-minibar-btn"
            title={allCollapsed ? 'Expand all projects' : 'Collapse all projects'}
            onClick={handleCollapseExpandAll}
          >
            {allCollapsed ? '⌃⌃ Expand all' : '⌄⌄ Collapse all'}
          </button>
          <span className="todo-minibar-sep" />
          <button
            type="button"
            className={`todo-minibar-btn${showCompleted ? ' on' : ''}`}
            title={showCompleted ? 'Hide completed tasks' : 'Show completed tasks'}
            onClick={() => { setShowCompleted(!showCompleted); clearFocusOverride(); }}
          >
            ✓ Done
          </button>
          <button
            type="button"
            className="todo-minibar-btn"
            title="Cycle sort: manual → priority → date → updated"
            onClick={() => {
              const cycle: SortBy[] = ['manual', 'priority', 'date', 'updated'];
              const next = cycle[(cycle.indexOf(sortBy) + 1) % cycle.length];
              setSortBy(next);
              persistSortBy(next);
            }}
          >
            ↕ {sortBy === 'manual' ? 'Manual' : sortBy === 'priority' ? 'Priority' : sortBy === 'date' ? 'Date' : 'Updated'}
          </button>
          {dateQuickChip}
          {runningTaskIds.length > 0 && (
            <>
              <span className="todo-minibar-sep" />
              <button
                type="button"
                className="todo-minibar-btn todo-minibar-running"
                title="Jump to the next task with a running session"
                onClick={jumpToNextRunning}
              >
                <span className="todo-minibar-running-dot" />
                Running ({runningTaskIds.length})
              </button>
            </>
          )}
        </div>
      )}

      {/* Tier view-mode bar — on single-TIER tabs only (not All/Recent/Notes):
          group by project (clustered + folder labels) vs the raw custom pin
          order. Persisted per tier; the two underlying orders are separate
          stores, so flipping the mode never rewrites either. */}
      {!isSearchMode
        && (['focus', 'satellite', 'backlog', 'wait'].includes(effectiveSection) || effectiveSection.startsWith('ct_'))
        && (
        <div className="todo-minibar" data-testid="tier-view-bar">
          {/* ONE toggle, not two buttons (user ruling 2026-08-23, same pattern
              as the Date chip): the label shows the ACTIVE mode, a click
              switches to the other. */}
          <button
            type="button"
            className="todo-minibar-btn on"
            data-testid="tier-mode-toggle"
            title={tierViewMode(effectiveSection) === 'project'
              ? 'Grouped by project, with folder labels. Click for your custom pin order.'
              : 'Your custom pin order (drag to arrange). Click to group by project.'}
            onClick={() => setTierViewMode(effectiveSection, tierViewMode(effectiveSection) === 'project' ? 'custom' : 'project')}
          >
            {tierViewMode(effectiveSection) === 'project'
              ? <>{ICONS.ICON_FOLDER} By project</>
              : <>↕ Custom order</>}
          </button>
          {dateQuickChip}
          {/* The tier's "+" (GAP-1). In the stacked All view every tier owns a
              sublabel row that carries this button; a single-tier tab has no
              sublabel (the tab itself names the tier), so the tier view bar is where
              the same control belongs — otherwise the tier tabs are the only place in
              the panel with no route to a session. Same handlers and same
              `meta.pinTier` seed as the All-view sublabel "+". */}
          <TierPlusButton
            tier={effectiveSection}
            label={tierDisplayLabel(effectiveSection, customTiers)}
            onAddSession={onOpenLauncherForTier}
            onAddTask={addTaskToTier}
            onAddSeparator={addSeparator}
          />
        </div>
      )}

      {/* Recent view-mode bar — the Recent tab's counterpart to the tier bar:
          sort the activity feed by last update (default) or by creation time.
          Pure sort toggle; the underlying feed isn't rewritten. */}
      {!isSearchMode && effectiveSection === 'recent' && (
        <div className="todo-minibar" data-testid="recent-sort-bar">
          {/* Same one-button toggle grammar as the tier mode / Date chips. */}
          <button
            type="button"
            className="todo-minibar-btn on"
            title={recentSortMode === 'updated'
              ? 'Sorted by latest activity (updates, sessions, completion). Click to sort by creation time.'
              : 'Sorted by creation time. Click to sort by latest activity.'}
            onClick={() => handleRecentSortChange(recentSortMode === 'updated' ? 'created' : 'updated')}
          >
            ↕ {recentSortMode === 'updated' ? 'Sort by update' : 'Sort by creation time'}
          </button>
        </div>
      )}

      {/* Unified DndContext wrapping both Pinned + Recent — enables drag from Recent to Pin */}
      {(anyTierVisible || recentVisible) && (visiblePinnedTasks.length > 0 || visibleRecentTasks.length > 0 || hiddenPinnedGroups.length > 0) && (
        <DndContext sensors={pinnedSensors} collisionDetection={closestCenter} onDragStart={handlePinnedDragStart} onDragMove={handlePinnedDragMove} onDragOver={handlePinnedDragOver} onDragEnd={handlePinnedDragEnd} onDragCancel={handlePinnedDragCancel}>
          <div
            ref={pinnedWrapperRef}
            // -unpin-armed opens a row-free band at the SCROLL END (padding on the
            // scroll container moves no existing row and no measured rect), so the
            // strip has somewhere it can actually accept a drop when a full tier
            // is scrolled to its bottom — over a real row it always refuses.
            className={`todo-pinned-wrapper${isAll ? '' : ' todo-pinned-wrapper-solo'}${unpinZone ? ' todo-pinned-wrapper-unpin-armed' : ''}`}
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
          {/* PINNED section — Focus + Satellite + Backlog + Wait sub-groups. In a single-tier
              view the "Pinned" wrapper header is dropped (the tab already names the
              tier) and only that tier's subgroup renders. */}
          {anyTierVisible && (visiblePinnedTasks.length > 0 || !isAll) && (
            <div className={`todo-pinned-section${isAll ? '' : ' todo-pinned-section-solo'}`}>
              {isAll && (
              <div className="todo-pinned-header" onClick={() => toggleSection('pinned')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSection('pinned'); }} style={{ cursor: 'pointer' }}>
                <span className={`todo-pinned-chevron${chevronCollapsed('pinned') ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
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
                      <span className={`todo-pinned-chevron todo-pinned-sub-chevron${chevronCollapsed('focus') ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                      <span className="todo-pinned-sublabel-icon todo-tier-icon-focus">{ICONS.ICON_TIER_FOCUS}</span>
                      <span className="todo-pinned-sublabel-text">Focus</span>
                      <span className="todo-pinned-sublabel-count">{focusTasksDisplay.length}</span>
                      <TierPlusButton tier="focus" label="Focus" onAddSession={onOpenLauncherForTier}
                        onAddTask={addTaskToTier} onAddSeparator={addSeparator} />
                    </div>
                    )}
                    {!isFolded('focus') && (
                      <SortableContext items={visibleFocusIds} strategy={verticalListSortingStrategy}>
                        <div className="todo-pinned-list-scroll" style={tierHeight(focusResize.height)} {...sepDropProps('focus')}>
                          <TierDropZone id="focus-drop-zone" isEmpty={focusTasksDisplay.length === 0}>
                            {renderTierItems(visibleFocusIds, 'focus', focusGroupMeta)}
                          </TierDropZone>
                          <InlineAdd label="Add to Focus…" openSignal={tierAddOpenSignal('focus')} onOpenSignalConsumed={consumeTierAddSignal} onAdd={async (title) => {
                            // capture:true → routes to the configured Default Platform/Project (fast local Inbox by default).
                            // No onFocusTask here: handleCreate already locates the new card with
                            // scope 'pinned' (Pinned-region scroll only). Calling onFocusTask would
                            // reset the scope to 'all' and switch the TASKS tab to the capture
                            // project — the "all my tasks disappeared" bug.
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
                      <div className="todo-pinned-sublabel" onClick={() => toggleSection('satellite')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSection('satellite'); }} style={{ cursor: 'pointer' }} title="Satellite — needs doing soon, the default pinned tier">
                        <span className={`todo-pinned-chevron todo-pinned-sub-chevron${chevronCollapsed('satellite') ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                        <span className="todo-pinned-sublabel-icon todo-tier-icon-satellite">{ICONS.ICON_TIER_SATELLITE}</span>
                        <span className="todo-pinned-sublabel-text">Satellite</span>
                        <span className="todo-pinned-sublabel-count">{satelliteTasksDisplay.length}</span>
                        <TierPlusButton tier="satellite" label="Satellite" onAddSession={onOpenLauncherForTier}
                        onAddTask={addTaskToTier} onAddSeparator={addSeparator} />
                      </div>
                      )}
                      {!isFolded('satellite') && (
                        <SortableContext items={visibleSatelliteIds} strategy={verticalListSortingStrategy}>
                          <div className="todo-pinned-list todo-pinned-list-scroll" style={tierHeight(satelliteResize.height)} {...sepDropProps('satellite')}>
                            {/* Solo view needs the drop zone so an empty Satellite tab is
                                still a valid drag target — the stacked view can skip it
                                because the tier only renders when non-empty. */}
                            {isAll ? renderTierItems(visibleSatelliteIds, 'satellite', satelliteGroupMeta) : (
                              <TierDropZone id="satellite-drop-zone" isEmpty={satelliteTasksDisplay.length === 0}>
                                {renderTierItems(visibleSatelliteIds, 'satellite', satelliteGroupMeta)}
                              </TierDropZone>
                            )}
                            <InlineAdd label="Add to Satellite…" openSignal={tierAddOpenSignal('satellite')} onOpenSignalConsumed={consumeTierAddSignal} onAdd={async (title) => {
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

                  {/* Backlog sub-group — someday work, pinned but not soon.
                      Renders unconditionally like Wait (NOT non-empty-gated like
                      Satellite/customs): the four built-ins ARE the tier model, so an
                      empty Backlog stays visible as a drop target / affordance.
                      Customs instead mount-on-drag (see the isPinnedDragActive gate
                      below) because N user tiers would multiply empty chrome. */}
                  {showSection('backlog') && (
                  <div className="todo-pinned-subgroup">
                    {isAll && (
                    <div className="todo-pinned-sublabel" onClick={() => toggleSection('backlog')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSection('backlog'); }} style={{ cursor: 'pointer' }} title="Backlog — someday work you still want pinned">
                      <span className={`todo-pinned-chevron todo-pinned-sub-chevron${chevronCollapsed('backlog') ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                      <span className="todo-pinned-sublabel-icon todo-tier-icon-backlog">{ICONS.ICON_TIER_BACKLOG}</span>
                      <span className="todo-pinned-sublabel-text">Backlog</span>
                      <span className="todo-pinned-sublabel-count">{backlogTasksDisplay.length}</span>
                      <TierPlusButton tier="backlog" label="Backlog" onAddSession={onOpenLauncherForTier}
                        onAddTask={addTaskToTier} onAddSeparator={addSeparator} />
                    </div>
                    )}
                    {!isFolded('backlog') && (
                      <SortableContext items={visibleBacklogIds} strategy={verticalListSortingStrategy}>
                        <div className="todo-pinned-list-scroll" style={tierHeight(backlogResize.height)} {...sepDropProps('backlog')}>
                          <TierDropZone id="backlog-drop-zone" isEmpty={backlogTasksDisplay.length === 0}>
                            {renderTierItems(visibleBacklogIds, 'backlog', backlogGroupMeta)}
                          </TierDropZone>
                          <InlineAdd label="Add to Backlog…" openSignal={tierAddOpenSignal('backlog')} onOpenSignalConsumed={consumeTierAddSignal} onAdd={async (title) => {
                            // handleCreate locates with scope 'pinned' — see the Focus InlineAdd note.
                            await onCreate({ title, priority: 'none', pinnedTier: 'backlog', capture: true });
                          }} />
                        </div>
                        {isAll && (
                        <div
                          className={`todo-tier-resize-handle${backlogResize.isDragging ? ' dragging' : ''}`}
                          onPointerDown={(e) => backlogResize.handlePointerDown(e, e.currentTarget.previousElementSibling as HTMLElement | null)}
                          title="Drag to resize Backlog"
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
                      <span className={`todo-pinned-chevron todo-pinned-sub-chevron${chevronCollapsed('wait') ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                      <span className="todo-pinned-sublabel-icon todo-tier-icon-wait">{ICONS.ICON_TIER_WAIT}</span>
                      <span className="todo-pinned-sublabel-text">Wait</span>
                      <span className="todo-pinned-sublabel-count">{waitTasksDisplay.length}</span>
                      <TierPlusButton tier="wait" label="Wait" onAddSession={onOpenLauncherForTier}
                        onAddTask={addTaskToTier} onAddSeparator={addSeparator} />
                    </div>
                    )}
                    {!isFolded('wait') && (
                      <SortableContext items={visibleWaitIds} strategy={verticalListSortingStrategy}>
                        <div className="todo-pinned-list-scroll" style={tierHeight(waitResize.height)} {...sepDropProps('wait')}>
                          <TierDropZone id="wait-drop-zone" isEmpty={waitTasksDisplay.length === 0}>
                            {renderTierItems(visibleWaitIds, 'wait', waitGroupMeta)}
                          </TierDropZone>
                          <InlineAdd label="Add to Wait…" openSignal={tierAddOpenSignal('wait')} onOpenSignalConsumed={consumeTierAddSignal} onAdd={async (title) => {
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

                  {/* Custom tier sub-groups — one per registry entry, after the built-ins.
                      Each is its own component (owns its useResizableHeight hook). */}
                  {(customTiers ?? []).map((def) => {
                    if (!showSection(def.id)) return null;
                    const render = customTierRender[def.id] ?? { visibleIds: [], display: [], groupMeta: new Map<string, GroupRenderInfo>() };
                    // Stacked view hides an EMPTY custom tier (mirrors Satellite's
                    // non-empty gate) — its own tab always renders it. EXCEPT while
                    // a drag is live: dragging a tier's last card out empties its
                    // live array, and unmounting the subgroup here would remove its
                    // droppable mid-drag — the user could never drag the card back.
                    if (isAll && !isPinnedDragActive && render.display.length === 0) return null;
                    return (
                      <CustomTierSubgroup
                        key={def.id}
                        def={def}
                        isAll={isAll}
                        folded={isFolded(def.id)}
                        collapsed={chevronCollapsed(def.id)}
                        onToggle={toggleSection}
                        visibleIds={render.visibleIds}
                        isEmpty={render.display.length === 0}
                        count={render.display.length}
                        onAdd={(title) => onCreate({ title, priority: 'none', pinnedTier: def.id, capture: true })}
                        onAddSession={onOpenLauncherForTier}
                        onAddTask={addTaskToTier}
                        onAddSeparator={addSeparator}
                        dropProps={sepDropProps(def.id)}
                        addOpenSignal={tierAddOpenSignal(def.id)}
                        onAddSignalConsumed={consumeTierAddSignal}
                      >
                        {renderTierItems(render.visibleIds, def.id, render.groupMeta)}
                      </CustomTierSubgroup>
                    );
                  })}
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
                <span className={`todo-pinned-chevron${chevronCollapsed('recent') ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
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
                        isVanishing={keepWhileCompleting(task) && !showCompleted && graceExiting}
                        isSessionOpen={openSessionTaskIds?.has(task.id) ?? false}
                        isDetailOpen={focusedTaskId === task.id && !suppressDetail}
                        onClick={handlePinnedCardClick}
                        onPinTask={onPinTask}
                        onUnpinTask={onUnpinTask}
                        isPinned={pinnedTaskIds?.has(task.id)}
                        pinnedTier={getTier(task.id)}
                        pinnedTierLabel={(() => { const t = getTier(task.id); return t ? (customTiers?.find((d) => d.id === t)?.label) : undefined; })()}
                        onSetPriority={onSetPriority}
                        onSetDate={onSetDate}
                        onSetStartDate={onSetStartDate}
                                    onSetTier={onSetTier}
                        onExpandDetail={handleExpandDetail}
                        onClearFocus={onClearFocus}
                        onOpenSession={onOpenSession}
                        onStartSession={onStartSession}
                        onSetPhase={setPhaseOrComplete}
                        onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                        onMoveToProject={onMoveTask ? handleMoveToProject : undefined}
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
          {/* The way out of the pinned area — see handlePinnedDragStart. Portalled at
              fixed coords over the wrapper's bottom edge so it costs the lists no
              reflow, and deliberately not a droppable: the pointer decides, so a card
              aimed at the last row of a tier can't be unpinned by a stray collision. */}
          {unpinZone && createPortal(
            <div
              className={`todo-unpin-zone${unpinHot ? ' todo-unpin-zone-hot' : ''}`}
              data-testid="unpin-drop-zone"
              style={{ left: unpinZone.left, top: unpinZone.top, width: unpinZone.width, height: unpinZone.height }}
            >
              <span className="todo-unpin-zone-icon" aria-hidden="true">↧</span>
              <span>{unpinHot ? 'Release to unpin' : 'Drop here to unpin'}</span>
            </div>,
            document.body,
          )}
          {/* Floating preview card during cross-container drag. pointer-events
              none so hit tests (the unpin strip's elementFromPoint row guard)
              see the row UNDER the pointer, not this chrome — dnd-kit does not
              set it by default. */}
          <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }}>
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
            {/* Divider-line drag: the cursor carries the line (+ heading text). */}
            {activeDragSep && (
              <div className={`tier-separator tier-separator-overlay${activeDragSep.label ? ' tier-separator-named' : ''}`}>
                {activeDragSep.label ? <span className="tier-separator-label">{activeDragSep.label}</span> : null}
                <span className="tier-separator-line" />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {/* Draggable divider between PINNED+RECENT and the main task list.
          Task detail now opens in a full-screen modal (hosted by MainPage), so only
          the inline project pane (detailTarget) compresses the list here. */}
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
        <span className="todo-pinned-count">{isSearchMode ? searchMatches.length : matchedIds.size}</span>
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
        {/* Search mode: flat, score-sorted list (no project grouping) */}
        {!loading && isSearchMode && searchFiltered.length > 0 && (
          <div className="todo-search-results">
            {(() => {
              // Compute child maps from searchFiltered (cross-project)
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
                    isVanishing={recentlyCompletedRef.current.has(task.id) && completedWillHide && graceExiting}
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
                            onDelete={onDelete}
                    onSetPriority={onSetPriority}
                    onSetDate={onSetDate}
                    onSetStartDate={onSetStartDate}
                    onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                    onOpenSession={onOpenSession}
                    onStartSession={onStartSession}
                    onExpandDetail={handleExpandDetail}
                    onClearFocus={onClearFocus}
                    onPinTask={onPinTask}
                    onUnpinTask={onUnpinTask}
                    onSetTier={onSetTier}
                    onUnparent={onReparentTask ? handleUnparent : undefined}
                    onMoveUp={moveUpMap.get(task.id)}
                    onMoveToProject={onMoveTask ? handleMoveToProject : undefined}
                    isPinned={pinnedTaskIds?.has(task.id)}
                    pinnedTier={getTier(task.id)}
                    searchContext={task.project || 'Inbox'}
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
                  isVanishing={recentlyCompletedRef.current.has(task.id) && completedWillHide && graceExiting}
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
                        onDelete={onDelete}
                  onSetPriority={onSetPriority}
                  onSetDate={onSetDate}
                  onSetStartDate={onSetStartDate}
                  onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                  onOpenSession={onOpenSession}
                  onStartSession={onStartSession}
                  onExpandDetail={handleExpandDetail}
                  onClearFocus={onClearFocus}
                  onPinTask={onPinTask}
                  onUnpinTask={onUnpinTask}
                  onUnparent={onReparentTask ? handleUnparent : undefined}
                  onMoveUp={moveUpMap.get(task.id)}
                  onMoveToProject={onMoveTask ? handleMoveToProject : undefined}
                  isPinned={pinnedTaskIds?.has(task.id)}
                  searchContext={task.project || 'Inbox'}
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
            onDragCancel={handleMainDragCancel}
          >
            <SortableContext items={grouped.map((g) => `proj:${g.project}`)} strategy={verticalListSortingStrategy}>
              {grouped.map(({ project, tasks: projTasks }) => (
                <SortableGroupItem key={`proj:${project}`} id={`proj:${project}`}>
                  {({ dragHandleProps }: { dragHandleProps: Record<string, unknown> }) => (
                    <div className="todo-group-project">
                      <DroppableHeader id={`hdr-proj:${project}`} project={project} disabled={activeDragType !== 'task'}>
                        {({ isOver: isHeaderOver, setNodeRef: setHeaderRef }) => (
                          <div ref={setHeaderRef} className={`todo-group-project-header${isHeaderOver ? ' header-drop-active' : ''}`} {...dragHandleProps}>
                            <div className="todo-group-header-controls">
                              <button className={`collapse-chevron${!isProjectCollapsed(project) ? ' expanded' : ''}`} onClick={(e) => { e.stopPropagation(); toggleProject(project); }} title="Collapse/Expand">
                                {CHEVRON_ICON}
                              </button>
                              {/* Inbox is the ABSENCE of a project — no registry row, so no detail pane and no favorite star. */}
                              <button className="todo-group-name-btn" onClick={() => showProjectDetail(project)} disabled={!project} title={project ? 'View project details' : 'Tasks with no project'}>
                                <span className="todo-group-project-name">{project || 'Inbox'}</span>
                                <ProjectSourceBadge source={projectRegistry.sourceByName.get(project.toLowerCase())} />
                                <span className="todo-group-count text-xs text-muted">{projTasks.length}</span>
                              </button>
                            </div>
                            {favorites && project && (
                              <button
                                className="todo-group-fav-btn"
                                onClick={(e) => { e.stopPropagation(); favorites.toggleFavoriteProject(project); }}
                                title={favorites.isProjectFavorite(project) ? 'Unfavorite project' : 'Favorite project'}
                              >
                                {favorites.isProjectFavorite(project) ? '\u2605' : '\u2606'}
                              </button>
                            )}
                            <span className="todo-group-header-actions">
                              {/* "+" → new task (opens this group's ghost row, in place)
                                  or new task with session. The SESSION branch stays
                                  named-projects-only: a launch seeds the project's
                                  default cwd and Inbox has no registry row to carry one.
                                  No separator item here — divider lines live in the
                                  pinned TIER lists, whose two view modes define what a
                                  line's position means. */}
                              <ProjectPlusMenu
                                project={project}
                                onAddSession={project ? onOpenLauncherForProject : undefined}
                                onAddTask={(p) => setHeaderAddSignal({ project: p, nonce: Date.now() })}
                              />
                              {project && (
                                <ProjectKebabMenu
                                  project={project}
                                  isFavorite={favorites?.isProjectFavorite(project)}
                                  onToggleFavorite={favorites ? favorites.toggleFavoriteProject : undefined}
                                  onViewDetails={showProjectDetail}
                                />
                              )}
                            </span>
                          </div>
                        )}
                      </DroppableHeader>
                      {!isProjectCollapsed(project) && (
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
                                isVanishing={recentlyCompletedRef.current.has(task.id) && completedWillHide && graceExiting}
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
                                                    onDelete={onDelete}
                                onSetPriority={onSetPriority}
                                onSetDate={onSetDate}
                                onSetStartDate={onSetStartDate}
                                onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                                onOpenSession={onOpenSession}
                                onStartSession={onStartSession}
                                onExpandDetail={handleExpandDetail}
                                onClearFocus={onClearFocus}
                                onPinTask={onPinTask}
                                onUnpinTask={onUnpinTask}
                                onSetTier={onSetTier}
                                onUnparent={onReparentTask ? handleUnparent : undefined}
                                onMoveUp={moveUpMap.get(task.id)}
                                onMoveToProject={onMoveTask ? handleMoveToProject : undefined}
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
                          <InlineAdd
                            label={`Add to ${project || 'Inbox'}\u2026`}
                            openSignal={headerAddSignal?.project === project ? headerAddSignal.nonce : undefined}
                            onOpenSignalConsumed={clearHeaderAddSignal}
                            onAdd={async (title) => {
                              const result = await onCreate({ title, priority: 'none', project: project || undefined });
                              const newTask = result as Task | undefined;
                              // openDetail:false — quick-add just scrolls to the new card; don't pop the detail panel.
                              if (newTask?.id) onFocusTask?.(newTask, { openDetail: false });
                            }}
                          />
                        </SortableContext>
                      )}
                    </div>
                  )}
                </SortableGroupItem>
              ))}
            </SortableContext>

            <DragOverlay
              modifiers={activeDragType === 'project-group' ? [snapToCursor] : undefined}
            >
              {activeDragType === 'project-group' && activeDragId ? (
                <div className="drag-overlay-group">
                  {activeDragId.slice(5) || 'Inbox'}
                </div>
              ) : draggedTask ? (
                <TaskItemOverlay task={draggedTask} />
              ) : null}
            </DragOverlay>

            {/* Container creation, clearly apart from task rows (hairline + dashed
                outline). The new empty group appears directly above this row —
                see freshProjects in the grouped memo. */}
            <NewProjectRow
              onError={onOperationError}
              onCreated={(name) => {
                setFreshProjects((prev) => (prev.includes(name) ? prev : [...prev, name]));
                projectRegistry.refresh();
                // Open the new group's ghost add row so the very next keystroke
                // is the first task's title.
                handleHeaderAddTask(name);
              }}
            />
          </DndContext>
        )}
      </div>
      )}

      {/* Detail pane: the project registry row (inline split-pane). Task detail now
          opens in a full-screen modal hosted by MainPage, not inline here. */}
      {detailTarget && <div className="todo-detail-splitter" {...splitterHandleProps} />}
      {detailTarget?.type === 'project' && (
        <ProjectDetailPane
          project={detailTarget.project}
          tasks={tasks}
          onClose={() => setDetailTarget(null)}
          style={{ flex: `${detailRatio} 1 0%` }}
        />
      )}

      {/* operationError is surfaced globally via the unified notification toaster (AppShell). */}
      {/* The old bottom "Quick add task..." bar is gone (2026-08-09): a creation
          input detached from the list couldn't answer "which project does this
          land in". Creation now lives IN the list — each group's ghost add row
          (title-aligned) — plus the header "+" composer for richer input. */}
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
          are picked (no project scope rule). "Cancel" abandons the selection and
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
            onMoveAllToProject={batchMoveToProject}
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
