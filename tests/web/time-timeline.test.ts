/**
 * Timeline tab (browser side) — the PURE axis geometry and color assignment.
 * No React, no DOM: everything the view decides about which hours to draw and
 * what color a task gets lives in these functions.
 */

import { describe, it, expect } from 'vitest';
import {
  AXIS_PAD_HOURS, HOUR_MIN, HOUR_PX, LABEL_MIN_PX, LEGEND_TOP_ROWS, MIN_AXIS_HOURS, MIN_BLOCK_PX,
  QUICK_TOUCH_MS, TASK_COLORS,
  axisRange, clockLabel, dayLabel, dayLengthMin, dayStartMs, formatDuration, groupLegend, hourLabel,
  minuteOfDay, planDrawMerge, shiftDate, taskColor, type LegendRow,
} from '@/components/settings/sections/time-timeline';

const DAY = 24 * HOUR_MIN;

/** A span in minutes-of-day. */
function span(startHour: number, endHour: number) {
  return { startMin: startHour * HOUR_MIN, endMin: endHour * HOUR_MIN };
}

describe('axisRange', () => {
  it('collapses to the tracked hours plus one hour of padding', () => {
    const range = axisRange([span(9, 18)], { lengthMin: DAY });
    expect(range.startMin).toBe((9 - AXIS_PAD_HOURS) * HOUR_MIN);
    expect(range.endMin).toBe((18 + AXIS_PAD_HOURS) * HOUR_MIN);
    expect(range.hours[0]).toBe(8);
    expect(range.hours.at(-1)).toBe(18);
  });

  it('never renders a day of emptiness around a single short block', () => {
    const range = axisRange([{ startMin: 14 * HOUR_MIN, endMin: 14 * HOUR_MIN + 3 }], { lengthMin: DAY });
    expect((range.endMin - range.startMin) / HOUR_MIN).toBe(MIN_AXIS_HOURS);
    expect(range.startMin).toBe(13 * HOUR_MIN);
  });

  it('clamps to the day rather than showing hours that do not exist', () => {
    const early = axisRange([span(0, 1)], { lengthMin: DAY });
    expect(early.startMin).toBe(0);
    const late = axisRange([span(23, 24)], { lengthMin: DAY });
    expect(late.endMin).toBe(DAY);
    expect((late.endMin - late.startMin) / HOUR_MIN).toBeGreaterThanOrEqual(MIN_AXIS_HOURS);
  });

  it('keeps the now-line inside the axis even when work stopped hours ago', () => {
    const range = axisRange([span(6, 7)], { lengthMin: DAY, nowMin: 22 * HOUR_MIN });
    expect(range.startMin).toBeLessThanOrEqual(6 * HOUR_MIN);
    expect(range.endMin).toBeGreaterThanOrEqual(22 * HOUR_MIN);
  });

  it('falls back to a working-hours window for a day with nothing on it', () => {
    const range = axisRange([], { lengthMin: DAY });
    expect(range.startMin).toBe(8 * HOUR_MIN);
    expect(range.endMin).toBe(18 * HOUR_MIN);
  });

  it('respects a short DST day', () => {
    const range = axisRange([span(20, 23)], { lengthMin: 23 * HOUR_MIN });
    expect(range.endMin).toBeLessThanOrEqual(23 * HOUR_MIN);
  });

  it('labels every hour it spans, ascending and gapless', () => {
    // 9-12 padded is 8-13: already past the minimum, so it is drawn as it is.
    const range = axisRange([span(9, 12)], { lengthMin: DAY });
    expect(range.hours).toEqual([8, 9, 10, 11, 12]);
    expect(range.hours.length).toBeGreaterThanOrEqual(MIN_AXIS_HOURS);
  });

  it('labels exactly the hours it spans once the span is wide enough', () => {
    const range = axisRange([span(9, 18)], { lengthMin: DAY });
    expect(range.hours).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });
});

describe('taskColor', () => {
  it('is stable for an id and drawn from the palette', () => {
    expect(taskColor('t_alpha')).toBe(taskColor('t_alpha'));
    expect(TASK_COLORS as readonly string[]).toContain(taskColor('t_alpha'));
  });

  it('separates ids that differ only in their last character', () => {
    const colors = new Set(['t_aa', 't_ab', 't_ac', 't_ad'].map(taskColor));
    expect(colors.size).toBeGreaterThan(1);
  });

  it('never hands a task a purple, which is the agent lane everywhere', () => {
    // Purple/magenta hues are reserved for agent time. Any palette entry with a
    // dominant blue+red and a weak green would read as "an agent ran this".
    for (const hex of TASK_COLORS) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const purple = b > 150 && r > 100 && g < Math.min(r, b) * 0.75;
      expect(purple, `${hex} reads as purple`).toBe(false);
    }
  });

  it('gives taskless time a neutral grey rather than a task hue', () => {
    expect(taskColor('')).toBe('var(--fg-muted)');
  });
});

describe('minuteOfDay', () => {
  const DATE = '2026-08-22';
  const start = dayStartMs(DATE);
  const length = dayLengthMin(DATE);

  it('converts a wall time on the day', () => {
    const iso = new Date(2026, 7, 22, 9, 30, 0, 0).toISOString();
    expect(minuteOfDay(iso, start, length)).toBe(9 * HOUR_MIN + 30);
  });

  it('reads a block clipped to the end of the day as the LAST minute, not zero', () => {
    // getHours() on the next midnight is 0, which drew a full-day block as a
    // sliver at the top of the axis.
    const nextMidnight = new Date(2026, 7, 23, 0, 0, 0, 0).toISOString();
    expect(minuteOfDay(nextMidnight, start, length)).toBe(length);
  });

  it('clamps instants outside the day instead of going negative', () => {
    expect(minuteOfDay(new Date(2026, 7, 21, 22, 0).toISOString(), start, length)).toBe(0);
    expect(minuteOfDay(new Date(2026, 7, 24, 3, 0).toISOString(), start, length)).toBe(length);
  });

  it('answers 0 for a torn timestamp rather than NaN geometry', () => {
    expect(minuteOfDay('', start, length)).toBe(0);
    expect(minuteOfDay('nope', start, length)).toBe(0);
  });
});

describe('day helpers', () => {
  it('walks the local calendar in both directions', () => {
    expect(shiftDate('2026-08-22', -1)).toBe('2026-08-21');
    expect(shiftDate('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('leaves a malformed date alone rather than inventing one', () => {
    expect(shiftDate('nope', 1)).toBe('nope');
    expect(dayLabel('nope')).toBe('nope');
    expect(Number.isNaN(dayStartMs('nope'))).toBe(true);
  });

  it('reports the real length of a local day', () => {
    expect([1380, DAY, 1500]).toContain(dayLengthMin('2026-08-22'));
  });
});

describe('labels', () => {
  it('formats a clock time', () => {
    expect(clockLabel(0)).toBe('12:00 AM');
    expect(clockLabel(9 * HOUR_MIN + 5)).toBe('9:05 AM');
    expect(clockLabel(12 * HOUR_MIN)).toBe('12:00 PM');
    expect(clockLabel(13 * HOUR_MIN + 45)).toBe('1:45 PM');
  });

  it('formats an hour tick', () => {
    expect(hourLabel(0)).toBe('12 AM');
    expect(hourLabel(8)).toBe('8 AM');
    expect(hourLabel(12)).toBe('Noon');
    expect(hourLabel(21)).toBe('9 PM');
  });

  it('keeps seconds visible so real short work never reads as "0m"', () => {
    expect(formatDuration(4_000)).toBe('4s');
    expect(formatDuration(90_000)).toBe('2m');
    expect(formatDuration(2 * 3_600_000 + 7 * 60_000)).toBe('2h 07m');
  });
});

describe('legend grouping', () => {
  const row = (title: string, ms: number): LegendRow => ({ taskId: `t_${title}`, title, ms });

  it('ranks by time and caps the visible rows', () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(`task ${i}`, (i + 1) * 10 * 60_000));
    const g = groupLegend(rows);
    expect(g.main).toHaveLength(LEGEND_TOP_ROWS);
    expect(g.main[0]!.ms).toBe(140 * 60_000); // biggest first
    expect(g.hidden).toHaveLength(6);
    expect(g.hiddenMs).toBe(g.hidden.reduce((a, r) => a + r.ms, 0));
  });

  it('collapses everything under two minutes into one group', () => {
    // The real day that broke this: three destinations plus a tail of 11s / 2s /
    // 1s touches, all printed as equals.
    const rows = [row('big', 40 * 60_000), row('mid', 5 * 60_000), row('a', 11_000), row('b', 2_000), row('c', 1_000)];
    const g = groupLegend(rows);
    expect(g.main.map((r) => r.title)).toEqual(['big', 'mid']);
    expect(g.quick.map((r) => r.title)).toEqual(['a', 'b', 'c']);
    expect(g.quickMs).toBe(14_000);
    expect(g.hidden).toHaveLength(0);
  });

  it('counts a row exactly at the quick-touch line as real work', () => {
    const g = groupLegend([row('edge', QUICK_TOUCH_MS)]);
    expect(g.main).toHaveLength(1);
    expect(g.quick).toHaveLength(0);
  });

  it('never loses a row: main + hidden + quick is the whole input', () => {
    const rows = Array.from({ length: 21 }, (_, i) => row(`t${i}`, i * 30_000));
    const g = groupLegend(rows);
    expect(g.main.length + g.hidden.length + g.quick.length).toBe(21);
  });

  it('is stable for equal durations (title order), so rows never jitter', () => {
    const g = groupLegend([row('beta', 60_000 * 5), row('alpha', 60_000 * 5)]);
    expect(g.main.map((r) => r.title)).toEqual(['alpha', 'beta']);
  });
});

describe('dense-render geometry', () => {
  it('gives an hour real vertical room, so minutes are distinguishable', () => {
    // At 48px/hour a 30s touch is 0.4px. The whole density problem starts here.
    expect(HOUR_PX).toBeGreaterThanOrEqual(90);
  });

  it('keeps a floor under every block and a text threshold above it', () => {
    expect(MIN_BLOCK_PX).toBeGreaterThanOrEqual(8);
    // Text must need MORE room than the minimum block, otherwise an 8px sliver
    // renders a clipped "No ta…" over its own edges. It must also stay low
    // enough to label a 10-minute block (16px at this scale), or a real day of
    // 10-minute heartbeat slices renders as a wall of anonymous colour.
    expect(LABEL_MIN_PX).toBeGreaterThan(MIN_BLOCK_PX + 4);
    expect(LABEL_MIN_PX).toBeLessThanOrEqual(16);
  });
});

describe('planDrawMerge', () => {
  const item = (taskId: string, startMin: number, endMin: number, kind = 'session') =>
    ({ taskId, kind, startMin, endMin });

  it('folds same-task slivers whose inflated boxes would collide', () => {
    // Two 30s touches 90s apart: no overlap in MINUTES, but both draw 8px tall,
    // so on screen the second lands inside the first.
    const runs = planDrawMerge([item('t1', 600, 600.5), item('t1', 602, 602.5)]);
    expect(runs).toEqual([[0, 1]]);
  });

  it('leaves a real gap alone', () => {
    const runs = planDrawMerge([item('t1', 600, 600.5), item('t1', 640, 640.5)]);
    expect(runs).toEqual([[0], [1]]);
  });

  it('never folds two different tasks, however close they draw', () => {
    const runs = planDrawMerge([item('t1', 600, 600.5), item('t2', 600, 600.5)]);
    expect(runs).toHaveLength(2);
    expect(runs.flat().sort()).toEqual([0, 1]);
  });

  it('never folds across kinds', () => {
    const runs = planDrawMerge([item('t1', 600, 600.5), item('t1', 601, 601.5, 'chat')]);
    expect(runs).toHaveLength(2);
  });

  it('cannot bridge more than the inflation it exists to fix', () => {
    // The whole point: this pass may only hide a gap the 8px minimum invented,
    // never a real pause in the day. 6 minutes is beyond any inflated box.
    const runs = planDrawMerge([item('t1', 600, 600.5), item('t1', 606, 606.5)]);
    expect(runs).toEqual([[0], [1]]);
  });

  it('keeps every input exactly once and orders runs by start', () => {
    const items = [
      item('t1', 700, 700.5), item('t2', 600, 610), item('t1', 701, 701.5), item('t2', 620, 621),
    ];
    const runs = planDrawMerge(items);
    expect(runs.flat().slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(items[runs[0]![0]!]!.startMin).toBeLessThan(items[runs[1]![0]!]!.startMin);
  });

  it('grows a run transitively while the boxes keep touching', () => {
    const runs = planDrawMerge([
      item('t1', 600, 600.5), item('t1', 602, 602.5), item('t1', 604, 604.5),
    ]);
    expect(runs).toEqual([[0, 1, 2]]);
  });
});
