/**
 * The Usage & Costs chart's data: a breakdown's per-day costs laid over every day
 * of the period, the biggest lines drawn and the rest folded into "Other", weeks
 * past three months, and a curve that never dips below a zero day.
 */
import { describe, expect, it } from 'vitest';
import type { CostGroup, CostLine } from '../../web/src/api/usage';
import {
  autoGranularity, bucketsFor, buildBreakdown, coverageOf, MAX_SERIES, monotonePath, niceTicks, OTHER_KEY, periodDays,
} from '../../web/src/components/usage/breakdown-model';

const line = (key: string, costUsd: number, label = key): CostLine => ({
  key, label, costUsd, requests: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, unpriced: 0,
});

describe('usage breakdown model', () => {
  it('lays each line over every day of the period, empty days at zero', () => {
    const group: CostGroup = {
      id: 'agent', heading: 'By agent', lines: [line('claude', 30, 'Claude Code'), line('walnut', 6, 'Walnut')],
      daily: [
        { date: '2026-10-20', costs: { claude: 10, walnut: 6 } },
        { date: '2026-10-22', costs: { claude: 20 } },
        { date: '2026-09-01', costs: { claude: 99 } }, // outside the period: ignored
      ],
    };
    const b = buildBreakdown(group, periodDays('2026-10-20', '2026-10-22'));
    expect(b.granularity).toBe('day');
    expect(b.buckets.map((x) => x.label)).toEqual(['Oct 20', 'Oct 21', 'Oct 22']);
    expect(b.series.map((s) => [s.label, s.values])).toEqual([['Claude Code', [10, 0, 20]], ['Walnut', [6, 0, 0]]]);
    // An agent keeps its own color whatever else is in the period.
    expect(b.series.map((s) => s.color)).toEqual(['var(--usage-s1)', 'var(--usage-s6)']);
    expect(b.rows.map((r) => Math.round(r.share))).toEqual([83, 17]);
  });

  it('draws the biggest lines and folds the rest into one Other layer, while the table keeps them all', () => {
    const lines = Array.from({ length: 8 }, (_, i) => line(`p${i}`, 80 - i * 10));
    const group: CostGroup = { id: 'project', heading: 'By project', lines,
      daily: [{ date: '2026-10-01', costs: Object.fromEntries(lines.map((l) => [l.key, l.costUsd])) }] };
    const b = buildBreakdown(group, ['2026-10-01']);
    expect(b.series).toHaveLength(MAX_SERIES + 1);
    const other = b.series[MAX_SERIES];
    expect(other.key).toBe(OTHER_KEY);
    expect(other.label).toBe('Other (3)');
    expect(other.values).toEqual([30 + 20 + 10]);
    expect(b.rows).toHaveLength(8);
    expect(new Set(b.series.slice(0, MAX_SERIES).map((s) => s.color)).size).toBe(MAX_SERIES);
    expect(b.rows.slice(MAX_SERIES).every((r) => r.color === 'var(--usage-other)')).toBe(true);
  });

  it('goes by week past three months, the first week starting on the first day', () => {
    const days = periodDays('2026-06-03', '2026-10-31');
    expect(days).toHaveLength(151);
    expect(autoGranularity(days.length)).toBe('week');
    const buckets = bucketsFor(days);
    expect(buckets[0]).toEqual({ start: '2026-06-03', end: '2026-06-07', label: 'Week of Jun 3', short: 'Jun 3' }); // Wed to Sun
    expect(buckets[1].start).toBe('2026-06-08'); // a Monday
    expect(buckets.every((b, i) => i === 0 || new Date(`${b.start}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    expect(buckets.reduce((n, b) => n + (Date.parse(b.end) - Date.parse(b.start)) / 86_400_000 + 1, 0)).toBe(151);
    const group: CostGroup = { id: 'host', heading: 'By host', lines: [line('__local__', 3)],
      daily: [{ date: '2026-06-03', costs: { __local__: 1 } }, { date: '2026-06-07', costs: { __local__: 2 } }] };
    expect(buildBreakdown(group, days).series[0].values[0]).toBe(3);
  });

  it('goes by calendar month, naming the year where the axis crosses one', () => {
    const days = periodDays('2025-11-15', '2026-02-10');
    const months = bucketsFor(days, 'month');
    expect(months.map((b) => [b.start, b.end, b.label, b.short])).toEqual([
      ['2025-11-15', '2025-11-30', 'Nov 2025', "Nov '25"], ['2025-12-01', '2025-12-31', 'Dec 2025', 'Dec'],
      ['2026-01-01', '2026-01-31', 'Jan 2026', "Jan '26"], ['2026-02-01', '2026-02-10', 'Feb 2026', 'Feb']]);
    expect(bucketsFor(periodDays('2026-03-01', '2026-04-30'), 'month').map((b) => b.short)).toEqual(['Mar', 'Apr']);
    expect(autoGranularity(731)).toBe('month');
    expect(autoGranularity(92)).toBe('day');
    // A line's days add up into its month.
    const group: CostGroup = { id: 'model', heading: 'By model', lines: [line('m', 6)],
      daily: [{ date: '2025-12-02', costs: { m: 1 } }, { date: '2025-12-30', costs: { m: 2 } }, { date: '2026-01-01', costs: { m: 3 } }] };
    expect(buildBreakdown(group, days, undefined, 'month').series[0].values).toEqual([0, 3, 3, 0]);
  });

  it('keeps fixed colors for token types and kinds of work, whatever their rank', () => {
    const tokens: CostGroup = { id: 'token', heading: 'By token type', daily: [],
      lines: [line('input', 9, 'Input'), line('cacheRead', 5, 'Cache read'), line('output', 2, 'Output')] };
    expect(buildBreakdown(tokens, ['2026-10-01']).rows.map((r) => [r.line.key, r.color]))
      .toEqual([['input', 'var(--usage-s5)'], ['cacheRead', 'var(--usage-s1)'], ['output', 'var(--usage-s3)']]);
    const kinds: CostGroup = { id: 'kind', heading: 'By kind of work', daily: [],
      lines: [line('routine', 9), line('interactive', 5), line('walnut', 1)] };
    expect(buildBreakdown(kinds, ['2026-10-01']).rows.map((r) => r.color)).toEqual(['var(--usage-s3)', 'var(--usage-s1)', 'var(--usage-s6)']);
  });

  it('says how much of a bucket is stored: nothing before the first stored day, part of the one that holds it', () => {
    const weeks = bucketsFor(periodDays('2026-04-20', '2026-05-17'), 'week');
    expect(weeks.map((b) => coverageOf(b, '2026-04-30'))).toEqual(['none', 'partial', 'full', 'full']);
    expect(coverageOf(weeks[3], '2026-04-30', true)).toBe('reading');
    expect(coverageOf(weeks[0], undefined)).toBe('none');
  });

  it('keeps an empty period and a missing group empty', () => {
    expect(periodDays(undefined, '2026-10-31')).toEqual([]);
    expect(buildBreakdown(undefined, ['2026-10-31'])).toMatchObject({ series: [], rows: [] });
  });

  it('puts every axis tick on a round step: 1, 2 or 5 times a power of ten', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(1_407.81)).toEqual([0, 500, 1_000, 1_500]);
    expect(niceTicks(24_000)).toEqual([0, 10_000, 20_000, 30_000]);
    expect(niceTicks(3_603)).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
    expect(niceTicks(0.37)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(niceTicks(2_000)).toEqual([0, 500, 1_000, 1_500, 2_000]);
  });

  it('draws a smooth curve that never overshoots a zero day', () => {
    // Screen y grows downward: 100 is the baseline (zero), 0 the top.
    const pts: [number, number][] = [[0, 100], [10, 20], [20, 100], [30, 100], [40, 30]];
    const d = monotonePath(pts);
    expect(d.startsWith('M0,100 C')).toBe(true);
    const ys = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]));
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(20);
    expect(monotonePath([[5, 5]], false)).toBe('L5,5');
  });
});
