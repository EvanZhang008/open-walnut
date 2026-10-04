/**
 * The order of a pinned tier's rows: ONE definition for the home TodoPanel and the phone.
 *
 * The iOS board twins this module verbatim
 * (`ios-native/Walnut/Views/Tasks/PinnedTierOrder.swift`), and a differential test runs
 * both over the same fixture (`tests/fixtures/pinned-tier-order/`, pinned by
 * `tests/web/pinned-tier-order.test.ts` and `PinnedTierOrderTests.swift`). Change the rule
 * here and the fixture test fails until the Swift twin and the fixture follow.
 *
 * Inputs, and nothing else (no browser state reaches the order):
 *  - `rows`: the tier's OPEN rows in pin order (`pin_order` ascending, the server's
 *    `splitTiers` order). Completed pins are not drawn in a tier outside search.
 *  - `mode`: the tier's view mode. `project` = "By project", `custom` = "Custom order".
 *  - `projectOrder`: the hand-arranged project order (`ordering.projects`).
 *
 * Date and search filters apply AFTER this, as a visibility filter over the result: a
 * hidden row still anchors its project's and folder's place, so filtering never
 * reorders what stays on screen.
 */

/** The three fields the order reads. `group_id` is the row's folder. */
export interface PinnedTierRow {
  id: string;
  project?: string | null;
  group_id?: string | null;
}

/** `project` = "By project" (the default), `custom` = "Custom order". */
export type PinnedTierMode = 'project' | 'custom';

/**
 * Cluster a tier's tasks so same-group members are contiguous, anchored at the
 * group's first member in the given order. Flat (no parent/child nesting) version
 * of the main list's computeSortOrder clustering. Every group clusters, a lone
 * member included (it simply stays where it is). Pure and order-stable, so
 * re-running on already-clustered input is a no-op. Returns ids.
 */
export function clusterTierByGroup<T extends PinnedTierRow>(tasks: T[], sinkFolders = false): string[] {
  const byGroup = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.group_id) {
      let arr = byGroup.get(t.group_id);
      if (!arr) { arr = []; byGroup.set(t.group_id, arr); }
      arr.push(t.id);
    }
  }
  const emitted = new Set<string>();
  const out: string[] = [];
  if (sinkFolders) {
    // A1 ordering (project view): loose tasks first, folder clusters sink AFTER
    // them. Two-pass emit keeps each side's relative order → still idempotent.
    // NOT applied in custom view, where the user's hand order is authority.
    for (const t of tasks) {
      if (!t.group_id) out.push(t.id);
    }
    for (const t of tasks) {
      if (!t.group_id || emitted.has(t.group_id)) continue;
      emitted.add(t.group_id);
      out.push(...(byGroup.get(t.group_id) ?? []));
    }
    return out;
  }
  for (const t of tasks) {
    const members = t.group_id ? byGroup.get(t.group_id) : undefined;
    if (t.group_id && members && members.length >= 1) {
      if (emitted.has(t.group_id)) continue; // already flushed at the lead
      emitted.add(t.group_id);
      out.push(...members);
    } else {
      out.push(t.id);
    }
  }
  return out;
}

/**
 * Cluster a tier's id order into project runs (first-seen anchor order), so the
 * pinned area can render a minimal folder label per project, the same folder
 * structure as the main task list. Runs AFTER clusterTierByGroup and treats a
 * contiguous same-group run as ONE atomic block keyed by its lead task's
 * project (a group must never be split across folders). Pure + order-stable
 * (idempotent), and NEVER applied mid-drag: during a drag the user's live
 * order is authority (same contract as group clustering).
 */
export function clusterTierByProject<T extends PinnedTierRow>(ids: string[], tasks: T[], projectOrder?: string[]): string[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // 1. Blocks: same-group contiguous runs collapse into one block; everything
  //    else is a single-id block. Unknown ids (group: sentinels shouldn't reach
  //    here outside a drag, but be safe) inherit the previous block's key.
  type Block = { key: string; ids: string[] };
  const blocks: Block[] = [];
  let i = 0;
  while (i < ids.length) {
    const t = taskById.get(ids[i]);
    if (!t) {
      const key = blocks.length > 0 ? blocks[blocks.length - 1].key : '';
      blocks.push({ key, ids: [ids[i]] });
      i++;
      continue;
    }
    if (t.group_id) {
      const run = [ids[i]];
      let j = i + 1;
      while (j < ids.length && taskById.get(ids[j])?.group_id === t.group_id) {
        run.push(ids[j]);
        j++;
      }
      blocks.push({ key: t.project || '', ids: run });
      i = j;
    } else {
      blocks.push({ key: t.project || '', ids: [ids[i]] });
      i++;
    }
  }
  // 2. Stable-partition blocks by key, anchored at each key's first occurrence.
  const byKey = new Map<string, string[]>();
  const keyOrder: string[] = [];
  for (const b of blocks) {
    let arr = byKey.get(b.key);
    if (!arr) { arr = []; byKey.set(b.key, arr); keyOrder.push(b.key); }
    arr.push(...b.ids);
  }
  // 3. Optional global project order (ordering.projects, case-insensitive):
  // listed projects rank by their position, unlisted keep first-occurrence
  // order after them, Inbox ('') stays wherever occurrence put it relative to
  // other unlisted keys. Stable sort → ties keep occurrence order.
  if (projectOrder && projectOrder.length > 0) {
    const rank = new Map(projectOrder.map((name, idx) => [name.toLowerCase(), idx]));
    const occurrence = new Map(keyOrder.map((k, idx) => [k, idx]));
    keyOrder.sort((a, b) => {
      const ra = rank.get(a.toLowerCase());
      const rb = rank.get(b.toLowerCase());
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return occurrence.get(a)! - occurrence.get(b)!;
    });
  }
  return keyOrder.flatMap((k) => byKey.get(k)!);
}

/**
 * The tier's row ids in the order the panel draws them.
 *
 *  - `project` ("By project"): loose rows keep pin order and every folder's rows sink
 *    below them as one block (anchored at the folder's first member), then the rows
 *    group into project runs. A project listed in `projectOrder` takes its listed
 *    place; every other project (Inbox included) follows, in order of first appearance.
 *  - `custom` ("Custom order"): pin order, with each folder's rows pulled up to its
 *    first member so a folder is never split.
 */
export function orderPinnedTier<T extends PinnedTierRow>(rows: T[], mode: PinnedTierMode, projectOrder?: string[]): string[] {
  const grouped = clusterTierByGroup(rows, mode === 'project');
  return mode === 'custom' ? grouped : clusterTierByProject(grouped, rows, projectOrder);
}
