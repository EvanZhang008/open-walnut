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

export function timeAgo(dateStr: string, opts?: TimeAgoOptions): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';

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
