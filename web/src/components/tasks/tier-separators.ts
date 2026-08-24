/**
 * Tier separators — the hand-placed divider lines inside a pinned tier list.
 *
 * A separator is JUST A LINE: no title, no tasks, no behaviour. It gives the
 * user one more level of grouping inside a tier (or inside one project run of a
 * tier) without inventing a container that the task model would then have to
 * carry everywhere.
 *
 * Three design rules live in this file:
 *
 * 1. **Anchored to neighbours, never to an index.** A line stored as "position
 *    4" drifts the moment anything above it is completed, reordered or moved to
 *    another tier — the user's band silently swallows the wrong rows. So a
 *    separator records what sits directly ABOVE it and directly BELOW it, and
 *    placement resolves `before` first, then `after`, then the end of the list.
 *    Whatever happens to the tier, the line lands next to something the user
 *    actually put it next to, and it can never disappear.
 *
 * 2. **A separator belongs to ONE view mode.** 'By project' and 'Custom order'
 *    are separate orders (project mode clusters the raw pin order into runs), so
 *    a line placed between two rows in one mode sits between unrelated rows in
 *    the other. Each separator names its mode and is invisible in the other one.
 *
 * 3. **In 'By project', A FOLDER IS ONE UNIT.** The two modes therefore anchor to
 *    different things, which is why the fields are separate rather than one pair
 *    whose meaning flips with `mode`:
 *
 *      custom  → the TASK above / below the line. Cards are the unit, so a line
 *                sits between two cards.
 *      project → the FOLDER above / below the line. A folder is a whole thing, so
 *                a line sits between two folders and NEVER inside one. Dropping a
 *                line between a folder's label and its own cards would read as
 *                "this folder is split from its tasks", which is not a band
 *                boundary, just a broken-looking folder.
 *
 * 4. **A GROUP IS ONE UNIT TOO, in BOTH modes.** Same reasoning as a folder, but
 *    it needs its own rule because a group's members are ordinary cards, so in
 *    custom mode a line CAN anchor to one. Reported 2026-08-24: a card that joined
 *    a group carried the line in with it (the line was anchored to that card), and
 *    the cluster ended up straddling the line — members the user had put above it
 *    were suddenly below it. So a resolved position that falls between two members
 *    of one group is pushed down to the boundary BELOW that group: everything the
 *    user had already put above the line stays above it.
 *
 * Placement is pure so the renderer can call it with the live drag preview
 * substituted in and get the exact frame it will commit.
 */

export type SeparatorMode = 'project' | 'custom';

export interface TierSeparator {
  /** `sep_<random>` — stable across drags, so a move is an update not a re-create. */
  id: string;
  /** 'focus' | 'satellite' | 'backlog' | 'wait' | `ct_*`. */
  tier: string;
  mode: SeparatorMode;
  /** mode 'custom': task id directly above the line ('' = top of the list). */
  after?: string;
  /** mode 'custom': task id directly below the line ('' = bottom of the list). */
  before?: string;
  /** mode 'project': the folder directly ABOVE the line ('' = Inbox, which is a
   *  real folder here). Absent means "no folder above": top of the tier. */
  afterProject?: string;
  /** mode 'project': the folder directly BELOW the line. Absent means "no folder
   *  below": bottom of the tier. */
  beforeProject?: string;
  /** LEGACY, read-only: the run a project-mode line used to sit INSIDE, back when
   *  a line could split a folder. Resolved as `beforeProject` so an old line moves
   *  to that folder's top edge instead of silently vanishing. Never written. */
  project?: string;
}

/** Where a separator sits, resolved against the tier's current render order. */
export interface SeparatorPlacement {
  /** mode 'custom': taskId → separators drawn immediately ABOVE that card. */
  above: Map<string, TierSeparator[]>;
  /** mode 'project': project → separators drawn immediately above that FOLDER
   *  (above its label, so the line reads as a boundary between folders). */
  aboveProject: Map<string, TierSeparator[]>;
  /** Separators drawn at the very END of the tier list, in either mode. */
  tail: TierSeparator[];
}

const SEP_PREFIX = 'sep_';

/** Stable-ish id without pulling in a uuid dep. Collisions are cosmetic (two
 *  lines would move together) and the space is large enough to ignore. */
export function newSeparatorId(): string {
  return `${SEP_PREFIX}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function isSeparatorId(id: string): boolean {
  return id.startsWith(SEP_PREFIX);
}

/**
 * The nearest slot that is not INSIDE a group's member run.
 *
 * `rows` is the card order (no sentinels), `index` a slot (0 = above the first
 * card, rows.length = below the last). A slot is inside a run when the cards on
 * both sides of it belong to the same group; such a slot is pushed DOWN to the
 * boundary below that run, so members already above the line stay above it.
 *
 * Members are contiguous by construction (the tier order clusters them), but the
 * walk doesn't rely on that: it follows the run from the slot outward.
 */
export function snapSlotOutOfGroup(
  rows: string[],
  index: number,
  groupOf: (id: string) => string | null,
): number {
  const i = Math.max(0, Math.min(index, rows.length));
  if (i === 0 || i === rows.length) return i; // the ends are never inside anything
  const gid = groupOf(rows[i - 1]);
  if (!gid || groupOf(rows[i]) !== gid) return i;
  let end = i;
  while (end < rows.length && groupOf(rows[end]) === gid) end++;
  return end;
}

/**
 * Resolve every separator of one tier+mode into render positions.
 *
 * `ids` is the tier's RENDER order (task ids, possibly with `group:*` sentinels
 * mixed in — those are skipped). `projectOf` returns a task's project ('' for
 * Inbox) or null when the id isn't a task. `groupOf` returns a task's group id or
 * null; without it a line can land between two members of one group and split it.
 */
export function placeSeparators(opts: {
  ids: string[];
  projectOf: (id: string) => string | null;
  groupOf?: (id: string) => string | null;
  tier: string;
  mode: SeparatorMode;
  separators: TierSeparator[];
}): SeparatorPlacement {
  const { ids, projectOf, groupOf = () => null, tier, mode, separators } = opts;
  const above = new Map<string, TierSeparator[]>();
  const aboveProject = new Map<string, TierSeparator[]>();
  const tail: TierSeparator[] = [];

  // The two modes divide different things, so they resolve against different
  // sequences: cards for 'custom', folder runs (first-seen order, which is the
  // order they render in) for 'project'.
  const taskIds: string[] = [];
  const runs: string[] = [];
  for (const id of ids) {
    const proj = projectOf(id);
    if (proj === null) continue; // group sentinel / unknown id
    taskIds.push(id);
    if (!runs.includes(proj)) runs.push(proj);
  }

  const push = (map: Map<string, TierSeparator[]>, anchor: string, sep: TierSeparator) => {
    const arr = map.get(anchor);
    if (arr) arr.push(sep); else map.set(anchor, [sep]);
  };

  for (const sep of separators) {
    if (sep.tier !== tier || sep.mode !== mode) continue;

    // Empty tier → nothing to divide and nowhere to draw. The record survives:
    // pin a task back and the line comes back where the user left it.
    if (taskIds.length === 0) continue;

    if (mode === 'project') {
      // 'project' is legacy data (a line that used to live inside a run) and
      // resolves to that folder's top edge.
      const below = sep.beforeProject ?? sep.project;
      if (below !== undefined && runs.includes(below)) { push(aboveProject, below, sep); continue; }
      // The folder below is gone — hold the line under the folder ABOVE it.
      if (sep.afterProject !== undefined) {
        const idx = runs.indexOf(sep.afterProject);
        if (idx !== -1) {
          const next = runs[idx + 1];
          if (next !== undefined) push(aboveProject, next, sep); else tail.push(sep);
          continue;
        }
      }
      // Both neighbours are gone: keep it at the end of the tier rather than
      // dropping it. The user placed it; only its neighbourhood moved on.
      tail.push(sep);
      continue;
    }

    // Resolve to a SLOT (the gap the line occupies), so the group snap below has
    // one thing to correct — the ladder is: the card below it, then the card above
    // it, then the end of the list.
    let slot: number | null = null;
    if (sep.before) {
      const bi = taskIds.indexOf(sep.before);
      if (bi !== -1) slot = bi;
    }
    if (slot === null && sep.after) {
      const ai = taskIds.indexOf(sep.after);
      if (ai !== -1) slot = ai + 1;
    }
    if (slot === null) { tail.push(sep); continue; }
    slot = snapSlotOutOfGroup(taskIds, slot, groupOf);
    if (slot >= taskIds.length) tail.push(sep); else push(above, taskIds[slot], sep);
  }

  return { above, aboveProject, tail };
}

/**
 * Neighbours for a drop between two CARDS (mode 'custom'): the ids that become
 * the separator's `after` / `before`. `rows` is the tier's task ids in render
 * order, `index` the slot the line lands in (0 = above the first row,
 * rows.length = below the last).
 */
export function anchorsForSlot(rows: string[], index: number): { after: string; before: string } {
  const i = Math.max(0, Math.min(index, rows.length));
  return { after: i > 0 ? rows[i - 1] : '', before: i < rows.length ? rows[i] : '' };
}

/**
 * Neighbours for a drop between two FOLDERS (mode 'project'). `runs` is the
 * tier's folders in render order, `index` the boundary (0 = above the first
 * folder, runs.length = below the last).
 *
 * An absent field means "that end of the tier", which is why these can't be
 * normalized to '': '' is Inbox, a real folder.
 */
export function projectAnchorsForSlot(runs: string[], index: number): { afterProject?: string; beforeProject?: string } {
  const i = Math.max(0, Math.min(index, runs.length));
  return {
    ...(i > 0 ? { afterProject: runs[i - 1] } : {}),
    ...(i < runs.length ? { beforeProject: runs[i] } : {}),
  };
}

/** Replace one separator in a list (by id), appending it when it's new. */
export function upsertSeparator(list: TierSeparator[], sep: TierSeparator): TierSeparator[] {
  const idx = list.findIndex((s) => s.id === sep.id);
  if (idx === -1) return [...list, sep];
  const next = [...list];
  next[idx] = sep;
  return next;
}

export function removeSeparator(list: TierSeparator[], id: string): TierSeparator[] {
  return list.filter((s) => s.id !== id);
}
