/**
 * The Routines card's one-line texts for a walnut-trigger check: what the daemon
 * reported, how long ago, and the command it runs. Pure functions, so the
 * awkward inputs (a missing timestamp, a delivery still retrying) are pinned
 * here rather than discovered on a card.
 */
import { describe, it, expect } from 'vitest';
import { describeAgo, describeCheck, describeLastCheck, describeSchedule } from '../../web/src/utils/routine-format';

const NOW = Date.parse('2026-09-16T12:00:00Z');

describe('describeAgo', () => {
  it('rounds to the unit a human would say', () => {
    expect(describeAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(describeAgo(NOW - 3 * 60_000, NOW)).toBe('3m ago');
    expect(describeAgo(NOW - 2 * 3_600_000, NOW)).toBe('2h ago');
    expect(describeAgo(NOW - 3 * 86_400_000, NOW)).toBe('3d ago');
  });

  it('never prints NaN for a missing or invalid timestamp', () => {
    expect(describeAgo(Number.NaN, NOW)).toBe('at an unknown time');
    expect(describeAgo(undefined as unknown as number, NOW)).toBe('at an unknown time');
  });
});

describe('describeLastCheck', () => {
  it('names each outcome with its count, reason, or error', () => {
    expect(describeLastCheck(undefined, NOW)).toBe('not checked yet');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'fired', items: 2 }, NOW)).toBe('fired, 2 items, 3m ago');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'fired', items: 1 }, NOW)).toBe('fired, 1 item, 3m ago');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'fired' }, NOW)).toBe('fired, 3m ago');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'quiet', reason: 'all-seen' }, NOW)).toBe('quiet, 3m ago');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'quiet', reason: 'rate-limited' }, NOW)).toBe('quiet (daily fire limit), 3m ago');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'error', error: 'exit 1: boom' }, NOW)).toBe('error: exit 1: boom, 3m ago');
  });

  it('says when a fire is still waiting on a retried delivery', () => {
    expect(describeLastCheck({ atMs: NOW - 60_000, outcome: 'fired', items: 3, retryPending: true, error: 'host unreachable' }, NOW))
      .toBe('fired, 3 items, delivery retrying, 1m ago');
  });

  it('clips a long error and flattens its whitespace', () => {
    const text = describeLastCheck({ atMs: NOW, outcome: 'error', error: `exit 2:\n  ${'x'.repeat(200)}` }, NOW);
    expect(text.startsWith('error: exit 2: xxx')).toBe(true);
    expect(text).toContain('…, just now');
    expect(text.length).toBeLessThan(120);
  });
});

describe('describeCheck', () => {
  it('shows the command and the host, "local" for the wire value', () => {
    expect(describeCheck({ run: 'gh pr view 1', host: '__local__' })).toBe('$ gh pr view 1 @ local');
    expect(describeCheck({ run: 'gh   pr\nview 1', host: 'devbox' })).toBe('$ gh pr view 1 @ devbox');
    expect(describeCheck({ run: 'x'.repeat(80), host: '__local__' })).toBe(`$ ${'x'.repeat(60)}… @ local`);
  });
});

describe('describeSchedule for an interval', () => {
  it('says seconds under a minute instead of rounding up to "1 min"', () => {
    expect(describeSchedule({ kind: 'every', everyMs: 30_000 })).toBe('Every 30s');
    expect(describeSchedule({ kind: 'every', everyMs: 10_000 })).toBe('Every 10s');
    expect(describeSchedule({ kind: 'every', everyMs: 300_000 })).toBe('Every 5 min');
    expect(describeSchedule({ kind: 'every', everyMs: 3_600_000 })).toBe('Every 1 hour');
  });
});
