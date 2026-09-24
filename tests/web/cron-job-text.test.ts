import { describe, expect, it } from 'vitest';
import type { SessionCronJob } from '../../src/core/types';
import { cronPillTitle, cronPromptPreview, formatCronClock, formatCronDistance } from '../../web/src/utils/cron-job-text';

// A local-time noon so day boundaries do not depend on the runner's zone.
const now = new Date(2026, 8, 15, 12, 0).getTime();
const hour = 3_600_000;
const day = 24 * hour;

const job = (over: Partial<SessionCronJob> = {}): SessionCronJob => ({
  id: '41935620', cron: '23 9 * * *', schedule: 'Every day at 9:23 AM', prompt: 'Daily disk inspection', promptTruncated: false,
  recurring: true, durable: false, createdAt: now - hour, nextRunAt: now + day - 2 * hour - 37 * 60_000, expiresAt: now + 6 * day, ...over,
});

describe('cron job text', () => {
  it('names today, tomorrow and yesterday, then falls back to a dated form', () => {
    expect(formatCronClock(now + hour, now)).toMatch(/^Today 1:00/);
    expect(formatCronClock(now + 13 * hour, now)).toMatch(/^Tomorrow 1:00/);
    expect(formatCronClock(now - 13 * hour, now)).toMatch(/^Yesterday 11:00/);
    expect(formatCronClock(now + 3 * day, now)).toMatch(/^Fri, Sep 18, 12:00/);
  });

  it('describes distance in the largest two units and marks a passed minute as due', () => {
    expect(formatCronDistance(now + 30_000, now)).toBe('in under a minute');
    expect(formatCronDistance(now + 3 * 60_000, now)).toBe('in 3m');
    expect(formatCronDistance(now + 12 * hour + 40 * 60_000, now)).toBe('in 12h 40m');
    expect(formatCronDistance(now + 2 * day + 5 * hour, now)).toBe('in 2d 5h');
    expect(formatCronDistance(now - 30_000, now)).toBe('due now');
    expect(formatCronDistance(now - 2 * hour, now)).toBe('2h 0m ago');
  });

  it('previews the first non-empty prompt line and trims long ones', () => {
    expect(cronPromptPreview(null)).toBe('');
    expect(cronPromptPreview('\n\n  Second line is first  \nmore')).toBe('Second line is first');
    const long = 'word '.repeat(40);
    const preview = cronPromptPreview(long, 40);
    expect(preview.length).toBe(40);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('builds a pill title from the first job and counts the rest', () => {
    expect(cronPillTitle(undefined, now)).toContain("host's daemon");
    expect(cronPillTitle([], now)).toBe('Confirmed cron job.');
    expect(cronPillTitle([job()], now)).toMatch(/^Cron job: Every day at 9:23 AM\. Next run Tomorrow 9:23 AM \(in 21h 23m\)\.$/);
    expect(cronPillTitle([job({ schedule: null, nextRunAt: null }), job({ id: 'b' }), job({ id: 'c' })], now))
      .toBe('Cron job: 23 9 * * *. 2 more jobs.');
  });
});
