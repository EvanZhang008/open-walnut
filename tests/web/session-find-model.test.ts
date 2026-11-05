/**
 * Cmd+F across a whole session (web/src/utils/session-find.ts): every match in
 * transcript order, the hidden rows' (not on the page) and the page's own, and
 * stepping through them.
 */
import { describe, it, expect } from 'vitest';
import {
  hiddenBefore, hiddenTotal, placeOfHidden, placeOfPage, stepFind, stopAt, totalOf, type FindLayout,
} from '@/utils/session-find';

// Rows: 0..9 held by the chat. Hidden: an unloaded row (pos < 0) with 2
// matches, and a folded row at 5 with 1. The page shows matches in rows 3, 3, 7.
const layout: FindLayout = {
  hidden: [{ id: 'old', count: 2, pos: -1e9 }, { id: 'fold', count: 1, pos: 5 }],
  pagePos: [3, 3, 7],
};

describe('find layout', () => {
  it('counts hidden and page matches together', () => {
    expect(hiddenTotal(layout.hidden)).toBe(3);
    expect(totalOf(layout)).toBe(6);
    expect(hiddenBefore(layout.hidden, 4)).toBe(2);
    expect(hiddenBefore(layout.hidden, 6)).toBe(3);
  });

  it('numbers every match in transcript order', () => {
    // old#0 old#1 page0 page1 fold#0 page2
    expect(placeOfHidden(layout, 0, 0)).toBe(0);
    expect(placeOfHidden(layout, 0, 1)).toBe(1);
    expect(placeOfPage(layout, 0)).toBe(2);
    expect(placeOfPage(layout, 1)).toBe(3);
    expect(placeOfHidden(layout, 1, 0)).toBe(4);
    expect(placeOfPage(layout, 2)).toBe(5);
  });

  it('stopAt inverts the numbering', () => {
    expect(stopAt(layout, 0)).toEqual({ kind: 'hidden', row: 0, occurrence: 0 });
    expect(stopAt(layout, 1)).toEqual({ kind: 'hidden', row: 0, occurrence: 1 });
    expect(stopAt(layout, 2)).toEqual({ kind: 'page', index: 0 });
    expect(stopAt(layout, 3)).toEqual({ kind: 'page', index: 1 });
    expect(stopAt(layout, 4)).toEqual({ kind: 'hidden', row: 1, occurrence: 0 });
    expect(stopAt(layout, 5)).toEqual({ kind: 'page', index: 2 });
  });

  it('a page match in a row before a leading position sorts first', () => {
    const lead: FindLayout = { hidden: [{ id: 'h', count: 1, pos: 2 }], pagePos: [-Infinity, 4] };
    expect(placeOfPage(lead, 0)).toBe(0);
    expect(placeOfHidden(lead, 0, 0)).toBe(1);
    expect(placeOfPage(lead, 1)).toBe(2);
  });
});

describe('a row on screen with words in a folded card', () => {
  // Row 3 shows 2 matches; 1 more sits in its folded card (pos 3.5: after them).
  const folded: FindLayout = { hidden: [{ id: 'r3', count: 1, pos: 3.5 }], pagePos: [3, 3, 7] };
  it('numbers the folded word after the row\'s visible ones, before the next row', () => {
    expect(placeOfPage(folded, 0)).toBe(0);
    expect(placeOfPage(folded, 1)).toBe(1);
    expect(placeOfHidden(folded, 0, 0)).toBe(2);
    expect(placeOfPage(folded, 2)).toBe(3);
    expect(totalOf(folded)).toBe(4);
  });
});

describe('stepFind', () => {
  it('from nothing chosen lets the page pick from the view when it has matches', () => {
    expect(stepFind(layout, null, 1)).toBeNull();
    expect(stepFind(layout, null, -1)).toBeNull();
  });

  it('from nothing chosen with no page match goes to the first (next) or last (previous)', () => {
    const onlyHidden: FindLayout = { hidden: layout.hidden, pagePos: [] };
    expect(stepFind(onlyHidden, null, 1)).toEqual({ kind: 'hidden', row: 0, occurrence: 0 });
    expect(stepFind(onlyHidden, null, -1)).toEqual({ kind: 'hidden', row: 1, occurrence: 0 });
  });

  it('previous from the first page match goes up into the newest unloaded occurrence', () => {
    expect(stepFind(layout, placeOfPage(layout, 0), -1)).toEqual({ kind: 'hidden', row: 0, occurrence: 1 });
  });

  it('next steps over a folded row between page matches', () => {
    expect(stepFind(layout, placeOfPage(layout, 1), 1)).toEqual({ kind: 'hidden', row: 1, occurrence: 0 });
    expect(stepFind(layout, placeOfHidden(layout, 1, 0), 1)).toEqual({ kind: 'page', index: 2 });
  });

  it('wraps at both ends', () => {
    expect(stepFind(layout, 5, 1)).toEqual({ kind: 'hidden', row: 0, occurrence: 0 });
    expect(stepFind(layout, 0, -1)).toEqual({ kind: 'page', index: 2 });
  });

  it('a full lap visits every match once, in order', () => {
    const seen: number[] = [];
    let c = 0;
    for (let i = 0; i < totalOf(layout); i++) {
      seen.push(c);
      const to = stepFind(layout, c, 1)!;
      c = to.kind === 'page' ? placeOfPage(layout, to.index) : placeOfHidden(layout, to.row, to.occurrence);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    expect(c).toBe(0);
  });

  it('nothing to step through', () => {
    expect(stepFind({ hidden: [], pagePos: [] }, null, 1)).toBeNull();
  });
});
