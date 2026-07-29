// Pure helpers for the home-page SessionPanel column queue.
// Extracted from MainPage.tsx so they can be unit-tested without React.
//
// Layout invariant:
//   [ unlocked ... ][ newly-locked ... first-locked ]
//    ↑ left                              ↑ rightmost = pin anchor
//
// Unlocked slots occupy the left; locked slots occupy the right. Within the
// locked region, the FIRST slot the user locked sits rightmost (acts as a
// visual anchor), and subsequently-locked slots slide in from the left edge of
// the locked region. Unlock symmetrically drops the slot at the right edge of
// the unlocked region, next to the boundary the user just crossed.

export interface SessionSlot {
  id: string;
  locked: boolean;
}

export function splitByLock(cols: SessionSlot[]): { unlocked: SessionSlot[]; locked: SessionSlot[] } {
  const unlocked: SessionSlot[] = [];
  const locked: SessionSlot[] = [];
  for (const c of cols) (c.locked ? locked : unlocked).push(c);
  return { unlocked, locked };
}

/**
 * Shrink to `max` total columns by dropping unlocked slots from the RIGHT, and
 * leaving every surviving slot exactly where it was.
 *
 * Locked slots are exempt — they can even push the total past `max` (visible
 * overflow is preferred over evicting something the user explicitly pinned).
 *
 * IT MUST PRESERVE THE INCOMING ORDER. This used to return
 * `[...unlocked.slice(0, keep), ...locked]`, i.e. it rebuilt the strip from the
 * lock-partitioned halves, which made a shrink do two things nobody asked for:
 *   - `[A* B C]` → `[B A*]`: the locked column, sitting LEFT of the survivors,
 *     was moved to the right — a pinned panel visibly jumping across the strip
 *     during an unrelated 3→2 change.
 *   - `[A B C*]` → `[A C*]`: it dropped B, the MIDDLE column, because
 *     `unlocked.slice(0, keep)` counts within the partitioned run rather than
 *     along the visual row. From the user's side a window in the middle
 *     vanished while the rightmost one stayed.
 * Both read as "a random panel disappeared". Walking right-to-left over the
 * original array evicts what the user actually sees as last, and keeps the rest
 * of the row untouched.
 */
export function trimUnlockedToMax(cols: SessionSlot[], max: number): SessionSlot[] {
  if (cols.length <= max) return cols;
  // How many unlocked slots must go. Locked ones are never candidates, so when
  // they alone exceed `max` this drops every unlocked slot and still overflows.
  let toDrop = cols.length - Math.max(max, cols.filter(c => c.locked).length);
  if (toDrop <= 0) return cols;
  const doomed = new Set<SessionSlot>();
  for (let i = cols.length - 1; i >= 0 && toDrop > 0; i--) {
    if (cols[i].locked) continue;
    doomed.add(cols[i]);
    toDrop--;
  }
  return cols.filter(c => !doomed.has(c));
}

/**
 * Returns `cols` unchanged (reference-equal) iff all slots are locked and `id`
 * is new — callers use `next === prev` to detect this rejection path and show
 * a toast. Any other case yields a new array.
 */
export function addSessionColumn(cols: SessionSlot[], id: string, triageOpen: boolean, maxColumns: number): SessionSlot[] {
  const max = triageOpen ? maxColumns - 1 : maxColumns;
  const existing = cols.find(c => c.id === id);
  if (existing) {
    const filtered = cols.filter(c => c.id !== id);
    const { unlocked, locked } = splitByLock(filtered);
    // Locked branch re-uses the existing object reference on purpose — preserves
    // React key+memo identity so the locked panel's subtree doesn't remount
    // when the user clicks its pill. Unlocked branch constructs fresh because
    // the slot is moving to leftmost; no stability benefit worth the branch cost.
    return existing.locked
      ? [...unlocked, existing, ...locked]              // locked: left edge of locked region
      : [{ id, locked: false }, ...unlocked, ...locked]; // unlocked: leftmost
  }
  const { unlocked, locked } = splitByLock(cols);
  if (locked.length >= max) return cols; // fully locked — caller shows toast
  return trimUnlockedToMax([{ id, locked: false }, ...unlocked, ...locked], max);
}

export function removeSessionColumn(cols: SessionSlot[], id: string): SessionSlot[] {
  return cols.filter(c => c.id !== id);
}

export function replaceSessionColumn(cols: SessionSlot[], oldId: string, newId: string): SessionSlot[] {
  const idx = cols.findIndex(c => c.id === oldId);
  if (idx === -1) return cols;
  const next = [...cols];
  next[idx] = { id: newId, locked: cols[idx].locked };
  return next;
}

/**
 * Lock moves slot to the left edge of the locked region (first-locked stays
 * rightmost as the pin anchor; newly-locked slots push in from the left).
 * Unlock moves slot to the right edge of the unlocked region.
 */
export function toggleLockSlot(cols: SessionSlot[], id: string): SessionSlot[] {
  const target = cols.find(c => c.id === id);
  if (!target) return cols;
  const rest = cols.filter(c => c.id !== id);
  const { unlocked, locked } = splitByLock(rest);
  return target.locked
    ? [...unlocked, { id, locked: false }, ...locked]
    : [...unlocked, { id, locked: true }, ...locked];
}
