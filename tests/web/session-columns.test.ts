import { describe, it, expect } from 'vitest';
import {
  addSessionColumn,
  forceAddSessionColumn,
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

  // ── Placeholder columns (draft:/pending:) are EXTRA — outside the budget. ──
  // They neither count toward `max` nor get evicted, and the real columns behave
  // exactly as if the placeholder weren't there. When they consumed budget,
  // opening a session while a draft was up evicted one more live panel than the
  // same click without it (shipped bug: max=3 + draft → open session → TWO real
  // panels vanished). The column IS their state (unsent text / in-flight
  // launch), which is why they can't be evicted either.

  it('a placeholder is never evicted and never costs a real column its slot', () => {
    // [a, pending] max=1: the pending column is free, `a` is within budget —
    // nothing to trim. (The old budget-consuming semantics evicted `a` here.)
    const cols = [slot('a'), slot('pending:temp-1')];
    expect(trimUnlockedToMax(cols, 1)).toBe(cols);
  });

  it('placeholders alone never trigger a trim', () => {
    const cols = [slot('pending:temp-1'), slot('draft:1-1')];
    expect(trimUnlockedToMax(cols, 1)).toBe(cols);
  });

  it('keeps a draft next to a locked column with max=1 (draft free, lock within budget)', () => {
    const cols = [slot('draft:1-1'), slot('L', true)];
    expect(trimUnlockedToMax(cols, 1)).toBe(cols);
  });

  it('real columns trim among themselves; interleaved placeholders ride along', () => {
    // Two real columns over a max of 1: the rightmost real one goes, both
    // placeholders stay, order preserved.
    const cols = [slot('draft:1-1'), slot('a'), slot('pending:temp-1'), slot('b')];
    expect(trimUnlockedToMax(cols, 1).map(s => s.id)).toEqual(['draft:1-1', 'a', 'pending:temp-1']);
  });

  it('a draft does NOT shield real neighbours once REAL columns exceed max', () => {
    // [A, draft, B] max=1 → one real column too many; the draft grants no
    // amnesty: the rightmost evictable real slot (B) goes. Getting this wrong
    // ("any placeholder ⇒ skip the trim") would let the strip grow without
    // bound every time the user opened a draft.
    const cols = [slot('A'), slot('draft:1-1'), slot('B')];
    expect(trimUnlockedToMax(cols, 1).map(s => s.id)).toEqual(['A', 'draft:1-1']);
  });

  it('opening a session beside a draft evicts exactly ONE real panel — the draft costs nothing', () => {
    // THE reported bug, as a regression pin: max=3, three real panels + a
    // draft. A new session arrives (inserted right of the draft prefix) → only
    // C (rightmost real) may go. The old semantics evicted B AND C ("第三个
    // window 被 draft 直接给覆盖了,然后我新点的也没出来").
    const cols = [slot('draft:1-1'), slot('new'), slot('A'), slot('B'), slot('C')];
    expect(trimUnlockedToMax(cols, 3).map(s => s.id)).toEqual(['draft:1-1', 'new', 'A', 'B']);
  });

  it('the overflow license expires when the placeholder becomes real', () => {
    // draft → pending keeps the exemption (still a placeholder, count unchanged);
    // pending → real id makes the column evictable again and the next trim
    // resolves the overflow. This is the "after send… normal rules" contract.
    const withDraft = [slot('draft:1-1'), slot('L1', true), slot('L2', true)];
    expect(trimUnlockedToMax(withDraft, 2)).toBe(withDraft);
    const promoted = replaceSessionColumn(withDraft, 'draft:1-1', 'pending:temp-1');
    expect(trimUnlockedToMax(promoted, 2)).toBe(promoted);
    const real = replaceSessionColumn(promoted, 'pending:temp-1', 'sess-real');
    expect(trimUnlockedToMax(real, 2).map(s => s.id)).toEqual(['L1', 'L2']);
  });
});

describe('sessionColumns: forceAddSessionColumn', () => {
  it('inserts leftmost on an empty strip', () => {
    const next = forceAddSessionColumn([], 'draft:1-1');
    expect(next.map(s => ({ id: s.id, locked: s.locked }))).toEqual([
      { id: 'draft:1-1', locked: false },
    ]);
  });

  it('adds even when every slot is locked (no rejection path)', () => {
    // addSessionColumn signals rejection by reference equality; force must NOT —
    // the "+" button has to produce a column unconditionally.
    const cols = [slot('a', true), slot('b', true)];
    const next = forceAddSessionColumn(cols, 'draft:1-1');
    expect(next).not.toBe(cols);
    expect(next.map(s => s.id)).toEqual(['draft:1-1', 'a', 'b']);
    expect(next[0].locked).toBe(false);
  });

  it('adds when already at/over max — overflow is accepted, nothing is trimmed', () => {
    const cols = [slot('a'), slot('b')]; // max would be 2
    const next = forceAddSessionColumn(cols, 'draft:1-1');
    expect(next.map(s => s.id)).toEqual(['draft:1-1', 'a', 'b']);
  });

  it('locked-and-at-max together still yields the new column', () => {
    const cols = [slot('L1', true), slot('u'), slot('L2', true)];
    const next = forceAddSessionColumn(cols, 'draft:1-1');
    // Insert is leftmost and lock partitioning is respected (unlocked left of locked).
    expect(next.map(s => ({ id: s.id, locked: s.locked }))).toEqual([
      { id: 'draft:1-1', locked: false },
      { id: 'u', locked: false },
      { id: 'L1', locked: true },
      { id: 'L2', locked: true },
    ]);
  });

  it('is idempotent for an existing unlocked id — moves it leftmost, no duplicate', () => {
    const cols = [slot('a'), slot('b'), slot('c', true)];
    const next = forceAddSessionColumn(cols, 'b');
    expect(next.map(s => s.id)).toEqual(['b', 'a', 'c']);
    expect(next.filter(s => s.id === 'b')).toHaveLength(1);
  });

  it('is idempotent for an existing locked id and keeps its object identity', () => {
    // Same trick as addSessionColumn: re-using the slot object preserves React
    // key+memo identity so the locked panel's subtree does not remount.
    const locked = slot('L2', true);
    const cols = [slot('u'), slot('L1', true), locked];
    const next = forceAddSessionColumn(cols, 'L2');
    expect(next.map(s => ({ id: s.id, locked: s.locked }))).toEqual([
      { id: 'u', locked: false },
      { id: 'L2', locked: true },
      { id: 'L1', locked: true },
    ]);
    expect(next[1]).toBe(locked);
  });

  it('repeated force-adds of the same draft id do not stack columns', () => {
    let cols = forceAddSessionColumn([slot('a')], 'draft:1-1');
    cols = forceAddSessionColumn(cols, 'draft:1-1');
    expect(cols.map(s => s.id)).toEqual(['draft:1-1', 'a']);
  });

  // ── Drafts are pinned FAR LEFT — a real insert lands BESIDE them, never
  // in front ("draft 的 location 应该一直是在最左边,不和其他发生反应"). ──

  it('a real (pending:) insert lands to the RIGHT of an open draft', () => {
    // Quick-start's fallback insert path: the draft must not be displaced.
    const cols = [slot('draft:1-1'), slot('a')];
    const next = forceAddSessionColumn(cols, 'pending:temp-1');
    expect(next.map(s => s.id)).toEqual(['draft:1-1', 'pending:temp-1', 'a']);
  });

  it('a second draft still opens at the absolute leftmost', () => {
    const cols = [slot('draft:1-1'), slot('a')];
    const next = forceAddSessionColumn(cols, 'draft:2-2');
    expect(next.map(s => s.id)).toEqual(['draft:2-2', 'draft:1-1', 'a']);
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

  // ── Draft pinned far left: session opens slide in beside it. ──

  it('a new session opens to the RIGHT of the draft, which keeps its corner', () => {
    // The user's rule: the draft "一直是在最左边,不和其他发生反应". Before this,
    // every open pushed the draft to position 2 — visually the composer the user
    // was typing into jumped sideways.
    const cols = [slot('draft:1-1'), slot('existing')];
    const next = addSessionColumn(cols, 'new', false, 3);
    expect(next.map(s => s.id)).toEqual(['draft:1-1', 'new', 'existing']);
  });

  it('moving an existing session to front also stops at the draft boundary', () => {
    // Clicking an open session's pill re-fronts it — within the REAL region only.
    const cols = [slot('draft:1-1'), slot('a'), slot('b')];
    const next = addSessionColumn(cols, 'b', false, 3);
    expect(next.map(s => s.id)).toEqual(['draft:1-1', 'b', 'a']);
  });

  it('eviction beside a draft keeps the draft leftmost and drops the rightmost real', () => {
    // max=2 real, strip full: the insert lands right of the draft, the trim
    // takes the rightmost real column, the draft never moves.
    const cols = [slot('draft:1-1'), slot('a'), slot('b')];
    const next = addSessionColumn(cols, 'new', false, 2);
    expect(next.map(s => s.id)).toEqual(['draft:1-1', 'new', 'a']);
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

  it('draft: → pending: morphs in place, preserving index AND lock', () => {
    // 「开始」swaps the id under the column instead of removing + re-adding, so the
    // draft does not visibly jump across the strip on send. A locked draft (the
    // user pinned the empty column) must stay locked and stay where it is.
    const cols = [slot('a'), slot('draft:1-1', true), slot('b')];
    const next = replaceSessionColumn(cols, 'draft:1-1', 'pending:temp-1');
    expect(next.map(s => ({ id: s.id, locked: s.locked }))).toEqual([
      { id: 'a', locked: false },
      { id: 'pending:temp-1', locked: true },
      { id: 'b', locked: false },
    ]);
  });

  it('draft: → pending: keeps an unlocked draft unlocked at its index', () => {
    const cols = [slot('draft:1-1'), slot('a', true)];
    const next = replaceSessionColumn(cols, 'draft:1-1', 'pending:temp-1');
    expect(next.map(s => ({ id: s.id, locked: s.locked }))).toEqual([
      { id: 'pending:temp-1', locked: false },
      { id: 'a', locked: true },
    ]);
  });

  it('replace is a no-op when oldId === newId', () => {
    const cols = [slot('a'), slot('b')];
    expect(replaceSessionColumn(cols, 'b', 'b')).toBe(cols);
  });

  // A column opened from a deep link with a truncated id adopts its canonical id
  // while the full id may already be open. Overwriting blindly left two slots with
  // the same id — duplicate React keys and two panels streaming one session.
  it('replace collapses into the existing slot when newId is already open', () => {
    const cols = [slot('full'), slot('prefix')];
    const next = replaceSessionColumn(cols, 'prefix', 'full');
    expect(next.map(s => s.id)).toEqual(['full']);
  });

  it('replace keeps the lock when either collapsed slot was locked', () => {
    expect(replaceSessionColumn([slot('full'), slot('prefix', true)], 'prefix', 'full')[0].locked).toBe(true);
    expect(replaceSessionColumn([slot('full', true), slot('prefix')], 'prefix', 'full')[0].locked).toBe(true);
    expect(replaceSessionColumn([slot('full'), slot('prefix')], 'prefix', 'full')[0].locked).toBe(false);
  });
});
