/**
 * Chaptering — the fold that turns sixty slices into a story. Pure, so the rules
 * that decide where a day breaks and what a stretch is CALLED are pinned here
 * rather than being read off a screenshot.
 */

import { describe, it, expect } from 'vitest';
import {
  CHAPTER_GAP_MS, COMP_TOP_PARTS, FRAGMENTED_SHARE, QUICK_PART_MS,
  buildChapters, composition, type Sliceish,
} from '@/components/settings/sections/time-chapters';

const MIN = 60_000;
/** A fixed local wall-clock base, so no assertion depends on the machine's zone. */
const BASE = new Date(2026, 7, 23, 11, 0, 0, 0).getTime();

/** A slice `atMin` minutes into the day, `lenMin` long, fully tracked. */
function slice(taskId: string, atMin: number, lenMin: number): Sliceish {
  const start = BASE + atMin * MIN;
  return {
    taskId,
    startTs: new Date(start).toISOString(),
    endTs: new Date(start + lenMin * MIN).toISOString(),
    trackedMs: lenMin * MIN,
  };
}

describe('buildChapters — where a day breaks', () => {
  it('keeps back-to-back work in one chapter', () => {
    const chapters = buildChapters([slice('a', 0, 10), slice('a', 10, 10), slice('b', 20, 5)]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.workedMs).toBe(25 * MIN);
    expect(chapters[0]!.spanMs).toBe(25 * MIN);
  });

  it('splits on an idle gap over the threshold and records the idle time', () => {
    const chapters = buildChapters([slice('a', 0, 10), slice('a', 25, 10)]);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]!.idleBeforeMs).toBe(0);
    expect(chapters[1]!.idleBeforeMs).toBe(15 * MIN);
  });

  it('does NOT split on a gap at exactly the threshold', () => {
    // The rule is "longer than", so a 10-minute coffee is the same chapter. A
    // boundary that flips at exactly 10:00 would make two identical days chapter
    // differently for no reason a reader could see.
    const chapters = buildChapters([slice('a', 0, 10), slice('a', 10 + CHAPTER_GAP_MS / MIN, 10)]);
    expect(chapters).toHaveLength(1);
  });

  it("honours a caller's gap override", () => {
    const chapters = buildChapters([slice('a', 0, 10), slice('a', 15, 10)], { gapMs: 2 * MIN });
    expect(chapters).toHaveLength(2);
  });

  it('sorts defensively, so a shuffled ribbon does not invent gaps', () => {
    const chapters = buildChapters([slice('b', 20, 5), slice('a', 0, 10), slice('a', 10, 10)]);
    expect(chapters).toHaveLength(1);
  });

  it('never lets an overlapping slice fake a chapter break', () => {
    // A long slice with a short one inside it: the cursor must not move backwards,
    // or the gap after the short one looks like 30 idle minutes.
    const chapters = buildChapters([slice('a', 0, 40), slice('b', 5, 2), slice('a', 41, 5)]);
    expect(chapters).toHaveLength(1);
  });

  it('drops a slice with an unparseable timestamp instead of throwing', () => {
    const bad: Sliceish = { taskId: 'x', startTs: 'not-a-date', endTs: 'nope', trackedMs: MIN };
    const chapters = buildChapters([bad, slice('a', 0, 10)]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.parts.map((p) => p.taskId)).toEqual(['a']);
  });

  it('returns nothing for an empty day', () => {
    expect(buildChapters([])).toEqual([]);
  });
});

describe('buildChapters — what a chapter is called', () => {
  it('names the dominant task when it really dominated', () => {
    const ch = buildChapters([slice('a', 0, 30), slice('b', 30, 5)])[0]!;
    expect(ch.dominant!.taskId).toBe('a');
    expect(ch.fragmented).toBe(false);
    expect(ch.focused).toBe(true);
    expect(ch.dominant!.share).toBeCloseTo(30 / 35, 5);
  });

  it('refuses to name a chapter after a task that held under 40%', () => {
    // Three ways to spend 30 minutes, top share 1/3. Calling this "task a" would
    // claim a focus that did not happen.
    const ch = buildChapters([slice('a', 0, 10), slice('b', 10, 10), slice('c', 20, 10)])[0]!;
    expect(ch.dominant!.share).toBeLessThan(FRAGMENTED_SHARE);
    expect(ch.fragmented).toBe(true);
  });

  it('is not fragmented at exactly the threshold share', () => {
    // 40% of 25 minutes = 10. At the boundary the top task keeps the title.
    const ch = buildChapters([slice('a', 0, 10), slice('b', 10, 8), slice('c', 18, 7)])[0]!;
    expect(ch.dominant!.share).toBeCloseTo(0.4, 5);
    expect(ch.fragmented).toBe(false);
  });

  it('is not "focused" when the leader is merely ahead', () => {
    const ch = buildChapters([slice('a', 0, 10), slice('b', 10, 9)])[0]!;
    expect(ch.fragmented).toBe(false);
    expect(ch.focused).toBe(false);
  });

  it('ranks parts by time and keeps every slice accounted for', () => {
    const ch = buildChapters([slice('a', 0, 5), slice('b', 5, 12), slice('a', 17, 4)])[0]!;
    expect(ch.parts.map((p) => p.taskId)).toEqual(['b', 'a']);
    expect(ch.parts.reduce((sum, p) => sum + p.ms, 0)).toBe(ch.workedMs);
    expect(ch.parts.reduce((sum, p) => sum + p.share, 0)).toBeCloseTo(1, 5);
  });

  it('treats taskless time as a task of its own, not as missing data', () => {
    const ch = buildChapters([slice('', 0, 20), slice('a', 20, 5)])[0]!;
    expect(ch.dominant!.taskId).toBe('');
    expect(ch.fragmented).toBe(false);
  });
});

describe('composition — the bar always adds up', () => {
  it('names the top parts and aggregates the tail into one remainder', () => {
    const ch = buildChapters([
      slice('a', 0, 20), slice('b', 20, 10), slice('c', 30, 8), slice('d', 38, 6),
      slice('e', 44, 4), slice('f', 48, 3),
    ])[0]!;
    const segs = composition(ch);
    expect(segs.filter((s) => s.taskId !== null)).toHaveLength(COMP_TOP_PARTS);
    const rest = segs[segs.length - 1]!;
    expect(rest.taskId).toBeNull();
    expect(rest.count).toBe(2);
    expect(rest.ms).toBe(7 * MIN);
  });

  it('sums to the whole chapter', () => {
    const ch = buildChapters([
      slice('a', 0, 9), slice('b', 9, 7), slice('c', 16, 5), slice('d', 21, 3),
      slice('e', 24, 2), slice('f', 26, 1),
    ])[0]!;
    const segs = composition(ch);
    expect(segs.reduce((sum, s) => sum + s.ms, 0)).toBe(ch.workedMs);
    expect(segs.reduce((sum, s) => sum + s.pct, 0)).toBeCloseTo(100, 4);
  });

  it('has no remainder when everything fits', () => {
    const ch = buildChapters([slice('a', 0, 20), slice('b', 20, 10)])[0]!;
    expect(composition(ch).every((s) => s.taskId !== null)).toBe(true);
  });

  it('folds an invisible sliver into the remainder rather than drawing 1px of it', () => {
    // 10 seconds of a 40-minute chapter is 0.4% — a stripe nobody can see or hit.
    const ch = buildChapters([slice('a', 0, 40), { ...slice('b', 40, 1), trackedMs: 10_000 }])[0]!;
    const segs = composition(ch);
    expect(segs).toHaveLength(2);
    expect(segs[1]!.taskId).toBeNull();
    expect(segs[1]!.count).toBe(1);
  });

  it('flags an all-quick remainder, so the label can say "快碰" honestly', () => {
    const ch = buildChapters([
      slice('a', 0, 30), slice('b', 30, 6), slice('c', 36, 4), slice('d', 40, 3),
      slice('e', 43, 1), slice('f', 44, 1),
    ])[0]!;
    const rest = composition(ch).at(-1)!;
    expect(rest.taskId).toBeNull();
    expect(rest.allQuick).toBe(true);
    expect(rest.ms).toBeLessThan(2 * QUICK_PART_MS);
  });

  it('does not call the remainder quick when a real chunk is hiding in it', () => {
    const ch = buildChapters([
      slice('a', 0, 20), slice('b', 20, 15), slice('c', 35, 12), slice('d', 47, 10),
      slice('e', 57, 9), slice('f', 66, 8),
    ])[0]!;
    const rest = composition(ch).at(-1)!;
    expect(rest.allQuick).toBe(false);
  });
});
