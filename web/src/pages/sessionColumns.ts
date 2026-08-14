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

import { isPlaceholderColumnId } from '@/utils/column-ids';

export interface SessionSlot {
  id: string;
  locked: boolean;
}

/** Slots the trim may never evict: user-pinned, or a placeholder mid-flight
 *  (`draft:`/`pending:`) whose column holds state that lives nowhere else. */
function trimExempt(slot: SessionSlot): boolean {
  return slot.locked || isPlaceholderColumnId(slot.id);
}

export function splitByLock(cols: SessionSlot[]): { unlocked: SessionSlot[]; locked: SessionSlot[] } {
  const unlocked: SessionSlot[] = [];
  const locked: SessionSlot[] = [];
  for (const c of cols) (c.locked ? locked : unlocked).push(c);
  return { unlocked, locked };
}

/**
 * Shrink to `max` total columns by dropping evictable slots from the RIGHT, and
 * leaving every surviving slot exactly where it was.
 *
 * Two kinds of slot are exempt and can push the total past `max`:
 *   - LOCKED — visible overflow is preferred over evicting a user's pin.
 *   - PLACEHOLDER (`draft:`/`pending:`) — the column IS the state. A draft holds
 *     the user's unsent text; a pending column holds an in-flight launch whose
 *     only handle is that id. Trimming either destroys data the user cannot get
 *     back (this also fixes the pre-existing "pending column evicted mid-HTTP"
 *     bug: the launch completed into a column that no longer existed).
 * The overflow license is self-expiring — a placeholder becomes a real id (or is
 * closed), which makes it evictable again and the next trim resolves the strip.
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
  // How many slots must go. Exempt ones are never candidates, so when they alone
  // exceed `max` this drops every evictable slot and still overflows.
  let toDrop = cols.length - Math.max(max, cols.filter(trimExempt).length);
  if (toDrop <= 0) return cols;
  const doomed = new Set<SessionSlot>();
  for (let i = cols.length - 1; i >= 0 && toDrop > 0; i--) {
    if (trimExempt(cols[i])) continue;
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

/**
 * Unconditional leftmost insert — the "overflow license".
 *
 * Contract, and every clause of it is deliberate: NO max check, NO trim, NO
 * all-locked rejection. The user pressed "+"; a new column MUST appear, even
 * when every panel is locked and the strip is already at max. Overflow is the
 * accepted cost (hard requirement of the one-verb-"New" design) and it expires
 * on its own: the inserted id is a placeholder, so it's trim-exempt only while
 * it stays one — the moment it becomes a real session (or is closed) the normal
 * eviction rules apply and the strip shrinks back.
 *
 * Never returns `cols` reference-equal for a NEW id, so callers must not read a
 * same-reference result as a rejection signal (unlike `addSessionColumn`, this
 * function has no rejection path). An id already in the strip is moved rather
 * than duplicated, matching `addSessionColumn`'s existing-id behavior.
 */
export function forceAddSessionColumn(cols: SessionSlot[], id: string): SessionSlot[] {
  const existing = cols.find(c => c.id === id);
  if (existing) {
    const filtered = cols.filter(c => c.id !== id);
    const { unlocked, locked } = splitByLock(filtered);
    // Locked branch re-uses the existing object reference (React key+memo
    // identity — see addSessionColumn); unlocked moves to leftmost.
    return existing.locked
      ? [...unlocked, existing, ...locked]
      : [{ id, locked: false }, ...unlocked, ...locked];
  }
  const { unlocked, locked } = splitByLock(cols);
  return [{ id, locked: false }, ...unlocked, ...locked];
}

export function removeSessionColumn(cols: SessionSlot[], id: string): SessionSlot[] {
  return cols.filter(c => c.id !== id);
}

export function replaceSessionColumn(cols: SessionSlot[], oldId: string, newId: string): SessionSlot[] {
  const idx = cols.findIndex(c => c.id === oldId);
  if (idx === -1) return cols;
  if (oldId === newId) return cols;
  // newId may already occupy another slot — e.g. a column opened from a deep link
  // with a truncated id adopts its canonical id while the full id is already open.
  // A blind overwrite would leave two slots with the same id (duplicate React keys
  // and two panels streaming one session), so collapse into one slot instead,
  // keeping the target position and locking if either slot was locked.
  const existing = cols.findIndex(c => c.id === newId);
  if (existing !== -1) {
    const locked = cols[existing].locked || cols[idx].locked;
    return cols
      .filter((_, i) => i !== idx)
      .map(c => (c.id === newId ? { id: newId, locked } : c));
  }
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
