import { memo, type ReactNode } from 'react';
import * as ICONS from '../common/Icons';

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

export type TodoSection = 'all' | 'focus' | 'satellite' | 'wait' | 'recent' | 'tasks' | 'notes';

export const TODO_SECTIONS: readonly TodoSection[] = ['all', 'focus', 'satellite', 'wait', 'recent', 'tasks', 'notes'];

const LABELS: Record<TodoSection, string> = {
  all: 'All',
  focus: 'Focus',
  satellite: 'Satellite',
  wait: 'Wait',
  recent: 'Recent',
  tasks: 'Tasks',
  notes: 'Notes',
};

const TITLES: Record<TodoSection, string> = {
  all: 'All sections stacked — the only view with cross-tier drag',
  focus: 'Focus — current sprint, finish these first',
  satellite: 'Satellite — backlog of other pinned tasks',
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
    case 'wait': return ICONS.ICON_TIER_WAIT;
    case 'recent': return ICONS.ICON_SECTION_RECENT;
    case 'tasks': return ICONS.ICON_SECTION_TASKS;
    case 'notes': return ICONS.ICON_SECTION_NOTES;
  }
}

interface TodoSectionTabsProps {
  active: TodoSection;
  onChange: (section: TodoSection) => void;
  /** Per-section badge counts. `notes`/`all` have none (undefined = no badge). */
  counts: Partial<Record<TodoSection, number>>;
}

export const TodoSectionTabs = memo(function TodoSectionTabs({ active, onChange, counts }: TodoSectionTabsProps) {
  return (
    <div className="todo-section-tabs" role="tablist" aria-label="Todo panel sections">
      {TODO_SECTIONS.map((section) => {
        const isActive = section === active;
        const count = counts[section];
        return (
          <button
            key={section}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`todo-section-tab${isActive ? ' is-active' : ''} todo-section-tab-${section}`}
            onClick={() => onChange(section)}
            title={TITLES[section]}
          >
            <span className="todo-section-tab-icon" aria-hidden="true">{icon(section)}</span>
            {/* The label is always in the DOM (screen readers, and it's what makes
                the active pill readable); CSS collapses it on inactive tabs. */}
            <span className="todo-section-tab-label">{LABELS[section]}</span>
            {count != null && count > 0 && (
              <span className="todo-section-tab-count">{count > 99 ? '99+' : count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
});
