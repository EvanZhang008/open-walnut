import { memo, type ReactNode } from 'react';
import * as ICONS from '../common/Icons';
import type { CustomTierDef } from '@/api/focus';

/**
 * The todo panel's section tab strip.
 *
 * Before this, the panel was ONE vertical stack of 7 regions (Focus, Satellite,
 * Wait, hidden-groups, Recent, Tasks, Notes), each getting a few rows of the
 * available height — with many tasks every region was cramped to the point of
 * uselessness. Now each section owns the whole panel and you pick one here.
 *
 * `all` is kept as a real tab (not dropped) because cross-tier drag —
 * Recent → Focus, Focus → Wait — needs the source and target regions mounted at
 * the same time. Single-section tabs are for reading/working inside one tier;
 * `all` is where you re-triage across tiers.
 *
 * Width is the constraint: the panel is often ~420-460px, so tabs render as
 * icon + count and only the ACTIVE tab expands to show its label.
 */

/** A built-in section name, or a custom tier id (`ct_*`) acting as its own tab. */
export type TodoSection = string;

export const TODO_SECTIONS: readonly TodoSection[] = ['all', 'focus', 'satellite', 'backlog', 'wait', 'recent', 'tasks', 'notes'];

const LABELS: Record<string, string> = {
  all: 'All',
  focus: 'Focus',
  satellite: 'Satellite',
  backlog: 'Backlog',
  wait: 'Wait',
  recent: 'Recent',
  tasks: 'Tasks',
  notes: 'Notes',
};

const TITLES: Record<string, string> = {
  all: 'All sections stacked — the only view with cross-tier drag',
  focus: 'Focus — current sprint, finish these first',
  satellite: 'Satellite — needs doing soon, the default pinned tier',
  backlog: 'Backlog — someday work you still want pinned',
  wait: 'Wait — parked tasks, pinned but not actively worked on',
  recent: 'Recent — recently touched tasks',
  tasks: 'Tasks — the full filterable list',
  notes: 'Notes — global scratchpad',
};

function icon(section: TodoSection): ReactNode {
  switch (section) {
    case 'all': return ICONS.ICON_SECTION_ALL;
    case 'focus': return ICONS.ICON_TIER_FOCUS;
    case 'satellite': return ICONS.ICON_TIER_SATELLITE;
    case 'backlog': return ICONS.ICON_TIER_BACKLOG;
    case 'wait': return ICONS.ICON_TIER_WAIT;
    case 'recent': return ICONS.ICON_SECTION_RECENT;
    case 'tasks': return ICONS.ICON_SECTION_TASKS;
    case 'notes': return ICONS.ICON_SECTION_NOTES;
    default: return ICONS.ICON_TIER_CUSTOM;
  }
}

interface TodoSectionTabsProps {
  active: TodoSection;
  onChange: (section: TodoSection) => void;
  /** Per-section badge counts. `notes`/`all` have none (undefined = no badge). */
  counts: Partial<Record<TodoSection, number>>;
  /** User-defined tiers — each gets its own tab between Wait and Recent. */
  customTiers?: CustomTierDef[];
  /** Search mode only: completed-results toggle chip pinned to the strip's right
      edge. The strip is the one row that stays visible while search results own
      the panel, so the toggle lives here — a fold row at the list TAIL forced
      scrolling to the bottom to reach it (user ruling 2026-08-31). */
  searchDone?: { count: number; shown: boolean; onToggle: () => void };
}

export const TodoSectionTabs = memo(function TodoSectionTabs({ active, onChange, counts, customTiers, searchDone }: TodoSectionTabsProps) {
  // Custom tier tabs slot in right after the built-in tiers so the strip reads
  // tiers-then-feeds: All | Focus | Satellite | Backlog | Wait | <customs> | Recent | Tasks | Notes.
  const sections: { id: TodoSection; label: string; title: string }[] = [];
  for (const s of TODO_SECTIONS) {
    if (s === 'recent' && customTiers) {
      for (const t of customTiers) {
        sections.push({ id: t.id, label: t.label, title: `${t.label} — custom tier` });
      }
    }
    sections.push({ id: s, label: LABELS[s], title: TITLES[s] });
  }
  return (
    <div className="todo-section-tabs" role="tablist" aria-label="Todo panel sections">
      {sections.map(({ id, label, title }) => {
        const isActive = id === active;
        const count = counts[id];
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`todo-section-tab${isActive ? ' is-active' : ''} todo-section-tab-${id.startsWith('ct_') ? 'custom' : id}`}
            onClick={() => onChange(id)}
            title={title}
          >
            <span className="todo-section-tab-icon" aria-hidden="true">{icon(id)}</span>
            {/* The label is always in the DOM (screen readers, and it's what makes
                the active pill readable); CSS collapses it on inactive tabs. */}
            <span className="todo-section-tab-label">{label}</span>
            {count != null && count > 0 && (
              <span className="todo-section-tab-count">{count > 99 ? '99+' : count}</span>
            )}
          </button>
        );
      })}
      {searchDone && (
        <button
          type="button"
          className={`todo-section-tab todo-search-done-chip${searchDone.shown ? ' is-active' : ''}`}
          aria-pressed={searchDone.shown}
          onClick={searchDone.onToggle}
          title={searchDone.shown
            ? 'Hide completed results'
            : 'Include completed results, ranked by relevance'}
        >
          <span className="todo-section-tab-icon" aria-hidden="true">✓</span>
          <span className="todo-search-done-chip-label">Done</span>
          <span className="todo-section-tab-count">{searchDone.count > 99 ? '99+' : searchDone.count}</span>
        </button>
      )}
    </div>
  );
});
