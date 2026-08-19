/**
 * view-filter-model — pure state model behind the [▾ View] filter panel.
 *
 * Everything here is React-free so the sentence builder and the cross-dimension
 * search index can be unit-tested without a DOM. `ViewDropdown.tsx` re-exports
 * the whole module, so existing importers (`TodoPanel`, `DashboardPage`,
 * `TaskFilterChips`) keep their import paths.
 */

// Relative import, NOT '@/utils/session-status': this module is imported by a
// unit test, and an aliased runtime import ties every consumer to configs that
// declare the alias — when one didn't (base vitest, before it gained the block),
// the test died at collection with zero assertions, invisible to the baseline gate.
import { PHASE_LABELS } from '../../utils/session-status';
import type { TaskPhase, TaskPriority } from '@open-walnut/core';
import { QUERY_TASK_PHASES } from '@open-walnut/task-query';
import type {
  TaskCompletion,
  TaskQuery,
  TaskQuerySort,
  TaskQueryTime,
  TimeBasis,
} from '@open-walnut/task-query';

// ── Canonical query filter state (shared by TodoPanel and DashboardPage) ──

/** Tri-state boolean control: `undefined` = "any", i.e. condition not applied. */
export type TriState = boolean | undefined;

/** Relative time window: a preset key, or a custom positive N + unit. */
export type TimePresetKey = '1h' | '6h' | '24h' | '7d' | '30d' | 'custom';

export interface TaskQueryFilterState {
  /** OR-ed within the field. Empty = no completion condition. */
  completion: TaskCompletion[];
  /** Exact phases, OR-ed. AND-ed with `completion` when both are set. */
  phases: TaskPhase[];
  /** Project names, matched case-insensitively. `''` is a valid entry = Inbox. */
  projects: string[];
  priorities: TaskPriority[];
  sources: string[];
  sprints: string[];
  tagsAny: string[];
  pinned: TriState;
  blocked: TriState;
  timeBasis: TimeBasis;
  /** `null` = no time window at all. */
  timePreset: TimePresetKey | null;
  /** Read only when `timePreset === 'custom'`. Must be a positive integer. */
  timeCustomValue: number;
  timeCustomUnit: 'hours' | 'days';
  sort: TaskQuerySort;
}

/**
 * Neutral default: nothing filtered, newest-updated first. Deliberately carries
 * NO implicit "hide completed": hiding completed tasks is an explicit choice a
 * surface makes (/tasks seeds `completion: ['todo','in_progress']`, the home
 * panel keeps its own ✓ Done toggle), never a rule buried in the evaluator.
 */
export const DEFAULT_TASK_QUERY_FILTER_STATE: TaskQueryFilterState = {
  completion: [],
  phases: [],
  projects: [],
  priorities: [],
  sources: [],
  sprints: [],
  tagsAny: [],
  pinned: undefined,
  blocked: undefined,
  timeBasis: 'updated',
  timePreset: null,
  timeCustomValue: 24,
  timeCustomUnit: 'hours',
  sort: 'updated_desc',
};

/**
 * Each preset carries its own UNIT. A day preset must stay a day preset all the
 * way through: collapsing 7d/30d to 168/720 hours made the chip and the panel
 * summary read "Updated ≤ 720h", which nobody thinks in.
 */
const PRESET_WINDOWS: Record<Exclude<TimePresetKey, 'custom'>, { value: number; unit: 'hours' | 'days' }> = {
  '1h': { value: 1, unit: 'hours' },
  '6h': { value: 6, unit: 'hours' },
  '24h': { value: 24, unit: 'hours' },
  '7d': { value: 7, unit: 'days' },
  '30d': { value: 30, unit: 'days' },
};

export const COMPLETION_OPTIONS: { value: TaskCompletion; label: string }[] = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'Doing' },
  { value: 'complete', label: 'Done' },
];

/**
 * Full phase list, derived from QUERY_TASK_PHASES — don't restate the count
 * here, it goes stale on every phase-model change (was "7", then "5"; the set
 * is whatever the shared query model says). The legacy control showed only
 * TODO/COMPLETE.
 * Derived, not hand-written: the phase set comes from the shared query model and
 * the labels from the canonical PHASE_LABELS table, so a new phase or a relabel
 * lands here automatically instead of needing a third copy kept in step.
 */
export const PHASE_FILTER_OPTIONS: { value: TaskPhase; label: string }[] =
  QUERY_TASK_PHASES.map((value) => ({ value, label: PHASE_LABELS[value] }));

export const QUERY_PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'immediate', label: 'Immediate' },
  { value: 'important', label: 'Important' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'none', label: 'None' },
];

export const TIME_BASIS_OPTIONS: { value: TimeBasis; label: string }[] = [
  { value: 'created', label: 'Created' },
  { value: 'updated', label: 'Updated' },
  { value: 'created_or_updated', label: 'Either' },
];

export const TIME_PRESET_OPTIONS: { value: TimePresetKey; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'custom', label: 'Custom' },
];

export const QUERY_SORT_OPTIONS: { value: TaskQuerySort; label: string }[] = [
  { value: 'updated_desc', label: 'Updated' },
  { value: 'created_desc', label: 'Created' },
  { value: 'completed_desc', label: 'Completed' },
  { value: 'priority', label: 'Priority' },
  { value: 'title_asc', label: 'Title' },
];

/** Resolve the state's time selection into a `TaskQueryTime`, or undefined. */
export function taskQueryTime(state: TaskQueryFilterState): TaskQueryTime | undefined {
  if (state.timePreset === null) return undefined;
  if (state.timePreset === 'custom') {
    // A half-typed custom value ('' → NaN, or 0) means "no window yet", not an
    // error: normalizeTaskQuery would throw on it and blank the whole list.
    const value = Math.floor(state.timeCustomValue);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return { basis: state.timeBasis, last: { value, unit: state.timeCustomUnit } };
  }
  const preset = PRESET_WINDOWS[state.timePreset];
  return { basis: state.timeBasis, last: { value: preset.value, unit: preset.unit } };
}

/**
 * Convert the UI state into the canonical `TaskQuery`. Empty arrays and
 * `undefined` tri-states are OMITTED — an empty array would mean "match nothing"
 * to the shared evaluator, the opposite of "no condition".
 *
 * `sort` always rides along: the shared comparator needs a key, and
 * 'updated_desc' is a default rather than an active filter.
 */
export function toTaskQuery(state: TaskQueryFilterState): TaskQuery {
  const query: TaskQuery = { sort: state.sort };
  if (state.completion.length) query.completion = [...state.completion];
  if (state.phases.length) query.phases = [...state.phases];
  if (state.projects.length) query.projects = [...state.projects];
  if (state.priorities.length) query.priorities = [...state.priorities];
  if (state.sources.length) query.sources = [...state.sources];
  if (state.sprints.length) query.sprints = [...state.sprints];
  if (state.tagsAny.length) query.tagsAny = [...state.tagsAny];
  if (state.pinned !== undefined) query.pinned = state.pinned;
  if (state.blocked !== undefined) query.blocked = state.blocked;
  const time = taskQueryTime(state);
  if (time) query.time = time;
  return query;
}

/** True when at least one real condition is set (`sort` alone doesn't count). */
export function hasActiveTaskQuery(state: TaskQueryFilterState): boolean {
  return Object.keys(toTaskQuery(state)).some((key) => key !== 'sort');
}

/** True when an explicit pinned condition is set — the surfaces use this to
 *  suppress the separate Focus/Pinned area so a pinned task can't appear twice. */
export function isPinnedFiltered(state: TaskQueryFilterState): boolean {
  return state.pinned !== undefined;
}

/** Toggle one value of an array dimension (OR-within-field semantics). */
export function toggleQueryValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

/** Human label for the active time window (chips + panel summary). */
export function timeWindowLabel(state: TaskQueryFilterState): string | null {
  const time = taskQueryTime(state);
  if (!time?.last) return null;
  const basis = TIME_BASIS_OPTIONS.find((o) => o.value === state.timeBasis)?.label ?? state.timeBasis;
  return `${basis} ≤ ${time.last.value}${time.last.unit === 'hours' ? 'h' : 'd'}`;
}

// ── Filter sentence (Design "Receipt") ──
//
// The active query rendered as one plain-English line: word tokens between
// removable value chips. The panel shows it under the search bar so the whole
// filter state is readable at a glance — and every chip carries the patch that
// removes just that one condition.

export type SentenceToken =
  | { kind: 'word'; text: string }
  | {
      kind: 'chip';
      /** Dimension key, stable for tests/styling (e.g. 'projects'). */
      dim: string;
      /** Raw value inside the dimension (e.g. '' for Inbox). */
      value: string;
      /** Human label shown in the chip. */
      label: string;
      /** State with ONLY this condition removed. */
      removed: TaskQueryFilterState;
    };

function labelOf<T extends string>(options: { value: T; label: string }[], value: T): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/** The array-valued dimensions a sentence chip can remove one value from.
 *  Narrowed on purpose: a computed key in an object spread ({...state, [dim]: x})
 *  type-checks as `string` and would silently accept `'pinned'` or `'sort'`,
 *  corrupting the removed state — this union keeps the spread honest. */
type ArrayDim = 'completion' | 'phases' | 'priorities' | 'projects' | 'sources' | 'sprints' | 'tagsAny';

/** Append `lead` word(s), then one chip per value joined by `joiner` words. */
function pushGroup(
  tokens: SentenceToken[],
  state: TaskQueryFilterState,
  dim: ArrayDim,
  values: string[],
  labels: string[],
  lead: string,
  joiner: string,
): void {
  if (!values.length) return;
  if (tokens.length > 1) tokens.push({ kind: 'word', text: ', ' });
  if (lead) tokens.push({ kind: 'word', text: `${lead} ` });
  values.forEach((value, i) => {
    if (i > 0) tokens.push({ kind: 'word', text: ` ${joiner} ` });
    tokens.push({
      kind: 'chip',
      dim,
      value,
      label: labels[i],
      removed: { ...state, [dim]: values.filter((v) => v !== value) },
    });
  });
}

/**
 * Build the sentence for a query state. Always starts with "Showing"; an empty
 * query yields the neutral "Showing every task." line (word tokens only).
 * Sort is NOT part of the sentence — it's a presentation default, not a filter
 * (the panel footer shows it separately).
 */
export function buildFilterSentence(state: TaskQueryFilterState): SentenceToken[] {
  const tokens: SentenceToken[] = [{ kind: 'word', text: 'Showing ' }];

  pushGroup(tokens, state, 'completion', state.completion,
    state.completion.map((v) => labelOf(COMPLETION_OPTIONS, v)), '', 'or');
  pushGroup(tokens, state, 'phases', state.phases,
    state.phases.map((v) => labelOf(PHASE_FILTER_OPTIONS, v)), 'in phase', 'or');
  pushGroup(tokens, state, 'priorities', state.priorities,
    state.priorities.map((v) => labelOf(QUERY_PRIORITY_OPTIONS, v)), 'priority', 'or');
  pushGroup(tokens, state, 'projects', state.projects,
    state.projects.map((v) => (v === '' ? 'Inbox' : v)), 'in', 'or');
  pushGroup(tokens, state, 'tagsAny', state.tagsAny, state.tagsAny, 'tagged', 'or');
  pushGroup(tokens, state, 'sources', state.sources, state.sources, 'from', 'or');
  pushGroup(tokens, state, 'sprints', state.sprints, state.sprints, 'in sprint', 'or');

  if (state.pinned !== undefined) {
    if (tokens.length > 1) tokens.push({ kind: 'word', text: ', ' });
    tokens.push({
      kind: 'chip', dim: 'pinned', value: String(state.pinned),
      label: state.pinned ? 'pinned' : 'not pinned',
      removed: { ...state, pinned: undefined },
    });
  }
  if (state.blocked !== undefined) {
    if (tokens.length > 1) tokens.push({ kind: 'word', text: ', ' });
    tokens.push({
      kind: 'chip', dim: 'blocked', value: String(state.blocked),
      label: state.blocked ? 'blocked' : 'not blocked',
      removed: { ...state, blocked: undefined },
    });
  }

  const time = taskQueryTime(state);
  if (time?.last) {
    if (tokens.length > 1) tokens.push({ kind: 'word', text: ', ' });
    const basisWord = state.timeBasis === 'created' ? 'created in'
      : state.timeBasis === 'updated' ? 'updated in' : 'active in';
    tokens.push({ kind: 'word', text: `${basisWord} ` });
    tokens.push({
      kind: 'chip', dim: 'time', value: state.timePreset ?? '',
      label: `${time.last.value}${time.last.unit === 'hours' ? 'h' : 'd'}`,
      removed: { ...state, timePreset: null },
    });
  }

  if (tokens.length === 1) {
    tokens.push({ kind: 'word', text: 'every task.' });
  } else {
    tokens.push({ kind: 'word', text: '.' });
  }
  return tokens;
}

// ── Cross-dimension search index ──
//
// The panel's search box matches option labels AND dimension names across every
// query dimension, so "wal" finds project Walnut and "pin" finds Pinned · Yes
// without knowing which section they live in.

export interface FilterSearchOption {
  /** Owning rail-section id — the panel uses it to special-case single-select
   *  sections (picking an already-selected 'q-sort' option is skipped). */
  section: string;
  /** Dimension display name, e.g. "Project". */
  dimension: string;
  label: string;
  selected: boolean;
  /** State with this option toggled (on→off / off→on). */
  toggled: TaskQueryFilterState;
}

export interface FilterSearchGroup {
  dimension: string;
  options: FilterSearchOption[];
}

export interface FilterSearchLists {
  projectOptions: string[];
  sourceOptions: string[];
  sprintOptions: string[];
}

/** Case-insensitive substring match on the option label or its dimension name. */
function matches(query: string, dimension: string, label: string): boolean {
  return label.toLowerCase().includes(query) || dimension.toLowerCase().includes(query);
}

export function searchFilterOptions(
  state: TaskQueryFilterState,
  lists: FilterSearchLists,
  rawQuery: string,
): FilterSearchGroup[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const groups: FilterSearchGroup[] = [];
  const push = (dimension: string, options: FilterSearchOption[]) => {
    if (options.length) groups.push({ dimension, options });
  };

  const arrayDim = (
    section: string, dimension: string,
    dim: 'completion' | 'phases' | 'priorities' | 'projects' | 'sources' | 'sprints',
    options: { value: string; label: string }[],
  ) => {
    push(dimension, options
      .filter((o) => matches(query, dimension, o.label))
      .map((o) => ({
        section,
        dimension,
        label: o.label,
        selected: (state[dim] as string[]).includes(o.value),
        toggled: { ...state, [dim]: toggleQueryValue(state[dim] as string[], o.value) },
      })));
  };

  arrayDim('q-status', 'Status', 'completion', COMPLETION_OPTIONS);
  arrayDim('q-phase', 'Phase', 'phases', PHASE_FILTER_OPTIONS);
  arrayDim('q-priority', 'Priority', 'priorities', QUERY_PRIORITY_OPTIONS);
  arrayDim('q-project', 'Project', 'projects',
    lists.projectOptions.map((p) => ({ value: p, label: p === '' ? 'Inbox' : p })));
  arrayDim('q-source', 'Source', 'sources',
    lists.sourceOptions.map((s) => ({ value: s, label: s })));
  arrayDim('q-sprint', 'Sprint', 'sprints',
    lists.sprintOptions.map((s) => ({ value: s, label: s })));

  const triDim = (dimension: string, key: 'pinned' | 'blocked') => {
    push(dimension, ([[true, 'Yes'], [false, 'No']] as const)
      .filter(([, l]) => matches(query, dimension, l))
      .map(([v, l]) => ({
        section: 'q-flags',
        dimension,
        label: l,
        selected: state[key] === v,
        toggled: { ...state, [key]: state[key] === v ? undefined : v },
      })));
  };
  triDim('Pinned', 'pinned');
  triDim('Blocked', 'blocked');

  // The haystack strings below are deliberate keyword ALIASES, wider than the
  // displayed dimension names, so "updated"/"sort" find these groups too.
  // 'custom' is excluded from search: a one-click toggle can't supply the
  // value+unit a custom window needs, so it would create an inactive condition.
  push('Time', TIME_PRESET_OPTIONS
    .filter((o) => o.value !== 'custom' && matches(query, 'updated time', o.label))
    .map((o) => ({
      section: 'q-time',
      dimension: 'Time',
      label: o.label,
      selected: state.timePreset === o.value,
      toggled: { ...state, timePreset: state.timePreset === o.value ? null : o.value },
    })));

  push('Order by', QUERY_SORT_OPTIONS
    .filter((o) => matches(query, 'order sort by', o.label))
    .map((o) => ({
      section: 'q-sort',
      dimension: 'Order by',
      label: o.label,
      selected: state.sort === o.value,
      // No "off" branch: the comparator always needs a key. The panel skips
      // picking an already-selected sort so this never fires a no-op change.
      toggled: { ...state, sort: o.value },
    })));

  return groups;
}
