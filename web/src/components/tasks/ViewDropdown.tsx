/**
 * ViewDropdown — unified [▾ View] panel replacing category tabs, filter rows, and sort controls.
 *
 * Wide (~360px) panel with 2-column category grid and compact filter/sort/group sections.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ICON_SLIDERS } from '../common/Icons';

// ── Types ──

export type SortBy = 'manual' | 'priority' | 'date' | 'updated';
export type GroupBy = 'category' | 'none';
export type DateFilter = '' | 'now' | 'overdue' | 'this-week' | 'no-date';

export interface ViewDropdownProps {
  categories: string[];
  activeCategory: string;
  onCategoryChange: (cat: string) => void;
  categoryCounts?: Record<string, number>;
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

const STARRED_TAB = '\u2605';

const PHASE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'TODO', label: 'To Do' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'AGENT_COMPLETE', label: 'Agent Done' },
  { value: 'AWAIT_HUMAN_ACTION', label: 'Awaiting You' },
  { value: 'HUMAN_VERIFIED', label: 'Verified' },
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
  categories, activeCategory, onCategoryChange, categoryCounts, hasStarredContent,
  phaseFilter, onPhaseFilterChange, priorityFilter, onPriorityFilterChange,
  tagFilter, onTagFilterChange, availableTags,
  dateFilter, onDateFilterChange,
  sortBy, onSortByChange, groupBy, onGroupByChange,
  showCompleted, onShowCompletedChange, onClearAll,
}: ViewDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const hasActiveFilter = !!(phaseFilter || priorityFilter || tagFilter || dateFilter || activeCategory || showCompleted);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
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

  // Build category chips: [★, All, ...categories]
  const catChips: { id: string; label: string; count?: number }[] = [];
  if (hasStarredContent) catChips.push({ id: STARRED_TAB, label: '\u2605' });
  catChips.push({ id: '', label: 'All' });
  for (const cat of categories) {
    catChips.push({ id: cat, label: cat, count: categoryCounts?.[cat] });
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

      {open && (
        <div className="vd-panel">
          {/* ── Filters: horizontal row of inline selects ── */}
          <div className="vd-filters">
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
          </div>

          {/* ── Sort + Group: two segmented controls side by side ── */}
          <div className="vd-controls">
            <div className="vd-control-group">
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
            <div className="vd-control-group">
              <span className="vd-label">Group</span>
              <div className="vd-seg">
                {([['category', 'Cat'], ['none', 'Flat']] as const).map(([val, lbl]) => (
                  <button key={val} className={`vd-seg-btn${groupBy === val ? ' vd-active' : ''}`} onClick={() => onGroupByChange(val)}>{lbl}</button>
                ))}
              </div>
            </div>
            <label className="vd-check">
              <input type="checkbox" checked={showCompleted} onChange={() => onShowCompletedChange(!showCompleted)} />
              Done
            </label>
          </div>

          <div className="vd-sep" />

          {/* ── Categories: 2-column chip grid (bottom) ── */}
          <div className="vd-cats">
            {catChips.map((c) => (
              <button
                key={c.id}
                className={`vd-cat${activeCategory === c.id ? ' vd-active' : ''}`}
                onClick={() => onCategoryChange(c.id)}
              >
                <span className="vd-cat-name">{c.label}</span>
                {c.count !== undefined && <span className="vd-cat-n">{c.count}</span>}
              </button>
            ))}
          </div>

          {/* ── Clear ── */}
          {hasActiveFilter && (
            <div className="vd-footer">
              <button className="vd-clear" onClick={onClearAll}>Clear all</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── InlineSelect: compact label + select on one line ──

function InlineSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="vd-inline-sel">
      <span className="vd-inline-label">{label}</span>
      <select className={`vd-sel${value ? ' vd-filtered' : ''}`} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
