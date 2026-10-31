/**
 * The Usage & Costs chart's data: one breakdown (agent, model, project or host)
 * laid over the period's days, its biggest lines as stacked series and the rest
 * as "Other". Long periods go by week so the curve stays readable.
 */
import type { CostGroup, CostLine } from '@/api/usage';

export type BreakdownId = 'agent' | 'model' | 'project' | 'host';

export interface Bucket { start: string; end: string; label: string }
export interface BreakdownSeries { key: string; label: string; color: string; values: number[]; costUsd: number }
export interface BreakdownRow { line: CostLine; label: string; color: string; values: number[]; share: number }
export interface Breakdown { buckets: Bucket[]; series: BreakdownSeries[]; rows: BreakdownRow[]; byWeek: boolean }

/** Series drawn before the rest fold into "Other"; the table still lists every line. */
export const MAX_SERIES = 5;
/** Longer than this, the chart goes by week. */
export const WEEKLY_AFTER_DAYS = 92;
export const OTHER_KEY = '__other__';

/** Categorical slots in their validated order (blue, orange, aqua, yellow, magenta, violet). */
const SLOTS = ['var(--usage-s1)', 'var(--usage-s2)', 'var(--usage-s3)', 'var(--usage-s4)', 'var(--usage-s5)', 'var(--usage-s6)'];
const OTHER_COLOR = 'var(--usage-other)';
/** An agent keeps its color whatever the period, so switching periods never repaints one. */
const AGENT_SLOT: Record<string, number> = { claude: 0, codex: 1, opencode: 2, goose: 3, walnut: 5 };

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

/** Days, or weeks starting on Monday when the period is long. */
export function bucketsFor(days: string[]): { buckets: Bucket[]; byWeek: boolean } {
  if (days.length <= WEEKLY_AFTER_DAYS) return { buckets: days.map(d => ({ start: d, end: d, label: dayLabel(d) })), byWeek: false };
  const buckets: Bucket[] = [];
  for (const d of days) {
    const t = Date.parse(`${d}T00:00:00Z`);
    const monday = iso(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY);
    const last = buckets[buckets.length - 1];
    // The first week starts on the period's first day, not on a Monday before it.
    if (last && monday <= last.start) last.end = d;
    else buckets.push({ start: d, end: d, label: `Week of ${dayLabel(d)}` });
  }
  return { buckets, byWeek: true };
}

export function buildBreakdown(group: CostGroup | undefined, days: string[], labelOf: (line: CostLine) => string = l => l.label): Breakdown {
  const lines = group?.lines ?? [];
  const { buckets, byWeek } = bucketsFor(days);
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
  if (group?.id === 'agent') for (const l of lines) if (AGENT_SLOT[l.key] !== undefined) used.add(AGENT_SLOT[l.key]);
  const colorOf = (line: CostLine, rank: number): string => {
    if (rank >= MAX_SERIES) return OTHER_COLOR;
    if (group?.id === 'agent' && AGENT_SLOT[line.key] !== undefined) return SLOTS[AGENT_SLOT[line.key]];
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
  return { buckets, series, rows, byWeek };
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
