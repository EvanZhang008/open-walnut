/**
 * The scanning line under a passage being answered (web/src/utils/thread-live-lines.ts):
 * text fragments become one bar per line, in the layer's coordinates, clipped to
 * where the passage can be seen; and the highlight name a live mark wears.
 */
import { describe, expect, it } from 'vitest';
import { liveLineBars, LIVE_BAR_HEIGHT } from '@/utils/thread-live-lines';
import { markHighlightName } from '@/hooks/useThreadMarks';

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const at0 = { left: 0, top: 0 };

describe('liveLineBars', () => {
  it('one fragment: one bar on its bottom edge, as wide as the text', () => {
    expect(liveLineBars([box(10, 100, 210, 118)], at0)).toEqual([{ top: 117, left: 10, width: 200 }]);
  });

  it('is in the layer\'s coordinates', () => {
    expect(liveLineBars([box(110, 400, 210, 418)], { left: 100, top: 250 })).toEqual([{ top: 167, left: 10, width: 100 }]);
  });

  it('a wrapped passage: one bar per line, top to bottom', () => {
    const bars = liveLineBars([box(300, 140, 500, 158), box(20, 120, 500, 138), box(20, 160, 180, 178)], at0);
    expect(bars.map((b) => b.top)).toEqual([137, 157, 177]);
    expect(bars.map((b) => b.width)).toEqual([480, 200, 160]);
  });

  it('runs of one line split across inline elements (a bold word, inline code a little taller) are one bar', () => {
    const bars = liveLineBars([box(20, 100, 80, 118), box(80, 99, 140, 119), box(141, 100, 260, 118)], at0);
    expect(bars).toEqual([{ top: 118, left: 20, width: 240 }]);
  });

  it('two table cells on one row stay two bars (the gap between them is not underlined)', () => {
    const bars = liveLineBars([box(20, 100, 120, 118), box(200, 100, 320, 118)], at0);
    expect(bars).toEqual([{ top: 117, left: 20, width: 100 }, { top: 117, left: 200, width: 120 }]);
  });

  it('drops empty fragments (collapsed whitespace, a hidden row)', () => {
    expect(liveLineBars([box(20, 100, 20, 118), box(30, 100, 90, 100), box(0, 0, 0, 0)], at0)).toEqual([]);
  });

  it('clip: a line scrolled out of sight has no bar; one crossing a side is trimmed', () => {
    const clip = box(50, 110, 400, 300);
    const bars = liveLineBars([box(20, 80, 300, 98), box(20, 120, 500, 138)], at0, clip);
    expect(bars).toEqual([{ top: 137, left: 50, width: 350 }]);
    // The line's bottom edge decides: on the clip's bottom it shows, past it it does not.
    expect(liveLineBars([box(60, 282, 200, 300)], at0, clip)).toHaveLength(1);
    expect(liveLineBars([box(60, 282 + LIVE_BAR_HEIGHT, 200, 300 + LIVE_BAR_HEIGHT)], at0, clip)).toHaveLength(0);
    expect(liveLineBars([box(60, 92, 200, 110)], at0, clip)).toHaveLength(1);
    expect(liveLineBars([box(60, 91, 200, 109)], at0, clip)).toHaveLength(0);
  });

  it('a sliver left by the clip is no bar', () => {
    expect(liveLineBars([box(20, 120, 51, 138)], at0, box(50, 0, 400, 400))).toEqual([]);
  });
});

describe('markHighlightName', () => {
  it('a live mark wears the live name whatever its done state; the others are unchanged', () => {
    expect(markHighlightName(214, false, true, true)).toBe('thread-mark-live-neutral');
    expect(markHighlightName(214, true, true, true)).toBe('thread-mark-live-neutral');
    expect(markHighlightName(214, false, false, true)).toBe('thread-mark-live-214');
    expect(markHighlightName(214, false, true)).toBe('thread-mark-neutral');
    expect(markHighlightName(214, true, true)).toBe('thread-mark-done-neutral');
    expect(markHighlightName(214, false)).toBe('thread-mark-214');
    expect(markHighlightName(214, true)).toBe('thread-mark-done-214');
  });
});
