/**
 * The kanban's one time format (G23). A relative time always has a verb and
 * `ago` (`Idle 2h ago`, `Done just now`), a duration a verb and no `ago`
 * (`Stale 3d`, `Waiting 3d`); a change time is `HH:MM` today, else the weekday
 * (within a week) or the date, then `HH:MM`. Tooltips carry the absolute time.
 * Built on timeAgo / compactAgo, so the units match the rest of the console.
 */
import { timeAgo } from '@/utils/time';
import { compactAgo } from '../board-overview-model';

/** What every card time text matches (C83): `<Verb...> <n><unit>[ ago]` or `<Verb...> just now`. */
export const KANBAN_TIME_RE = /^[A-Z][a-z]*(?: [a-z]+)* (?:\d+(?:m|h|d|w|mo|y)(?: ago)?|just now)$/;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ms(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return Date.parse(iso);
}

/** `Idle 2h ago`, `Done just now`; '' without a valid time. */
export function agoText(verb: string, iso: string | null | undefined, now: number = Date.now()): string {
  if (!Number.isFinite(ms(iso))) return '';
  const short = compactAgo(timeAgo(iso as string, { now }));
  if (!short) return '';
  return short === 'now' ? `${verb} just now` : `${verb} ${short} ago`;
}

/** `Stale 3d`, `Waiting 5h`: the time since `iso`, never under 1m; '' without a valid time. */
export function durationText(verb: string, iso: string | null | undefined, now: number = Date.now()): string {
  if (!Number.isFinite(ms(iso))) return '';
  const short = compactAgo(timeAgo(iso as string, { now }));
  if (!short) return '';
  return `${verb} ${short === 'now' ? '1m' : short}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `15:02` today, `Mon 15:02` within the last week, `Sep 24 15:02` before that; '' without a valid time. */
export function clockText(iso: string | null | undefined, now: number = Date.now()): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return hm;
  if (now - t < 6 * 86_400_000 && now >= t) return `${WEEKDAYS[d.getDay()]} ${hm}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

/**
 * A wait's end (N12), on the same 24 hour clock as every other card time:
 * `Today 17:45`, `Tomorrow 09:00`, `Tue 05:16` within the week ahead, else
 * `Oct 12 05:16`; a time already past reads like clockText. '' without a valid time.
 */
export function waitText(iso: string | null | undefined, now: number = Date.now()): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return '';
  if (t < now) return clockText(iso, now);
  const d = new Date(t);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  if (days === 0) return `Today ${hm}`;
  if (days === 1) return `Tomorrow ${hm}`;
  if (days < 7) return `${WEEKDAYS[d.getDay()]} ${hm}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

/**
 * One formatter for every tooltip: toLocaleString WITH options builds a new
 * Intl.DateTimeFormat per call, and every card's tooltips are rebuilt on each
 * status push (37 cards made it a 100ms task, C96).
 */
let absFormat: Intl.DateTimeFormat | null = null;

/** The absolute time for a tooltip, on the same 24 hour clock ('' without a valid time). */
export function absoluteText(iso: string | null | undefined): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return '';
  absFormat ??= new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return absFormat.format(new Date(t));
}

/** The newest of the stamps (ISO), '' when none is valid. */
export function latestIso(...stamps: Array<string | null | undefined>): string {
  let best = '';
  let bestMs = -Infinity;
  for (const s of stamps) {
    const t = ms(s);
    if (Number.isFinite(t) && t > bestMs) { best = s as string; bestMs = t; }
  }
  return best;
}
