/**
 * Which dated copies a history keeps (pure): every copy of the last `withinHours`
 * (at most MAX_WITHIN), the newest `recent` copies, the newest (and with
 * `oldestOfDay` also the oldest) of each of the last `daily` days that have one,
 * and the newest of each of the last `weekly` ISO weeks. The newest copy is always
 * kept, so a prune never deletes the only one.
 *
 * Shared by the encrypted backup's snapshots (core/backup/repo/prune.ts, local days)
 * and config.yaml's dated copies (core/config-history.ts, UTC days).
 */
export interface RetentionPolicy {
  daily: number;
  weekly: number;
  /** The newest few, whatever their day: a copy made right after a bad change keeps the good one of that morning. */
  recent?: number;
  /** Every copy this recent is kept, whatever else the policy says. */
  withinHours?: number;
  /** Count days and weeks in UTC instead of local time. */
  utc?: boolean;
  /**
   * Keep each kept day's oldest copy too: after a bad write the day's newest copy is
   * the bad one, and the good one from earlier that day must not depend on `recent`.
   */
  oldestOfDay?: boolean;
}

/** A bound on the copies kept for being recent (an hourly schedule plus many manual runs). */
const MAX_WITHIN = 48;

const dayKey = (d: Date, utc: boolean): string => utc
  ? `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`
  : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** ISO 8601 week ("2026-W45"), in local time unless `utc`. */
export function isoWeekKey(d: Date, utc = false): string {
  const t = utc
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const weekday = t.getUTCDay() || 7; // Monday 1 .. Sunday 7
  t.setUTCDate(t.getUTCDate() + 4 - weekday); // the Thursday of this week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}

/** Ids of the copies the policy keeps. `createdAt` is an ISO 8601 time (they sort as text). */
export function selectKept(items: ReadonlyArray<{ id: string; createdAt: string }>, policy: RetentionPolicy, now = Date.now()): Set<string> {
  const utc = policy.utc === true;
  const newestFirst = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const kept = new Set<string>();
  if (policy.withinHours) {
    const since = now - policy.withinHours * 3_600_000;
    for (const s of newestFirst.filter((x) => Date.parse(x.createdAt) >= since).slice(0, MAX_WITHIN)) kept.add(s.id);
  }
  for (const s of newestFirst.slice(0, Math.max(1, policy.recent ?? 1))) kept.add(s.id);
  const days = new Set<string>();
  const weeks = new Set<string>();
  /** Each kept day's oldest copy so far (newest first, so the last one seen wins). */
  const oldest = new Map<string, string>();
  for (const s of newestFirst) {
    const d = new Date(s.createdAt);
    const dk = dayKey(d, utc);
    if (!days.has(dk) && days.size < policy.daily) {
      days.add(dk);
      kept.add(s.id);
    }
    if (policy.oldestOfDay && days.has(dk)) oldest.set(dk, s.id);
    const wk = isoWeekKey(d, utc);
    if (!weeks.has(wk) && weeks.size < policy.weekly) {
      weeks.add(wk);
      kept.add(s.id);
    }
  }
  for (const id of oldest.values()) kept.add(id);
  return kept;
}
