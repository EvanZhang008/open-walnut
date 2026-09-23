/**
 * Which tabs the task panel's tab bar draws.
 *
 * The bar holds the panel's views: All, the built-in tiers, the user's custom tiers, and
 * Recent. Projects and the Scratchpad are not on it (2026-09-23, "move the task and note
 * out"): Projects is picked from the filter menu, the Scratchpad opens from the rail.
 * The user chooses which tabs stay (the bar's own menu), and a tab with nothing in it
 * hides by default, the same rule the All view uses for an empty built-in tier: a custom
 * tier always shows, so a tier made a moment ago can be found. The tab the panel is on
 * always shows, or the bar would not say where you are.
 */

export interface TabBarTab {
  id: string;
  label: string;
  title: string;
  custom: boolean;
}

const BUILT_IN: readonly Omit<TabBarTab, 'custom'>[] = [
  { id: 'all', label: 'All', title: 'All: every tier at once, the view for dragging a task between tiers' },
  { id: 'focus', label: 'Focus', title: 'Focus: the current sprint, finish these first' },
  { id: 'satellite', label: 'Satellite', title: 'Satellite: needs doing soon' },
  { id: 'backlog', label: 'Backlog', title: 'Backlog: someday work you still want pinned' },
  { id: 'wait', label: 'Wait', title: 'Wait: pinned, but not being worked on' },
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
  hidden: readonly string[];
  hideEmpty: boolean;
}

/** The tabs drawn right now: the ones the user keeps, less the empty ones when that is on. */
export function visibleTabBarTabs(tabs: readonly TabBarTab[], { active, counts, hidden, hideEmpty }: TabBarChoice): TabBarTab[] {
  return tabs.filter((tab) => {
    if (tab.id === active) return true;
    if (hidden.includes(tab.id)) return false;
    // All has no count of its own; a custom tier stays findable while empty.
    if (!hideEmpty || tab.id === 'all' || tab.custom) return true;
    return (counts[tab.id] ?? 0) > 0;
  });
}
