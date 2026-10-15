import { describe, expect, it } from 'vitest';
import {
  StableOrderGate, mergeStableOrder, sameRelativeOrder, updatesLabel,
  HOLD_AFTER_TOUCH_MS, touchHold, __noteTouchForTest,
} from '../../web/src/components/tasks/useStableOrder';

describe('mergeStableOrder', () => {
  it('keeps the frozen relative order of rows that stay', () => {
    expect(mergeStableOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('drops removed rows at once', () => {
    expect(mergeStableOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
  });

  it('inserts a new row right after the live row before it', () => {
    expect(mergeStableOrder(['a', 'b', 'c'], ['c', 'n', 'a', 'b'])).toEqual(['a', 'b', 'c', 'n']);
    expect(mergeStableOrder(['a', 'b'], ['n', 'b', 'a'])).toEqual(['n', 'a', 'b']);
  });
});

describe('StableOrderGate', () => {
  it('passes the live order through while nothing holds it', () => {
    const g = new StableOrderGate();
    expect(g.update(['a', 'b'], false)).toEqual(['a', 'b']);
    expect(g.update(['b', 'a'], false)).toEqual(['b', 'a']);
    expect(g.pending).toBe(0);
  });

  it('holds the order and counts one queued update per reorder', () => {
    const g = new StableOrderGate();
    g.update(['a', 'b', 'c'], false);
    expect(g.update(['c', 'a', 'b'], true)).toEqual(['a', 'b', 'c']);
    expect(g.pending).toBe(1);
    expect(updatesLabel(g.pending)).toBe('1 update');
    // The same live order again (a StrictMode re-render, a data-only push) adds nothing.
    expect(g.update(['c', 'a', 'b'], true)).toEqual(['a', 'b', 'c']);
    expect(g.pending).toBe(1);
    expect(g.update(['b', 'c', 'a'], true)).toEqual(['a', 'b', 'c']);
    expect(g.pending).toBe(2);
    expect(updatesLabel(2)).toBe('2 updates');
  });

  it('keeps the queue after the hold lifts, until apply', () => {
    const g = new StableOrderGate();
    g.update(['a', 'b'], false);
    g.update(['b', 'a'], true);
    expect(g.update(['b', 'a'], false)).toEqual(['a', 'b']);
    expect(g.pending).toBe(1);
    expect(g.apply()).toEqual(['b', 'a']);
    expect(g.pending).toBe(0);
    expect(g.update(['b', 'a'], true)).toEqual(['b', 'a']);
  });

  it('applies new and removed rows at once while holding', () => {
    const g = new StableOrderGate();
    g.update(['a', 'b', 'c'], false);
    expect(g.update(['a', 'n', 'b', 'c'], true)).toEqual(['a', 'n', 'b', 'c']);
    expect(g.pending).toBe(0);
    expect(g.update(['a', 'c'], true)).toEqual(['a', 'c']);
    expect(g.pending).toBe(0);
  });

  it('clears the queue when the live order comes back to what is shown', () => {
    const g = new StableOrderGate();
    g.update(['a', 'b'], false);
    g.update(['b', 'a'], true);
    expect(g.pending).toBe(1);
    expect(g.update(['a', 'b'], true)).toEqual(['a', 'b']);
    expect(g.pending).toBe(0);
  });
});

describe('touch hold', () => {
  it('holds for 2 s after a touch ends', () => {
    const t = 1_000_000;
    __noteTouchForTest(t);
    expect(touchHold(t + 100)).toBe(true);
    expect(touchHold(t + HOLD_AFTER_TOUCH_MS - 1)).toBe(true);
    expect(touchHold(t + HOLD_AFTER_TOUCH_MS + 200)).toBe(false);
  });

  it('compares relative order on the shared ids only', () => {
    expect(sameRelativeOrder(['a', 'b', 'c'], ['a', 'x', 'b'])).toBe(true);
    expect(sameRelativeOrder(['a', 'b'], ['b', 'a'])).toBe(false);
  });
});
