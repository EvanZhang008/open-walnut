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
 * (`into:<gid>:<tier>`), for a FOLDER dragged onto it (nesting) and a card from Recent.
 * It is deliberately NOT in the tier's SortableContext items: while it is the
 * collision target, dnd-kit opens no slot and the list stays at rest, so the one row
 * that lights up is the one the drop goes into. A card dragged on the board never
 * names it: its slot alone says where it lands (cardLanding), and the id only names
 * the chip that lights for that slot.
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
  /** A card pinned on the board when the drag started: its slot files it into the
   *  folder there (cardLanding). Anything else (a card from Recent) keeps slotFits. */
  pinnedCard?: (id: string) => boolean;
  /** The folder a chip's row stands for: the deepest folder of a chain drawn as one
   *  "A / B" row (compactFolderChains), the chip's own folder otherwise. */
  leafOf?: (groupId: string) => string;
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

/** Where a card dropped at a slot ends up: `folder` undefined = loose. */
export interface CardLanding {
  fits: boolean;
  folder?: string;
}

/**
 * The folder a CARD dragged on the board lands in at `arr[index]`: the slot itself says
 * it, so the gap the drag opens is exactly where the drop puts the card and every slot
 * is a real place (no slot is refused and snapped back, which is what made a card flick
 * between two places over a folder's rows).
 *
 *  - right under a folder's row: into that folder, as its first card (a row drawn for a
 *    chain "A / B" stands for its deepest folder, `leafOf`);
 *  - among a folder's cards: into that folder, at that place;
 *  - after a folder's last row: still in it "By project", where nothing loose follows a
 *    folder. A custom order puts a card back between two top-level folders there,
 *    except one of that folder's own cards, which stays its last;
 *  - under a loose card or a project label: loose, there;
 *  - above a tier's first project label: nowhere (`fits` false).
 *
 * Divider lines are looked through, as in slotFits.
 */
export function cardLanding(arr: string[], index: number, rules: SlotRules): CardLanding {
  const { folderOf, parentOf, mode } = rules;
  const activeId = arr[index];
  if (activeId === undefined || isGroupSentinel(activeId) || isTierLabelId(activeId)) return { fits: false };
  if (arr.findIndex(isTierLabelId) > index) return { fits: false };
  let prev: string | undefined;
  for (let i = index - 1; i >= 0; i--) if (!isSeparatorId(arr[i])) { prev = arr[i]; break; }
  let next: string | undefined;
  for (let i = index + 1; i < arr.length; i++) if (!isSeparatorId(arr[i])) { next = arr[i]; break; }
  if (prev === undefined || isTierLabelId(prev)) return { fits: true };
  if (isGroupSentinel(prev)) {
    const gid = parseGroupSentinelGid(prev);
    return { fits: true, folder: rules.leafOf?.(gid) ?? gid };
  }
  const above = folderOf(prev);
  if (!above) return { fits: true };
  const folderOfRow = (id: string): string | undefined => isGroupSentinel(id)
    ? parseGroupSentinelGid(id)
    : isTierLabelId(id) ? undefined : folderOf(id);
  const within = (id: string | undefined, folder: string) => id !== undefined && folderWithin(folderOfRow(id), folder, parentOf);
  if (within(next, above) || mode === 'project' || folderOf(activeId) === above) return { fits: true, folder: above };
  // The end of a folder in a custom order: loose when nothing of the folder's top-level
  // folder follows. Inside it (a sibling subfolder next), the card cannot leave it there.
  const top = folderAncestors(above, parentOf ?? new Map())[0] ?? above;
  return within(next, top) ? { fits: true, folder: above } : { fits: true };
}

/**
 * Folder chains a tier draws as ONE row, "A / B": a folder whose rows here are exactly
 * one subfolder (no card of its own, no second subfolder) and that subfolder's, so two
 * headings in a row never say the same thing twice. A chain keeps going while its
 * deepest folder qualifies again. Keyed by the chain's top folder: [top, ..., leaf].
 * Divider lines are looked through. `ids` is a tier's drawn ids, chips and labels
 * included.
 */
export function folderChains(ids: string[], folderOf: (cardId: string) => string | undefined, parentOf: Map<string, string>): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  if (parentOf.size === 0) return chains;
  const folderOfRow = (id: string): string | undefined => isGroupSentinel(id)
    ? parseGroupSentinelGid(id)
    : isTierLabelId(id) || isSeparatorId(id) ? undefined : folderOf(id);
  const nextRow = (from: number): number => {
    for (let k = from + 1; k < ids.length; k++) if (!isSeparatorId(ids[k])) return k;
    return -1;
  };
  const absorbed = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    if (!isGroupSentinel(ids[i])) continue;
    const top = parseGroupSentinelGid(ids[i]);
    if (absorbed.has(top)) continue;
    const chain = [top];
    let at = i;
    for (;;) {
      const cur = chain[chain.length - 1];
      const k = nextRow(at);
      if (k === -1 || !isGroupSentinel(ids[k])) break;
      const child = parseGroupSentinelGid(ids[k]);
      if (parentOf.get(child) !== cur) break;
      // Every row of cur's subtree after the child's chip must be the child's.
      let only = true;
      for (let r = nextRow(k); r !== -1; r = nextRow(r)) {
        const f = folderOfRow(ids[r]);
        if (!folderWithin(f, cur, parentOf)) break;
        if (!folderWithin(f, child, parentOf)) { only = false; break; }
      }
      if (!only) break;
      chain.push(child);
      at = k;
    }
    if (chain.length < 2) continue;
    chains.set(top, chain);
    for (const gid of chain.slice(1)) absorbed.add(gid);
  }
  return chains;
}

/** `ids` without the chips a chain row draws for (every folder of a chain but its
 *  top). Same array back when there is none. */
export function withoutChainedChips(ids: string[], chains: Map<string, string[]> | undefined): string[] {
  if (!chains || chains.size === 0) return ids;
  const absorbed = new Set<string>();
  for (const chain of chains.values()) for (const gid of chain.slice(1)) absorbed.add(gid);
  const out = ids.filter((id) => !isGroupSentinel(id) || !absorbed.has(parseGroupSentinelGid(id)));
  return out.length === ids.length ? ids : out;
}

/** The parent map a tier DRAWS its folders with: a chained folder stands in its top's
 *  place (same depth), so the cards under an "A / B" row indent one step, not two. */
export function chainedParents(parentOf: Map<string, string>, chains: Map<string, string[]> | undefined): Map<string, string> {
  if (!chains || chains.size === 0) return parentOf;
  const out = new Map(parentOf);
  for (const [top, chain] of chains) {
    const above = parentOf.get(top);
    for (const gid of chain.slice(1)) {
      if (above === undefined) out.delete(gid); else out.set(gid, above);
    }
  }
  return out;
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
