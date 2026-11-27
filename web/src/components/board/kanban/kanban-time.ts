/**
 * The kanban's card times (G23), on the console's one way of writing a time (web/src/utils/time.ts).
 * A relative time always has a verb and `ago` (`Idle 2h ago`, `Done just now`), a duration a verb and
 * no `ago` (`Stale 3d`, `Waiting 3d`); a change time is its clock today (`3:02 PM`), else the day and
 * the clock (`yesterday 3:02 PM`, `Sep 24, 3:02 PM`). Tooltips carry the whole time (`fullTime`).
 */
import { clockTime, fullTime, pointInTime, timeAgo } from '@/utils/time';

/** What every card time text matches (C83): `<Verb...> <n><unit>[ ago]` or `<Verb...> just now`. */
export const KANBAN_TIME_RE = /^[A-Z][a-z]*(?: [a-z]+)* (?:\d+(?:m|h|d|w|mo|y)(?: ago)?|just now)$/;

function ms(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return Date.parse(iso);
}

/** `Idle 2h ago`, `Done just now`; '' without a valid time. */
export function agoText(verb: string, iso: string | null | undefined, now: number = Date.now()): string {
  if (!Number.isFinite(ms(iso))) return '';
  const ago = timeAgo(iso as string, { now });
  return ago ? `${verb} ${ago}` : '';
}

/** `Stale 3d`, `Waiting 5h`: the time since `iso`, never under 1m; '' without a valid time. */
export function durationText(verb: string, iso: string | null | undefined, now: number = Date.now()): string {
  if (!Number.isFinite(ms(iso))) return '';
  const ago = timeAgo(iso as string, { now });
  if (!ago) return '';
  return `${verb} ${ago === 'just now' ? '1m' : ago.replace(/ ago$/, '')}`;
}

/** `3:02 PM` today, else `yesterday 3:02 PM`, `Sep 24, 3:02 PM`; '' without a valid time. */
export function clockText(iso: string | null | undefined, now: number = Date.now()): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return '';
  const words = pointInTime(t, { now });
  return words.startsWith('today ') ? clockTime(t) : words;
}

/**
 * A wait's end (N12): `today 5:45 PM`, `tomorrow 9:00 AM`, `Oct 12, 5:16 AM`; a time already past
 * reads like clockText. '' without a valid time.
 */
export function waitText(iso: string | null | undefined, now: number = Date.now()): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return '';
  if (t < now) return clockText(iso, now);
  return pointInTime(t, { now });
}

/**
 * Each tooltip's whole time, kept per instant: every card's tooltips are rebuilt on each status
 * push (37 cards made it a 100ms task when each built its own date formatter, C96).
 */
const absWords = new Map<number, string>();

/** The whole time for a tooltip, `Fri, Nov 20, 2026, 9:40 PM` ('' without a valid time). */
export function absoluteText(iso: string | null | undefined): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return '';
  let words = absWords.get(t);
  if (words === undefined) {
    if (absWords.size > 2000) absWords.clear();
    words = fullTime(t);
    absWords.set(t, words);
  }
  return words;
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
