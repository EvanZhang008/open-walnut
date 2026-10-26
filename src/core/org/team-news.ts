/**
 * A team's news in its tasks' own words, pure. One rule for every reader:
 *
 *   web     the VP card and the Org page row say the newest of it (org-chart-model.ts,
 *           org-channels-model.ts), with its time
 *   server  a lead hears what moved before its next message (team-note.ts)
 *
 * The words are each task's status (src/core/user-status.ts): what it asks the user, else where
 * it stands now, else what it waits on, and when its session wrote them. So the card follows the
 * team's real state by itself and no one has to write a summary for it. 2026-10-26, the user:
 * "the VP should know the status of the task"; a VP card read "1 waiting" while its team's task
 * had passed an identity check and asked the user to sign.
 */

import type { TaskPhase } from '../types.js';
import { fallbackUserState, type UserState, type UserStatus } from '../user-status.js';

export interface TeamNewsTask {
  id: string;
  title: string;
  phase: TaskPhase;
  updated_at?: string;
  last_session_update?: string;
  /** Its leader (a lead's team note tells the lead what waits on it). */
  parent_task_id?: string;
  /** When its phase last moved: a wait on its lead that began later is a new one. */
  phase_changed_at?: string;
  project?: string;
  user_status?: Pick<UserStatus, 'state' | 'kind' | 'ask' | 'source' | 'now' | 'waitingOn' | 'at' | 'stale'>;
}

export interface TeamNewsItem {
  taskId: string;
  title: string;
  state: UserState;
  /** Where it stands in its status's words; '' when its status has none. */
  words: string;
  /** The words are the session's own and current (its ask, or where it stands now), not what
   *  Walnut says it waits on, and not a day old. */
  reported: boolean;
  /** When the session wrote its words, else when the task last moved (ms); 0 = unknown. */
  at: number;
}

function ms(iso: string | undefined): number {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : 0;
}

function clean(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** Waits that say nothing a title does not ("You, to read the latest turn", "Not started yet"). */
const PLAIN_WAITS: ReadonlySet<string> = new Set(['you', 'lead', 'not-started', 'time']);

/** What a task's status says about it: its ask, else what it did last, else on what it waits
 *  when that names something (another task, a watch, a clock, the machine, being stuck). */
export function statusWords(s: TeamNewsTask['user_status'], state: UserState): string {
  if (!s || s.state !== state) return '';
  if (state === 'needs') return clean(s.ask || s.now);
  const waits = state === 'waiting' && !PLAIN_WAITS.has(s.kind ?? '') ? s.waitingOn : '';
  return clean(s.now || waits);
}

export function newsItem(t: TeamNewsTask): TeamNewsItem {
  const s = t.user_status;
  const state = t.phase === 'COMPLETE' ? 'done' : s?.state ?? fallbackUserState(t.phase);
  const words = statusWords(s, state);
  // The session's own words carry the time it wrote them. An ask from a letter, a prompt, a Board
  // choice or a failure keeps an older report's time in `at`, so it takes the task's last move.
  const own = !!words && (state === 'needs' ? s?.source === 'session' : !!clean(s?.now));
  const moved = Math.max(ms(t.updated_at), ms(t.last_session_update));
  return { taskId: t.id, title: t.title, state, words, reported: own && !s?.stale, at: (own && ms(s?.at)) || moved };
}

/**
 * The open tasks' news, the one to read first on top: what needs the user, then the newest of
 * the sessions' own current words (a turn that just reported), then work running now, then
 * what waits with words (on what, or a day-old report), then the rest; newest first in each.
 */
export function teamNews(tasks: readonly TeamNewsTask[]): TeamNewsItem[] {
  const tier = (i: TeamNewsItem) => (i.state === 'needs' ? 0 : i.reported ? 1 : i.state === 'working' ? 2 : i.words ? 3 : 4);
  return tasks
    .filter((t) => t.phase !== 'COMPLETE')
    .map(newsItem)
    .sort((a, b) => tier(a) - tier(b)
      || b.at - a.at
      || a.taskId.localeCompare(b.taskId));
}

/** A title cut to `max` characters (code points), so the words after it still show. */
export function shortTitle(title: string, max = 36): string {
  const chars = Array.from(title.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
}

/** One line of news, its words first (a narrow card cuts the end): what the session says, else
 *  what the task is doing. The task it is about goes beside it (newsSubject). */
export function newsLine(item: TeamNewsItem): string {
  if (item.state === 'needs') return `Needs you: ${item.words || item.title}`;
  if (item.words) return item.words;
  return item.state === 'working' ? `Working on: ${item.title}` : `Waiting: ${item.title}`;
}

/** The task a news line is about, when the line does not name it already. */
export function newsSubject(item: TeamNewsItem): string {
  return item.words ? item.title : '';
}
