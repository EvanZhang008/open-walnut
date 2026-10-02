/**
 * filter-bar-model: the dimension registry and the adapters that project the
 * two internal filter models (legacy TodoPanel fields + TaskQueryFilterState)
 * onto one user-facing FilterState, and write it back. Pure, no React.
 *
 * Relative runtime imports on purpose (see view-filter-model.ts header).
 */
import type { TaskPhase, TaskPriority } from '@open-walnut/core';
import { COMPLETION_TO_PHASES } from '@open-walnut/task-query';
import { INBOX_TAB } from './task-tabs';
import { QUERY_PRIORITY_OPTIONS, TIME_PRESET_OPTIONS, type TaskQueryFilterState } from './view-filter-model';
import {
  FILTER_DIMS,
  MORE_DIMS,
  type FilterChip,
  type FilterDim,
  type FilterLists,
  type FilterPickMode,
  type FilterState,
  type FilterValueOption,
  type LegacyFilterFields,
} from './filter-bar-types';
import {
  BLOCKED_OPTIONS,
  DATE_FILTER_OPTIONS,
  MISSING_VALUE_TITLE,
  OPEN_PHASES,
  STATUS_FILTER_ORDER,
  STATUS_LAST_VALUE_TITLE,
  STATUS_TITLES,
  dimLabel,
  hasAllOpen,
  hasName,
  isDimDefault,
  isValueMissing,
  listChipLabel,
  orderStatus,
  priorityLabel,
  resetDim,
  sameName,
  selectedValues,
  sourceLabel,
  statusChipLabel,
  timeBasisWord,
  timeChipText,
  valueLabel,
  withValues,
} from './filter-bar-dims';

export * from './filter-bar-dims';

// ── Status adapter (4.2) ──
type StatusLegacy = Pick<LegacyFilterFields, 'phaseFilter' | 'showWaiting' | 'showCompleted'>;
type StatusQuery = Pick<TaskQueryFilterState, 'phases' | 'completion'>;

/** 4.2 steps 2-3 only: the query side's exact status set, or null. */
export function foldQueryStatus(query: StatusQuery): TaskPhase[] | null {
  if (query.phases.length) return orderStatus(query.phases);
  if (query.completion.length) {
    return orderStatus(query.completion.flatMap((c) => COMPLETION_TO_PHASES[c] ?? []));
  }
  return null;
}

/** 4.2 read: fold both models into one status set S. */
export function readStatusSet(legacy: StatusLegacy, query: StatusQuery): TaskPhase[] {
  const fromQuery = foldQueryStatus(query);
  if (fromQuery && fromQuery.length) return fromQuery;
  const pf = legacy.phaseFilter;
  if (pf === 'TODO') return orderStatus([...OPEN_PHASES, 'WAITING']);
  if (pf && (STATUS_FILTER_ORDER as readonly string[]).includes(pf)) return [pf as TaskPhase];
  const set: TaskPhase[] = [...OPEN_PHASES];
  if (legacy.showWaiting) set.push('WAITING');
  if (legacy.showCompleted) set.push('COMPLETE');
  return orderStatus(set);
}

export interface StatusWrite {
  legacy: StatusLegacy;
  query: StatusQuery;
}

/**
 * 4.2 write table. Returns null for the empty set (refused: the last value
 * cannot be turned off). Supersets of OPEN ride on the legacy toggles so the
 * home list's `isDone && !showCompleted` gate opens; anything else is exact
 * `phases` with the toggles following the set.
 */
export function writeStatusSet(set: readonly TaskPhase[]): StatusWrite | null {
  const s = orderStatus(set);
  if (!s.length) return null;
  const showWaiting = s.includes('WAITING');
  const showCompleted = s.includes('COMPLETE');
  const phases = hasAllOpen(s) ? [] : s;
  return {
    legacy: { phaseFilter: '', showWaiting, showCompleted },
    query: { phases, completion: [] },
  };
}

// ── Project (4.3) ──

export function readProjectSet(query: Pick<TaskQueryFilterState, 'projects'>): string[] {
  return [...query.projects];
}

export interface ProjectWrite {
  query: { projects: string[] };
  legacy: { activeProject: '' };
  /** Tab key bookmark for URL restore and MainPage: the one project, else ''. */
  bookmark: string;
}

export function projectBookmark(projects: readonly string[]): string {
  if (projects.length !== 1) return '';
  return projects[0] === '' ? INBOX_TAB : projects[0];
}

export function writeProjectSet(projects: readonly string[]): ProjectWrite {
  return {
    query: { projects: [...projects] },
    legacy: { activeProject: '' },
    bookmark: projectBookmark(projects),
  };
}

/**
 * Fold the legacy `activeProject` into `query.projects` and drop
 * `query.pinned` (the home Filter has no Pinned dimension). Idempotent.
 */
export function migrateLegacy<L extends Pick<LegacyFilterFields, 'activeProject'>>(
  legacy: L,
  query: TaskQueryFilterState,
): { legacy: L; query: TaskQueryFilterState } {
  let projects = query.projects;
  if (legacy.activeProject) {
    const name = legacy.activeProject === INBOX_TAB ? '' : legacy.activeProject;
    if (!projects.some((p) => sameName(p, name))) projects = [...projects, name];
  }
  return {
    legacy: { ...legacy, activeProject: '' },
    query: { ...query, projects, pinned: undefined },
  };
}

export function readFilterState(legacy: LegacyFilterFields, query: TaskQueryFilterState): FilterState {
  const m = migrateLegacy(legacy, query);
  const q = m.query;
  return {
    status: readStatusSet(m.legacy, q),
    projects: readProjectSet(q),
    date: legacy.dateFilter,
    sources: [...q.sources],
    priorities: [...q.priorities],
    blocked: q.blocked,
    tagsAny: [...q.tagsAny],
    sprints: [...q.sprints],
    time: {
      basis: q.timeBasis,
      preset: q.timePreset,
      customValue: q.timeCustomValue,
      customUnit: q.timeCustomUnit,
    },
  };
}

export interface FilterStateWrite {
  legacy: LegacyFilterFields;
  query: TaskQueryFilterState;
  bookmark: string;
}

/** Write a FilterState back to both models. Keeps prevQuery.sort; pinned undefined. */
export function writeFilterState(next: FilterState, prevQuery: TaskQueryFilterState): FilterStateWrite {
  const status = writeStatusSet(next.status) ?? writeStatusSet(OPEN_PHASES)!;
  const project = writeProjectSet(next.projects);
  return {
    legacy: {
      dateFilter: next.date,
      phaseFilter: status.legacy.phaseFilter,
      activeProject: '',
      showCompleted: status.legacy.showCompleted,
      showWaiting: status.legacy.showWaiting,
    },
    query: {
      completion: status.query.completion,
      phases: status.query.phases,
      projects: project.query.projects,
      priorities: [...next.priorities],
      sources: [...next.sources],
      sprints: [...next.sprints],
      tagsAny: [...next.tagsAny],
      pinned: undefined,
      blocked: next.blocked,
      timeBasis: next.time.basis,
      timePreset: next.time.preset,
      timeCustomValue: next.time.customValue,
      timeCustomUnit: next.time.customUnit,
      sort: prevQuery.sort,
    },
    bookmark: project.bookmark,
  };
}

const PLURALS: Partial<Record<FilterDim, string>> = {
  project: 'projects', source: 'sources', priority: 'priorities', tags: 'tags', sprint: 'sprints',
};

// ── Chips (4.5) ──

function chipFor(state: FilterState, dim: FilterDim, lists: FilterLists): FilterChip | null {
  if (isDimDefault(state, dim)) return null;
  const values = selectedValues(state, dim);
  const labels = values.map((v) => valueLabel(dim, v, lists));
  const full = labels.join(', ');
  let value: string;
  if (dim === 'status') value = statusChipLabel(state.status);
  else if (dim === 'time') value = timeChipText(state.time) ?? `${timeBasisWord(state.time.basis)} in a custom window`;
  else if (PLURALS[dim]) value = listChipLabel(labels, PLURALS[dim]!);
  else value = full;
  const missing = values.length > 0 && values.every((v) => isValueMissing(dim, v, lists));
  return {
    dim,
    label: dimLabel(dim),
    value,
    title: missing ? MISSING_VALUE_TITLE : (dim === 'time' ? value : full),
    missing,
    reset: (s) => resetDim(s, dim),
  };
}

/** One chip per non-default dimension, in registry order. */
export function buildFilterChips(state: FilterState, lists: FilterLists): FilterChip[] {
  const out: FilterChip[] = [];
  for (const dim of FILTER_DIMS) {
    const chip = chipFor(state, dim, lists);
    if (chip) out.push(chip);
  }
  return out;
}

/** `Project: Garden, Status: Open, Complete` for the popover footer. */
export function chipSummary(chips: readonly FilterChip[]): string {
  return chips.map((c) => (c.dim === 'blocked' || c.dim === 'time' ? c.value : `${c.label}: ${c.value}`)).join(', ');
}

export function moreSetCount(state: FilterState): number {
  return MORE_DIMS.filter((dim) => !isDimDefault(state, dim)).length;
}

export function isDimVisible(dim: FilterDim, state: FilterState, lists: FilterLists): boolean {
  switch (dim) {
    case 'status': case 'date': case 'blocked': case 'time': return true;
    case 'project': return lists.loading || lists.projects.length > 0 || state.projects.length > 0;
    case 'source': return lists.sources.length >= 2 || state.sources.length > 0;
    case 'priority': return lists.showPriority;
    case 'tags': return lists.tags.length > 0 || state.tagsAny.length > 0;
    case 'sprint': return lists.sprints.length > 0 || state.sprints.length > 0;
  }
}

// ── Popover values (4.1, G9) ──

export function valueTitle(dim: FilterDim, value: string, lists: FilterLists): string {
  switch (dim) {
    case 'status': return STATUS_TITLES[value as TaskPhase] ?? value;
    case 'project': return value === '' ? 'Tasks with no project' : `Tasks in ${value}`;
    case 'date': return DATE_FILTER_OPTIONS.find((o) => o.value === value)?.title ?? value;
    case 'source':
      return value === 'local' ? 'Tasks that live only in Walnut' : `Tasks synced from ${sourceLabel(value, lists)}`;
    case 'priority': return value === 'none' ? 'Tasks with no priority' : `Tasks with ${priorityLabel(value as TaskPriority)} priority`;
    case 'blocked': return BLOCKED_OPTIONS.find((o) => o.value === value)?.title ?? value;
    case 'tags': return `Tasks tagged ${lists.tagLabel(value)}`;
    case 'sprint': return `Tasks in sprint ${value}`;
    case 'time': return value === 'custom' ? 'Pick your own window' : `Within the last ${value}`;
  }
}

/** All value ids a dimension offers, in display order (no selection applied). */
function universe(dim: FilterDim, lists: FilterLists): string[] {
  switch (dim) {
    case 'status': return [...STATUS_FILTER_ORDER];
    case 'project': return [...lists.projects];
    case 'date': return DATE_FILTER_OPTIONS.map((o) => o.value);
    case 'source': return lists.sources.map((s) => s.id);
    case 'priority': return QUERY_PRIORITY_OPTIONS.map((o) => o.value);
    case 'blocked': return BLOCKED_OPTIONS.map((o) => o.value);
    case 'tags': return [...lists.tags];
    case 'sprint': return [...lists.sprints];
    case 'time': return TIME_PRESET_OPTIONS.map((o) => o.value);
  }
}

/** Values for one popover row: selected-but-missing first, then the list order. */
export function dimValues(dim: FilterDim, state: FilterState, lists: FilterLists): FilterValueOption[] {
  const selected = selectedValues(state, dim);
  const all = universe(dim, lists);
  const isSel = (v: string) => (dim === 'project' ? hasName(selected, v) : selected.includes(v));
  const missingSel = selected.filter((v) =>
    dim === 'project' ? !hasName(all, v) : !all.includes(v));
  const ids = [...missingSel, ...all];
  const lastStatus = dim === 'status' && orderStatus(state.status).length === 1;
  return ids.map((value) => {
    const sel = isSel(value);
    const missing = missingSel.includes(value) && isValueMissing(dim, value, lists);
    const opt: FilterValueOption = {
      dim,
      value,
      label: valueLabel(dim, value, lists),
      title: missing ? MISSING_VALUE_TITLE : valueTitle(dim, value, lists),
      selected: sel,
      missing,
    };
    if (lastStatus && sel) {
      opt.disabled = true;
      opt.disabledTitle = STATUS_LAST_VALUE_TITLE;
    }
    return opt;
  });
}

// ── Picking (6.2, G13) ──

const REPLACE_DIMS: readonly FilterDim[] = ['project', 'source'];
const SINGLE_DIMS: readonly FilterDim[] = ['date', 'blocked', 'time'];

function toggleIn(list: readonly string[], value: string, dim: FilterDim): string[] {
  const has = dim === 'project' ? hasName(list, value) : list.includes(value);
  if (!has) return [...list, value];
  return list.filter((v) => (dim === 'project' ? !sameName(v, value) : v !== value));
}

/**
 * One click on a value. `replace` is the plain click: Project and Source
 * replace (re-click on the sole value removes it), the other multi-select
 * dimensions toggle. `toggle` = checkbox / Cmd-click. `only` = just this value.
 * `add` never removes (search Enter). Single-select dims ignore the mode:
 * Date replaces, Blocked and Time window cancel on re-click. Status never
 * goes empty.
 */
export function pickValue(state: FilterState, dim: FilterDim, value: string, mode: FilterPickMode): FilterState {
  const current = selectedValues(state, dim);
  if (SINGLE_DIMS.includes(dim)) {
    if (dim === 'date') return withValues(state, dim, [value]);
    return withValues(state, dim, current[0] === value ? [] : [value]);
  }
  let next: string[];
  const has = dim === 'project' ? hasName(current, value) : current.includes(value);
  if (mode === 'only') next = [value];
  else if (mode === 'add') next = has ? current : [...current, value];
  else if (mode === 'toggle' || !REPLACE_DIMS.includes(dim)) next = toggleIn(current, value, dim);
  else next = current.length === 1 && has ? [] : [value];
  if (dim === 'status' && next.length === 0) return state;
  return withValues(state, dim, next);
}
