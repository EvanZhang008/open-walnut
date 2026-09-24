import type { SessionCronJob } from '@open-walnut/core';

/** Calendar-aware clock text: "Today 9:23 AM", "Tomorrow 9:23 AM", else "Tue, Sep 22, 12:43 PM". */
export function formatCronClock(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayStart = (value: number) => {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const dayOffset = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  if (dayOffset === 0) return `Today ${time}`;
  if (dayOffset === 1) return `Tomorrow ${time}`;
  if (dayOffset === -1) return `Yesterday ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** Distance to a future or past instant: "in 12h 40m", "in 3m", "due now", "2h ago". */
export function formatCronDistance(at: number, now = Date.now()): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff >= 0 ? 'in under a minute' : 'due now';
  const minutes = Math.floor(abs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const span = days >= 1 ? `${days}d ${hours % 24}h`
    : hours >= 1 ? `${hours}h ${minutes % 60}m`
    : `${minutes}m`;
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

/** First line of the prompt, trimmed to `limit` characters, for a collapsed summary. */
export function cronPromptPreview(prompt: string | null, limit = 96): string {
  if (!prompt) return '';
  const line = prompt.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  if (line.length <= limit) return line;
  // A code-unit cut can land inside a surrogate pair; the orphaned half renders as U+FFFD.
  const cut = line.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${cut.trimEnd()}…`;
}

/** The pill's hover text: the first job's schedule and next run, plus a count of the rest. */
export function cronPillTitle(jobs: SessionCronJob[] | undefined, now = Date.now()): string {
  if (jobs === undefined) return "Confirmed cron job. Details need this host's daemon to update.";
  const [first, ...rest] = jobs;
  if (!first) return 'Confirmed cron job.';
  const parts = [`Cron job: ${first.schedule || first.cron || first.id}.`];
  if (first.nextRunAt !== null) parts.push(`Next run ${formatCronClock(first.nextRunAt, now)} (${formatCronDistance(first.nextRunAt, now)}).`);
  if (rest.length) parts.push(`${rest.length} more job${rest.length === 1 ? '' : 's'}.`);
  return parts.join(' ');
}
