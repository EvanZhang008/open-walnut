/**
 * `formatMailTime` keeps the words of a day older than a week per local day (the dense grouped
 * inbox's redraw spent 360 to 460 ms in it when every row built its own date formatter, a CPU
 * profile of 2026-11-10). The cache must never change the text: every case here is graded against
 * the shared helpers themselves (`timeAgo` inside the week, `dayDate` beyond it), twice per stamp.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatMailTime, resetMailDayCache } from '../../web/src/apps/mail/mail-format';
import { dayDate, timeAgo } from '../../web/src/utils/time';

const DAY = 86_400_000;

/** What the stamp must read as, with no cache in between. */
function expected(sentAt: number, now: number): string {
  if (!Number.isFinite(sentAt) || sentAt <= 0) return '';
  if (now - sentAt < 7 * DAY) return timeAgo(new Date(sentAt).toISOString(), { now });
  return dayDate(sentAt, { now });
}

/** Stamps around `now`: today, yesterday, this week, the 7-day edge, this year, past years, day and year edges. */
function stampsAround(now: number): number[] {
  const out = [
    now, now - 1, now - 59_000, now - 61_000, now - 3_600_000, now - 23 * 3_600_000,
    now - DAY, now - DAY - 1, now - 3 * DAY, now - 7 * DAY + 1, now - 7 * DAY, now - 7 * DAY - 1,
    now - 8 * DAY, now - 40 * DAY, now - 200 * DAY, now - 365 * DAY, now - 3 * 365 * DAY,
    Date.parse('1999-12-31T23:59:59Z'), Date.parse('2000-01-01T00:00:00Z'), Date.parse('2000-02-29T12:00:00Z'),
    Date.parse('2025-12-31T23:30:00Z'), Date.parse('2026-01-01T00:30:00Z'),
    Date.parse('2026-03-08T09:59:59Z'), Date.parse('2026-03-08T10:00:00Z'), // a US spring-forward hour
    Date.parse('2026-10-25T00:59:59Z'), Date.parse('2026-10-25T01:00:00Z'), // a European fall-back hour
    1, 0, -5, Number.NaN, Number.POSITIVE_INFINITY,
  ];
  // Every hour of one UTC day: wherever the local midnight falls, both sides of it are covered.
  for (let h = 0; h < 24; h++) out.push(Date.parse('2026-06-15T00:00:00Z') + h * 3_600_000 + 1_800_000);
  return out;
}

afterEach(() => {
  vi.useRealTimers();
  resetMailDayCache();
});

describe('formatMailTime with a cached day', () => {
  const nows = [
    Date.parse('2026-09-05T12:00:00Z'), Date.parse('2026-01-01T00:05:00Z'), Date.parse('2026-12-31T23:55:00Z'),
    Date.parse('2024-02-29T08:00:00Z'), Date.parse('2026-11-10T16:00:00Z'),
  ];
  for (const now of nows) {
    it(`prints what the shared helpers print, every stamp around ${new Date(now).toISOString()}`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      for (const stamp of stampsAround(now)) {
        // Twice: the first call fills the cache, the second reads it.
        expect(formatMailTime(stamp), String(stamp)).toBe(expected(stamp, now));
        expect(formatMailTime(stamp), String(stamp)).toBe(expected(stamp, now));
      }
    });
  }

  it('a cached day follows the clock into the next year', () => {
    vi.useFakeTimers();
    const stamp = Date.parse('2026-06-15T12:00:00Z');
    vi.setSystemTime(Date.parse('2026-12-31T12:00:00Z'));
    const thisYear = formatMailTime(stamp);
    expect(thisYear).not.toContain('2026');
    vi.setSystemTime(Date.parse('2027-01-02T12:00:00Z'));
    expect(formatMailTime(stamp)).toBe(`${thisYear}, 2026`);
  });
});
