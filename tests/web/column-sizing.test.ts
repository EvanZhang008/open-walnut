import { describe, it, expect } from 'vitest';
import {
  evenWeights,
  normalizeWeights,
  resizeAtBoundary,
  loadColWeights,
  saveColWeights,
  minColPct,
} from '../../web/src/pages/columnSizing';

/**
 * THE BUG these cover: session column widths were ONE scalar (`colSplitPct`) —
 * column 0 got `pct`%, and every OTHER column got `100 - pct`%. That is only
 * coherent for exactly two columns; with three the strip summed to 150% and
 * overflowed, so a "3 Panels" option built on the scalar could not lay out.
 *
 * The invariant that replaces it, asserted throughout: weights always sum to 100
 * for ANY column count, and a divider drag only ever trades between its two
 * neighbours.
 */

const sum = (w: number[]) => w.reduce((a, b) => a + b, 0);

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    raw: map,
  };
}

describe('columnSizing: minColPct (drag floor)', () => {
  it('keeps the familiar 20% floor for the 2-column case', () => {
    expect(minColPct(2)).toBeCloseTo(20);
  });

  it('stays satisfiable at every custom count — a fixed 20% would not be', () => {
    // THE BUG: a fixed 20% floor is unsatisfiable from 5 columns up (5 × 20 = 100
    // leaves nothing to trade, 6 × 20 = 120 is unreachable), so every drag in a
    // 5- or 6-panel layout silently became a no-op.
    for (const n of [2, 3, 4, 5, 6, 8]) {
      expect(n * minColPct(n), `count ${n} must leave slack to trade`).toBeLessThan(100);
    }
  });

  it('never exceeds the even share (a column can always reach its floor)', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      expect(minColPct(n)).toBeLessThanOrEqual(100 / n);
    }
  });
});

describe('columnSizing: evenWeights', () => {
  it('sums to exactly 100 for every supported count', () => {
    // Through the custom-count ceiling (6), plus one above it.
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      expect(sum(evenWeights(n))).toBe(100);
    }
  });

  it('gives the indivisible remainder to the first column', () => {
    // 100/3 = 33.33 — integers would sum to 99, so col 0 absorbs the extra 1.
    expect(evenWeights(3)).toEqual([34, 33, 33]);
  });

  it('returns an empty layout for a zero-column strip', () => {
    expect(evenWeights(0)).toEqual([]);
  });
});

describe('columnSizing: normalizeWeights', () => {
  it('rescales a valid layout to sum to 100', () => {
    const out = normalizeWeights([1, 1, 2], 3);
    expect(sum(out)).toBeCloseTo(100);
    expect(out[2]).toBeCloseTo(50);
  });

  it('resets when the stored length does not match the column count', () => {
    // THE 3-panel regression: a saved 2-column layout must not be stretched
    // across 3 columns (that is exactly how the old scalar overflowed).
    expect(normalizeWeights([60, 40], 3)).toEqual(evenWeights(3));
  });

  it('resets on non-numeric, negative, or non-array data', () => {
    expect(normalizeWeights(['60', '40'], 2)).toEqual(evenWeights(2));
    expect(normalizeWeights([60, -40], 2)).toEqual(evenWeights(2));
    expect(normalizeWeights([60, NaN], 2)).toEqual(evenWeights(2));
    expect(normalizeWeights(null, 2)).toEqual(evenWeights(2));
    expect(normalizeWeights({ 0: 50, 1: 50 }, 2)).toEqual(evenWeights(2));
  });

  it('resets a layout that violates the per-column floor', () => {
    expect(normalizeWeights([95, 5], 2)).toEqual(evenWeights(2));
  });

  it('keeps a layout whose columns are all at or above the floor', () => {
    const floor = minColPct(2);
    const out = normalizeWeights([floor, 100 - floor], 2);
    expect(out[0]).toBeCloseTo(floor);
  });
});

describe('columnSizing: resizeAtBoundary', () => {
  it('trades width between the two neighbours only, leaving others untouched', () => {
    // Boundary 0 = divider between col 0 and col 1. Col 2 must not move.
    const out = resizeAtBoundary([34, 33, 33], 0, 10);
    expect(out[0]).toBeCloseTo(44);
    expect(out[1]).toBeCloseTo(23);
    expect(out[2]).toBe(33);
    expect(sum(out)).toBeCloseTo(100);
  });

  it('resizes the second divider of a 3-column strip', () => {
    const out = resizeAtBoundary([34, 33, 33], 1, -8);
    expect(out[0]).toBe(34);
    expect(out[1]).toBeCloseTo(25);
    expect(out[2]).toBeCloseTo(41);
    expect(sum(out)).toBeCloseTo(100);
  });

  it('preserves the 100 total for any drag magnitude, including overshoot', () => {
    for (const delta of [-500, -37, -1, 0, 1, 37, 500]) {
      expect(sum(resizeAtBoundary([34, 33, 33], 0, delta))).toBeCloseTo(100);
    }
  });

  it('clamps at the floor instead of collapsing a column', () => {
    const shrinkLeft = resizeAtBoundary([34, 33, 33], 0, -999);
    expect(shrinkLeft[0]).toBeCloseTo(minColPct(3));
    const shrinkRight = resizeAtBoundary([34, 33, 33], 0, 999);
    expect(shrinkRight[1]).toBeCloseTo(minColPct(3));
  });

  it('is a no-op for a boundary outside the strip', () => {
    const w = [34, 33, 33];
    expect(resizeAtBoundary(w, 2, 10)).toBe(w);  // no column right of the last
    expect(resizeAtBoundary(w, -1, 10)).toBe(w);
    expect(resizeAtBoundary([100], 0, 10)).toEqual([100]); // single column
  });

  it('still trades width at custom counts of 5 and 6', () => {
    // Regression for the fixed-20% floor: at these counts every column starts
    // BELOW a 20% floor, so the old clamp rejected the whole drag as a no-op.
    for (const n of [5, 6]) {
      const base = evenWeights(n);
      const out = resizeAtBoundary(base, 1, 5);
      expect(out[1], `count ${n}: left neighbour grew`).toBeGreaterThan(base[1]);
      expect(out[2], `count ${n}: right neighbour shrank`).toBeLessThan(base[2]);
      expect(sum(out)).toBeCloseTo(100);
      // Untouched columns keep their exact share.
      expect(out[0]).toBe(base[0]);
      if (n > 3) expect(out[3]).toBe(base[3]);
    }
  });

  it('applies the delta to the grab-time weights, not as a running sum', () => {
    // The drag handler always passes the total delta from the grab point, so
    // replaying one drag as two calls from the SAME base must be idempotent.
    const base = [34, 33, 33];
    expect(resizeAtBoundary(base, 0, 5)).toEqual(resizeAtBoundary(base, 0, 5));
  });
});

describe('columnSizing: persistence', () => {
  it('stores each column count separately so counts do not clobber each other', () => {
    const s = fakeStorage();
    saveColWeights([60, 40], s);
    saveColWeights([50, 25, 25], s);
    // Opening a 3rd panel must not have destroyed the tuned 2-column layout.
    expect(loadColWeights(2, s)[0]).toBeCloseTo(60);
    expect(loadColWeights(3, s)[0]).toBeCloseTo(50);
  });

  it('round-trips a layout', () => {
    const s = fakeStorage();
    saveColWeights([50, 30, 20], s);
    const out = loadColWeights(3, s);
    expect(out[0]).toBeCloseTo(50);
    expect(out[1]).toBeCloseTo(30);
    expect(out[2]).toBeCloseTo(20);
  });

  it('migrates the legacy 2-column scalar', () => {
    // Users upgrading must keep the split they had, not get reset to 50/50.
    const s = fakeStorage({ 'open-walnut-col-split': '65' });
    const out = loadColWeights(2, s);
    expect(out[0]).toBeCloseTo(65);
    expect(out[1]).toBeCloseTo(35);
  });

  it('does not apply the legacy 2-column scalar to a 3-column strip', () => {
    const s = fakeStorage({ 'open-walnut-col-split': '65' });
    expect(loadColWeights(3, s)).toEqual(evenWeights(3));
  });

  it('falls back to an even split when nothing is stored', () => {
    expect(loadColWeights(3, fakeStorage())).toEqual(evenWeights(3));
  });

  it('survives corrupt stored JSON', () => {
    const s = fakeStorage({ 'open-walnut-col-weights': '{not json' });
    expect(loadColWeights(2, s)).toEqual(evenWeights(2));
  });

  it('survives a storage that throws (private mode / quota)', () => {
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(loadColWeights(3, throwing)).toEqual(evenWeights(3));
    expect(() => saveColWeights([50, 50], throwing)).not.toThrow();
  });

  it('keeps a separate tuned layout per custom count', () => {
    // Switching 2 → 5 → 3 → back must restore each layout verbatim, not a
    // stretched guess: the per-count keying is what makes Custom safe to explore.
    const s = fakeStorage();
    saveColWeights([70, 30], s);
    saveColWeights(evenWeights(5), s);
    saveColWeights([50, 30, 20], s);
    expect(loadColWeights(2, s)[0]).toBeCloseTo(70);
    expect(loadColWeights(5, s)).toHaveLength(5);
    expect(loadColWeights(3, s)[1]).toBeCloseTo(30);
    // A count never tuned falls back to even rather than borrowing another count's.
    expect(loadColWeights(6, s)).toEqual(evenWeights(6));
  });

  it('ignores an empty layout rather than writing a "0" entry', () => {
    const s = fakeStorage();
    saveColWeights([], s);
    expect(s.raw.size).toBe(0);
  });
});
