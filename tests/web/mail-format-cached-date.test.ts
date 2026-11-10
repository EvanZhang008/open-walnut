/**
 * `formatMailTime` prints a date older than a week through a cached `Intl.DateTimeFormat`
 * (`cachedDateFormat`) instead of `toLocaleDateString`, which built a new formatter per row. The
 * text must not change by a single character, so every case here is graded against the old
 * expression itself, not against a written string.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedDateFormat, formatMailTime, resetCachedDateFormats } from '../../web/src/apps/mail/mail-format';
import { timeAgo } from '../../web/src/utils/time';

const OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
const DAY = 86_400_000;

/** The implementation before the cache, kept verbatim as the oracle. */
function oldFormatMailTime(sentAt: number): string {
  if (!Number.isFinite(sentAt) || sentAt <= 0) return '';
  const age = Date.now() - sentAt;
  if (age >= 7 * DAY) {
    return new Date(sentAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return timeAgo(new Date(sentAt).toISOString());
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
  resetCachedDateFormats();
});

describe('formatMailTime with a cached formatter', () => {
  const nows = [
    Date.parse('2026-09-05T12:00:00Z'), Date.parse('2026-01-01T00:05:00Z'), Date.parse('2026-12-31T23:55:00Z'),
    Date.parse('2024-02-29T08:00:00Z'), Date.parse('2026-11-10T16:00:00Z'),
  ];
  for (const now of nows) {
    it(`prints what toLocaleDateString printed, every stamp around ${new Date(now).toISOString()}`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      for (const stamp of stampsAround(now)) {
        // Twice: the first call fills the cache, the second reads it.
        expect(formatMailTime(stamp), String(stamp)).toBe(oldFormatMailTime(stamp));
        expect(formatMailTime(stamp), String(stamp)).toBe(oldFormatMailTime(stamp));
      }
    });
  }
});

describe('cachedDateFormat', () => {
  const locales = [undefined, 'en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP', 'zh-CN', 'ar-EG', 'he-IL', 'hi-IN']
  const zones = ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Asia/Tokyo',
    'Australia/Adelaide', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']
  const now = Date.parse('2026-11-10T16:00:00Z')

  it('formats exactly as toLocaleDateString does, in every locale and across time zone day edges', () => {
    for (const locale of locales) {
      for (const timeZone of zones) {
        const options = { ...OPTIONS, timeZone };
        for (const stamp of stampsAround(now).filter((one) => Number.isFinite(one) && one > 0)) {
          expect(cachedDateFormat(locale, options).format(stamp), `${locale} ${timeZone} ${stamp}`)
            .toBe(new Date(stamp).toLocaleDateString(locale, options));
        }
      }
    }
  });

  it('makes one formatter per locale and options and reuses it', () => {
    const first = cachedDateFormat('en-GB', OPTIONS);
    expect(cachedDateFormat('en-GB', { ...OPTIONS })).toBe(first);
    expect(cachedDateFormat('en-US', OPTIONS)).not.toBe(first);
    expect(cachedDateFormat('en-GB', { ...OPTIONS, timeZone: 'UTC' })).not.toBe(first);
    resetCachedDateFormats();
    expect(cachedDateFormat('en-GB', OPTIONS)).not.toBe(first);
  });
});
