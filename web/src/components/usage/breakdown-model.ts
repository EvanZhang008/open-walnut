/**
 * The Usage & Costs chart's data: one breakdown (agent, model, project or host)
 * laid over the period's days, its biggest lines as stacked series and the rest
 * as "Other". Long periods go by week so the curve stays readable.
 */
import type { CostGroup, CostLine } from '@/api/usage';

export type BreakdownId = 'agent' | 'model' | 'project' | 'host' | 'kind' | 'token';
export type Granularity = 'day' | 'week' | 'month';

export interface Bucket { start: string; end: string; label: string; short: string }
export interface BreakdownSeries { key: string; label: string; color: string; values: number[]; costUsd: number }
export interface BreakdownRow { line: CostLine; label: string; color: string; values: number[]; share: number }
export interface Breakdown { buckets: Bucket[]; series: BreakdownSeries[]; rows: BreakdownRow[]; granularity: Granularity }

/** Series drawn before the rest fold into "Other"; the table still lists every line. */
export const MAX_SERIES = 5;
/** Longer than this, the chart opens by week. */
export const WEEKLY_AFTER_DAYS = 92;
/** Longer than this (two years), it opens by month. */
export const MONTHLY_AFTER_DAYS = 730;
export const OTHER_KEY = '__other__';

/** Categorical slots in their validated order (blue, orange, aqua, yellow, magenta, violet). */
const SLOTS = ['var(--usage-s1)', 'var(--usage-s2)', 'var(--usage-s3)', 'var(--usage-s4)', 'var(--usage-s5)', 'var(--usage-s6)'];
const OTHER_COLOR = 'var(--usage-other)';
/** An agent keeps its color whatever the period, so switching periods never repaints one. */
const AGENT_SLOT: Record<string, number> = { claude: 0, codex: 1, opencode: 2, goose: 3, imported: 4, walnut: 5 };
/** Token kinds and kinds of work keep theirs too, so the table reads the same on every visit. */
const FIXED_SLOT: Partial<Record<BreakdownId, Record<string, number>>> = {
  agent: AGENT_SLOT,
  kind: { interactive: 0, subagent: 1, routine: 2, imported: 4, walnut: 5 },
  token: { cacheRead: 0, cacheWrite1h: 1, output: 2, cacheWrite5m: 3, input: 4, reported: 5 },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayLabel(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

const DAY = 86_400_000;
function iso(t: number): string { return new Date(t).toISOString().slice(0, 10); }

/** Every day from start to end (the newest 400 at most), empty days included. */
export function periodDays(start: string | undefined, end: string | undefined): string[] {
  if (!start || !end) return [];
  const stop = Date.parse(`${end}T00:00:00Z`);
  const out: string[] = [];
  for (let t = Math.max(Date.parse(`${start}T00:00:00Z`), stop - 399 * DAY); t <= stop; t += DAY) out.push(iso(t));
  return out;
}

/** The grain a period opens with: days, weeks past three months, months past two years. */
export function autoGranularity(days: number): Granularity {
  return days > MONTHLY_AFTER_DAYS ? 'month' : days > WEEKLY_AFTER_DAYS ? 'week' : 'day';
}

export function monthLabel(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Days, weeks starting on Monday, or calendar months. The first bucket starts on the period's first day. */
export function bucketsFor(days: string[], granularity: Granularity = autoGranularity(days.length)): Bucket[] {
  if (granularity === 'day') return days.map(d => ({ start: d, end: d, label: dayLabel(d), short: dayLabel(d) }));
  const buckets: Bucket[] = [];
  for (const d of days) {
    const t = Date.parse(`${d}T00:00:00Z`);
    const head = granularity === 'week' ? iso(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY) : `${d.slice(0, 7)}-01`;
    const last = buckets[buckets.length - 1];
    if (last && head <= last.start) last.end = d;
    else if (granularity === 'week') buckets.push({ start: d, end: d, label: `Week of ${dayLabel(d)}`, short: dayLabel(d) });
    else buckets.push({ start: d, end: d, label: monthLabel(d), short: MONTHS[Number(d.slice(5, 7)) - 1] });
  }
  // A month axis that spans years names the year on each January (and on the first month).
  if (granularity === 'month' && new Set(buckets.map(b => b.start.slice(0, 4))).size > 1) {
    buckets.forEach((b, i) => { if (i === 0 || b.start.slice(5, 7) === '01') b.short = `${b.short} '${b.start.slice(2, 4)}`; });
  }
  return buckets;
}

export function buildBreakdown(group: CostGroup | undefined, days: string[], labelOf: (line: CostLine) => string = l => l.label,
  granularity: Granularity = autoGranularity(days.length)): Breakdown {
  const lines = group?.lines ?? [];
  const buckets = bucketsFor(days, granularity);
  const index = new Map<string, number>();
  buckets.forEach((b, i) => { for (const d of days) if (d >= b.start && d <= b.end) index.set(d, i); });
  const perKey = new Map<string, number[]>();
  for (const day of group?.daily ?? []) {
    const i = index.get(day.date);
    if (i === undefined) continue;
    for (const [key, cost] of Object.entries(day.costs)) {
      const v = perKey.get(key) ?? new Array(buckets.length).fill(0);
      v[i] += cost; perKey.set(key, v);
    }
  }
  const total = lines.reduce((n, l) => n + l.costUsd, 0);
  let next = 0;
  const used = new Set<number>();
  const fixed = group ? FIXED_SLOT[group.id as BreakdownId] : undefined;
  if (fixed) for (const l of lines) if (fixed[l.key] !== undefined) used.add(fixed[l.key]);
  const colorOf = (line: CostLine, rank: number): string => {
    if (rank >= MAX_SERIES) return OTHER_COLOR;
    if (fixed?.[line.key] !== undefined) return SLOTS[fixed[line.key]];
    while (used.has(next) && next < SLOTS.length) next++;
    const slot = next < SLOTS.length ? next++ : -1;
    return slot < 0 ? OTHER_COLOR : SLOTS[slot];
  };
  const priced = lines.filter(l => l.costUsd > 0);
  const rows: BreakdownRow[] = priced.map((line, rank) => ({
    line, label: labelOf(line), color: colorOf(line, rank), values: perKey.get(line.key) ?? new Array(buckets.length).fill(0),
    share: total > 0 ? line.costUsd / total * 100 : 0,
  }));
  // The chart stacks the biggest at the bottom; everything past them is one "Other" layer.
  const top = rows.slice(0, MAX_SERIES);
  const series: BreakdownSeries[] = top.map(r => ({ key: r.line.key, label: r.label, color: r.color, values: r.values, costUsd: r.line.costUsd }));
  const rest = rows.slice(MAX_SERIES);
  if (rest.length) {
    series.push({ key: OTHER_KEY, label: `Other (${rest.length})`, color: OTHER_COLOR, costUsd: rest.reduce((n, r) => n + r.line.costUsd, 0),
      values: buckets.map((_, i) => rest.reduce((n, r) => n + r.values[i], 0)) });
  }
  return { buckets, series, rows, granularity };
}

/** Axis ticks from zero to a round top a little above `v`, each step 1, 2 or 5 times a power of ten. */
export function niceTicks(v: number, target = 4): number[] {
  if (!(v > 0)) return [0, 1];
  const raw = v / target, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  const n = Math.max(1, Math.ceil(v / step - 1e-9));
  // Rounded to the step's own precision, so 0.1 + 0.2 never prints as 0.30000000000000004.
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return Array.from({ length: n + 1 }, (_, i) => Number((i * step).toFixed(digits)));
}

/**
 * A smooth path through the points that never overshoots them (monotone cubic,
 * Fritsch and Carlson): a day of zero stays at zero instead of dipping below it.
 */
export function monotonePath(pts: [number, number][], moveTo = true): string {
  const n = pts.length;
  if (!n) return '';
  const head = `${moveTo ? 'M' : 'L'}${f(pts[0][0])},${f(pts[0][1])}`;
  if (n === 1) return head;
  const dx: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0]); m.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1)); }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
  t.push(m[n - 2]);
  let d = head;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${f(pts[i][0] + h)},${f(pts[i][1] + h * t[i])} ${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - h * t[i + 1])} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
  }
  return d;
}

function f(v: number): string { return (Math.round(v * 10) / 10).toString(); }

export type Coverage = 'none' | 'partial' | 'imported' | 'mixed' | 'full' | 'reading';

/**
 * How much of a bucket Walnut holds: nothing before the first stored day (those
 * transcripts were gone before usage was kept), part of the bucket that holds it,
 * and "reading" for the newest one while the latest hours are not read yet. Days
 * before `ownFrom` (the first day Walnut recorded itself) that were imported from
 * a bill read "imported", and the bucket holding both kinds "mixed".
 */
export function coverageOf(b: Bucket, storedFrom: string | undefined, stillReading = false, ownFrom?: string): Coverage {
  if (!storedFrom || b.end < storedFrom) return 'none';
  if (ownFrom && ownFrom > storedFrom) {
    if (b.end < ownFrom) return b.start < storedFrom ? 'partial' : 'imported';
    if (b.start < ownFrom) return 'mixed';
  }
  if (b.start < storedFrom) return 'partial';
  return stillReading ? 'reading' : 'full';
}

/** The latest collection is this old or more, so the newest hours may still be missing. */
export const STALE_AFTER_MS = 45 * 60_000;
