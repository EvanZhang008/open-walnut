/**
 * Question-mark hit testing, the pure half (web/src/utils/thread-mark-hit.ts):
 * range containment plus the line-box check, the empty-selection rule, the
 * per-frame throttle and the caret lookup's engine fallback.
 */
import { describe, it, expect } from 'vitest';
import {
  caretFromPoint, hitMark, pointInRects, rafThrottle, selectionIsEmpty, type MarkRangeLike, type ThreadMark,
} from '@/utils/thread-mark-hit';

const node = {} as Node;
const other = {} as Node;

function fakeRange(holds: Node, from: number, to: number, rects: Array<[number, number, number, number]>): MarkRangeLike {
  return {
    isPointInRange: (n, off) => n === holds && off >= from && off <= to,
    getClientRects: () => rects.map(([left, top, right, bottom]) => ({ left, top, right, bottom })),
  };
}

const mark = (key: string, range: MarkRangeLike): ThreadMark<MarkRangeLike> =>
  ({ key, range, hue: 152, resolved: false, title: key });

describe('hitMark', () => {
  const marks = [
    mark('a', fakeRange(node, 0, 10, [[0, 0, 100, 20]])),
    mark('b', fakeRange(node, 20, 30, [[0, 40, 60, 60]])),
  ];

  it('needs the caret inside the range AND the point inside its line boxes', () => {
    expect(hitMark(marks, { node, offset: 5 }, 50, 10)?.key).toBe('a');
    expect(hitMark(marks, { node, offset: 25 }, 30, 50)?.key).toBe('b');
    // Caret snapped to the end of b, but the pointer is in the empty run after the line.
    expect(hitMark(marks, { node, offset: 30 }, 200, 50)).toBeNull();
    expect(hitMark(marks, { node: other, offset: 5 }, 50, 10)).toBeNull();
    expect(hitMark(marks, null, 50, 10)).toBeNull();
    expect(hitMark([], { node, offset: 5 }, 50, 10)).toBeNull();
  });

  it('treats a throwing range (detached node) as a miss', () => {
    const broken = mark('x', { isPointInRange: () => { throw new Error('wrong document'); }, getClientRects: () => [] });
    expect(hitMark([broken], { node, offset: 1 }, 0, 0)).toBeNull();
  });

  it('checks rects with a pixel of slop', () => {
    expect(pointInRects([{ left: 10, right: 20, top: 10, bottom: 20 }], 9.5, 15)).toBe(true);
    expect(pointInRects([{ left: 10, right: 20, top: 10, bottom: 20 }], 5, 15)).toBe(false);
  });
});

describe('selectionIsEmpty', () => {
  it('opens a mark only with nothing selected', () => {
    expect(selectionIsEmpty(null)).toBe(true);
    expect(selectionIsEmpty({ isCollapsed: true, toString: () => '' })).toBe(true);
    expect(selectionIsEmpty({ isCollapsed: false, toString: () => 'passage' })).toBe(false);
  });
});

describe('rafThrottle', () => {
  it('runs once per frame with the newest argument, and cancels', () => {
    const frames: Array<() => void> = [];
    const seen: number[] = [];
    const t = rafThrottle<number>((n) => seen.push(n), (cb) => { frames.push(cb); return frames.length; }, () => { frames.length = 0; });
    t.call(1); t.call(2); t.call(3);
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(seen).toEqual([3]);
    t.call(4);
    t.cancel();
    expect(frames).toHaveLength(0);
    expect(seen).toEqual([3]);
  });
});

describe('caretFromPoint', () => {
  it('prefers caretPositionFromPoint and falls back to caretRangeFromPoint', () => {
    const chromium = { caretPositionFromPoint: () => ({ offsetNode: node, offset: 3 }) } as unknown as Document;
    expect(caretFromPoint(chromium, 1, 1)).toEqual({ node, offset: 3 });
    const webkit = { caretRangeFromPoint: () => ({ startContainer: other, startOffset: 7 }) } as unknown as Document;
    expect(caretFromPoint(webkit, 1, 1)).toEqual({ node: other, offset: 7 });
    expect(caretFromPoint({} as Document, 1, 1)).toBeNull();
    const throwing = { caretPositionFromPoint: () => { throw new Error('x'); } } as unknown as Document;
    expect(caretFromPoint(throwing, 1, 1)).toBeNull();
  });
});
