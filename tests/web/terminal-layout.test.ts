/**
 * The layout of a session's terminals (web/src/components/sessions/terminal-layout.ts):
 * tabs, split panes, which slot a new terminal takes, what closing one leaves on
 * screen, and how the layout meets the terminals the host still runs after a
 * reload, a server restart or another device's changes.
 */
import { describe, it, expect } from 'vitest';
import {
  initialLayout, addTab, splitActive, removeSlot, focusSlot, activateTab, reconcileLayout,
  parseLayout, focusedSlot, freeSlot, allSlots, canSplit, paneRects, MAX_PANES_PER_TAB,
} from '@/components/sessions/terminal-layout';
import { MAX_TERMINAL_SLOTS } from '@open-walnut/terminal-key';

describe('terminal layout', () => {
  it('starts with one terminal in slot 1', () => {
    const l = initialLayout();
    expect(allSlots(l)).toEqual([1]);
    expect(focusedSlot(l)).toBe(1);
  });

  it('a new tab takes the lowest free slot and is shown', () => {
    let l = addTab(initialLayout());
    expect(allSlots(l)).toEqual([1, 2]);
    expect(focusedSlot(l)).toBe(2);
    l = addTab(l);
    l = removeSlot(l, 2);
    l = addTab(l);
    expect(allSlots(l)).toEqual([1, 3, 2]);
    expect(focusedSlot(l)).toBe(2);
  });

  it('never takes more than the slots there are', () => {
    let l = initialLayout();
    for (let i = 0; i < 20; i++) l = addTab(l);
    expect(allSlots(l)).toHaveLength(MAX_TERMINAL_SLOTS);
    expect(freeSlot(l)).toBeNull();
    expect(addTab(l)).toBe(l);
    expect(splitActive(l, 'row')).toBe(l);
  });

  it('a split puts a new pane right after the focused one, focused, in the direction asked', () => {
    let l = splitActive(initialLayout(), 'row');
    expect(l.tabs).toHaveLength(1);
    expect(l.tabs[0]).toMatchObject({ root: { dir: 'row', children: [{ slot: 1 }, { slot: 2 }] }, slots: [1, 2], focus: 2 });
    // The same direction again: only the focused pane is halved; pane 2 keeps its half.
    l = focusSlot(l, 1);
    l = splitActive(l, 'row');
    expect(l.tabs[0]).toMatchObject({ root: { dir: 'row', children: [{ dir: 'row', children: [{ slot: 1 }, { slot: 3 }] }, { slot: 2 }] }, slots: [1, 3, 2], focus: 3 });
    expect(paneRects(l.tabs[0]!.root).map((r) => [r.slot, r.w])).toEqual([[1, 0.25], [3, 0.25], [2, 0.5]]);
  });

  it('a split the other way splits only the focused pane; the others keep their place', () => {
    // Split right, then split the right one down: [1 | (2 over 3)].
    let l = splitActive(splitActive(initialLayout(), 'row'), 'col');
    expect(l.tabs[0]!.root).toEqual({ dir: 'row', children: [{ slot: 1 }, { dir: 'col', children: [{ slot: 2 }, { slot: 3 }] }] });
    expect(paneRects(l.tabs[0]!.root)).toEqual([
      { slot: 1, x: 0, y: 0, w: 0.5, h: 1 },
      { slot: 2, x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { slot: 3, x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ]);
    // Then the left one down: a 2 x 2 grid.
    l = splitActive(focusSlot(l, 1), 'col');
    expect(l.tabs[0]!.root).toEqual({ dir: 'row', children: [
      { dir: 'col', children: [{ slot: 1 }, { slot: 4 }] },
      { dir: 'col', children: [{ slot: 2 }, { slot: 3 }] },
    ] });
    expect(l.tabs[0]!.slots).toEqual([1, 4, 2, 3]);
    expect(focusedSlot(l)).toBe(4);
  });

  it('closing a pane of a nested split folds the split it leaves with one part', () => {
    let l = splitActive(splitActive(initialLayout(), 'row'), 'col'); // [1 | (2 / 3)]
    l = removeSlot(l, 2);
    expect(l.tabs[0]!.root).toEqual({ dir: 'row', children: [{ slot: 1 }, { slot: 3 }] });
    l = removeSlot(l, 1);
    expect(l.tabs[0]!.root).toEqual({ slot: 3 });
    expect(paneRects(l.tabs[0]!.root)).toEqual([{ slot: 3, x: 0, y: 0, w: 1, h: 1 }]);
  });

  it('takes a slot the server reserved, but never one a tab already uses', () => {
    let l = addTab(initialLayout(), 5);
    expect(allSlots(l)).toEqual([1, 5]);
    l = splitActive(l, 'col', 7);
    expect(allSlots(l)).toEqual([1, 5, 7]);
    // A reserved slot this page already shows (or no slot at all): the lowest free one.
    expect(allSlots(addTab(l, 5))).toEqual([1, 5, 7, 2]);
    expect(allSlots(addTab(l, 0))).toEqual([1, 5, 7, 2]);
  });

  it('a tab holds at most MAX_PANES_PER_TAB panes', () => {
    let l = initialLayout();
    for (let i = 0; i < 10; i++) l = splitActive(l, 'row');
    expect(l.tabs[0]!.slots).toHaveLength(MAX_PANES_PER_TAB);
    expect(canSplit(l)).toBe(false);
    // Another tab can still split.
    l = addTab(l);
    expect(canSplit(l)).toBe(true);
  });

  it('closing a pane focuses the one before it and keeps the tab', () => {
    let l = splitActive(splitActive(initialLayout(), 'row'), 'row'); // [1,2,3] focus 3
    l = removeSlot(l, 3);
    expect(l.tabs[0]).toMatchObject({ slots: [1, 2], focus: 2 });
    l = removeSlot(l, 1);
    expect(l.tabs[0]).toMatchObject({ root: { slot: 2 }, slots: [2], focus: 2 });
  });

  it('closing the shown tab shows the one after it, else the one before', () => {
    let l = addTab(addTab(initialLayout())); // tabs tab1 tab2 tab3, tab3 shown
    l = activateTab(l, 'tab2');
    l = removeSlot(l, 2);
    expect(l.active).toBe('tab3');
    l = removeSlot(l, 3);
    expect(l.active).toBe('tab1');
    l = removeSlot(l, 1);
    expect(l.tabs).toEqual([]);
  });

  it('closing a tab that is not shown keeps the shown one', () => {
    let l = addTab(initialLayout()); // tab2 shown
    l = removeSlot(l, 1);
    expect(l.active).toBe('tab2');
  });

  it('focusing a pane in another tab shows that tab', () => {
    let l = addTab(initialLayout());
    l = focusSlot(l, 1);
    expect(l.active).toBe('tab1');
    expect(focusedSlot(l)).toBe(1);
    expect(focusSlot(l, 1)).toBe(l);
    expect(focusSlot(l, 7)).toBe(l);
  });

  describe('reconcile with the terminals the host runs', () => {
    it('adds a tab for a terminal running on the host that no tab shows (another device opened it)', () => {
      const l = reconcileLayout(initialLayout(), [1, 4], [1]);
      expect(allSlots(l)).toEqual([1, 4]);
      expect(l.active).toBe('tab1');
    });

    it('drops a stored terminal whose shell no longer runs', () => {
      const stored = splitActive(addTab(initialLayout()), 'row'); // tab1 [1], tab2 [2,3]
      const l = reconcileLayout(stored, [1, 3], allSlots(stored));
      expect(allSlots(l)).toEqual([1, 3]);
    });

    it('keeps a terminal added after the list was asked for (its open may be on the way)', () => {
      const asked = allSlots(initialLayout());
      const now = addTab(initialLayout());
      expect(allSlots(reconcileLayout(now, [1], asked))).toEqual([1, 2]);
    });

    it('with nothing running, gives one fresh terminal in the first stored slot', () => {
      const stored = activateTab(addTab(addTab(initialLayout())), 'tab2');
      const l = reconcileLayout(removeSlot(stored, 1), [], [2, 3]);
      expect(allSlots(l)).toEqual([2]);
      expect(reconcileLayout(initialLayout(), [], [1])).toEqual(initialLayout());
    });

    it('ignores slots that are not slots', () => {
      expect(allSlots(reconcileLayout(initialLayout(), [1, 0, 99, 2.5], [1]))).toEqual([1]);
    });
  });

  describe('stored layout', () => {
    it('round-trips', () => {
      const l = splitActive(addTab(initialLayout()), 'col');
      expect(parseLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
      const nested = splitActive(focusSlot(splitActive(splitActive(initialLayout(), 'row'), 'col'), 1), 'col');
      expect(parseLayout(JSON.parse(JSON.stringify(nested)))).toEqual(nested);
    });

    it('reads a layout stored before splits nested (one direction per tab)', () => {
      const l = parseLayout({ tabs: [{ id: 'tab1', slots: [1, 3], dir: 'col', focus: 3 }, { id: 'tab2', slots: [2], dir: 'row', focus: 2 }], active: 'tab1' });
      expect(l).toEqual({
        tabs: [
          { id: 'tab1', root: { dir: 'col', children: [{ slot: 1 }, { slot: 3 }] }, slots: [1, 3], focus: 3 },
          { id: 'tab2', root: { slot: 2 }, slots: [2], focus: 2 },
        ],
        active: 'tab1',
      });
    });

    it('trims a stored tab of too many panes and a tree too deep', () => {
      const leaves = [1, 2, 3, 4, 5, 6].map((slot) => ({ slot }));
      const l = parseLayout({ tabs: [{ id: 'a', root: { dir: 'row', children: leaves }, focus: 6 }], active: 'a' });
      expect(l!.tabs[0]).toMatchObject({ slots: [1, 2, 3, 4], focus: 1 });
      // A slot trimmed off one tab can still show in a later one.
      const later = parseLayout({ tabs: [{ id: 'a', root: { dir: 'row', children: leaves.slice(0, 5) } }, { id: 'b', root: { slot: 5 } }], active: 'a' });
      expect(later!.tabs.map((t) => t.slots)).toEqual([[1, 2, 3, 4], [5]]);
      let deep: unknown = { slot: 1 };
      for (let i = 0; i < 10; i++) deep = { dir: 'row', children: [deep, { slot: 2 }] };
      // Past the depth kept, parts are dropped (slot 1 sits deepest); a slot claimed twice keeps its first place.
      expect(allSlots(parseLayout({ tabs: [{ id: 'a', root: deep }], active: 'a' })!)).toEqual([2]);
    });

    it('rejects what is not a layout', () => {
      for (const bad of [null, 'x', 3, {}, { tabs: 'x', active: 'tab1' }, { tabs: [], active: 'tab1' }, { tabs: [{ id: 'tab1', slots: [0, 9] }], active: 'tab1' }]) {
        expect(parseLayout(bad)).toBeNull();
      }
    });

    it('drops a slot two tabs claim and fixes a stale focus or active tab', () => {
      const l = parseLayout({ tabs: [{ id: 'a', slots: [1, 2], dir: 'col', focus: 5 }, { id: 'b', slots: [2] }], active: 'zz' });
      expect(l).toEqual({ tabs: [{ id: 'a', root: { dir: 'col', children: [{ slot: 1 }, { slot: 2 }] }, slots: [1, 2], focus: 1 }], active: 'a' });
    });
  });
});
