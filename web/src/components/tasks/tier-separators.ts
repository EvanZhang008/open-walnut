/**
 * Tier separators — the hand-placed divider lines inside a pinned tier list.
 *
 * A separator is JUST A LINE: no title, no tasks, no behaviour. It gives the
 * user one more level of grouping inside a tier (or inside one project run of a
 * tier) without inventing a container that the task model would then have to
 * carry everywhere.
 *
 * Two design rules live in this file:
 *
 * 1. **Anchored to neighbours, never to an index.** A line stored as "position
 *    4" drifts the moment anything above it is completed, reordered or moved to
 *    another tier — the user's band silently swallows the wrong rows. So a
 *    separator records the task id directly ABOVE it and the one directly BELOW
 *    it, and placement resolves `before` first, then `after`, then the end of
 *    its scope. Whatever happens to the list, the line lands next to a row the
 *    user actually put it next to, and it can never disappear.
 *
 * 2. **A separator belongs to ONE view mode.** 'By project' and 'Custom order'
 *    are separate orders (project mode clusters the raw pin order into runs), so
 *    a line placed between two rows in one mode sits between unrelated rows in
 *    the other. Each separator names its mode and is invisible in the other one.
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
  /** mode 'project' only: which project run it sits in ('' = Inbox). */
  project?: string;
  /** Task id directly above the line ('' = top of scope). */
  after?: string;
  /** Task id directly below the line ('' = bottom of scope). */
  before?: string;
}

/** Where a separator sits, resolved against the tier's current render order. */
export interface SeparatorPlacement {
  /** taskId → separators drawn immediately ABOVE that row. */
  above: Map<string, TierSeparator[]>;
  /** scope key → separators drawn at the END of that scope. In project mode the
   *  key is the project name ('' = Inbox); in custom mode it is always ''. */
  tail: Map<string, TierSeparator[]>;
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
 * Resolve every separator of one tier+mode into render positions.
 *
 * `ids` is the tier's RENDER order (task ids, possibly with `group:*` sentinels
 * mixed in — those are skipped). `projectOf` returns a task's project ('' for
 * Inbox) or null when the id isn't a task.
 */
export function placeSeparators(opts: {
  ids: string[];
  projectOf: (id: string) => string | null;
  tier: string;
  mode: SeparatorMode;
  separators: TierSeparator[];
}): SeparatorPlacement {
  const { ids, projectOf, tier, mode, separators } = opts;
  const above = new Map<string, TierSeparator[]>();
  const tail = new Map<string, TierSeparator[]>();

  // Task ids per scope, in render order. In custom mode the whole tier is one
  // scope ('') — that mode has no project runs at all.
  const scopeIds = new Map<string, string[]>();
  for (const id of ids) {
    const proj = projectOf(id);
    if (proj === null) continue; // group sentinel / unknown id
    const key = mode === 'project' ? proj : '';
    const arr = scopeIds.get(key);
    if (arr) arr.push(id); else scopeIds.set(key, [id]);
  }

  const pushAbove = (anchor: string, sep: TierSeparator) => {
    const arr = above.get(anchor);
    if (arr) arr.push(sep); else above.set(anchor, [sep]);
  };
  const pushTail = (key: string, sep: TierSeparator) => {
    const arr = tail.get(key);
    if (arr) arr.push(sep); else tail.set(key, [sep]);
  };

  for (const sep of separators) {
    if (sep.tier !== tier || sep.mode !== mode) continue;
    const key = mode === 'project' ? (sep.project ?? '') : '';
    const scope = scopeIds.get(key);
    // Scope gone (project has no rows in this tier right now) → the line is not
    // rendered, but it is NOT deleted: pin a task back into that project and the
    // line comes back where the user left it.
    if (!scope || scope.length === 0) continue;

    const beforeIdx = sep.before ? scope.indexOf(sep.before) : -1;
    if (beforeIdx !== -1) { pushAbove(sep.before!, sep); continue; }

    // The row below vanished — hold the line under the row ABOVE it instead.
    const afterIdx = sep.after ? scope.indexOf(sep.after) : -1;
    if (afterIdx !== -1) {
      const next = scope[afterIdx + 1];
      if (next) pushAbove(next, sep); else pushTail(key, sep);
      continue;
    }

    // Both neighbours are gone. Keep it at the end of its scope rather than
    // dropping it — the user placed it, only its neighbourhood moved on.
    pushTail(key, sep);
  }

  return { above, tail };
}

/**
 * Neighbours for a drop between two rows: the ids that will become the
 * separator's `after` / `before`. `rows` is the scope's task ids in render
 * order, `index` the slot the line lands in (0 = above the first row,
 * rows.length = below the last).
 */
export function anchorsForSlot(rows: string[], index: number): { after: string; before: string } {
  const i = Math.max(0, Math.min(index, rows.length));
  return { after: i > 0 ? rows[i - 1] : '', before: i < rows.length ? rows[i] : '' };
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
