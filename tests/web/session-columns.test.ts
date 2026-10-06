import { describe, it, expect } from 'vitest';
import {
  addSessionColumn,
  forceAddSessionColumn,
  toggleLockSlot,
  trimUnlockedToMax,
  panelBudget,
  fitRestoredColumns,
  removeSessionColumn,
  replaceSessionColumn,
  restoreSessionColumn,
  splitByLock,
  type SessionSlot,
} from '../../web/src/pages/sessionColumns';
import { MAX_PANELS } from '../../web/src/hooks/useSessionPanelMode';

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

  it('returns same reference (rejection signal) only when MAX_PANELS slots are locked', () => {
    // Below the hard ceiling a fully pinned strip GROWS instead (see the lock
    // grant block); the toast is reserved for the ceiling itself.
    const cols = Array.from({ length: MAX_PANELS }, (_, i) => slot(`L${i}`, true));
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

  it('triage + 1 locked filling the slots still opens the new id (lock grant)', () => {
    // maxColumns=2, triage open → effective max=1; the one slot is pinned, so the
    // strip grows by one beside the triage column instead of refusing.
    const cols = [slot('L', true)];
    const next = addSessionColumn(cols, 'new', true, 2);
    expect(next.map(s => s.id)).toEqual(['new', 'L']);
  });
});

// ── The lock grant: pins never block opening a session ─────────────────────────
//
// With 3 panels and all 3 locked, a pill click used to answer with a toast ("All
// session panels are locked") and nothing else. The budget now follows the pins:
// pins that fill the user's count get ONE free slot on top (never past
// MAX_PANELS). Only an OPEN reads it; the page then writes the new width into the
// setting, so every picker shows what is on screen and lowering it is the user's
// own pick (restores and count changes fit the setting, see fitRestoredColumns).

describe('sessionColumns: panelBudget', () => {
  it('is the plain max while a slot is free', () => {
    expect(panelBudget([slot('a', true), slot('b')], 3)).toBe(3);
    expect(panelBudget([], 3)).toBe(3);
  });

  it('grants ONE free slot when the pins fill the max', () => {
    expect(panelBudget([slot('a', true), slot('b', true), slot('c', true)], 3)).toBe(4);
  });

  it('follows pins that already exceed the max (count was lowered under them)', () => {
    // setting 2, 3 pins: the strip holds the 3 pins plus one free slot
    expect(panelBudget([slot('a', true), slot('b', true), slot('c', true)], 2)).toBe(4);
  });

  it('never grants past MAX_PANELS', () => {
    const pins = Array.from({ length: MAX_PANELS }, (_, i) => slot(`L${i}`, true));
    expect(panelBudget(pins, 3)).toBe(MAX_PANELS);
    expect(panelBudget(pins, MAX_PANELS)).toBe(MAX_PANELS);
  });

  it('a placeholder is not a pin and not a column', () => {
    // 2 pins + a draft at max 2: the draft rides free, the grant is for the pins
    expect(panelBudget([slot('draft:1-1'), slot('a', true), slot('b', true)], 2)).toBe(3);
    expect(panelBudget([slot('draft:1-1'), slot('a', true)], 2)).toBe(2);
  });

  it('grants nothing without a pin, even to a budget of zero', () => {
    // count 1 with triage open leaves 0 slots; an unpinned column is not a pin
    // that filled the budget, so triage still takes the slot and an open is refused.
    expect(panelBudget([slot('a')], 0)).toBe(0);
    expect(panelBudget([], 0)).toBe(0);
    expect(trimUnlockedToMax([slot('a')], panelBudget([slot('a')], 0))).toEqual([]);
    const cols = [slot('a')];
    expect(addSessionColumn(cols, 'new', true, 1)).toBe(cols);
  });
});

describe('sessionColumns: addSessionColumn with every slot pinned', () => {
  const pinned3 = () => [slot('A', true), slot('B', true), slot('C', true)];

  it('opens a 4th column instead of refusing, evicting nothing', () => {
    const next = addSessionColumn(pinned3(), 'D', false, 3);
    expect(next.map(s => s.id)).toEqual(['D', 'A', 'B', 'C']);
    expect(next.filter(s => s.locked)).toHaveLength(3);
  });

  it('the free slot is SHARED: the next open reuses it, one in one out', () => {
    const cols = [slot('D'), ...pinned3()];
    const next = addSessionColumn(cols, 'E', false, 3);
    expect(next.map(s => s.id)).toEqual(['E', 'A', 'B', 'C']);
  });

  it('closing a pin ends the grant: the next open evicts back to max', () => {
    // [D A* B* C*] → close B* → [D A* C*] (3 = max) → open E evicts D
    const cols = removeSessionColumn([slot('D'), ...pinned3()], 'B');
    expect(cols.map(s => s.id)).toEqual(['D', 'A', 'C']);
    const next = addSessionColumn(cols, 'E', false, 3);
    expect(next.map(s => s.id)).toEqual(['E', 'A', 'C']);
  });

  it('closing the free column leaves the pins; the next open is granted again', () => {
    const cols = removeSessionColumn([slot('D'), ...pinned3()], 'D');
    const next = addSessionColumn(cols, 'E', false, 3);
    expect(next.map(s => s.id)).toEqual(['E', 'A', 'B', 'C']);
  });

  it('unlocking never closes anything, and the first open after it evicts ONE, not two', () => {
    // [D A* B* C*] unlock A → [D A B* C*]: 4 columns over a budget of 3. The
    // strip is NOT trimmed here (nothing fires on a lock toggle), and the next
    // open must not make two panels vanish to catch up — one in, one out.
    const afterUnlock = toggleLockSlot([slot('D'), ...pinned3()], 'A');
    expect(afterUnlock.map(s => s.id)).toEqual(['D', 'A', 'B', 'C']);
    expect(panelBudget(afterUnlock, 3)).toBe(3);
    const next = addSessionColumn(afterUnlock, 'E', false, 3);
    expect(next.map(s => s.id)).toEqual(['E', 'D', 'B', 'C']);
  });

  it('a strip over budget shrinks when the user closes a column, then stays at max', () => {
    // [E D B* C*] (over by one after an unlock) → close D → [E B* C*] → open F evicts E
    const cols = removeSessionColumn([slot('E'), slot('D'), slot('B', true), slot('C', true)], 'D');
    const next = addSessionColumn(cols, 'F', false, 3);
    expect(next.map(s => s.id)).toEqual(['F', 'B', 'C']);
  });

  it('a draft beside the pins stays free; the granted column is for the session', () => {
    const next = addSessionColumn([slot('draft:1-1'), ...pinned3()], 'D', false, 3);
    expect(next.map(s => s.id)).toEqual(['draft:1-1', 'D', 'A', 'B', 'C']);
  });

  it('at MAX_PANELS pins the grant is gone and the open is refused', () => {
    const pins = Array.from({ length: MAX_PANELS }, (_, i) => slot(`L${i}`, true));
    expect(addSessionColumn(pins, 'new', false, MAX_PANELS)).toBe(pins);
  });

  it('existing-id moves are untouched by the grant', () => {
    const cols = pinned3();
    const next = addSessionColumn(cols, 'C', false, 3);
    expect(next.map(s => s.id)).toEqual(['C', 'A', 'B']);
  });
});

describe('sessionColumns: fitRestoredColumns', () => {
  it('fits the count, not the grant: a free column saved over a count the pins fill goes, the pins stay', () => {
    // A grant writes the count at once, so this strip only exists when that write
    // never landed or another tab lowered the count; the setting wins.
    const saved = [slot('D'), slot('A', true), slot('B', true), slot('C', true)];
    expect(fitRestoredColumns(saved, 3).map(s => s.id)).toEqual(['A', 'B', 'C']);
    expect(fitRestoredColumns(saved, 4)).toBe(saved);
  });

  it('trims a strip left over budget by an unlock, evicting from the right', () => {
    const saved = [slot('D'), slot('A'), slot('B', true), slot('C', true)];
    expect(fitRestoredColumns(saved, 3).map(s => s.id)).toEqual(['D', 'B', 'C']);
  });

  it('never cuts a pin the way the old positional slice did', () => {
    // slice(0, 2) on [u1 u2 L] kept u1 u2 and dropped the user's anchor
    const saved = [slot('u1'), slot('u2'), slot('L', true)];
    expect(fitRestoredColumns(saved, 2).map(s => s.id)).toEqual(['u1', 'L']);
  });

  it('is a plain truncation for an unlocked deep link', () => {
    const saved = [slot('a'), slot('b'), slot('c')];
    expect(fitRestoredColumns(saved, 2).map(s => s.id)).toEqual(['a', 'b']);
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

describe('sessionColumns: restoreSessionColumn (Undo of a completed task\'s column)', () => {
  const restore = (cols: SessionSlot[], s: SessionSlot, index: number, triage = false, max = 3) =>
    restoreSessionColumn(cols, s, index, triage, max);

  it('puts the column back at the index it had (middle of a strip of three)', () => {
    // [a b c] -> b closed -> [a c] -> Undo
    expect(restore([slot('a'), slot('c')], slot('b'), 1).map(s => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('puts the column back at either end', () => {
    expect(restore([slot('b'), slot('c')], slot('a'), 0).map(s => s.id)).toEqual(['a', 'b', 'c']);
    expect(restore([slot('a'), slot('b')], slot('c'), 2).map(s => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op (same reference) when the column is already open', () => {
    const cols = [slot('a'), slot('b')];
    expect(restore(cols, slot('b'), 0)).toBe(cols);
  });

  it('clamps an index past the end to the end of the unlocked region, before the pins', () => {
    const cols = [slot('a'), slot('p', true)];
    expect(restore(cols, slot('b'), 9, false, 3).map(s => s.id)).toEqual(['a', 'b', 'p']);
  });

  it('never goes in front of the drafts that are pinned to the far left', () => {
    const cols = [slot('draft:1'), slot('a')];
    expect(restore(cols, slot('b'), 0, false, 3).map(s => s.id)).toEqual(['draft:1', 'b', 'a']);
  });

  it('a pinned column comes back pinned, in its place among the pins', () => {
    // [a c* b*] -> c* closed -> [a b*] -> Undo
    expect(restore([slot('a'), slot('b', true)], slot('c', true), 1)).toEqual([slot('a'), slot('c', true), slot('b', true)]);
    // the anchor (rightmost pin) goes back to the far right
    expect(restore([slot('a'), slot('c', true)], slot('b', true), 2)).toEqual([slot('a'), slot('c', true), slot('b', true)]);
  });

  it('a pinned column never lands among the unlocked ones, an unlocked one never among the pins', () => {
    // the strip changed while the Undo was up: the saved index now points into the other region
    expect(restore([slot('a'), slot('x'), slot('p', true)], slot('b', true), 0, false, 5).map(s => s.id)).toEqual(['a', 'x', 'b', 'p']);
    expect(restore([slot('a'), slot('p', true), slot('q', true)], slot('b'), 3, false, 5).map(s => s.id)).toEqual(['a', 'b', 'p', 'q']);
  });

  it('a pinned column with no room left is opened like any column, then pinned again', () => {
    const out = restore([slot('x'), slot('y'), slot('z')], slot('b', true), 2, false, 3);
    expect(out).toHaveLength(3);
    expect(out.find(s => s.id === 'b')?.locked).toBe(true);
    expect(out[out.length - 1]).toEqual(slot('b', true));  // the left edge of the pins, which here is the end
    expect(out.map(s => s.id)).not.toContain('z');
  });

  it('an unlocked column comes back unlocked', () => {
    expect(restore([slot('a')], slot('b'), 1).find(s => s.id === 'b')?.locked).toBe(false);
  });

  it('with no room left it is a normal open: the budget evicts the rightmost unlocked column', () => {
    // the strip refilled to 3 while the Undo was on screen
    const cols = [slot('x'), slot('y'), slot('z')];
    const out = restore(cols, slot('b'), 1, false, 3).map(s => s.id);
    expect(out).toContain('b');
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('b'); // addSessionColumn opens leftmost
    expect(out).not.toContain('z');
  });

  it('respects the triage panel\'s slot in the budget', () => {
    // max 3 with triage open leaves 2 for sessions: already 2 open -> full
    const out = restore([slot('a'), slot('c')], slot('b'), 1, true, 3).map(s => s.id);
    expect(out).toHaveLength(2);
    expect(out).toContain('b');
  });

  it('uses the lock grant like an open does: every panel pinned still leaves one free slot, left of the pins', () => {
    const cols = [slot('p1', true), slot('p2', true), slot('p3', true)];
    expect(restore(cols, slot('b'), 0, false, 3).map(s => s.id)).toEqual(['b', 'p1', 'p2', 'p3']);
  });

  it('is unchanged (same reference) at the hard ceiling of pinned panels', () => {
    const cols = Array.from({ length: MAX_PANELS }, (_, i) => slot(`p${i}`, true));
    expect(restore(cols, slot('b'), 0, false, MAX_PANELS)).toBe(cols);
    expect(restore(cols, slot('b', true), 2, false, MAX_PANELS)).toBe(cols);
  });
});
