/**
 * Per-view geometry. These are the rules that were violated by the rejected
 * column-packed render, so they are pinned as assertions rather than left to a
 * screenshot review: the tape stays strictly proportional, text is drawn only where
 * it fits, and a bar always has a visible minimum.
 */

import { describe, it, expect } from 'vitest';
import {
  CHAPTER_MAX_PX, CHAPTER_MIN_PX, CHAPTER_ZOOM_PX_PER_MIN, LANE_BAR_MIN_PX, LANE_ROWS,
  LANE_TRACK_PX, SEG_LABEL_PX, SEG_MIN_PX, SEG_RANGE_PX, TAPE_PX_PER_MIN,
  chapterHeightPx, laneBar, layoutTape, segLabel,
// The geometry now lives ONLY in the walnut-time Plugin App: the console section that
// used to hold a second copy is gone, so these assertions follow the surviving one.
} from '../../examples/plugins/walnut-time/src/web/time-views';

const MIN = 60_000;
const BASE = new Date(2026, 7, 23, 11, 0, 0, 0).getTime();

function slice(atMin: number, lenMin: number) {
  const start = BASE + atMin * MIN;
  return {
    startTs: new Date(start).toISOString(),
    endTs: new Date(start + lenMin * MIN).toISOString(),
  };
}

/** Minutes-of-day for the fixture base (11:00 = 660). */
const minuteOf = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
};
const AXIS_START = 11 * 60;

describe('layoutTape — the ribbon is proportional', () => {
  it('places a segment at its own minute and scales its height by duration', () => {
    const [seg] = layoutTape([slice(30, 20)], AXIS_START, minuteOf);
    expect(seg!.topPx).toBeCloseTo(30 * TAPE_PX_PER_MIN, 5);
    expect(seg!.heightPx).toBeCloseTo(20 * TAPE_PX_PER_MIN, 5);
  });

  it('never inflates a short slice past the floor', () => {
    // This is THE rule that keeps the ribbon attached to the hour ruler: an
    // inflated segment would have to push its neighbours down, and 20 of them
    // would drift the day by half an hour.
    const [seg] = layoutTape([slice(0, 0.5)], AXIS_START, minuteOf);
    expect(seg!.heightPx).toBe(SEG_MIN_PX);
    expect(SEG_MIN_PX).toBeLessThanOrEqual(3);
  });

  it('keeps consecutive segments in order and never overlaps beyond the floor', () => {
    const segs = layoutTape([slice(0, 10), slice(10, 10), slice(20, 5)], AXIS_START, minuteOf);
    for (let i = 1; i < segs.length; i++) {
      const prev = segs[i - 1]!;
      expect(segs[i]!.topPx).toBeGreaterThanOrEqual(prev.topPx + prev.heightPx - SEG_MIN_PX);
    }
  });

  it('marks a segment that continues the previous one', () => {
    const segs = layoutTape([slice(0, 10), slice(10, 5)], AXIS_START, minuteOf);
    expect(segs[0]!.hairline).toBe(false); // nothing above the first
    expect(segs[1]!.hairline).toBe(true);
  });

  it('does not mark a segment that follows real idle time', () => {
    const segs = layoutTape([slice(0, 10), slice(25, 5)], AXIS_START, minuteOf);
    expect(segs[1]!.hairline).toBe(false);
  });

  it('honours a zoom, so an expanded chapter can label its slices', () => {
    const [seg] = layoutTape([slice(0, 5)], AXIS_START, minuteOf, CHAPTER_ZOOM_PX_PER_MIN);
    expect(seg!.heightPx).toBeCloseTo(5 * CHAPTER_ZOOM_PX_PER_MIN, 5);
    // A five-minute slice is unlabelled on the day tape and labelled when zoomed:
    // the whole reason expanding a chapter is worth doing.
    expect(segLabel(5 * TAPE_PX_PER_MIN)).toBe(0);
    expect(seg!.label).toBeGreaterThan(0);
  });

  it('is empty for an empty ribbon', () => {
    expect(layoutTape([], AXIS_START, minuteOf)).toEqual([]);
  });
});

describe('segLabel — text only where it fits', () => {
  it('draws nothing in a box too small for a line of type', () => {
    expect(segLabel(SEG_MIN_PX)).toBe(0);
    expect(segLabel(SEG_LABEL_PX - 0.1)).toBe(0);
  });

  it('draws the title from the one-line threshold', () => {
    expect(segLabel(SEG_LABEL_PX)).toBe(1);
    expect(segLabel(SEG_RANGE_PX - 0.1)).toBe(1);
  });

  it('adds the clock range only when there is real room', () => {
    expect(segLabel(SEG_RANGE_PX)).toBe(2);
  });

  it('keeps the thresholds ordered and above the floor', () => {
    // A floor above the label threshold would put a clipped half-word in every
    // 30-second stripe, which is what the previous render did.
    expect(SEG_MIN_PX).toBeLessThan(SEG_LABEL_PX);
    expect(SEG_LABEL_PX).toBeLessThan(SEG_RANGE_PX);
  });
});

describe('chapterHeightPx — span with a readable floor', () => {
  it('scales with the span between the floor and the ceiling', () => {
    const short = chapterHeightPx(20 * MIN);
    const medium = chapterHeightPx(60 * MIN);
    expect(medium).toBeGreaterThan(short);
    expect(medium).toBeLessThanOrEqual(CHAPTER_MAX_PX);
  });

  it('never shrinks below the height the card text needs', () => {
    expect(chapterHeightPx(2 * MIN)).toBe(CHAPTER_MIN_PX);
    expect(chapterHeightPx(0)).toBe(CHAPTER_MIN_PX);
  });

  it('caps a marathon stretch instead of letting one chapter be the whole view', () => {
    expect(chapterHeightPx(6 * 60 * MIN)).toBe(CHAPTER_MAX_PX);
  });
});

describe('laneBar — horizontal geometry', () => {
  const axis = { startMin: 11 * 60, endMin: 17 * 60 };

  it('positions a bar as a share of the axis', () => {
    const bar = laneBar(12 * 60, 13 * 60, axis, { tick: false });
    expect(bar.leftPct).toBeCloseTo((60 / 360) * 100, 5);
    expect(bar.widthPct).toBeCloseTo((60 / 360) * 100, 5);
  });

  it('gives a sub-minute touch a visible minimum width', () => {
    const bar = laneBar(12 * 60, 12 * 60 + 0.5, axis, { tick: true });
    expect(bar.widthPct).toBeCloseTo((LANE_BAR_MIN_PX / LANE_TRACK_PX) * 100, 5);
    expect(bar.tick).toBe(true);
  });

  it('clamps a bar that starts before the axis rather than drawing off-card', () => {
    const bar = laneBar(10 * 60, 11 * 60 + 30, axis, { tick: false });
    expect(bar.leftPct).toBe(0);
  });

  it('caps the row count so twenty tasks cannot become twenty rows', () => {
    expect(LANE_ROWS).toBeGreaterThanOrEqual(5);
    expect(LANE_ROWS).toBeLessThanOrEqual(8);
  });
});
