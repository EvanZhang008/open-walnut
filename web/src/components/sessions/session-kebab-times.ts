/**
 * The read-only "when" rows at the foot of the session panel's ⋮ menu:
 * when the task was created, when it was last edited, and when its session
 * last did anything. Pure (no React), unit tested in
 * tests/web/session-kebab-times.test.ts.
 */
import { timeAgo } from '@/utils/time';

export interface KebabTimeRow {
  key: 'created' | 'updated' | 'active';
  label: string;
  /** `Sep 20, 10:14 AM · 8d ago` */
  value: string;
  /** Full timestamp for the hover tooltip, naming whose time it is. */
  title: string;
}

interface TimedTask { created_at?: string; updated_at?: string }
interface TimedSession { startedAt?: string; lastActiveAt?: string }

const DAY_MS = 24 * 60 * 60 * 1000;
const NBSP_RE = /[\u202f\u00a0]/g;

function parse(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Absolute clock time plus how long ago: `Today 3:02 PM · 2h ago`,
 * `Yesterday 9:15 AM · 1d ago`, `Sep 20, 10:14 AM · 8d ago`, and the year once
 * it is not this year (`Mar 3, 2025, 8:00 AM · 1y ago`). Both halves are shown
 * because each alone misleads: an `ago` hides the date, a date hides that it
 * was two minutes ago.
 */
export function formatKebabTime(iso: string | undefined, now: number = Date.now()): string | null {
  const d = parse(iso);
  return d ? formatDate(d, now) : null;
}

function formatDate(d: Date, now: number): string {
  const nowDate = new Date(now);
  // ICU puts a narrow no-break space before AM/PM; menu copy uses a plain space.
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(NBSP_RE, ' ');
  const days = Math.round((startOfLocalDay(nowDate) - startOfLocalDay(d)) / DAY_MS);
  let when: string;
  if (days === 0) when = `Today ${time}`;
  else if (days === 1) when = `Yesterday ${time}`;
  else if (d.getFullYear() === nowDate.getFullYear()) {
    when = `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
  } else {
    when = `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${time}`;
  }
  return `${when} · ${timeAgo(d.toISOString(), { now })}`;
}

/** `Mon, Sep 28, 2026, 3:02:05 PM` for tooltips. */
function fullTime(d: Date): string {
  return d.toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  }).replace(NBSP_RE, ' ');
}

/**
 * Created / Updated come from the task (the same two times the task detail
 * shows); Last active comes from the session, which is what moves while you
 * work in it. A session whose task is not loaded still says when it was
 * created, from its own start time. A missing or unparseable time drops its
 * row rather than printing "Invalid Date".
 */
export function sessionKebabTimeRows(
  task: TimedTask | null | undefined,
  session: TimedSession | null | undefined,
  now: number = Date.now(),
): KebabTimeRow[] {
  const rows: KebabTimeRow[] = [];
  const started = parse(session?.startedAt);

  const created = parse(task?.created_at) ?? started;
  if (created) {
    const fromTask = !!parse(task?.created_at);
    let title = `${fromTask ? 'Task created' : 'Session started'} ${fullTime(created)}`;
    // A task filed long before anyone worked on it: say when the session began too.
    if (fromTask && started && Math.abs(started.getTime() - created.getTime()) >= 60_000) {
      title += `\nSession started ${fullTime(started)}`;
    }
    rows.push({ key: 'created', label: 'Created', value: formatDate(created, now), title });
  }

  const updated = parse(task?.updated_at);
  if (updated) {
    rows.push({
      key: 'updated', label: 'Updated',
      value: formatDate(updated, now),
      title: `Task last changed ${fullTime(updated)}`,
    });
  }

  const active = parse(session?.lastActiveAt);
  if (active) {
    rows.push({
      key: 'active', label: 'Last active',
      value: formatDate(active, now),
      title: `Session last active ${fullTime(active)}`,
    });
  }
  return rows;
}
