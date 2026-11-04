/**
 * The words of a task row a usage limit holds, pure (limit-row.tsx draws them): shared by every
 * Home view, so a limited task reads the same wherever it is drawn.
 */
import type { Task } from '@open-walnut/core';
import { limitedLine, limitTimeWords } from '@open-walnut/user-status';

type Limit = NonNullable<NonNullable<Task['user_status']>['limit']>;

/** The first word of a Limited line wears the session banner's tag ("Limited", or "Continuing"
 *  once the reset passed). */
export const LIMIT_HEAD = /^(Limited|Continuing) · /;

/** A waiting limit row's words after its tag: "resets 9:08 PM", the banner's own words; past the
 *  reset, when it goes on ("at 5:31 PM"). */
export function limitRowWords(line: string): string {
  return ` ${line.replace(LIMIT_HEAD, '')}`;
}

export type LimitTone = 'off' | 'refused' | undefined;
export type LimitRowLine = { tag: string | null; tone?: LimitTone; text: string };

/** "resets 6:36 AM", "resets about 6:36 AM": the banner's own words for the reset. */
export function limitResetWords(l: Limit, now: number): string {
  return l.resetsAt ? `resets ${l.estimate ? 'about ' : ''}${limitTimeWords(l.resetsAt, now)}` : '';
}

/** The line of a limit row that is the user's (auto-continue off, or every continue refused): its
 *  tag says why, in the banner's colour (grey when off), then when it resets, on one line. Past the
 *  reset the tag says Reset. `live` is the wait's state as last announced, ahead of the stored
 *  status: a row turned off reads off at once, one turned back on reads Limited. */
export function limitOwnWords(task: Task, needText: string, now: number, live: string | undefined): LimitRowLine | null {
  const l = task.user_status?.limit;
  if (!l || (l.auto && live !== 'off')) return null;
  if (live === 'waiting') return { tag: 'Limited', text: limitResetWords(l, now) || 'Walnut continues it' };
  const ahead = !l.resetsAt || Date.parse(l.resetsAt) > now;
  if (!ahead) return { tag: 'Reset', text: 'Continue it when you want' };
  const reset = limitResetWords(l, now);
  return /^Limited, still refusing/.test(needText) && live !== 'off'
    ? { tag: 'Refused again', tone: 'refused', text: reset || 'Continue it once your limit allows' }
    : { tag: 'Auto-continue off', tone: 'off', text: reset || 'Continue it when you want' };
}

/** The line of a limited row in any view: its tag and its words. `needText` is what the row's
 *  status asks (it tells a refused continue from a turned-off one). */
export function limitRowLine(task: Task, needText: string, now: number, live: string | undefined): LimitRowLine | null {
  const l = task.user_status?.limit;
  if (!l) return null;
  if (live === 'resumed' || live === 'gone') return { tag: 'Continuing', text: 'now' };
  const own = limitOwnWords(task, needText, now, live);
  if (own) return own;
  const line = limitedLine(task.user_status, now);
  const head = line?.match(LIMIT_HEAD);
  return head ? { tag: head[1], text: line!.replace(LIMIT_HEAD, '') } : { tag: 'Limited', text: limitResetWords(l, now) };
}
