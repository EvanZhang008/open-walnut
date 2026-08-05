/**
 * ViewDropdown — unified [▾ View] panel replacing project tabs, filter rows, and sort controls.
 *
 * Wide (~360px) panel with a 2-column project chip grid and compact filter/sort/group sections.
 */

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { ICON_SLIDERS } from '../common/Icons';
import { STARRED_TAB, INBOX_TAB } from './task-tabs';

// ── Types ──

export type SortBy = 'manual' | 'priority' | 'date' | 'updated';
export type GroupBy = 'project' | 'none';
export type DateFilter = '' | 'now' | 'overdue' | 'this-week' | 'no-date';

export interface ViewDropdownProps {
  /** Project chips. '' = the All chip; INBOX_TAB = tasks with no project. */
  projects: string[];
  activeProject: string;
  onProjectChange: (project: string) => void;
  projectCounts?: Record<string, number>;
  hasStarredContent?: boolean;

  phaseFilter: string;
  onPhaseFilterChange: (v: string) => void;
  priorityFilter: string;
  onPriorityFilterChange: (v: string) => void;
  tagFilter: string;
  onTagFilterChange: (v: string) => void;
  availableTags?: string[];

  dateFilter: DateFilter;
  onDateFilterChange: (v: DateFilter) => void;

  sortBy: SortBy;
  onSortByChange: (v: SortBy) => void;
  groupBy: GroupBy;
  onGroupByChange: (v: GroupBy) => void;

  showCompleted: boolean;
  onShowCompletedChange: (v: boolean) => void;
  onClearAll: () => void;
}

// Tab sentinels live in ./task-tabs so ViewDropdown, TodoPanel, MainPage and
// useUrlSync share ONE definition. Re-exported here for existing importers.
export { INBOX_TAB } from './task-tabs';

// Keep in sync with .vd-panel width in globals.css.
const PANEL_WIDTH = 340;

// Simplified to the two user-facing states (To Do / Complete); intermediate
// agent-lifecycle phases still exist in the data model but are hidden from UI.
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

export function ViewDropdown({
  projects, activeProject, onProjectChange, projectCounts, hasStarredContent,
  phaseFilter, onPhaseFilterChange, priorityFilter, onPriorityFilterChange,
  tagFilter, onTagFilterChange, availableTags,
  dateFilter, onDateFilterChange,
  sortBy, onSortByChange, groupBy, onGroupByChange,
  showCompleted, onShowCompletedChange, onClearAll,
}: ViewDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const hasActiveFilter = !!(phaseFilter || priorityFilter || tagFilter || dateFilter || activeProject || showCompleted);

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
  if (hasStarredContent) catChips.push({ id: STARRED_TAB, label: '\u2605' });
  catChips.push({ id: '', label: 'All' });
  for (const project of projects) {
    catChips.push({ id: project, label: project === INBOX_TAB ? 'Inbox' : project, count: projectCounts?.[project] });
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
        <div
          className="vd-panel"
          ref={panelRef}
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
        >
          {/* ── Filters + Sort + Group: unified 2-col grid, label above control ── */}
          <div className="vd-grid">
            <InlineSelect label="Phase" value={phaseFilter} options={PHASE_OPTIONS} onChange={onPhaseFilterChange} />
            <InlineSelect label="Priority" value={priorityFilter} options={PRIORITY_OPTIONS} onChange={onPriorityFilterChange} />
            <InlineSelect label="Date" value={dateFilter} options={DATE_FILTER_OPTIONS} onChange={(v) => onDateFilterChange(v as DateFilter)} />
            {availableTags && availableTags.length > 0 && (
              <InlineSelect
                label="Tag"
                value={tagFilter}
                options={[{ value: '', label: 'All' }, ...availableTags.slice(0, 20).map(t => ({ value: t, label: t.length > 16 ? t.slice(0, 16) + '\u2026' : t }))]}
                onChange={onTagFilterChange}
              />
            )}
            <div className="vd-field">
              <span className="vd-label">Sort</span>
              <div className="vd-seg">
                {([['manual', 'M'], ['priority', 'P\u2193'], ['date', 'C\u2193'], ['updated', 'U\u2193']] as const).map(([val, lbl]) => (
                  <button
                    key={val}
                    className={`vd-seg-btn${sortBy === val ? ' vd-active' : ''}`}
                    onClick={() => onSortByChange(val)}
                    title={val === 'manual' ? 'Manual order (drag / move buttons)' : undefined}
                  >{lbl}</button>
                ))}
              </div>
            </div>
            <div className="vd-field">
              <span className="vd-label">Group</span>
              <div className="vd-seg">
                {([['project', 'Proj'], ['none', 'Flat']] as const).map(([val, lbl]) => (
                  <button key={val} className={`vd-seg-btn${groupBy === val ? ' vd-active' : ''}`} onClick={() => onGroupByChange(val)}>{lbl}</button>
                ))}
              </div>
            </div>
          </div>

          <div className="vd-sep" />

          {/* ── Projects: 2-column chip grid (bottom) ── */}
          <div className="vd-cats">
            {catChips.map((c) => (
              <button
                key={c.id}
                className={`vd-cat${activeProject === c.id ? ' vd-active' : ''}`}
                onClick={() => onProjectChange(c.id)}
              >
                <span className="vd-cat-name">{c.label}</span>
                {c.count !== undefined && <span className="vd-cat-n">{c.count}</span>}
              </button>
            ))}
          </div>

          {/* ── Footer: show-completed toggle + clear ── */}
          <div className="vd-footer">
            <label className="vd-check">
              <input type="checkbox" checked={showCompleted} onChange={() => onShowCompletedChange(!showCompleted)} />
              Show completed
            </label>
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

// ── InlineSelect: grid field — small label above a full-width select ──

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
