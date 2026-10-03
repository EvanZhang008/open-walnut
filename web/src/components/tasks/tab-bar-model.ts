/**
 * Which tabs the task panel's tab bar draws.
 *
 * The bar holds the panel's views: All, Pinned (every tier, no project list), the built-in
 * tiers, the user's custom tiers, and Recent. Projects and the Scratchpad are not on it
 * (2026-09-23, "move the task and note out"): Projects is picked from the Display menu, the
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
  { id: 'all', label: 'All', title: 'All: every open task on your board' },
  { id: 'pinned', label: 'Pinned', title: 'Pinned: tasks you pinned to keep in front of you' },
  { id: 'focus', label: 'Focus', title: 'Focus: the current sprint, finish these first' },
  { id: 'satellite', label: 'Satellite', title: 'Satellite: needs doing soon' },
  { id: 'wait', label: 'Parked', title: 'Parked: pinned, but set aside for now' },
  { id: 'recent', label: 'Recent', title: 'Recent: tasks touched lately' },
];

/**
 * Projects: a view the panel can be on that the bar never draws (it is picked from the
 * Display menu). Listed here so every surface reads its title from this one table.
 */
export const PROJECTS_VIEW: Omit<TabBarTab, 'custom'> = {
  id: 'tasks', label: 'Projects', title: 'Projects: every task grouped by project, with filters applied',
};

function customTitle(label: string): string {
  return `${label}: a list of pins you made`;
}

/** Every tab the bar can draw, custom tiers after the built-in ones and before Recent. */
export function tabBarTabs(customTiers: readonly { id: string; label: string }[] = []): TabBarTab[] {
  const tabs: TabBarTab[] = [];
  for (const tab of BUILT_IN) {
    if (tab.id === 'recent') {
      for (const tier of customTiers) tabs.push({ id: tier.id, label: tier.label, title: customTitle(tier.label), custom: true });
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

/** Every view the panel can be on, in menu order: the bar's tabs, then Projects. */
export function allViews(customTiers: readonly { id: string; label: string }[] = []): TabBarTab[] {
  return [...tabBarTabs(customTiers), { ...PROJECTS_VIEW, custom: false }];
}

/** One source for a view's hover sentence (Display menu rows, flyout rows, tabs). */
export function viewTitle(id: string, customTiers: readonly { id: string; label: string }[] = []): string {
  return allViews(customTiers).find((v) => v.id === id)?.title ?? '';
}

/** A view's display name ('' when the id is unknown). */
export function viewLabel(id: string, customTiers: readonly { id: string; label: string }[] = []): string {
  return allViews(customTiers).find((v) => v.id === id)?.label ?? '';
}

/**
 * At most this many views sit in the Display menu's first layer. A board with 30 custom
 * tiers keeps all 30 on its bar; inline they would make the menu unbounded (web/src
 * AGENTS.md menu rule 2), so the tail goes to the menu's View page instead.
 */
export const DISPLAY_FIRST_LAYER_LIMIT = 6;

/**
 * The Display menu's two layers: first = the tabs the user keeps on the bar (same list,
 * same order, whether or not the bar is drawn, capped at DISPLAY_FIRST_LAYER_LIMIT),
 * more = every other view in menu order, Projects last.
 */
export function displayViewLayers(
  customTiers: readonly { id: string; label: string }[],
  hidden: readonly string[],
): { first: TabBarTab[]; more: TabBarTab[] } {
  const first: TabBarTab[] = [];
  const more: TabBarTab[] = [];
  for (const view of allViews(customTiers)) {
    const kept = view.id !== PROJECTS_VIEW.id && !hidden.includes(view.id);
    if (kept && first.length < DISPLAY_FIRST_LAYER_LIMIT) first.push(view);
    else more.push(view);
  }
  return { first, more };
}

/** Ids the bar's own menu lists above its divider; every tier goes under the divider. */
export const TAB_MENU_TOP_IDS: readonly string[] = ['all', 'pinned', 'recent'];

/** The bar's own menu: All, Pinned, Recent on top; the built-in and custom tiers below. */
export function tabMenuGroups(tabs: readonly TabBarTab[]): { top: TabBarTab[]; tiers: TabBarTab[] } {
  return {
    top: TAB_MENU_TOP_IDS.flatMap((id) => tabs.filter((t) => t.id === id)),
    tiers: tabs.filter((t) => !TAB_MENU_TOP_IDS.includes(t.id)),
  };
}
