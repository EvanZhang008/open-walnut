import { describe, it, expect } from 'vitest';
import {
  WEEK_STARTS_ON,
  SLOT_MINUTES,
  formatDateOnly,
  formatLocalIso,
  startOfDay,
  addDays,
  sameDay,
  minutesOfDay,
  dayOf,
  slotToLocalIso,
  isoToSlot,
  snapMinutes,
  weekRange,
  monthGridRange,
  viewRange,
  layoutDayEvents,
} from '../../web/src/utils/calendar-date';

/**
 * Contract these lock down: calendar values are tz-less LOCAL wall-time
 * strings ("YYYY-MM-DD" / "YYYY-MM-DDTHH:MM:SS"). A timezone suffix leaking
 * into a stored start_date would shift every render in UTC-negative zones —
 * the exact bug parseDateLocal exists to prevent.
 */
const TZLESS = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/; // src/core/quick-task-parse.ts contract

describe('formatting', () => {
  it('formats tz-less strings that match the quick-parse contract regex', () => {
    const d = new Date(2026, 7, 5, 9, 30, 0);
    expect(formatDateOnly(d)).toBe('2026-08-05');
    expect(formatLocalIso(d)).toBe('2026-08-05T09:30:00');
    expect(formatDateOnly(d)).toMatch(TZLESS);
    expect(formatLocalIso(d)).toMatch(TZLESS);
  });

  it('pads single-digit fields', () => {
    expect(formatLocalIso(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02T03:04:05');
  });
});

describe('slot ↔ iso round-trips', () => {
  it('round-trips every slot of a day', () => {
    for (let slot = 0; slot < (24 * 60) / SLOT_MINUTES; slot++) {
      const iso = slotToLocalIso('2026-08-05', slot);
      expect(iso).toMatch(TZLESS);
      expect(isoToSlot(iso)).toBe(slot);
      expect(dayOf(iso)).toBe('2026-08-05');
    }
  });

  it('midnight and last slot', () => {
    expect(slotToLocalIso('2026-08-05', 0)).toBe('2026-08-05T00:00:00');
    expect(slotToLocalIso('2026-08-05', 47)).toBe('2026-08-05T23:30:00');
  });

  it('clamps out-of-range slots instead of rolling the day', () => {
    expect(slotToLocalIso('2026-08-05', -3)).toBe('2026-08-05T00:00:00');
    expect(slotToLocalIso('2026-08-05', 999)).toBe('2026-08-05T23:30:00');
  });

  it('isoToSlot floors mid-slot times into the containing row', () => {
    expect(isoToSlot('2026-08-05T09:00:00')).toBe(18);
    expect(isoToSlot('2026-08-05T09:15:00')).toBe(18);
    expect(isoToSlot('2026-08-05T09:29:59')).toBe(18);
    expect(isoToSlot('2026-08-05T09:30:00')).toBe(19);
  });

  it('date-only strings land in slot 0 with 0 minutes', () => {
    expect(minutesOfDay('2026-08-05')).toBe(0);
    expect(isoToSlot('2026-08-05')).toBe(0);
  });

  it('snapMinutes snaps to 15 and clamps within the day', () => {
    expect(snapMinutes(0)).toBe(0);
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(9 * 60 + 22)).toBe(9 * 60 + 15);
    expect(snapMinutes(24 * 60 + 500)).toBe(24 * 60 - 15);
  });
});

describe('day helpers', () => {
  it('startOfDay / addDays / sameDay use local fields (DST-safe)', () => {
    const d = new Date(2026, 2, 8, 15, 30); // a US spring-forward date
    expect(formatLocalIso(startOfDay(d))).toBe('2026-03-08T00:00:00');
    expect(formatDateOnly(addDays(d, 1))).toBe('2026-03-09');
    expect(sameDay(d, startOfDay(d))).toBe(true);
    expect(sameDay(d, addDays(d, 1))).toBe(false);
  });

  it('addDays crosses month/year boundaries', () => {
    expect(formatDateOnly(addDays(new Date(2026, 11, 31), 1))).toBe('2027-01-01');
    expect(formatDateOnly(addDays(new Date(2026, 0, 1), -1))).toBe('2025-12-31');
  });
});

describe('weekRange (Monday start)', () => {
  it('is configured for Monday', () => {
    expect(WEEK_STARTS_ON).toBe(1);
  });

  it('Sunday belongs to the week that STARTED the previous Monday', () => {
    // 2026-08-02 is a Sunday
    const days = weekRange(new Date(2026, 7, 2));
    expect(formatDateOnly(days[0])).toBe('2026-07-27');
    expect(formatDateOnly(days[6])).toBe('2026-08-02');
  });

  it('a Monday anchors its own week; always 7 consecutive days', () => {
    const days = weekRange(new Date(2026, 7, 3)); // Monday
    expect(formatDateOnly(days[0])).toBe('2026-08-03');
    expect(days).toHaveLength(7);
    for (let i = 1; i < 7; i++) expect(sameDay(days[i], addDays(days[0], i))).toBe(true);
  });
});

describe('monthGridRange', () => {
  it('covers the whole month in full Monday-start weeks', () => {
    const weeks = monthGridRange(new Date(2026, 7, 15)); // Aug 2026: Sat 1st … Mon 31st
    expect(formatDateOnly(weeks[0][0])).toBe('2026-07-27');
    expect(formatDateOnly(weeks[weeks.length - 1][6])).toBe('2026-09-06');
    expect(weeks).toHaveLength(6);
    for (const w of weeks) expect(w).toHaveLength(7);
  });

  it('leap February starting on its week-start day packs tight', () => {
    // Feb 2027 starts Monday and has 28 days → exactly 4 rows
    const weeks = monthGridRange(new Date(2027, 1, 10));
    expect(weeks).toHaveLength(4);
    expect(formatDateOnly(weeks[0][0])).toBe('2027-02-01');
    expect(formatDateOnly(weeks[3][6])).toBe('2027-02-28');
    // Feb 2028 (leap year, 29 days, starts Tuesday) → 5 rows
    const leap = monthGridRange(new Date(2028, 1, 29));
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(formatDateOnly(leap[leap.length - 1][6]).startsWith('2028-03')).toBe(true);
  });
});

describe('viewRange', () => {
  it('day view is a single-day range', () => {
    expect(viewRange('day', new Date(2026, 7, 5))).toEqual({ from: '2026-08-05', to: '2026-08-05' });
  });
  it('week view spans Monday..Sunday', () => {
    expect(viewRange('week', new Date(2026, 7, 5))).toEqual({ from: '2026-08-03', to: '2026-08-09' });
  });
  it('month view spans the padded grid', () => {
    expect(viewRange('month', new Date(2026, 7, 5))).toEqual({ from: '2026-07-27', to: '2026-09-06' });
  });
});

describe('layoutDayEvents overlap lanes', () => {
  const place = (items: Parameters<typeof layoutDayEvents>[0]) => {
    const m = layoutDayEvents(items);
    return Object.fromEntries([...m.entries()].map(([id, p]) => [id, [p.lane, p.laneCount]]));
  };

  it('non-overlapping events all get the full width', () => {
    expect(
      place([
        { id: 'a', startMin: 540, endMin: 600 },
        { id: 'b', startMin: 600, endMin: 660 },
      ])
    ).toEqual({ a: [0, 1], b: [0, 1] });
  });

  it('two overlapping events split into two lanes', () => {
    expect(
      place([
        { id: 'a', startMin: 540, endMin: 660 },
        { id: 'b', startMin: 570, endMin: 630 },
      ])
    ).toEqual({ a: [0, 2], b: [1, 2] });
  });

  it('lane is reused after an event ends, and the whole cluster shares laneCount', () => {
    // a 9-11, b 9:30-10, c 10-12: c reuses b's lane; all transitively overlap → count 2
    expect(
      place([
        { id: 'a', startMin: 540, endMin: 660 },
        { id: 'b', startMin: 570, endMin: 600 },
        { id: 'c', startMin: 600, endMin: 720 },
      ])
    ).toEqual({ a: [0, 2], b: [1, 2], c: [1, 2] });
  });

  it('independent clusters do not inflate each other', () => {
    expect(
      place([
        { id: 'a', startMin: 540, endMin: 600 },
        { id: 'b', startMin: 550, endMin: 610 },
        { id: 'c', startMin: 560, endMin: 620 },
        { id: 'z', startMin: 900, endMin: 960 },
      ])
    ).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3], z: [0, 1] });
  });

  it('handles empty input', () => {
    expect(layoutDayEvents([]).size).toBe(0);
  });
});
