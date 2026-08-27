/**
 * Group "chip sentinels" for the pinned tiers.
 *
 * A virtual group renders a header chip above its member cards. That chip is a real
 * dnd-kit sortable unit whose id (`group:<gid>:<tier>`) sits in the tier's
 * SortableContext items, immediately before the member run it heads.
 *
 * Why it has to be in `items` (2026-08-22 fix): dnd-kit only displaces the ids it
 * knows about, and it only keeps measured rects for enabled droppables. With the chip
 * outside items it stayed frozen at its original y while its own cards slid away (the
 * header visibly detached from its cluster), and a dragged group's sentinel had no
 * rect at all, so the strategy mis-sized the slot it was supposed to open — dragging
 * a whole group produced no visible feedback about where it would land.
 *
 * These helpers are pure so they can be tested without mounting the panel:
 * tests/web/tier-group-sentinels.test.ts.
 */
import type { Task } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import { isSeparatorId } from './tier-separators';

export const GROUP_SENTINEL_PREFIX = 'group:';

/** Sortable id for a group's chip in a tier — the tier is encoded so a group split
 *  across tiers renders distinct chips without an id collision. */
export function groupSortableId(groupId: string, tier: FocusTier): string {
  return `${GROUP_SENTINEL_PREFIX}${groupId}:${tier}`;
}

export function isGroupSentinel(id: string): boolean {
  return id.startsWith(GROUP_SENTINEL_PREFIX);
}

/** Group id out of `group:<gid>:<tier>`. Neither group ids (`g_…`) nor tier keys
 *  (`focus`/`ct_…`) contain colons, so slicing between the first and last colon is
 *  exact — works for custom tier suffixes too. */
export function parseGroupSentinelGid(sentinel: string): string {
  const body = sentinel.slice(GROUP_SENTINEL_PREFIX.length);
  const lastColon = body.lastIndexOf(':');
  return lastColon === -1 ? body : body.slice(0, lastColon);
}

/** Strip every sentinel (group chips AND separator lines) — every id that leaves the
 *  panel as PIN ORDER must be a real task id (the server assigns pin_order by
 *  position, so a sentinel would eat a slot). */
export function taskIdsOnly(ids: string[]): string[] {
  return ids.filter((id) => !isGroupSentinel(id) && !isSeparatorId(id));
}

/**
 * Insert each group's sentinel immediately before that group's member run.
 *
 * Must run LAST in the tier's clustering chain, after project clustering:
 * clusterTierByProject keys its blocks off their tasks, and a sentinel (which has no
 * Task) would otherwise inherit the PREVIOUS block's project and be sorted away from
 * its own group. Idempotent — a sentinel already present marks its group as covered.
 */
export function withGroupSentinels(ids: string[], tasks: Task[], tier: FocusTier): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: string[] = [];
  let prevGid: string | undefined;
  for (const id of ids) {
    if (isGroupSentinel(id)) {
      out.push(id);
      prevGid = parseGroupSentinelGid(id);
      continue;
    }
    const gid = byId.get(id)?.group_id;
    if (gid && gid !== prevGid) out.push(groupSortableId(gid, tier));
    out.push(id);
    prevGid = gid;
  }
  return out;
}

/**
 * Drop sentinels that no longer head a member run, so items and DOM stay in step.
 *
 * A sentinel is inserted per group with pinned members, but the tier's VISIBLE ids are
 * then filtered (search, a project scope, the members' own visibility). Filter every
 * member out and its sentinel would be left over: an items entry with no element,
 * hence no rect, plus a group header floating above nothing. The one exception is the
 * sentinel currently being DRAGGED — its members are deliberately collapsed away and
 * the chip stands in for the whole cluster.
 *
 * Separator sentinels get the same treatment when the filter removed EVERY card:
 * renderTierItems draws no line in a card-less tier (nothing to divide), so keeping
 * the `sep_*` ids would leave items entries with no element and no rect.
 */
export function pruneOrphanSentinels(
  ids: string[],
  taskById: Map<string, Task>,
  activeDragId: string | null,
): string[] {
  // Fast path keeps array identity stable for the common sentinel-free tier
  // (SortableContext re-registers on a new `items` identity — React #185 history).
  if (!ids.some((id) => isGroupSentinel(id) || isSeparatorId(id))) return ids;
  const anyTask = ids.some((id) => taskById.has(id));
  return ids.filter((id, i) => {
    if (isSeparatorId(id)) return anyTask;
    if (!isGroupSentinel(id)) return true;
    if (id === activeDragId) return true;
    // The line ids ride the array between a chip and its member — skip them when
    // checking that the chip still heads its run.
    let next = ids[i + 1];
    for (let j = i + 1; next !== undefined && isSeparatorId(next); j++) next = ids[j + 1];
    return next !== undefined && !isGroupSentinel(next)
      && taskById.get(next)?.group_id === parseGroupSentinelGid(id);
  });
}
