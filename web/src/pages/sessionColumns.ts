// Pure helpers for the home-page SessionPanel column queue.
// Extracted from MainPage.tsx so they can be unit-tested without React.
//
// Layout invariant:
//   [ drafts ... ][ unlocked ... ][ newly-locked ... first-locked ]
//    ↑ far left                                ↑ rightmost = pin anchor
//
// DRAFT columns are pinned to the FAR LEFT and stay there: a draft is "extra"
// by design (outside the panel budget, see trimUnlockedToMax) and must not
// interact with the real strip at all — so a real session opening must slide
// in BESIDE it, never push it out of its corner. Then unlocked real slots;
// locked slots occupy the right. Within the locked region, the FIRST slot the
// user locked sits rightmost (acts as a visual anchor), and subsequently-locked
// slots slide in from the left edge of the locked region. Unlock symmetrically
// drops the slot at the right edge of the unlocked region, next to the boundary
// the user just crossed.

import { isDraftColumnId, isPlaceholderColumnId } from '@/utils/column-ids';
import { MAX_PANELS } from '@/hooks/session-panel-limits';

export interface SessionSlot {
  id: string;
  locked: boolean;
}

/** Real (budget-counting) columns: everything but the free-riding placeholders. */
function realColumns(cols: SessionSlot[]): SessionSlot[] {
  return cols.filter(c => !isPlaceholderColumnId(c.id));
}

/** How many columns count against the budget right now. */
export function realColumnCount(cols: SessionSlot[]): number {
  return realColumns(cols).length;
}

/**
 * The column budget an OPEN gets right now.
 *
 * `max` (the user's panel count) unless the pins alone fill it: then the budget is
 * the pins plus ONE free slot, never past MAX_PANELS. A pin means "keep this panel",
 * not "stop opening sessions" — with every budgeted slot locked, a pill click used
 * to answer with a toast and nothing else, so the strip grows by one for the next
 * session instead. Only `addSessionColumn` reads this: when an open uses the grant,
 * the caller (MainPage) writes the new width into the panel-count setting at once,
 * so every picker shows the number of panels on screen and the strip is back to
 * "size = setting" (2026-10-02: a strip of 3 under a picker saying "2" was confusing).
 * Going back down is the user's own pick; restores and count changes fit the setting,
 * never this grant. The free slot is shared, not cumulative — under a count the pins
 * fill, the next open reuses it (one in, one out) rather than growing again.
 */
export function panelBudget(cols: SessionSlot[], max: number): number {
  const locked = realColumns(cols).filter(c => c.locked).length;
  // Pins only: a budget of 0 with nothing pinned (triage holding the one slot of
  // a 1-panel strip) stays 0, it is not a strip the pins filled.
  if (locked === 0 || locked < max) return max;
  return Math.min(Math.max(max, locked + 1), MAX_PANELS);
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

/** Partition the unlocked region into the draft prefix (pinned far left) and
 *  the rest (real + pending slots). Drafts are never locked (a draft panel has
 *  no lock control), so partitioning only the unlocked half is complete. */
function splitDrafts(unlocked: SessionSlot[]): { drafts: SessionSlot[]; rest: SessionSlot[] } {
  const drafts: SessionSlot[] = [];
  const rest: SessionSlot[] = [];
  for (const c of unlocked) (isDraftColumnId(c.id) ? drafts : rest).push(c);
  return { drafts, rest };
}

/** Where a slot lands on insert/move: a draft goes to the FAR LEFT (before
 *  other drafts — it's the one just asked for); anything else goes leftmost
 *  of the REAL region, i.e. right after the draft prefix, so opening a session
 *  never bumps a draft out of its corner. */
function insertLeftmost(id: string, unlocked: SessionSlot[], locked: SessionSlot[]): SessionSlot[] {
  const slot = { id, locked: false };
  if (isDraftColumnId(id)) return [slot, ...unlocked, ...locked];
  const { drafts, rest } = splitDrafts(unlocked);
  return [...drafts, slot, ...rest, ...locked];
}

/**
 * Shrink the REAL columns to `max` by dropping evictable slots from the RIGHT,
 * leaving every surviving slot exactly where it was.
 *
 * PLACEHOLDERS (`draft:`/`pending:`) ARE EXTRA — outside the budget entirely:
 * they neither count toward `max` nor get evicted, and their presence must not
 * change what happens to the real columns by one pixel. The column IS their
 * state (a draft holds unsent text, a pending column an in-flight launch), so
 * they can't be evicted; and if they CONSUMED budget, opening a session while a
 * draft was up would evict one more real panel than the same click without it
 * (shipped bug: max=3 + draft, open a session → TWO live panels vanished).
 * "现有的就是现有的逻辑…draft 是单独额外的,不去争抢" — the real strip behaves
 * exactly as if the placeholder weren't there. The extra column self-expires:
 * pending→real makes it count (and be evictable), and the next trim resolves
 * the strip; a closed draft just leaves.
 *
 * Among the real columns, LOCKED slots are still exempt — visible overflow is
 * preferred over evicting a user's pin — so when locked alone exceed `max` this
 * drops every evictable slot and still overflows.
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
  // The budget applies to REAL columns only — placeholders ride for free.
  const real = realColumns(cols);
  if (real.length <= max) return cols;
  let toDrop = real.length - Math.max(max, real.filter(c => c.locked).length);
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
 * Returns `cols` unchanged (reference-equal) iff `id` is new and the pins leave no
 * slot even after the lock grant (MAX_PANELS columns locked) — callers use
 * `next === prev` to detect this rejection path and show a toast. Any other case
 * yields a new array.
 *
 * An open evicts AT MOST ONE real column. The trim target is the budget or the
 * strip's current size, whichever is larger: a strip can legitimately sit above
 * the budget (the lock grant was used, then a pin was released — unlocking never
 * closes anything), and the first click after that must not make two panels
 * vanish to catch up. It shrinks when the user closes a column, which is also
 * the one answer to "how do I get back to N": close one.
 */
export function addSessionColumn(cols: SessionSlot[], id: string, triageOpen: boolean, maxColumns: number): SessionSlot[] {
  const max = panelBudget(cols, triageOpen ? maxColumns - 1 : maxColumns);
  const existing = cols.find(c => c.id === id);
  if (existing) {
    const filtered = cols.filter(c => c.id !== id);
    const { unlocked, locked } = splitByLock(filtered);
    // Locked branch re-uses the existing object reference on purpose — preserves
    // React key+memo identity so the locked panel's subtree doesn't remount
    // when the user clicks its pill. Unlocked branch constructs fresh because
    // the slot is moving to leftmost (of the real region — drafts stay put);
    // no stability benefit worth the branch cost.
    return existing.locked
      ? [...unlocked, existing, ...locked]     // locked: left edge of locked region
      : insertLeftmost(id, unlocked, locked);  // unlocked: leftmost of its region
  }
  const { unlocked, locked } = splitByLock(cols);
  if (locked.length >= max) return cols; // every slot pinned, no grant left — caller shows toast
  const target = Math.max(max, realColumns(cols).length);
  return trimUnlockedToMax(insertLeftmost(id, unlocked, locked), target);
}

/**
 * Fit a RESTORED strip (sessionStorage, a deep link) to the panel count. Replaces the
 * old `slice(0, max)`: a positional cut ignored locks, so with the pins on the right
 * it kept the free column and dropped the user's anchor. Pins are never cut; a free
 * column saved over the count (the count was lowered in another tab, or the write
 * that should have followed a grant never landed) is what goes.
 */
export function fitRestoredColumns(cols: SessionSlot[], max: number): SessionSlot[] {
  return trimUnlockedToMax(cols, max);
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
    // identity — see addSessionColumn); unlocked moves to its region's leftmost.
    return existing.locked
      ? [...unlocked, existing, ...locked]
      : insertLeftmost(id, unlocked, locked);
  }
  const { unlocked, locked } = splitByLock(cols);
  return insertLeftmost(id, unlocked, locked);
}

export function removeSessionColumn(cols: SessionSlot[], id: string): SessionSlot[] {
  return cols.filter(c => c.id !== id);
}

/**
 * Put back a column the person just watched leave (the Undo of a completed task's
 * column), in the place it had: `index` is where it sat in the strip, clamped into the
 * unlocked region so the drafts-first / pins-last layout still holds.
 *
 * Already open: unchanged. No room left under the person's panel COUNT (another open took
 * the slot while the Undo was on screen, or every panel is pinned): it comes back as a
 * normal open, so the budget rules decide who yields or whether the lock grant applies,
 * never a strip past the panel count without the count following (the caller does that).
 */
export function restoreSessionColumn(
  cols: SessionSlot[],
  slot: SessionSlot,
  index: number,
  triageOpen: boolean,
  maxColumns: number,
): SessionSlot[] {
  if (cols.some(c => c.id === slot.id)) return cols;
  const count = triageOpen ? maxColumns - 1 : maxColumns;
  if (realColumns(cols).length >= count) return addSessionColumn(cols, slot.id, triageOpen, maxColumns);
  const { unlocked } = splitByLock(cols);
  const draftPrefix = splitDrafts(unlocked).drafts.length;
  const at = Math.min(Math.max(index, draftPrefix), unlocked.length);
  return [...cols.slice(0, at), { id: slot.id, locked: false }, ...cols.slice(at)];
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
