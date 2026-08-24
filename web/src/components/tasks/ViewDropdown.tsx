/**
 * ViewDropdown — unified [▾ View] panel: search bar + filter sentence + a
 * two-pane rail/detail body (the "Receipt" redesign, 2026-08).
 *
 * Layout: a search input spans the top; under it the active query is written
 * out as a plain-English SENTENCE ("Showing Doing, in Walnut or iOS App,
 * updated in 24h.") whose value chips are individually removable; below that a
 * left RAIL lists every filter dimension (with a count badge when set) and the
 * right DETAIL pane shows only the selected dimension's options. Typing in the
 * search box replaces the detail pane with a cross-dimension result list
 * (↑↓ + Enter toggles). The panel is a fixed-height box — the rail and detail
 * scroll internally, the panel itself never grows with content.
 *
 * TWO filter layers live here, deliberately separated:
 *
 *  1. QUERY state (`query` + `onQueryChange`) — the canonical `TaskQuery` model
 *     shared with REST and the agent tool (see ./view-filter-model.ts, which
 *     this file re-exports). Conditions here decide whether a task is a hit.
 *  2. PRESENTATION state (due-date view filter, group-by, manual sort, project
 *     tab) — view concerns that can't be expressed as task-row conditions.
 *     They render as their own rail sections (Projects / Quick / Arrange) only
 *     when the caller passes the legacy prop pairs.
 *
 * Menu rules honored (web/src/AGENTS.md → "Menus & overlays"): the panel is
 * portalled to <body> with measured placement + `maxHeight`, options are custom
 * rows (the legacy selects predate the rule and keep their spec contract), and
 * the body height is FIXED — interacting with the panel never resizes it.
 */

import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ICON_SLIDERS } from '../common/Icons';
import { INBOX_TAB } from './task-tabs';
import { log } from '@/utils/log';
import {
  COMPLETION_OPTIONS,
  PHASE_FILTER_OPTIONS,
  QUERY_PRIORITY_OPTIONS,
  QUERY_SORT_OPTIONS,
  TIME_BASIS_OPTIONS,
  TIME_PRESET_OPTIONS,
  buildFilterSentence,
  hasActiveTaskQuery,
  searchFilterOptions,
  toTaskQuery,
  toggleQueryValue,
  type FilterSearchOption,
  type TaskQueryFilterState,
  type TriState,
} from './view-filter-model';

// The React-free model (state shape, option tables, sentence + search builders)
// lives in ./view-filter-model.ts; re-export it whole so existing importers
// (TodoPanel, DashboardPage, TaskFilterChips) keep their import paths.
export * from './view-filter-model';

// ── Presentation types (unchanged) ──

export type SortBy = 'manual' | 'priority' | 'date' | 'updated';
export type GroupBy = 'project' | 'none';
export type DateFilter = '' | 'now' | 'overdue' | 'this-week' | 'no-date';

// Tab sentinels live in ./task-tabs so ViewDropdown, TodoPanel, MainPage and
// useUrlSync share ONE definition. Re-exported here for existing importers.
export { INBOX_TAB } from './task-tabs';

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

  phaseFilter?: string;
  onPhaseFilterChange?: (v: string) => void;

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

// Wide enough for the 168px rail (.vd-rail column in globals.css) plus a
// readable 2-col detail pane; the placement math clamps to the viewport on
// narrow screens, so the CSS declares no width of its own.
const PANEL_WIDTH = 560;

// Legacy two-state control (the exact phase set lives in the query Phase section).
const PHASE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'TODO', label: 'To Do' },
  { value: 'COMPLETE', label: 'Complete' },
];

const DATE_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'now', label: 'Now' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'this-week', label: 'Week' },
  { value: 'no-date', label: 'No date' },
];

// Date values beyond the two-button pair (All / Now) live in the "More…"
// dropdown of the Quick filters section.
const DATE_MORE_OPTIONS = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'this-week', label: 'This week' },
  { value: 'no-date', label: 'No date' },
];

interface RailSection {
  id: string;
  name: string;
  /** Selected-value count shown as a badge; undefined = never badged. */
  badge?: number;
}

export function ViewDropdown({
  projects, activeProject, onProjectChange, projectCounts,
  phaseFilter, onPhaseFilterChange,
  dateFilter, onDateFilterChange,
  sortBy, onSortByChange, groupBy, onGroupByChange,
  showCompleted, onShowCompletedChange, onClearAll,
  query, onQueryChange, queryProjectOptions, querySourceOptions, querySprintOptions,
}: ViewDropdownProps) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Which legacy blocks this surface still owns. Each is all-or-nothing (value +
  // setter), so a half-wired caller can't render a dead control.
  const hasLegacySelects = onPhaseFilterChange !== undefined && onDateFilterChange !== undefined;
  const hasLegacySortGroup = onSortByChange !== undefined && onGroupByChange !== undefined;
  const hasProjectChips = projects !== undefined && onProjectChange !== undefined;
  const hasShowCompleted = onShowCompletedChange !== undefined;
  const hasQuery = !!query && !!onQueryChange;

  const queryActive = !!query && hasActiveTaskQuery(query);
  const hasActiveFilter = !!(phaseFilter || dateFilter || activeProject || showCompleted) || queryActive;

  // Memoized: the fallback branches allocate, and these arrays feed the
  // sections/search memos below — fresh identities would defeat both.
  const projectOptions = useMemo(
    () => queryProjectOptions ?? (projects ?? []).filter((p) => p && p !== INBOX_TAB),
    [queryProjectOptions, projects],
  );
  const sourceOptions = useMemo(() => querySourceOptions ?? [], [querySourceOptions]);
  const sprintOptions = useMemo(() => querySprintOptions ?? [], [querySprintOptions]);

  // Rail sections, in reading order: Quick filters FIRST (it is the landing
  // page — the most-used controls, one glance away), then the other
  // presentation sections (home panel only), then the canonical query
  // dimensions.
  const sections = useMemo<RailSection[]>(() => {
    const list: RailSection[] = [];
    if (hasLegacySelects) {
      const set = [phaseFilter, dateFilter].filter(Boolean).length;
      list.push({ id: 'quick', name: 'Quick filters', badge: set });
    }
    if (hasProjectChips) list.push({ id: 'projects', name: 'Projects', badge: activeProject ? 1 : 0 });
    if (hasLegacySortGroup) list.push({ id: 'arrange', name: 'Arrange' });
    if (hasQuery && query) {
      list.push({ id: 'q-status', name: 'Status', badge: query.completion.length });
      list.push({ id: 'q-phase', name: 'Phase', badge: query.phases.length });
      list.push({ id: 'q-priority', name: 'Priority', badge: query.priorities.length });
      // Home already has the Projects chip section — a second "Project" row
      // right under it read as a duplicate (user report 2026-08-23). The
      // multi-project query stays reachable there via the panel search;
      // /tasks (no chips) keeps its dedicated section.
      if (projectOptions.length && !hasProjectChips) list.push({ id: 'q-project', name: 'Project', badge: query.projects.length });
      if (sourceOptions.length) list.push({ id: 'q-source', name: 'Source', badge: query.sources.length });
      if (sprintOptions.length) list.push({ id: 'q-sprint', name: 'Sprint', badge: query.sprints.length });
      list.push({
        id: 'q-flags', name: 'Pinned / Blocked',
        badge: (query.pinned !== undefined ? 1 : 0) + (query.blocked !== undefined ? 1 : 0),
      });
      list.push({ id: 'q-time', name: 'Time', badge: query.timePreset ? 1 : 0 });
      list.push({ id: 'q-sort', name: 'Order by' });
    }
    return list;
    // NOT `.length` deps: contents can change at the same length (rename a
    // project) and the memo would go stale. `query` changes on every filter
    // click anyway, so this memo mostly documents the inputs.
  }, [hasProjectChips, hasLegacySelects, hasLegacySortGroup, hasQuery, query,
      activeProject, phaseFilter, dateFilter,
      projectOptions, sourceOptions, sprintOptions]);

  const activeSection = sections.find((s) => s.id === section) ?? sections[0];

  // If the selected section disappears (e.g. the last sprint option goes away
  // on a background refresh), drop the stale id so state and render agree —
  // otherwise the section silently teleports back when the options return.
  useEffect(() => {
    if (section !== null && !sections.some((s) => s.id === section)) setSection(null);
  }, [section, sections]);

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

  // Escape clears an in-progress search first; a second Escape closes the
  // panel. The two-step matters: closing while results are up loses the
  // user's place, and clearing is the cheaper undo. Reads the DOM value (not
  // `search` state) so the listener needs no dep on every keystroke; the
  // input is controlled, so the two can't diverge.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (searchRef.current?.value) { setSearch(''); return; }
      setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Reset transient state per open so the panel always comes up predictable:
  // no stale search, rail on the first section (which differs per surface:
  // home = Quick filters, /tasks = Status). Focus is handled by autoFocus on the
  // search input — this effect can run before the portal mounts (pos is set
  // in a layout effect), so a ref .focus() here would race the mount.
  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSection(null);
    setCursor(0);
  }, [open]);

  const patchQuery = (patch: Partial<TaskQueryFilterState>) => {
    if (!query || !onQueryChange) return;
    onQueryChange({ ...query, ...patch });
  };

  // Cross-dimension search (query model only — the legacy quick filters are
  // already one click away and duplicate the same concepts).
  const searchGroups = useMemo(
    () => (hasQuery && query ? searchFilterOptions(query, { projectOptions, sourceOptions, sprintOptions }, search) : []),
    [hasQuery, query, projectOptions, sourceOptions, sprintOptions, search],
  );
  const searchFlat = useMemo(() => searchGroups.flatMap((g) => g.options), [searchGroups]);
  const searching = search.trim().length > 0;

  // Clamp the cursor on WRITE when the result list shrinks under it (a picked
  // option can drop out of the set), so reads never need their own clamp.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, searchFlat.length - 1)));
  }, [searchFlat.length]);

  // Toggling a single-select option that's already selected (sort) would fire
  // onQueryChange with a deep-equal state — surfaces run side effects on every
  // change (log line, focus-override fade), so skip the no-op at the source.
  const pickSearchOption = (opt: FilterSearchOption) => {
    if (!onQueryChange) return;
    if (opt.selected && opt.section === 'q-sort') return;
    onQueryChange(opt.toggled);
  };

  const handleSearchKey = (e: React.KeyboardEvent) => {
    if (!searching || !searchFlat.length) return;
    if (e.key === 'ArrowDown') { setCursor((c) => Math.min(c + 1, searchFlat.length - 1)); e.preventDefault(); }
    if (e.key === 'ArrowUp') { setCursor((c) => Math.max(c - 1, 0)); e.preventDefault(); }
    if (e.key === 'Enter') {
      const hit = searchFlat[cursor];
      if (hit) pickSearchOption(hit);
      e.preventDefault();
    }
  };

  const sentence = hasQuery && query ? buildFilterSentence(query) : null;

  // The legacy quick filters (Phase/Priority/Date/Tag selects) are folded into
  // the visible list OUTSIDE the query model, so the sentence alone would lie:
  // Date defaults to "Now" and actively hides deferred tasks while the sentence
  // reads "Showing every task." Surface them as non-removable words so the
  // receipt stays honest; they're cleared from their own Quick filters section.
  const quickNotes: string[] = [];
  if (hasLegacySelects) {
    if (dateFilter) quickNotes.push(`date ${DATE_FILTER_OPTIONS.find((o) => o.value === dateFilter)?.label ?? dateFilter}`);
    if (phaseFilter) quickNotes.push(`phase ${PHASE_OPTIONS.find((o) => o.value === phaseFilter)?.label ?? phaseFilter}`);
  }

  // Build project chips: [All, ...projects]. Inbox rides in the project list
  // when the caller includes it (INBOX_TAB), since '' is taken by the All chip.
  const catChips: { id: string; label: string; count?: number }[] = [];
  if (hasProjectChips) {
    catChips.push({ id: '', label: 'All' });
    for (const project of projects ?? []) {
      catChips.push({ id: project, label: project === INBOX_TAB ? 'Inbox' : project, count: projectCounts?.[project] });
    }
  }

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
          {hasQuery && (
            <div className="vd-search">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" aria-hidden>
                <circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" />
              </svg>
              <input
                ref={searchRef}
                autoFocus
                value={search}
                onChange={(e) => { setSearch(e.target.value); setCursor(0); }}
                onKeyDown={handleSearchKey}
                placeholder="Search all filters…"
                aria-label="Search filters"
              />
              {searching && (
                <button className="vd-search-clear" onClick={() => setSearch('')} aria-label="Clear search">×</button>
              )}
            </div>
          )}

          {sentence && (
            <div className="vd-sentence" data-testid="vd-sentence">
              {sentence.map((tok, i) => tok.kind === 'word'
                ? <span key={i} className="vd-sw">{tok.text}</span>
                : (
                  // Two data attributes, not one joined string: a value can
                  // itself contain ':' (project names), which would make a
                  // combined selector ambiguous.
                  <span key={i} className="vd-sc" data-chip-dim={tok.dim} data-chip-value={tok.value}>
                    <span className="vd-sc-label" title={tok.label}>{tok.label}</span>
                    <button
                      className="vd-sc-x"
                      aria-label={`Remove ${tok.label}`}
                      onClick={() => onQueryChange?.(tok.removed)}
                    >×</button>
                  </span>
                ))}
              {quickNotes.length > 0 && (
                <span className="vd-sw"> Quick filters: {quickNotes.join(', ')}.</span>
              )}
            </div>
          )}

          <div className="vd-body">
            {/* Plain buttons, deliberately NOT role=tablist/tab: the ARIA tab
                pattern obliges arrow-key navigation + roving tabIndex, and a
                half-implemented contract is worse for screen readers than an
                honest list of buttons with aria-current. */}
            <div className="vd-rail" aria-label="Filter sections">
              {sections.map((s) => (
                <button
                  key={s.id}
                  aria-current={activeSection?.id === s.id && !searching}
                  className={`vd-rail-btn${activeSection?.id === s.id && !searching ? ' vd-active' : ''}`}
                  data-rail-section={s.id}
                  // Also clears any active search (the detail pane swaps from
                  // results back to the section) — re-selecting the active
                  // section is otherwise a no-op.
                  onClick={() => { setSection(s.id); setSearch(''); }}
                >
                  <span className="vd-rail-name">{s.name}</span>
                  {s.badge !== undefined && (
                    // The badge box always renders (empty when 0) so rail
                    // labels don't shift when a count appears — don't
                    // "simplify" to conditional rendering.
                    <span className={`vd-rail-badge${s.badge > 0 ? ' vd-set' : ''}`}>{s.badge > 0 ? s.badge : ''}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="vd-detail">
              {searching ? (
                <SearchResults groups={searchGroups} flat={searchFlat} cursor={cursor}
                  onPick={pickSearchOption} search={search} />
              ) : (
                <SectionDetail
                  id={activeSection?.id ?? ''}
                  catChips={catChips} activeProject={activeProject} onProjectChange={onProjectChange}
                  phaseFilter={phaseFilter} onPhaseFilterChange={onPhaseFilterChange}
                  dateFilter={dateFilter} onDateFilterChange={onDateFilterChange}
                  sortBy={sortBy} onSortByChange={onSortByChange}
                  groupBy={groupBy} onGroupByChange={onGroupByChange}
                  query={query} patchQuery={patchQuery}
                  projectOptions={projectOptions} sourceOptions={sourceOptions} sprintOptions={sprintOptions}
                />
              )}
            </div>
          </div>

          {/* ── Footer: show-completed toggle + clear. Gated as a whole so a
                surface with neither control doesn't render an empty strip. ── */}
          {(hasShowCompleted || hasActiveFilter) && (
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
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Detail pane: one section at a time ──

function SectionDetail(props: {
  id: string;
  catChips: { id: string; label: string; count?: number }[];
  activeProject?: string;
  onProjectChange?: (p: string) => void;
  phaseFilter?: string; onPhaseFilterChange?: (v: string) => void;
  dateFilter?: DateFilter; onDateFilterChange?: (v: DateFilter) => void;
  sortBy?: SortBy; onSortByChange?: (v: SortBy) => void;
  groupBy?: GroupBy; onGroupByChange?: (v: GroupBy) => void;
  query?: TaskQueryFilterState;
  patchQuery: (patch: Partial<TaskQueryFilterState>) => void;
  projectOptions: string[]; sourceOptions: string[]; sprintOptions: string[];
}) {
  const { id, query, patchQuery } = props;

  if (id === 'projects') {
    return (
      <div className="vd-cats">
        {props.catChips.map((c) => (
          <button
            key={c.id}
            className={`vd-cat${props.activeProject === c.id ? ' vd-active' : ''}`}
            onClick={() => props.onProjectChange!(c.id)}
          >
            <span className="vd-cat-name">{c.label}</span>
            {c.count !== undefined && <span className="vd-cat-n">{c.count}</span>}
          </button>
        ))}
      </div>
    );
  }

  if (id === 'quick') {
    // The landing page stays LEAN (user ruling 2026-08-23): Date is the one
    // filter used every day, so its two everyday values (All / Now) are direct
    // buttons and the long tail hides in a "More…" dropdown. Priority was
    // dropped from here entirely — it still has its own query rail section.
    const df = props.dateFilter ?? '';
    const dfMore = DATE_MORE_OPTIONS.some((o) => o.value === df) ? df : '';
    return (
      <div className="vd-grid">
        <div className="vd-field vd-span2">
          <span className="vd-label">Date</span>
          <div className="vd-daterow">
            <div className="vd-seg">
              {([['', 'All'], ['now', 'Now']] as const).map(([val, lbl]) => (
                <button
                  key={val || 'all'}
                  className={`vd-seg-btn${df === val ? ' vd-active' : ''}`}
                  data-date-value={val}
                  title={val === 'now' ? 'Hide tasks whose start date is still in the future' : 'Show every task, deferred ones included'}
                  onClick={() => props.onDateFilterChange!(val as DateFilter)}
                >{lbl}</button>
              ))}
            </div>
            <select
              className={`vd-sel vd-sel-more${dfMore ? ' vd-filtered' : ''}`}
              aria-label="More date filters"
              value={dfMore}
              onChange={(e) => props.onDateFilterChange!(e.target.value as DateFilter)}
            >
              <option value="">More…</option>
              {DATE_MORE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div className="vd-field vd-span2">
          <span className="vd-label">Phase</span>
          <div className="vd-seg">
            {PHASE_OPTIONS.map((o) => (
              <button
                key={o.value || 'all'}
                className={`vd-seg-btn${(props.phaseFilter ?? '') === o.value ? ' vd-active' : ''}`}
                data-phase-value={o.value}
                onClick={() => props.onPhaseFilterChange!(o.value)}
              >{o.label}</button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (id === 'arrange') {
    return (
      <div className="vd-grid">
        {/* Full words, not P↓/C↓ codes — the pane has the room, and the codes
            read as noise (user review 2026-08-23). */}
        <div className="vd-field vd-span2">
          <span className="vd-label">Sort</span>
          <div className="vd-seg">
            {([
              ['manual', 'Manual', 'Manual order (drag / move buttons)'],
              ['priority', 'Priority', 'Highest priority first'],
              ['date', 'Created', 'Newest first'],
              ['updated', 'Updated', 'Recently updated first'],
            ] as const).map(([val, lbl, tip]) => (
              <button
                key={val}
                className={`vd-seg-btn${props.sortBy === val ? ' vd-active' : ''}`}
                onClick={() => props.onSortByChange!(val)}
                title={tip}
              >{lbl}</button>
            ))}
          </div>
        </div>
        <div className="vd-field vd-span2">
          <span className="vd-label">Group</span>
          <div className="vd-seg">
            {([['project', 'By project'], ['none', 'Flat']] as const).map(([val, lbl]) => (
              <button key={val} className={`vd-seg-btn${props.groupBy === val ? ' vd-active' : ''}`} onClick={() => props.onGroupByChange!(val)}>{lbl}</button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!query) return null;

  // Query sections keep the original .vd-query/.vd-field/data-filter-value
  // markup — the browser specs (task-filters.spec.ts) drive them by it.
  return (
    <div className="vd-query">
      {id === 'q-status' && (
        <ChipGroup label="Status" options={COMPLETION_OPTIONS} selected={query.completion}
          onToggle={(v) => patchQuery({ completion: toggleQueryValue(query.completion, v) })} />
      )}
      {id === 'q-phase' && (
        <ChipGroup label="Phase (exact)" options={PHASE_FILTER_OPTIONS} selected={query.phases}
          onToggle={(v) => patchQuery({ phases: toggleQueryValue(query.phases, v) })} />
      )}
      {id === 'q-priority' && (
        <ChipGroup label="Priority" options={QUERY_PRIORITY_OPTIONS} selected={query.priorities}
          onToggle={(v) => patchQuery({ priorities: toggleQueryValue(query.priorities, v) })} />
      )}
      {id === 'q-project' && (
        <ChipGroup label="Project"
          // '' is a real selectable value (the Inbox bucket) — it needs a label,
          // or it renders as an unclickable-looking empty chip.
          options={props.projectOptions.map((p) => ({ value: p, label: p === '' ? 'Inbox' : p }))}
          selected={query.projects}
          onToggle={(v) => patchQuery({ projects: toggleQueryValue(query.projects, v) })} />
      )}
      {id === 'q-source' && (
        <ChipGroup label="Source" options={props.sourceOptions.map((s) => ({ value: s, label: s }))}
          selected={query.sources}
          onToggle={(v) => patchQuery({ sources: toggleQueryValue(query.sources, v) })} />
      )}
      {id === 'q-sprint' && (
        <ChipGroup label="Sprint" options={props.sprintOptions.map((s) => ({ value: s, label: s }))}
          selected={query.sprints}
          onToggle={(v) => patchQuery({ sprints: toggleQueryValue(query.sprints, v) })} />
      )}
      {id === 'q-flags' && (
        <div className="vd-grid">
          <TriStateField label="Pinned" value={query.pinned} onChange={(v) => patchQuery({ pinned: v })} />
          <TriStateField label="Blocked" value={query.blocked} onChange={(v) => patchQuery({ blocked: v })} />
        </div>
      )}
      {id === 'q-time' && <TimeSection query={query} patchQuery={patchQuery} />}
      {id === 'q-sort' && (
        // Single-select: re-clicking the active sort is skipped, or the no-op
        // patch would still fire the surfaces' on-change side effects.
        <ChipGroup label="Order by" options={QUERY_SORT_OPTIONS} selected={[query.sort]}
          onToggle={(v) => { if (v !== query.sort) patchQuery({ sort: v }); }} />
      )}
    </div>
  );
}

function TimeSection({ query, patchQuery }: {
  query: TaskQueryFilterState;
  patchQuery: (patch: Partial<TaskQueryFilterState>) => void;
}) {
  return (
    <>
      <div className="vd-field">
        <span className="vd-label">Time basis</span>
        <div className="vd-seg">
          {TIME_BASIS_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`vd-seg-btn${query.timeBasis === o.value ? ' vd-active' : ''}`}
              data-time-basis={o.value}
              onClick={() => patchQuery({ timeBasis: o.value })}
            >{o.label}</button>
          ))}
        </div>
      </div>
      <div className="vd-cats" style={{ marginTop: 6 }}>
        <button
          className={`vd-cat${query.timePreset === null ? ' vd-active' : ''}`}
          data-time-preset="any"
          onClick={() => patchQuery({ timePreset: null })}
        ><span className="vd-cat-name">Any time</span></button>
        {TIME_PRESET_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`vd-cat${query.timePreset === o.value ? ' vd-active' : ''}`}
            data-time-preset={o.value}
            onClick={() => patchQuery({ timePreset: o.value })}
          ><span className="vd-cat-name">{o.label}</span></button>
        ))}
      </div>
      {query.timePreset === 'custom' && (
        <div className="vd-grid" style={{ marginTop: 6 }}>
          <div className="vd-field">
            <span className="vd-label">Last</span>
            <input
              className="vd-sel"
              type="number"
              min={1}
              step={1}
              aria-label="Custom time window amount"
              value={Number.isFinite(query.timeCustomValue) ? query.timeCustomValue : ''}
              onChange={(e) => patchQuery({ timeCustomValue: Number.parseInt(e.target.value, 10) })}
            />
          </div>
          <div className="vd-field">
            <span className="vd-label">Unit</span>
            <div className="vd-seg">
              {(['hours', 'days'] as const).map((unit) => (
                <button
                  key={unit}
                  className={`vd-seg-btn${query.timeCustomUnit === unit ? ' vd-active' : ''}`}
                  onClick={() => patchQuery({ timeCustomUnit: unit })}
                >{unit === 'hours' ? 'Hours' : 'Days'}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Search results: grouped, keyboard-navigable ──

function SearchResults({ groups, flat, cursor, onPick, search }: {
  groups: { dimension: string; options: FilterSearchOption[] }[];
  flat: FilterSearchOption[];
  cursor: number;
  onPick: (opt: FilterSearchOption) => void;
  search: string;
}) {
  if (!flat.length) {
    return <div className="vd-none">No filter matches “{search.trim()}”</div>;
  }
  let index = -1;
  return (
    // .vd-query for the shared field spacing; the markup deliberately reuses
    // .vd-cat + data-filter-value so the browser specs' selectors work in
    // search results too. NOTE the attribute carries the LABEL here (ChipGroup
    // carries the VALUE) — search options only expose their display label.
    <div className="vd-query">
      {groups.map((g) => (
        <div className="vd-field" key={g.dimension}>
          <span className="vd-label">{g.dimension}</span>
          <div className="vd-cats">
            {g.options.map((o) => {
              index += 1;
              const cur = index === cursor;
              return (
                <button
                  key={`${g.dimension}:${o.label}`}
                  // Keep the keyboard cursor visible even when it sits below
                  // the detail pane's fold.
                  ref={cur ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                  className={`vd-cat${o.selected ? ' vd-active' : ''}${cur ? ' vd-cursor' : ''}`}
                  data-filter-value={o.label}
                  aria-pressed={o.selected}
                  onClick={() => onPick(o)}
                  title={o.label}
                ><span className="vd-cat-name">{o.label}</span></button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Multi-toggle chip row. Selected chips get a leading ✓ so state is readable
 *  even where accent-on-accent contrast is weak (e.g. bright light themes). */
function ChipGroup<T extends string>({ label, options, selected, onToggle }: {
  label: string;
  options: { value: T; label: string }[];
  selected: readonly T[];
  onToggle: (value: T) => void;
}) {
  return (
    <div className="vd-field">
      <span className="vd-label">{label}</span>
      <div className="vd-cats">
        {options.map((o) => (
          <button
            key={o.value}
            className={`vd-cat${selected.includes(o.value) ? ' vd-active' : ''}`}
            data-filter-value={o.value}
            aria-pressed={selected.includes(o.value)}
            onClick={() => onToggle(o.value)}
            title={o.label}
          >
            {selected.includes(o.value) && <span className="vd-cat-check" aria-hidden>✓</span>}
            <span className="vd-cat-name">{o.label}</span>
          </button>
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
