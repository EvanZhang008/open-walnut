/**
 * ViewDropdown: the /tasks page's filter panel (search bar + filter sentence + a
 * two-pane rail/detail body, the "Receipt" redesign, 2026-08).
 *
 * Layout: a search input spans the top; under it the active query is written
 * out as a plain-English SENTENCE ("Showing To Do, in Walnut or iOS App,
 * updated in 24h.") whose value chips are individually removable; below that a
 * left RAIL lists every filter dimension (with a count badge when set) and the
 * right DETAIL pane shows only the selected dimension's options. Typing in the
 * search box replaces the detail pane with a cross-dimension result list
 * (ArrowUp/ArrowDown + Enter toggles). The panel is a fixed-height box: the rail
 * and detail scroll internally, the panel itself never grows with content.
 *
 * Query-only: it reads and writes the canonical `TaskQuery` model shared with
 * REST and the agent tool (./view-filter-model.ts, re-exported whole here). The
 * home task panel moved to the Filter bar and the Display menu (FilterMenu.tsx,
 * DisplayMenu.tsx); its view, quick filter, project, arrange and footer
 * checkbox branches are gone from this file. Moving /tasks onto the Filter bar
 * too is follow-up work.
 *
 * Status is ONE section (spec D7): the five status words, read from a legacy
 * completion list folded into phases (foldQueryStatus) and written as exact
 * phases with completion cleared, so the hit set of a stored query is unchanged.
 *
 * Menu rules honored (web/src/AGENTS.md, "Menus & overlays"): the panel is
 * portalled to <body> with measured placement + `maxHeight`, options are custom
 * rows, and the body height is FIXED: interacting with the panel never resizes it.
 */

import { useState, useRef, useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { TaskPhase } from '@open-walnut/core';
import { ICON_CHECK, ICON_CLOSE, ICON_SLIDERS } from '../common/Icons';
import '@/styles/view-menu-choices.css';
import { log } from '@/utils/log';
import { useShowPriority } from '@/hooks/useShowPriority';
import { STATUS_OPTIONS } from './TaskStatusControl';
import { STATUS_FILTER_ORDER, foldQueryStatus, statusChipLabel } from './filter-bar-model';
import {
  QUERY_PRIORITY_OPTIONS,
  QUERY_SORT_OPTIONS,
  TIME_BASIS_OPTIONS,
  TIME_PRESET_OPTIONS,
  buildFilterSentence,
  hasActiveTaskQuery,
  searchFilterOptions,
  tagChipOptions,
  toTaskQuery,
  toggleQueryValue,
  withQueryStatus,
  type FilterSearchOption,
  type TaskQueryFilterState,
  type TriState,
} from './view-filter-model';

// The React-free model (state shape, option tables, sentence + search builders)
// lives in ./view-filter-model.ts; re-export it whole so existing importers
// (TodoPanel, DashboardPage, TaskFilterChips) keep their import paths.
export * from './view-filter-model';

// ── Presentation types (shared with the home panel's Display menu) ──

export type SortBy = 'manual' | 'priority' | 'date' | 'updated';
export type GroupBy = 'project' | 'none';
export type DateFilter = '' | 'now' | 'overdue' | 'this-week';

// Tab sentinels live in ./task-tabs so ViewDropdown, TodoPanel, MainPage and
// useUrlSync share ONE definition. Re-exported here for existing importers.
export { INBOX_TAB } from './task-tabs';

export interface ViewDropdownProps {
  onClearAll: () => void;
  query: TaskQueryFilterState;
  onQueryChange: (next: TaskQueryFilterState) => void;
  /** Value lists for the query sections. */
  queryProjectOptions?: string[];
  querySourceOptions?: string[];
  querySprintOptions?: string[];
  /** Every pickable tag, most frequent first (the surface applies the display rules). */
  queryTagOptions?: string[];
}

/** A view-scoped control: a chip, or an on/off switch row when `toggle` is set. */
export interface ViewOption {
  key: string;
  label: string;
  active?: boolean;
  title?: string;
  /** An on/off setting: drawn as a switch row instead of a chip, `active` is its state. */
  toggle?: boolean;
  onSelect: () => void;
  choices?: undefined;
}
/** A setting with a few values: one row, its label on the left, a segmented pick on the right. */
export interface ViewChoiceRow {
  key: string;
  label: string;
  title?: string;
  choices: { key: string; label: string; active: boolean; title?: string; onSelect: () => void }[];
}
export interface ViewOptionGroup { label: string; options: (ViewOption | ViewChoiceRow)[] }

// Wide enough for the 168px rail (.vd-rail column in globals.css) plus a
// readable 2-col detail pane; the placement math clamps to the viewport on
// narrow screens, so the CSS declares no width of its own.
const PANEL_WIDTH = 560;

/** The merged Status values: filter order, STATUS_OPTIONS words and icons. */
const STATUS_VALUES: { value: TaskPhase; label: string; icon: ReactNode }[] = STATUS_FILTER_ORDER.map((value) => {
  const o = STATUS_OPTIONS.find((s) => s.value === value);
  return { value, label: o?.label ?? value, icon: o?.icon };
});

interface RailSection {
  id: string;
  name: string;
  /** Selected-value count shown as a badge; undefined = never badged. */
  badge?: number;
}

export function ViewDropdown({
  onClearAll, query, onQueryChange,
  queryProjectOptions, querySourceOptions, querySprintOptions, queryTagOptions,
}: ViewDropdownProps) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const showPriority = useShowPriority();
  const hasActiveFilter = hasActiveTaskQuery(query);

  // Memoized: the fallback branches allocate, and these arrays feed the
  // sections/search memos below; fresh identities would defeat both.
  const projectOptions = useMemo(() => queryProjectOptions ?? [], [queryProjectOptions]);
  const sourceOptions = useMemo(() => querySourceOptions ?? [], [querySourceOptions]);
  const sprintOptions = useMemo(() => querySprintOptions ?? [], [querySprintOptions]);
  const tagOptions = useMemo(() => queryTagOptions ?? [], [queryTagOptions]);
  const statusSet = foldQueryStatus(query) ?? [];

  // Rail sections, in reading order: Status first (the panel lands on it).
  const sections = useMemo<RailSection[]>(() => {
    const list: RailSection[] = [];
    list.push({ id: 'q-status', name: 'Status', badge: (foldQueryStatus(query) ?? []).length });
    if (showPriority) list.push({ id: 'q-priority', name: 'Priority', badge: query.priorities.length });
    if (projectOptions.length) list.push({ id: 'q-project', name: 'Project', badge: query.projects.length });
    if (sourceOptions.length) list.push({ id: 'q-source', name: 'Source', badge: query.sources.length });
    if (sprintOptions.length) list.push({ id: 'q-sprint', name: 'Sprint', badge: query.sprints.length });
    // Also kept while a tag is selected but no loaded task carries it any
    // more, so the condition can still be switched off here.
    if (tagOptions.length || query.tagsAny.length) list.push({ id: 'q-tags', name: 'Tags', badge: query.tagsAny.length });
    list.push({
      id: 'q-flags', name: 'Pinned / Blocked',
      badge: (query.pinned !== undefined ? 1 : 0) + (query.blocked !== undefined ? 1 : 0),
    });
    list.push({ id: 'q-time', name: 'Time', badge: query.timePreset ? 1 : 0 });
    list.push({ id: 'q-sort', name: 'Order by' });
    return list;
  }, [query, showPriority, projectOptions, sourceOptions, sprintOptions, tagOptions]);

  const activeSection = sections.find((s) => s.id === section) ?? sections[0];

  // If the selected section disappears (e.g. the last sprint option goes away
  // on a background refresh), drop the stale id so state and render agree.
  useEffect(() => {
    if (section !== null && !sections.some((s) => s.id === section)) setSection(null);
  }, [section, sections]);

  // Portalled to document.body (fixed coords) so ancestor overflow can never
  // clip it: right-aligned to the trigger, clamped to the viewport on BOTH
  // edges, height capped to the space below.
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const margin = 8;
    const place = () => {
      const r = containerRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - margin * 2);
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
    // The host can move without a resize: the task panel slides open over 250ms when a
    // reveal brings it back, and the toolbar reflows as it widens. Follow the last frame.
    document.addEventListener('transitionend', onScrollOrResize, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
      document.removeEventListener('transitionend', onScrollOrResize, true);
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
  // panel (closing while results are up loses the user's place). Reads the DOM
  // value so the listener needs no dep on every keystroke.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Claimed, so the page's own Escape (deselect the task) does not run as well.
      e.preventDefault();
      if (searchRef.current?.value) { setSearch(''); return; }
      setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Reset transient state per open: no stale search, rail on the first section.
  // Focus is autoFocus on the search input (this effect can run before the
  // portal mounts, so a ref .focus() here would race the mount).
  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSection(null);
    setCursor(0);
  }, [open]);

  const patchQuery = (patch: Partial<TaskQueryFilterState>) => onQueryChange({ ...query, ...patch });

  const searchGroups = useMemo(() => {
    const groups = searchFilterOptions(query, { projectOptions, sourceOptions, sprintOptions, tagOptions }, search);
    // A hidden dimension has no rail section to land on.
    return showPriority ? groups : groups.filter((g) => g.options[0]?.section !== 'q-priority');
  }, [query, projectOptions, sourceOptions, sprintOptions, tagOptions, search, showPriority]);
  const searchFlat = useMemo(() => searchGroups.flatMap((g) => g.options), [searchGroups]);
  const searching = search.trim().length > 0;

  // Clamp the cursor on WRITE when the result list shrinks under it.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, searchFlat.length - 1)));
  }, [searchFlat.length]);

  // Re-picking the selected sort would fire a deep-equal change (surfaces run
  // side effects on every change), so the no-op is skipped at the source.
  const pickSearchOption = (opt: FilterSearchOption) => {
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

  const sentence = buildFilterSentence(query);

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
        // Portals escape clipping, NOT event bubbling: without stopPropagation
        // dnd-kit's sensors see these pointer downs and drag the row behind.
        <div
          className="vd-panel"
          ref={panelRef}
          onPointerDown={(e) => e.stopPropagation()}
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
        >
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
              <button className="vd-search-clear" onClick={() => setSearch('')} aria-label="Clear search">{ICON_CLOSE}</button>
            )}
          </div>

          <div className="vd-sentence" data-testid="vd-sentence">
            {sentence.map((tok, i) => tok.kind === 'word'
              ? <span key={i} className="vd-sw">{tok.text}</span>
              : (
                // Two data attributes, not one joined string: a value can itself
                // contain ':' (project names), which would make a combined selector ambiguous.
                <span key={i} className="vd-sc" data-chip-dim={tok.dim} data-chip-value={tok.value}>
                  <span className="vd-sc-label" title={tok.label}>{tok.label}</span>
                  <button className="vd-sc-x" aria-label={`Remove ${tok.label}`} onClick={() => onQueryChange(tok.removed)}>
                    {ICON_CLOSE}
                  </button>
                </span>
              ))}
          </div>

          <div className="vd-body">
            {/* Plain buttons, deliberately NOT role=tablist/tab: the ARIA tab
                pattern obliges arrow-key navigation + roving tabIndex, and a
                half-implemented contract is worse than buttons with aria-current. */}
            <div className="vd-rail" aria-label="Filter sections">
              {sections.map((s) => (
                <button
                  key={s.id}
                  aria-current={activeSection?.id === s.id && !searching}
                  className={`vd-rail-btn${activeSection?.id === s.id && !searching ? ' vd-active' : ''}`}
                  data-rail-section={s.id}
                  title={s.id === 'q-status' && statusSet.length ? `Status: ${statusChipLabel(statusSet)}` : undefined}
                  // Also clears any active search (the detail pane swaps from results back to the section).
                  onClick={() => { setSection(s.id); setSearch(''); }}
                >
                  <span className="vd-rail-name">{s.name}</span>
                  {s.badge !== undefined && (
                    // The badge box always renders (empty when 0) so rail labels
                    // don't shift when a count appears.
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
                  query={query} patchQuery={patchQuery} statusSet={statusSet}
                  onStatusChange={(set) => onQueryChange(withQueryStatus(query, set))}
                  projectOptions={projectOptions} sourceOptions={sourceOptions} sprintOptions={sprintOptions}
                  tagOptions={tagOptions}
                />
              )}
            </div>
          </div>

          {hasActiveFilter && (
            <div className="vd-footer">
              <button className="vd-clear" onClick={onClearAll}>Clear all</button>
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
  query: TaskQueryFilterState;
  patchQuery: (patch: Partial<TaskQueryFilterState>) => void;
  statusSet: TaskPhase[];
  onStatusChange: (set: TaskPhase[]) => void;
  projectOptions: string[]; sourceOptions: string[]; sprintOptions: string[]; tagOptions: string[];
}) {
  const { id, query, patchQuery } = props;
  // Query sections keep the .vd-query/.vd-field/data-filter-value markup the
  // browser specs (task-filters.spec.ts) drive them by.
  return (
    <div className="vd-query">
      {id === 'q-status' && (
        // Empty = no status condition (every task), the same hit set as before the merge.
        <ChipGroup label="Status" options={STATUS_VALUES} selected={props.statusSet}
          onToggle={(v) => props.onStatusChange(toggleQueryValue(props.statusSet, v))} />
      )}
      {id === 'q-priority' && (
        <ChipGroup label="Priority" options={QUERY_PRIORITY_OPTIONS} selected={query.priorities}
          onToggle={(v) => patchQuery({ priorities: toggleQueryValue(query.priorities, v) })} />
      )}
      {id === 'q-project' && (
        <ChipGroup label="Project"
          // '' is a real selectable value (the Inbox bucket): it needs a label.
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
      {id === 'q-tags' && <TagsSection query={query} patchQuery={patchQuery} tagOptions={props.tagOptions} />}
      {id === 'q-flags' && (
        <div className="vd-grid">
          <TriStateField label="Pinned" value={query.pinned} onChange={(v) => patchQuery({ pinned: v })} />
          <TriStateField label="Blocked" value={query.blocked} onChange={(v) => patchQuery({ blocked: v })} />
        </div>
      )}
      {id === 'q-time' && <TimeSection query={query} patchQuery={patchQuery} />}
      {id === 'q-sort' && (
        // Single-select: re-clicking the active sort is skipped (no-op change).
        <ChipGroup label="Order by" options={QUERY_SORT_OPTIONS} selected={[query.sort]}
          onToggle={(v) => { if (v !== query.sort) patchQuery({ sort: v }); }} />
      )}
    </div>
  );
}

/** Tag chips (any of them matches), capped; the long tail is reached through the panel search. */
function TagsSection({ query, patchQuery, tagOptions }: {
  query: TaskQueryFilterState;
  patchQuery: (patch: Partial<TaskQueryFilterState>) => void;
  tagOptions: string[];
}) {
  const { options, hidden } = tagChipOptions(query.tagsAny, tagOptions);
  return (
    <>
      <ChipGroup label="Tag" options={options.map((t) => ({ value: t, label: t }))}
        selected={query.tagsAny}
        onToggle={(v) => patchQuery({ tagsAny: toggleQueryValue(query.tagsAny, v) })} />
      {hidden > 0 && (
        <div className="vd-hint">Search above for the other {hidden} {hidden === 1 ? 'tag' : 'tags'}.</div>
      )}
    </>
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
    // Reuses .vd-cat + data-filter-value so the browser specs' selectors work in
    // search results too. NOTE the attribute carries the LABEL here (ChipGroup
    // carries the VALUE): search options only expose their display label.
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
                  // Keep the keyboard cursor visible even below the detail pane's fold.
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

/** Multi-toggle chip row. Selected chips get a leading check icon so state is
 *  readable even where accent-on-accent contrast is weak (bright light themes). */
function ChipGroup<T extends string>({ label, options, selected, onToggle }: {
  label: string;
  options: { value: T; label: string; icon?: ReactNode }[];
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
            {selected.includes(o.value) && <span className="vd-cat-check" aria-hidden>{ICON_CHECK}</span>}
            {o.icon && <span className="vd-cat-icon" aria-hidden>{o.icon}</span>}
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
          <button key={c.key} className={`vd-seg-btn${value === c.v ? ' vd-active' : ''}`}
            data-tri-state={c.key} onClick={() => onChange(c.v)}>{c.label}</button>
        ))}
      </div>
    </div>
  );
}

/** Log helper for surfaces adopting the query block: `info`, not `debug` (debug is
 *  suppressed at the default level, which hid what the user had filtered to exactly
 *  when they reported "my task vanished"). A filter change is low-frequency. */
export function logTaskQueryChange(surface: string, next: TaskQueryFilterState): void {
  log.info('tasks', 'task query filter changed', { surface, query: toTaskQuery(next) });
}
