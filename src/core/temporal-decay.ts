/**
 * Temporal decay scoring for date-bearing file paths.
 * Files with dates closer to now score higher; undated files are treated as evergreen.
 */
export function temporalDecay(filepath: string, halfLifeDays: number): number {
  const dateMatch = filepath.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch) return 1.0; // evergreen
  // Age in WHOLE DAYS between calendar dates, not wall-clock milliseconds.
  // `new Date('2026-07-26')` is UTC midnight while Date.now() is the current
  // instant, so a same-day note used to decay as the day went on — 1.0 at
  // 00:00 UTC but 0.98 by late afternoon — making one file's score depend on
  // when you searched. Comparing day numbers keeps a given date's score fixed
  // for the whole day, which is the granularity the filename carries anyway.
  const fileDay = Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const ageInDays = (today - fileDay) / 86_400_000;
  if (ageInDays <= 0) return 1.0;
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageInDays);
}
