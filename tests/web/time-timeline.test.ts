/**
 * Timeline tab (browser side) — the PURE axis geometry and color assignment.
 * No React, no DOM: everything the view decides about which hours to draw and
 * what color a task gets lives in these functions.
 */

import { describe, it, expect } from 'vitest';
import {
  AXIS_PAD_HOURS, HOUR_MIN, MIN_AXIS_HOURS, TASK_COLORS,
  axisRange, clockLabel, dayLabel, dayLengthMin, dayStartMs, formatDuration, hourLabel,
  minuteOfDay, shiftDate, taskColor,
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
    // 9-12 padded is 8-13, five hours — one short of the minimum, so the axis
    // grows downward to 8-14 and labels the six hours it now covers.
    const range = axisRange([span(9, 12)], { lengthMin: DAY });
    expect(range.hours).toEqual([8, 9, 10, 11, 12, 13]);
    expect(range.hours.length).toBe(MIN_AXIS_HOURS);
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
