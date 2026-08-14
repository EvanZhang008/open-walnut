/**
 * ViewDropdown — unified [▾ View] panel replacing project tabs, filter rows, and sort controls.
 *
 * Wide (~360px) panel with a 2-column project chip grid and compact filter/sort/group sections.
 *
 * TWO filter layers live here, deliberately separated:
 *
 *  1. QUERY state (`query` + `onQueryChange`) — the canonical `TaskQuery` model
 *     shared with REST and the agent tool. Conditions here decide whether a task
 *     is a real hit. Rendered only when the caller passes the pair, so a surface
 *     can adopt it independently.
 *  2. PRESENTATION state (due-date view filter, group-by, manual sort) — view
 *     concerns that can't be expressed as task-row conditions and so are NOT part
 *     of a TaskQuery. Left exactly as they were.
 *
 * Menu rules honored (web/src/AGENTS.md → "Menus & overlays"): the panel is
 * portalled to <body> with its own measured placement + `maxHeight` (`.vd-panel`
 * sets `overflow-y:auto`), the new controls are custom option rows rather than
 * native `<select>`s, and every value list that can grow (projects/sources/
 * sprints) is a FIXED-height scroll box — the panel's height therefore never
 * changes because the user interacted with it.
 */

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { ICON_SLIDERS } from '../common/Icons';
import { STARRED_TAB, INBOX_TAB } from './task-tabs';
import { log } from '@/utils/log';
import { PHASE_LABELS } from '@/utils/session-status';
import type { TaskPhase, TaskPriority } from '@open-walnut/core';
import { QUERY_TASK_PHASES } from '@open-walnut/task-query';
import type {
  TaskCompletion,
  TaskQuery,
  TaskQuerySort,
  TaskQueryTime,
  TimeBasis,
} from '@open-walnut/task-query';

// ── Presentation types (unchanged) ──

export type SortBy = 'manual' | 'priority' | 'date' | 'updated';
export type GroupBy = 'project' | 'none';
export type DateFilter = '' | 'now' | 'overdue' | 'this-week' | 'no-date';

// ── Canonical query filter state (shared by TodoPanel and DashboardPage) ──

/** Tri-state boolean control: `undefined` = "any", i.e. condition not applied. */
export type TriState = boolean | undefined;

/** Relative time window: a preset key, or a custom positive N + unit. */
export type TimePresetKey = '1h' | '6h' | '24h' | '7d' | '30d' | 'custom';

export interface TaskQueryFilterState {
  /** OR-ed within the field. Empty = no completion condition. */
  completion: TaskCompletion[];
  /** Exact 7-state phases, OR-ed. AND-ed with `completion` when both are set. */
  phases: TaskPhase[];
  /** Project names, matched case-insensitively. `''` is a valid entry = Inbox. */
  projects: string[];
  priorities: TaskPriority[];
  sources: string[];
  sprints: string[];
  tagsAny: string[];
  pinned: TriState;
  starred: TriState;
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
  starred: undefined,
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
 * Full 7-state phase list (the legacy control showed only TODO/COMPLETE).
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

const TIME_BASIS_OPTIONS: { value: TimeBasis; label: string }[] = [
  { value: 'created', label: 'Created' },
  { value: 'updated', label: 'Updated' },
  { value: 'created_or_updated', label: 'Either' },
];

const TIME_PRESET_OPTIONS: { value: TimePresetKey; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'custom', label: 'Custom' },
];

const QUERY_SORT_OPTIONS: { value: TaskQuerySort; label: string }[] = [
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
  if (state.starred !== undefined) query.starred = state.starred;
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

// ── Props ──

/**
 * The legacy blocks (single-value selects, project chips, show-completed) are
 * OPTIONAL as a group: a surface that has moved fully onto the query model
 * (`/tasks`) omits them and gets a query-only panel, while the home panel keeps
 * passing them until its own presentation controls are retired.
 */
export interface ViewDropdownProps {
  /** Project chips. '' = the All chip; INBOX_TAB = tasks with no project. */
  projects?: string[];
  activeProject?: string;
  onProjectChange?: (project: string) => void;
  projectCounts?: Record<string, number>;
  hasStarredContent?: boolean;

  phaseFilter?: string;
  onPhaseFilterChange?: (v: string) => void;
  priorityFilter?: string;
  onPriorityFilterChange?: (v: string) => void;
  tagFilter?: string;
  onTagFilterChange?: (v: string) => void;
  availableTags?: string[];

  dateFilter?: DateFilter;
  onDateFilterChange?: (v: DateFilter) => void;

  sortBy?: SortBy;
  onSortByChange?: (v: SortBy) => void;
  groupBy?: GroupBy;
  onGroupByChange?: (v: GroupBy) => void;

  showCompleted?: boolean;
  onShowCompletedChange?: (v: boolean) => void;
  onClearAll: () => void;

  /**
   * Canonical query block. Rendered ONLY when BOTH are supplied — a surface
   * adopts the shared model without every other surface having to move at the
   * same time, and the legacy controls above keep working until it does.
   */
  query?: TaskQueryFilterState;
  onQueryChange?: (next: TaskQueryFilterState) => void;
  /** Value lists for the query block. Projects default to the chip list. */
  queryProjectOptions?: string[];
  querySourceOptions?: string[];
  querySprintOptions?: string[];
}

// Tab sentinels live in ./task-tabs so ViewDropdown, TodoPanel, MainPage and
// useUrlSync share ONE definition. Re-exported here for existing importers.
export { INBOX_TAB } from './task-tabs';

// Keep in sync with .vd-panel width in globals.css.
const PANEL_WIDTH = 340;

// Legacy two-state control (the full 7 phases live in the query block).
const PHASE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'TODO', label: 'To Do' },
  { value: 'COMPLETE', label: 'Complete' },
];

const PRIORITY_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'immediate', label: '!!' },
  { value: 'important', label: '!' },
  { value: 'backlog', label: '~' },
  { value: 'none', label: '--' },
];

const DATE_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'now', label: 'Now' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'this-week', label: 'Week' },
  { value: 'no-date', label: 'No date' },
];

// Fixed-height scroll boxes: a value list that can grow must NOT change the
// panel's height after open (see the menu rules in the file header).
const LIST_BOX_STYLE = { maxHeight: 88, overflowY: 'auto' as const };

export function ViewDropdown({
  projects, activeProject, onProjectChange, projectCounts, hasStarredContent,
  phaseFilter, onPhaseFilterChange, priorityFilter, onPriorityFilterChange,
  tagFilter, onTagFilterChange, availableTags,
  dateFilter, onDateFilterChange,
  sortBy, onSortByChange, groupBy, onGroupByChange,
  showCompleted, onShowCompletedChange, onClearAll,
  query, onQueryChange, queryProjectOptions, querySourceOptions, querySprintOptions,
}: ViewDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Which legacy blocks this surface still owns. Each is all-or-nothing (value +
  // setter), so a half-wired caller can't render a dead control.
  const hasLegacySelects = onPhaseFilterChange !== undefined
    && onPriorityFilterChange !== undefined && onDateFilterChange !== undefined;
  const hasLegacySortGroup = onSortByChange !== undefined && onGroupByChange !== undefined;
  const hasProjectChips = projects !== undefined && onProjectChange !== undefined;
  const hasShowCompleted = onShowCompletedChange !== undefined;

  const queryActive = !!query && hasActiveTaskQuery(query);
  const hasActiveFilter = !!(phaseFilter || priorityFilter || tagFilter || dateFilter || activeProject || showCompleted) || queryActive;

  // The panel renders in a portal on document.body (fixed coords) so ancestor
  // panels/overflow can never clip it. Smart placement: right-align to the trigger,
  // clamp to the viewport on BOTH edges, cap height to the space below.
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const margin = 8;
    const place = () => {
      const r = containerRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - margin * 2);
      // Right edge of panel aligns with right edge of trigger, then clamp.
      let left = r.right - width;
      if (left + width + margin > window.innerWidth) left = window.innerWidth - width - margin;
      if (left < margin) left = margin;
      const top = r.bottom + 4;
      setPos({ top, left, width, maxHeight: window.innerHeight - top - margin });
    };
    place();
    let raf = 0;
    const onScrollOrResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (containerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Build project chips: [★, All, ...projects]. Inbox rides in the project list
  // when the caller includes it (INBOX_TAB), since '' is taken by the All chip.
  const catChips: { id: string; label: string; count?: number }[] = [];
  if (hasProjectChips) {
    if (hasStarredContent) catChips.push({ id: STARRED_TAB, label: '★' });
    catChips.push({ id: '', label: 'All' });
    for (const project of projects ?? []) {
      catChips.push({ id: project, label: project === INBOX_TAB ? 'Inbox' : project, count: projectCounts?.[project] });
    }
  }

  const patchQuery = (patch: Partial<TaskQueryFilterState>) => {
    if (!query || !onQueryChange) return;
    onQueryChange({ ...query, ...patch });
  };

  return (
    <div className="vd" ref={containerRef}>
      <button
        className={`vd-trigger vd-trigger-icon${hasActiveFilter ? ' vd-has-filter' : ''}`}
        onClick={() => setOpen(!open)}
        title="Filter, sort, and group tasks"
        aria-label="View options"
      >
        {ICON_SLIDERS}
        {hasActiveFilter && <span className="vd-dot" />}
      </button>

      {open && pos && createPortal(
        // Portals escape clipping, NOT event bubbling — without stopPropagation
        // dnd-kit's sensors see these pointer downs and drag the row behind.
        <div
          className="vd-panel"
          ref={panelRef}
          onPointerDown={(e) => e.stopPropagation()}
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
        >
          {/* ── Filters + Sort + Group: unified 2-col grid, label above control ── */}
          {(hasLegacySelects || hasLegacySortGroup) && (
          <div className="vd-grid">
            {hasLegacySelects && (
              <>
                <InlineSelect label="Phase" value={phaseFilter ?? ''} options={PHASE_OPTIONS} onChange={onPhaseFilterChange!} />
                <InlineSelect label="Priority" value={priorityFilter ?? ''} options={PRIORITY_OPTIONS} onChange={onPriorityFilterChange!} />
                <InlineSelect label="Date" value={dateFilter ?? ''} options={DATE_FILTER_OPTIONS} onChange={(v) => onDateFilterChange!(v as DateFilter)} />
                {availableTags && availableTags.length > 0 && onTagFilterChange && (
                  <InlineSelect
                    label="Tag"
                    value={tagFilter ?? ''}
                    options={[{ value: '', label: 'All' }, ...availableTags.slice(0, 20).map(t => ({ value: t, label: t.length > 16 ? t.slice(0, 16) + '…' : t }))]}
                    onChange={onTagFilterChange}
                  />
                )}
              </>
            )}
            {hasLegacySortGroup && (
              <>
                <div className="vd-field">
                  <span className="vd-label">Sort</span>
                  <div className="vd-seg">
                    {([['manual', 'M'], ['priority', 'P↓'], ['date', 'C↓'], ['updated', 'U↓']] as const).map(([val, lbl]) => (
                      <button
                        key={val}
                        className={`vd-seg-btn${sortBy === val ? ' vd-active' : ''}`}
                        onClick={() => onSortByChange!(val)}
                        title={val === 'manual' ? 'Manual order (drag / move buttons)' : undefined}
                      >{lbl}</button>
                    ))}
                  </div>
                </div>
                <div className="vd-field">
                  <span className="vd-label">Group</span>
                  <div className="vd-seg">
                    {([['project', 'Proj'], ['none', 'Flat']] as const).map(([val, lbl]) => (
                      <button key={val} className={`vd-seg-btn${groupBy === val ? ' vd-active' : ''}`} onClick={() => onGroupByChange!(val)}>{lbl}</button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
          )}

          {query && onQueryChange && (
            <QuerySection
              query={query}
              patch={patchQuery}
              projectOptions={queryProjectOptions ?? (projects ?? []).filter((p) => p && p !== INBOX_TAB)}
              sourceOptions={querySourceOptions ?? []}
              sprintOptions={querySprintOptions ?? []}
              leadingSeparator={hasLegacySelects || hasLegacySortGroup}
            />
          )}

          {hasProjectChips && (
            <>
              <div className="vd-sep" />
              {/* ── Projects: 2-column chip grid (bottom) ── */}
              <div className="vd-cats">
                {catChips.map((c) => (
                  <button
                    key={c.id}
                    className={`vd-cat${activeProject === c.id ? ' vd-active' : ''}`}
                    onClick={() => onProjectChange!(c.id)}
                  >
                    <span className="vd-cat-name">{c.label}</span>
                    {c.count !== undefined && <span className="vd-cat-n">{c.count}</span>}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* ── Footer: show-completed toggle + clear ── */}
          <div className="vd-footer">
            {hasShowCompleted && (
              <label className="vd-check">
                <input type="checkbox" checked={!!showCompleted} onChange={() => onShowCompletedChange!(!showCompleted)} />
                Show completed
              </label>
            )}
            {hasActiveFilter && (
              <button className="vd-clear" onClick={onClearAll}>Clear all</button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Query section: the canonical, composable conditions ──

function QuerySection({ query, patch, projectOptions, sourceOptions, sprintOptions, leadingSeparator }: {
  query: TaskQueryFilterState;
  patch: (patch: Partial<TaskQueryFilterState>) => void;
  projectOptions: string[];
  sourceOptions: string[];
  sprintOptions: string[];
  /** False in a query-ONLY panel, where a leading rule is a stray hairline. */
  leadingSeparator: boolean;
}) {
  const timeLabel = timeWindowLabel(query);
  return (
    <div className="vd-query">
      {leadingSeparator && <div className="vd-sep" />}

      <ChipGroup
        label="Status"
        options={COMPLETION_OPTIONS}
        selected={query.completion}
        onToggle={(v) => patch({ completion: toggleQueryValue(query.completion, v) })}
      />
      <ChipGroup
        label="Phase (exact)"
        options={PHASE_FILTER_OPTIONS}
        selected={query.phases}
        onToggle={(v) => patch({ phases: toggleQueryValue(query.phases, v) })}
      />
      <ChipGroup
        label="Priority"
        options={QUERY_PRIORITY_OPTIONS}
        selected={query.priorities}
        onToggle={(v) => patch({ priorities: toggleQueryValue(query.priorities, v) })}
      />
      {projectOptions.length > 0 && (
        <ChipGroup
          label="Project"
          // '' is a real selectable value (the Inbox bucket) — it needs a label,
          // or it renders as an unclickable-looking empty chip.
          options={projectOptions.map((p) => ({ value: p, label: p === '' ? 'Inbox' : p }))}
          selected={query.projects}
          onToggle={(v) => patch({ projects: toggleQueryValue(query.projects, v) })}
          scroll
        />
      )}
      {sourceOptions.length > 0 && (
        <ChipGroup
          label="Source"
          options={sourceOptions.map((s) => ({ value: s, label: s }))}
          selected={query.sources}
          onToggle={(v) => patch({ sources: toggleQueryValue(query.sources, v) })}
          scroll
        />
      )}
      {sprintOptions.length > 0 && (
        <ChipGroup
          label="Sprint"
          options={sprintOptions.map((s) => ({ value: s, label: s }))}
          selected={query.sprints}
          onToggle={(v) => patch({ sprints: toggleQueryValue(query.sprints, v) })}
          scroll
        />
      )}

      <div className="vd-grid">
        <TriStateField label="Pinned" value={query.pinned} onChange={(v) => patch({ pinned: v })} />
        <TriStateField label="Starred" value={query.starred} onChange={(v) => patch({ starred: v })} />
        <TriStateField label="Blocked" value={query.blocked} onChange={(v) => patch({ blocked: v })} />
      </div>

      <div className="vd-field" style={{ marginTop: 8 }}>
        <span className="vd-label">Time{timeLabel ? ` · ${timeLabel}` : ''}</span>
        <div className="vd-seg">
          {TIME_BASIS_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`vd-seg-btn${query.timeBasis === o.value ? ' vd-active' : ''}`}
              data-time-basis={o.value}
              onClick={() => patch({ timeBasis: o.value })}
            >{o.label}</button>
          ))}
        </div>
      </div>
      <div className="vd-cats" style={{ marginTop: 4 }}>
        <button
          className={`vd-cat${query.timePreset === null ? ' vd-active' : ''}`}
          data-time-preset="any"
          onClick={() => patch({ timePreset: null })}
        ><span className="vd-cat-name">Any time</span></button>
        {TIME_PRESET_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`vd-cat${query.timePreset === o.value ? ' vd-active' : ''}`}
            data-time-preset={o.value}
            onClick={() => patch({ timePreset: o.value })}
          ><span className="vd-cat-name">{o.label}</span></button>
        ))}
      </div>
      {query.timePreset === 'custom' && (
        <div className="vd-grid" style={{ marginTop: 4 }}>
          <div className="vd-field">
            <span className="vd-label">Last</span>
            <input
              className="vd-sel"
              type="number"
              min={1}
              step={1}
              aria-label="Custom time window amount"
              value={Number.isFinite(query.timeCustomValue) ? query.timeCustomValue : ''}
              onChange={(e) => patch({ timeCustomValue: Number.parseInt(e.target.value, 10) })}
            />
          </div>
          <div className="vd-field">
            <span className="vd-label">Unit</span>
            <div className="vd-seg">
              {(['hours', 'days'] as const).map((unit) => (
                <button
                  key={unit}
                  className={`vd-seg-btn${query.timeCustomUnit === unit ? ' vd-active' : ''}`}
                  onClick={() => patch({ timeCustomUnit: unit })}
                >{unit === 'hours' ? 'Hours' : 'Days'}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      <ChipGroup
        label="Order by"
        options={QUERY_SORT_OPTIONS}
        selected={[query.sort]}
        onToggle={(v) => patch({ sort: v })}
      />
    </div>
  );
}

/** Multi-toggle chip row. `scroll` bounds a list that can grow after mount. */
function ChipGroup<T extends string>({ label, options, selected, onToggle, scroll }: {
  label: string;
  options: { value: T; label: string }[];
  selected: readonly T[];
  onToggle: (value: T) => void;
  scroll?: boolean;
}) {
  return (
    <div className="vd-field" style={{ marginTop: 8 }}>
      <span className="vd-label">{label}</span>
      <div className="vd-cats" style={scroll ? LIST_BOX_STYLE : undefined}>
        {options.map((o) => (
          <button
            key={o.value}
            className={`vd-cat${selected.includes(o.value) ? ' vd-active' : ''}`}
            data-filter-value={o.value}
            aria-pressed={selected.includes(o.value)}
            onClick={() => onToggle(o.value)}
            title={o.label}
          ><span className="vd-cat-name">{o.label}</span></button>
        ))}
      </div>
    </div>
  );
}

/** Any / Yes / No segmented control for a tri-state condition. */
function TriStateField({ label, value, onChange }: {
  label: string;
  value: TriState;
  onChange: (v: TriState) => void;
}) {
  const choices: { key: string; v: TriState; label: string }[] = [
    { key: 'any', v: undefined, label: 'Any' },
    { key: 'yes', v: true, label: 'Yes' },
    { key: 'no', v: false, label: 'No' },
  ];
  return (
    <div className="vd-field">
      <span className="vd-label">{label}</span>
      <div className="vd-seg">
        {choices.map((c) => (
          <button
            key={c.key}
            className={`vd-seg-btn${value === c.v ? ' vd-active' : ''}`}
            data-tri-state={c.key}
            onClick={() => onChange(c.v)}
          >{c.label}</button>
        ))}
      </div>
    </div>
  );
}

// ── InlineSelect: grid field — small label above a full-width select ──
//
// Native <select> (against the general menu rule) ONLY because these legacy
// controls predate it and existing specs drive them via selectOption; the new
// query controls above are custom option rows. Retire together with the legacy
// props once both surfaces are on the query model.

function InlineSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="vd-field">
      <span className="vd-label">{label}</span>
      <select className={`vd-sel${value ? ' vd-filtered' : ''}`} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

/** Log helper for surfaces adopting the query block — keeps filter changes
 *  traceable in the browser log without every caller writing its own line.
 *
 *  `info`, not `debug`: debug is suppressed at the default level, so the whole
 *  point of the line (reading back what the user had filtered to when they
 *  report "my task vanished") was unavailable exactly when it was needed. A
 *  filter change is a low-frequency, user-driven event — not stream chatter. */
export function logTaskQueryChange(surface: string, next: TaskQueryFilterState): void {
  log.info('tasks', 'task query filter changed', { surface, query: toTaskQuery(next) });
}
