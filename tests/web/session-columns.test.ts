import { describe, it, expect } from 'vitest';
import {
  addSessionColumn,
  toggleLockSlot,
  trimUnlockedToMax,
  removeSessionColumn,
  replaceSessionColumn,
  splitByLock,
  type SessionSlot,
} from '../../web/src/pages/sessionColumns';

const slot = (id: string, locked = false): SessionSlot => ({ id, locked });

describe('sessionColumns: splitByLock', () => {
  it('partitions preserving relative order', () => {
    const cols = [slot('a'), slot('b', true), slot('c'), slot('d', true)];
    const { unlocked, locked } = splitByLock(cols);
    expect(unlocked.map(s => s.id)).toEqual(['a', 'c']);
    expect(locked.map(s => s.id)).toEqual(['b', 'd']);
  });
});

describe('sessionColumns: trimUnlockedToMax', () => {
  it('no-op when under max', () => {
    const cols = [slot('a'), slot('b')];
    expect(trimUnlockedToMax(cols, 2)).toBe(cols);
  });

  it('drops unlocked from the right when over max', () => {
    const cols = [slot('a'), slot('b'), slot('c')];
    expect(trimUnlockedToMax(cols, 2).map(s => s.id)).toEqual(['a', 'b']);
  });

  it('keeps locked slots even if that forces overflow', () => {
    // 3 locked, max=2 → locked exempt, all 3 kept (visible overflow > evicting user pin)
    const cols = [slot('a', true), slot('b', true), slot('c', true)];
    expect(trimUnlockedToMax(cols, 2).map(s => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('evicts unlocked first when mixed', () => {
    // [u1, u2, L] max=2 → keep 1 unlocked + 1 locked = [u1, L]
    const cols = [slot('u1'), slot('u2'), slot('L', true)];
    expect(trimUnlockedToMax(cols, 2).map(s => s.id)).toEqual(['u1', 'L']);
  });

  // ── Regressions: a shrink must ONLY remove the rightmost unlocked slot(s). ──
  // Both cases below reported as "a random panel disappeared" on a 3→2 change.
  // Root cause was rebuilding the strip as [...unlocked.slice(0, keep), ...locked],
  // which reorders by lock state and counts within the partitioned run instead of
  // along the visual row.

  it('never REORDERS survivors — a locked slot on the left stays on the left', () => {
    // [L, u1, u2] max=2. Old code returned [u1, L]: the pinned column jumped from
    // leftmost to rightmost during an unrelated count change.
    const cols = [slot('L', true), slot('u1'), slot('u2')];
    expect(trimUnlockedToMax(cols, 2).map(s => s.id)).toEqual(['L', 'u1']);
  });

  it('evicts the rightmost UNLOCKED slot, skipping over a locked one', () => {
    // [u1, u2, L] — already covered above — and the harder shape: the rightmost
    // slot is locked, so the rightmost *unlocked* (u2) is what goes, even though
    // it sits in the middle of the row.
    const cols = [slot('u1'), slot('u2'), slot('L', true)];
    const out = trimUnlockedToMax(cols, 2);
    expect(out.map(s => s.id)).toEqual(['u1', 'L']);
    // Position of every survivor is unchanged relative to each other.
    expect(out.map(s => s.id)).toEqual(cols.filter(c => out.includes(c)).map(s => s.id));
  });

  it('drops several from the right at once, right-to-left', () => {
    // 5 → 2 in one step (e.g. picking "2" while five panels are open).
    const cols = [slot('a'), slot('b'), slot('c'), slot('d'), slot('e')];
    expect(trimUnlockedToMax(cols, 2).map(s => s.id)).toEqual(['a', 'b']);
  });

  it('keeps every locked slot and sheds only the unlocked when locks exceed max', () => {
    // [L1, u, L2, L3] max=2 → all 3 locks survive (overflow allowed), u is dropped.
    const cols = [slot('L1', true), slot('u'), slot('L2', true), slot('L3', true)];
    expect(trimUnlockedToMax(cols, 2).map(s => s.id)).toEqual(['L1', 'L2', 'L3']);
  });

  it('returns the same array reference when nothing can be dropped', () => {
    // All locked and over max — callers compare by reference to detect "no change".
    const cols = [slot('a', true), slot('b', true), slot('c', true)];
    expect(trimUnlockedToMax(cols, 2)).toBe(cols);
  });
});

describe('sessionColumns: addSessionColumn', () => {
  it('inserts new id at leftmost when a slot is available', () => {
    const cols = [slot('existing')];
    const next = addSessionColumn(cols, 'new', false, 2);
    expect(next.map(s => s.id)).toEqual(['new', 'existing']);
    expect(next[0].locked).toBe(false);
  });

  it('evicts rightmost unlocked when full', () => {
    const cols = [slot('oldLeft'), slot('oldRight')];
    const next = addSessionColumn(cols, 'new', false, 2);
    expect(next.map(s => s.id)).toEqual(['new', 'oldLeft']);
  });

  it('preserves locked anchor when evicting', () => {
    // [U, L] full, open new → unlocked evicted, locked stays rightmost
    const cols = [slot('U'), slot('L', true)];
    const next = addSessionColumn(cols, 'new', false, 2);
    expect(next.map(s => ({ id: s.id, locked: s.locked }))).toEqual([
      { id: 'new', locked: false },
      { id: 'L', locked: true },
    ]);
  });

  it('returns same reference (rejection signal) when all slots locked', () => {
    const cols = [slot('a', true), slot('b', true)];
    const next = addSessionColumn(cols, 'new', false, 2);
    expect(next).toBe(cols); // reference equality = reject signal for caller toast
  });

  it('does NOT reject when id already exists even if all locked', () => {
    // Clicking pill for an already-open locked session should still work
    const cols = [slot('a', true), slot('b', true)];
    const next = addSessionColumn(cols, 'a', false, 2);
    expect(next).not.toBe(cols);
    expect(next.length).toBe(2);
    expect(next.find(s => s.id === 'a')?.locked).toBe(true);
  });

  it('moves existing unlocked id to leftmost', () => {
    const cols = [slot('a'), slot('b'), slot('c', true)];
    const next = addSessionColumn(cols, 'b', false, 3);
    expect(next.map(s => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('moves existing locked id to left edge of locked region', () => {
    // [u, L1, L2] click L2's pill → L2 moves to left edge of locked = [u, L2, L1]
    const cols = [slot('u'), slot('L1', true), slot('L2', true)];
    const next = addSessionColumn(cols, 'L2', false, 3);
    expect(next.map(s => ({ id: s.id, locked: s.locked }))).toEqual([
      { id: 'u', locked: false },
      { id: 'L2', locked: true },
      { id: 'L1', locked: true },
    ]);
  });

  it('honors triage-open reducing max by 1', () => {
    // maxColumns=2, triage open → effective max=1
    // [a] + new 'b' with triage open → should evict a (unlocked) and keep b
    const cols = [slot('a')];
    const next = addSessionColumn(cols, 'b', true, 2);
    expect(next.map(s => s.id)).toEqual(['b']);
  });

  it('rejects new id when triage + 1 locked fills the slots', () => {
    // maxColumns=2, triage open → effective max=1; already 1 locked → reject
    const cols = [slot('L', true)];
    const next = addSessionColumn(cols, 'new', true, 2);
    expect(next).toBe(cols);
  });
});

describe('sessionColumns: toggleLockSlot', () => {
  it('locking moves slot to LEFT edge of locked region (anchor preserved)', () => {
    // [U1, U2, L-anchor] lock U2 → U2 goes to left of locked, anchor stays rightmost
    const cols = [slot('U1'), slot('U2'), slot('anchor', true)];
    const next = toggleLockSlot(cols, 'U2');
    expect(next.map(s => ({ id: s.id, locked: s.locked }))).toEqual([
      { id: 'U1', locked: false },
      { id: 'U2', locked: true },
      { id: 'anchor', locked: true },
    ]);
  });

  it('unlocking moves slot to RIGHT edge of unlocked region (boundary anchored)', () => {
    // [U, L1, L2] unlock L1 → L1 becomes unlocked and sits just before the locked region
    const cols = [slot('U'), slot('L1', true), slot('L2', true)];
    const next = toggleLockSlot(cols, 'L1');
    expect(next.map(s => ({ id: s.id, locked: s.locked }))).toEqual([
      { id: 'U', locked: false },
      { id: 'L1', locked: false },
      { id: 'L2', locked: true },
    ]);
  });

  it('locking the only unlocked slot leaves locked region ordered correctly', () => {
    const cols = [slot('U'), slot('L1', true)];
    const next = toggleLockSlot(cols, 'U');
    expect(next.map(s => ({ id: s.id, locked: s.locked }))).toEqual([
      { id: 'U', locked: true },
      { id: 'L1', locked: true },
    ]);
  });

  it('is a no-op for unknown id', () => {
    const cols = [slot('a'), slot('b', true)];
    expect(toggleLockSlot(cols, 'nope')).toBe(cols);
  });
});

describe('sessionColumns: removeSessionColumn / replaceSessionColumn', () => {
  it('remove filters by id', () => {
    const cols = [slot('a'), slot('b', true)];
    expect(removeSessionColumn(cols, 'a').map(s => s.id)).toEqual(['b']);
  });

  it('replace preserves lock state at same position', () => {
    const cols = [slot('a'), slot('b', true)];
    const next = replaceSessionColumn(cols, 'b', 'c');
    expect(next.map(s => ({ id: s.id, locked: s.locked }))).toEqual([
      { id: 'a', locked: false },
      { id: 'c', locked: true },
    ]);
  });

  it('replace is a no-op when oldId missing', () => {
    const cols = [slot('a')];
    expect(replaceSessionColumn(cols, 'missing', 'new')).toBe(cols);
  });
});
