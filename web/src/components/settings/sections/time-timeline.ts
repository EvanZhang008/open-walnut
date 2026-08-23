/**
 * Day-timeline geometry and colors — PURE, so the axis rules are unit tested
 * without a browser.
 *
 * Two decisions live here that the view only renders:
 *
 * 1. The axis COLLAPSES to the hours that actually carry time (plus an hour of
 *    padding, and the current hour on today so the now-line is never off-screen).
 *    Twenty-four rows of emptiness answer "how did my day go?" with a scroll bar.
 * 2. A task's color is a stable hash into a fixed palette that deliberately
 *    contains NO purple or magenta, because purple is the agent lane's color
 *    everywhere in this feature. Your time and an agent's runtime must never be
 *    confusable, so they never share a hue family — not just never a rectangle.
 */

/** Minutes of a day are converted against its own midnight, never assumed 1440. */
export const HOUR_MIN = 60;
/** Hour row height. Matches the calendar grid's 48px hour so the two read alike. */
export const HOUR_PX = 48;
export const PX_PER_MIN = HOUR_PX / HOUR_MIN;
/** Whole hours of breathing room added around the tracked span. */
export const AXIS_PAD_HOURS = 1;
/** An axis shorter than this reads as a cropped fragment of a day. */
export const MIN_AXIS_HOURS = 6;
/** Blocks under this render as thin ticks: visible, but not shouting. */
export const TICK_BELOW_MS = 5 * 60 * 1000;
/** Fallback window for a day with nothing on it. */
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 18;

/**
 * Human task colors. No purple/magenta on purpose (see the file header), and
 * each one holds up on both the light and the dark surface.
 */
export const TASK_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#f97316', // orange
  '#14b8a6', // teal
] as const;

/** Stable per-task color. Same id → same color across days and reloads. */
export function taskColor(taskId: string): string {
  if (!taskId) return 'var(--fg-muted)'; // taskless time is deliberately grey
  // FNV-1a, 32-bit. Cheap, and spreads adjacent ids (t_ab / t_ac) apart.
  let hash = 0x811c9dc5;
  for (let i = 0; i < taskId.length; i++) {
    hash ^= taskId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return TASK_COLORS[Math.abs(hash) % TASK_COLORS.length]!;
}

/** Local midnight of a YYYY-MM-DD, in ms. NaN when the date is malformed. */
export function dayStartMs(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
}

/** Length of a local day in minutes — 1380 or 1500 on a DST changeover. */
export function dayLengthMin(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return 24 * HOUR_MIN;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, 0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

/**
 * Minutes since the day's midnight for an instant.
 *
 * Deliberately NOT `getHours() * 60 + getMinutes()`: a block clipped to the end
 * of the day lands exactly ON the next midnight, which reads back as minute 0 and
 * drew a full-day block as a zero-height sliver at the top.
 */
export function minuteOfDay(iso: string, startMs: number, lengthMin: number): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || !Number.isFinite(startMs)) return 0;
  return Math.min(Math.max((ms - startMs) / 60_000, 0), lengthMin);
}

export interface AxisRange {
  startMin: number;
  endMin: number;
  /** Whole hours the ruler labels, ascending. */
  hours: number[];
}

/**
 * The hours worth drawing: the tracked span, rounded out to whole hours, padded,
 * grown to MIN_AXIS_HOURS, and clamped to the day. `nowMin` (today only) is
 * folded in so the now-line always sits inside the axis.
 */
export function axisRange(
  spans: ReadonlyArray<{ startMin: number; endMin: number }>,
  opts: { lengthMin: number; nowMin?: number },
): AxisRange {
  const dayHours = Math.ceil(opts.lengthMin / HOUR_MIN);
  let lo: number;
  let hi: number;
  if (spans.length === 0 && opts.nowMin === undefined) {
    lo = DEFAULT_START_HOUR;
    hi = DEFAULT_END_HOUR;
  } else {
    let earliest = Number.POSITIVE_INFINITY;
    let latest = Number.NEGATIVE_INFINITY;
    for (const s of spans) {
      earliest = Math.min(earliest, s.startMin);
      latest = Math.max(latest, s.endMin);
    }
    if (opts.nowMin !== undefined) {
      earliest = Math.min(earliest, opts.nowMin);
      latest = Math.max(latest, opts.nowMin);
    }
    lo = Math.floor(earliest / HOUR_MIN) - AXIS_PAD_HOURS;
    hi = Math.ceil(latest / HOUR_MIN) + AXIS_PAD_HOURS;
  }
  lo = Math.max(0, lo);
  hi = Math.min(dayHours, Math.max(hi, lo + 1));
  // Grow to the minimum span — downward first (the day usually has more room
  // after the last block than before the first), then upward.
  if (hi - lo < MIN_AXIS_HOURS) {
    hi = Math.min(dayHours, lo + MIN_AXIS_HOURS);
    if (hi - lo < MIN_AXIS_HOURS) lo = Math.max(0, hi - MIN_AXIS_HOURS);
  }
  const hours: number[] = [];
  for (let h = lo; h < hi; h++) hours.push(h);
  return { startMin: lo * HOUR_MIN, endMin: hi * HOUR_MIN, hours };
}

/** "9:05 AM" for a minute-of-day. */
export function clockLabel(min: number): string {
  const total = Math.max(0, Math.round(min));
  const h24 = Math.floor(total / HOUR_MIN) % 24;
  const m = total % HOUR_MIN;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** "8 AM" / "Noon" / "12 AM" for an hour ruler tick. */
export function hourLabel(hour: number): string {
  const h = hour % 24;
  if (h === 12) return 'Noon';
  if (h === 0) return '12 AM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/** Shift a YYYY-MM-DD by whole days, staying in the local calendar. */
export function shiftDate(date: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  // Noon anchor: a DST transition can move midnight across the day boundary.
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  d.setDate(d.getDate() + deltaDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Under a minute → "42s"; under an hour → "42m"; otherwise "2h 07m". Shared by
 * every view in the Time Tracking section.
 *
 * Seconds matter: rounding to minutes printed a real 4-second window as "0m",
 * which reads as "nothing was recorded" — the same "this data is wrong" reaction
 * the two-tab split was made to prevent.
 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** "Sat, Aug 23" — the day nav's own label. */
export function dayLabel(date: string): string {
  const ms = dayStartMs(date);
  if (!Number.isFinite(ms)) return date;
  return new Date(ms).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
}
