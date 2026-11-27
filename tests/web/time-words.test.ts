/**
 * The shared ways to write a point in time (web/src/utils/time.ts): every screen reads the same
 * clock (12-hour, no seconds, no leading zero) and shows the year only when it is not this year.
 */
import { describe, it, expect } from 'vitest';
import { clockTime, dayDate, pointInTime, fullTime, lineStart, timeAgo } from '../../web/src/utils/time';

// Local times, so the test reads the same in any zone the runner has.
const NOW = new Date(2026, 10, 27, 15, 0).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);

describe('time words', () => {
  it('writes a clock without seconds or a leading zero', () => {
    expect(clockTime(at(2026, 11, 20, 21, 40))).toBe('9:40 PM');
    expect(clockTime(at(2026, 11, 20, 9, 5))).toBe('9:05 AM');
  });

  it('names a day in words near today, else by its date, the year only when not this year', () => {
    expect(dayDate(at(2026, 11, 27, 1, 0), { now: NOW })).toBe('today');
    expect(dayDate(at(2026, 11, 26, 23, 0), { now: NOW })).toBe('yesterday');
    expect(dayDate(at(2026, 11, 28, 8, 0), { now: NOW })).toBe('tomorrow');
    expect(dayDate(at(2026, 11, 20, 8, 0), { now: NOW })).toBe('Nov 20');
    expect(dayDate(at(2025, 11, 20, 8, 0), { now: NOW })).toBe('Nov 20, 2025');
  });

  it('writes a point in time as a day and its clock', () => {
    expect(pointInTime(at(2026, 11, 27, 1, 30), { now: NOW })).toBe('today 1:30 AM');
    expect(pointInTime(at(2026, 11, 30, 18, 0), { now: NOW })).toBe('Nov 30, 6:00 PM');
    expect(pointInTime(at(2025, 1, 2, 18, 0), { now: NOW })).toBe('Jan 2, 2025, 6:00 PM');
  });

  it('writes the whole time for a hover, always with its year', () => {
    expect(fullTime(at(2026, 11, 20, 21, 40))).toBe('Fri, Nov 20, 2026, 9:40 PM');
  });

  it('reads an ISO string, a number and a Date alike; empty or invalid reads as nothing', () => {
    const d = at(2026, 11, 20, 21, 40);
    expect(fullTime(d.toISOString())).toBe(fullTime(d));
    expect(fullTime(d.getTime())).toBe(fullTime(d));
    for (const v of ['', null, undefined, 'not a date']) {
      expect(clockTime(v)).toBe('');
      expect(dayDate(v)).toBe('');
      expect(pointInTime(v)).toBe('');
      expect(fullTime(v)).toBe('');
    }
  });

  it('goes to the second only when asked (rows of one list that share a minute)', () => {
    const d = new Date(2026, 10, 27, 9, 40, 12);
    expect(clockTime(d, { seconds: true })).toBe('9:40:12 AM');
    expect(pointInTime(d, { now: NOW, seconds: true })).toBe('today 9:40:12 AM');
  });

  it('starts a line with a capital', () => {
    expect(lineStart('today 9:40 PM')).toBe('Today 9:40 PM');
    expect(lineStart('')).toBe('');
  });

  it('reads an age from a number or a Date as from an ISO string, and nothing from NaN', () => {
    const d = new Date(NOW - 3 * 3_600_000);
    expect(timeAgo(d.getTime(), { now: NOW })).toBe('3h ago');
    expect(timeAgo(d, { now: NOW })).toBe(timeAgo(d.toISOString(), { now: NOW }));
    expect(timeAgo(NaN, { now: NOW })).toBe('');
  });
});
