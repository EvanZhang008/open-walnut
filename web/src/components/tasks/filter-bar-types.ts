/**
 * filter-bar-types: shared types and tiny constants for the home task panel's
 * Filter bar and Display menu. Types only (plus a few literal tables) so every
 * package can import it without pulling React or the filter engine.
 */
import type { RefObject } from 'react';
import type { TaskPhase, TaskPriority } from '@open-walnut/core';
import type { TimeBasis } from '@open-walnut/task-query';
import type { TimePresetKey, TriState } from './view-filter-model';
import type { SortBy, GroupBy } from './ViewDropdown';
import type { CustomTierDef } from '@/api/focus';

export type FilterDim =
  | 'status'
  | 'project'
  | 'date'
  | 'source'
  | 'priority'
  | 'blocked'
  | 'tags'
  | 'sprint'
  | 'time';

/** Registry order: chip order, popover row order, search result order. */
export const FILTER_DIMS: readonly FilterDim[] = [
  'status', 'project', 'date', 'source', 'priority', 'blocked', 'tags', 'sprint', 'time',
];
/** The first page's rows; Source folds with the rest (2026-10-03: "source is not important"). */
export const FIRST_LAYER_DIMS: readonly FilterDim[] = ['status', 'project', 'date'];
export const MORE_DIMS: readonly FilterDim[] = ['source', 'priority', 'blocked', 'tags', 'sprint', 'time'];

/** The legacy client-side date filter ids (`data-date-value`). */
export type DateFilterValue = '' | 'now' | 'overdue' | 'this-week';

export interface FilterTime {
  basis: TimeBasis;
  /** `null` = no time window. */
  preset: TimePresetKey | null;
  customValue: number;
  customUnit: 'hours' | 'days';
}

/** The user-facing filter state: one projection over the legacy and query models. */
export interface FilterState {
  status: TaskPhase[];
  /** `''` = Inbox (no project). */
  projects: string[];
  date: DateFilterValue;
  sources: string[];
  priorities: TaskPriority[];
  blocked: TriState;
  tagsAny: string[];
  sprints: string[];
  time: FilterTime;
}

export const DEFAULT_FILTER_TIME: FilterTime = {
  basis: 'updated',
  preset: null,
  customValue: 24,
  customUnit: 'hours',
};

export const DEFAULT_FILTER_STATE: FilterState = {
  status: ['TODO', 'IN_PROGRESS', 'NEED_ACTION'],
  projects: [],
  date: 'now',
  sources: [],
  priorities: [],
  blocked: undefined,
  tagsAny: [],
  sprints: [],
  time: DEFAULT_FILTER_TIME,
};

/** The legacy home-panel filter fields (TodoPanel useState). */
export interface LegacyFilterFields {
  dateFilter: DateFilterValue;
  phaseFilter: string;
  activeProject: string;
  showCompleted: boolean;
  showWaiting: boolean;
}

/** Value lists the popover and chips draw from. */
export interface FilterLists {
  loading: boolean;
  /** Board order, only projects with loaded tasks; `''` first when Inbox has tasks. */
  projects: string[];
  sources: { id: string; label: string }[];
  tags: string[];
  sprints: string[];
  showPriority: boolean;
  tagLabel(tag: string): string;
}

export interface FilterValueOption {
  dim: FilterDim;
  value: string;
  label: string;
  title: string;
  selected: boolean;
  /** Selected, but no task has this value now (muted chip). */
  missing: boolean;
  disabled?: boolean;
  disabledTitle?: string;
}

export interface FilterChip {
  dim: FilterDim;
  /** Dimension name, e.g. `Project`. */
  label: string;
  /** Value text, e.g. `Garden` or `Open, Complete`. */
  value: string;
  /** Full value list. */
  title: string;
  missing: boolean;
  /** The write that returns this dimension to its default. */
  reset(s: FilterState): FilterState;
}

export type FacetCounts = Partial<Record<FilterDim, Record<string, number>>>;

/** One remembered pick; stored as ids, drawn through the registry. */
export interface RecentEntry {
  dim: FilterDim;
  value: string | string[];
  /** How many times the user made this pick (absent = once). Ranks the search hits. */
  uses?: number;
}

export type FilterOrigin =
  | 'menu'
  | 'chip-menu'
  | 'search'
  | 'recent'
  | 'footer'
  | 'board'
  | 'override'
  | 'toast'
  | 'undo';

export type FilterPickMode = 'replace' | 'toggle' | 'only' | 'add';

export interface FilterBarController {
  state: FilterState;
  lists: FilterLists;
  chips: FilterChip[];
  facets: FacetCounts;
  /** `null` = still loading. */
  count: number | null;
  archiveLoading: boolean;
  search: {
    active: boolean;
    includeComplete: { count: number; on: boolean; toggle(): void } | null;
  };
  viewItem: { label: string } | null;
  recent: RecentEntry[];
  apply(next: FilterState, origin: FilterOrigin): void;
  clearAll(): void;
  openDisplay(): void;
  menuOpen: boolean;
  setMenuOpen(open: boolean): void;
  /** A row chip's menu is open: facet counts are wanted (F20). */
  setChipMenuOpen?(open: boolean): void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  rowRef: RefObject<HTMLDivElement | null>;
  listScrollRef: RefObject<HTMLElement | null>;
}

export interface DisplayMenuProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  section: string;
  onSectionChange(id: string): void;
  customTiers: CustomTierDef[];
  quickViews: boolean;
  onQuickViewsChange(v: boolean): void;
  viewTitleHint: string | null;
  sortBy: SortBy;
  projectSortCount: number;
  onSortForAll(v: SortBy): void;
  showSort: boolean;
  groupBy: GroupBy;
  onGroupByChange(v: GroupBy): void;
  showGroup: boolean;
  allCollapsed: boolean;
  onCollapseExpandAll(): void;
  /** The view draws project groups that Collapse all acts on (F05). */
  showCollapse: boolean;
  /** Why Sort and Group do nothing in this view (shown in their rows), when they don't apply. */
  orderNote: string | null;
  tierLayout: { mode: 'project' | 'custom'; onChange(m: 'project' | 'custom'): void } | null;
  recentOrder: { mode: 'updated' | 'created'; onChange(m: 'updated' | 'created'): void } | null;
}
