import { Fragment, useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef, useDeferredValue, memo, startTransition, type CSSProperties, type DragEvent as ReactDragEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { SESSION_MODE_LABELS } from '@open-walnut/core';
import type { Task as CoreTask, SessionRecord } from '@open-walnut/core';
import { renderNoteMarkdown } from '@/utils/markdown';
import { fetchSessionsForTask } from '@/api/sessions';
import { fetchTask, updateTask as apiUpdateTask, type BatchTaskOutcome } from '@/api/tasks';
import { PluginFieldPills } from '@/components/tasks/PluginFieldPicker';
import { PluginSlotFact, PluginSlots } from '@/plugins/PluginSlots';
import { fetchTriageHistory } from '@/api/chat';
import { useEvent } from '@/hooks/useWebSocket';
import { useConfirm, usePrompt } from '@/hooks/useConfirm';
import { useNotifications } from '@/contexts/notifications';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { timeAgo } from '@/utils/time';
import { scrollLog } from '@/utils/scroll-debug';
import type { ProcessStatus } from '@open-walnut/core';
import type { TaskPhase } from '@/types/session';
import { PHASE_LABELS, PHASE_COLORS, PROCESS_COLORS, resolveTaskSessionId, phasePickerChoices, taskNeedsAction } from '@/utils/session-status';
import type { UseFavoritesReturn } from '@/hooks/useFavorites';
import type { UseOrderingReturn } from '@/hooks/useOrdering';
import * as ICONS from '../common/Icons';
import type { TaskPriority } from '@open-walnut/core';
import { TodoSearchBar } from './TodoSearchBar';
import { NavigationHeading, NavigationSection, NavigationSections } from './NavigationSections';
import { recentActivityTime, recentActivityTitle, type RecentSortMode } from './recent-activity-time';
import { footerStatusScope } from './footer-scope';
import type { ContextMenuItem } from '@/components/common/ContextMenu';
import { TAB_BAR_HIDDEN_TABS_KEY, TASK_SHORTCUTS_KEY, useNavigationList, useNavigationPreference } from '@/hooks/useNavigationPreference';
import { AgentSearchPanel } from './AgentSearchPanel';
import { NewLauncherButton } from './NewLauncherButton';
import { TierPlusButton } from './ProjectHeaderMenus';
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
import { CronPill } from '@/components/sessions/CronPill';
import { tierLabelOf } from '@/components/sessions/task-meta-constants';
import { TriggerPill } from '@/components/routines/TriggerPill';
import { ImportedPill } from '@/components/tasks/ImportedPill';
import { WorkspacePill } from '@/components/workspaces/WorkspacePill';
import { TaskTagPills } from '@/components/tasks/TaskTagPills';
import { TagEditor } from '@/components/tasks/TagEditor';
import { dateTags } from '../../../../src/core/tag-model';
import { SubtaskPill } from './SubtaskPill';
import { LeaderPill } from './LeaderPill';
import { countSubtasksByParent, resolveParentRef, withSubtaskContext } from './task-tree-index';
import { ProjectSourceBadge } from './ProjectSourceBadge';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { useShowPriority } from '@/hooks/useShowPriority';
import { createProject } from '@/api/projects';
import { ProjectSourcePicker } from './ProjectSourcePicker';
import { log } from '@/utils/log';
import { visibleInterval } from '@/utils/page-visibility';
import {
  mapServerTaskSearchResults,
  taskReferenceMatchField,
} from './search-results';
import { arrangeSearchResults, taskMatchesLiterally } from './search-relevance';
import { taskMatchesDateTag } from './date-tag-search';
import '@/styles/todo-search.css';
import '@/styles/todo-empty-board.css';
import '@/styles/row-pill-fit.css';
import { useTaskSearch } from '@/hooks/useTaskSearch';
import { SessionRecapLine } from '@/components/sessions/SessionRecapTip';
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
  type DragCancelEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type CollisionDetection,
  type DroppableContainer,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  defaultAnimateLayoutChanges,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { dragBus } from '@/utils/drag-bus';
import { observeRowFit } from '@/utils/row-fit';
import { TaskKebabMenu } from './TaskKebabMenu';
import { TaskStatusBadge, formatWaitUntil } from './TaskStatusControl';
import { TaskBatchMenu } from './TaskBatchMenu';
import { type SortBy, type GroupBy } from './ViewDropdown';
import {
  RECENT_SORT_VALUES, SORT_VALUES, commonValue, groupByProject, groupOfTierMode, keepPinOrder, orderLists,
  parseTierSorts, recentOrderOfSort, sortOfRecentOrder, tierModeOfGroup, type RecentOrder, type TierViewMode,
} from './list-order';
import { FilterBar } from './FilterBar';
import { DisplayButton } from './DisplayMenu';
import type { DisplayMenuProps, FilterBarController, FilterDim, FilterState } from './filter-bar-types';
import { isDefaultStatus } from './filter-bar-model';
import { markTierUsed, readTierUsed } from './filter-bar-persist';
import { hiddenByReasons, passesChips } from './filter-predicate';
import { useHomeFilters, useArchiveFetch, useCreatedOutsideToast } from './useHomeFilters';
import { TodoFilterFooter, footerScope } from './TodoFilterFooter';
import { TodoProjectsMiniBar } from './TodoProjectsMiniBar';
import { TodoFilterEmpty, FilterOverrideReasons, isJustCreated } from './TodoFilterEmpty';
import { staleDonePinIds } from './pin-search-fold';
import { orderPinnedTier } from '@/utils/pinned-tier-order';
import { foldedId, isFoldedAt, pruneFolds, readFolds, saveFolds, toggleFold, unfold } from './place-folds';
import { ancestorHeadings, buildFolderParents, folderAncestors, folderDepth, nestFolderUnits } from './folder-tree';
import { DatePicker, formatDateDisplay, formatDateTimeDisplay, isOverdue, parseDateLocal } from '../common/DatePicker';
import { CopyableId } from '../common/CopyableId';
import { useVerticalSplitter } from '@/hooks/useVerticalSplitter';
import { useFoldAnchor } from '@/hooks/useFoldAnchor';
import { useResizableHeight } from '@/hooks/useResizableHeight';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';
import { ProjectDetailPane } from './ProjectDetailPane';
import { SortableTierCard, TierDropZone, GroupChip } from './FocusSatelliteCards';
import { useFolderContextMenu } from './FolderContextMenu';
import { PROJECT_SORT_OPTIONS, useProjectContextMenu } from './ProjectContextMenu';
import { TierProjectLabelRow } from './TierProjectLabel';
import {
  groupSortableId, parseGroupSentinelGid, isGroupSentinel, taskIdsOnly, withGroupSentinels,
  pruneOrphanSentinels, intoFolderId, isIntoFolderId, parseIntoFolderId, folderWithin,
  isTierLabelId, tierLabelId, tierLabelProject, withProjectLabels, runProjectOf, pruneTierLabels,
  slotFits, cardLanding, folderChains, withoutChainedChips, chainedParents, type SlotRules,
} from './tier-group-sentinels';
import { inferTierDropProject, resolveMoveMigration, sourceDisplayName } from './task-move-project';
import { TodoSectionTabs, TODO_SECTIONS, type TodoSection } from './TodoSectionTabs';
import { DEFAULT_HIDDEN_TABS, allViews } from './tab-bar-model';
import { FLAT_BATCH_KEY, FRESH_BATCH, LIST_BATCH, cutListBatch, isPastBatch, type ListBatchState } from './list-batch';
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

/** A tier view (Focus, Satellite, Parked or a custom tier). */
function isTierSection(s: string): boolean {
  return s === 'focus' || s === 'satellite' || s === 'wait' || s.startsWith('ct_');
}

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
   *  'all' (default) = full locate incl. tab switch. 'locate' = 'all' asked from outside
   *  the panel, which also moves the panel to the task's tier tab or to All. */
  focusScope?: 'all' | 'pinned' | 'locate' | 'created';
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
  onReorderPinned?: (newIds: string[]) => void | Promise<void>;
  onSetTier?: (taskId: string, tier: FocusTier, newPinnedOrder?: string[]) => void | Promise<void>;
  onSetDate?: (taskId: string, date: string | null) => void;
  onSetStartDate?: (taskId: string, date: string | null) => void;
  pinnedTaskIds?: Set<string>;
  focusTaskIds?: Set<string>;
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
  /** ✦ AI search card's "Open as session": continue `query` as a conversation.
   *  MainPage reopens the session the lane ran the search in, or (no such
   *  session) starts an Ask Walnut session on `message`, the search briefing.
   *  Settles when the round-trip lands. */
  onOpenSearchSession?: (
    message: string,
    query: string,
    opts: { search: boolean; progressId?: string },
  ) => Promise<void> | void;
  /** Virtual-group name registry: group_id → label. */
  taskGroups?: Record<string, string>;
  /** Group ids hidden from the Focus (pinned) area — their cards are skipped there. */
  hiddenGroups?: Set<string>;
  /** Create a virtual group from ≥2 task ids (label AI-generated if omitted). */
  onGroupTasks?: (taskIds: string[], label?: string, opts?: { moveInto?: string }) => void;
  /** Add task(s) to an existing group — used when dragging a task onto a grouped one. */
  onAddToGroup?: (groupId: string, taskIds: string[], opts?: { moveInto?: string; after?: PromiseLike<unknown> }) => void;
  /** Remove a single task from its virtual group. */
  onUngroupTask?: (taskId: string) => void;
  /** Remove several tasks from their group(s) in one call (used to dissolve a whole cluster). */
  onUngroupTasks?: (taskIds: string[]) => void;
  /** Rename a virtual group. */
  onRenameGroup?: (groupId: string, label: string) => void;
  /** Show/hide a group in the Focus (pinned) area (membership untouched). */
  onSetGroupHidden?: (groupId: string, hidden: boolean) => void;
  /** Folder metadata: group_id → owning project / parent / member count. Drives
   *  empty-folder rows (a created-but-unfilled folder must render) and the
   *  per-project scoping of folder rows. */
  folderMeta?: Record<string, { project: string; parent_id?: string; memberCount: number }>;
  /** Create an EMPTY folder under a project ('' = Inbox). */
  onCreateFolder?: (label: string, project: string, parentId?: string) => void;
  /** Delete a folder: members fall back to the project in place. */
  onDeleteFolder?: (groupId: string) => void;
  /** Move a folder to another project ('' = Inbox): subfolders + members travel
   *  with it. May resolve false (server refused, or a move for this folder is
   *  already in flight), which the panel needs to know before it registers the
   *  destination project locally. */
  onMoveFolderToProject?: (groupId: string, project: string) => void | Promise<boolean>;
  /** Nest a folder under another (null = make it top-level); the pinned tiers' chip
   *  drop uses it. Same-project only, as the server rules. */
  onSetFolderParent?: (groupId: string, parentId: string | null) => void;
  /** The attention banner mount, placed right under the toolbar (outside every scroll container). */
  banner?: ReactNode;
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

const PHASE_LABEL: Record<string, string> = {
  TODO: 'To Do',
  WAITING: 'Waiting',
  IN_PROGRESS: 'In Progress',
  NEED_ACTION: 'Need Action',
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

// One glyph for every collapse-chevron button (CSS rotation handles the expanded
// state). It lives in Icons.tsx so the pinned tier's folder chip can share it:
// FocusSatelliteCards importing this file would be an import cycle.
const CHEVRON_ICON = ICONS.CHEVRON_GLYPH;

// Shared empty set for the tierGraceUnion fast path — one identity so memos
// keyed on the result don't churn. Never mutate.
const EMPTY_ID_SET: Set<string> = new Set<string>();

/** Where a tier sits, for the drag-start scroll anchor: its box, not its heading, which can be
 *  stuck to the top and stay put while the rows above it grow. */
function anchorTop(el: Element): number {
  return (el.closest('.todo-pinned-subgroup') ?? el).getBoundingClientRect().top;
}

/** The top band of a folder chip that still reads "insert above the folder" rather
 *  than "into it" (the rest of the row, and anything below its text, is "into"). */
const FOLDER_CHIP_ABOVE_BAND = 0.3;

/** A tier's slot rules (slotFits) by its SortableContext id, which is the tier id;
 *  null for any other list (Recent). */
type SlotRulesFor = (tier: string) => SlotRules | null;

type SortableSlot = { containerId: string; index: number; items: string[] };
const sortableSlot = (data: { current?: unknown } | undefined): SortableSlot | undefined =>
  (data?.current as { sortable?: SortableSlot } | undefined)?.sortable;

/**
 * The frame dnd-kit draws when `over` is named: `over`'s list with the dragged row at its
 * slot. Same list: the row takes `over`'s index. Another tier: handlePinnedDragOver's
 * insert, right above `over` (a folder chip or line goes above the chips a folder's first
 * row sits under; a card goes exactly there, which may be inside the folder). null for
 * anything that is not a tier row (a drop zone, Recent).
 */
function slotFrame(activeId: string, over: Pick<DroppableContainer, 'id' | 'data'>, rulesFor: SlotRulesFor): { arr: string[]; at: number; tier: string; rules: SlotRules } | null {
  const target = sortableSlot(over.data);
  const rules = target ? rulesFor(target.containerId) : null;
  if (!target || !rules) return null;
  const from = target.items.indexOf(activeId);
  if (from !== -1) return { arr: arrayMove(target.items, from, target.index), at: target.index, tier: target.containerId, rules };
  const arr = [...target.items];
  let at = arr.indexOf(String(over.id));
  if (at === -1) return null;
  if (!rules.pinnedCard?.(activeId)) while (at > 0 && isGroupSentinel(arr[at - 1])) at--;
  arr.splice(at, 0, activeId);
  return { arr, at, tier: target.containerId, rules };
}

/** A card pinned on the board when the drag started (every tier shares the predicate). */
const isBoardCard = (rulesFor: SlotRulesFor | null, id: string): boolean => !!rulesFor?.('focus')?.pinnedCard?.(id);

/** Would naming `over` leave the dragged row where the tier keeps it? A board card fits
 *  anywhere its slot can file it (cardLanding); a folder, a line or a card from Recent
 *  only where the clustering keeps it (slotFits). */
function overFits(activeId: string, over: DroppableContainer, rulesFor: SlotRulesFor): boolean {
  const frame = slotFrame(activeId, over, rulesFor);
  if (!frame) return true;
  return frame.rules.pinnedCard?.(activeId)
    ? cardLanding(frame.arr, frame.at, frame.rules).fits
    : slotFits(frame.arr, frame.at, frame.rules);
}

function makePinnedCollision(rulesFor: () => SlotRulesFor | null): CollisionDetection {
  return (args) => {
    const point = args.pointerCoordinates;
    const activeId = String(args.active.id);
    const rules = rulesFor();
    const fits = (container: DroppableContainer) => !rules || overFits(activeId, container, rules);
    const hit = (container: DroppableContainer) => [{ id: container.id, data: { droppableContainer: container, value: 0 } }];
    if (point) {
      const under = document.elementFromPoint(point.x, point.y);
      if (under?.closest('.todo-unpin-zone')) return [];
      for (const container of args.droppableContainers) {
        if (!String(container.id).endsWith('-header-drop-zone')) continue;
        const rect = container.node.current?.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0 && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
          return hit(container);
        }
      }
      // A folder's row is a POINTER target, like the tier headings, read off its measured
      // rect (the layout dnd-kit sorts in; the row's SORTABLE rect, which dnd-kit
      // re-measures when a row crosses into its tier, never the `into:` twin's). Its top
      // band means "a slot above the folder"; the rest means "into it":
      //  - for a dragged FOLDER (and a card from Recent), the row's `into:` droppable,
      //    which is not a sortable item, so the list stays at rest and the row alone
      //    lights up. A folder never takes itself or one of its subfolders;
      //  - for a card on the board, the slot right under the row, the folder's first
      //    place: the gap opens there and the row lights (cardLanding), and the list
      //    never goes back to rest under a moving card (that made it flick between its
      //    own place and the slot it was pointed at).
      // A heading stuck over the rows (the section or tier one) covers them: no row
      // under it is a target.
      const activeFolder = isGroupSentinel(activeId) ? parseGroupSentinelGid(activeId) : null;
      const boardCard = isBoardCard(rules, activeId);
      const find = (id: string | undefined) => (id === undefined ? undefined : args.droppableContainers.find((c) => String(c.id) === id));
      const pointerTargets = !isSeparatorId(activeId) && !under?.closest('.navigation-heading');
      for (const container of pointerTargets ? args.droppableContainers : []) {
        const cid = String(container.id);
        if (!isIntoFolderId(cid)) continue;
        const { groupId, tier } = parseIntoFolderId(cid);
        // (A chain row's target is its deepest folder, which a dragged chain row holds.)
        if (activeFolder ? folderWithin(groupId, activeFolder, rules?.(tier)?.parentOf) : !boardCard && groupId === rules?.(tier)?.folderOf(activeId)) continue;
        // The row's sortable id: its own folder's chip, the top folder's for a chain row.
        const rowId = (container.data.current as { rowId?: string } | undefined)?.rowId ?? groupSortableId(groupId, tier);
        const rect = args.droppableRects.get(rowId) ?? container.rect.current;
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;
        if (point.x < rect.left || point.x > rect.left + rect.width || point.y < rect.top || point.y > rect.top + rect.height) continue;
        // dnd-kit puts the dragged row where the row it names was: below it when the
        // dragged row comes from above, above it otherwise (a row from another tier is
        // inserted above it). So each slot names a different row by direction.
        const chip = find(rowId);
        const slot = chip ? sortableSlot(chip.data) : undefined;
        const at = slot ? slot.items.indexOf(activeId) : -1;
        const fromAbove = !!slot && at !== -1 && at < slot.index;
        if (point.y >= rect.top + Math.max(6, rect.height * FOLDER_CHIP_ABOVE_BAND)) {
          if (!boardCard) return hit(container);
          // Under the row: the row itself from above, its next row otherwise.
          let below = fromAbove ? chip : undefined;
          for (let k = (slot?.index ?? 0) + 1; !below && slot && k < slot.items.length; k++) below = find(slot.items[k]);
          below ??= chip;
          if (below && fits(below)) return hit(below);
          break;
        }
        // Above the row: the row before it from above (the dragged row itself when it
        // already sits there: no move), the row itself otherwise.
        const above = fromAbove && slot ? find(slot.items[slot.index - 1]) : chip;
        if (above && fits(above)) return hit(above);
        break;
      }
    }
    // The closest row whose slot the drop can honour (overFits): a slot opens only
    // where the drop keeps what lands there, so the preview is the result. None nearby
    // = the dragged row stays where it is.
    const ranked = closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((container) => {
        const id = String(container.id);
        return !id.endsWith('-header-drop-zone') && !isIntoFolderId(id);
      }),
    });
    // The search stays in the project run the pointer is in (the nearest row's run):
    // a card aimed between two folders slides to the end of its own run's loose cards,
    // it never jumps into whichever other project happens to have a legal slot closer.
    const containerOf = (collision: (typeof ranked)[number]) =>
      (collision.data as { droppableContainer?: DroppableContainer } | undefined)?.droppableContainer;
    const runOf = (container: DroppableContainer): string | null => {
      const slot = sortableSlot(container.data);
      if (!slot) return null;
      for (let i = slot.index; i >= 0; i--) if (isTierLabelId(slot.items[i])) return `${slot.containerId}|${slot.items[i]}`;
      return `${slot.containerId}|`;
    };
    const nearest = ranked[0] ? containerOf(ranked[0]) : undefined;
    const nearestRun = nearest ? runOf(nearest) : null;
    for (const collision of ranked) {
      const container = containerOf(collision);
      if (!container) return [collision];
      const run = runOf(container);
      if (nearestRun !== null && run !== null && run !== nearestRun) continue;
      if (fits(container)) return [collision];
    }
    return ranked.filter((collision) => String(collision.id) === activeId);
  };
}

class TaskPointerSensor extends PointerSensor {
  static activators: typeof PointerSensor.activators = PointerSensor.activators.map(activator => ({
    ...activator,
    handler: (event, options) => event.nativeEvent.pointerType !== 'touch' && activator.handler(event, options),
  }));
}

/** Human label for a tier value: a built-in's board label (`wait` reads Parked), a
 *  custom id (`ct_*`) resolved through the registry. Same rule as MainPage.tierLabel. */
function tierDisplayLabel(tier: string, customTiers?: CustomTierDef[]): string {
  return tierLabelOf(tier, customTiers);
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
const LS_EXPANDED_PARENTS_KEY = 'walnut-todo-expanded-parents';
/** Project runs in the pinned tiers, folded per (tier, project): place-folds.ts. */
const LS_RUN_FOLDS_KEY = 'walnut-todo-tier-run-folds';
const LS_LEGACY_RUN_FOLDS_KEY = 'walnut-todo-collapsed-projs';
/** Folders, folded per (tier or LIST_PLACE, folder id). */
const LS_FOLDER_FOLDS_KEY = 'open-walnut-folder-folds';
const LS_LEGACY_FOLDER_FOLDS_KEY = 'open-walnut-collapsed-folders';
/** The Projects list's place in the folder fold record. */
const LIST_PLACE = 'list';
// LS_FILTERS_COLLAPSED_KEY removed — filters now inside ViewDropdown
const LS_SORT_KEY = 'walnut-todo-sortBy';
/** Per-project task order, `{ [project]: SortBy }`; a project absent here follows LS_SORT_KEY. */
const LS_PROJECT_SORT_KEY = 'walnut-todo-project-sort';
const LS_GROUP_KEY = 'walnut-todo-groupBy';
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

/** The Projects list remembers the projects the user OPENED; every other one, a project
 *  that appears later included, starts folded. The key is new on purpose: the one before
 *  it was converted from an older "folded ones" record whose default was open, so it
 *  marked nearly every project opened (2026-09-23, "these should always be collapsed
 *  unless I click into it"). The retired keys are dropped on read. */
const LS_LIST_OPEN_PROJS_KEY = 'walnut-todo-list-opened';
const RETIRED_LIST_FOLD_KEYS = ['walnut-todo-list-open-projs', 'walnut-todo-list-collapsed-projs'];

function readListOpen(): Set<string> {
  try {
    for (const key of RETIRED_LIST_FOLD_KEYS) if (localStorage.getItem(key) !== null) localStorage.removeItem(key);
  } catch { /* Storage off: the first-visit folds. */ }
  return readSetFromStorage(LS_LIST_OPEN_PROJS_KEY);
}

function saveListOpen(open: Set<string>): Set<string> {
  persistSet(LS_LIST_OPEN_PROJS_KEY, open);
  return open;
}

function readSection(): TodoSection {
  try {
    const v = localStorage.getItem(LS_SECTION_KEY);
    // Custom tier tabs persist by id. A stale id (tier deleted elsewhere) is
    // accepted here — the stale-tab effect in TodoPanel switches back to
    // 'focus' once the registry loads and the id isn't in it.
    if (v && ((TODO_SECTIONS as readonly string[]).includes(v) || v.startsWith('ct_'))) return v as TodoSection;
    // The retired Backlog tab: its tasks are in Parked now, so that is where the
    // view goes too.
    if (v === 'backlog') return 'wait';
  } catch { /* ignore */ }
  return 'all';
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

// Per-tier task sort (the Display menu's Sort in a tier view), keyed like the view
// modes; absent = Manual, the tier's pin order. 'walnut-todo-' prefix rides ui-prefs-sync.
const LS_TIER_SORT_KEY = 'walnut-todo-tier-sorts';

function readTierSorts(): Record<string, SortBy> {
  try { return parseTierSorts(localStorage.getItem(LS_TIER_SORT_KEY)); } catch { return {}; }
}

function persistTierSorts(sorts: Record<string, SortBy>) {
  try { localStorage.setItem(LS_TIER_SORT_KEY, JSON.stringify(sorts)); } catch { /* ignore */ }
}

// Recent's Group (Flat by default, the feed as it always was).
const LS_RECENT_GROUP_KEY = 'walnut-todo-recent-group';

function readRecentGroup(): GroupBy {
  try { return localStorage.getItem(LS_RECENT_GROUP_KEY) === 'project' ? 'project' : 'none'; } catch { return 'none'; }
}

// Recent tab sort mode — see RecentSortMode in recent-activity-time.ts (the row's
// time and the feed's sort share it). 'walnut-todo-' prefix rides ui-prefs-sync.
const LS_RECENT_SORT_KEY = 'walnut-todo-recent-sort';

function readRecentSortMode(): RecentOrder {
  try {
    const v = localStorage.getItem(LS_RECENT_SORT_KEY);
    if (v === 'updated' || v === 'created' || v === 'priority') return v;
  } catch { /* ignore */ }
  return 'updated';
}

function persistRecentSortMode(mode: RecentOrder) {
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
  /** Toggle children visibility. Takes the task id so call sites can pass ONE
   *  stable callback instead of a per-row lambda (per-row lambdas defeat the
   *  memo() wrapper and re-render every mounted row on each panel render). */
  onToggleExpand?: (taskId: string) => void;
  /** Receives the task + mouse event so callers can detect Cmd/Ctrl/Shift
   *  multi-select. Task-first for the same stable-callback reason as above. */
  onClick: (task: Task, e?: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
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
  searchContext?: string; // Project label shown at the end of a search / flat-list row
  /** Search rows only: the tier a pinned hit lives in, as a pill (search is one flat list). */
  searchTierLabel?: string;
  filterOverrideReason?: ReactNode;  // Why this task is outside current filters (focus override)
  isFadingOverride?: boolean;     // Task is fading out after focus moved away
  /** Virtual-group rendering: present when this task is part of a multi-member group. */
  groupInfo?: GroupRenderInfo;
  onRenameGroup?: (groupId: string, currentLabel: string) => void;  // Rename the whole group
  onUngroupTask?: (taskId: string) => void;                          // Remove this task from its group
  onDissolveGroup?: (groupId: string) => void;                       // Ungroup ALL members (dissolve the cluster)
  isGroupHidden?: boolean;                                           // This task's group is hidden from Focus
  onUnhideGroup?: (groupId: string) => void;                         // Restore a Focus-hidden group
  /** Folder collapse (main list): true = this row is inside a folded folder (its
   *  own, or an ANCESTOR task's), so hide it. The header row above the lead stays
   *  visible and carries the chevron. */
  folderCollapsed?: boolean;
  /** Stable toggle (takes the group id): its presence renders the chevron. */
  onToggleFolder?: (groupId: string) => void;
  /** The folder's owning project ('' = Inbox), resolved by the ONE precedence rule
   *  (folderOwnerProject) at the call site. Only read for a lead row's header. */
  folderProject?: string;
  /** Folder right-click "Move to project…" moves the whole folder, not this task. */
  onMoveFolderToProject?: (groupId: string, project: string) => void;
}

/** Per-task folder render metadata (computed in TodoPanel, consumed by SortableTaskItem). */
interface GroupRenderInfo {
  groupId: string;
  label: string;
  isLead: boolean;   // first member in sorted order — the folder header row goes here
  isLast: boolean;   // last member — the rail stops here
  count: number;     // displayed member count (shown on the header row)
  /** Folder depth (folder-tree.ts): 0 at the top of its project, 1 for a subfolder. */
  depth?: number;
  /** On the lead: ancestor folders with no row of their own above it, whose
   *  headings it draws first (root first). */
  heads?: FolderHeadInfo[];
  /** Main list only, filled per fold state: an ANCESTOR folder is folded, so this
   *  folder's own heading hides with it. */
  headerHidden?: boolean;
}

/** An ancestor heading a lead row draws above its own folder's. */
interface FolderHeadInfo {
  groupId: string;
  label: string;
  depth: number;
  /** Main list only, filled per fold state. */
  collapsed?: boolean;
  hidden?: boolean;
}

/**
 * The nesting half of a folder's render info: its depth, and on each lead row the
 * ancestor headings it has to draw (folder-tree.ts). Mutates `map` in place; a
 * no-op when no folder nests.
 */
function addFolderNesting(
  map: Map<string, GroupRenderInfo>,
  displayed: Task[],
  labels: Record<string, string> | undefined,
  parentOf: Map<string, string>,
): void {
  if (parentOf.size === 0) return;
  const heads = ancestorHeadings(displayed.map((t) => t.group_id || undefined), parentOf);
  displayed.forEach((t, i) => {
    const info = map.get(t.id);
    if (!info) return;
    info.depth = folderDepth(info.groupId, parentOf);
    const missing = heads.get(i);
    if (info.isLead && missing) {
      info.heads = missing.map((id) => ({ groupId: id, label: labels?.[id] ?? '', depth: folderDepth(id, parentOf) }));
    }
  });
}

// The pinned tiers' order (group + project clustering) lives in
// '@/utils/pinned-tier-order', shared with the phone's Swift twin.

/** Case-insensitive project identity, the registry's rule ('' = Inbox). */
function sameProjectKey(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}


/**
 * Per-tier virtual-group render metadata: taskId → { groupId, label, isLead, isLast }.
 * Mirrors the main list's groupRenderMap but scoped to a single tier's displayed
 * tasks (already clustered). A group renders its chip/box down to a SINGLE member
 * (a 1-member group is valid — it acts like a tag and stays visible until the user
 * dissolves it). For a lone member isLead and isLast both hold → chip on top +
 * rounded bottom = a complete one-card box. `displayed` must be in clustered order.
 */
function buildTierGroupMeta(displayed: Task[], labels?: Record<string, string>, parentOf?: Map<string, string>): Map<string, GroupRenderInfo> {
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
      count: counts.get(gid) ?? 0,
    });
  });
  if (parentOf) addFolderNesting(map, displayed, labels, parentOf);
  return map;
}

/**
 * ONE precedence rule for "which project owns this folder", used by every surface
 * that draws a folder row (the pinned tier's chip, the main list's header row).
 *
 * The `folderMeta` record is authoritative, but it arrives on its OWN fetch and
 * can lag, so a MEMBER task's project is the fallback (a folder's members are
 * always in its project). Both normalizations here were bugs before: an Inbox
 * member (`project: ''`) is a KNOWN answer, not a missing one, and `undefined` is
 * reserved for "nothing knows yet" so the menu can say exactly that.
 */
function folderOwnerProject(
  meta: { project: string } | undefined,
  member: Task | undefined,
): string | undefined {
  if (meta) return meta.project || '';
  return member ? (member.project || '') : undefined;
}

/**
 * What a tier chip needs to know about a folder, in ONE pass over the pinned map:
 * any member (the project fallback above) and how many PINNED members it has.
 * Two fixes encoded here: the old `[...map.values()].find(...)` copied the whole
 * map per chip, and the count is deliberately tier-local like the lead-member
 * branch's `gi.count`, because `folderMeta.memberCount` counts members this tier
 * cannot see and made the badge JUMP the moment a drag handed the chip over to
 * the sentinel.
 */
function pinnedFolderFacts(gid: string, pinned: Map<string, Task>): { member?: Task; count: number } {
  let member: Task | undefined;
  let count = 0;
  for (const t of pinned.values()) {
    if (t.group_id !== gid) continue;
    if (!member) member = t;
    count++;
  }
  return { member, count };
}

/**
 * Folder header row (main list) — names the whole folder above its lead member.
 * V2 tree look: chevron (collapse) + hollow folder icon + name + count; the
 * member rows indent under a rail. Stays visible when collapsed.
 *
 * Its OWN component rather than inline JSX in SortableTaskItem for one reason:
 * the right-click menu needs hooks, and inlining them would mount four extra
 * hooks on every one of the ~6k task rows instead of only the lead members.
 */
function FolderHeaderRow({ groupId, label, count, project, depth, folderDepth: nestDepth = 0, collapsed, hidden, onToggleCollapse, onRename, onMoveToProject, onDelete }: {
  groupId: string;
  label: string;
  count: number;
  /** Owning project ('' = Inbox) — the current value the picker ticks. */
  project: string;
  /** The lead row's SUBTASK depth (a folder member's subtask indents its header). */
  depth: number;
  /** How deep the FOLDER sits in the folder tree (0 = top of its project). */
  folderDepth?: number;
  collapsed?: boolean;
  /** An ancestor folder is folded: hidden (display:none) with its contents. */
  hidden?: boolean;
  onToggleCollapse?: (groupId: string) => void;
  onRename?: (groupId: string, currentLabel: string) => void;
  onMoveToProject?: (groupId: string, project: string) => void;
  onDelete?: (groupId: string) => void;
}) {
  const folderMenu = useFolderContextMenu({
    onRename,
    onToggleCollapse,
    onMoveToProject,
    onDelete,
  });
  return (
    <>
      <div
        className={`task-group-chip${onToggleCollapse ? ' task-group-chip-clickable' : ''}${hidden ? ' task-folder-collapsed' : ''}`}
        style={{
          ...(nestDepth > 0 ? { '--folder-depth': nestDepth } as CSSProperties : {}),
          ...(depth > 0 ? { marginLeft: `calc(${14 + depth * 22}px + var(--folder-depth, 0) * 16px)` } : {}),
        }}
        data-group-id={groupId}
        data-folder-depth={nestDepth || undefined}
        title={onToggleCollapse
          ? `Folder: click to ${collapsed ? 'expand' : 'collapse'}`
          : 'Folder — independent tasks kept together inside this project'}
        // Click ANYWHERE on the row, the name included, folds/unfolds. Only the
        // chevron and the "···" menu button stopPropagation.
        onClick={() => onToggleCollapse?.(groupId)}
        onContextMenu={(e) => folderMenu.open(e, { groupId, label, project, collapsed })}
      >
        {onToggleCollapse && (
          <button
            className={`collapse-chevron${!collapsed ? ' expanded' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(groupId); }}
            title={collapsed ? `Expand ${count} task(s)` : 'Collapse folder'}
            aria-label={collapsed ? 'Expand folder' : 'Collapse folder'}
          >
            {CHEVRON_ICON}
          </button>
        )}
        <span className="task-group-chip-icon" aria-hidden="true">
          {ICONS.ICON_FOLDER_OUTLINE}
        </span>
        <span className="task-group-chip-label">{label}</span>
        {/* ONE rule for the badge, shared with the tier chip: draw it only when
            there is something to count (a "0" badge names no members). */}
        {count > 0 && <span className="task-group-chip-count" aria-hidden="true">{count}</span>}
        {(onRename || onDelete || onMoveToProject) && (
          <button
            type="button"
            className="navigation-more task-group-chip-more"
            aria-haspopup="menu"
            aria-label={`${label} folder menu`}
            title="Folder actions"
            onClick={(e) => folderMenu.openFrom(e, { groupId, label, project, collapsed })}
          >
            ···
          </button>
        )}
      </div>
      {/* Sibling, not child — see the note in FolderContextMenu.tsx. */}
      {folderMenu.node}
    </>
  );
}

// memo: with ~6k tasks the mounted-row count is what turns every panel render
// into a main-thread block. All props are stable references (useCallback
// handlers, per-task objects reused by the useTasks identity-preserving merge),
// so shallow compare skips unchanged rows.
// The sortable half of a list row. Every useSortable consumer re-renders whenever the
// drag context changes (a drag starting, the pointer crossing a row), so this wrapper
// stays thin and hands the body only values that change for THIS row. With a thousand
// rows open, re-rendering each body on a project drag froze the drag's first frame.
const SortableTaskItem = memo(function SortableTaskItem(props: SortableTaskItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.task.id,
    data: { type: 'task' },
    animateLayoutChanges: noAnimateAfterDrag,
    // Drop off while the row is hidden by a collapsed folder. dnd-kit measures every
    // ENABLED droppable, and a display:none node's getBoundingClientRect is all zeros,
    // so a hidden row would stay in the collision candidates with its centre at the
    // viewport origin: dragging toward the top-left corner would file the task into the
    // collapsed folder. The id still stays in the SortableContext, which is what keeps
    // dnd-kit's indices from shifting. (A row hidden by a folded PROJECT is unmounted
    // here, so it never registers at all.)
    disabled: { draggable: false, droppable: !!props.folderCollapsed },
  });
  return (
    <TaskRowBody
      {...props}
      sortableRef={setNodeRef}
      sortableTransform={CSS.Transform.toString(transform)}
      sortableTransition={transition}
      isDragging={isDragging}
      dragAttributes={attributes}
      dragListeners={listeners}
    />
  );
});

interface TaskRowBodyProps extends SortableTaskItemProps {
  sortableRef: (node: HTMLElement | null) => void;
  sortableTransform: string | undefined;
  sortableTransition: string | undefined;
  isDragging: boolean;
  dragAttributes: DraggableAttributes;
  dragListeners: DraggableSyntheticListeners;
}

const TaskRowBody = memo(function TaskRowBody({ task, isFocused, isDetailOpen, isRecentlyDone, isVanishing, isNestTarget, isGroupTarget, depth = 0, childCount, isExpanded, onToggleExpand, onClick, isSelected, selectMode, onSelectToggle, onStartSelect, onSetPhase, onDelete, onSetPriority, onUpdateTitle, onOpenSession, onStartSession, onExpandDetail, onClearFocus, onPinTask, onUnpinTask, onSetTier, onSetDate, onSetStartDate, onUnparent, onMoveUp, onMoveToProject, isPinned, pinnedTier, searchContext, searchTierLabel, filterOverrideReason, isFadingOverride, groupInfo, onRenameGroup, onUngroupTask, onDissolveGroup, isGroupHidden, onUnhideGroup, folderCollapsed, onToggleFolder, folderProject, onMoveFolderToProject, sortableRef, sortableTransform, sortableTransition, isDragging, dragAttributes: attributes, dragListeners: listeners }: TaskRowBodyProps) {
  // Live circle: error red / waiting red-pulse / running green-pulse.
  const circleClass = useTaskCircle(task);
  const setNodeRef = sortableRef;

  const style: CSSProperties = {
    transform: sortableTransform,
    transition: sortableTransition,
    opacity: isDragging ? 0 : undefined,
    // Subtasks indent: 22px = phase-icon(18px) + gap(4px), aligns with parent's first letter
    ...(depth > 0 ? { marginLeft: `${depth * 22}px` } : {}),
    // A subfolder's members step in under its heading (CSS reads --folder-depth).
    ...(groupInfo?.depth ? { '--folder-depth': groupInfo.depth } as CSSProperties : {}),
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
    // NOT gated on groupInfo: a member's SUBTASK has no group_id of its own, and
    // it must hide with the folder that holds its parent (see isRowFolderCollapsed).
    folderCollapsed ? 'task-folder-collapsed' : '',
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
      onClick(task, e);
      return;
    }
    // First click on an unfocused task → focus it (open detail panel).
    // Only enter editing mode when task is already focused.
    if (!isFocused) {
      onClick(task);
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
    {/* Ancestor folders with no row of their own above this one: their headings
        first, so a subfolder never sits indented under a name that is not there. */}
    {groupInfo?.isLead && groupInfo.heads?.map((head) => (
      <FolderHeaderRow
        key={head.groupId}
        groupId={head.groupId}
        label={head.label}
        count={0}
        project={folderProject ?? (task.project || '')}
        depth={depth}
        folderDepth={head.depth}
        collapsed={head.collapsed}
        hidden={head.hidden}
        onToggleCollapse={onToggleFolder}
        onRename={onRenameGroup}
        onMoveToProject={onMoveFolderToProject}
        onDelete={onDissolveGroup}
      />
    ))}
    {/* Folder header row — only above the lead member; names the whole folder. */}
    {groupInfo?.isLead && (
      <FolderHeaderRow
        groupId={groupInfo.groupId}
        label={groupInfo.label}
        count={groupInfo.count}
        // folderProject is the resolved owner (folderMeta first); the lead task's
        // own project is the fallback for surfaces that don't pass it.
        project={folderProject ?? (task.project || '')}
        depth={depth}
        folderDepth={groupInfo.depth}
        hidden={groupInfo.headerHidden}
        collapsed={folderCollapsed}
        onToggleCollapse={onToggleFolder}
        onRename={onRenameGroup}
        onMoveToProject={onMoveFolderToProject}
        onDelete={onDissolveGroup}
      />
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
        onClick(task, e);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter' && !isEditing) onClick(task); }}
      {...activeAttributes}
      {...activeListeners}
    >
      {/* Highlight layer (A1 gutter): state backgrounds paint on this inset pill
          (starts 14px in), NOT on the row itself — content-visibility's paint
          containment clips anything outside the row's padding box, so the unread
          dot must stay INSIDE the row while the highlight starts after it. */}
      <span className="todo-row-pill" aria-hidden="true" />
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
          {isSelected ? ICONS.ICON_CHECK : null}
        </button>
      )}

      {/* Chevron — absolutely positioned in left padding area (only for parent tasks) */}
      {(childCount ?? 0) > 0 && (
        <button
          className={`collapse-chevron${isExpanded ? ' expanded' : ''}`}
          title={isExpanded ? 'Collapse child tasks' : `Expand ${childCount} child task(s)`}
          onClick={(e) => { e.stopPropagation(); onToggleExpand?.(task.id); }}
        >
          {CHEVRON_ICON}
        </button>
      )}

      {/* — content area: single-line [attention] [phase] [title] [badges] [⋮] — */}
      <div className="todo-item-content">
        <div className="todo-item-title-row">
          {/* Unread dot — leftmost, keeps everything on one line. Clears when the
              user opens the task (MainPage.handleFocusTask marks it read). */}
          {!isDone && (task.unread ? (
            <span className="task-unread-dot" role="img" aria-label="Unread: agent output you haven't seen" title="Unread: click to open and mark read" />
          ) : needsAction && (
            <span className="task-unread-dot task-attention-dot" role="img" aria-label="Needs your action" title="Needs your action" />
          ))}
          {/* Phase icon — one click toggles To Do ↔ Complete (an hourglass while Waiting) */}
          <button
            className={`task-phase-icon-btn ${circleClass}`}
            onClick={(e) => {
              e.stopPropagation();
              onSetPhase(task.id, isDone ? 'TODO' : 'COMPLETE');
            }}
            aria-label={isDone ? 'Reopen (mark To Do)' : 'Mark complete'}
            title={isDone ? 'Done: click to reopen' : task.phase === 'WAITING' ? 'Waiting: click to complete' : 'Click to complete'}
          >
            {ICONS.binaryPhaseIcon(isDone, task.phase)}
          </button>
          <span
            ref={titleRef}
            className={`todo-item-title${isEditing ? ' editing' : ''}${task.walnut_agent ? ' walnut-task-title' : ''}`}
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
          <CronPill sessionId={resolveTaskSessionId(task)} />
          <TriggerPill taskId={task.id} />
          <ImportedPill task={task} />
          <WorkspacePill task={task} />
          <TaskTagPills task={task} />
          <SubtaskPill task={task} />
          <LeaderPill task={task} />
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
          {task.phase === 'WAITING' && task.wait_until && (
            <span
              className="todo-item-due-pill todo-item-wait-pill"
              data-testid="task-row-wait-until"
              title={`Waiting until ${new Date(task.wait_until).toLocaleString()}, or until something happens first`}
            >
              until {formatWaitUntil(task.wait_until)}
            </span>
          )}
          {!!task.is_blocked && !isDone && (
            <span className="task-blocked-badge" title="Blocked by dependencies">
              blocked
            </span>
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
            onSetPhase={onSetPhase}
          />
        </div>
        {/* Where a search / flat-list hit lives, on its own line so the title keeps the row */}
        {(searchContext || (searchTierLabel && pinnedTier)) && (
          <div className="todo-search-meta-row">
            {searchTierLabel && pinnedTier && (
              <span className={`todo-search-tier-pill todo-search-tier-${isBuiltinTier(pinnedTier) ? pinnedTier : 'custom'}`} title={`Pinned in ${searchTierLabel}`}>
                {searchTierLabel}
              </span>
            )}
            {searchContext && (
              <span className="todo-search-context-pill" title={searchContext}>
                {searchContext}
              </span>
            )}
          </div>
        )}
        {/* Why the task is outside the current filters (focus override, spec 5.12). */}
        {filterOverrideReason}
      </div>
    </div>
    </>
  );
});

// ── Static task item for DragOverlay ──

function TaskItemOverlay({ task }: { task: Task }) {
  const showPriority = useShowPriority();
  return (
    <div className="todo-panel-item drag-overlay-item">
      <div className="todo-item-content">
        <span className={`todo-item-title${task.walnut_agent ? ' walnut-task-title' : ''}`}>{task.title}</span>
      </div>
      {showPriority && (
        <span className={`badge badge-${task.priority}`}>{task.priority === 'immediate' ? '!!' : task.priority === 'important' ? '!' : task.priority === 'backlog' ? '~' : '--'}</span>
      )}
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

// ── Project header row (main list) — names one project group, folds it, and
// carries the project actions ──
//
// Its OWN component rather than inline JSX in the grouped list for the reason
// FolderHeaderRow is: the right-click menu needs hooks, and the menu node has to
// be a SIBLING of the row (see ProjectContextMenu.tsx) — one hook instance per
// rendered header is the only shape that gives both without duplicating the node.
//
// The row body folds the project, exactly like a folder row. Everything else on
// the row stops its own click, and that IS the mechanism (no target sniffing):
// the NAME opens the detail pane, the chevron folds, the star favorites, and the
// "+"/kebab open their menus.
function ProjectHeaderRow({
  project, taskCount, collapsed, source, droppableDisabled, dragHandleProps,
  isFavorite, onToggleFavorite, onToggleCollapse, onViewDetails, onAddTask, onAddFolder, onAddSession,
  onMoveUp, onMoveDown, sort, onSetSort, onFilterToProject,
}: {
  /** '' = Inbox. */
  project: string;
  taskCount: number;
  /** "Filter to this project" (spec 6.8). */
  onFilterToProject?: (project: string) => void;
  /** How this project's tasks are ordered, and the menu rows that change it. */
  sort?: SortBy;
  onSetSort?: (project: string, sort: SortBy) => void;
  collapsed: boolean;
  /** Provider that claims this project ('ms-todo', …), for the badge. */
  source?: string;
  /** No task drag in flight — the header is only a drop target during one. */
  droppableDisabled: boolean;
  /** dnd-kit activator for PROJECT reordering (SortableGroupItem). */
  dragHandleProps: Record<string, unknown>;
  isFavorite?: boolean;
  onToggleFavorite?: (project: string) => void;
  onToggleCollapse: (project: string) => void;
  onViewDetails: (project: string) => void;
  onAddTask: (project: string) => void;
  onAddFolder?: (project: string) => void;
  onAddSession?: (project: string) => void;
  /** Trade slots with the neighbouring project in the shared project order. */
  onMoveUp?: (project: string) => void;
  onMoveDown?: (project: string) => void;
}) {
  const projectMenu = useProjectContextMenu({
    onToggleCollapse,
    onNewTask: onAddTask,
    onNewFolder: onAddFolder,
    onNewSession: onAddSession,
    onToggleFavorite,
    onViewDetails,
    onMoveUp,
    onMoveDown,
    onSetSort,
    onFilterToProject,
  });
  return (
    <>
      <DroppableHeader id={`hdr-proj:${project}`} project={project} disabled={droppableDisabled}>
        {({ isOver: isHeaderOver, setNodeRef: setHeaderRef }) => (
          <div
            ref={setHeaderRef}
            className={`todo-group-project-header${isHeaderOver ? ' header-drop-active' : ''}`}
            {...dragHandleProps}
            title={`Project: click to ${collapsed ? 'expand' : 'collapse'}`}
            // dnd-kit swallows the click once its 5px activation fired, so a real
            // project drag can never also fold the group.
            onClick={() => onToggleCollapse(project)}
            onContextMenu={(e) => projectMenu.open(e, { project, collapsed, favorite: isFavorite, sort })}
          >
            <div className="todo-group-header-controls">
              {/* pointerdown too, not just click: the row carries dragHandleProps and
                  the mouse sensor arms at 5px, so a slip on this 13px glyph starts a
                  project reorder and dnd-kit then swallows the click: the user asked
                  to fold and got a reorder instead. The ··· below guards the same way. */}
              <button className={`collapse-chevron${!collapsed ? ' expanded' : ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onToggleCollapse(project); }} title="Collapse/Expand">
                {CHEVRON_ICON}
              </button>
              {/* The name FOLDS the project, like every other pixel of this row —
                  one row, one meaning. Details moved to the ··· / right-click menu:
                  a name that navigated away was the surprise, since the row around
                  it folded and nothing said which half did what.
                  stopPropagation anyway: the row's own onClick would toggle a second
                  time on the same click and cancel this one out. */}
              <button
                className="todo-group-name-btn"
                onClick={(e) => { e.stopPropagation(); onToggleCollapse(project); }}
                title={`${project || 'Inbox'}: click to ${collapsed ? 'expand' : 'collapse'}`}
              >
                {/* SOLID icon + kind-tag = project (folders inside use the hollow icon + indent). */}
                <span className="todo-group-project-icon">{ICONS.ICON_FOLDER_SOLID}</span>
                <span className="todo-group-project-name">{project || 'Inbox'}</span>
              </button>
              {/* Tag / badge / count sit on the ROW, not inside the name button, and
                  that placement is the feature: the button is the "open the project
                  pane" target and must stay exactly as wide as the name, while these
                  three (plus the slack after them) are the strip you click to FOLD.
                  Capping the button's width instead was tried first and ellipsised
                  names that fit ("Backend" → "Back…"). PLACEMENT matches the tier's
                  project label (the same three are plain row spans there); the
                  SPACING deliberately does not, this row's 2px gap is tighter than
                  the tier's 5px because the gap also spaces the chevron and name. */}
              <span className="project-kind-tag">project</span>
              <ProjectSourceBadge source={source} />
              <span className="todo-group-count text-xs text-muted">{taskCount}</span>
            </div>
            {onToggleFavorite && project && (
              <button
                className="todo-group-fav-btn"
                // See the chevron above: a 5px slip on the star would arm the row's
                // drag and the click that was meant to favorite gets eaten.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onToggleFavorite(project); }}
                title={isFavorite ? 'Unfavorite project' : 'Favorite project'}
              >
                {isFavorite ? '★' : '☆'}
              </button>
            )}
            {/* ONE control, not a "+" and a "⋮": both drew from the same verb list,
                so two glyphs on a dense row only asked the user to guess which half
                held the item they wanted. Same menu a right-click opens.
                The popup portals to <body>, but React events still bubble through the
                component TREE, so a click on the menu's own chrome (the 4px list
                padding, the 8px divider band) would land on the row's fold —
                stopPropagation here, where the menu is a child. The tier's project
                label guards the same way. */}
            <span className="todo-group-header-actions" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="navigation-more"
                aria-label={`${project || 'Inbox'} menu`}
                aria-haspopup="menu"
                // See the chevron above: the row is a dnd-kit activator, so a 5px
                // slip on this glyph would arm a project reorder and eat the click.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => projectMenu.open(e, { project, collapsed, favorite: isFavorite, sort })}
              >
                ···
              </button>
            </span>
          </div>
        )}
      </DroppableHeader>
      {/* Sibling, not child — see the note in ProjectContextMenu.tsx. */}
      {projectMenu.node}
    </>
  );
}

/** Draws the next batch of a long list (list-batch.ts). */
function ShowMoreRow({ batchKey, hidden, onShowMore }: {
  batchKey: string;
  hidden: number;
  onShowMore: (key: string) => void;
}) {
  return (
    <button
      type="button"
      className="todo-list-show-more"
      title={`${hidden} more ${hidden === 1 ? 'task' : 'tasks'}`}
      onClick={() => onShowMore(batchKey)}
    >
      Show more
    </button>
  );
}

// ── Empty folder row — a created-but-unfilled folder inside a project bucket ──
// Renders where the folder's members will live and is a drop target: dragging a
// same-project task onto it files the task (the folder's first member). Its "···"
// menu matches the member-backed chip so the affordances stay uniform.
export const EMPTY_FOLDER_DROP_PREFIX = 'folder-empty:';

function EmptyFolderRow({ groupId, label, project, onRename, onDelete, onMoveToProject }: {
  groupId: string;
  label: string;
  project: string;
  onRename?: (groupId: string, currentLabel: string) => void;
  onDelete?: (groupId: string) => void;
  onMoveToProject?: (groupId: string, project: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `${EMPTY_FOLDER_DROP_PREFIX}${groupId}`,
    data: { type: 'empty-folder', groupId, project },
  });
  // No Collapse/Expand row here: an empty folder has nothing to fold away.
  const folderMenu = useFolderContextMenu({ onRename, onMoveToProject, onDelete });
  return (
    <>
    <div
      ref={setNodeRef}
      className={`task-group-chip task-group-chip-empty${isOver ? ' task-group-chip-drop' : ''}`}
      data-group-id={groupId}
      title="Empty folder: drag a task here to file it"
      onContextMenu={(e) => folderMenu.open(e, { groupId, label, project })}
    >
      <span className="task-group-chip-icon" aria-hidden="true">
        {ICONS.ICON_FOLDER_OUTLINE}
      </span>
      <span className="task-group-chip-label">{label}</span>
      <span className="task-group-chip-empty-hint" aria-hidden="true">empty: drag a task here</span>
      {(onRename || onDelete || onMoveToProject) && (
        <button
          type="button"
          className="navigation-more task-group-chip-more"
          aria-haspopup="menu"
          aria-label={`${label} folder menu`}
          title="Folder actions"
          onClick={(e) => folderMenu.openFrom(e, { groupId, label, project })}
        >
          ···
        </button>
      )}
    </div>
    {/* Sibling, not child — see the note in FolderContextMenu.tsx. */}
    {folderMenu.node}
    </>
  );
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
    if (isSortBy(v)) return v;
  } catch { /* ignore */ }
  // Newest activity first unless the user picked otherwise (the user's call, 2026-09-23).
  return 'updated';
}

function persistSortBy(v: SortBy) {
  try { localStorage.setItem(LS_SORT_KEY, v); } catch { /* ignore */ }
}

function isSortBy(v: unknown): v is SortBy {
  return v === 'manual' || v === 'priority' || v === 'date' || v === 'updated';
}

function readProjectSorts(): Record<string, SortBy> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LS_PROJECT_SORT_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => isSortBy(v))) as Record<string, SortBy>;
  } catch { return {}; }
}

function persistProjectSorts(v: Record<string, SortBy>) {
  try { localStorage.setItem(LS_PROJECT_SORT_KEY, JSON.stringify(v)); } catch { /* ignore */ }
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

function priorityRank(t: Task): number {
  return PRIORITY_RANK[effectivePriority(t.priority)] ?? 3;
}

/** The order each non-Manual sort draws a list in: the Projects list and the tiers alike. */
const TASK_COMPARATORS: Record<Exclude<SortBy, 'manual'>, (a: Task, b: Task) => number> = {
  priority: comparePriority, date: compareDate, updated: compareUpdated,
};

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

    // Tasks can collide with all tasks (cross-group), header drop zones, and
    // empty-folder rows (dropping files the task as the folder's first member).
    if (activeType === 'task') {
      return cType === 'task' || cType === 'header-drop' || cType === 'empty-folder';
    }

    // Project group drags: same-type only. Project groups are GLOBALLY sortable
    // now (flat ordering) — there is no parent-scope constraint left.
    return cType === activeType;
  });

  if (filtered.length === 0) return [];
  // A project header can be stuck to the top of the list, and dnd-kit moves the boxes it took
  // at the drag's start with the scroll, so a stuck header's box drifts down over the rows it
  // covers. Like the tier headings (pinnedCollision), a header takes a drop only where it is
  // now, under the pointer.
  const point = args.pointerCoordinates;
  if (activeType === 'task' && point) {
    const isHeader = (container: (typeof filtered)[number]) => (container.data?.current as { type?: string })?.type === 'header-drop';
    for (const container of filtered) {
      if (!isHeader(container)) continue;
      const rect = container.node.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0 && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
        return [{ id: container.id, data: { droppableContainer: container, value: 0 } }];
      }
    }
    const rows = filtered.filter(container => !isHeader(container));
    return rows.length ? closestCenter({ ...args, droppableContainers: rows }) : [];
  }
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

// ── Modifier: the pinned tiers' ghost rides BESIDE the pointer, not under it ──
// A full-width card ghost under the pointer hides the very row the drop goes to,
// and the folder chip's "into" highlight is the whole point of aiming at it. The
// compact ghost (.todo-pinned-card-dragging) sits just right of and below the
// pointer, so the row under the pointer stays readable. Overlay-only: the
// collision rect still follows the dragged node.
const ghostBesideCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform;
  const event = activatorEvent as PointerEvent;
  if (typeof event.clientX !== 'number') return transform;
  const offsetX = event.clientX - draggingNodeRect.left + 14;
  const offsetY = event.clientY - draggingNodeRect.top + 10;
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
  const showPriority = useShowPriority();
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
  // Dates write through the shared task store when it has this row, so the
  // board row's due pill moves in the same frame; the direct REST call is the
  // fallback for the pop-out window, which mounts no store.
  const store = useTasksContextSafe();
  const handleDateChange = async (date: string | null) => {
    if (store?.tasks.some((t) => t.id === task.id)) { store.update(task.id, { due_date: date ?? '' }); return; }
    await apiUpdateTask(task.id, { due_date: date ?? '' });
  };

  const handleStartDateChange = async (date: string | null) => {
    if (store?.tasks.some((t) => t.id === task.id)) { store.update(task.id, { start_date: date ?? '' }); return; }
    await apiUpdateTask(task.id, { start_date: date ?? '' });
  };

  // Tags edit in place, the same way: through the store when it has the row.
  const handleTags = (change: { add_tags?: string[]; remove_tags?: string[] }) => {
    if (store?.tasks.some((t) => t.id === task.id)) { store.update(task.id, change); return; }
    void apiUpdateTask(task.id, change).catch(() => { /* the row keeps its tags; the pane re-reads on the next event */ });
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
          <TaskStatusBadge task={task} />
          {showPriority && task.priority && task.priority !== 'none' && (
            <span className={`todo-detail-priority-pill priority-${task.priority}`}>
              {PRIORITY_ICON[task.priority]} {PRIORITY_LABEL[task.priority]}
            </span>
          )}
          <PluginFieldPills task={task} />
          <TagEditor
            tags={task.tags ?? []}
            derived={dateTags(task)}
            placeholder="+ Tag"
            onAdd={(tag) => handleTags({ add_tags: [tag] })}
            onRemove={(tag) => handleTags({ remove_tags: [tag] })}
          />
        </div>
        <div className="todo-detail-dates text-xs text-muted">
          {/* The id is a reference, so it rides the metadata line rather than
              the title: an agent or a log line names a task by id, and without
              this there was no way to tell which card that is. */}
          <CopyableId id={task.id} label="ID" />
          {task.created_at && <span> · Created {timeAgo(task.created_at)}</span>}
          {task.updated_at && <span> · Updated {timeAgo(task.updated_at)}</span>}
          {task.start_date && (
            <span> · Starts {formatDateTimeDisplay(task.start_date)}</span>
          )}
          {task.due_date && (
            <span style={isOverdue(task.due_date) ? { color: 'var(--error)' } : undefined}>
              {' '}· Due {formatDateTimeDisplay(task.due_date)}
            </span>
          )}
          {task.phase === 'WAITING' && task.wait_until && (
            <span data-testid="task-detail-wait-until"> · Waiting until {formatWaitUntil(task.wait_until)}</span>
          )}
          {/* Plugin facts (walnut.ui.slot 'task.meta'), e.g. the time this task took:
              one short value on this line, never a block of its own. */}
          <PluginSlots
            target="task.meta"
            props={{ taskId: task.id }}
            onNavigate={onClose}
            wrap={(entry, node) => (
              <PluginSlotFact entry={entry} className="todo-detail-meta-fact" labelClassName="todo-detail-meta-fact-label" separator=" · ">
                {node}
              </PluginSlotFact>
            )}
          />
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
                  : parentTask.phase === 'NEED_ACTION' ? 'var(--error)'
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
                    {/* Recap line — one line "what just happened" (self-report), read
                        through the same store as the session column's tip; hidden
                        while running (live activity above covers that state). */}
                    {processStatus !== 'running' && (
                      <SessionRecapLine
                        sessionId={sid}
                        session={record}
                        className="text-xs truncate"
                        style={{ color: 'var(--fg-muted)', marginTop: '2px' }}
                      />
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
                      : child.phase === 'NEED_ACTION' ? 'var(--error)'
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

// ── TierNavigationGroup — ONE pinned tier (built-in or custom) as a navigation
// section. This is the single definition: the four built-ins used to be four
// hand-copied JSX blocks and the customs a near-identical component, so every
// affordance had to be added five times (and drifted: Satellite alone skipped its
// drop zone in the stacked view).
//
// The header is a NavigationHeading, so the row IS the reorder handle, the chevron
// IS the collapse control, and every tier verb lives in its ··· / right-click menu.
// No grip, no icon, no count, and no per-tier resize handle: the All view is one
// scroller now, so a per-tier maxHeight would carve a second scrollbar out of it.
function TierNavigationGroup({ def, isAll, headless, folded, collapsed, onToggle, visibleIds, children, isEmpty, onAdd, onAddSession, onAddTask, onAddSeparator, dropProps, addOpenSignal, onAddSignalConsumed, viewMode, onChangeViewMode, sortBy, onChangeSort }: {
  /** `id` + `label` of the tier — the four built-ins pass a synthetic def. */
  def: CustomTierDef;
  /** In a stacked view (All or Pinned): the tier draws its heading and takes header drops. */
  isAll: boolean;
  /** 5.10: the only tier with tasks on a board that never picked a tier: no heading. */
  headless?: boolean;
  /** Chevron-folded in the stacked view (content hidden). */
  folded: boolean;
  /** Raw collapsed-set membership (chevron direction). */
  collapsed: boolean;
  onToggle: (id: string) => void;
  /** Sortable ids for this tier's SortableContext (mirrors visibleFocusIds etc.). */
  visibleIds: string[];
  children: ReactNode;
  isEmpty: boolean;
  onAdd: (title: string) => Promise<unknown> | void;
  /** Menu "New task with session" → a draft session pinned to this tier. */
  onAddSession?: (tier: string) => void;
  /** Menu "New task" → open this tier's inline add row. */
  onAddTask?: (tier: string) => void;
  /** Menu → drop a divider line at the top of this tier. */
  onAddSeparator?: (tier: string) => void;
  /** Native-drag handlers so a dragged separator can land in this tier. */
  dropProps?: { onDragOver: (e: ReactDragEvent<HTMLDivElement>) => void; onDrop: (e: ReactDragEvent<HTMLDivElement>) => void };
  addOpenSignal?: number;
  onAddSignalConsumed?: () => void;
  /** Per-tier view mode, offered as two menu rows (the solo tab keeps its bar). */
  viewMode?: TierViewMode;
  onChangeViewMode?: (tier: string, mode: TierViewMode) => void;
  /** The tier's own sort, offered as pick-one rows like the Projects heading's. */
  sortBy?: SortBy;
  onChangeSort?: (tier: string, sort: SortBy) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${def.id}-header-drop-zone`, disabled: !isAll });
  const actions: ContextMenuItem[] = [
    {
      key: 'new-task',
      label: 'New task',
      when: !!onAddTask,
      // Unfold FIRST: the inline add row lives inside the folded subtree, so the
      // signal would land on an unmounted InlineAdd and the click would do nothing.
      onSelect: () => { if (folded) onToggle(def.id); onAddTask?.(def.id); },
    },
    { key: 'new-session', label: 'New task with session', when: !!onAddSession, onSelect: () => onAddSession?.(def.id) },
    { key: 'new-separator', label: 'Add separator', when: !!onAddSeparator, onSelect: () => onAddSeparator?.(def.id) },
    { divider: true },
    { key: 'collapse', label: folded ? `Expand ${def.label}` : `Collapse ${def.label}`, onSelect: () => onToggle(def.id) },
    { divider: true },
    // The tier's Group and Sort, the same pick-one groups the Projects heading has (and
    // what the Display menu sets in this tier's own view).
    { key: 'organize', label: 'Organize', section: true, when: !!onChangeViewMode },
    { key: 'mode-project', label: 'By project', when: !!onChangeViewMode, checked: viewMode === 'project', onSelect: () => onChangeViewMode?.(def.id, 'project') },
    { key: 'mode-custom', label: 'In one list', when: !!onChangeViewMode, checked: viewMode === 'custom', onSelect: () => onChangeViewMode?.(def.id, 'custom') },
    { key: 'sort', label: 'Sort by', section: true, when: !!onChangeSort },
    ...PROJECT_SORT_OPTIONS.map(([value, label]) => ({
      key: `sort-${value}`, label, when: !!onChangeSort, checked: sortBy === value, onSelect: () => onChangeSort?.(def.id, value),
    })),
  ];
  return (
    <div className="todo-pinned-subgroup">
      {isAll && !headless && (
        <div ref={setNodeRef} className={`todo-pinned-subgroup-heading${isOver ? ' navigation-drop-target' : ''}`}>
        <NavigationHeading
          id={def.id}
          label={def.label}
          className="todo-pinned-sublabel"
          icon={<span className={`todo-tier-icon-${isBuiltinTier(def.id) ? def.id : 'custom'}`}>{ICONS.tierIcon(def.id)}</span>}
          collapsed={collapsed}
          onClick={() => onToggle(def.id)}
          actions={actions}
        />
        </div>
      )}
      {!folded && (
        <SortableContext id={def.id} items={visibleIds} strategy={verticalListSortingStrategy}>
          {/* `todo-pinned-list` rides on TierDropZone, as it did for three of the
              four built-ins — Satellite's copy was the odd one out. */}
          <div className="todo-pinned-list-scroll" {...dropProps}>
            <TierDropZone id={`${def.id}-drop-zone`} isEmpty={isEmpty}>
              {children}
            </TierDropZone>
            <InlineAdd label={headless ? 'Add a pinned task…' : `Add to ${def.label}…`} onAdd={onAdd} openSignal={addOpenSignal} onOpenSignalConsumed={onAddSignalConsumed} />
          </div>
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

// ── NewProjectRow: the project name entry at the very bottom of the grouped list.
// Opened from the Projects heading's "New project..." menu item and mounted only
// while it is open (a permanent dashed "New Project" button used to be the one
// visible control on an empty board, which read as "make a project first").
// Visually separated from task rows (hairline + dashed outline, folder icon):
// this creates a CONTAINER, not a task. On create the caller re-renders the
// group list; the row itself never moves (it's static DOM below the groups), so
// no scroll compensation is needed here: the new empty group appears above it.
// Esc, a blur with no name, and a successful create all end it via `onClose`. ──
function NewProjectRow({ onCreated, onError, onClose }: { onCreated: (name: string) => void; onError?: (msg: string) => void; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [source, setSource] = useState('local');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mounted = asked for (the menu item), so the caret goes straight into the name.
  // focus() also scrolls the row into view at the bottom of a long list.
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async () => {
    const name = value.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = await createProject(name, source === 'local' ? undefined : source);
      onClose();
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

  return (
    <div className="todo-new-project-wrap">
      <div className="todo-new-project-input-row">
        <span className="todo-new-project-icon">{ICONS.ICON_FOLDER}</span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={busy}
          aria-label="New project name"
          placeholder="Project name (Enter to create)"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') { e.preventDefault(); void submit(); }
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
          onBlur={() => { if (!value.trim()) onClose(); }}
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
  /** The feed's sort mode: the row shows the same clock the feed ranks by. */
  timeMode: RecentSortMode;
}

// ── SortableRecentCard — draggable recent-activity card with kebab menu ──

function SortableRecentCard({ task, isFocused, isVanishing, isSessionOpen, isDetailOpen, onClick, onPinTask, onUnpinTask, isPinned, pinnedTier, pinnedTierLabel, onSetPriority, onSetDate, onSetStartDate, onSetTier, onExpandDetail, onClearFocus, onOpenSession, onStartSession, onSetPhase, onUpdateTitle, onDelete, onMoveToProject, timeMode }: RecentCardProps) {
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

  // Rename is DOUBLE-click only (2026-08-31, matches SortableTierCard): a single
  // click opens the card; click-to-edit popped the outlined editor over the
  // title on every open, which read as a glitch.
  const handleTitleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!onUpdateTitle) return;
    clickPosRef.current = { x: e.clientX, y: e.clientY };
    setIsEditing(true);
  }, [onUpdateTitle]);

  const isDone = task.status === 'done' || task.phase === 'COMPLETE';
  // Two red affordances (2026-08-14): the row TINT follows the phase — a task at
  // NEED_ACTION stays red until the human acts (opening it
  // is not acting). The DOT follows the stored unread marker and clears on open.
  const needsAction = taskNeedsAction(task);
  const unread = !isDone && Boolean(task.unread);
  // The row shows the clock the feed sorts by (latest of update / session /
  // completion; creation in 'created' mode) — see recentActivityTime.
  const activity = recentActivityTime(task, timeMode);
  const ago = timeAgo(activity.at);

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
      // A+B drag: whole card activates (5px distance keeps click-to-open);
      // gutter grip is a hover hint. Spread FIRST so role/Enter below win.
      {...(isStatic || isEditing ? {} : { ...attributes, ...listeners })}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && !isEditing) { e.preventDefault(); onClick?.(task); } }}
    >
      {/* No drag grip: the WHOLE card is the drag handle (the listeners above), so a
          decorative gutter glyph only claimed width and suggested a second target
          that never existed. Pinned cards still show their tier dot below \u2014
          "already placed" at a glance. */}
      {isPinned && pinnedTier && (
        <span
          className={`todo-recent-tier-dot todo-tier-icon-${isBuiltinTier(pinnedTier) ? pinnedTier : 'custom'}`}
          title={`Pinned \u2014 ${pinnedTierLabel ?? (pinnedTier === 'focus' ? 'Focus' : pinnedTier === 'wait' ? 'Parked' : 'Satellite')}`}
        >
          {ICONS.tierIcon(pinnedTier)}
        </span>
      )}
      {/* Unread dot — the tinted background alone was too subtle on a dense
          pinned strip, and the user asked for the dot on these cards too. */}
      {unread ? (
        <span className="task-unread-dot" role="img" aria-label="Unread: agent output you haven't seen" title="Unread: click to open and mark read" />
      ) : needsAction && !isDone && (
        <span className="task-unread-dot task-attention-dot" role="img" aria-label="Needs your action" title="Needs your action" />
      )}
      {/* Phase icon — one click toggles To Do ↔ Complete */}
      <button
        className={`task-phase-icon-btn pinned-phase-picker ${circleClass}`}
        onClick={(e) => {
          e.stopPropagation();
          onSetPhase?.(task.id, isDone ? 'TODO' : 'COMPLETE');
        }}
        aria-label={isDone ? 'Reopen (mark To Do)' : 'Mark complete'}
        title={isDone ? 'Done: click to reopen' : task.phase === 'WAITING' ? 'Waiting: click to complete' : 'Click to complete'}
      >
        {ICONS.binaryPhaseIcon(isDone, task.phase)}
      </button>
      {/* Editable title */}
      <span
        ref={titleRef}
        className={`todo-pinned-title${isEditing ? ' editing' : ''}${task.walnut_agent ? ' walnut-task-title' : ''}`}
        contentEditable={isEditing}
        suppressContentEditableWarning
        title={task.title}
        onClick={isEditing ? (e) => e.stopPropagation() : undefined}
        onDoubleClick={isEditing ? undefined : handleTitleDoubleClick}
        onBlur={isEditing ? commitEdit : undefined}
        onKeyDown={isEditing ? (e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        } : undefined}
      >
        {task.title}
      </span>
      <SubtaskPill task={task} />
      <LeaderPill task={task} />
      {ago && <span className="todo-recent-ago" title={recentActivityTitle(activity)}>{ago}</span>}
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
        onSetPhase={onSetPhase}
      />
    </div>
  );
}

// ── TodoPanel ──

export const TodoPanel = memo(function TodoPanel({ tasks: rawTasks, loading, onComplete, onSetPhase, onCreate, onUpdate, onDelete, onBatchSetPhase, onBatchDelete, onSetPriority, onFocusTask, onClearFocus, focusedTaskId, focusNonce, focusScope, favorites, ordering, onReorder, onMoveTask, onReparentTask, onBakeOrder, onOpenSession, onStartSession, onOpenTriageForTask, onPinTask, onUnpinTask, onReorderPinned, onSetTier: onSetTierProp, onSetDate, onSetStartDate, pinnedTaskIds, focusTaskIds, waitTaskIds, customTiers: customTiersLive, customTiersLoaded, customTierIds, suppressDetail, openSessionIds, openSessionTaskIds, onOperationError, externalProject, onProjectChange, onOpenLauncher, onOpenLauncherForProject, onOpenLauncherForTier, onOpenSearchSession, taskGroups, hiddenGroups, onGroupTasks, onAddToGroup, onUngroupTask, onUngroupTasks, onRenameGroup, onSetGroupHidden, folderMeta, onCreateFolder, onDeleteFolder, onMoveFolderToProject, onSetFolderParent, banner }: TodoPanelProps) {
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
  // The focus-override effect (above the filter memos, deliberately not re-run
  // on filter changes) reads the board predicate through this ref, published
  // from a layout effect below, never during render.
  const passesBoardRef = useRef<(t: Task) => boolean>(() => true);
  // 5.10: tier headings stay off a one-tier board until the user picks a tier once.
  const [tierUsed, setTierUsed] = useState(readTierUsed);
  const noteTierUsed = useCallback(() => { markTierUsed(); setTierUsed(true); }, []);
  const onSetTier = useMemo(() => onSetTierProp && ((...args: Parameters<NonNullable<typeof onSetTierProp>>) => {
    noteTierUsed();
    return onSetTierProp(...args);
  }), [onSetTierProp, noteTierUsed]);
  const [sortBy, setSortBy] = useState<SortBy>(readSortBy);
  // A project's own order (its right-click "Sort tasks by"); the rest follow sortBy.
  // Only the By-project list reads it: "In one list" has one order for everything.
  const [projectSorts, setProjectSorts] = useState<Record<string, SortBy>>(readProjectSorts);
  // Ephemeral toast shown when a manual action (drag / move up / move left)
  // auto-switches the sort mode to 'manual'. Routed through the unified toaster
  // (kind:'sort', non-persistent, 3s lifetime) — no local toast state needed.
  const { notify } = useNotifications();
  const showSortToast = useCallback((msg: string) => {
    notify({ kind: 'sort', severity: 'info', title: 'Sort', body: msg, persistent: false, dedupKey: 'sort' });
  }, [notify]);
  const [groupBy, setGroupBy] = useState<GroupBy>(readGroupBy);
  const sortForProject = useCallback((project: string): SortBy =>
    (groupBy === 'project' ? projectSorts[project] : undefined) ?? sortBy, [groupBy, projectSorts, sortBy]);
  // One project's order. Picking the order every other project has just drops its own.
  const setProjectSort = useCallback((project: string, v: SortBy) => {
    setProjectSorts((prev) => {
      const next = { ...prev };
      if (v === sortBy) delete next[project]; else next[project] = v;
      persistProjectSorts(next);
      return next;
    });
  }, [sortBy]);
  // Every project at once (the Projects heading, the filter menu): per-project choices go.
  const setSortForAll = useCallback((v: SortBy) => {
    setSortBy(v); persistSortBy(v);
    setProjectSorts({}); persistProjectSorts({});
  }, []);

  // Focus override: when a focused task would be hidden by filters, store its ID here
  // instead of clearing filters. The filtered useMemo exempts this task from all filter checks.
  // When focus moves away, the task fades out (fadingOverrideRef) before being removed.
  const focusOverrideRef = useRef<string | null>(null);
  const fadingOverrideRef = useRef<string | null>(null);
  // The override a creation started (5.11), not a locate: only it gets the pill and toast.
  const createdOverrideRef = useRef<string | null>(null);
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

  // Auto-refresh tick: bump every 60s so time-dependent UI re-evaluates —
  // the date filter (deferred tasks appear on time) AND the per-row ▶ start
  // pill, which renders in the "All" view too, so the timer runs always.
  const [_tick, setTick] = useState(0);
  useEffect(() => {
    // visibleInterval: hidden tabs skip the re-render tick; one catch-up on return.
    return visibleInterval(() => setTick((t) => t + 1), 60_000);
  }, []);

  // Filter state (both internal models, spec D5) lives in useHomeFilters.
  const homeFilters = useHomeFilters({
    tasks, loading, projectOrder: ordering?.projectOrder, externalProject, onProjectChange, clearFocusOverride,
    timeTick: _tick,
  });
  const { showCompleted } = homeFilters;
  const filterState = homeFilters.state;
  const filterEvalCtx = homeFilters.evalCtx;
  const waitingRevealed = filterState.status.includes('WAITING');
  /** The list's hiding rule for a task on hold; pins and Recent read it too. */
  const hiddenAsWaiting = useCallback(
    (t: Task): boolean => t.phase === 'WAITING' && !waitingRevealed,
    [waitingRevealed],
  );

  // Registry projects (incl. zero-task ones) + provider source for the badges.
  const projectRegistry = useProjectRegistry();
  // Project header "+ → Add task": open that group's ghost add row (the group's
  // own inline editor — creation stays physically IN the group, so "where does
  // it land" needs no explanation). Nonce so re-clicks re-open after an Escape.
  const [headerAddSignal, setHeaderAddSignal] = useState<{ project: string; nonce: number } | null>(null);
  /** Unfold a project, for callers about to reveal something INSIDE it — a ghost
   *  row (or any other row) under a folded project is a dead click. Shared by the
   *  main list's add row and the pinned tiers' per-run add row. With a `tier`, only
   *  that tier's run opens and the Projects list is left alone (a list project opens
   *  only when the user acts on it there); without one, only the list's project opens,
   *  never a run in a tier above it. */
  const expandProject = useCallback((project: string, opts?: { tier?: string }) => {
    const tier = opts?.tier;
    if (tier === undefined) {
      setListOpen(prev => prev.has(project) ? prev : saveListOpen(new Set(prev).add(project)));
      return;
    }
    setRunFolds((prev) => {
      const next = unfold(prev, project, tier, allTierKeysRef.current);
      if (next !== prev) saveFolds(LS_RUN_FOLDS_KEY, next);
      return next;
    });
  }, []);
  const handleHeaderAddTask = useCallback((project: string) => {
    expandProject(project);
    setHeaderAddSignal((prev) => ({ project, nonce: (prev?.nonce ?? 0) + 1 }));
  }, [expandProject]);
  // Consume-once acknowledgment from the target InlineAdd (see its effect).
  const clearHeaderAddSignal = useCallback(() => setHeaderAddSignal(null), []);
  // First visit (nothing stored) starts Parked folded: all three tiers are
  // permanent rows now, and the "someday" one is the one a first look does not
  // need open. Every other region stays expanded, and the first chevron click
  // persists whatever the user actually wants.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      if (localStorage.getItem(LS_COLLAPSED_SECTIONS_KEY) === null) return new Set(['wait']);
    } catch { /* storage disabled */ }
    return readSetFromStorage(LS_COLLAPSED_SECTIONS_KEY);
  });
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
  // Which of Focus / Satellite / Parked / Recent / Tasks / Notes owns the panel
  // right now ('all' = the legacy stacked view, kept for cross-tier drag).
  // `collapsedSections` is still the *within-a-view* chevron state; these two are
  // independent — in single-section mode the region renders regardless of its
  // collapse flag (a tab you just picked must never show up already folded).
  const [activeSection, setActiveSection] = useState<TodoSection>(readSection);
  const [quickViews, setQuickViews] = useNavigationPreference(TASK_SHORTCUTS_KEY);
  const [tabBarHidden] = useNavigationList(TAB_BAR_HIDDEN_TABS_KEY, DEFAULT_HIDDEN_TABS);
  // Read by the locate effect, whose deps deliberately leave out view state.
  const tabBarRef = useRef({ shown: quickViews, hidden: tabBarHidden });
  tabBarRef.current = { shown: quickViews, hidden: tabBarHidden };
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
  // Per-tier task sort: Manual (pin order) unless the Display menu picked another.
  const [tierSorts, setTierSorts] = useState<Record<string, SortBy>>(readTierSorts);
  const tierSort = useCallback((tier: string): SortBy => tierSorts[tier] ?? 'manual', [tierSorts]);
  const setTierSort = useCallback((tier: string, v: SortBy) => {
    setTierSorts((prev) => {
      if ((prev[tier] ?? 'manual') === v) return prev;
      const next = { ...prev };
      if (v === 'manual') delete next[tier]; else next[tier] = v;
      persistTierSorts(next);
      return next;
    });
  }, []);
  // Read by the drag-end handler, whose deps leave the sort out.
  const tierSortRef = useRef(tierSort);
  tierSortRef.current = tierSort;
  // Recent's order: the time the feed ranks by (the row's time too, see
  // RecentSortMode), or Priority, which keeps the feed and orders it by priority.
  const [recentOrder, setRecentOrder] = useState<RecentOrder>(readRecentSortMode);
  const recentSortMode: RecentSortMode = recentOrder === 'created' ? 'created' : 'updated';
  const handleRecentSortChange = useCallback((mode: RecentOrder) => {
    setRecentOrder(mode);
    persistRecentSortMode(mode);
  }, []);
  const [recentGroup, setRecentGroup] = useState<GroupBy>(readRecentGroup);
  const handleRecentGroupChange = useCallback((g: GroupBy) => {
    setRecentGroup(g);
    try { localStorage.setItem(LS_RECENT_GROUP_KEY, g); } catch { /* ignore */ }
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
    if (isTierSection(section)) noteTierUsed();
    if (isSearchModeRef.current) { setSearchSection(section); return; }
    // startTransition: switching into a big section (Tasks/All = thousands of
    // mounted rows) is a multi-second render. Time-slice it so the click never
    // freezes the page — typing/scrolling stay responsive while rows mount.
    startTransition(() => setActiveSection(section));
    persistSection(section);
  }, [noteTierUsed]);
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
  // The pinned tiers' project runs, folded per (tier, project).
  const [runFolds, setRunFolds] = useState<ReadonlySet<string>>(() => readFolds(LS_RUN_FOLDS_KEY, LS_LEGACY_RUN_FOLDS_KEY));
  // Every tier key; allTierKeys is computed further down, and splitting an every-tier
  // fold (place-folds.ts) needs it inside callbacks declared before it.
  const allTierKeysRef = useRef<readonly string[]>([]);
  const [listOpen, setListOpen] = useState<Set<string>>(readListOpen);
  // Projects a locate opened for this visit only. Nothing but a click on the project
  // saves it open, so a reload folds these back.
  const [revealedProjects, setRevealedProjects] = useState<Set<string>>(() => new Set());
  // How many rows each open project draws before its "Show more" row (list-batch.ts).
  // Per visit: folding a project resets it.
  const [listBatch, setListBatch] = useState<Map<string, ListBatchState>>(() => new Map());
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
  // Pinned tiers: the folder chip the drag is aimed INTO (`into:<gid>:<tier>`, set
  // from dnd-kit's `over`, which is exact for this pointer-decided target).
  const [folderTargetId, setFolderTargetId] = useState<string | null>(null);
  // Collapse-on-drag bookkeeping: when a whole group is dragged, its member ids in the
  // frozen tier refs are collapsed to a single sentinel (= the chip's id) so the group
  // becomes ONE atomic sortable unit and the strategy pushes siblings aside / opens a
  // slot exactly like a task drag. We remember the sentinel id + the ordered members it
  // stands for (the folder's own cards and every subfolder's, pre-order) so drag
  // end/cancel can expand it back to the real member ids.
  const collapsedGroupRef = useRef<{ sentinel: string; gid: string; members: string[] } | null>(null);
  // ref holds `${overId}:${intent}` of the last applied highlight, to dedupe.
  const dropIntentRef = useRef<string | null>(null);
  // Remove the live-pointer listener if the panel unmounts mid-drag (prevents a
  // leaked window listener on route change during a drag).
  useEffect(() => () => { window.removeEventListener('pointermove', trackPointer); }, []);
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);

  // Search state
  const { query: searchQuery, setQuery: setSearchQuery, results: searchResults, isSearching, clearSearch } = useTaskSearch();

  // Vertical splitter for list/detail ratio
  const { ratio: detailRatio, containerRef: splitterContainerRef, handleProps: splitterHandleProps, isResizing: splitterResizing } = useVerticalSplitter();
  // A fold keeps its clicked row in place; only the rows below it move.
  useFoldAnchor(splitterContainerRef);
  // GONE (deliberately): the PINNED-vs-list splitter and the four per-tier resize
  // handles. The stacked view is ONE scroller now, so a ratio between the two
  // regions and a maxHeight per tier both carved private scrollboxes out of it —
  // which is exactly what made a tier's cards unreachable without three nested
  // scrolls. `open-walnut-todo-pinned-ratio` and `open-walnut-focus-tier-height-*`
  // are left in storage untouched; nothing reads them.
  //
  // Recent keeps its handle — it is a capped feed, not a stacked tier (before it
  // was hard-capped at ~3 rows, RECENT_VISIBLE_MAX * 30, with no way to pull it
  // taller).
  // (RECENT_VISIBLE_MAX * 30) with no way to pull it taller.
  const recentResize = useResizableHeight('open-walnut-focus-tier-height-recent', { min: 60, max: 1200 });

  // Typing responsiveness (2026-08-26): the search input tracks `searchQuery`
  // synchronously, but every EXPENSIVE consumer (match recompute over thousands
  // of tasks, the section-layout flip, the pinned/recent search-mode filters)
  // reads this deferred copy instead. React renders the keystroke first and the
  // heavy pass at deferred (interruptible) priority, so fast typing never waits
  // on a full panel recompute per character.
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // Determine if search mode is active (query entered). Derived from the
  // DEFERRED query so mode-dependent consumers flip in the same pass that
  // computes their matches (an urgent flip with a stale deferred query would
  // run one frame of "search mode with empty query" = match-everything).
  const isSearchMode = deferredSearchQuery.trim().length > 0;

  // ── Section-tab view resolution ──
  // Search defaults to the All view, where every match lands in ONE flat ranked
  // list (a pinned hit carries its tier as a pill; the tier regions step aside),
  // so the best hit is first no matter where it lives. Tabs stay usable during a
  // search via the ephemeral
  // `searchSection` override; the persisted tab is untouched, so clearing the query
  // restores the pre-search view.
  isSearchModeRef.current = isSearchMode;
  const rawSection: TodoSection = isSearchMode ? (searchSection ?? 'all') : activeSection;
  // The home Filter has no Pinned dimension (spec 3.2), so the view is the section.
  const effectiveSection: TodoSection = rawSection;

  activeSectionRef.current = effectiveSection;
  // Drop the ephemeral override when the query is cleared, so the next search
  // starts from the All default again.
  useEffect(() => {
    if (!isSearchMode && searchSection !== null) setSearchSection(null);
  }, [isSearchMode, searchSection]);
  const isAll = effectiveSection === 'all';
  // The Pinned view is the All view's tier stack without the project list: the tiers
  // keep their headings, folds and cross-tier drag, so everything that is "stacked"
  // behaviour keys off this, and only the list itself keys off `isAll`.
  const isPinnedView = effectiveSection === 'pinned';
  const isStacked = isAll || isPinnedView;
  /** True when `section` should be mounted: either we're in a stacked view that holds it or it IS the active tab. */
  const showSection = useCallback(
    (section: TodoSection) => (isAll && section !== 'recent')
      || (isPinnedView && (section === 'focus' || section === 'satellite' || section === 'wait' || section.startsWith('ct_')))
      || effectiveSection === section,
    [isAll, isPinnedView, effectiveSection],
  );
  /** Within the active view, is this region folded? Only a stacked view honors
   *  chevrons — and a live search ignores them entirely (a hit hidden inside a
   *  folded region would read as "search found nothing"). The persisted collapse
   *  state is untouched; clearing the query folds things back. */
  const isFolded = useCallback(
    (id: string) => isStacked && !isSearchMode && collapsedSections.has(id),
    [isStacked, isSearchMode, collapsedSections],
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
      const scroller = listContainer.closest('.home-navigation-scroll.is-stacked') ?? listContainer;
      const elRect = el.getBoundingClientRect();
      const containerRect = scroller.getBoundingClientRect();
      // The stuck headings cover the scroller's top; the row's scroll margin says how much.
      const covered = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      const outOfView = elRect.top < containerRect.top + covered || elRect.bottom > containerRect.bottom;
      if (outOfView) {
        const elTopInContainer = elRect.top - containerRect.top + scroller.scrollTop;
        scroller.scrollTop = elTopInContainer - Math.max(containerRect.height / 3, covered);
        scrollLog('focus-scroll-done', { taskId, scrollTo: Math.round(scroller.scrollTop) });
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

  /** scrollIntoView({block:'nearest'}) that also counts a card under the stuck headings as out of
   *  view. The card's scroll margin is how much they cover; Chromium ignores it for a card that is
   *  already on screen, and would leave it hidden under them. */
  const revealBelowHeadings = useCallback((el: Element) => {
    const covered = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    let scroller = el.parentElement;
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
    const top = scroller ? el.getBoundingClientRect().top - scroller.getBoundingClientRect().top : covered;
    if (scroller && top < covered) scroller.scrollBy({ top: top - covered, behavior: 'smooth' });
    else el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  // Scroll a pinned task into view inside the top Pinned region (Focus/Next/Satellite/Parked).
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
      // A card hidden by a folded project run (.tier-project-collapsed) or a collapsed
      // folder is still IN the DOM, so the query finds it while scrollIntoView and the
      // flash are both no-ops. getClientRects() is empty for display:none, so treat
      // that as not-found and let the 150ms retry pick the card up once the unfold
      // (see the focus effect) has committed.
      if (el && el.getClientRects().length > 0) { revealBelowHeadings(el); flashCard(el); return true; }
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
  }, [flashCard, revealBelowHeadings]);

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
    scrollLog('focus-effect-run', { taskId: focusedTaskId.substring(0, 12), isNewFocus, proj: task.project, scope: focusScope ?? 'all' });

    // `proj` is the GROUP key ('' = Inbox). A Project chip that excludes it is
    // never switched away: the focus override below keeps the task on screen and
    // names the chip that hides it (spec 5.12).
    const proj = task.project || '';
    if (isUserLocate && !pinnedOnly) {
      setRevealedProjects(prev => prev.has(proj) ? prev : new Set(prev).add(proj));

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
    // into the filtered list. It fades out when focus moves away. The SAME board
    // predicate the list uses (read via a ref: this effect's deps deliberately
    // don't include filter state), so "would the list hide this?" cannot drift.
    const wouldBeHidden = !passesBoardRef.current(task);
    // 5.11: a task just created (a tier quick-add, Save as todo) that the chips
    // hide keeps the override too, so it stays on screen with its pill.
    // 'created' = the draft's Save as todo (F07): its task gets the pill too.
    const keepCreated = wouldBeHidden && (pinnedOnly || focusScope === 'created') && isJustCreated(task.created_at);

    if (wouldBeHidden && (!pinnedOnly || keepCreated)) {
      // Cancel any in-progress fade-out from a previous override
      if (fadingTimerRef.current) { clearTimeout(fadingTimerRef.current); fadingTimerRef.current = null; }
      fadingOverrideRef.current = null;
      focusOverrideRef.current = focusedTaskId;
      createdOverrideRef.current = keepCreated ? focusedTaskId : null;
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
      // A tier's project runs FOLD (rows kept in the DOM, display:none) instead of
      // unmounting, so a folded run is the third way the card can be unreachable, and
      // the silent one, because the query above still finds the node. Unfold it.
      // Runs on the pinnedOnly path too (the block at the top of this effect that
      // unfolds projects is gated on !pinnedOnly, which is exactly the tier quick-add
      // case); expanding only touches the fold, never the tab, so the "pinnedOnly must
      // not switch tabs" rule stays intact. Only the task's own tier opens (below).
      let tierKey = focusTaskIds?.has(focusedTaskId) ? 'focus'
        : waitTaskIds?.has(focusedTaskId) ? 'wait'
        : 'satellite';
      if (tierKey === 'satellite' && customTierIds) {
        for (const [tid, ids] of Object.entries(customTierIds)) {
          if (ids.has(focusedTaskId)) { tierKey = tid; break; }
        }
      }
      expandProject(proj, { tier: tierKey });
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
      // a locate into Parked while the Focus tab is showing would scroll to nothing.
      // STAY PUT whenever the current view already shows the task — the stacked
      // view, the Tasks list (pinned tasks are ordinary rows there), and the
      // task's own tier tab all do. Clicking a card must never yank the user to
      // a different tab (the old "click in Tasks → teleport to its Pin tier"
      // complaint). Only an off-view locate (chat/session ref while some OTHER
      // tier/Recent/Notes tab is showing) switches — to the stacked All view,
      // which shows the task in its tier AND the list at once.
      const cur = activeSectionRef.current;
      if (focusScope === 'locate') {
        // Asked from outside the panel (a session panel's Locate): with the tab bar showing
        // the task's tier, go straight to that tab; without it, All, which shows every tier.
        const bar = tabBarRef.current;
        const target = bar.shown && !bar.hidden.includes(tierKey) ? tierKey : cur === 'pinned' ? 'pinned' : 'all';
        if (cur !== target) handleSectionChange(target);
      } else if (cur !== 'all' && cur !== 'pinned' && cur !== 'tasks' && cur !== tierKey) handleSectionChange('all');
    } else if (isUserLocate && !pinnedOnly && activeSectionRef.current !== 'all' && (focusScope === 'locate' || activeSectionRef.current !== 'tasks')) {
      // A task in no tier only shows in the list, and All is the view with the list in it
      // (Projects is a filter menu view, not a tab the user can see they are on).
      handleSectionChange('all');
    }

    // Scroll to the focused task after state changes (expand/filter) have flushed to DOM.
    // scrollToTask uses double-RAF + retry to wait for React commit + browser paint.
    // pinned scope skips the main-list scroll — the tab wasn't switched, so the task
    // may not even be in the list below; only the Pinned region jump applies.
    if (!pinnedOnly || keepCreated) scrollToTask(focusedTaskId);
    // Also jump the top Pinned region (no-op if the task isn't pinned — the DOM
    // query simply finds nothing). Keeps the PIN row in sync with the list below.
    scrollToPinnedTask(focusedTaskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedTaskId, focusNonce, tasks, favorites]);

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
  // When this render ran: the batch effect below compares against it to catch a
  // window that was open while the memos ran but closed before the effect did.
  const graceRenderAt = Date.now();
  const recentlyCompletedRef = useRef<Set<string>>(new Set());
  // A task just set to Waiting leaves the list the same way (it is hidden by
  // default): same batch deadline, same fade, keyed on phase_changed_at the way
  // completion is keyed on completed_at. Shares the timers below.
  const recentlyParkedRef = useRef<Set<string>>(new Set());
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

  /** The Waiting twin: a task whose phase_changed_at is inside the window (the
   *  optimistic write stamps it, the server echo carries its own), or one the
   *  batch effect already holds. Only a WAITING task ever qualifies. */
  const isInParkingGrace = useCallback((t: Task): boolean => {
    if (t.phase !== 'WAITING' || !t.phase_changed_at) return false;
    const elapsed = Date.now() - new Date(t.phase_changed_at).getTime();
    return elapsed >= 0 && elapsed < GRACE_MS;
  }, []);
  const keepWhileParking = useCallback(
    (t: Task): boolean => t.phase === 'WAITING' && (recentlyParkedRef.current.has(t.id) || isInParkingGrace(t)),
    [isInParkingGrace],
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
      recentlyParkedRef.current.clear();
      graceDeadlineRef.current = 0;
      graceExitTimerRef.current = null;
      graceClearTimerRef.current = null;
      setGraceExiting(false);
      setRecentTick((n) => n + 1);
    }, untilDeadline);
  }, []);

  useEffect(() => {
    let extended = false;
    // A window that closed between the render and this effect: the render's memos
    // drew the task inline (isIn*Grace) and no timer is armed to redraw it, so it
    // stayed on the board. A heavy first mount makes that gap a second or more
    // (a task parked just before the page loaded stuck in its Focus tier).
    let closedSinceRender = false;
    const closedAfterRender = (at: number, elapsed: number) => elapsed >= GRACE_MS && at + GRACE_MS > graceRenderAt;
    for (const task of tasks) {
      if (task.status === 'done' && task.completed_at && !recentlyCompletedRef.current.has(task.id)) {
        const completedAt = new Date(task.completed_at).getTime();
        const elapsed = Date.now() - completedAt;
        if (elapsed >= 0 && elapsed < GRACE_MS) {
          recentlyCompletedRef.current.add(task.id);
          // ONE shared deadline for the whole batch: latest completion + GRACE_MS.
          graceDeadlineRef.current = Math.max(graceDeadlineRef.current, completedAt + GRACE_MS);
          extended = true;
        } else if (closedAfterRender(completedAt, elapsed)) closedSinceRender = true;
      }
      // A task just parked joins the same batch (it is about to leave the list too).
      if (task.phase === 'WAITING' && task.phase_changed_at && !recentlyParkedRef.current.has(task.id)) {
        const parkedAt = new Date(task.phase_changed_at).getTime();
        const elapsed = Date.now() - parkedAt;
        if (elapsed >= 0 && elapsed < GRACE_MS) {
          recentlyParkedRef.current.add(task.id);
          graceDeadlineRef.current = Math.max(graceDeadlineRef.current, parkedAt + GRACE_MS);
          extended = true;
        } else if (closedAfterRender(parkedAt, elapsed)) closedSinceRender = true;
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
    for (const taskId of recentlyParkedRef.current) {
      const task = tasks.find((t) => t.id === taskId);
      if (!task || task.phase !== 'WAITING') {
        recentlyParkedRef.current.delete(taskId);
        removed = true;
      }
    }
    if (extended) armGraceTimers();
    else if (removed && recentlyCompletedRef.current.size === 0 && recentlyParkedRef.current.size === 0) {
      // Batch emptied by reopens — disarm so the stale timers don't flash graceExiting.
      if (graceExitTimerRef.current) { clearTimeout(graceExitTimerRef.current); graceExitTimerRef.current = null; }
      if (graceClearTimerRef.current) { clearTimeout(graceClearTimerRef.current); graceClearTimerRef.current = null; }
      graceDeadlineRef.current = 0;
      setGraceExiting(false);
    }
    // Trigger re-render so the filters re-run with the new grace entries
    if (extended || removed || closedSinceRender) setRecentTick((n) => n + 1);
    // graceRenderAt is this render's own clock reading; the effect runs once per tasks change.
  }, [tasks, armGraceTimers]);

  // Cleanup shared timers on unmount
  useEffect(() => () => {
    if (graceExitTimerRef.current) clearTimeout(graceExitTimerRef.current);
    if (graceClearTimerRef.current) clearTimeout(graceClearTimerRef.current);
  }, []);

  // ── Sticky pin membership during the grace window ──
  // HISTORICAL SHIM, now a fallback: completing a task used to AUTO-UNPIN it
  // server-side and getPinnedTasks() filtered done tasks, so the card was
  // yanked out of the tier dataset before the grace filters ever saw it. Both
  // behaviors were removed 2026-08-26 (completed pins now stay in their tier),
  // so on a current server this snapshot is a no-op. It stays as cover for the
  // transition (stale replicas / older servers still emitting the unpin).
  const lastPinStateRef = useRef<Map<string, { pinned: boolean; tier: string }>>(new Map());
  useEffect(() => {
    for (const t of tasks) {
      // Snapshot only while OPEN — once done, the entry must stay frozen at its
      // pre-completion value (the server has already dropped it from the sets).
      if (t.status !== 'done' && t.phase !== 'COMPLETE') {
        let tier = 'satellite';
        if (focusTaskIds?.has(t.id)) tier = 'focus';
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
  }, [tasks, pinnedTaskIds, focusTaskIds, waitTaskIds, customTierIds]);

  // Active pinned-drag id — declared BEFORE every pinned render-model memo below so
  // they can freeze on it (useFrozenWhile) while a drag is live.
  const [activeDragPinnedId, setActiveDragPinnedId] = useState<string | null>(null);
  const isPinnedDragActive = activeDragPinnedId !== null;
  // The All view mounts empty tiers only while a pinned drag is live, so the rows
  // above the dragged card grow at the gesture's start and shrink at its end. The
  // list scrolls by the same amount so the anchor stays under the pointer.
  const scrollAnchorRef = useRef<{ selector: string; top: number } | null>(null);
  const holdScrollAnchor = useCallback((selector: string) => {
    const el = document.querySelector(selector);
    scrollAnchorRef.current = el ? { selector, top: anchorTop(el) } : null;
  }, []);
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (!anchor) return;
    scrollAnchorRef.current = null;
    const el = document.querySelector(anchor.selector);
    const scroller = el?.closest('.home-navigation-scroll');
    if (!el || !scroller) return;
    const delta = anchorTop(el) - anchor.top;
    if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
  }, [activeDragPinnedId]);
  // The tier REGISTRY freezes too: a cross-client tier create/delete mid-drag
  // (config:changed{focus_tiers} → refetch) would otherwise swap DROP_ZONE_TIERS,
  // unmount a TierNavigationGroup's SortableContext inside the active DndContext,
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
  // Completed pins keep their MEMBERSHIP (completion no longer unpins,
  // 2026-08-26) but the tier only DISPLAYS them during search: a query match
  // in Focus/Satellite must surface even when the task is done, while the
  // everyday tier view stays clutter-free (grace still covers the completion
  // animation there).
  // A Waiting pin keeps its tier but is not DRAWN there by default either (the
  // same rule as the list: hiddenAsWaiting, plus the parking grace so a card set
  // to Waiting from its menu fades out instead of popping).
  // "Show completed" reveals a tier's done pins in the tier itself, so the
  // footer's per-view completed count on a tier tab has something to show.
  const pinnedTasksLive = useMemo(() => {
    if (pinnedIdsWithGrace.size === 0) return [];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    return [...pinnedIdsWithGrace]
      .map((id) => taskMap.get(id))
      .filter((t): t is Task => !!t
        && (isSearchMode
          || showCompleted
          || (t.status !== 'done' && t.phase !== 'COMPLETE')
          || keepWhileCompleting(t))
        && (isSearchMode || !hiddenAsWaiting(t) || keepWhileParking(t))
        && !(t.group_id && hiddenGroups?.has(t.group_id)));
  }, [tasks, pinnedIdsWithGrace, hiddenGroups, showCompleted, keepWhileCompleting, hiddenAsWaiting, keepWhileParking, recentTick, isSearchMode]);
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

  // Split pinned into Focus / Satellite / Parked (id `wait`) / custom tiers
  const focusTasksLocal = useMemo(() => {
    if (focusIdsWithGrace.size === 0) return [];
    return pinnedTasks.filter((t) => focusIdsWithGrace.has(t.id));
  }, [pinnedTasks, focusIdsWithGrace]);

  // Satellite = the default bucket: not focus/wait, not in any custom tier.
  const satelliteTasksLocal = useMemo(() =>
    pinnedTasks.filter((t) => !focusIdsWithGrace.has(t.id) && !waitIdsWithGrace.has(t.id) && !customMemberIds.has(t.id)),
  [pinnedTasks, focusIdsWithGrace, waitIdsWithGrace, customMemberIds]);

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
    if (waitIdsWithGrace.has(taskId)) return 'wait';
    for (const [tid, ids] of Object.entries(customIdsWithGrace)) {
      if (ids.has(taskId)) return tid;
    }
    return 'satellite';
  }, [pinnedIdsWithGrace, focusIdsWithGrace, waitIdsWithGrace, customIdsWithGrace]);

  // Recent tasks: an ACTIVITY FEED — every recently created/updated task pops up
  // here, INCLUDING pinned ones (they render in their tier AND here; the Recent
  // card shows a tier dot and isn't draggable — it's already placed). When "Show
  // completed" is on, recently completed tasks surface too, ranked by completion.
  // FROZEN during a pinned drag: Recent sorts by last_session_update/updated_at and
  // shares the pinned DndContext — a mid-drag re-sort moves/remounts cards and
  // feeds the useRect #185 loop. Converges to live order on drop.
  const recentTasksLive = useMemo(() => {
    // 'updated': most recent of creation / any update / session activity /
    // completion (the activity feed). 'created': pure creation time. The row's
    // "3w ago" reads the same function, so what it says matches where it sits.
    const recentTime = (t: Task) => recentActivityTime(t, recentSortMode).at;
    // Completed tasks join the feed DURING SEARCH (2026-08-26, user request —
    // a matching done task must be findable in Recent too); the everyday feed
    // keeps the "Show completed" gate (+ the completion-animation grace).
    const feed = tasks
      .filter(t => {
        const isDone = t.status === 'done' || t.phase === 'COMPLETE';
        if (isDone) return isSearchMode || showCompleted || keepWhileCompleting(t);
        return isSearchMode || !hiddenAsWaiting(t) || keepWhileParking(t);
      })
      .sort((a, b) => recentTime(b).localeCompare(recentTime(a)))
      .slice(0, 50);
    // Priority reorders the same 50 (newest first among equals); By project then
    // gathers each project's rows under its label.
    const ranked = recentOrder === 'priority'
      ? feed.map((t, i) => ({ t, i })).sort((a, b) => priorityRank(a.t) - priorityRank(b.t) || a.i - b.i).map((x) => x.t)
      : feed;
    return recentGroup === 'project' ? groupByProject(ranked) : ranked;
  }, [tasks, showCompleted, keepWhileCompleting, hiddenAsWaiting, keepWhileParking, recentTick, recentSortMode, recentOrder, recentGroup, isSearchMode]);
  const recentTasks = useFrozenWhile(recentTasksLive, isPinnedDragActive);

  // Stable sensor config — inline objects in useSensor destabilize dnd-kit's internal
  // memoization (Object.values({distance:5}) produces new ref each render → sensors
  // re-register on every render → cascading re-renders during drag-end transition).
  const pointerConstraint = useRef({ distance: 5 }).current;
  const pointerOpts = useMemo(() => ({ activationConstraint: pointerConstraint }), [pointerConstraint]);
  const keyboardOpts = useMemo(() => ({ coordinateGetter: sortableKeyboardCoordinates }), []);

  // Keep pointerdown guards on nested controls while leaving touch gestures to scrolling.
  const sensors = useSensors(
    useSensor(TaskPointerSensor, pointerOpts),
    useSensor(KeyboardSensor, keyboardOpts),
  );

  // Sensors for pinned section DnD (separate from main task DnD)
  const pinnedSensors = useSensors(
    useSensor(TaskPointerSensor, pointerOpts),
    useSensor(KeyboardSensor, keyboardOpts),
  );
  // The pinned collision reads each tier's slot rules through a ref (set below, once the
  // task map and the folder tree exist), so its identity never changes mid-drag.
  const slotRulesRef = useRef<SlotRulesFor | null>(null);
  const pinnedCollision = useMemo(() => makePinnedCollision(() => slotRulesRef.current), []);

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
    () => ['focus', 'satellite', 'wait', ...(customTiers ?? []).map((t) => t.id)],
    [customTiers],
  );
  allTierKeysRef.current = allTierKeys;
  const DROP_ZONE_TIERS = useMemo<Record<string, FocusTier>>(() => {
    const map: Record<string, FocusTier> = {};
    for (const k of allTierKeys) {
      map[`${k}-drop-zone`] = k;
      map[`${k}-header-drop-zone`] = k;
    }
    return map;
  }, [allTierKeys]);

  // Local tier arrays that can be overridden during drag
  // Drag overlay arrays stored as refs (NOT state) to avoid triggering React re-renders
  // during DnD Kit's rapid onDragOver events. A single tick counter forces a re-render
  // when we explicitly want the UI to update (during over + on end).
  // One Map keyed by tier (built-in name or custom id) replaces the old three
  // fixed refs — null = not dragging.
  const dragTierIdsRef = useRef<Map<FocusTier, string[]> | null>(null);
  /**
   * The AIM RECORD: the last row dnd-kit itself named as `over` during the live
   * pinned drag, other than the dragged item (a task card id or a group chip
   * sentinel). null = it never named one.
   *
   * Why a record and not just `event.over` at the drop: dnd-kit routinely reports
   * `over === active` at the END of a real cross-run drag, because the dragged
   * card's preview follows the pointer and the live layout shift can put the
   * pointer back on the dragged card itself. Measured, project-clustered tier,
   * 30px rows: after the gesture task-move-project.spec.ts performs, EVERY row's
   * transform is back to the identity matrix and the release pointer sits inside
   * the dragged card's own at-rest rect — the release instant carries no evidence
   * at all of the run the user aimed at. The row dnd-kit named while they were
   * aiming is the only surviving record of it, and it is the SAME kind of evidence
   * the explicit-`over` path already trusts. See maybeMoveProject.
   */
  const lastNamedOverRef = useRef<string | null>(null);
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
  // Folder → parent folder, normalised (folder-tree.ts). Empty on a board where no
  // folder nests, and every nesting pass below is then a no-op.
  const folderParents = useMemo(() => buildFolderParents(folderMeta), [folderMeta]);
  const clusterForTier = useCallback((tier: string, tierTasks: Task[]): string[] => {
    const isCustom = tierViewMode(tier) === 'custom';
    const sort = tierSort(tier);
    const byId = new Map(tierTasks.map((t) => [t.id, t]));
    // A sorted tier reads its cards in the sort's order instead of pin order; the
    // folder and project passes below then work on that order (both are stable).
    const ordered = sort === 'manual' ? tierTasks : [...tierTasks].sort(TASK_COMPARATORS[sort]);
    // Project view sinks folder clusters below the loose tasks (A1); custom view
    // keeps the lead-anchored cluster so the user's hand order stays authoritative.
    const projected = orderPinnedTier(ordered, isCustom ? 'custom' : 'project', ordering?.projectOrder);
    // A subfolder's rows move inside its parent folder's run (pre-order), so the
    // tree draws nested instead of as siblings.
    const nested = nestFolderUnits(projected, (id) => byId.get(id)?.group_id || undefined, folderParents);
    // Chip sentinels go in LAST — see withGroupSentinels for why they must not be
    // visible to the project clustering pass. Ancestor folders with no card here get
    // one too, so every heading on screen is a row the drag can slide and drop on.
    const withChips = withGroupSentinels(nested, tierTasks, tier, folderParents);
    if (!isCustom) {
      // Project labels ride the items too (withProjectLabels), whenever two projects
      // share the tier; which of them are drawn is the visible pass's call.
      const projects = new Set(tierTasks.map((t) => t.project || ''));
      if (projects.size < 2) return withChips;
      return withProjectLabels(withChips, tier, runProjectOf(nested, (id) => byId.get(id), folderParents));
    } // project-mode lines anchor folders → plain DOM rows
    // Custom-mode divider lines ride the items array itself (withSeparatorSentinels):
    // in `items`, the strategy displaces a line with the cards around it, so a card
    // can never visually cross it mid-drag (2026-08-25) and a slot can open above a
    // top-anchored line.
    // Lines divide a hand order: a sorted tier draws none (they stay saved for Manual).
    if (sort !== 'manual') return withChips;
    return withSeparatorSentinels({
      ids: withChips, separators, tier,
      groupOf: (id) => byId.get(id)?.group_id ?? null,
      isTaskId: (id) => byId.has(id),
    });
  }, [tierViewMode, tierSort, ordering?.projectOrder, separators, folderParents]);
  const focusIds_arr = useMemo(() => dragTierIds?.get('focus') ?? clusterForTier('focus', focusTasksLocal), [dragTierIds, focusTasksLocal, clusterForTier]);
  const satelliteIds_arr = useMemo(() => dragTierIds?.get('satellite') ?? clusterForTier('satellite', satelliteTasksLocal), [dragTierIds, satelliteTasksLocal, clusterForTier]);
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
  // Every task's folder, Recent cards included (they drag onto the tiers too).
  const folderOfTask = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) if (t.group_id) map.set(t.id, t.group_id);
    return map;
  }, [tasks]);
  // Each tier's "A / B" rows (folderChains), published below where they are computed.
  const tierChainsRef = useRef<Map<string, Map<string, string[]>>>(new Map());
  useLayoutEffect(() => {
    const tiers = new Set<string>(['focus', 'satellite', 'wait', ...(customTiers ?? []).map((d) => d.id)]);
    const folderOf = (id: string) => folderOfTask.get(id);
    const pinnedCard = (id: string) => pinnedTaskMap.has(id);
    slotRulesRef.current = (tier) => tiers.has(tier) ? {
      folderOf, parentOf: folderParents, mode: tierViewMode(tier), pinnedCard,
      leafOf: (gid) => tierChainsRef.current.get(tier)?.get(gid)?.at(-1) ?? gid,
    } : null;
  }, [customTiers, folderOfTask, folderParents, tierViewMode, pinnedTaskMap]);

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
    if (tierViewMode(tier) !== 'custom' || tierSortRef.current(tier) !== 'manual') return;
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
  const syncCustomSepAnchors = useCallback((tiers: Array<{ tier: string; arr: string[] }>, movedIds: string[] = []) => {
    let next = separators;
    for (const { tier, arr } of tiers) {
      if (tierViewMode(tier) !== 'custom' || tierSortRef.current(tier) !== 'manual') continue;
      next = syncSeparatorAnchorsFromArr({
        separators: next, tier, finalArr: arr,
        isTaskId: (id) => pinnedTaskMap.has(id),
        groupOf: (id) => pinnedTaskMap.get(id)?.group_id ?? null,
        // Hidden ≠ gone: a line anchored to a card that exists but isn't in this
        // frame (completed pin, collapsed group) renders at a fallback slot — a
        // card move must not write that fallback over the durable anchor.
        isKnownTaskId: (id) => !movedIds.includes(id) && tasksRef.current.some((t) => t.id === id),
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
    // The whole subtree travels: the folder's own cards and its subfolders' cards.
    const members = pinnedTasks.filter((t) => folderWithin(t.group_id, gid, folderParents));
    const label = taskGroups?.[gid] ?? 'Folder';
    if (members.length === 0) return { label, titles: [], count: 0 };
    return { label, titles: members.map((t) => t.title), count: members.length };
  }, [activeDragPinnedId, pinnedTasks, taskGroups, folderParents]);

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
  const requestFileIntoFolderRef = useRef<typeof requestFileIntoFolder | null>(null);
  const nestFolderRef = useRef<typeof nestFolder | null>(null);
  const requestMoveFolderRef = useRef<typeof requestMoveFolder | null>(null);

  // ── Unpin-by-drag ── `unpinZone` drives the portalled strip (null = no strip),
  // `unpinRectRef` is the same rect for the drop test in a handler that runs after
  // state has been torn down, `unpinHot` is the armed look.
  const pinnedWrapperRef = useRef<HTMLDivElement>(null);
  const unpinRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const [unpinZone, setUnpinZone] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [unpinHot, setUnpinHot] = useState(false);
  // The explicit strip owns its pixels; both the highlight and release use this hit test.
  const overUnpinZone = useCallback((x: number, y: number) => {
    const r = unpinRectRef.current;
    if (!r || x < r.left || x > r.left + r.width || y < r.top || y > r.top + r.height) return false;
    const el = document.elementFromPoint(x, y);
    return el instanceof Element && !!el.closest('.todo-unpin-zone');
  }, []);

  // ── A board card goes where its gap is ── The gap the dragged card opens is
  // the drop: a gap between two of a folder's cards is inside that folder and lights
  // the folder's row (cardLanding), anything else is loose. There is no "join this
  // card" target any more: one that stopped the list while named made the gap flick
  // back and forth over a folder's cards (2026-10-01), and lit the card under the
  // pointer instead of showing where the card would go. A folder row's middle is the
  // gap at the top of that folder, its top band the gap above it (makePinnedCollision).

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
    // A fresh gesture aims at nothing yet (see lastNamedOverRef).
    lastNamedOverRef.current = null;

    collapsedGroupRef.current = null;
    if (isGroupSentinel(activeId)) {
      const gid = parseGroupSentinelGid(activeId);
      // The folder's whole SUBTREE collapses into its chip: its own cards, every
      // subfolder's cards, and the subfolders' chips, in on-screen order (tier render
      // order) so the restored block preserves how the user saw them. A folder with
      // no card in any tier (an ancestor heading) still drags as the one chip.
      const inSubtree = (id: string): boolean => isGroupSentinel(id)
        ? id !== activeId && folderWithin(parseGroupSentinelGid(id), gid, folderParents)
        : folderWithin(pinnedTaskMap.get(id)?.group_id, gid, folderParents);
      const orderedMembers = [...tierArrays.values()].flat().filter((id) => !isGroupSentinel(id) && inSubtree(id));
      const collapse = (arr: string[]): string[] => {
        const out: string[] = [];
        for (const id of arr) {
          // The subtree goes; every other id (this folder's own sentinel and OTHER
          // folders' sentinels included) stays exactly where it is.
          if (!inSubtree(id)) out.push(id);
        }
        return out;
      };
      const collapsedMap = new Map<FocusTier, string[]>();
      for (const [tier, arr] of tierArrays) collapsedMap.set(tier, collapse(arr));
      dragTierIdsRef.current = collapsedMap;
      collapsedGroupRef.current = { sentinel: activeId, gid, members: orderedMembers };
    }

    const sourceTier = [...tierArrays].find(([, ids]) => ids.includes(activeId))?.[0];
    scrollAnchorRef.current = null;
    if (sourceTier) holdScrollAnchor(`#home-task-navigation [data-navigation-id="${window.CSS.escape(sourceTier)}"]`);
    setActiveDragPinnedId(activeId);
    // Reserve the viewport's bottom strip without moving any existing row.
    if (!isGroupSentinel(activeId) && pinnedTaskIds?.has(activeId) && onUnpinTask) {
      const wrapper = pinnedWrapperRef.current;
      const r = wrapper?.getBoundingClientRect();
      const viewport = wrapper?.closest('.home-navigation-scroll')?.getBoundingClientRect();
      const bottom = viewport?.bottom;
      if (r && viewport && bottom !== undefined && viewport.height > UNPIN_ZONE_H * 2) {
        const rect = { left: r.left, top: bottom - UNPIN_ZONE_H, width: r.width, height: UNPIN_ZONE_H };
        unpinRectRef.current = rect;
        setUnpinZone(rect);
      }
    }
    // Track the live cursor: the collision reads a folder row's bands from it, and the
    // drop end reads the tier heading and the unpin strip under it.
    window.addEventListener('pointermove', trackPointer, { passive: true });
    dropIntentRef.current = null;
    // Cross-panel drag: announce single-task drags on the bus so out-of-context
    // targets (calendar side panel) can accept the drop. Group sentinels stay
    // in-panel — a multi-task cluster has no calendar semantics.
    const busTask = pinnedTaskMap.get(activeId)
      ?? tasksRef.current.find((t) => t.id === activeId);
    if (busTask && !isGroupSentinel(activeId)) {
      const pe = event.activatorEvent as PointerEvent | undefined;
      dragBus.begin({ kind: 'task', task: busTask }, pe?.clientX !== undefined ? { x: pe.clientX, y: pe.clientY } : undefined);
    }
  }, [focusTasksLocal, satelliteTasksLocal, waitTasksLocal, customTiers, customTasksLocal, recentDraggableIds, pinnedTaskMap, clusterForTier, pinnedTaskIds, onUnpinTask, holdScrollAnchor, folderParents]);

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
    const activeId = active.id as string;
    // The folder a drop would go into lights up (its row): for a folder or a card from
    // Recent, for exactly as long as dnd-kit names that row's pointer-decided `into:`
    // target (nothing else happens for it: no slot opens, no tier array moves, the drop
    // does the filing); for a card on the board, the folder its slot files it into,
    // read off the very frame dnd-kit draws next (slotFrame), so the gap and the lit
    // row always tell the same story. dragOver fires on every change of `over`, which
    // is every change of that frame.
    const intoId = over && isIntoFolderId(String(over.id)) ? String(over.id) : null;
    let lit = intoId;
    const rulesFor = slotRulesRef.current;
    if (!lit && over && rulesFor && isBoardCard(rulesFor, activeId)) {
      const frame = slotFrame(activeId, over, rulesFor);
      const folder = frame ? cardLanding(frame.arr, frame.at, frame.rules).folder : undefined;
      lit = frame && folder ? intoFolderId(folder, frame.tier as FocusTier) : null;
    }
    setFolderTargetId((prev) => (prev === lit ? prev : lit));
    if (!over) return;
    const overId = over.id as string;
    if (intoId) return;
    // A folded destination cannot hold a preview without moving its own header under the pointer.
    if (overId.endsWith('-header-drop-zone')) return;

    // Keep the aim record (lastNamedOverRef) current. FIRST thing in this handler on
    // purpose: every branch below returns early for some drag kind, and the record has
    // to describe the whole gesture regardless of what kind it was. Only ROWS count —
    // a tier drop-zone names a TIER, not a slot inside it, and the dragged item naming
    // itself is dnd-kit saying it has no row to name (which must not erase the last
    // row it did name; that erasure is the whole reason the drop had nothing to read).
    if (overId !== activeId && !DROP_ZONE_TIERS[overId] && !isSeparatorId(overId)) {
      lastNamedOverRef.current = overId;
    }

    // Whole-group drag (chip grip): the active id is the `group:<gid>:<tier>` sentinel,
    // now a real sortable unit in the tier refs (collapsed at drag start). Same-tier
    // reordering is handled automatically by verticalListSortingStrategy (siblings
    // shift, an empty slot opens — just like a task). Here we only move the sentinel
    // BETWEEN tiers so the slot opens in the hovered tier. Never light a per-card
    // "join group" target for a group drag. Clear any stale single-card highlight.
    if (isGroupSentinel(activeId)) {
      if (!dragStartSnapshot.current) return;
      // Target tier from the hovered drop-zone or the tier the over-card lives in now.
      const targetTier: FocusTier | undefined = DROP_ZONE_TIERS[overId] ?? findTierOf(overId);
      if (!targetTier || activeId === overId) return;
      const currentTier: FocusTier = findTierOf(activeId) ?? 'satellite';
      if (currentTier === targetTier) return; // same tier — strategy handles the visual
      const addAt = (arr: string[], ovId: string) => {
        let idx = arr.indexOf(ovId);
        if (idx === -1) return [...arr, activeId];
        // Above the chips a folder's first row sits under, like a card (overFits
        // judged this very slot).
        while (idx > 0 && isGroupSentinel(arr[idx - 1])) idx--;
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
      if (!dragStartSnapshot.current) return;
      const targetTier: FocusTier | undefined = DROP_ZONE_TIERS[overId] ?? findTierOf(overId);
      if (!targetTier || activeId === overId) return;
      if (tierViewMode(targetTier) !== 'custom') return;
      const currentTier: FocusTier | undefined = findTierOf(activeId);
      if (!currentTier || currentTier === targetTier) return;
      const addAt = (arr: string[], ovId: string) => {
        let idx = arr.indexOf(ovId);
        if (idx === -1) return [...arr, activeId];
        // Landing on a group's first member: insert ABOVE its chip sentinel(s) (a
        // nested folder has its ancestors' chips right above its own), not between
        // chip and member — pruneOrphanSentinels wants the chip heading its run,
        // and lines draw above chips anyway (withSeparatorSentinels).
        while (idx > 0 && isGroupSentinel(arr[idx - 1])) idx--;
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
      // Right above `over`, the slot overFits judged (slotFrame): a card above a
      // folder's first card lands in that folder, as its first card.
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
    // The aim record dies with the gesture. handlePinnedDragEnd captures it BEFORE
    // calling this, next to liveTiers/collapsed and for the same reason.
    lastNamedOverRef.current = null;
    setActiveDragPinnedId(null);
    // Tear down the drop-intent highlight + live-pointer listener started in
    // handlePinnedDragStart.
    window.removeEventListener('pointermove', trackPointer);
    dropIntentRef.current = null;
    setFolderTargetId((prev) => (prev === null ? prev : null));
    unpinRectRef.current = null;
    setUnpinZone(null);
    setUnpinHot(false);
  }, []);

  const handlePinnedDragCancel = useCallback((event: DragCancelEvent) => {
    holdScrollAnchor(`#home-task-navigation .todo-pinned-section [data-task-id="${window.CSS.escape(String(event.active.id))}"]`);
    dragBus.cancel();
    clearDragState();
  }, [clearDragState, holdScrollAnchor]);

  const handlePinnedDragEnd = useCallback((event: DragEndEvent) => {
    holdScrollAnchor(`#home-task-navigation .todo-pinned-section [data-task-id="${window.CSS.escape(String(event.active.id))}"]`);
    // Cross-panel drop first: if a bus target (calendar side panel) consumed
    // the pointer-up, skip ALL in-panel drop semantics — dnd-kit's
    // closestCenter still reports an in-panel `over` even when the pointer is
    // physically outside the panel, and acting on it would reorder/retier.
    if (dragBus.end()) {
      clearDragState();
      return;
    }
    const { active } = event;
    const header = document.elementFromPoint(livePointer.x, livePointer.y)?.closest('[data-navigation-id]');
    const headerId = header?.getAttribute('data-navigation-id');
    const releaseTier = headerId && DROP_ZONE_TIERS[`${headerId}-header-drop-zone`];
    const over = releaseTier ? { id: `${releaseTier}-header-drop-zone` } : event.over;
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
    let liveTiers = dragTierIdsRef.current;
    const collapsed = collapsedGroupRef.current;
    // The aim record, captured alongside them and for the same reason: clearDragState
    // is about to null it, and maybeMoveProject below is its only reader.
    const lastNamedOver = lastNamedOverRef.current;

    clearDragState();

    if (!over || !snap) return;
    const activeId = active.id as string;
    const overId = over.id as string;
    const headerTier = overId.endsWith('-header-drop-zone') ? DROP_ZONE_TIERS[overId] : undefined;
    if (headerTier) {
      if (isSeparatorId(activeId) && tierViewMode(headerTier) !== 'custom') return;
      liveTiers = new Map([...liveTiers ?? snap.tiers].map(([tier, ids]) => {
        const remaining = ids.filter(id => id !== activeId);
        return [tier, tier === headerTier ? [...remaining, activeId] : remaining];
      }));
      setCollapsedSections(prev => {
        const next = new Set(prev);
        next.delete(headerTier);
        persistSet(LS_COLLAPSED_SECTIONS_KEY, next);
        return next;
      });
    }

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
    // Sorted tiers (list-order.ts): snap.tiers holds what each tier DREW, its sort's
    // order. A drop that moves something inside one sorted tier switches it to Manual,
    // and the order it drew becomes its pin order, so nothing on screen jumps. Every
    // other sorted tier keeps its own pin order through the write: a drop writes every
    // tier, and a sort's order must not replace a hand order nobody touched.
    const pinIndex = new Map(pinnedTaskIds_arr.map((id, i) => [id, i]));
    const persisted = (order: string[], manualTier?: FocusTier): string[] => {
      const keep: Set<string>[] = [];
      for (const tier of snap.tiers.keys()) {
        if (tier === manualTier || tierSortRef.current(tier) === 'manual') continue;
        keep.push(new Set(taskIdsOnly(finalArr(tier))));
      }
      return keep.length ? keepPinOrder(order, keep, pinIndex) : order;
    };
    /** `tier`'s cards in `order` differ from what it drew: the drop moved something there. */
    const movedWithin = (tier: FocusTier, order: string[]): boolean => {
      const before = taskIdsOnly(snap.tiers.get(tier) ?? []);
      const members = new Set(before);
      const after = order.filter((id) => members.has(id));
      return after.length === before.length && after.some((id, i) => id !== before[i]);
    };
    /** A reorder inside `tier`: a sorted tier switches to Manual. Returns the tier the write bakes. */
    const reorderIn = (tier: FocusTier, order: string[]): FocusTier | undefined => {
      if (tierSortRef.current(tier) === 'manual' || !movedWithin(tier, order)) return undefined;
      setTierSort(tier, 'manual');
      showSortToast(`${tierDisplayLabel(tier, customTiers)} switched to Manual order`);
      return tier;
    };
    // A card filed into a folder drawn in `tier` lives there from now on: pinned first
    // when it came from Recent, retiered when it came from another tier. The card
    // teleports into the cluster, so a line anchored to it is freed first (it would
    // ride into the folder with it).
    const landInTier = (id: string, tier: FocusTier) => {
      const fromTier = snapTierOf(id);
      if (fromTier) sepReanchor(fromTier, taskIdsOnly(snap.tiers.get(fromTier) ?? []), [id]);
      if (snap.recent?.includes(id)) {
        onPinTask?.(id);
        setTimeout(() => onSetTier?.(id, tier), 100);
      } else if (fromTier && fromTier !== tier) {
        onSetTier?.(id, tier);
      }
    };

    // ── Released on a folder chip ("into this folder") ── The one drop that is
    // decided by the pointer alone (pinnedCollision), so nothing about slots or tier
    // arrays applies: a folder chip is nested under it (its cards move to the tier the
    // chip is drawn in, because that is where the user put it down), and a card from
    // Recent is filed into it (from another project through requestFileIntoFolder's
    // confirm) and pinned there. Only once that went through: a cancelled confirm
    // leaves everything where it was. A card on the board never gets here: its slot
    // says which folder it goes into (cardLanding, below).
    if (isIntoFolderId(overId)) {
      if (isSeparatorId(activeId)) return;
      const { groupId: intoGid, tier: intoTier } = parseIntoFolderId(overId);
      if (isGroupSentinel(activeId)) {
        const members = collapsed?.members ?? [];
        const fromTier = members.length > 0 ? snapTierOf(members[0]) : undefined;
        void nestFolderRef.current?.(parseGroupSentinelGid(activeId), intoGid).then((nested) => {
          if (!nested || !fromTier || fromTier === intoTier) return;
          sepReanchor(fromTier, taskIdsOnly(snap.tiers.get(fromTier) ?? []), members);
          for (const mid of members) onSetTier?.(mid, intoTier);
        });
        return;
      }
      const activeTask = tasks.find((t) => t.id === activeId);
      const fileInto = requestFileIntoFolderRef.current;
      if (!activeTask || activeTask.group_id === intoGid || !fileInto) return;
      const project = folderMeta?.[intoGid]?.project ?? tasks.find((t) => t.group_id === intoGid)?.project ?? activeTask.project ?? '';
      fileInto(activeId, { groupId: intoGid, project })
        .then((filed) => { if (filed) landInTier(activeId, intoTier); })
        .catch((err) => { onOperationError?.(err instanceof Error ? err.message : 'Move failed'); });
      return;
    }

    // The project run a slot of `arr` belongs to: the nearest DRAWN label above it.
    // `arr` can hold labels the filters hid (the full tier array), and a hidden label
    // must never answer for a slot the user saw under another one.
    const drawnItems = new Set((active.data.current?.sortable as { items?: string[] } | undefined)?.items ?? []);
    const runAbove = (arr: string[], index: number, tier?: FocusTier): string | null => {
      const ownPrefix = tier !== undefined ? tierLabelId(tier, '') : null;
      for (let i = index; i >= 0; i--) {
        const id = arr[i];
        if (!isTierLabelId(id) || (ownPrefix !== null && !id.startsWith(ownPrefix))) continue;
        if (drawnItems.size === 0 || drawnItems.has(id)) return tierLabelProject(id);
      }
      return null;
    };

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
    //
    // THREE kinds of evidence, in strict precedence order, because they are not
    // equally trustworthy and mixing them up silently corrupted data twice:
    //
    //  1. The row dnd-kit names as `over` at the drop. The dragged card took that
    //     row's slot, so it is in that run even when the slot sits at a run boundary
    //     where the neighbour walk would read the previous folder instead.
    //  2. The AIM RECORD (`lastNamedOver`): the last row dnd-kit named DURING the
    //     gesture. Needed because `over` collapses back onto the dragged card at the
    //     end of a real cross-run drag (the preview follows the pointer, the live
    //     layout shift then puts the pointer back on the dragged card, and dnd-kit
    //     reports it as its own `over`). Same kind of evidence as 1, just the last
    //     moment it existed. A gesture that never named another row — a twitch, a
    //     sideways slip — records nothing, and NOTHING is the correct answer there.
    //  3. The landing SLOT in `tierIds` (inferTierDropProject). Evidence ONLY when
    //     dragOver really spliced the card into that array, i.e. a cross-tier drop or
    //     an explicit-over reorder. For a same-tier self-drop the array is still the
    //     AT-REST order (invariant #3 above: same-tier drags never mutate it), so the
    //     walk just re-reads where the card already lived and `prev` wins — which for
    //     the FIRST card of a run answers "the run ABOVE you". That is how a 12px
    //     twitch and a 40px sideways slip used to reproject a task with no visible
    //     gesture at all. Both are ratcheted in project-collapse-menu.spec.ts.
    //
    // `evidence: 'none'` for Recent-origin drops: dragOver APPENDS a Recent card at
    // the tier's end regardless of where the pointer hovers, so its landing position
    // is an artifact and only an explicit over-card carries intent.
    let projectMoveRequested = false;
    // Set by the landing check below: a card reordered among its own folder's rows, and
    // a card going into another folder (whose project is then the card's).
    let staysInOwnFolder = false;
    let fileTo: string | undefined;
    const maybeMoveProject = (
      tier: FocusTier,
      tierIds: string[],
      evidence: 'none' | 'aim' | 'aim+slot' = 'aim+slot',
    ) => {
      // A drag that CROSSES tiers is a tier-assignment gesture, full stop: the card
      // moved because the user wanted it in another tier, and the run it happens to
      // land in on the way is not a request to reproject it. (Recent-origin cards
      // have no snap tier at all, so they take this branch too — pinning a card is
      // not a project move either.) Checked FIRST, before the mode gate, because it
      // holds for every kind of evidence below.
      if (snapTierOf(activeId) !== tier) return;
      if (tierViewMode(tier) !== 'project') return;
      // A tier drop-zone names a TIER, not a slot inside it — dragOver merely
      // appended the card to the tier's end, so the neighbour walk below would
      // read "last run in the tier" out of an artifact and silently reproject a
      // pure tier-assignment gesture. Tier moves never change projects.
      if (DROP_ZONE_TIERS[overId]) return;
      const activeTask = tasks.find((t) => t.id === activeId);
      if (!activeTask) return;
      // Still in its folder = still in the folder's run, whatever project the card
      // itself says (a folder's rows are drawn under its first card's label). Into
      // another folder = into that folder's project, which the filing does.
      if (staysInOwnFolder || fileTo) return;
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
      // One named ROW → the project of the run it sits in. A chip stands in for its
      // whole group, so resolve it from the id right AFTER the sentinel in this tier
      // (its first member here) — a global tasks.find could hit a member parked in
      // another tier or a mixed-project group's far member. Scoped to `tierIds` on
      // purpose: a row the tier being dropped into does not hold cannot answer for it,
      // which is also what keeps a stale aim record from another tier out.
      const runProjectOfRow = (rowId: string): string | null => {
        if (!isGroupSentinel(rowId)) {
          return tierIds.includes(rowId) ? (projectOf(rowId) ?? null) : null;
        }
        const si = tierIds.indexOf(rowId);
        if (si === -1) return null;
        for (let i = si + 1; i < tierIds.length; i++) {
          if (tierIds[i] === activeId || isGroupSentinel(tierIds[i])) continue;
          return projectOf(tierIds[i]) ?? null;
        }
        return null;
      };
      let landed: string | null = null;
      if (tierIds.some(isTierLabelId)) {
        // Labelled tier: the labels ride the items, so the run a slot belongs to is
        // simply the nearest label above it, exactly what the user saw mid-drag.
        const runAt = (index: number) => runAbove(tierIds, index);
        if (evidence === 'aim+slot') {
          // The array was spliced at the landing slot: where the card sits IS the answer.
          landed = runAt(tierIds.indexOf(activeId));
        } else if (evidence === 'aim' && lastNamedOver !== null) {
          // At-rest array, so read the row the user aimed at. Aimed at a label, the
          // direction decides the side, as dnd-kit's own slot did: from above, the
          // card went below the label (into that run); from below, above it.
          const row = tierIds.indexOf(lastNamedOver);
          if (row !== -1) {
            landed = isTierLabelId(lastNamedOver) && tierIds.indexOf(activeId) > row ? runAt(row - 1) : runAt(row);
          }
        }
      } else {
        if (overId !== activeId) landed = runProjectOfRow(overId);
        // Evidence 2 — the aim record. Reached when dnd-kit had no row to name at the
        // drop, which is the normal end of a same-tier cross-run drag, not an edge case.
        if (landed === null && evidence !== 'none' && lastNamedOver !== null) {
          landed = runProjectOfRow(lastNamedOver);
        }
        // Evidence 3 — the landing slot, only where the array was really spliced.
        if (landed === null && evidence === 'aim+slot') landed = inferTierDropProject(tierIds, activeId, projectOf);
      }
      if (landed === null || sameProjectKey(landed, activeTask.project)) return;
      const requestMove = requestMoveTaskRef.current;
      if (!requestMove) return;
      // Fire-and-forget by design: the confirm (if any) resolves after this
      // handler returns, and a CANCEL leaves the already-persisted pin reorder
      // in place — the project cluster pass snaps the card back visually, at
      // the cost of a silently changed raw pin index (visible only if the tier
      // later switches to custom view). Accepted residue. A card leaving a folder
      // stays in it on a cancel too: the drop did not happen.
      projectMoveRequested = true;
      requestMove(activeId, landed).catch((err) => {
        onOperationError?.(err instanceof Error ? err.message : 'Move failed');
      });
    };

    // ── Whole-folder drag (chip) ── The active id is the `group:<gid>:<tier>`
    // sentinel that stood in for the collapsed subtree. Its FINAL tier is simply the
    // tier ref that now holds it (dragOver moved it cross-tier; same-tier position was
    // reflected by the strategy's slot). Expand the sentinel back to the ordered
    // members at its landing spot, retier any member whose tier changed, and persist.
    // A same-tier drop inside ANOTHER project's run moves the folder to that project
    // (a folder belongs to one project, so the old "a group can span projects" scope
    // cut no longer applies); without it the project clustering snapped the folder
    // straight back to where it came from.
    if (isGroupSentinel(activeId)) {
      if (!collapsed || collapsed.members.length === 0) return;
      const orderedMembers = collapsed.members;
      const memberSet = new Set(orderedMembers);

      // The sentinel's final tier = whichever live ref contains it.
      const overTier: FocusTier = finalTierOf(activeId) ?? 'satellite';

      const gid = collapsed.gid;
      const ownProject = folderMeta?.[gid]?.project ?? pinnedTaskMap.get(orderedMembers[0])?.project ?? '';
      const sameTier = snapTierOf(activeId) === overTier;

      // Live global order (sentinel present once, members already collapsed out).
      const liveGlobal = globalOrder(finalArr);

      // A drop onto a real row. Same tier: the slot dnd-kit previewed, i.e. the
      // dragged item takes that row's index (below it when coming from above, above
      // it when coming from below), the same splice the card reorder does. Before,
      // the folder always went ABOVE the row, one slot short of the preview whenever
      // it was dragged down. Cross tier: dragOver already put it right above the row.
      let ordered = liveGlobal;
      if (overId !== activeId && !DROP_ZONE_TIERS[overId] && !memberSet.has(overId) && liveGlobal.includes(overId)) {
        if (sameTier) {
          const ai = liveGlobal.indexOf(activeId);
          const oi = liveGlobal.indexOf(overId);
          ordered = [...liveGlobal];
          ordered.splice(ai, 1);
          ordered.splice(oi, 0, activeId);
        } else {
          ordered = liveGlobal.filter((id) => id !== activeId);
          ordered.splice(ordered.indexOf(overId), 0, activeId);
        }
      }

      // A same-tier drop in ANOTHER project's run (the label above the slot names it)
      // moves the folder to that project. A gesture that ended where it began moves
      // nothing, and an aimed-at label decides its side by direction, like a card's.
      if (sameTier && !headerTier && tierViewMode(overTier) === 'project') {
        let landed: string | null = null;
        if (overId !== activeId) {
          landed = runAbove(ordered, ordered.indexOf(activeId), overTier);
        } else {
          const netDrop = Math.hypot(event.delta?.x ?? 0, event.delta?.y ?? 0);
          const aim = netDrop >= (active.rect.current.initial?.height ?? 30) / 2 ? lastNamedOver : null;
          const row = aim !== null ? liveGlobal.indexOf(aim) : -1;
          if (row !== -1 && aim !== null) {
            landed = isTierLabelId(aim) && liveGlobal.indexOf(activeId) > row
              ? runAbove(liveGlobal, row - 1, overTier)
              : runAbove(liveGlobal, row, overTier);
          }
        }
        if (landed !== null && !sameProjectKey(landed, ownProject)) {
          void requestMoveFolderRef.current?.(gid, landed);
        }
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
      const folderOrder = taskIdsOnly(newOrder);
      onReorderPinned?.(persisted(folderOrder, sameTier ? reorderIn(overTier, folderOrder) : undefined));
      return;
    }

    // Check if item came from Recent section
    const isFromRecent = snap.recent?.includes(activeId) ?? false;

    // ── Which folder the card lands in ── Read off the frame the user saw, by the rule
    // the collision and the lit row used (cardLanding): the landing tier's drawn rows
    // with the card at its slot. A tier heading or a drop zone means the tier's end,
    // loose. Then FALL THROUGH to the tier-move / reorder logic, which writes where the
    // card sits. A card from Recent is only pinned (its slot is an artifact, see
    // maybeMoveProject); one on its folder's chip went through `into:` above.
    if (!isFromRecent && pinnedTaskMap.has(activeId)) {
      const own = pinnedTaskMap.get(activeId)?.group_id || undefined;
      const landing = ((): string | undefined | null => {
        if (headerTier || DROP_ZONE_TIERS[overId]) return undefined;
        const origin = snapTierOf(activeId);
        const tier = overId === activeId ? finalTierOf(activeId) : (snapTierOf(overId) ?? finalTierOf(activeId));
        const rules = tier ? slotRulesRef.current?.(tier) : null;
        if (!tier || !rules) return null;
        const sortable = active.data.current?.sortable as { containerId?: string; items?: string[] } | undefined;
        const drawn = sortable?.containerId === tier && sortable.items ? sortable.items : null;
        let arr = tier === origin && drawn ? [...drawn] : [...finalArr(tier)];
        const ai = arr.indexOf(activeId);
        const oi = overId === activeId ? -1 : arr.indexOf(overId);
        if (ai !== -1 && oi !== -1 && ai !== oi) arr = arrayMove(arr, ai, oi);
        if (drawn) { const seen = new Set(drawn); arr = arr.filter((id) => id === activeId || seen.has(id)); }
        const at = arr.indexOf(activeId);
        return at === -1 ? null : cardLanding(arr, at, rules).folder;
      })();
      // null = no frame to read: the card keeps its folder.
      staysInOwnFolder = !!own && (landing === own || landing === null);
      if (landing && landing !== own) fileTo = landing;
      if (own && landing === undefined && onUngroupTask) {
        // Out of its folder, loose. Once the handler has run (the tier-move / reorder
        // logic below repositions the card), unless it also moved the card to another
        // project: that move takes it out of the folder server-side, and a separate
        // ungroup refetches the list, which could be answered before the move was
        // written and drew the card back in its old project for a second or two.
        queueMicrotask(() => { if (!projectMoveRequested) onUngroupTask(activeId); });
      }
    }
    // A card going into ANOTHER folder is filed there (requestFileIntoFolder: a folder
    // of another project asks first, and Cancel changes nothing) and its place is
    // written in the same breath, the same render when nothing asks, so it never shows
    // first in the folder before it moves to where it was dropped.
    const commit = (persist: () => unknown) => {
      const fileInto = requestFileIntoFolderRef.current;
      if (!fileTo || !fileInto) { persist(); return; }
      const project = folderMeta?.[fileTo]?.project ?? tasks.find((t) => t.group_id === fileTo)?.project ?? '';
      fileInto(activeId, { groupId: fileTo, project }, persist)
        .catch((err) => { onOperationError?.(err instanceof Error ? err.message : 'Move failed'); });
    };

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
          const order = persisted(buildOrderFromRefs());
          onPinTask?.(activeId);
          setTimeout(() => onSetTier?.(activeId, currentTier, order), 100);
          maybeMoveProject(currentTier, finalArr(currentTier), /* evidence */ 'none');
        }
      } else {
        const origTier: FocusTier = snapTierOf(activeId) ?? 'satellite';
        if (currentTier && origTier !== currentTier) {
          commit(() => {
            // Lines live in the tier arrays now — their post-move anchors are read
            // straight off the final frames (both tiers), not rule-5-walked.
            syncCustomSepAnchors([
              { tier: origTier, arr: finalArr(origTier) },
              { tier: currentTier, arr: finalArr(currentTier) },
            ], [activeId]);
            return onSetTier?.(activeId, currentTier, persisted(buildOrderFromRefs()));
          });
        } else if (fileTo) {
          commit(() => {});
        }
        // dnd-kit had no row to name at the drop (`over` is the dragged card, whose
        // centre follows the pointer). TWO independent questions decide what may be
        // read here, and conflating them is what shipped the bug twice:
        //
        // WHETHER anything at all: the dragged node's net translation. A gesture that
        // ends where it began is not a request to move anything — that covers the 12px
        // twitch (TRAVELS 24px, NETS 0) and, just as importantly, an aim at another run
        // followed by a change of mind, where the aim record below IS populated and must
        // be vetoed. Half a row is the cutoff: a drop that changed nothing about where
        // the card sits cannot have been a request to change its project.
        //
        // WHAT is read: never the at-rest array for a SAME-tier drop. `finalArr` is
        // still the order the tier had before the gesture (invariant #3: same-tier drags
        // never mutate it), so the neighbour walk re-reads where the card already lived,
        // and for the FIRST card of a run `prev` answers "the run ABOVE you". Net
        // displacement cannot see that, because it only ever decided WHETHER: 40px of
        // purely HORIZONTAL slip clears half a row while telling you nothing about which
        // vertically-stacked run you are in, and the walk then reprojected the task
        // backwards (ratcheted: "a sideways slip on the first card of a project run").
        // So a same-tier self-drop gets 'aim' only — the row dnd-kit named while the
        // user was aiming, or nothing. A CROSS-tier self-drop keeps 'aim+slot': dragOver
        // really did splice the card into the destination array, so its neighbours are
        // genuine evidence of the run it landed in.
        const netDrop = Math.hypot(event.delta?.x ?? 0, event.delta?.y ?? 0);
        const halfRow = (active.rect.current.initial?.height ?? 40) / 2;
        if (currentTier) {
          const retiered = origTier !== currentTier;
          maybeMoveProject(
            currentTier, finalArr(currentTier),
            /* evidence */ !retiered && netDrop < halfRow ? 'none' : (retiered ? 'aim+slot' : 'aim'),
          );
        }
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
      const order = persisted(buildOrderFromRefs());
      onPinTask?.(activeId);
      setTimeout(() => onSetTier?.(activeId, targetTier, order), 100);
      maybeMoveProject(targetTier, finalArr(targetTier), /* evidence */ 'none');
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

    if (origTier !== targetTier || headerTier) {
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
      commit(() => {
        // Lines in both tiers re-anchor to the final frames (the origin lost a card,
        // the target gained one at the landing slot). The origin filter covers the
        // no-hover drop where dragOver never moved the card out of its live array.
        syncCustomSepAnchors([
          { tier: origTier, arr: finalArr(origTier).filter((id) => id !== activeId) },
          { tier: targetTier, arr },
        ], [activeId]);
        const order = buildOrderFromRefs(targetTier);
        return origTier !== targetTier
          ? onSetTier?.(activeId, targetTier, persisted(order))
          : onReorderPinned?.(persisted(order, reorderIn(targetTier, order)));
      });
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
    commit(() => {
      // Anchors from the final frame: a card that pushed a line aside really is on
      // the other side of it now (the strategy's preview was the truth).
      syncCustomSepAnchors([{ tier: origTier, arr: reorderedTier }]);
      const order = taskIdsOnly(newOrder);
      return onReorderPinned?.(persisted(order, reorderIn(origTier, order)));
    });
  }, [holdScrollAnchor, pinnedTaskIds_arr, onReorderPinned, onSetTier, onPinTask, clearDragState, folderMeta, onUngroupTask, onUnpinTask, overUnpinZone, pinnedCardIds, tasks, DROP_ZONE_TIERS, tierViewMode, pinnedTaskMap, onOperationError, separators, persistSeparators, sepReanchor, syncCustomSepAnchors, setTierSort, showSortToast, customTiers]);

  /** Every live project group key: real project names + '' when Inbox exists. */
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
    setRunFolds((prev) => {
      const next = pruneFolds(prev, (key) => liveGroupKeys.has(foldedId(key)));
      if (next !== prev) saveFolds(LS_RUN_FOLDS_KEY, next);
      return next;
    });
    // The list's own set too: an opened name left behind by a rename would open a
    // later project that reuses it.
    setListOpen((prev) => {
      const stale = [...prev].filter((k) => !liveGroupKeys.has(k));
      if (stale.length === 0) return prev;
      const next = new Set(prev);
      for (const k of stale) next.delete(k);
      return saveListOpen(next);
    });
  }, [loading, tasks.length, liveGroupKeys]);

  // ── The ONE board predicate (spec 4.6, 5.6, 5.7) ──
  //
  // Every surface (the list, the pin area, tier views, Recent, search, counts,
  // the footer and the focus-override reasons) asks filter-predicate's
  // passesChips, so a chip means the same thing in every view (D10). What stays
  // local is the completion / parking grace: a row just completed or set to
  // Waiting stays for its exit animation before the Status rule takes it out.
  const passesBoard = useCallback((t: Task): boolean => {
    if (passesChips(t, filterEvalCtx)) return true;
    return (keepWhileCompleting(t) || keepWhileParking(t)) && passesChips(t, filterEvalCtx, { except: 'status' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recentTick re-runs the grace check
  }, [filterEvalCtx, keepWhileCompleting, keepWhileParking, recentTick]);

  // Publish the predicate for the focus-override effect OUTSIDE render. A layout
  // effect, NOT useEffect: the consumer is a passive effect declared EARLIER in
  // this component, and passive effects run in declaration order, so a passive
  // publish would hand it the PREVIOUS commit's predicate (measured: that made
  // pinned-drag-storm.spec.ts fail every run via a React #185 loop).
  useLayoutEffect(() => { passesBoardRef.current = passesBoard; }, [passesBoard]);

  const filterResult = useMemo(() => {
    // SYNC: the focus effect's wouldBeHidden reads the same passesBoard.
    const overrideIds = new Set([focusOverrideRef.current, fadingOverrideRef.current]);
    const matchedList = tasks.filter((t) => overrideIds.has(t.id) || passesBoard(t));
    // matchedIds: the REAL hits, the focus-override row excluded (4.6).
    const matchedIds = new Set<string>();
    for (const t of matchedList) if (!overrideIds.has(t.id) || passesBoard(t)) matchedIds.add(t.id);
    // contextIds: descendants pulled in for HIERARCHY CONTEXT only. They are
    // RENDERED but are not hits: only the completed and Waiting hiding applies.
    const result = withSubtaskContext(tasks, matchedList, (t) =>
      (showCompleted || t.status !== 'done' || keepWhileCompleting(t))
      && (!hiddenAsWaiting(t) || keepWhileParking(t)));
    return { list: result, matchedIds };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusOverrideRef/fadingOverrideRef read via _overrideTick
  }, [tasks, showCompleted, passesBoard, hiddenAsWaiting, keepWhileParking, keepWhileCompleting, _tick, _overrideTick, recentTick]);

  // Read here, not further down: the dedupe memo below is the first consumer.
  const filterOverrideId = focusOverrideRef.current;
  const fadingOverrideId = fadingOverrideRef.current;
  /** Real hits only: what counts report. */
  const matchedIds = filterResult.matchedIds;

  // Whether a completed task will actually disappear after the grace period:
  // drives the exit animation (search keeps completed rows, so none there).
  const completedWillHide = !showCompleted && !isSearchMode;
  // The Waiting twin, and one answer for every row: "is this row on its way out?"
  const waitingWillHide = !waitingRevealed && !isSearchMode;
  const isRowVanishing = useCallback((t: Task): boolean => graceExiting && (
    (recentlyCompletedRef.current.has(t.id) && completedWillHide)
    || (recentlyParkedRef.current.has(t.id) && waitingWillHide)
  ), [graceExiting, completedWillHide, waitingWillHide]);

  // The list arrives with a recent window of completed tasks (useTasks); the
  // first view that shows completed rows loads the rest of the archive once.
  const tasksStore = useTasksContextSafe();
  const wantsCompletedArchive = showCompleted || isSearchMode || filterState.status.includes('COMPLETE');
  const archiveLoading = useArchiveFetch(wantsCompletedArchive, tasksStore);

  // Focus-override reasons in the chips' own words (5.12), one Show per reason.
  const overrideReasonTaskId = filterOverrideId || fadingOverrideId;
  const filterOverrideReasons = useMemo(() => {
    if (!overrideReasonTaskId) return undefined;
    const task = tasks.find((t) => t.id === overrideReasonTaskId);
    if (!task) return undefined;
    const reasons = hiddenByReasons(task, filterEvalCtx, homeFilters.lists);
    if (reasons.length === 0) return undefined;
    return { task, reasons };
  }, [overrideReasonTaskId, tasks, filterEvalCtx, homeFilters.lists]);
  // A locate of a task someone else just made shows the reasons; only a creation here gets the pill.
  const overrideCreated = !!filterOverrideReasons && createdOverrideRef.current === filterOverrideReasons.task.id
    && isJustCreated(filterOverrideReasons.task.created_at);
  const { showTask } = homeFilters;
  const showOverrideDim = useCallback((dim: FilterDim) => {
    if (filterOverrideReasons) showTask(filterOverrideReasons.task, [dim], 'override');
  }, [filterOverrideReasons, showTask]);
  const filterOverrideNode = filterOverrideReasons
    ? <FilterOverrideReasons reasons={filterOverrideReasons.reasons} created={overrideCreated} onShow={showOverrideDim} />
    : undefined;
  useCreatedOutsideToast(overrideCreated ? filterOverrideReasons : undefined, showTask);

  // --- Search filtering: search spans the WHOLE task set ---
  // Search honors every chip the user added and bypasses only the defaults
  // nobody chose (Status open, Date Available now; spec 5.7, D11): typing a
  // title you know exists must find it, and the Date default hides any task
  // whose start date is still in the future.
  const searchMatches = useMemo(() => {
    if (!isSearchMode) return filterResult.list;

    const eligibleTasks = tasks.filter((t) => passesChips(t, filterEvalCtx, { bypassDefaults: true }));
    const lowerQuery = deferredSearchQuery.trim().toLowerCase();
    // Keep the urgent pass on small metadata fields; descriptions and summaries can
    // contain enough text to block an input frame across a large task collection.
    // `created:…` / `updated:…` name the task's own dates, which are never stored as tags.
    const metadataMatches = eligibleTasks.filter((t) => taskMatchesLiterally(t, lowerQuery) || taskMatchesDateTag(t, lowerQuery));

    if (!searchResults) {
      const metadataTaskIds = new Set(metadataMatches.map((task) => task.id));
      return [
        ...metadataMatches,
        ...eligibleTasks.filter((task) =>
          !metadataTaskIds.has(task.id)
          && taskReferenceMatchField(task, deferredSearchQuery) !== null
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
    //
    // No open-before-done partition on top (removed 2026-08-26 by user request):
    // order is pure relevance rank, so a completed task that IS the best match
    // ranks above barely-relevant open ones. Live work stays competitive via
    // the server's completedLivenessPenalty (core/search.ts, 2026-08-28) —
    // stale completed matches sink within their coverage tier, strong exact
    // matches are structurally exempt.
    const serverMatches = mapServerTaskSearchResults(
      eligibleTasks,
      searchResults.map((result) => result.taskId),
    );
    const metadataTaskIds = new Set(metadataMatches.map((task) => task.id));
    return [
      ...metadataMatches,
      ...serverMatches.filter((task) => !metadataTaskIds.has(task.id)),
    ];
  }, [tasks, filterResult.list, isSearchMode, deferredSearchQuery, searchResults, filterEvalCtx]);

  // Completed results (search only): a finished task must be findable by its own
  // title (2026-09-23: a done task titled with the exact query was hidden, with
  // nothing on screen saying so), but a broad query used to bury live work under
  // strikethrough history. So up to three completed title hits show inline after
  // the open ones, other completed hits that show the query wait behind
  // "Completed (N)", and loose ones behind the "✓ Done N" chip, which reveals
  // everything in PURE relevance order (user ruling 2026-08-31). Both reveals are
  // per-search. See arrangeSearchResults in search-relevance.ts.
  // Tasks completed THIS session keep their grace slot in the open list so
  // checking a box in search results doesn't rip the row out from under the
  // cursor (same recentlyCompleted grace the plain list uses).
  const searchOpenMatches = useMemo(
    () => searchMatches.filter((t) => t.status !== 'done' || recentlyCompletedRef.current.has(t.id)),
    [searchMatches],
  );
  const [showDoneResults, setShowDoneResults] = useState(false);
  // Include Complete lives in the filter row and only while Status is default (5.7).
  const statusIsDefault = isDefaultStatus(filterState.status);
  useEffect(() => {
    if (!isSearchMode) setShowDoneResults(false);
  }, [isSearchMode]);

  // Server hits that don't show the query in their own text fold into one
  // "Related (N)" row; a quick-lane hit never folds.
  const [showRelatedResults, setShowRelatedResults] = useState(false);
  const [showCompletedResults, setShowCompletedResults] = useState(false);
  useEffect(() => { setShowRelatedResults(false); setShowCompletedResults(false); }, [deferredSearchQuery]);
  const searchSplit = useMemo(() => {
    if (!isSearchMode) return { primary: searchOpenMatches, completed: [] as Task[], related: [] as Task[], looseDone: 0 };
    const lowerQuery = deferredSearchQuery.trim().toLowerCase();
    const openIds = new Set(searchOpenMatches.map((task) => task.id));
    const evidenced = new Set(searchResults?.filter((result) => result.showsQuery).map((result) => result.taskId));
    const isLiteral = (task: Task) => taskMatchesLiterally(task, lowerQuery) || taskMatchesDateTag(task, lowerQuery);
    return arrangeSearchResults(searchMatches, {
      isOpen: (task) => openIds.has(task.id),
      isLiteral,
      // Before the server answers, every match is a literal hit or an exact reference.
      showsQuery: (task) => !searchResults || isLiteral(task) || evidenced.has(task.id),
      titlePosition: (task) => {
        const at = task.title.toLowerCase().indexOf(lowerQuery);
        return at < 0 ? Infinity : at;
      },
      completedAt: (task) => task.completed_at,
    }, showDoneResults || !statusIsDefault);
  }, [searchOpenMatches, searchMatches, showDoneResults, statusIsDefault, isSearchMode, searchResults, deferredSearchQuery]);
  // Include Complete (C56) counts every completed hit of the search, inline,
  // folded or loose: it is the one switch that brings them all in rank order.
  const searchDoneCount = isSearchMode ? searchMatches.length - searchOpenMatches.length : 0;

  // Counts and cross-section visibility use the complete match set, but the main
  // list mounts a bounded number of rows so neither search phase can stall typing.
  const searchFiltered = useMemo(
    () => searchSplit.primary.slice(0, 40),
    [searchSplit],
  );
  const searchCompletedRows = useMemo(
    () => (showCompletedResults ? searchSplit.completed.slice(0, 40) : []),
    [searchSplit, showCompletedResults],
  );
  const searchRelatedRows = useMemo(
    () => (showRelatedResults ? searchSplit.related.slice(0, 40) : []),
    [searchSplit, showRelatedResults],
  );

  // Count of search results (for display) — counts what the list SHOWS; the
  // Done chip and the Completed / Related rows carry the hidden remainder.
  const searchResultCount = isSearchMode
    ? searchSplit.primary.length
      + (showCompletedResults ? searchSplit.completed.length : 0)
      + (showRelatedResults ? searchSplit.related.length : 0)
    : null;

  // Pinned membership and ordering stay based on the complete tier arrays. Filters only
  // constrain the rendered IDs so hidden cards keep their stable pin position.
  //
  // The same board predicate as the list, so a Project chip scopes the pin area,
  // Pinned, the tier views and Recent too (spec D10, 4.3).
  // FROZEN during a pinned drag: this membership set derives from the live
  // `tasks` array, so external churn (WS echoes / refetches) would otherwise
  // change the SortableContext items / remount cards mid-drag (→ React #185 via
  // dnd-kit useRect). Tier ORDER is separately frozen by the drag ref
  // (dragTierIdsRef) — freezing membership here completes the invariant.
  // The focus-override task (a locate, or a task created under the chips, 5.11)
  // stays in its tier too, so a Pinned or tier view keeps it on screen with its
  // reasons; it is never a hit, so the counts below leave it out (4.6).
  const overrideOnlyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of [filterOverrideId, fadingOverrideId]) {
      const t = id ? tasks.find((x) => x.id === id) : undefined;
      if (t && !passesBoard(t)) ids.add(t.id);
    }
    return ids;
  }, [filterOverrideId, fadingOverrideId, tasks, passesBoard]);
  const visibleTaskIdsLive = useMemo(
    () => new Set(
      (isSearchMode ? searchMatches : tasks.filter((t) => overrideOnlyIds.has(t.id) || passesBoard(t))).map((task) => task.id),
    ),
    [tasks, isSearchMode, searchMatches, passesBoard, overrideOnlyIds],
  );
  const visibleTaskIds = useFrozenWhile(visibleTaskIdsLive, isPinnedDragActive);
  // ONE source for every tier consumer below (tier id lists, display arrays, tab
  // badges, section mount conditions); the All list dedupes against it.
  const tierVisibleTaskIds = visibleTaskIds;
  const [showStaleDonePins, setShowStaleDonePins] = useState(false);
  useEffect(() => {
    if (!isSearchMode) setShowStaleDonePins(false);
  }, [isSearchMode]);
  // Stale-done-pin folding (search only): the tiers directly show a done pin
  // only while its completion is fresh (≤30d); older matches fold into a
  // one-line count so a broad query's first screen isn't a wall of
  // strikethrough history. They stay findable in the ranked list below.
  const staleDoneIds = useMemo(
    () => (isSearchMode ? staleDonePinIds(pinnedTasks) : EMPTY_ID_SET),
    [isSearchMode, pinnedTasks],
  );
  const staleDonePinMatchCount = useMemo(() => {
    if (!isSearchMode) return 0;
    let n = 0;
    for (const id of staleDoneIds) if (tierVisibleTaskIds.has(id)) n += 1;
    return n;
  }, [isSearchMode, staleDoneIds, tierVisibleTaskIds]);
  const tierDisplayTaskIds = useMemo(() => {
    if (!isSearchMode || showStaleDonePins || staleDonePinMatchCount === 0) return tierVisibleTaskIds;
    const next = new Set(tierVisibleTaskIds);
    for (const id of staleDoneIds) next.delete(id);
    return next;
  }, [isSearchMode, showStaleDonePins, staleDonePinMatchCount, tierVisibleTaskIds, staleDoneIds]);
  const displayedPinIds = useMemo(
    () => new Set(pinnedTasks.filter(task => tierDisplayTaskIds.has(task.id)).map(task => task.id)),
    [pinnedTasks, tierDisplayTaskIds],
  );
  const dedupePinned = isAll && !isSearchMode;
  const filtered = useMemo(() => {
    const list = filterResult.list;
    if (!dedupePinned || displayedPinIds.size === 0) return list;
    const keep = new Set<string>();
    const dropped: Task[] = [];
    for (const task of list) {
      if (displayedPinIds.has(task.id)) dropped.push(task);
      else keep.add(task.id);
    }
    // Retained children still need their pinned ancestors in the project list.
    let added = true;
    while (added) {
      added = false;
      for (const task of list) {
        if (!keep.has(task.id) || !task.parent_task_id) continue;
        for (const parent of dropped) {
          if (keep.has(parent.id) || !parent.id.startsWith(task.parent_task_id)) continue;
          keep.add(parent.id);
          added = true;
        }
      }
    }
    return list.filter(task => keep.has(task.id));
  }, [filterResult.list, dedupePinned, displayedPinIds]);
  const visibleRecentTasks = useMemo(
    () => recentTasks.filter((task) => visibleTaskIds.has(task.id)),
    [recentTasks, visibleTaskIds],
  );
  const visibleRecentIds = useMemo(
    () => visibleRecentTasks.map(recentStaticId),
    [recentStaticId, visibleRecentTasks],
  );
  const recentProjectCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of visibleRecentTasks) map.set(t.project || '', (map.get(t.project || '') ?? 0) + 1);
    return map;
  }, [visibleRecentTasks]);
  // Projects with a visible card per tier, AT REST (frozen for a pinned drag): which
  // project labels a tier draws. Frozen so a label never comes or goes under a live
  // drag, the way the old plain-DOM labels read their set from tierIdsAtRest.
  const labelProjectsLive = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (tier: string, arr: string[]) => {
      const set = new Set<string>();
      for (const id of arr) {
        if (!tierDisplayTaskIds.has(id)) continue;
        const t = pinnedTaskMap.get(id);
        if (t) set.add(t.project || '');
      }
      map.set(tier, set);
    };
    add('focus', focusIds_arr); add('satellite', satelliteIds_arr); add('wait', waitIds_arr);
    for (const def of customTiers ?? []) add(def.id, customIds_arr[def.id] ?? []);
    return map;
  }, [focusIds_arr, satelliteIds_arr, waitIds_arr, customIds_arr, customTiers, tierDisplayTaskIds, pinnedTaskMap]);
  const labelProjects = useFrozenWhile(labelProjectsLive, isPinnedDragActive);
  // A tier's rows that pass the filters, plus the chips, lines and labels that still
  // head something visible.
  const shownTierIds = useCallback((arr: string[], tier: string) => pruneTierLabels(
    pruneOrphanSentinels(
      arr.filter((id) => isGroupSentinel(id) || isSeparatorId(id) || isTierLabelId(id) || tierDisplayTaskIds.has(id)),
      pinnedTaskMap, activeDragPinnedId, folderParents,
    ),
    labelProjects.get(tier),
  ), [tierDisplayTaskIds, pinnedTaskMap, activeDragPinnedId, folderParents, labelProjects]);
  // Folder chains drawn as one "A / B" row per tier (folderChains), AT REST: frozen for
  // a pinned drag like the labels, so no heading splits or merges under the pointer
  // (collapse-on-drag takes a dragged folder's rows out of the arrays mid-gesture).
  const tierChainsLive = useMemo(() => {
    const map = new Map<string, Map<string, string[]>>();
    if (folderParents.size === 0) return map;
    const folderOf = (id: string) => pinnedTaskMap.get(id)?.group_id || undefined;
    const add = (tier: string, arr: string[]) => {
      const chains = folderChains(shownTierIds(arr, tier), folderOf, folderParents);
      if (chains.size > 0) map.set(tier, chains);
    };
    add('focus', focusIds_arr); add('satellite', satelliteIds_arr); add('wait', waitIds_arr);
    for (const def of customTiers ?? []) add(def.id, customIds_arr[def.id] ?? []);
    return map;
  }, [focusIds_arr, satelliteIds_arr, waitIds_arr, customIds_arr, customTiers, shownTierIds, pinnedTaskMap, folderParents]);
  const tierChains = useFrozenWhile(tierChainsLive, isPinnedDragActive);
  useLayoutEffect(() => { tierChainsRef.current = tierChains; }, [tierChains]);
  // A tier's sortable ids as drawn: a chain's row is its top folder's chip alone.
  const visibleTierIds = useCallback(
    (arr: string[], tier: string) => withoutChainedChips(shownTierIds(arr, tier), tierChains.get(tier)),
    [shownTierIds, tierChains],
  );
  const visibleFocusIds = useMemo(() => visibleTierIds(focusIds_arr, 'focus'), [focusIds_arr, visibleTierIds]);
  const visibleSatelliteIds = useMemo(() => visibleTierIds(satelliteIds_arr, 'satellite'), [satelliteIds_arr, visibleTierIds]);
  const visibleWaitIds = useMemo(() => visibleTierIds(waitIds_arr, 'wait'), [waitIds_arr, visibleTierIds]);
  // Per-custom-tier render model: visible ids + display tasks + group meta in one
  // memo (the built-ins keep their three separate memos; a custom tier bundles them
  // because the set of tiers itself is dynamic).
  const customTierRender = useMemo(() => {
    const map: Record<string, { visibleIds: string[]; display: Task[]; groupMeta: Map<string, GroupRenderInfo> }> = {};
    for (const def of customTiers ?? []) {
      const visibleIds = visibleTierIds(customIds_arr[def.id] ?? [], def.id);
      const display = visibleIds.map((id) => pinnedTaskMap.get(id)).filter((task): task is Task => !!task);
      map[def.id] = { visibleIds, display, groupMeta: buildTierGroupMeta(display, taskGroups, chainedParents(folderParents, tierChains.get(def.id))) };
    }
    return map;
  }, [customTiers, customIds_arr, visibleTierIds, pinnedTaskMap, taskGroups, folderParents, tierChains]);
  // tier id → its visible render ids, for logic that must work for ANY tier
  // (separator placement) instead of naming the three built-ins.
  const tierIdsByTier = useMemo(() => {
    const map = new Map<string, string[]>();
    map.set('focus', visibleFocusIds);
    map.set('satellite', visibleSatelliteIds);
    map.set('wait', visibleWaitIds);
    for (const def of customTiers ?? []) map.set(def.id, customTierRender[def.id]?.visibleIds ?? []);
    return map;
  }, [visibleFocusIds, visibleSatelliteIds, visibleWaitIds, customTiers, customTierRender]);
  // The same map, frozen for the duration of a pinned drag. renderTierItems derives
  // the project label set (and its per-project counts) from HERE, never from the
  // arrays it walks: collapse-on-drag REMOVES a dragged folder's member ids from every
  // tier array, so a tier whose second project lives entirely inside that folder drops
  // to ONE distinct project mid-drag → showFolders goes false → every folded run in the
  // tier un-hides, injecting rows under the pointer after dnd-kit already measured its
  // rects, and the labels the drag is supposed to keep disappear.
  // Freezing (the same isPinnedDragActive signal foldersInert reads) is smaller than
  // rebuilding an at-rest cluster inside the callback, and it also keeps the count
  // badges still: one gesture, one label set, exactly like the inert labels promise.
  const tierIdsAtRest = useFrozenWhile(tierIdsByTier, isPinnedDragActive);
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
    () => buildTierGroupMeta(focusTasksDisplay, taskGroups, chainedParents(folderParents, tierChains.get('focus'))),
    [focusTasksDisplay, taskGroups, folderParents, tierChains],
  );
  const satelliteGroupMeta = useMemo(
    () => buildTierGroupMeta(satelliteTasksDisplay, taskGroups, chainedParents(folderParents, tierChains.get('satellite'))),
    [satelliteTasksDisplay, taskGroups, folderParents, tierChains],
  );
  const waitGroupMeta = useMemo(
    () => buildTierGroupMeta(waitTasksDisplay, taskGroups, chainedParents(folderParents, tierChains.get('wait'))),
    [waitTasksDisplay, taskGroups, folderParents, tierChains],
  );

  // --- Parent-anchored sort with child grouping ---
  // Produces a sorted ID order where children always follow their parent.
  const computeSortOrder = useCallback((items: Task[]): string[] => {
    // Partition tasks into top-level (+ orphans) vs children-of-visible-parent
    const topLevel: Task[] = [];
    const childrenOf = new Map<string, Task[]>();

    // Build a prefix→fullId lookup so parent_task_id (short prefix) resolves to the actual parent
    const fullIds = items.map((t) => t.id);
    const byId = new Map(items.map((t) => [t.id, t]));
    const resolveParent = (prefix: string): string | undefined =>
      fullIds.find((id) => id.startsWith(prefix));

    for (const task of items) {
      if (!task.parent_task_id) {
        topLevel.push(task);
        continue;
      }
      // parent_task_id may be a short prefix (e.g. "mlk71mm5") — resolve via prefix match.
      // Nesting stays inside one project: a subtask filed into another project
      // is a top-level row there (the list buckets rows by project below, so
      // nesting it would move it under the parent's project header).
      const parentFullId = resolveParent(task.parent_task_id);
      const parentTask = parentFullId ? byId.get(parentFullId) : undefined;
      if (parentFullId && parentTask && sameProjectKey(parentTask.project, task.project)) {
        let siblings = childrenOf.get(parentFullId);
        if (!siblings) { siblings = []; childrenOf.set(parentFullId, siblings); }
        siblings.push(task);
      } else {
        // Orphan: parent not in filtered set — render as top-level
        topLevel.push(task);
      }
    }

    // Manual mode: keep store order as-is. Priority/date/updated: re-sort siblings.
    // Each project sorts by its own order; projects are drawn in the project order
    // (grouped below), so how their runs interleave here does not matter.
    const sortRun = (run: Task[], mode: SortBy) => { if (mode !== 'manual') run.sort(TASK_COMPARATORS[mode] ?? compareDate); };
    if (groupBy === 'project') {
      const runs = new Map<string, Task[]>();
      for (const task of topLevel) {
        const key = task.project || '';
        const run = runs.get(key);
        if (run) run.push(task); else runs.set(key, [task]);
      }
      topLevel.length = 0;
      for (const [project, run] of runs) { sortRun(run, sortForProject(project)); topLevel.push(...run); }
      for (const children of childrenOf.values()) sortRun(children, sortForProject(children[0]?.project || ''));
    } else {
      sortRun(topLevel, sortBy);
      for (const children of childrenOf.values()) sortRun(children, sortBy);
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
    // A1 ordering: loose tasks first, folder clusters sink AFTER them. The
    // main list buckets this order by project, so within every project the
    // loose tasks render on top and folders collect at the bottom.
    for (const task of topLevel) {
      if (visited.has(task.id) || task.group_id) continue;
      emitWithChildren(task);
    }
    const clustered: Task[] = [];
    for (const task of topLevel) {
      if (visited.has(task.id) || !task.group_id) continue;
      // Group lead: take the whole cluster contiguously, then mark it done so
      // later members are skipped in place.
      if (emittedGroups.has(task.group_id)) continue;
      emittedGroups.add(task.group_id);
      clustered.push(...(groupTopMembers.get(task.group_id) ?? [task]));
    }
    // A subfolder's cluster goes inside its parent folder's (pre-order).
    for (const m of nestFolderUnits(clustered, (t) => t.group_id || undefined, folderParents)) emitWithChildren(m);
    return order;
  }, [sortBy, groupBy, sortForProject, folderParents]);

  // --- Debounced sort order ---
  // Badge/data updates instantly (always use latest `filtered` task objects).
  // Only the POSITION (sort order) is debounced by 3s on reorder-only changes.
  const [sortOrder, setSortOrder] = useState<string[]>(() => computeSortOrder(filtered));
  // The sort settings the current order was computed with (computeSortOrder is rebuilt
  // exactly when sortBy, groupBy or a project's own order changes).
  const sortSettingsRef = useRef(computeSortOrder);
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

    // Sort settings changed or structural change (IDs added/removed): flush immediately
    const currIds = new Set(filtered.map((t) => t.id));
    const prevIds = prevFilteredIdsRef.current;
    const structural = currIds.size !== prevIds.size || !filtered.every((t) => prevIds.has(t.id));
    if (sortSettingsRef.current !== computeSortOrder || structural) {
      sortSettingsRef.current = computeSortOrder;
      prevFilteredIdsRef.current = currIds;
      stableSortUpdate(newOrder);
      return;
    }
    prevFilteredIdsRef.current = currIds;

    // Manual order: store order IS the truth, so a change among manually ordered
    // tasks (a drag, Move up) lands at once. A stray debounced re-sort must never
    // override the user's drag result. Projects can mix modes, hence the projection.
    const manualIds = new Set(filtered.filter((t) => sortForProject(t.project || '') === 'manual').map((t) => t.id));
    if (manualIds.size > 0) {
      setSortOrder((prev) => {
        const was = prev.filter((id) => manualIds.has(id));
        const now = newOrder.filter((id) => manualIds.has(id));
        const moved = was.length !== now.length || was.some((id, i) => id !== now[i]);
        return moved ? newOrder : prev;
      });
    }

    // Same set of tasks, just reordered (e.g. priority change): debounce 3s
    const timer = setTimeout(() => stableSortUpdate(newOrder), 3000);
    return () => clearTimeout(timer);
  }, [filtered, computeSortOrder, sortForProject, stableSortUpdate]);

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
  // The bottom name-entry row is mounted only while this is set (the Projects
  // heading's "New project..." sets it; the row's Esc / empty blur / create clears it).
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const closeNewProject = useCallback(() => setNewProjectOpen(false), []);
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

  /**
   * Moving a folder to another project, wrapped so the DESTINATION gets a bucket.
   *
   * `grouped` below only builds a project group for projects that own a displayed
   * task (plus freshProjects), so a folder moved into a project with no visible
   * tasks (an empty folder, or members the current filters hide) had nowhere to
   * render and simply vanished from the panel until the next reload. Registering
   * the destination through the SAME mechanism the New Project row uses keeps the
   * folder on screen, in its new home.
   *
   * Two guards: Inbox ('') is skipped, since freshProjects holding '' would
   * duplicate the Inbox bucket the memo appends by itself; and registration waits
   * for the server's answer, so a refused (or duplicate, in-flight) move leaves no
   * phantom empty group behind.
   */
  const requestMoveFolder = useCallback(async (groupId: string, project: string): Promise<boolean> => {
    if (!onMoveFolderToProject) return false;
    // The move takes the folder's whole subtree, so it migrates every synced card in
    // it whose provider the destination does not share: ONE confirm for all of them,
    // fail-closed while the registry is unloaded (the rule requestMoveTask follows).
    const moving = tasks.filter((t) => folderWithin(t.group_id, groupId, folderParents) && !sameProjectKey(t.project, project));
    const migrating = moving.filter(
      (t) => resolveMoveMigration(t.source, project, projectRegistry.sourceByName).migrates
        || (!projectRegistry.loaded && (t.source ?? 'local') !== 'local'),
    ).length;
    if (migrating > 0) {
      const ok = await confirm({
        title: 'Move across providers?',
        message: `${migrating} of the ${moving.length} tasks in “${taskGroups?.[groupId] ?? 'this folder'}” cross a provider boundary. Their original tasks will be archived (renamed “[Moved]” and marked complete).`,
        confirmLabel: 'Move',
      });
      if (!ok) return false;
    }
    const accepted = await Promise.resolve(onMoveFolderToProject(groupId, project));
    if (accepted === false) return false;
    if (migrating > 0) projectRegistry.refresh();
    if (project) setFreshProjects((prev) => (prev.includes(project) ? prev : [...prev, project]));
    return true;
  }, [onMoveFolderToProject, tasks, folderParents, taskGroups, projectRegistry.sourceByName, projectRegistry.loaded, projectRegistry.refresh, confirm]);
  useLayoutEffect(() => { requestMoveFolderRef.current = requestMoveFolder; }, [requestMoveFolder]);
  const handleMoveFolderToProject = useCallback((groupId: string, project: string) => {
    void requestMoveFolder(groupId, project);
  }, [requestMoveFolder]);

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
  const trueChildCountMap = useMemo(() => countSubtasksByParent(tasks), [tasks]);

  const { childTaskIds, childParentMap, depthMap } = useMemo(() => {
    const childIds = new Set<string>();
    const parentMap = new Map<string, string>(); // childId → parentFullId
    for (const task of sorted) {
      if (task.parent_task_id) {
        // Find parent — match by prefix (parent_task_id may be a short prefix)
        const parentId = task.parent_task_id;
        const parent = resolveParentRef(sorted, parentId);
        // Same project only, as computeSortOrder nests: a cross-project subtask
        // is a top-level row in its own project, never indented or folded away.
        if (parent && sameProjectKey(parent.project, task.project)) {
          childIds.add(task.id);
          parentMap.set(task.id, parent.id);
        }
        // If parent not visible (or in another project) → orphan: no childIds entry, renders as top-level
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
  // Empty folders per project (lower-cased key): registry entries with zero live
  // members. They have no task rows to anchor a chip to, so the bucket renders
  // them as standalone droppable rows. Live membership beats the (possibly
  // stale) fetched memberCount — a just-emptied folder shows up immediately.
  const emptyFoldersByProject = useMemo(() => {
    const map = new Map<string, Array<{ groupId: string; label: string }>>();
    if (!folderMeta) return map;
    const liveMembership = new Set<string>();
    for (const t of tasks) if (t.group_id) liveMembership.add(t.group_id);
    for (const [gid, meta] of Object.entries(folderMeta)) {
      if (liveMembership.has(gid)) continue;
      const key = (meta.project ?? '').toLowerCase();
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push({ groupId: gid, label: taskGroups?.[gid] ?? gid });
    }
    return map;
  }, [folderMeta, taskGroups, tasks]);

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
        count: counts.get(gid) ?? 0,
      });
    });
    addFolderNesting(map, sorted, taskGroups, folderParents);
    return map;
  }, [sorted, taskGroups, folderParents]);

  // Folder folds. Each tier and the Projects list fold a folder on their own
  // (place-folds.ts), so a folder shown in two places never folds the copy above
  // the click. Persisted so a fold survives reloads. The folder header row stays
  // and carries the chevron; member rows get .task-folder-collapsed (display:none)
  // so dnd ids stay mounted.
  const [folderFolds, setFolderFolds] = useState<ReadonlySet<string>>(() => readFolds(LS_FOLDER_FOLDS_KEY, LS_LEGACY_FOLDER_FOLDS_KEY));
  // Prune on write: the set is otherwise append-only, so every folder the user
  // ever folded and later DELETED stays in localStorage for good. Skipped until a
  // registry has actually loaded, or the first toggle after a cold boot (empty
  // registries) would wipe every remembered fold.
  const foldersKnown = useMemo(
    () => new Set([...Object.keys(taskGroups ?? {}), ...Object.keys(folderMeta ?? {})]),
    [taskGroups, folderMeta],
  );
  const toggleFolder = useCallback((place: string, groupId: string) => {
    setFolderFolds((prev) => {
      const kept = foldersKnown.size > 0
        ? pruneFolds(prev, (key) => foldedId(key) === groupId || foldersKnown.has(foldedId(key)))
        : prev;
      const next = toggleFold(kept, place, groupId, [...allTierKeysRef.current, LIST_PLACE]);
      saveFolds(LS_FOLDER_FOLDS_KEY, next);
      return next;
    });
  }, [foldersKnown]);
  const toggleListFolder = useCallback((groupId: string) => toggleFolder(LIST_PLACE, groupId), [toggleFolder]);

  // taskId → its folder id, for the ancestor walk below. Built from `sorted` (the
  // rows actually drawn), the same source the folder header/collapse logic uses.
  const groupIdByTaskId = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of sorted) if (t.group_id) m.set(t.id, t.group_id);
    return m;
  }, [sorted]);

  /**
   * Is this row inside a folded folder? Its OWN folder, or the folder of any
   * ANCESTOR task. The second half is the fix: a folder member's SUBTASK carries
   * no group_id, so checking `task.group_id` alone kept subtask rows drawn under a
   * parent row the fold had already hidden. Same parent-chain walk as
   * isChildHidden below, with the same depth cap guarding a cycle.
   */
  const isRowFolderCollapsed = useCallback((taskId: string) => {
    if (folderFolds.size === 0) return false;
    let currentId: string | undefined = taskId;
    for (let hops = 0; currentId && hops <= 10; hops++) {
      const gid = groupIdByTaskId.get(currentId);
      // Its folder, or any folder ABOVE it in the folder tree.
      if (gid && (isFoldedAt(folderFolds, LIST_PLACE, gid)
        || folderAncestors(gid, folderParents).some((a) => isFoldedAt(folderFolds, LIST_PLACE, a)))) return true;
      currentId = childParentMap.get(currentId);
    }
    return false;
  }, [folderFolds, groupIdByTaskId, childParentMap, folderParents]);

  // The fold state on top of groupRenderMap for the main list's headings: a
  // folder's heading hides when an ANCESTOR folder is folded, while the folded
  // folder's own heading stays as the way back. Only nested leads get a new
  // object, so a flat board hands every row the very same groupInfo as before.
  const listGroupInfo = useMemo(() => {
    if (folderParents.size === 0) return groupRenderMap;
    const folded = (gid: string) => isFoldedAt(folderFolds, LIST_PLACE, gid);
    const underFold = (gid: string) => folderAncestors(gid, folderParents).some(folded);
    const map = new Map(groupRenderMap);
    for (const [id, info] of groupRenderMap) {
      if (!info.isLead || (!info.depth && !info.heads)) continue;
      map.set(id, {
        ...info,
        headerHidden: underFold(info.groupId),
        ...(info.heads ? { heads: info.heads.map((h) => ({ ...h, collapsed: folded(h.groupId), hidden: underFold(h.groupId) })) } : {}),
      });
    }
    return map;
  }, [groupRenderMap, folderFolds, folderParents]);

  // Determine if a child task should be hidden (any ancestor is collapsed, walks full chain)
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

  // A tier's project label row folds that tier's run only, so the rows above the
  // click never move. The main list keeps its own record (`listOpen`, folded by
  // default). Both survive a reload. useCallback because the tier render pass
  // depends on it.
  const toggleRun = useCallback((tier: string, project: string) => {
    setRunFolds((prev) => {
      const next = toggleFold(prev, tier, project, allTierKeysRef.current);
      saveFolds(LS_RUN_FOLDS_KEY, next);
      return next;
    });
  }, []);

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

  // A query's hits must be on screen, so while one is active every project group
  // starts open and folds only for that query; the saved fold set is untouched.
  const queryActive = homeFilters.chips.some((c) => c.dim !== 'date');
  const [queryFoldedProjects, setQueryFoldedProjects] = useState<Set<string>>(() => new Set());
  useEffect(() => { if (!queryActive) setQueryFoldedProjects(new Set()); }, [queryActive]);
  const isListProjectCollapsed = useCallback(
    (project: string) => queryActive ? queryFoldedProjects.has(project)
      : !listOpen.has(project) && !revealedProjects.has(project),
    [queryActive, queryFoldedProjects, listOpen, revealedProjects],
  );
  const toggleListProject = useCallback((project: string) => {
    if (queryActive) {
      setQueryFoldedProjects(prev => {
        const next = new Set(prev);
        if (next.has(project)) next.delete(project); else next.add(project);
        return next;
      });
      return;
    }
    const shown = !isListProjectCollapsed(project);
    if (shown) setListBatch(prev => { if (!prev.has(project)) return prev; const next = new Map(prev); next.delete(project); return next; });
    setRevealedProjects(prev => { if (!prev.has(project)) return prev; const next = new Set(prev); next.delete(project); return next; });
    setListOpen(prev => {
      const next = new Set(prev);
      if (shown) next.delete(project); else next.add(project);
      return saveListOpen(next);
    });
  }, [queryActive, isListProjectCollapsed]);

  const allCollapsed = liveGroupKeys.size > 0 &&
    [...liveGroupKeys].every(project => isListProjectCollapsed(project));

  const handleCollapseExpandAll = useCallback(() => {
    if (queryActive) { setQueryFoldedProjects(new Set<string>(allCollapsed ? [] : liveGroupKeys)); return; }
    setRevealedProjects(new Set());
    setListBatch(new Map());
    setListOpen(saveListOpen(new Set<string>(allCollapsed ? liveGroupKeys : [])));
    if (!allCollapsed) {
      setExpandedParents(new Set());
      persistSet(LS_EXPANDED_PARENTS_KEY, new Set());
    }
  }, [queryActive, allCollapsed, liveGroupKeys]);

  // Row batching (list-batch.ts). A folded folder's members stay drawn but unseen, so
  // they don't use up the batch; the "In one list" view batches under FLAT_BATCH_KEY.
  const countsTowardBatch = useCallback(
    (task: Task) => !isRowFolderCollapsed(task.id) || !!groupRenderMap.get(task.id)?.isLead,
    [isRowFolderCollapsed, groupRenderMap],
  );
  const cutRows = (key: string, rows: Task[]) => {
    const state = listBatch.get(key) ?? FRESH_BATCH;
    return cutListBatch(rows, state.limit, id => id === focusedTaskId || state.kept.has(id), countsTowardBatch);
  };
  const showMoreRows = useCallback((key: string) => {
    setListBatch(prev => {
      const state = prev.get(key) ?? FRESH_BATCH;
      return new Map(prev).set(key, { ...state, limit: state.limit + LIST_BATCH });
    });
  }, []);
  // The cut always draws the focused row; this keeps a row focused past the batch drawn
  // after focus moves on, so the list doesn't reshape under the next click.
  useEffect(() => {
    if (!focusedTaskId) return;
    const key = groupBy === 'none' ? FLAT_BATCH_KEY : taskGroupMap.get(focusedTaskId);
    if (key === undefined) return;
    const rows = (groupBy === 'none' ? sorted : grouped.find(g => g.project === key)?.tasks ?? [])
      .filter(t => !isChildHidden(t.id));
    const state = listBatch.get(key) ?? FRESH_BATCH;
    if (state.kept.has(focusedTaskId) || !isPastBatch(rows, state.limit, focusedTaskId, countsTowardBatch)) return;
    setListBatch(prev => {
      const current = prev.get(key) ?? FRESH_BATCH;
      return new Map(prev).set(key, { ...current, kept: new Set(current.kept).add(focusedTaskId) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a focus change keeps a row
  }, [focusedTaskId]);

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
    // The one exception: a card of ANOTHER folder. Dropping there moves the member
    // into that folder (addToGroup re-files it), never merges two folders.
    const activeGroup = tasks.find((t) => t.id === activeId)?.group_id;
    const overGroup = tasks.find((t) => t.id === overId)?.group_id;
    if (intent === 'group' && activeGroup && (!overGroup || overGroup === activeGroup)) {
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
  //
  // In the By-project list only the project the action happened in switches: every
  // project keeps its own order.
  const ensureManualSort = useCallback((project?: string) => {
    if (groupBy === 'project' && project !== undefined) {
      if (sortForProject(project) === 'manual') return;
      if (onBakeOrder && sortOrder.length > 0) onBakeOrder(sortOrder);
      setProjectSort(project, 'manual');
      showSortToast(`${project || 'Inbox'} switched to Manual order`);
      return;
    }
    if (sortBy !== 'manual') {
      if (onBakeOrder && sortOrder.length > 0) onBakeOrder(sortOrder);
      setSortBy('manual');
      persistSortBy('manual');
      showSortToast('Switched to Manual sort');
    }
  }, [groupBy, sortBy, sortForProject, setProjectSort, sortOrder, onBakeOrder, showSortToast]);

  // Cross-project move with a cross-provider gate: when the destination project is
  // claimed by a DIFFERENT provider, the backend migrates the task (old remote twin
  // archived as "[Moved]" + completed) — that is destructive enough to confirm first.
  // Same-provider (and local→provider folder-only) moves go straight through, and
  // are answered at once rather than as a promise: a drop that moves a card into
  // another project's folder then lands in the drop's own render, instead of drawing
  // the card back where it came from for a frame while the answer resolves.
  type MoveGate = { ok: boolean; migrates: boolean };
  const confirmProjectMove = useCallback((taskId: string, project: string): MoveGate | Promise<MoveGate> => {
    const task = tasks.find((t) => t.id === taskId);
    const mig = resolveMoveMigration(task?.source, project, projectRegistry.sourceByName);
    // Fail CLOSED while the registry hasn't loaded: with an empty sourceByName
    // every target reads "unknown → no migration", which would silently skip the
    // destructive confirm for provider tasks. Local tasks never migrate, so only
    // provider-sourced ones need the conservative ask.
    const claimUnknown = !projectRegistry.loaded && mig.from !== 'local';
    if (!mig.migrates && !claimUnknown) return { ok: true, migrates: false };
    const fromName = sourceDisplayName(mig.from);
    return confirm({
      title: 'Move across providers?',
      message: mig.migrates
        ? `“${task?.title ?? taskId}” moves from ${fromName} to ${sourceDisplayName(mig.to)}. The original ${fromName} task will be archived (renamed “[Moved]” and marked complete). Same-provider subtasks move along with it.`
        : `“${task?.title ?? taskId}” is a ${fromName} task and “${project || 'Inbox'}” may belong to a different provider (the project list hasn't loaded). If it does, the original ${fromName} task will be archived (renamed “[Moved]” and marked complete).`,
      confirmLabel: 'Move',
    }).then((ok) => ({ ok, migrates: mig.migrates }));
  }, [tasks, projectRegistry.sourceByName, projectRegistry.loaded, confirm]);

  const requestMoveTask = useCallback(async (
    taskId: string,
    project: string,
    opts?: { insertNearTaskId?: string; ensureSort?: boolean },
  ): Promise<boolean> => {
    if (!onMoveTask) return false;
    const { ok, migrates } = await confirmProjectMove(taskId, project);
    if (!ok) return false;
    // Only a CONFIRMED move switches the list to manual sort — a cancelled one must
    // leave the user's sort mode alone.
    if (opts?.ensureSort) ensureManualSort(project);
    onMoveTask(taskId, project, opts?.insertNearTaskId);
    // A migration rewrites the destination project's claim server-side without a
    // project:created event, so the registry snapshot goes stale — refresh it or
    // the NEXT move's confirm decision can be wrong in either direction.
    if (migrates) projectRegistry.refresh();
    return true;
  }, [onMoveTask, confirmProjectMove, projectRegistry.refresh, ensureManualSort]);
  // Published for handlePinnedDragEnd, which is declared above this point. Layout
  // effect, not a render-phase write: this component uses startTransition, and a
  // discarded concurrent render must not leave its abandoned closure in the ref.
  useLayoutEffect(() => { requestMoveTaskRef.current = requestMoveTask; }, [requestMoveTask]);

  // A drop into a folder: `into` is the folder, or a loose card to start one
  // with. A folder belongs to one project, so a task from another project moves
  // into it as it joins, behind the same cross-provider confirm as any move.
  // `place` is the write that puts the card where it was dropped (its pin order). It
  // runs with the filing, synchronously when nothing asks first, so both land in one
  // render, and its request goes out FIRST: the filing waits for it, so the list the
  // filing then refetches already holds that order.
  const requestFileIntoFolder = useCallback(async (
    taskId: string,
    into: { groupId: string; project: string } | { withTaskId: string; project: string },
    place?: () => unknown,
  ): Promise<boolean> => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;
    const moving = !sameProjectKey(task.project, into.project);
    let migrates = false;
    if (moving) {
      const asked = confirmProjectMove(taskId, into.project);
      const gate = asked instanceof Promise ? await asked : asked;
      if (!gate.ok) return false;
      migrates = gate.migrates;
    }
    const opts = moving ? { moveInto: into.project } : undefined;
    const placed = place ? Promise.resolve(place()) : undefined;
    if ('groupId' in into) onAddToGroup?.(into.groupId, [taskId], { ...opts, after: placed });
    else onGroupTasks?.([into.withTaskId, taskId], undefined, opts);
    if (migrates) projectRegistry.refresh();
    return true;
  }, [tasks, confirmProjectMove, onAddToGroup, onGroupTasks, projectRegistry.refresh]);
  useLayoutEffect(() => { requestFileIntoFolderRef.current = requestFileIntoFolder; }, [requestFileIntoFolder]);

  /**
   * A folder chip dropped on another folder's chip nests it there (the whole subtree
   * moves with it). A folder belongs to one project, so a folder from another project
   * first moves into the target's project (its members too, through
   * moveFolderToProject) and nests once that landed. Into itself or into one of its
   * own descendants is nothing; depth is the server's call and comes back as an error.
   */
  const nestFolder = useCallback(async (groupId: string, intoGroupId: string): Promise<boolean> => {
    if (!onSetFolderParent || groupId === intoGroupId) return false;
    if (folderWithin(intoGroupId, groupId, folderParents)) return false;
    const own = folderMeta?.[groupId];
    const target = folderMeta?.[intoGroupId];
    if (!own || !target) return false;
    if (own.parent_id === intoGroupId) return false;
    if (!sameProjectKey(own.project, target.project) && !(await requestMoveFolder(groupId, target.project))) return false;
    onSetFolderParent(groupId, intoGroupId);
    return true;
  }, [onSetFolderParent, requestMoveFolder, folderMeta, folderParents]);
  useLayoutEffect(() => { nestFolderRef.current = nestFolder; }, [nestFolder]);

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

    // ── Drag-into-group (Main list) ── A left-zone drop on a foldered task card
    // joins its folder. This takes precedence over reparent/reorder (which run for
    // every other drop). A folder belongs to one project, so a card from another
    // project moves into the target's project as it joins (requestFileIntoFolder).
    // A member of another folder moves over (addToGroup re-files it, nothing merges).
    // GUARD: a grouped member dropped on a LOOSE card must NOT group-merge (groupTasks
    // ABSORBS the member's whole group + the target — the reported bug); it falls
    // through to the drag-OUT block below.
    if (groupDrop && String(over.id) === groupDrop && groupDrop !== String(active.id)) {
      const activeId = String(active.id);
      const overTask = tasks.find((t) => t.id === groupDrop);
      const activeTask = tasks.find((t) => t.id === activeId);
      // Only a FOLDERED card is a join target here. Unlike the pinned tiers, the
      // main list has no middle-band test (every hovered card lights), so a drop
      // on a loose card must stay a reorder; making a folder of two loose tasks
      // is the pinned tiers' and multi-select's job.
      if (overTask?.group_id && activeTask && activeTask.group_id !== overTask.group_id && onAddToGroup) {
        const project = folderMeta?.[overTask.group_id]?.project ?? overTask.project ?? '';
        requestFileIntoFolder(activeId, { groupId: overTask.group_id, project }).catch((err) => {
          onOperationError?.(err instanceof Error ? err.message : 'Move failed');
        });
        return;
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

    // Dropped on an EMPTY folder row → file the task as its first member. A
    // task from another project moves into the folder's project as it joins,
    // the same as a drop onto a member card.
    if (overId.startsWith(EMPTY_FOLDER_DROP_PREFIX)) {
      const folderData = over.data?.current as { groupId?: string; project?: string } | undefined;
      if (folderData?.groupId && onAddToGroup) {
        requestFileIntoFolder(activeId, { groupId: folderData.groupId, project: folderData.project ?? '' }).catch((err) => {
          onOperationError?.(err instanceof Error ? err.message : 'Move failed');
        });
      }
      return;
    }

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
        ensureManualSort(activeTaskProject);
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
      ensureManualSort(activeTaskProject);

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
  }, [onReorder, onReparentTask, ordering, taskGroupMap, grouped, fullGrouped, sorted, childParentMap, trueChildCountMap, ensureManualSort, requestMoveTask, nestTargetId, groupTargetId, clearDropIntent, tasks, onAddToGroup, onGroupTasks, onOperationError, requestFileIntoFolder, folderMeta]);

  // Kebab "Move left" — promote subtask to top-level via onReparentTask(id, null).
  // Also primes scroll restoration so the task stays visible after refetch.
  const handleUnparent = useCallback((taskId: string) => {
    if (!onReparentTask) return;
    ensureManualSort(tasks.find((t) => t.id === taskId)?.project || '');
    scrollAfterReparentRef.current = taskId;
    onReparentTask(taskId, null);
  }, [onReparentTask, ensureManualSort, tasks]);

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

  // Folder chip ✕ → DELETE the folder. Consequence-free by design: member tasks
  // fall back to the project in place and are never deleted (folders are no
  // longer auto-pruned server-side, so ungrouping members would leave an empty
  // shell — delete is the real inverse of creating a folder). Falls back to
  // ungroup-all for a consumer that wired the old callbacks only.
  const handleDissolveGroup = useCallback((groupId: string) => {
    if (onDeleteFolder) { onDeleteFolder(groupId); return; }
    const memberIds = tasks.filter((t) => t.group_id === groupId).map((t) => t.id);
    if (memberIds.length === 0) return;
    if (onUngroupTasks) onUngroupTasks(memberIds);
    else if (onUngroupTask) memberIds.forEach((id) => onUngroupTask(id));
  }, [onDeleteFolder, onUngroupTasks, onUngroupTask, tasks]);

  // "+ → New folder" on a project header: prompt a name, create it empty.
  const handleCreateFolder = useCallback(async (project: string) => {
    if (!onCreateFolder) return;
    const name = await prompt({ title: 'New folder', placeholder: 'Folder name', confirmLabel: 'Create' });
    const trimmed = name?.trim();
    if (!trimmed) return;
    // Unfold first, like handleHeaderAddTask: the new folder's row lives inside the
    // project's rows (the main list unmounts them while folded, the tiers hide them),
    // so creating into a folded project would produce no visible row at all. After the
    // prompt, not before: a cancelled prompt must not move the fold.
    expandProject(project);
    onCreateFolder(trimmed, project);
  }, [onCreateFolder, prompt, expandProject]);

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
            ensureManualSort(project);
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

  // Stable move-up dispatcher: the map above rebuilds (fresh closures) on every
  // tasks change, and passing those closures straight down gave every row a new
  // onMoveUp identity per render — defeating the row memo() list-wide. Rows get
  // this ONE function (eligibility still decided per row via moveUpMap.has).
  // useLayoutEffect, not a render-phase write: this component renders inside
  // startTransition, where React may discard or replay a render — a ref
  // mutated during render can then hold a map from a thrown-away tree.
  const moveUpMapRef = useRef(moveUpMap);
  useLayoutEffect(() => { moveUpMapRef.current = moveUpMap; }, [moveUpMap]);
  const handleMoveUpById = useCallback((taskId: string) => {
    moveUpMapRef.current.get(taskId)?.();
  }, []);

  const draggedTask = activeDragId ? sorted.find((t) => t.id === activeDragId) : null;

  // User-controlled collapse only — no auto-collapse during drag.
  // `project` = the plain project name ('' = Inbox).
  const isRunCollapsed = useCallback((tier: string, project: string) => {
    return isFoldedAt(runFolds, tier, project);
  }, [runFolds]);

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
  // dnd-kit's mouse sensor. Dropping label A onto label B moves A's project
  // before B in the global `ordering.projects` list — the same list the Tasks
  // tab groups and the /tasks rail use, so all surfaces re-order together.
  const [labelDragProj, setLabelDragProj] = useState<string | null>(null);
  const [labelDropProj, setLabelDropProj] = useState<string | null>(null);
  const handleLabelDrop = useCallback((active: string, target: string, visibleOrder: readonly string[]) => {
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
    const below = visibleOrder.indexOf(active) < visibleOrder.indexOf(target);
    const targetIndex = next.findIndex(name => name.toLowerCase() === target.toLowerCase());
    next.splice(targetIndex + (below ? 1 : 0), 0, moved);
    // Reported, never swallowed: this is also what the menu's Move up / Move down
    // call, and a rejected reorder there would otherwise be an unhandled rejection
    // plus a row that silently snapped back.
    ordering.reorderProjects(next).catch((err) => {
      onOperationError?.(err instanceof Error ? err.message : 'Reorder failed');
    });
  }, [ordering, tasks, onOperationError]);

  /** Menu "Move up" / "Move down" for a project row — the keyboard/touch route to
   *  what dragging a label does. The caller passes the sequence IT draws (the main
   *  list's group order, or one tier's project runs), so "up" always means the row
   *  the user can see above this one; the swap itself is handleLabelDrop, so there
   *  is still exactly one place that writes `ordering.projectOrder`. */
  const moveProjectBy = useCallback((seq: readonly string[], project: string, delta: -1 | 1) => {
    const index = seq.indexOf(project);
    if (index === -1) return;
    const target = seq[index + delta];
    if (target === undefined) return;
    handleLabelDrop(project, target, seq);
  }, [handleLabelDrop]);

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
        onOperationError?.('Only one folder in this tier: "By project" puts a line BETWEEN folders. Set its Group to Flat to divide inside one.');
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
    // The ghost row is rendered INSIDE the project's run, so a folded project
    // would hide the very row this click asked for. Unfold first.
    expandProject(project, { tier });
    setRunAddSignal({ tier, project, nonce: Date.now() });
  }, [expandProject]);
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
  const movePinnedRow = useCallback((taskId: string, neighborId: string, tier: FocusTier) => {
    let next = [...pinnedTaskIds ?? []];
    if (tierSort(tier) !== 'manual') {
      // A sorted tier draws no hand order to swap in: the order it shows becomes its
      // pin order, the move is made there, and the tier switches to Manual.
      const shown = taskIdsOnly(tierIdsAtRest.get(tier) ?? []);
      const members = new Set(shown);
      let k = 0;
      next = next.map((id) => (members.has(id) ? shown[k++] ?? id : id));
      setTierSort(tier, 'manual');
      showSortToast(`${tierDisplayLabel(tier, customTiers)} switched to Manual order`);
    }
    const from = next.indexOf(taskId), to = next.indexOf(neighborId);
    if (from < 0 || to < 0) return;
    [next[from], next[to]] = [next[to], next[from]];
    onReorderPinned?.(next);
  }, [pinnedTaskIds, onReorderPinned, tierSort, setTierSort, tierIdsAtRest, showSortToast, customTiers]);
  const renderTierItems = useCallback((ids: string[], tier: FocusTier, groupMeta: Map<string, GroupRenderInfo>) => {
    const out: ReactNode[] = [];
    // Project labels — a slim row above each project run (ids are pre-clustered by
    // project). Each one is a `tierproj:` sentinel IN the ids (withProjectLabels), so
    // dnd-kit displaces it with its run and the slot a drag opens is drawn under the
    // project it really lands in. Present only in 'project' view mode and when two or
    // more projects have a visible card here (pruneTierLabels) — a single label
    // (incl. a lone "Inbox") separates nothing and is pure noise.
    const distinctProjects = new Set<string>();
    // Cards this project has in this tier (the label's count badge). Tier-local like
    // the folder chip's badge: counting cards this tier does not hold would make the
    // number jump for no visible reason. Deliberately NOT "visible rows": a card hidden
    // by a collapsed FOLDER still counts, and the full count above a FOLDED run is the
    // point, that number is what tells you what is behind the fold.
    const projectRowCount = new Map<string, number>();
    // The AT-REST ids, not the array being walked (see tierIdsAtRest): mid-drag `ids`
    // is missing a dragged folder's members, which can silently drop this tier under
    // the 2-project label threshold and pop every folded run open under the pointer.
    for (const id of tierIdsAtRest.get(tier) ?? ids) {
      const t = pinnedTaskMap.get(id);
      if (!t) continue;
      const p = t.project || '';
      distinctProjects.add(p);
      projectRowCount.set(p, (projectRowCount.get(p) ?? 0) + 1);
    }
    // 'custom' view mode = raw pin order: no project runs exist, so no labels.
    // Labels STAY during a card drag (hiding them collapsed the tier into a
    // flat list mid-drag — "我完全懵逼", 2026-08-13) but render INERT: no drag
    // handle, no "+", no hover — read-only separators until the drop lands.
    const showFolders = ids.some(isTierLabelId);
    const foldersInert = isPinnedDragActive;
    /**
     * Is this project's run folded shut right now?
     *
     * A folded run is HIDDEN (display:none via .tier-project-collapsed), never
     * unmounted: its ids stay in this tier's SortableContext, and dropping them
     * would shift dnd-kit's indices under a live drag. Gated on `showFolders`
     * because the label row is the ONLY way back — hiding a run in a tier that
     * draws no label (single project, or 'custom' view mode) would be a one-way
     * door: the fold outlives the label (it is saved, and a second project can
     * leave the tier).
     */
    const runHidden = (p: string) => showFolders && isRunCollapsed(tier, p);
    // Folders fold per tier. A folder under a folded ANCESTOR hides with it, chip
    // and cards (display:none, ids stay in the SortableContext); the folded
    // folder's own chip stays as the way back.
    const folded = (gid: string) => isFoldedAt(folderFolds, tier, gid);
    const underFold = (gid: string) => folderParents.size > 0 && folderAncestors(gid, folderParents).some(folded);
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
    const sorted = tierSort(tier) !== 'manual';
    const sepList = sorted ? NO_SEPARATORS : sepPreview ? upsertSeparator(separators, sepPreview) : separators;
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
    // A drag preview can split one project's run in two. Each project's lines and
    // add row go out once, and a repeated label needs its own key: a duplicate key
    // leaves an orphaned label in the DOM after the drop.
    const runsSeen = new Map<string, number>();
    let runAddShown = false;
    /**
     * The rows that open a project's run (its lines, its label) and close the one
     * before it (that run's inline "add task" row), emitted the first time a row of
     * `proj` is walked. Both a folder chip and a card can be that first row, so both
     * branches below go through here.
     */
    const enterRun = (proj: string, labelId?: string) => {
      if (proj === prevProject && !labelId) return;
      // Leaving a project run: its inline "add task" row belongs to the run above,
      // so it goes out BEFORE the next folder label.
      if (sepMode === 'project' && prevProject !== null) {
        // runHidden gate: the signal is nonce-independent, so folding the project
        // AFTER opening the row would otherwise leave an "Add to X…" row floating
        // under a shut label, and typing in it would create a task into a run the
        // user cannot see.
        if (!runAddShown && runAddSignal?.tier === tier && runAddSignal.project === prevProject && !runHidden(prevProject)) {
          out.push(runAddRow(tier, prevProject));
          runAddShown = true;
        }
      }
      const runIndex = runsSeen.get(proj) ?? 0;
      runsSeen.set(proj, runIndex + 1);
      // A line placed between folders draws ABOVE this folder's label, outside the
      // folder entirely — a folder is one unit in this mode, and a line between a
      // label and its own cards would read as a split folder, not a band boundary.
      if (sepPlacement && runIndex === 0) {
        for (const sep of sepPlacement.aboveProject.get(proj) ?? []) out.push(sepRow(sep));
      }
      if (labelId) {
        out.push(
          <TierProjectLabelRow
            key={labelId}
            sortableId={labelId}
            project={proj}
            count={projectRowCount.get(proj) ?? 0}
            collapsed={isRunCollapsed(tier, proj)}
            inert={foldersInert}
            dropIndicator={labelDropProj === proj && labelDragProj !== proj ? dropSide(proj) : null}
            // The project-reorder drag stays HERE, next to `ordering.projects`.
            // Inbox ('') drags too — its slot rides that list as the empty string.
            // '' is falsy, so every gate below checks against null (the "no drag"
            // sentinel), never truthiness.
            dragProps={{
              draggable: !foldersInert,
              onDragStart: (e) => {
                e.dataTransfer.setData('text/walnut-project', proj);
                e.dataTransfer.effectAllowed = 'move';
                setLabelDragProj(proj);
              },
              onDragEnd: () => { setLabelDragProj(null); setLabelDropProj(null); },
              onDragOver: (e) => {
                if (labelDragProj !== null && labelDragProj !== proj) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setLabelDropProj(proj);
                }
              },
              onDragLeave: () => { if (labelDropProj === proj) setLabelDropProj(null); },
              onDrop: (e) => {
                e.preventDefault();
                // getData returns '' both for "no payload" AND for an Inbox drag —
                // labelDragProj (state) disambiguates; null means no live drag.
                const fromData = e.dataTransfer.getData('text/walnut-project');
                const active = fromData !== '' ? fromData : labelDragProj;
                if (active !== null) handleLabelDrop(active, proj, projSeq);
              },
            }}
            onToggleCollapse={(p) => toggleRun(tier, p)}
            onAddTask={(p) => addTaskToRun(tier, p)}
            onAddSeparator={sorted ? undefined : (p) => addSeparator(tier, p)}
            onAddFolder={onCreateFolder ? handleCreateFolder : undefined}
            // Named projects only: a launch seeds the project's default folder and
            // Inbox has no registry row to carry one.
            onAddSession={proj && onOpenLauncherForProject ? onOpenLauncherForProject : undefined}
            isFavorite={favorites?.isProjectFavorite(proj)}
            onToggleFavorite={favorites?.toggleFavoriteProject}
            onViewDetails={showProjectDetail}
            // Neighbours = this tier's own run sequence, the same list the drag's
            // drop-side calculation uses, so the menu and the drag agree on "above".
            onMoveUp={(p) => moveProjectBy(projSeq, p, -1)}
            onMoveDown={(p) => moveProjectBy(projSeq, p, 1)}
          />
        );
      }
      prevProject = proj;
    };
    /** The folder chip for `gid`, drawn by whichever branch meets the folder first. */
    // A folder holding only one subfolder here draws with it as ONE row, "A / B"
    // (folderChains): the row drags as A, takes drops into B, and folds the pair.
    const chains = tierChains.get(tier);
    const drawnParents = chainedParents(folderParents, chains);
    // The dragged card's gap is indented where the card lands: in the folder lit for it
    // in this tier, or out in the loose column.
    const into = folderTargetId ? parseIntoFolderId(folderTargetId) : null;
    const dragLandingDepth = into && into.tier === tier ? folderDepth(into.groupId, drawnParents) : null;
    const chipFor = (gid: string, project: string | undefined, count: number) => {
      const chain = chains?.get(gid);
      const leaf = chain ? chain[chain.length - 1] : gid;
      return (
        <GroupChip key={groupSortableId(gid, tier)} groupId={gid} tier={tier}
          label={taskGroups?.[leaf] ?? ''}
          path={chain?.slice(0, -1).map((g) => ({ groupId: g, label: taskGroups?.[g] ?? '' }))}
          leafId={chain ? leaf : undefined}
          project={project}
          showProjectPrefix={!showFolders}
          count={chain ? ids.filter((id) => pinnedTaskMap.get(id)?.group_id === leaf).length : count}
          depth={folderDepth(gid, drawnParents)}
          collapsed={chain ? chain.some(folded) : folded(gid)}
          // The RUN's project decides, not the folder's registry project: this chip is
          // drawn inside the bucket its members cluster into, and that bucket is what
          // the label row folds. `prevProject` IS that bucket (enterRun just set it).
          projectCollapsed={(prevProject !== null ? runHidden(prevProject) : false) || underFold(gid)}
          inert={foldersInert}
          isDropTarget={folderTargetId === intoFolderId(leaf, tier)}
          // A chain folds as one: shut any of it, and the row opens it all again.
          onToggleCollapse={chain
            ? () => { const shut = chain.filter(folded); for (const g of shut.length > 0 ? shut : [gid]) toggleFolder(tier, g); }
            : (id) => toggleFolder(tier, id)}
          onMoveToProject={handleMoveFolderToProject}
          onRename={handleRenameGroup}
          onDissolve={handleDissolveGroup} onHide={handleHideGroup} />
      );
    };
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
      if (isTierLabelId(id)) {
        enterRun(tierLabelProject(id), id);
        continue;
      }
      if (isGroupSentinel(id)) {
        // A sentinel sits immediately before its member run (withGroupSentinels).
        // When the run follows at rest, the LEAD MEMBER branch below emits the chip,
        // so it lands after that row's folder label / separator lines — the placement
        // those two features were written around. The sentinel draws the chip itself
        // when no run follows: an ANCESTOR folder with no card of its own in this
        // tier (its heading, a real sortable row like every other), or the folder
        // being dragged, whose subtree is collapsed away so the chip IS the whole
        // cluster. Same key in both states, so React keeps one chip instance and
        // dnd-kit's active node never remounts mid-drag.
        const gid = parseGroupSentinelGid(id);
        const next = ids[i + 1];
        const runFollows = next !== undefined && !isGroupSentinel(next)
          && pinnedTaskMap.get(next)?.group_id === gid;
        if (runFollows) continue;
        // One pass for both facts this chip needs (owning project + member count),
        // and ONE precedence rule shared with the lead-member branch below.
        const facts = pinnedFolderFacts(gid, pinnedTaskMap);
        const project = folderOwnerProject(folderMeta?.[gid], facts.member);
        // Without labels the folder's own project opens its run: with no card of its
        // own here, this chip can be the first row of the project in this tier.
        if (!showFolders && project !== undefined) enterRun(project);
        out.push(chipFor(gid, project, facts.count));
        continue;
      }
      const task = pinnedTaskMap.get(id);
      if (!task) continue;
      const proj = task.project || '';
      // With labels, the label sentinel opened this run; a card a cross-tier drag
      // dropped into another project's run is drawn in THAT run, where it will land.
      if (!showFolders) enterRun(proj);
      const gi = groupMeta.get(id);
      // A chained folder's row is its chain's top chip (the sentinel branch).
      if (gi?.isLead && !(chains && [...chains.values()].some((c) => c.indexOf(gi.groupId) > 0))) {
        // Same precedence rule as the sentinel branch; the lead member IS the
        // fallback here, so this never renders an unknown project.
        out.push(chipFor(gi.groupId, folderOwnerProject(folderMeta?.[gi.groupId], task), gi.count));
      }
      out.push(
        <SortableTierCard key={task.id} task={task} tier={tier} isFocused={focusedTaskId === task.id}
          isVanishing={graceExiting && (keepWhileCompleting(task) || (keepWhileParking(task) && waitingWillHide))}
          isSessionOpen={openSessionTaskIds?.has(task.id) ?? false}
          isDetailOpen={focusedTaskId === task.id && !suppressDetail}
          onClick={handlePinnedCardClick} onSetTier={onSetTier} onUnpinTask={onUnpinTask}
          onPinTask={onPinTask} onSetPriority={onSetPriority} onSetDate={onSetDate} onSetStartDate={onSetStartDate}
          onExpandDetail={handleExpandDetail} onClearFocus={onClearFocus} onOpenSession={onOpenSession}
          onStartSession={onStartSession}
          onSetPhase={setPhaseOrComplete} onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
          onDelete={onDelete} onMoveToProject={onMoveTask ? handleMoveToProject : undefined}
          groupInfo={gi} folderCollapsed={!!(gi && (folded(gi.groupId) || underFold(gi.groupId)))}
          projectCollapsed={runHidden(showFolders && prevProject !== null ? prevProject : proj)}
          selectMode={selectMode}
          isSelected={selectedIds.has(task.id)} onSelectToggle={onSelectToggle}
          onMoveUp={i > 0 && pinnedTaskMap.get(ids[i - 1])?.project === task.project && pinnedTaskMap.get(ids[i - 1])?.group_id === task.group_id ? () => movePinnedRow(task.id, ids[i - 1], tier) : undefined}
          onMoveDown={i < ids.length - 1 && pinnedTaskMap.get(ids[i + 1])?.project === task.project && pinnedTaskMap.get(ids[i + 1])?.group_id === task.group_id ? () => movePinnedRow(task.id, ids[i + 1], tier) : undefined}
          onStartSelect={onStartSelect} isGroupTarget={groupTargetId === task.id} landingDepth={task.id === activeDragPinnedId ? dragLandingDepth : undefined}
          filterOverrideReason={task.id === filterOverrideId || task.id === fadingOverrideId ? filterOverrideNode : undefined} />
      );
    }
    // Project-mode lines whose neighbours are all gone end up here, at the bottom
    // of the tier: the user placed them, only their neighbourhood moved on. Then
    // the last run's inline "add task" row.
    if (sepPlacement) for (const sep of sepPlacement.tail) out.push(sepRow(sep));
    const lastScope = prevProject ?? '';
    // Same runHidden gate as the mid-list push above.
    if (sepMode === 'project' && !runAddShown && runAddSignal?.tier === tier && runAddSignal.project === lastScope && !runHidden(lastScope)) {
      out.push(runAddRow(tier, lastScope));
    }
    return out;
  }, [filterOverrideId, fadingOverrideId, filterOverrideNode, movePinnedRow, tierIdsAtRest, pinnedTaskMap, taskGroups, folderMeta, folderFolds, toggleFolder, handleMoveFolderToProject, focusedTaskId, openSessionTaskIds, suppressDetail, handlePinnedCardClick, onSetTier, onUnpinTask, onPinTask, onSetPriority, onSetDate, handleExpandDetail, onClearFocus, onOpenSession, onStartSession, setPhaseOrComplete, onUpdate, handleUpdateTitle, onDelete, onMoveTask, handleMoveToProject, selectMode, selectedIds, onSelectToggle, onStartSelect, groupTargetId, handleRenameGroup, handleDissolveGroup, handleHideGroup, keepWhileCompleting, keepWhileParking, waitingWillHide, recentTick, graceExiting, isPinnedDragActive, labelDragProj, labelDropProj, handleLabelDrop, tierViewMode, onOpenLauncherForProject, separators, sepPreview, sepDrag, setSepDrag, clearSepDrag, deleteSeparator, renameSeparator, addSeparator, addTaskToRun, runAddRow, runAddSignal, isRunCollapsed, toggleRun, favorites, showProjectDetail, onCreateFolder, handleCreateFolder, moveProjectBy, folderParents, folderTargetId, tierChains, activeDragPinnedId, tierSort]);

  // The regular task list gets its own PINNED/RECENT-style collapsible bar.
  // Outside the stacked view the Tasks tab IS the list — it can't be folded away.
  // A live search also unfolds it (matching isFolded): hits must never hide
  // behind a chevron the user folded before searching.
  const tasksCollapsed = isAll && !isSearchMode && collapsedSections.has('tasks');
  const tasksVisible = showSection('tasks');
  // The project name row lives in the grouped list: when that list goes away
  // (folded, flat, a search), the request ends with it instead of popping back
  // with the caret on the next unfold.
  const newProjectRowHost = tasksVisible && !tasksCollapsed && !isSearchMode && groupBy !== 'none';
  useEffect(() => { if (!newProjectRowHost) setNewProjectOpen(false); }, [newProjectRowHost]);
  // "Collapse all" for the Pinned heading's menu: folds every tier at once.
  const allTiersFolded = allTierKeys.every((tier) => collapsedSections.has(tier));
  const setAllTiersFolded = (fold: boolean) => {
    if (isSearchModeRef.current) return;
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      for (const tier of allTierKeys) { if (fold) next.add(tier); else next.delete(tier); }
      persistSet(LS_COLLAPSED_SECTIONS_KEY, next);
      return next;
    });
  };
  // Any pinned tier showing? Drives whether the pinned wrapper mounts at all.
  const anyTierVisible = showSection('focus') || showSection('satellite') || showSection('wait')
    || (customTiers ?? []).some((t) => showSection(t.id));
  const recentVisible = showSection('recent');
  // Section counts for the tab badges. `focus`/`satellite`/`wait`/`recent`
  // come from the already-computed display arrays, so the badges track exactly what
  // the tab would render (incl. project/filter scoping).
  const hits = (list: readonly Task[]) => (overrideOnlyIds.size === 0 ? list.length
    : list.reduce((n, t) => n + (overrideOnlyIds.has(t.id) ? 0 : 1), 0));
  const sectionCounts: Partial<Record<TodoSection, number>> = {
    focus: hits(focusTasksDisplay),
    satellite: hits(satelliteTasksDisplay),
    wait: hits(waitTasksDisplay),
    recent: hits(visibleRecentTasks),
    // Real hits only: descendant CONTEXT rows never inflate the badge. A search
    // counts the rows it draws (folded Completed / Related rows wait), F06.
    tasks: isSearchMode ? (searchResultCount ?? 0) : matchedIds.size,
  };
  for (const def of customTiers ?? []) {
    sectionCounts[def.id] = hits(customTierRender[def.id]?.display ?? []);
  }
  sectionCounts.pinned = (sectionCounts.focus ?? 0) + (sectionCounts.satellite ?? 0) + (sectionCounts.wait ?? 0)
    + (customTiers ?? []).reduce((sum, def) => sum + (sectionCounts[def.id] ?? 0), 0);
  // Parked pins a tier holds but hides by default: a tier with only those keeps its tab
  // under "Hide empty tabs" (the footer's "N waiting hidden" needs the tab to be
  // reachable). Completed pins do not count; they accumulate forever.
  const sectionHeldCounts = useMemo((): Partial<Record<TodoSection, number>> => {
    if (waitingRevealed || isSearchMode) return {};
    const held: Partial<Record<TodoSection, number>> = {};
    const parked = tasks.filter((t) => t.phase === 'WAITING' && pinnedTaskIds?.has(t.id) && !(t.group_id && hiddenGroups?.has(t.group_id)));
    if (parked.length === 0) return held;
    const tierSets: Array<[TodoSection, Set<string> | undefined]> = [
      ['focus', focusTaskIds], ['wait', waitTaskIds],
      ...Object.entries(customTierIds ?? {}),
    ];
    for (const t of parked) {
      const tier = tierSets.find(([, ids]) => ids?.has(t.id))?.[0] ?? 'satellite';
      held[tier] = (held[tier] ?? 0) + 1;
    }
    return held;
  }, [tasks, waitingRevealed, isSearchMode, pinnedTaskIds, focusTaskIds, waitTaskIds, customTierIds, hiddenGroups]);
  // One count for the filter row, every tab badge and the hit rows (4.6): real
  // hits only (no focus-override row, no descendant context rows). All counts
  // the list hits, which already hold every pin that passes the chips.
  sectionCounts.all = isSearchMode ? (searchResultCount ?? 0) : matchedIds.size;
  const filterCount = loading ? null
    : isSearchMode ? (searchResultCount ?? 0)
    : (sectionCounts[effectiveSection] ?? 0);
  // 5.3: chips are set and nothing matches: say so, with one way back.
  const showFilterEmpty = !isSearchMode && filterCount === 0 && homeFilters.chips.length > 0;
  const toggleIncludeComplete = useCallback(() => setShowDoneResults((v) => !v), []);
  // The view name rides in the filter row whenever no tab shows it: the bar is
  // hidden, or the view is Projects, which the bar never draws (F36).
  const viewItemLabel = (!quickViews || effectiveSection === 'tasks') && effectiveSection !== 'all'
    ? (allViews(customTiers ?? []).find((v) => v.id === effectiveSection)?.label ?? effectiveSection)
    : null;
  const filterBar = useMemo<FilterBarController>(() => ({
    state: homeFilters.state, lists: homeFilters.lists, chips: homeFilters.chips, facets: homeFilters.facets,
    recent: homeFilters.recent, apply: homeFilters.apply, clearAll: homeFilters.clearAll,
    menuOpen: homeFilters.menuOpen, setMenuOpen: homeFilters.setMenuOpen, setChipMenuOpen: homeFilters.setChipMenuOpen,
    buttonRef: homeFilters.buttonRef, rowRef: homeFilters.rowRef, listScrollRef: homeFilters.listScrollRef,
    count: filterCount,
    archiveLoading,
    search: {
      active: isSearchMode,
      includeComplete: isSearchMode && statusIsDefault && searchDoneCount > 0
        ? { count: searchDoneCount, on: showDoneResults, toggle: toggleIncludeComplete }
        : null,
    },
    viewItem: viewItemLabel ? { label: viewItemLabel } : null,
    openDisplay: () => homeFilters.setMenuOpen(true),
  }), [homeFilters, filterCount, archiveLoading, isSearchMode, statusIsDefault, searchDoneCount, showDoneResults, toggleIncludeComplete, viewItemLabel]);
  const footerTasks = useMemo(() => footerScope(tasks, effectiveSection, {
    pinned: pinnedTaskIds, focus: focusTaskIds, wait: waitTaskIds, custom: customTierIds,
  }), [tasks, effectiveSection, pinnedTaskIds, focusTaskIds, waitTaskIds, customTierIds]);
  const applyFromFooter = useCallback((next: FilterState) => homeFilters.apply(next, 'footer'), [homeFilters]);
  // A stable ref callback: an inline one is detached (set to null) on every commit,
  // which left FilterBar's scroll keeper reading a null list scroller.
  const listScrollRef = homeFilters.listScrollRef;
  const stopRowFit = useRef<(() => void) | null>(null);
  const setListScrollEl = useCallback((el: HTMLDivElement | null) => {
    listScrollRef.current = el;
    stopRowFit.current?.();
    stopRowFit.current = el ? observeRowFit(el) : null;
  }, [listScrollRef]);
  // 6.8: the project heading's "Filter to this project" replaces the Project set.
  const filterToProject = useCallback(
    (project: string) => homeFilters.apply({ ...homeFilters.state, projects: [project] }, 'board'),
    [homeFilters],
  );
  /**
   * One tier's render model, for the section loop below. A pure LOOKUP over the
   * memos that already exist (three per built-in, one bundle per custom) — no
   * computation moves here, so the drag snapshots and the frozen at-rest maps keep
   * reading exactly the arrays they did when each tier had its own hand-written JSX.
   * null = a tier id with no registry entry (a deleted custom tier mid-refresh).
   */
  const tierSectionModel = (tier: FocusTier): {
    def: CustomTierDef;
    visibleIds: string[];
    display: Task[];
    groupMeta: Map<string, GroupRenderInfo>;
  } | null => {
    switch (tier) {
      case 'focus': return { def: { id: 'focus', label: 'Focus' }, visibleIds: visibleFocusIds, display: focusTasksDisplay, groupMeta: focusGroupMeta };
      case 'satellite': return { def: { id: 'satellite', label: 'Satellite' }, visibleIds: visibleSatelliteIds, display: satelliteTasksDisplay, groupMeta: satelliteGroupMeta };
      case 'wait': return { def: { id: 'wait', label: 'Parked' }, visibleIds: visibleWaitIds, display: waitTasksDisplay, groupMeta: waitGroupMeta };
      default: {
        const def = (customTiers ?? []).find((d) => d.id === tier);
        const render = customTierRender[tier];
        if (!def || !render) return null;
        return { def, visibleIds: render.visibleIds, display: render.display, groupMeta: render.groupMeta };
      }
    }
  };
  // A stacked view draws a built-in tier only once it holds a task, so a first visit is
  // not a wall of empty headings; with nothing drawn the Pinned heading stays over one
  // line that says so (2026-10-01: the section must be there to be learned, the tiers
  // under it need not). A custom tier always draws: the user just made it and needs its
  // add row. Every tier mounts while a pinned card is dragged, so an empty one can still
  // take the drop; a single-tier view always draws its tier.
  // F25: under an active chip an empty custom tier steps aside too (no heading over nothing).
  const tierHiddenWhenEmpty = (tier: FocusTier, model: { display: unknown[] }) =>
    isStacked && !isPinnedDragActive && (isBuiltinTier(tier) || homeFilters.chips.length > 0) && model.display.length === 0;
  // 5.10: one tier with tasks and no tier ever picked: the pins sit under Pinned
  // with no tier heading (a lone `Satellite` title is what makes new users ask).
  // Latched for a live drag: the empty tiers that open as drop zones get their
  // headings, while the tier the card came from keeps its headless layout, so no
  // heading is inserted above the cards (and the card under the pointer does not
  // jump) the moment a drag starts.
  const tiersWithTasks = allTierKeys.filter((tier) => showSection(tier) && (tierSectionModel(tier)?.display.length ?? 0) > 0);
  // F08: a user who never picked a tier sees no tier name, also once a draft (which
  // lands in Focus) joins pins (which land in Satellite). A task in any other tier
  // (Parked, a custom tier), alone or not, means the board has tiers on purpose: all
  // keep headings.
  const headlessKey = useFrozenWhile<string>(
    !isStacked || tierUsed || tiersWithTasks.length === 0 ? ''
      : tiersWithTasks.every((t) => t === 'focus' || t === 'satellite') ? tiersWithTasks.join('|') : '',
    isPinnedDragActive,
  );
  const headlessTiers = useMemo(() => new Set(headlessKey ? headlessKey.split('|') : []), [headlessKey]);
  const anyTierDrawn = allTierKeys.some((tier) => {
    const model = tierSectionModel(tier);
    return !!model && !tierHiddenWhenEmpty(tier, model);
  });

  // Sort and Group act on the view's own list (list-order.ts): All and Projects the
  // Projects list, Pinned every tier, a tier view its tier, Recent its feed. A search
  // ranks by match instead.
  const listOrderApplies = (effectiveSection === 'all' || effectiveSection === 'tasks') && !isSearchMode;
  const displayOrder = ((): DisplayMenuProps['order'] => {
    // Pinned reads the tiers it draws; a pick writes every tier it holds.
    const drawnTiers = tiersWithTasks.length > 0 ? tiersWithTasks : allTierKeys;
    const reads = orderLists(effectiveSection, drawnTiers);
    const writes = orderLists(effectiveSection, allTierKeys);
    const sorts: SortBy[] = [
      ...reads.tiers.map(tierSort),
      ...(reads.projects ? [sortBy] : []),
      ...(reads.recent ? [sortOfRecentOrder(recentOrder)] : []),
    ];
    const groups: GroupBy[] = [
      ...reads.tiers.map((t) => groupOfTierMode(tierViewMode(t))),
      ...(reads.projects ? [groupBy] : []),
      ...(reads.recent ? [recentGroup] : []),
    ];
    return {
      sort: commonValue(sorts),
      sortChoices: reads.recent ? RECENT_SORT_VALUES : SORT_VALUES,
      onSort: (v: SortBy) => {
        for (const t of writes.tiers) setTierSort(t, v);
        if (writes.projects) setSortForAll(v);
        if (writes.recent && v !== 'manual') handleRecentSortChange(recentOrderOfSort(v));
      },
      projectSortCount: reads.projects ? Object.keys(projectSorts).length : 0,
      group: commonValue(groups),
      onGroup: (v: GroupBy) => {
        for (const t of writes.tiers) setTierViewMode(t, tierModeOfGroup(v));
        if (writes.projects) { setGroupBy(v); persistGroupBy(v); }
        if (writes.recent) handleRecentGroupChange(v);
      },
      note: isSearchMode ? 'Search ranks by match' : null,
    };
  })();
  // The Pinned heading sets every tier's Group and Sort at once, as Pinned's Display rows
  // do. A new board draws its pins with no tier heading, so this is All's way to order them.
  const pinnedReads = tiersWithTasks.length > 0 ? tiersWithTasks : allTierKeys;
  const pinnedGroup = commonValue(pinnedReads.map((t) => groupOfTierMode(tierViewMode(t))));
  const pinnedSort = commonValue(pinnedReads.map(tierSort));
  const pinnedHeadless = tiersWithTasks.length > 0 && tiersWithTasks.every((t) => headlessTiers.has(t));
  // One toolbar button: the menu's open state and anchor are the filter controller's.
  const displayProps: DisplayMenuProps = {
    open: homeFilters.menuOpen,
    onOpenChange: homeFilters.setMenuOpen,
    buttonRef: homeFilters.buttonRef,
    section: effectiveSection,
    onSectionChange: (id: string) => handleSectionChange(id as TodoSection),
    customTiers: customTiers ?? [],
    quickViews,
    // A switch: the menu stays open both ways, so the bar is seen coming and going.
    onQuickViewsChange: (next: boolean) => setQuickViews(next),
    viewTitleHint: viewItemLabel,
    order: displayOrder,
    allCollapsed,
    onCollapseExpandAll: handleCollapseExpandAll,
    // F05: only in the views whose list has project groups for the action to fold
    // (All and Projects, with at least one project). Under Flat it still sets the
    // folds the By project list opens with.
    showCollapse: listOrderApplies && liveGroupKeys.size > 0,
  };

  const tierSectionActive = isTierSection(effectiveSection) && !isSearchMode;

  return (
    <div className={`todo-panel${splitterResizing ? ' splitter-resizing' : ''}${activeDragPinnedId ? ' is-task-dragging' : ''}`} ref={splitterContainerRef}>
      <div className="fb-toolbar-scope">
      <div className="todo-panel-toolbar">
        <TodoSearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onClear={clearSearch}
          isSearching={isSearching}
          resultCount={searchResultCount}
        />
        {onOpenLauncher && <NewLauncherButton onOpen={onOpenLauncher} />}
        <DisplayButton {...displayProps} filters={filterBar} />
        <button
          type="button"
          className="todo-panel-hide"
          tabIndex={0}
          aria-label="Hide task panel"
          title="Hide task panel"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('sidebar:toggle-todo'));
            requestAnimationFrame(() => document.querySelector<HTMLElement>('.app-task-panel-toggle')?.focus({ preventScroll: true }));
          }}
        >
          {ICONS.ICON_SIDE_PANEL}
        </button>
      </div>
      </div>

      {banner}

      {/* ✦ AI lane: an in-process agent searches tasks AND session transcripts,
          streaming its progress live. Anchored here — directly under the search
          bar, OUTSIDE every scroll container — so it is always visible at the
          very top while searching, wherever the list is scrolled. */}
      {isSearchMode && (
        <AgentSearchPanel
          query={searchQuery}
          onOpenTask={handleAgentResultClick}
          {...(onOpenSearchSession ? { onOpenSession: onOpenSearchSession } : {})}
        />
      )}

      {/* A single-tier view names its tier and keeps the tier's "+" (the All view's
          tier headings carry the same control). View modes live in the Display menu. */}
      {tierSectionActive && (
        <div className="tier-solo-heading" data-testid="tier-view-bar">
          <span className={`navigation-icon todo-tier-icon-${isBuiltinTier(effectiveSection) ? effectiveSection : 'custom'}`} aria-hidden="true">{ICONS.tierIcon(effectiveSection)}</span>
          <span className="tier-solo-heading-label">{tierDisplayLabel(effectiveSection, customTiers)}</span>
          <TierPlusButton
            tier={effectiveSection}
            label={tierDisplayLabel(effectiveSection, customTiers)}
            onAddSession={onOpenLauncherForTier}
            onAddTask={addTaskToTier}
            onAddSeparator={tierSort(effectiveSection) === 'manual' ? addSeparator : undefined}
          />
        </div>
      )}

      {quickViews && <TodoSectionTabs
        active={effectiveSection}
        onChange={handleSectionChange}
        counts={sectionCounts}
        heldCounts={sectionHeldCounts}
        countsReady={!loading}
        customTiers={customTiers}
      />}

      {/* The filter row sits right above the list it narrows, below the tier heading
          and the tab bar; opening Display adds nothing here (FilterBar.tsx). */}
      <div className="fb-row-scope">
        <FilterBar controller={filterBar} />
      </div>

      {/* Projects view only: Running and Collapse/Expand (spec 5.6). */}
      {quickViews && !isSearchMode && effectiveSection === 'tasks' && (
        <TodoProjectsMiniBar
          runningCount={runningTaskIds.length}
          onJumpRunning={jumpToNextRunning}
          allCollapsed={allCollapsed}
          onCollapseExpandAll={handleCollapseExpandAll}
        />
      )}

      {showFilterEmpty && <TodoFilterEmpty onClear={homeFilters.clearAll} />}

      <div ref={setListScrollEl} className={`home-navigation-scroll${isStacked ? ' is-stacked' : ''}${unpinZone ? ' is-unpin-dragging' : ''}${showFilterEmpty && overrideOnlyIds.size === 0 ? ' is-filter-empty' : ''}`}>
      <NavigationSections storageKey="walnut-todo-navigation-order">
        <NavigationSection key="pinned" navId="pinned">
      {/* Unified DndContext wrapping both Pinned + Recent — enables drag from Recent to Pin.
          A search in the All view is ONE ranked list (pinned hits carry a tier pill), so
          the tier regions step aside; a single-tier view still searches inside its tier. */}
      {!(isSearchMode && isAll) && (anyTierVisible || recentVisible) && (
        <DndContext sensors={pinnedSensors} collisionDetection={pinnedCollision} onDragStart={handlePinnedDragStart} onDragOver={handlePinnedDragOver} onDragEnd={handlePinnedDragEnd} onDragCancel={handlePinnedDragCancel}>
          <div
            ref={pinnedWrapperRef}
            className={`todo-pinned-wrapper${isStacked ? '' : ' todo-pinned-wrapper-solo'}${activeDragPinnedId ? ' todo-pinned-wrapper-dragging' : ''}`}
            // Single-section view: this region IS the panel — take all the height.
            // Stacked view: NO forced share. The All view is one scroller now
            // (home-navigation-scroll), so every region is its natural height and
            // the sections scroll past each other; handing out flex ratios here is
            // what used to give each tier its own little scrollbox.
            style={!isStacked ? { flex: '1 1 auto' } : undefined}
          >
          {/* PINNED section — Focus + Satellite + Parked sub-groups. In a single-tier
              view the "Pinned" wrapper header is dropped (the tab already names the
              tier) and only that tier's subgroup renders. A pinned query condition
              routes every pin through the list, so the tier area steps aside. */}
          {anyTierVisible && (anyTierDrawn || (isStacked && !isSearchMode)) && (
            <div className={`todo-pinned-section${isStacked ? '' : ' todo-pinned-section-solo'}`}>
              {isStacked && (
              <NavigationHeading id="pinned" label="Pinned" className="todo-pinned-header" collapsed={isFolded('pinned')} onClick={() => toggleSection('pinned')}
                actions={[
                  { key: 'organize', label: 'Organize', section: true, when: anyTierDrawn },
                  ...([['project', 'By project'], ['none', 'In one list']] as const).map(([value, label]) => ({
                    key: `group-${value}`, label, checked: pinnedGroup === value, when: anyTierDrawn,
                    onSelect: () => { for (const t of allTierKeys) setTierViewMode(t, tierModeOfGroup(value)); },
                  })),
                  { key: 'sort', label: pinnedHeadless ? 'Sort by' : 'Sort every tier by', section: true, when: anyTierDrawn },
                  ...PROJECT_SORT_OPTIONS.map(([value, label]) => ({
                    key: `sort-${value}`, label, checked: pinnedSort === value, when: anyTierDrawn,
                    onSelect: () => { for (const t of allTierKeys) setTierSort(t, value); },
                  })),
                  { key: 'folds', divider: true, when: anyTierDrawn },
                  ...(anyTierDrawn && !tiersWithTasks.every((t) => headlessTiers.has(t)) ? [{ key: 'collapse-all', label: allTiersFolded ? 'Expand all tiers' : 'Collapse all tiers', onSelect: () => setAllTiersFolded(!allTiersFolded) }] : []),
                  { key: 'collapse', label: isFolded('pinned') ? 'Expand Pinned' : 'Collapse Pinned', onSelect: () => toggleSection('pinned') },
                ]} />
              )}
              {/* F34: no "nothing pinned" verdict before the pins have loaded. */}
              {!isFolded('pinned') && !anyTierDrawn && !loading && (
                <p className="todo-pinned-empty" data-testid="todo-pinned-empty">Nothing pinned yet. Pin a task from its menu to keep it here.</p>
              )}
              {!isFolded('pinned') && anyTierDrawn && (
                <NavigationSections storageKey="walnut-todo-tier-order">
                  {allTierKeys.map((tier) => {
                    if (!showSection(tier)) return null;
                    const model = tierSectionModel(tier);
                    if (!model) return null;
                    if (tierHiddenWhenEmpty(tier, model)) return null;
                    return (
                      <NavigationSection key={tier} navId={tier}>
                        <TierNavigationGroup
                          def={model.def}
                          isAll={isStacked}
                          headless={headlessTiers.has(tier)}
                          folded={!headlessTiers.has(tier) && isFolded(tier)}
                          collapsed={chevronCollapsed(tier)}
                          onToggle={toggleSection}
                          visibleIds={model.visibleIds}
                          isEmpty={model.display.length === 0}
                          // capture:true → the configured Default Platform/Project (fast
                          // local Inbox by default). Deliberately NO onFocusTask:
                          // handleCreate already locates the new card with scope 'pinned',
                          // and onFocusTask would reset that to 'all' and switch the TASKS
                          // tab to the capture project — the "all my tasks disappeared" bug.
                          onAdd={(title) => onCreate({ title, priority: 'none', pinnedTier: tier, capture: true })}
                          onAddSession={onOpenLauncherForTier}
                          onAddTask={addTaskToTier}
                          onAddSeparator={tierSort(tier) === 'manual' ? addSeparator : undefined}
                          dropProps={sepDropProps(tier)}
                          addOpenSignal={tierAddOpenSignal(tier)}
                          onAddSignalConsumed={consumeTierAddSignal}
                          viewMode={tierViewMode(tier)}
                          onChangeViewMode={setTierViewMode}
                          sortBy={tierSort(tier)}
                          onChangeSort={setTierSort}
                        >
                          {renderTierItems(model.visibleIds, tier, model.groupMeta)}
                        </TierNavigationGroup>
                      </NavigationSection>
                    );
                  })}
                </NavigationSections>
              )}
            </div>
          )}

          {/* Stale-done fold — search only: pins completed >30d ago that match the
              query fold into this one line instead of flooding the tiers with
              strikethrough history. Expand shows them in place; the ranked task
              list below always carries them regardless. */}
          {anyTierVisible && isSearchMode && staleDonePinMatchCount > 0 && (
            <button
              type="button"
              className="todo-pinned-stale-fold"
              onClick={() => setShowStaleDonePins((v) => !v)}
              title={showStaleDonePins
                ? 'Hide completed matches older than 30 days'
                : 'Show them in their pinned positions'}
            >
              {ICONS.ICON_CHECK}
              {showStaleDonePins
                ? `Hide ${staleDonePinMatchCount} older completed`
                : `${staleDonePinMatchCount} older completed match${staleDonePinMatchCount === 1 ? '' : 'es'} hidden`}
            </button>
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
                    {visibleRecentTasks.map((task, i) => (
                      <Fragment key={task.id}>
                      {/* Group by project: a quiet label over each project's rows (read only:
                          the feed has no order of its own to drag). */}
                      {recentGroup === 'project' && (i === 0 || (visibleRecentTasks[i - 1].project || '') !== (task.project || '')) && (
                        <div className="tier-project-label recent-project-label" data-project={task.project || ''}>
                          <span className="tier-project-label-name">{task.project || 'Inbox'}</span>
                          <span className="tier-project-label-count" aria-hidden="true">{recentProjectCounts.get(task.project || '') ?? 0}</span>
                        </div>
                      )}
                      <SortableRecentCard
                        task={task}
                        isFocused={focusedTaskId === task.id}
                        isVanishing={graceExiting && ((keepWhileCompleting(task) && !showCompleted) || (keepWhileParking(task) && waitingWillHide))}
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
                        timeMode={recentSortMode}
                      />
                      </Fragment>
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
          {/* The preview must not mask the real drop target. */}
          <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }} modifiers={activeDragSep ? undefined : [ghostBesideCursor]}>
            {/* dnd-kit measures the overlay's only child as the collision rect, so the
                compact ghost sits in a frame the size of the dragged row: a narrower
                rect skewed closestCenter's 2D distance toward the narrower folder rows
                (a lit card, then a drop on the folder chip above it). */}
            {activeDragPinnedTask && (
              <div className="todo-pinned-drag-frame">
                <div className="todo-pinned-card todo-pinned-card-dragging">
                  <span className={`todo-pinned-title${activeDragPinnedTask.walnut_agent ? ' walnut-task-title' : ''}`} title={activeDragPinnedTask.title}>{activeDragPinnedTask.title}</span>
                </div>
              </div>
            )}
            {/* Whole-folder drag: a stacked preview naming the folder + its cards (the
                subfolders' too) so the cursor always carries a visible payload while
                moving a cluster. */}
            {activeDragGroup && (
              <div className="todo-pinned-drag-frame">
                <div className="todo-pinned-group-drag-preview">
                  <div className="todo-pinned-group-drag-header">
                    <span className="task-group-chip-icon" aria-hidden="true">{ICONS.ICON_FOLDER_OUTLINE}</span>
                    <span className="todo-pinned-group-drag-label">{activeDragGroup.label}</span>
                    {activeDragGroup.count > 0 && <span className="todo-pinned-group-drag-count">{activeDragGroup.count}</span>}
                  </div>
                  {activeDragGroup.titles.slice(0, 3).map((t, i) => (
                    <div key={i} className="todo-pinned-group-drag-row" title={t}>{t}</div>
                  ))}
                  {activeDragGroup.titles.length > 3 && (
                    <div className="todo-pinned-group-drag-more">+{activeDragGroup.titles.length - 3} more</div>
                  )}
                </div>
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

      </NavigationSection>
      <NavigationSection key="tasks" navId="tasks">
      {/* One box for the heading and its list, so a stuck Projects heading lets go where
          the list ends. Outside the stacked view it is display:contents, and the list
          stays the flex child that scrolls. */}
      <div className="todo-tasks-section">

      {/* TASKS header bar — the stacked view's collapsible affordance, matching
          PINNED / RECENT / Notes. The Tasks TAB doesn't get one: the tab strip
          already labels the region, and folding the only visible section away
          would leave an empty panel with no way back except another tab. */}
      {isAll && !isSearchMode && (
      <NavigationHeading id="tasks" label="Projects" className="todo-pinned-header todo-tasks-header" collapsed={tasksCollapsed} onClick={() => toggleSection('tasks')}
        actions={[
          { key: 'organize', label: 'Organize', section: true },
          ...([['project', 'By project'], ['none', 'In one list']] as const).map(([value, label]) => ({
            key: `group-${value}`, label, checked: groupBy === value,
            onSelect: () => { setGroupBy(value); persistGroupBy(value); },
          })),
          // Sets every project at once; a project's own right-click menu sets just that one.
          { key: 'sort', label: groupBy === 'project' ? 'Sort every project by' : 'Sort by', section: true },
          ...PROJECT_SORT_OPTIONS.map(([value, label]) => ({
            key: `sort-${value}`, label, checked: sortBy === value,
            onSelect: () => setSortForAll(value),
          })),
          { key: 'folds', divider: true },
          { key: 'collapse-all', label: allCollapsed ? 'Expand all projects' : 'Collapse all projects', onSelect: handleCollapseExpandAll, when: groupBy === 'project' },
          { key: 'collapse', label: tasksCollapsed ? 'Expand Projects' : 'Collapse Projects', onSelect: () => toggleSection('tasks') },
          // Container creation, kept off the list itself: the row it opens lives at the
          // bottom of the grouped list, so a folded Projects section unfolds first.
          { key: 'new-project-divider', divider: true, when: groupBy !== 'none' },
          { key: 'new-project', label: 'New project…', when: groupBy !== 'none', onSelect: () => {
            if (tasksCollapsed) toggleSection('tasks');
            setNewProjectOpen(true);
          } },
        ]} />
      )}

      {/* No pinned/list flex share any more (see the pinned wrapper): the stacked
          view scrolls as ONE column, so the list is simply as tall as it is. The
          detail pane still splits, because that IS two panes side by side. */}
      {tasksVisible && !tasksCollapsed && (
      <div className="todo-panel-list" style={detailTarget ? { flex: `${1 - detailRatio} 1 0%` } : undefined}>
        {loading && (
          <div className="empty-state" style={{ padding: '24px 8px' }}>
            <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2, margin: '0 auto' }} />
          </div>
        )}
        {!loading && isSearchMode && searchFiltered.length === 0 && (
          <div className="empty-state" style={{ padding: '24px 8px' }}>
            {/* While the server pass is still in flight, "no matches yet" is a
                pending state, not an answer — declaring "No tasks match" early
                reads as a (wrong) final verdict for queries with no literal
                title hit. */}
            {isSearching
              ? <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2, margin: '0 auto' }} />
              : (
                searchDoneCount > 0
                  ? (
                    <>
                      <p className="text-sm">No open tasks match &lsquo;{deferredSearchQuery}&rsquo;</p>
                      {/* Inline mirror of the ✓ Done chip so the answer is right
                          where the user is already looking, not up in the strip. */}
                      <button
                        type="button"
                        className="todo-search-done-reveal"
                        onClick={() => setShowDoneResults(true)}
                      >
                        Show {searchDoneCount} completed result{searchDoneCount === 1 ? '' : 's'}
                      </button>
                    </>
                  )
                  : <p className="text-sm">No tasks match &lsquo;{deferredSearchQuery}&rsquo;</p>
              )}
          </div>
        )}
        {/* An EMPTY board (no task at all, not a filter's empty answer) says what
            to do first, and that no project is needed before it. A board whose
            tasks are all elsewhere (pinned above, filtered out) keeps the plain
            line. A project just made from the menu draws its own empty group. */}
        {!loading && !isSearchMode && filtered.length === 0 && tasks.length === 0 && freshProjects.length === 0 && (
          <div className="empty-state todo-empty-board" data-testid="todo-empty-board">
            <p className="todo-empty-board-title">No tasks yet</p>
            <p className="text-sm">Start with New task above. Projects are created for you as you go.</p>
          </div>
        )}
        {/* F35: a list emptied only because its tasks sit in Pinned above says nothing. */}
        {!loading && !isSearchMode && filtered.length === 0 && filterResult.list.length === 0 && tasks.length > 0 && !showFilterEmpty && (
          <div className="empty-state" style={{ padding: '24px 8px' }}>
            <p className="text-sm">No tasks found</p>
          </div>
        )}
        {/* Search mode: ONE flat ranked list (no tier, project or parent grouping: a
            hit tucked under a folded parent would read as "not found", and nesting
            would move a literal hit after it was shown). Literal hits lead, server
            hits append, the loose tail folds behind the Related row. */}
        {!loading && isSearchMode && searchFiltered.length > 0 && (
          <div className="todo-search-results">
            {(() => {
              const renderSearchRows = (rows: Task[]) => {
                return rows.map((task) => {
                  const tier = pinnedTaskIds?.has(task.id) ? getTier(task.id) : undefined;
                  return (
                    <SortableTaskItem
                      key={task.id}
                      task={task}
                      isFocused={focusedTaskId === task.id}
                      isDetailOpen={focusedTaskId === task.id && !suppressDetail}
                      isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                      isVanishing={isRowVanishing(task)}
                      isNestTarget={nestTargetId === task.id} isGroupTarget={groupTargetId === task.id}
                      onClick={handleTaskClick}
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
                      onMoveUp={moveUpMap.has(task.id) ? handleMoveUpById : undefined}
                      onMoveToProject={onMoveTask ? handleMoveToProject : undefined}
                      isPinned={pinnedTaskIds?.has(task.id)}
                      pinnedTier={getTier(task.id)}
                      searchContext={task.project || 'Inbox'}
                      searchTierLabel={tier ? tierDisplayLabel(tier, customTiers) : undefined}
                      filterOverrideReason={(task.id === filterOverrideId || task.id === fadingOverrideId) ? filterOverrideNode : undefined}
                      isFadingOverride={fadingOverrideId === task.id}
                    />
                  );
                });
              };
              const renderFold = (kind: 'completed' | 'related', label: string, count: number, expanded: boolean, toggle: () => void, what: string) => count > 0 && (
                <button
                  type="button"
                  className={`todo-search-fold-toggle todo-search-${kind}-toggle${expanded ? ' expanded' : ''}`}
                  aria-expanded={expanded}
                  title={`${expanded ? 'Hide' : 'Show'} ${what}`}
                  onClick={toggle}
                >
                  <span>{label} ({count})</span>
                  <span className="todo-search-fold-chevron" aria-hidden="true">{'\u203A'}</span>
                </button>
              );
              return (
                <>
                  {renderSearchRows(searchFiltered)}
                  {renderFold('completed', 'Completed', searchSplit.completed.length, showCompletedResults, () => setShowCompletedResults((v) => !v), 'more completed tasks that match')}
                  {searchCompletedRows.length > 0 && renderSearchRows(searchCompletedRows)}
                  {renderFold('related', 'Related', searchSplit.related.length, showRelatedResults, () => setShowRelatedResults((v) => !v), 'loosely related results')}
                  {searchRelatedRows.length > 0 && renderSearchRows(searchRelatedRows)}
                </>
              );
            })()}
          </div>
        )}
        {/* Flat mode: ungrouped list sorted by selected sort option */}
        {!loading && !isSearchMode && groupBy === 'none' && sorted.length > 0 && (
          <div className="todo-flat-results">
            {(() => {
            const batch = cutRows(FLAT_BATCH_KEY, sorted.filter((t) => !isChildHidden(t.id)));
            const row = (task: Task) => (
                <SortableTaskItem
                  key={task.id}
                  task={task}
                  isFocused={focusedTaskId === task.id}
                  isDetailOpen={focusedTaskId === task.id && !suppressDetail}
                  isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                  isVanishing={isRowVanishing(task)}
                  isNestTarget={nestTargetId === task.id} isGroupTarget={groupTargetId === task.id}
                  depth={depthMap.get(task.id) ?? 0}
                  childCount={trueChildCountMap.get(task.id)}
                  isExpanded={expandedParents.has(task.id)}
                  onToggleExpand={toggleParentExpand}
                  onClick={handleTaskClick}
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
                  onMoveUp={moveUpMap.has(task.id) ? handleMoveUpById : undefined}
                  onMoveToProject={onMoveTask ? handleMoveToProject : undefined}
                  isPinned={pinnedTaskIds?.has(task.id)}
                  searchContext={task.project || 'Inbox'}
                  filterOverrideReason={(task.id === filterOverrideId || task.id === fadingOverrideId) ? filterOverrideNode : undefined}
                  isFadingOverride={fadingOverrideId === task.id}
                  groupInfo={listGroupInfo.get(task.id)}
                  onRenameGroup={handleRenameGroup}
                  onUngroupTask={onUngroupTask}
                  isGroupHidden={!!(task.group_id && hiddenGroups?.has(task.group_id))}
                  onUnhideGroup={handleUnhideGroup}
                  onDissolveGroup={handleDissolveGroup}
                  // Flat mode folds exactly like the grouped list: ONE collapse
                  // set, shared by every list mode.
                  folderCollapsed={isRowFolderCollapsed(task.id)}
                  onToggleFolder={toggleListFolder}
                  folderProject={task.group_id ? folderOwnerProject(folderMeta?.[task.group_id], task) : undefined}
                  onMoveFolderToProject={handleMoveFolderToProject}
                />
            );
            return (<>
            {batch.head.map(row)}
            {batch.hidden > 0 && <ShowMoreRow batchKey={FLAT_BATCH_KEY} hidden={batch.hidden} onShowMore={showMoreRows} />}
            {batch.tail.map(row)}
            </>);
            })()}
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
                      <ProjectHeaderRow
                        project={project}
                        taskCount={projTasks.length}
                        collapsed={isListProjectCollapsed(project)}
                        source={projectRegistry.sourceByName.get(project.toLowerCase())}
                        droppableDisabled={activeDragType !== 'task'}
                        dragHandleProps={dragHandleProps}
                        isFavorite={favorites?.isProjectFavorite(project)}
                        onToggleFavorite={favorites ? favorites.toggleFavoriteProject : undefined}
                        onToggleCollapse={toggleListProject}
                        onViewDetails={showProjectDetail}
                        // handleHeaderAddTask, not a raw signal write: it unfolds the
                        // project first, so the ghost row can never open inside a group
                        // whose rows are unmounted.
                        onAddTask={handleHeaderAddTask}
                        onAddFolder={onCreateFolder ? handleCreateFolder : undefined}
                        onAddSession={onOpenLauncherForProject}
                        // Neighbours from the order this list DRAWS, so "up" is the
                        // header directly above — not a slot in the stored order that
                        // may hold a project with no tasks in view.
                        onMoveUp={(p) => moveProjectBy(allGroupKeys, p, -1)}
                        onMoveDown={(p) => moveProjectBy(allGroupKeys, p, 1)}
                        sort={sortForProject(project)}
                        onSetSort={setProjectSort}
                        onFilterToProject={filterToProject}
                      />
                      {!isListProjectCollapsed(project) && (() => {
                        const batch = cutRows(project, projTasks.filter((t) => !isChildHidden(t.id)));
                        const row = (task: Task) => (
                              <SortableTaskItem
                                key={task.id}
                                task={task}
                                isFocused={focusedTaskId === task.id}
                                isDetailOpen={focusedTaskId === task.id && !suppressDetail}
                                isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                                isVanishing={isRowVanishing(task)}
                                isNestTarget={nestTargetId === task.id} isGroupTarget={groupTargetId === task.id}
                                depth={depthMap.get(task.id) ?? 0}
                                childCount={trueChildCountMap.get(task.id)}
                                isExpanded={expandedParents.has(task.id)}
                                onToggleExpand={toggleParentExpand}
                                onClick={handleTaskClick}
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
                                onMoveUp={moveUpMap.has(task.id) ? handleMoveUpById : undefined}
                                onMoveToProject={onMoveTask ? handleMoveToProject : undefined}
                                isPinned={pinnedTaskIds?.has(task.id)}
                                pinnedTier={getTier(task.id)}
                                filterOverrideReason={(task.id === filterOverrideId || task.id === fadingOverrideId) ? filterOverrideNode : undefined}
                                isFadingOverride={fadingOverrideId === task.id}
                                groupInfo={listGroupInfo.get(task.id)}
                                onRenameGroup={handleRenameGroup}
                                onUngroupTask={onUngroupTask}
                                isGroupHidden={!!(task.group_id && hiddenGroups?.has(task.group_id))}
                                onUnhideGroup={handleUnhideGroup}
                                onDissolveGroup={handleDissolveGroup}
                                folderCollapsed={isRowFolderCollapsed(task.id)}
                                onToggleFolder={toggleListFolder}
                                folderProject={task.group_id ? folderOwnerProject(folderMeta?.[task.group_id], task) : undefined}
                                onMoveFolderToProject={handleMoveFolderToProject}
                              />
                        );
                        return (
                        <SortableContext items={batch.head.concat(batch.tail).map((t) => t.id)} strategy={verticalListSortingStrategy}>
                          {batch.head.map(row)}
                          {batch.hidden > 0 && <ShowMoreRow batchKey={project} hidden={batch.hidden} onShowMore={showMoreRows} />}
                          {batch.tail.map(row)}
                          {(emptyFoldersByProject.get((project || '').toLowerCase()) ?? []).map((f) => (
                            <EmptyFolderRow
                              key={f.groupId}
                              groupId={f.groupId}
                              label={f.label}
                              project={project}
                              onRename={handleRenameGroup}
                              onDelete={onDeleteFolder ? handleDissolveGroup : undefined}
                              onMoveToProject={handleMoveFolderToProject}
                            />
                          ))}
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
                        );
                      })()}
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
                outline), mounted only while "New project…" asked for it. The new
                empty group appears directly above this row (see freshProjects in
                the grouped memo). */}
            {newProjectOpen && <NewProjectRow
              onError={onOperationError}
              onClose={closeNewProject}
              onCreated={(name) => {
                setFreshProjects((prev) => (prev.includes(name) ? prev : [...prev, name]));
                projectRegistry.refresh();
                // Open the new group's ghost add row so the very next keystroke
                // is the first task's title.
                handleHeaderAddTask(name);
              }}
            />}
          </DndContext>
        )}
      </div>
      )}
      </div>

      </NavigationSection>
      </NavigationSections>
      </div>

      {/* Filter footer: what the default filters hide in this view (spec 5.6). */}
      {!isSearchMode && (
        <TodoFilterFooter
          tasks={footerTasks}
          ctx={filterEvalCtx}
          archiveHidden={footerTasks === tasks ? (tasksStore?.completedHidden ?? 0) : 0}
          onApply={applyFromFooter}
        />
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
