/**
 * The one way Walnut writes a point in time, for every screen (web/src/utils/time.ts re-exports it)
 * and for the server's texts a person reads: notices, letters, reports, status lines. A 12-hour
 * clock with no leading zero and no seconds, the year only when it is not this year. The server
 * writes in its own zone, which is the user's (the Mac). Guarded by tests/web/time-words-guard.test.ts.
 */
export type TimeInput = Date | string | number | null | undefined;
export interface TimeWordsOptions {
  /** Reference clock (ms since epoch); defaults to Date.now(). Tests pin it. */
  now?: number;
  /** To the second: only for rows of one list that would otherwise read alike (two backups or
   *  saved versions in one minute). Every other place stays to the minute. */
  seconds?: boolean;
  /** Always the date, never "today" or "yesterday": for text that is kept and read later (a letter,
   *  a report, a title), where "today" would be wrong tomorrow. */
  dated?: boolean;
}

function toDate(value: TimeInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a date string as a relative time (e.g. "2h ago", "3 days ago").
 *
 * The default (short) output is the site-wide format and must not change. `long: true`
 * is the spelled-out variant used where the time is read as a sentence (the Plugins
 * header "Checked 3 min ago", the update chip tooltips): `just now`, `3 min ago`,
 * `2 h ago`, `yesterday`, `3 days ago`, then the same week/month/year rules as short.
 */
export interface TimeAgoOptions {
  long?: boolean;
  /** Reference clock (ms since epoch); defaults to Date.now(). Tests pin it. */
  now?: number;
}

export function timeAgo(value: TimeInput, opts?: TimeAgoOptions): string {
  const date = toDate(value);
  if (!date) return '';

  const now = opts?.now ?? Date.now();
  const diff = now - date.getTime();

  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';

  const long = opts?.long === true;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return long ? `${minutes} min ago` : `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return long ? `${hours} h ago` : `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) {
    if (!long) return `${days}d ago`;
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/*
 * One way to write a point in time on every screen (standard.md, "Words", rule 6; the UI audit
 * of 2026-11-27 counted at least eight on the user's data: "Nov 20, 2026", "Fri, Nov 20, 2026,
 * 09:40 PM", "11/17/2026, 6:05:45 AM", "built 2026-11-27" ...). Every screen writes a time
 * through these, in the person's own zone and a 12-hour clock, never with seconds:
 *
 *   timeAgo       a row's age:            "6d ago"  (long: "6 days ago", inside a sentence)
 *   clockTime     a clock alone:          "9:40 PM"
 *   dayDate       a day:                  "today", "yesterday", "tomorrow", "Nov 20", "Nov 20, 2025"
 *   pointInTime   a day and its clock:    "today 9:40 PM", "Nov 20, 9:40 PM", "Nov 20, 2025, 9:40 PM"
 *   fullTime      a hover or a reader:    "Fri, Nov 20, 2026, 9:40 PM"
 *
 * The year shows only when it is not this year (fullTime always shows it). An empty or invalid
 * value reads as ''. tests/web/time-words-guard.test.ts counts every other way of writing a
 * date in web/src, per file, and the counts only go down.
 */
/** Engines put a narrow no-break space before AM/PM (U+202F); every screen and test reads a plain one. */
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY_MS = 86_400_000;

/** "9:40 PM" ("9:40:12 PM" with `seconds`). */
export function clockTime(value: TimeInput, opts?: Pick<TimeWordsOptions, 'seconds'>): string {
  const d = toDate(value);
  return d ? plain(d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(opts?.seconds ? { second: '2-digit' } : {}) })) : '';
}

/** "today", "yesterday", "tomorrow", else "Nov 20" (", 2025" when not this year). */
export function dayDate(value: TimeInput, opts?: TimeWordsOptions): string {
  const d = toDate(value);
  if (!d) return '';
  const now = new Date(opts?.now ?? Date.now());
  const days = opts?.dated ? NaN : Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  if (days === 0) return 'today';
  if (days === -1) return 'yesterday';
  if (days === 1) return 'tomorrow';
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** "today 9:40 PM", "Nov 20, 9:40 PM", "Nov 20, 2025, 9:40 PM" (`dated`: "Nov 27, 9:40 PM" even today). */
export function pointInTime(value: TimeInput, opts?: TimeWordsOptions): string {
  const d = toDate(value);
  if (!d) return '';
  const day = dayDate(d, opts);
  // A day said in words takes its clock after a space ("today 9:40 PM"); a date takes a comma.
  const clock = clockTime(d, opts);
  return /\d/.test(day) ? `${day}, ${clock}` : `${day} ${clock}`;
}

/** "Fri, Nov 20, 2026, 9:40 PM": a hover or a reader's head, where the whole time is wanted. */
export function fullTime(value: TimeInput): string {
  const d = toDate(value);
  if (!d) return '';
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  return `${date}, ${clockTime(d)}`;
}

/** A time's words at the start of a line or a standalone label: "Today 9:40 PM", not "today 9:40 PM". */
export function lineStart(words: string): string {
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}
