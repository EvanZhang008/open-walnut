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
import { folderAncestors } from './folder-tree';

export const GROUP_SENTINEL_PREFIX = 'group:';

/**
 * The "into this folder" drop target a folder chip carries next to its sortable id
 * (`into:<gid>:<tier>`). It is deliberately NOT in the tier's SortableContext items:
 * while it is the collision target, dnd-kit opens no slot and the list stays at rest,
 * so the one row that lights up is the one the drop goes into. The chip's sortable id
 * keeps meaning "land above this folder" (a slot opens there).
 */
export const INTO_FOLDER_PREFIX = 'into:';

export function intoFolderId(groupId: string, tier: FocusTier): string {
  return `${INTO_FOLDER_PREFIX}${groupId}:${tier}`;
}

export function isIntoFolderId(id: string): boolean {
  return id.startsWith(INTO_FOLDER_PREFIX);
}

/** `{ groupId, tier }` out of `into:<gid>:<tier>` (same colon rule as the sentinel). */
export function parseIntoFolderId(id: string): { groupId: string; tier: FocusTier } {
  const body = id.slice(INTO_FOLDER_PREFIX.length);
  const lastColon = body.lastIndexOf(':');
  return lastColon === -1
    ? { groupId: body, tier: '' as FocusTier }
    : { groupId: body.slice(0, lastColon), tier: body.slice(lastColon + 1) as FocusTier };
}

/**
 * The "into this card's folder" target a pinned card carries (`join:<taskId>:<tier>`):
 * the middle of a card means "put the dragged card with this one" (into its folder,
 * or a new folder of the two). Like `into:`, it is not a sortable item, so while it is
 * the target the list stays at rest and the card alone lights up.
 */
export const JOIN_CARD_PREFIX = 'join:';

export function joinCardId(taskId: string, tier: FocusTier): string {
  return `${JOIN_CARD_PREFIX}${taskId}:${tier}`;
}

export function isJoinCardId(id: string): boolean {
  return id.startsWith(JOIN_CARD_PREFIX);
}

/** `{ taskId, tier }` out of `join:<taskId>:<tier>` (task ids and tier keys have no colon). */
export function parseJoinCardId(id: string): { taskId: string; tier: FocusTier } {
  const body = id.slice(JOIN_CARD_PREFIX.length);
  const lastColon = body.lastIndexOf(':');
  return lastColon === -1
    ? { taskId: body, tier: '' as FocusTier }
    : { taskId: body.slice(0, lastColon), tier: body.slice(lastColon + 1) as FocusTier };
}

/** Is `folder` the folder `groupId` names, or one of its ancestors? */
export function folderWithin(groupId: string | undefined, folder: string, parentOf?: Map<string, string>): boolean {
  const seen = new Set<string>();
  for (let cur = groupId; cur !== undefined && !seen.has(cur); cur = parentOf?.get(cur)) {
    if (cur === folder) return true;
    seen.add(cur);
  }
  return false;
}

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

/**
 * A project label row of a "By project" tier (`tierproj:<tier>:<project>`). It rides
 * the tier's sortable items like a chip does, for the same reason: dnd-kit only
 * displaces what it knows about. A label left out stayed put while the rows around it
 * slid, so a dragged card's slot (and the cards making room for it) were drawn under
 * the wrong project mid-drag. In `items` the label moves with its run, and where the
 * slot opens relative to a label is where the drop lands. Never a drag source.
 */
export const TIER_LABEL_PREFIX = 'tierproj:';

export function tierLabelId(tier: FocusTier, project: string): string {
  return `${TIER_LABEL_PREFIX}${tier}:${project}`;
}

export function isTierLabelId(id: string): boolean {
  return id.startsWith(TIER_LABEL_PREFIX);
}

/** The project out of `tierproj:<tier>:<project>`: tier keys have no colon, a project
 *  name may, so the split is at the FIRST colon. */
export function tierLabelProject(id: string): string {
  const body = id.slice(TIER_LABEL_PREFIX.length);
  const colon = body.indexOf(':');
  return colon === -1 ? '' : body.slice(colon + 1);
}

/**
 * Insert a label sentinel before the first row of each project run. A chip has no
 * project of its own here, so it takes the project of the next card after it (the
 * card it heads); a chip with no card after it keeps the run it is in. Idempotent.
 */
export function withProjectLabels(ids: string[], tier: FocusTier, projectOfTask: (id: string) => string | undefined): string[] {
  const out: string[] = [];
  let current: string | undefined;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (isTierLabelId(id)) { current = tierLabelProject(id); out.push(id); continue; }
    let proj = projectOfTask(id);
    if (proj === undefined && isGroupSentinel(id)) {
      for (let k = i + 1; k < ids.length && proj === undefined; k++) {
        if (isTierLabelId(ids[k])) break;
        proj = projectOfTask(ids[k]);
      }
    }
    if (proj !== undefined && proj !== current) {
      out.push(tierLabelId(tier, proj));
      current = proj;
    }
    out.push(id);
  }
  return out;
}

/**
 * The project each row of a tier is drawn under, for withProjectLabels: a loose card's
 * own, and for every row of a folder (its subfolders' included) the project of the
 * folder's first card in `ids`, the one the project clustering keyed the folder by. A
 * card of another project filed inside a folder must not open a label there, which
 * would also draw that project's label a second time (two rows with one id).
 */
export function runProjectOf(
  ids: string[],
  rowOf: (id: string) => { project?: string | null; group_id?: string | null } | undefined,
  parentOf: Map<string, string>,
): (id: string) => string | undefined {
  const rootOf = (gid: string) => folderAncestors(gid, parentOf)[0] ?? gid;
  const runOfFolder = new Map<string, string>();
  for (const id of ids) {
    const row = rowOf(id);
    if (row?.group_id && !runOfFolder.has(rootOf(row.group_id))) runOfFolder.set(rootOf(row.group_id), row.project || '');
  }
  return (id) => {
    const row = rowOf(id);
    if (!row) return undefined;
    return (row.group_id ? runOfFolder.get(rootOf(row.group_id)) : undefined) ?? (row.project || '');
  };
}

/**
 * Drop the labels a tier must not draw: all of them when fewer than two projects
 * have a visible card here (one label separates nothing), else the ones whose project
 * has none. `visibleProjects` is the at-rest answer, so a label never comes and goes
 * under a live drag. Same array back when nothing changes.
 */
export function pruneTierLabels(ids: string[], visibleProjects: Set<string> | undefined): string[] {
  if (!ids.some(isTierLabelId)) return ids;
  const keep = visibleProjects && visibleProjects.size >= 2 ? visibleProjects : null;
  const out = ids.filter((id) => !isTierLabelId(id) || (keep !== null && keep.has(tierLabelProject(id))));
  return out.length === ids.length ? ids : out;
}

/** What `slotFits` needs to know about a tier. */
export interface SlotRules {
  /** A card's folder (as it was when the drag started); undefined = a loose card. */
  folderOf: (cardId: string) => string | undefined;
  parentOf?: Map<string, string>;
  /** 'project' ("By project"): a run's loose cards come before its folders. */
  mode: 'project' | 'custom';
}

/**
 * Is `arr[index]` (the dragged row, a card or a folder chip standing in for its whole
 * subtree) in a place the tier's own ordering keeps it? The clustering that runs once
 * the drop lands (folder members together, subfolders inside their parent after its
 * own cards, and in "By project" view loose cards before folders) moves anything that
 * is not, so a slot there is a preview the drop cannot honour.
 *
 *  - a folder sits between its siblings: a top-level folder never inside another
 *    folder (nor, By project, among the loose cards), a subfolder inside its parent,
 *    after the parent's own cards;
 *  - a member card stays among its folder's own cards, or leaves the folder and must
 *    then fit as a loose card;
 *  - a loose card is never inside a folder (nor, By project, below one);
 *  - nothing goes above a tier's first project label.
 *
 * Divider lines are looked through: they draw at boundaries and never split a folder.
 */
export function slotFits(arr: string[], index: number, rules: SlotRules): boolean {
  const { folderOf, parentOf, mode } = rules;
  const activeId = arr[index];
  if (activeId === undefined) return false;
  // Above a tier's first project label a row is in no project's run: the clustering
  // takes it back to its own.
  if (arr.findIndex(isTierLabelId) > index) return false;
  let prev: string | undefined;
  for (let i = index - 1; i >= 0; i--) if (!isSeparatorId(arr[i])) { prev = arr[i]; break; }
  let next: string | undefined;
  for (let i = index + 1; i < arr.length; i++) if (!isSeparatorId(arr[i])) { next = arr[i]; break; }
  const folderOfRow = (id: string): string | undefined => isGroupSentinel(id)
    ? parseGroupSentinelGid(id)
    : isTierLabelId(id) ? undefined : folderOf(id);
  const inside = (id: string | undefined, folder: string) => id !== undefined && folderWithin(folderOfRow(id), folder, parentOf);
  const chipWhere = (id: string | undefined, test: (gid: string) => boolean) =>
    id !== undefined && isGroupSentinel(id) && test(parseGroupSentinelGid(id));
  const topChip = (id: string | undefined) => chipWhere(id, (gid) => !parentOf?.has(gid));
  const loose = (id: string | undefined) => id !== undefined && !isGroupSentinel(id) && !isTierLabelId(id) && !folderOf(id);

  if (isGroupSentinel(activeId)) {
    const parent = parentOf?.get(parseGroupSentinelGid(activeId));
    if (parent !== undefined) {
      if (!inside(prev, parent)) return false;
      return next === undefined || chipWhere(next, (gid) => parentOf?.get(gid) === parent) || !inside(next, parent);
    }
    if (next === undefined || isTierLabelId(next) || topChip(next)) return true;
    return mode === 'custom' && loose(next);
  }
  if (staysInFolder(arr, index, folderOf)) return true;
  if (!(next === undefined || isTierLabelId(next) || topChip(next) || loose(next))) return false;
  return mode === 'custom' || prev === undefined || isTierLabelId(prev) || loose(prev);
}

/** Does the card at `arr[index]` sit among its own folder's cards (right below the
 *  folder's chip or one of its own cards)? Anywhere else, the drop takes it out. */
export function staysInFolder(arr: string[], index: number, folderOf: (cardId: string) => string | undefined): boolean {
  const activeId = arr[index];
  const folder = activeId === undefined || isGroupSentinel(activeId) ? undefined : folderOf(activeId);
  if (!folder) return false;
  for (let i = index - 1; i >= 0; i--) {
    const id = arr[i];
    if (isSeparatorId(id)) continue;
    if (isGroupSentinel(id)) return parseGroupSentinelGid(id) === folder;
    return !isTierLabelId(id) && folderOf(id) === folder;
  }
  return false;
}

/** Strip every sentinel (group chips, separator lines, project labels) — every id
 *  that leaves the panel as PIN ORDER must be a real task id (the server assigns
 *  pin_order by position, so a sentinel would eat a slot). */
export function taskIdsOnly(ids: string[]): string[] {
  return ids.filter((id) => !isGroupSentinel(id) && !isSeparatorId(id) && !isTierLabelId(id));
}

/**
 * Insert each group's sentinel immediately before that group's member run.
 *
 * With `parentOf` (folder-tree.ts) the ANCESTORS of a folder get a sentinel too, root
 * first, ahead of the first subtree row that needs them: a folder with no card of its
 * own in this tier is still a row here (its heading), and only a row that is in
 * `items` slides with the tree during a drag and takes a drop. One sentinel per
 * folder, so a folder whose rows are split by a filter never registers two sortables
 * under one id.
 *
 * Must run LAST in the tier's clustering chain, after project clustering:
 * clusterTierByProject keys its blocks off their tasks, and a sentinel (which has no
 * Task) would otherwise inherit the PREVIOUS block's project and be sorted away from
 * its own group. Idempotent — a sentinel already present marks its group as covered.
 */
export function withGroupSentinels(ids: string[], tasks: Task[], tier: FocusTier, parentOf?: Map<string, string>): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: string[] = [];
  const emitted = new Set<string>();
  let prevGid: string | undefined;
  for (const id of ids) {
    if (isGroupSentinel(id)) {
      out.push(id);
      prevGid = parseGroupSentinelGid(id);
      emitted.add(prevGid);
      continue;
    }
    const gid = byId.get(id)?.group_id;
    if (gid && gid !== prevGid) {
      if (parentOf && parentOf.size > 0) {
        for (const ancestor of folderAncestors(gid, parentOf)) {
          if (emitted.has(ancestor)) continue;
          emitted.add(ancestor);
          out.push(groupSortableId(ancestor, tier));
        }
      }
      if (!emitted.has(gid)) {
        emitted.add(gid);
        out.push(groupSortableId(gid, tier));
      }
    }
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
 * An ANCESTOR's sentinel heads its whole subtree: it stays while the next card (past
 * the chips and lines between) sits anywhere under it. The dragged chip counts as a
 * card of its own folder here, so the headings above a folder being dragged keep
 * standing until it lands.
 *
 * Separator sentinels get the same treatment when the filter removed EVERY card:
 * renderTierItems draws no line in a card-less tier (nothing to divide), so keeping
 * the `sep_*` ids would leave items entries with no element and no rect.
 */
export function pruneOrphanSentinels(
  ids: string[],
  taskById: Map<string, Task>,
  activeDragId: string | null,
  parentOf?: Map<string, string>,
): string[] {
  // Fast path keeps array identity stable for the common sentinel-free tier
  // (SortableContext re-registers on a new `items` identity — React #185 history).
  if (!ids.some((id) => isGroupSentinel(id) || isSeparatorId(id))) return ids;
  const anyTask = ids.some((id) => taskById.has(id));
  return ids.filter((id, i) => {
    if (isSeparatorId(id)) return anyTask;
    if (!isGroupSentinel(id)) return true;
    if (id === activeDragId) return true;
    const gid = parseGroupSentinelGid(id);
    // Walk to the first row that can answer for a folder: a card (its folder), or the
    // dragged chip (the folder it stands in for). Other chips and lines are passed.
    for (let j = i + 1; j < ids.length; j++) {
      const next = ids[j];
      if (isSeparatorId(next)) continue;
      // A project label opens the next run: nothing of this folder's comes after it.
      if (isTierLabelId(next)) return false;
      if (isGroupSentinel(next)) {
        if (next === activeDragId) return folderWithin(parseGroupSentinelGid(next), gid, parentOf);
        continue;
      }
      return folderWithin(taskById.get(next)?.group_id, gid, parentOf);
    }
    return false;
  });
}
