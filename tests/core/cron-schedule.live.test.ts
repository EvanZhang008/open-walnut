/**
 * Live tests for cron schedule computation.
 *
 * Tests real croner scheduling without mocks. These verify the actual
 * croner library integration with real timestamps and timezones.
 *
 * Run with: WALNUT_LIVE_TEST=1 npx vitest run tests/core/cron-schedule.live.test.ts --config vitest.live.config.ts
 */
import { describe, it, expect } from 'vitest';
import { isLiveTest } from '../helpers/live.js';
import { computeNextRunAtMs } from '../../src/core/cron/schedule.js';

describe.skipIf(!isLiveTest())('cron schedule live', () => {
  // These test real time-based scheduling, not mocked

  it('every schedule fires at correct intervals', () => {
    const now = Date.now();
    const schedule = { kind: 'every' as const, everyMs: 5000, anchorMs: now };
    const next = computeNextRunAtMs(schedule, now);
    expect(next).toBe(now + 5000);
  });

  it('every schedule with past anchor aligns to grid', () => {
    const now = Date.now();
    const anchor = now - 100_000; // 100s ago
    const everyMs = 30_000; // 30s intervals
    const schedule = { kind: 'every' as const, everyMs, anchorMs: anchor };
    const next = computeNextRunAtMs(schedule, now);
    expect(next).toBeDefined();
    // Next run should be in the future (or exactly now)
    expect(next!).toBeGreaterThanOrEqual(now);
    // Should be within one interval of now
    expect(next! - now).toBeLessThanOrEqual(everyMs);
    // Should be aligned to the anchor grid
    expect((next! - anchor) % everyMs).toBe(0);
  });

  it('cron expression matches real system timezone', () => {
    const now = Date.now();
    // Every minute expression
    const schedule = { kind: 'cron' as const, expr: '* * * * *' };
    const next = computeNextRunAtMs(schedule, now);
    expect(next).toBeDefined();
    // Next run should be within the next 60 seconds
    expect(next! - now).toBeLessThanOrEqual(60_000);
    expect(next! - now).toBeGreaterThanOrEqual(0);
  });

  it('cron expression with explicit timezone', () => {
    const now = Date.now();
    const schedule = { kind: 'cron' as const, expr: '0 9 * * *', tz: 'America/New_York' };
    const next = computeNextRunAtMs(schedule, now);
    expect(next).toBeDefined();
    // The next 9 AM ET should be within 24 hours
    expect(next! - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

    // Verify the computed time is actually 9:00 AM in New York timezone
    const nextDate = new Date(next!);
    const nyHour = parseInt(
      nextDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }),
    );
    expect(nyHour).toBe(9);
  });

  it('cron expression with UTC timezone', () => {
    const now = Date.now();
    const schedule = { kind: 'cron' as const, expr: '0 12 * * *', tz: 'UTC' };
    const next = computeNextRunAtMs(schedule, now);
    expect(next).toBeDefined();
    // Should be within 24 hours
    expect(next! - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

    // Verify the computed time is actually 12:00 UTC
    const nextDate = new Date(next!);
    expect(nextDate.getUTCHours()).toBe(12);
    expect(nextDate.getUTCMinutes()).toBe(0);
  });

  it('at schedule with future ISO string', () => {
    const futureMs = Date.now() + 3600_000; // 1 hour from now
    const schedule = { kind: 'at' as const, at: new Date(futureMs).toISOString() };
    const next = computeNextRunAtMs(schedule, Date.now());
    expect(next).toBeDefined();
    // Should be approximately 1 hour from now (within 1 second tolerance)
    expect(Math.abs(next! - futureMs)).toBeLessThan(1000);
  });

  it('at schedule with past ISO string returns undefined', () => {
    const pastMs = Date.now() - 3600_000; // 1 hour ago
    const schedule = { kind: 'at' as const, at: new Date(pastMs).toISOString() };
    const next = computeNextRunAtMs(schedule, Date.now());
    expect(next).toBeUndefined();
  });

  it('cron expression with day-of-week constraint', () => {
    const now = Date.now();
    // Every Monday at 10 AM
    const schedule = { kind: 'cron' as const, expr: '0 10 * * 1' };
    const next = computeNextRunAtMs(schedule, now);
    expect(next).toBeDefined();
    // Should be within the next 7 days
    expect(next! - now).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    // Verify it's a Monday (0=Sunday, 1=Monday)
    const nextDate = new Date(next!);
    expect(nextDate.getDay()).toBe(1);
  });

  it('cron expression every 5 minutes', () => {
    const now = Date.now();
    const schedule = { kind: 'cron' as const, expr: '*/5 * * * *' };
    const next = computeNextRunAtMs(schedule, now);
    expect(next).toBeDefined();
    // Should be within the next 5 minutes
    expect(next! - now).toBeLessThanOrEqual(5 * 60_000);
    // The minute should be a multiple of 5
    const nextDate = new Date(next!);
    expect(nextDate.getMinutes() % 5).toBe(0);
  });
});
