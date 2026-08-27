/**
 * Tier separators — the hand-placed divider lines inside a pinned tier list.
 *
 * A separator is JUST A LINE: no title, no tasks, no behaviour. It gives the
 * user one more level of grouping inside a tier (or inside one project run of a
 * tier) without inventing a container that the task model would then have to
 * carry everywhere.
 *
 * Five design rules live in this file:
 *
 * 1. **Anchored to neighbours, never to an index.** A line stored as "position
 *    4" drifts the moment anything above it is completed, reordered or moved to
 *    another tier — the user's band silently swallows the wrong rows. So a
 *    separator records what sits directly ABOVE it and directly BELOW it, and
 *    placement resolves `after` first (the line clings to the row it ends a band
 *    after), then `before`, then the end of the list. `after` leads because a
 *    card INSERTED into the line's gap arrives from below it (a drop in the gap
 *    above targets the row above → a different gesture entirely), so the honest
 *    read of "new card between my anchors" is "it landed under the line".
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
 * 5. **A line never follows a card that MOVES.** Anchors follow their card when it
 *    is COMPLETED or unpinned (the ladder degrades to the other side) — that is
 *    the point of anchoring. But when the user picks an anchor card up and drops
 *    it somewhere ELSE, the line marks a band position, not that card: reported
 *    2026-08-25, a card below the line was dragged into a group above it, the
 *    line rode along past the whole group, and every task the user had banded
 *    ended up on the wrong side. So every drag that relocates a card re-anchors
 *    the affected lines to the neighbours that STAYED
 *    (reanchorSeparatorsAfterMove), before the move is persisted.
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
  /** Optional heading text ("Now", "Next"…). A named line is a section heading;
   *  an unnamed one is the plain divider it always was. Layout-only either way:
   *  no task ever references it. */
  label?: string;
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
 * A custom-mode separator's SLOT in a card order (0 = above the first card,
 * rows.length = below the last), or null when neither anchor is present. The
 * ladder is rule 1's: below the `after` card, else above the `before` card.
 * Shared by render placement and the move-time re-anchor so the two can never
 * disagree about where a line currently sits.
 */
export function customSlotFor(rows: string[], sep: TierSeparator): number | null {
  if (sep.after) {
    const ai = rows.indexOf(sep.after);
    if (ai !== -1) return ai + 1;
  }
  if (sep.before) {
    const bi = rows.indexOf(sep.before);
    if (bi !== -1) return bi;
  }
  return null;
}

/**
 * Rule 5: re-anchor the lines whose anchor card is about to MOVE, so the line
 * stays with its band instead of riding along with the card.
 *
 * `beforeIds` is the tier's render order BEFORE the move (task ids only, in the
 * order placement resolved against), `movedIds` the card being relocated — or a
 * whole group's members when the block moves as one. Each affected line keeps
 * its current slot: the new anchors are the nearest rows on either side that
 * are NOT moving. Lines in other tiers/modes and lines not anchored to a moved
 * card pass through untouched; when nothing changes the SAME array comes back,
 * so callers can `!==` to skip a pointless save.
 */
export function reanchorSeparatorsAfterMove(opts: {
  separators: TierSeparator[];
  tier: string;
  beforeIds: string[];
  movedIds: string[];
  groupOf?: (id: string) => string | null;
}): TierSeparator[] {
  const { separators, tier, beforeIds, movedIds, groupOf = () => null } = opts;
  const moved = new Set(movedIds);
  let changed = false;
  const out = separators.map((sep) => {
    if (sep.tier !== tier || sep.mode !== 'custom') return sep;
    if (!(sep.after && moved.has(sep.after)) && !(sep.before && moved.has(sep.before))) return sep;
    let slot = customSlotFor(beforeIds, sep);
    if (slot === null) return sep; // already unresolvable — the ladder owns it
    slot = snapSlotOutOfGroup(beforeIds, slot, groupOf);
    // The band's real neighbours are the rows that STAY: walk outward past the
    // moving cards on both sides.
    let ai = slot - 1;
    while (ai >= 0 && moved.has(beforeIds[ai])) ai--;
    let bi = slot;
    while (bi < beforeIds.length && moved.has(beforeIds[bi])) bi++;
    const after = ai >= 0 ? beforeIds[ai] : '';
    const before = bi < beforeIds.length ? beforeIds[bi] : '';
    if (after === (sep.after ?? '') && before === (sep.before ?? '')) return sep;
    changed = true;
    return { ...sep, after, before };
  });
  return changed ? out : separators;
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
    // one thing to correct — rule 1's ladder: below the card above it, then above
    // the card below it, then the end of the list.
    let slot = customSlotFor(taskIds, sep);
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

/**
 * Insert a CUSTOM-mode tier's separator ids into its sentinel-bearing render
 * array, at the slot each line resolves to.
 *
 * This is what makes a line a REAL dnd-kit sortable unit (same architecture as
 * the group chip in tier-group-sentinels.ts): in `items`, the strategy displaces
 * the line together with the cards around it during any drag, so a card can
 * never visually cross a line that "never yields" (reported 2026-08-25: dragging
 * T2 above T1 slid T1 below the static line; and the insert slot could not open
 * above a top-anchored line at all).
 *
 * `ids` is the tier's render order AFTER withGroupSentinels (group sentinels
 * present). A line resolves against the real task ids only, then is inserted
 * before the card at its slot — jumping above that card's group chip when one
 * immediately precedes it, because renderTierItems draws lines above chips.
 * Unresolvable lines (both anchors gone) go to the end, mirroring placeSeparators'
 * tail. An empty tier gets no lines (nothing to divide).
 */
export function withSeparatorSentinels(opts: {
  ids: string[];
  separators: TierSeparator[];
  tier: string;
  groupOf?: (id: string) => string | null;
  /** Distinguishes real task ids from group sentinels in `ids`. */
  isTaskId: (id: string) => boolean;
}): string[] {
  const { ids, separators, tier, groupOf = () => null, isTaskId } = opts;
  const seps = separators.filter((s) => s.tier === tier && s.mode === 'custom');
  if (seps.length === 0) return ids;
  const taskIds = ids.filter(isTaskId);
  if (taskIds.length === 0) return ids;

  // Resolve every line to a task slot first (against the card order, which is
  // stable), THEN splice into the sentinel-bearing array — inserting as we go
  // would shift the later lines' reference frame.
  const bySlot = new Map<number, TierSeparator[]>();
  const tail: TierSeparator[] = [];
  for (const sep of seps) {
    let slot = customSlotFor(taskIds, sep);
    if (slot === null) { tail.push(sep); continue; }
    slot = snapSlotOutOfGroup(taskIds, slot, groupOf);
    if (slot >= taskIds.length) { tail.push(sep); continue; }
    const arr = bySlot.get(slot);
    if (arr) arr.push(sep); else bySlot.set(slot, [sep]);
  }

  const out: string[] = [];
  let taskIdx = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (isTaskId(id)) {
      const here = bySlot.get(taskIdx);
      if (here) {
        // Lines draw above the card AND above its group chip: when the previous
        // emitted id is this card's chip sentinel, hoist the lines above it.
        const insertAt = out.length > 0 && !isTaskId(out[out.length - 1]) && !isSeparatorId(out[out.length - 1])
          ? out.length - 1 : out.length;
        out.splice(insertAt, 0, ...here.map((s) => s.id));
      }
      taskIdx++;
    }
    out.push(id);
  }
  for (const sep of tail) out.push(sep.id);
  return out;
}

/**
 * Rewrite CUSTOM-mode anchors from a tier's FINAL render array (cards + any
 * sentinels), after a drop. With lines living in `items`, what dnd-kit previewed
 * is the truth of the gesture — a card dropped into a line's gap that pushed the
 * line DOWN really is above the line now. Deriving anchors from the final array
 * keeps the stored record and the last visible frame identical, so nothing jumps
 * after the drop lands. Returns the SAME array when nothing changed.
 *
 * Two guards keep "the frame is the truth" from destroying durable anchors the
 * frame never showed (both were shipped bugs, 2026-08-26 review):
 *  • A frame with NO cards derives nothing — anchorsForSlot([]) is ('',''),
 *    which would strand the line at the tail forever. Keep the record; pin a
 *    card back and the line returns where the user left it.
 *  • A line anchored to a card that EXISTS but is hidden from this frame
 *    (completed pin, collapsed group) is rendering at a FALLBACK slot, not
 *    where the user put it — rewriting from that fallback silently moves the
 *    line for when the card comes back. `isKnownTaskId` tells hidden apart
 *    from gone (gone anchors SHOULD be healed). `forceId` overrides for the
 *    one line the user explicitly dragged: that gesture is always the truth.
 */
export function syncSeparatorAnchorsFromArr(opts: {
  separators: TierSeparator[];
  tier: string;
  finalArr: string[];
  isTaskId: (id: string) => boolean;
  groupOf?: (id: string) => string | null;
  /** True for any REAL task id in the whole dataset, visible or not. */
  isKnownTaskId?: (id: string) => boolean;
  /** This line's anchors are rewritten even when hidden-anchored (it was dragged). */
  forceId?: string;
}): TierSeparator[] {
  const { separators, tier, finalArr, isTaskId, groupOf = () => null, isKnownTaskId, forceId } = opts;
  // Position of each line = how many real cards precede it.
  const slotOf = new Map<string, number>();
  let count = 0;
  for (const id of finalArr) {
    if (isSeparatorId(id)) slotOf.set(id, count);
    else if (isTaskId(id)) count++;
  }
  const taskIds = finalArr.filter(isTaskId);
  if (taskIds.length === 0) return separators; // nothing to divide, nothing to derive
  const hiddenAnchor = (anchor: string | undefined) =>
    !!anchor && !!isKnownTaskId?.(anchor) && !taskIds.includes(anchor);
  let changed = false;
  const out = separators.map((sep) => {
    if (sep.tier !== tier || sep.mode !== 'custom') return sep;
    let slot = slotOf.get(sep.id);
    if (slot === undefined) return sep; // not rendered here (filtered) — keep as-is
    if (sep.id !== forceId && (hiddenAnchor(sep.after) || hiddenAnchor(sep.before))) return sep;
    // Rule 4: a group is one unit — a drop between two members snaps below the run.
    slot = snapSlotOutOfGroup(taskIds, slot, groupOf);
    const { after, before } = anchorsForSlot(taskIds, slot);
    if (after === (sep.after ?? '') && before === (sep.before ?? '')) return sep;
    changed = true;
    return { ...sep, after, before };
  });
  return changed ? out : separators;
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
