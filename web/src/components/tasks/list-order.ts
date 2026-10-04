/**
 * list-order: the Sort and Group of every list the home task panel draws, so the
 * Display menu's two rows work in every view. Each pinned tier, the Recent feed
 * and the Projects list keep their own choice; a view's rows read and set the
 * view's own lists (All and Projects: the Projects list, Pinned: every tier, a
 * tier view: its tier, Recent: its feed). Pure, no React. Relative runtime imports on purpose.
 */
import type { GroupBy, SortBy } from './ViewDropdown';

export const SORT_VALUES: readonly SortBy[] = ['manual', 'priority', 'date', 'updated'];
/** Recent is a time feed: it has no hand order to keep. */
export const RECENT_SORT_VALUES: readonly SortBy[] = ['priority', 'date', 'updated'];

/** The lists a view draws, the ones its Sort and Group rows act on. */
export interface OrderLists {
  tiers: string[];
  projects: boolean;
  recent: boolean;
}

/**
 * `section` is the effective view; `tiers` the tier ids Pinned draws. All acts on
 * its Projects list like Projects does: its tiers keep their own order (each tier's
 * heading menu sets it), so the board's default (Manual tiers over a Projects list
 * by Updated) never reads as two lists that disagree.
 */
export function orderLists(section: string, tiers: readonly string[]): OrderLists {
  if (section === 'tasks' || section === 'all') return { tiers: [], projects: true, recent: false };
  if (section === 'pinned') return { tiers: [...tiers], projects: false, recent: false };
  if (section === 'recent') return { tiers: [], projects: false, recent: true };
  return { tiers: [section], projects: false, recent: false };
}

/** The one value every list holds, or null when they differ (no segment reads as pressed). */
export function commonValue<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  return values.every((v) => v === values[0]) ? values[0] : null;
}

/** A tier's group: "By project" clusters its cards into project runs, Flat keeps one list. */
export type TierViewMode = 'project' | 'custom';
export function groupOfTierMode(mode: TierViewMode): GroupBy {
  return mode === 'custom' ? 'none' : 'project';
}
export function tierModeOfGroup(group: GroupBy): TierViewMode {
  return group === 'none' ? 'custom' : 'project';
}

/** Stored per-tier sorts; anything that is not a sort reads as Manual (absent). */
export function parseTierSorts(raw: string | null): Record<string, SortBy> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, SortBy> = {};
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v !== 'manual' && SORT_VALUES.includes(v as SortBy)) out[k] = v as SortBy;
    }
    return out;
  } catch {
    return {};
  }
}

/** Recent's stored order: the time it ranks by, or Priority. */
export type RecentOrder = 'updated' | 'created' | 'priority';
export function recentOrderOfSort(sort: SortBy): RecentOrder {
  return sort === 'date' ? 'created' : sort === 'priority' ? 'priority' : 'updated';
}
export function sortOfRecentOrder(order: RecentOrder): SortBy {
  return order === 'created' ? 'date' : order;
}

/**
 * A drop writes every tier's drawn order as the pin order. A tier drawn by a
 * sort must not lose its hand order to that: each `keep` set's ids go back to
 * their pin order, in the slots the drop gave them, and every other id stays.
 */
export function keepPinOrder(order: readonly string[], keep: readonly ReadonlySet<string>[], pinIndex: ReadonlyMap<string, number>): string[] {
  const out = [...order];
  for (const set of keep) {
    const slots: number[] = [];
    out.forEach((id, i) => { if (set.has(id)) slots.push(i); });
    const ids = slots.map((i) => out[i]);
    const rank = (id: string) => pinIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
    const sorted = ids.map((id, i) => ({ id, i })).sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i).map((x) => x.id);
    slots.forEach((slot, i) => { out[slot] = sorted[i]; });
  }
  return out;
}

/** Recent grouped by project: each project's rows together, the projects in the order their first row came. */
export function groupByProject<T extends { project?: string | null }>(rows: readonly T[]): T[] {
  const runs = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.project || '';
    const run = runs.get(key);
    if (run) run.push(row); else runs.set(key, [row]);
  }
  return [...runs.values()].flat();
}
