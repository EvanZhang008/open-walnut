import { memo, useState, type MouseEvent, type ReactNode } from 'react';
import * as ICONS from '../common/Icons';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import type { CustomTierDef } from '@/api/focus';
import {
  TAB_BAR_HIDDEN_TABS_KEY, TAB_BAR_HIDE_EMPTY_KEY, TASK_SHORTCUTS_KEY,
  useNavigationList, useNavigationPreference,
} from '@/hooks/useNavigationPreference';
import { tabBarTabs, visibleTabBarTabs } from './tab-bar-model';

/**
 * The todo panel's tab bar: one tab per view, the picked view owns the panel below.
 *
 * `all` is a real tab because cross-tier drag (Recent to Focus, Focus to Wait) needs the
 * source and target regions mounted at the same time; a single tier's tab is for working
 * inside it. Width is the constraint (the panel is often ~420px), so a tier tab is its
 * icon + count and only the ACTIVE tab spells out its name; All is the word itself.
 * Which tabs show is the user's call, from the bar's own menu (see tab-bar-model.ts).
 */

/** A built-in section name, or a custom tier id (`ct_*`) acting as its own tab. */
export type TodoSection = string;

/** Every view the panel can be on. `tasks` (Projects) is picked from the filter menu, not a tab. */
export const TODO_SECTIONS: readonly TodoSection[] = ['all', 'focus', 'satellite', 'backlog', 'wait', 'recent', 'tasks'];

function icon(section: TodoSection): ReactNode {
  switch (section) {
    case 'focus': return ICONS.ICON_TIER_FOCUS;
    case 'satellite': return ICONS.ICON_TIER_SATELLITE;
    case 'backlog': return ICONS.ICON_TIER_BACKLOG;
    case 'wait': return ICONS.ICON_TIER_WAIT;
    case 'recent': return ICONS.ICON_SECTION_RECENT;
    default: return ICONS.ICON_TIER_CUSTOM;
  }
}

interface TodoSectionTabsProps {
  active: TodoSection;
  onChange: (section: TodoSection) => void;
  /** Per-section badge counts (undefined = no badge). */
  counts: Partial<Record<TodoSection, number>>;
  /** False while the tasks are still loading: every count reads 0 then, and no tab is empty yet. */
  countsReady?: boolean;
  /** User-defined tiers: each gets its own tab between Wait and Recent. */
  customTiers?: CustomTierDef[];
  /** Search mode only: completed-results toggle chip pinned to the strip's right
      edge. The strip is the one row that stays visible while search results own
      the panel, so the toggle lives here; a fold row at the list TAIL forced
      scrolling to the bottom to reach it (user ruling 2026-08-31). */
  searchDone?: { count: number; shown: boolean; onToggle: () => void };
}

export const TodoSectionTabs = memo(function TodoSectionTabs({ active, onChange, counts, countsReady = true, customTiers, searchDone }: TodoSectionTabsProps) {
  const [hidden, setHidden] = useNavigationList(TAB_BAR_HIDDEN_TABS_KEY);
  const [hideEmpty, setHideEmpty] = useNavigationPreference(TAB_BAR_HIDE_EMPTY_KEY, true);
  const [, setBarShown] = useNavigationPreference(TASK_SHORTCUTS_KEY);
  const [menu, setMenu] = useState<{ x: number; y: number; origin: HTMLElement } | null>(null);
  const tabs = tabBarTabs(customTiers);
  const shown = visibleTabBarTabs(tabs, { active, counts, hidden, hideEmpty: hideEmpty && countsReady });

  const openMenu = (event: MouseEvent<HTMLElement>, atCursor = false) => {
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: atCursor ? event.clientX : rect.right, y: atCursor ? event.clientY : rect.bottom, origin: event.currentTarget });
  };
  const hideBar = () => {
    // The menu's opener goes with the bar, so focus lands on the filter menu, where the bar comes back.
    const filter = menu?.origin.closest('.todo-panel')?.querySelector<HTMLElement>('.todo-panel-toolbar button[aria-label="View options"]');
    setBarShown(false);
    requestAnimationFrame(() => filter?.focus({ preventScroll: true }));
  };
  const items: ContextMenuItem[] = [
    { key: 'tabs', label: 'Tabs', section: true },
    ...tabs.map((tab) => ({
      key: `tab-${tab.id}`, label: tab.label, toggle: true, keepOpen: true, checked: !hidden.includes(tab.id),
      title: tab.id === active ? 'The tab you are on stays until you switch away' : undefined,
      onSelect: () => setHidden(hidden.includes(tab.id) ? hidden.filter((id) => id !== tab.id) : [...hidden, tab.id]),
    })),
    { divider: true },
    { key: 'hide-empty', label: 'Hide empty tabs', toggle: true, keepOpen: true, checked: hideEmpty, title: 'A tier with no tasks leaves the bar; custom tiers always stay', onSelect: () => setHideEmpty(!hideEmpty) },
    { divider: true },
    { key: 'tab-bar', label: 'Show tab bar', toggle: true, checked: true, onSelect: hideBar },
  ];

  return (
    <div className="todo-section-tabs" onContextMenu={(event) => openMenu(event, true)}>
      <div className="todo-section-tabs-list" role="tablist" aria-label="Todo panel sections">
        {shown.map(({ id, label, title }) => {
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
              {id !== 'all' && <span className="todo-section-tab-icon" aria-hidden="true">{icon(id)}</span>}
              {/* The label is always in the DOM (screen readers, and it's what makes
                  the active pill readable); CSS collapses it on inactive tier tabs. */}
              <span className="todo-section-tab-label">{label}</span>
              {count != null && count > 0 && (
                <span className="todo-section-tab-count">{count > 99 ? '99+' : count}</span>
              )}
            </button>
          );
        })}
      </div>
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
      <button
        type="button"
        className="todo-section-tabs-menu"
        aria-label="Tab bar options"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title="Choose the tabs on this bar"
        onClick={(event) => openMenu(event)}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" /></svg>
      </button>
      {menu && <ContextMenu point={menu} items={items} onClose={() => setMenu(null)} returnFocus={menu.origin} ariaLabel="Tab bar options" />}
    </div>
  );
});
