/**
 * Which tabs the task panel's tab bar draws.
 *
 * The bar holds the panel's views: All, Pinned (every tier, no project list), the built-in
 * tiers, the user's custom tiers, and Recent. Projects and the Scratchpad are not on it
 * (2026-09-23, "move the task and note out"): Projects is picked from the filter menu, the
 * Scratchpad opens from the rail. The user chooses which tabs stay (the bar's own menu);
 * until they do, the bar is All and Pinned alone (2026-10-01, "just show the pin, like a
 * quick access bar": the tiers are detail under Pinned, so they wait to be asked for). A
 * tab with nothing in it hides by default, the same rule the All view uses for an empty
 * built-in tier; Pinned and a custom tier always show, one because it is the bar's reason
 * to be there, the other so a tier made a moment ago can be found. The tab the panel is on
 * always shows, or the bar would not say where you are.
 */

export interface TabBarTab {
  id: string;
  label: string;
  title: string;
  custom: boolean;
}

/** The tabs a bar nobody has customised leaves off: the tiers and Recent. */
export const DEFAULT_HIDDEN_TABS: readonly string[] = ['focus', 'satellite', 'wait', 'recent'];

/** Up to this many tabs, every tab spells out its name; past it, only the active one does. */
export const ROOMY_TAB_LIMIT = 3;

const BUILT_IN: readonly Omit<TabBarTab, 'custom'>[] = [
  { id: 'all', label: 'All', title: 'All: every tier at once, the view for dragging a task between tiers' },
  { id: 'pinned', label: 'Pinned', title: 'Pinned: every pinned task by tier, without the project list' },
  { id: 'focus', label: 'Focus', title: 'Focus: the current sprint, finish these first' },
  { id: 'satellite', label: 'Satellite', title: 'Satellite: needs doing soon' },
  { id: 'wait', label: 'Parked', title: 'Parked: pinned, but set aside for now' },
  { id: 'recent', label: 'Recent', title: 'Recent: tasks touched lately' },
];

/** Every tab the bar can draw, custom tiers after the built-in ones and before Recent. */
export function tabBarTabs(customTiers: readonly { id: string; label: string }[] = []): TabBarTab[] {
  const tabs: TabBarTab[] = [];
  for (const tab of BUILT_IN) {
    if (tab.id === 'recent') {
      for (const tier of customTiers) tabs.push({ id: tier.id, label: tier.label, title: `${tier.label}: custom tier`, custom: true });
    }
    tabs.push({ ...tab, custom: false });
  }
  return tabs;
}

export interface TabBarChoice {
  active: string;
  counts: Partial<Record<string, number>>;
  /** Tasks a tab holds but hides by default (parked ones): a tab with only those is not empty. */
  held?: Partial<Record<string, number>>;
  hidden: readonly string[];
  hideEmpty: boolean;
}

/** The tabs drawn right now: the ones the user keeps, less the empty ones when that is on. */
export function visibleTabBarTabs(tabs: readonly TabBarTab[], { active, counts, held, hidden, hideEmpty }: TabBarChoice): TabBarTab[] {
  return tabs.filter((tab) => {
    if (tab.id === active) return true;
    if (hidden.includes(tab.id)) return false;
    // All has no count of its own; Pinned is the bar's one fixed stop; a custom tier
    // stays findable while empty.
    if (!hideEmpty || tab.id === 'all' || tab.id === 'pinned' || tab.custom) return true;
    // A tier whose tasks are all parked still has work in it: the tab stays, so the
    // footer's "N waiting hidden" under it can be reached (2026-10-01).
    return (counts[tab.id] ?? 0) > 0 || (held?.[tab.id] ?? 0) > 0;
  });
}
