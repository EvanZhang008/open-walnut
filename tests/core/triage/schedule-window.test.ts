/**
 * The interval and active-hours parsers config.triage reads
 * (src/core/triage/schedule-window.ts; they came from the removed heartbeat).
 */
import { describe, it, expect } from 'vitest';
import { parseDuration, isWithinActiveHours } from '../../../src/core/triage/schedule-window.js';

// ── parseDuration ──

describe('parseDuration', () => {
  it('parses minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('5m')).toBe(5 * 60_000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses combined hours and minutes', () => {
    expect(parseDuration('1h30m')).toBe(90 * 60_000);
  });

  it('parses seconds', () => {
    expect(parseDuration('10s')).toBe(10_000);
  });

  it('returns 0 for disable strings', () => {
    expect(parseDuration('0')).toBe(0);
    expect(parseDuration('0m')).toBe(0);
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration('')).toBe(0);
  });

  it('treats bare number as minutes', () => {
    expect(parseDuration('15')).toBe(15 * 60_000);
  });
});

// ── isWithinActiveHours ──

describe('isWithinActiveHours', () => {
  it('returns true when no activeHours is configured', () => {
    expect(isWithinActiveHours()).toBe(true);
    expect(isWithinActiveHours(undefined)).toBe(true);
  });

  it('returns true when current time is within range', () => {
    const now = new Date();
    const h = now.getHours();
    // Create a range that includes the current hour
    const start = `${String(h).padStart(2, '0')}:00`;
    const end = `${String((h + 2) % 24).padStart(2, '0')}:00`;
    expect(isWithinActiveHours(`${start}-${end}`)).toBe(true);
  });

  it('returns false when current time is outside range', () => {
    const now = new Date();
    const h = now.getHours();
    // Create a range that excludes the current hour (2-3 hours ago)
    const start = `${String((h + 22) % 24).padStart(2, '0')}:00`;
    const end = `${String((h + 23) % 24).padStart(2, '0')}:00`;
    expect(isWithinActiveHours(`${start}-${end}`)).toBe(false);
  });

  it('returns true for invalid format (graceful fallback)', () => {
    expect(isWithinActiveHours('invalid')).toBe(true);
  });
});

// ── isWithinActiveHours edge cases ──

describe('isWithinActiveHours edge cases', () => {
  it('handles overnight range (e.g. 22:00-06:00)', () => {
    const now = new Date();
    const h = now.getHours();

    // Create an overnight range that includes midnight
    if (h >= 22 || h < 6) {
      // Current hour is in the overnight range
      expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    } else {
      // Current hour is outside the overnight range
      expect(isWithinActiveHours('22:00-06:00')).toBe(false);
    }
  });

  it('handles single-hour ranges', () => {
    const now = new Date();
    const h = now.getHours();
    const start = `${String(h).padStart(2, '0')}:00`;
    // End is EXCLUSIVE, so HH:59 excludes the 59th minute — this assertion used
    // to fail for one minute in every hour (caught at 22:59). Use the top of the
    // next hour so the range covers the whole current hour whatever the minute.
    const end = `${String((h + 1) % 24).padStart(2, '0')}:00`;
    expect(isWithinActiveHours(`${start}-${end}`)).toBe(true);
  });

  it('handles exact boundary (end time exclusive)', () => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    // End time equals current time — should be false (end is exclusive)
    const end = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const start = `${String((h + 23) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    // Range from 23 hours ago to exactly now — current time = end → false
    expect(isWithinActiveHours(`${start}-${end}`)).toBe(false);
  });
});
