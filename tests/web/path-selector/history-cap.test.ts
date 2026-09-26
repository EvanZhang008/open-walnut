/**
 * The history group's cap (spec 4.4, checklist C30 / C31): 8 history rows and one
 * 'Show N more' option row, only when a HOME FOLDERS group with rows follows.
 * Pure function tests, no IO.
 */
import { describe, it, expect } from 'vitest';
import {
  capHistorySections, HISTORY_CAP, HISTORY_CAP_MIN, historyCapFor, isMoreRow, moreRowText,
} from '../../../web/src/components/sessions/path-selector/history-cap';
import type { RankedItem, Section } from '../../../web/src/components/sessions/path-selector/ranking';

function row(cwd: string): RankedItem {
  return { cwd, host: null, source: 'history', depth: 0, quality: 'substring', leafHit: true, frecency: 1 };
}
function history(n: number): Section {
  return { id: 'history', label: 'history', hostKey: '__local__', items: Array.from({ length: n }, (_, i) => row(`/work/p${i}`)) };
}
const home = (n: number): Section => ({
  id: 'home:__local__', label: 'home folders', hostKey: '__local__',
  items: Array.from({ length: n }, (_, i) => ({ ...row(`/home/alice/work${i}`), source: 'live' as const })),
});

describe('capHistorySections', () => {
  it('99 history rows + home rows: exactly 8 rows then the more row (N = total - 8)', () => {
    const out = capHistorySections([history(99), home(4)], false);
    const hist = out.find((s) => s.id === 'history')!;
    expect(hist.items).toHaveLength(HISTORY_CAP + 1);
    expect(hist.items.slice(0, 8).every((i) => !isMoreRow(i))).toBe(true);
    const more = hist.items[8];
    expect(isMoreRow(more)).toBe(true);
    expect(moreRowText(more.moreCount!)).toBe('Show 91 more');
    // The home group is untouched and now sits right after 9 rows.
    expect(out[1].items).toHaveLength(4);
  });

  it('expanded shows every row, in place (same section order, no more row)', () => {
    const input = [history(99), home(4)];
    const out = capHistorySections(input, true);
    expect(out).toBe(input);
    expect(out[0].items.some(isMoreRow)).toBe(false);
  });

  it('no cap without home rows (nothing below history to be hidden from)', () => {
    const input = [history(99)];
    expect(capHistorySections(input, false)).toBe(input);
    const emptyHome = [history(99), home(0)];
    expect(capHistorySections(emptyHome, false)).toBe(emptyHome);
  });

  it('8 or fewer history rows: no more row', () => {
    const input = [history(8), home(2)];
    expect(capHistorySections(input, false)).toBe(input);
  });

  it('the more row sits at the flat index of the former 9th row (the highlight lands on it after expanding)', () => {
    const capped = capHistorySections([history(20), home(3)], false);
    const flat = capped.flatMap((s) => s.items);
    const at = flat.findIndex(isMoreRow);
    expect(at).toBe(8);
    const expanded = capHistorySections([history(20), home(3)], true).flatMap((s) => s.items);
    expect(expanded[at].cwd).toBe('/work/p8');
  });

  it('the more row is never a path: no cwd a Start could use, and no history entry', () => {
    const more = capHistorySections([history(12), home(1)], false)[0].items[8];
    expect(more.history).toBeUndefined();
    expect(more.cwd).toBe('');
  });
});

describe('historyCapFor: the cap follows the list height (8 at most, 3 at least)', () => {
  // The picker's real shape: a 30px row pitch, the history label above the rows,
  // the more row + the HOME FOLDERS label below them.
  const measure = (listHeight: number, rows = 8) => ({ listHeight, above: 22, rowHeights: Array(rows).fill(30), below: 30 + 26 })

  it('a tall list (1280x900, about 430px) keeps 8 rows', () => {
    expect(historyCapFor(measure(430))).toBe(8);
    expect(historyCapFor(measure(22 + 8 * 30 + 56))).toBe(8);
  });

  it('a 720px window (list about 250px) takes as many rows as fit above HOME FOLDERS', () => {
    // 250 - 22 above - 56 below = 172 of room: 5 rows of 30.
    expect(historyCapFor(measure(250))).toBe(5);
    expect(historyCapFor(measure(22 + 5 * 30 + 56))).toBe(5);
    expect(historyCapFor(measure(22 + 5 * 30 + 56 - 1))).toBe(4);
  });

  it('never fewer than 3, never more than 8', () => {
    expect(historyCapFor(measure(60))).toBe(HISTORY_CAP_MIN);
    expect(historyCapFor(measure(5000))).toBe(HISTORY_CAP);
  });

  it('rows measured so far count at their own pitch; the rest at the average (a capped list re-measures to the same answer)', () => {
    expect(historyCapFor({ listHeight: 250, above: 22, rowHeights: [30, 30, 30, 30, 30], below: 56 })).toBe(5);
    expect(historyCapFor({ listHeight: 250, above: 22, rowHeights: [40, 20], below: 56 })).toBe(5);
  });

  it('nothing measured yet: 8', () => {
    expect(historyCapFor(null)).toBe(HISTORY_CAP);
    expect(historyCapFor({ listHeight: 0, above: 0, rowHeights: [30], below: 0 })).toBe(HISTORY_CAP);
    expect(historyCapFor({ listHeight: 250, above: 0, rowHeights: [], below: 0 })).toBe(HISTORY_CAP);
  });

  it('capHistorySections takes the cap: 5 rows + Show 35 more, and clamps a bad cap into [3, 8]', () => {
    const five = capHistorySections([history(40), home(4)], false, 5)[0];
    expect(five.items).toHaveLength(6);
    expect(isMoreRow(five.items[5])).toBe(true);
    expect(moreRowText(five.items[5].moreCount!)).toBe('Show 35 more');
    expect(capHistorySections([history(40), home(4)], false, 1)[0].items).toHaveLength(HISTORY_CAP_MIN + 1);
    expect(capHistorySections([history(40), home(4)], false, 99)[0].items).toHaveLength(HISTORY_CAP + 1);
    // 5 history rows with a cap of 5: nothing to hide.
    const input = [history(5), home(2)];
    expect(capHistorySections(input, false, 5)).toBe(input);
  });
});
