/**
 * The Board's Status view (BoardStatusView.tsx): every task of the team in ONE list, by the
 * one status the user sees (src/core/user-status.ts), the same four groups and the same
 * counts as the Org page, the task list and the phone. Pure: no React, no DOM. Unit-pinned
 * in tests/web/board-status-model.test.ts.
 *
 * Order, top down: Needs you (its due date first, then newest first; a task with only a result
 * or an answer to look at is here too, shownState: 2026-11-03, the user: "I dont wnat serpeate
 * to read"), Working (latest activity first), Waiting (stuck first, then by what it waits on,
 * not started last), Done (the recent window, newest first). Each Needs you row has one line
 * saying what to do with it (needsRowLine: Take a look, Decide, Review, Can close).
 * A worker under another worker is listed flat and says whom it is under.
 */
import type { Task } from '@open-walnut/core';
import {
  limitedLine,
  NEEDS_CATEGORY_LABELS, USER_STATES, USER_STATE_LABELS, dueAtMs, fallbackUserState, needsLineOf, shownState, stateCountLabel,
  storedUserState, type NeedsCategory, type UserState, type UserStatus, type WaitKind,
} from '@open-walnut/user-status';
import { teamChildren, walkTeam } from './board-overview-model';

/** The groups the user sees: To read is drawn under Needs you (shownState). */
export type ShownState = Exclude<UserState, 'read'>;
export const SHOWN_STATES: readonly ShownState[] = USER_STATES.filter((s): s is ShownState => s !== 'read');
export type ShownCounts = Record<ShownState, number>;

/** Not started: a part of Waiting with a chip and a pill of its own (2026-11-09, the user: not
 *  started is "completeli differnet" from wait and snooze), the same rule as Home's Flat section
 *  (status-sections.ts isNotStarted). A snoozed task sleeps under Waiting / snoozed. */
export const NOT_STARTED_LABEL = 'Not started';
export function isNotStartedStatus(status: UserStatus): boolean {
  return status.state === 'waiting' && status.kind === 'not-started' && !status.snoozed;
}
/** The chips over the table, in order: the shown states with Not started after Waiting. */
export type StatusChip = ShownState | 'notstarted';
export const STATUS_CHIPS: readonly StatusChip[] = SHOWN_STATES.flatMap((s): StatusChip[] => (s === 'waiting' ? ['waiting', 'notstarted'] : [s]));
export function chipLabel(chip: StatusChip): string {
  return chip === 'notstarted' ? NOT_STARTED_LABEL : USER_STATE_LABELS[chip];
}
/** A chip's count: Waiting less the not started ones, which Not started counts. */
export function chipCount(board: StatusBoard, chip: StatusChip): number {
  const ns = board.groups.waiting.filter((r) => isNotStartedStatus(r.status)).length;
  if (chip === 'notstarted') return ns;
  return chip === 'waiting' ? board.counts.waiting - ns : board.counts[chip];
}

export interface StatusRow {
  task: Task;
  status: UserStatus;
  /** 0 = the board's owner (the lead), 1 = a direct subtask of it. */
  depth: number;
  /** A deeper worker: the title of the task it is under. */
  under?: string;
}

export interface StatusBoard {
  /** By group: Needs you counts the To read rows drawn in it. */
  counts: ShownCounts;
  groups: Record<ShownState, StatusRow[]>;
  /** Finished tasks older than the window are left out of Done (and its count). */
  doneWindowDays: number;
}

/** The stored status, else what the phase alone says (a task the server has not derived yet). */
export function userStatusOf(task: Task): UserStatus {
  if (task.phase === 'COMPLETE' || task.status === 'done') return { state: 'done' };
  // A To read an older server stored as Waiting with `toRead` reads as To read (storedUserState).
  if (task.user_status) {
    const state = storedUserState(task.user_status);
    return state === task.user_status.state ? task.user_status : { ...task.user_status, state };
  }
  const state = fallbackUserState(task.phase, task.status);
  // Not derived yet (an older server): a hand back reads as an older Walnut meant it.
  return state === 'needs' ? { state, ask: 'Open it: its session handed the task back.' } : { state };
}

const WAIT_ORDER: Record<WaitKind, number> = {
  stuck: 0, you: 1, task: 2, lead: 3, outside: 4, machine: 4, own: 4, time: 5, other: 6, 'not-started': 9,
};

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** When the row last moved, for "3m ago" and the order inside a group. */
export function rowTime(row: Pick<StatusRow, 'task' | 'status'>): number {
  const { task, status } = row;
  if (status.state === 'done') return ms(task.completed_at ?? task.updated_at);
  return Math.max(ms(status.at), ms(task.phase_changed_at), ms(task.last_session_update));
}

export function buildStatusBoard(input: {
  ownerId: string;
  tasks: readonly Task[];
  now: number;
  doneWindowDays: number;
}): StatusBoard {
  // The owner first (it is part of the team, as on the Org page), then its subtree.
  const owner = input.tasks.find((t) => t.id === input.ownerId);
  const members = [
    ...(owner ? [{ task: owner, depth: 0, parentId: '' }] : []),
    ...walkTeam(input.ownerId, teamChildren(input.tasks, input.ownerId)),
  ];
  const titleOf = new Map(input.tasks.map((t) => [t.id, t.title] as const));
  const cutoff = input.now - input.doneWindowDays * 24 * 60 * 60_000;
  const groups: Record<ShownState, StatusRow[]> = { needs: [], working: [], waiting: [], done: [] };
  for (const m of members) {
    const status = userStatusOf(m.task);
    if (status.state === 'done' && ms(m.task.completed_at ?? m.task.updated_at) < cutoff) continue;
    groups[shownState(status.state)].push({
      task: m.task, status, depth: m.depth,
      ...(m.depth > 1 ? { under: titleOf.get(m.parentId) ?? '' } : {}),
    });
  }
  const newest = (a: StatusRow, b: StatusRow) => rowTime(b) - rowTime(a);
  // Past or near its due date goes first in its group, the earliest deadline first (user-status.ts `due`).
  const byDue = (order: (a: StatusRow, b: StatusRow) => number) => (a: StatusRow, b: StatusRow) => {
    const da = a.status.due ? dueAtMs(a.status.due.at) : NaN;
    const db = b.status.due ? dueAtMs(b.status.due.at) : NaN;
    if (Number.isFinite(da) || Number.isFinite(db)) {
      if (!Number.isFinite(db)) return -1;
      if (!Number.isFinite(da)) return 1;
      if (da !== db) return da - db;
    }
    return order(a, b);
  };
  groups.needs.sort(byDue(newest));
  groups.working.sort(byDue(newest));
  groups.done.sort(newest);
  groups.waiting.sort(byDue((a, b) => {
    const ka = WAIT_ORDER[a.status.kind ?? 'other'] ?? 6;
    const kb = WAIT_ORDER[b.status.kind ?? 'other'] ?? 6;
    return ka !== kb ? ka - kb : newest(a, b);
  }));
  const counts = { needs: groups.needs.length, working: groups.working.length, waiting: groups.waiting.length, done: groups.done.length };
  return { counts, groups, doneWindowDays: input.doneWindowDays };
}

/** A Needs you row's one line: what to do with it, then what it asks or has to read
 *  ("Take a look: It answered your question"). Null for a row under another group. */
export function needsRowLine(status: UserStatus): { category: NeedsCategory; label: string; text: string } | null {
  if (shownState(status.state) !== 'needs') return null;
  const line = needsLineOf(status);
  return line ? { ...line, label: NEEDS_CATEGORY_LABELS[line.category] } : null;
}

/** "Take a look: It answered your question", or the label alone when there are no words. */
export const needsLineText = (l: { label: string; text: string }): string => (l.text ? `${l.label}: ${l.text}` : l.label);

/** A waiting row's one line: "Waiting on another task: …", "Nothing will wake it. …", "Not started yet". */
/**
 * A row that waits because its decision shows elsewhere (same-ask.ts): who or where first, in a few
 * words, since a row shows one line (2026-11-05 UI review: "Waiting on the same decisio..." hid
 * which task asks it and who answered). The full sentence is waitingSentence, the row's hover text.
 */
export function sameAskLine(status: UserStatus): string {
  if (status.state !== 'waiting') return '';
  const name = (t: string) => `"${t.replace(/\s+/g, ' ').slice(0, 80)}"`;
  if (status.answeredFor) {
    const answer = (status.waitingOn ?? '').split(' for you: ')[1]?.trim();
    return `Answered by ${status.answeredFor.byTitle.replace(/\s+/g, ' ').slice(0, 80)}${answer ? `: ${answer}` : ''}`;
  }
  const fold = status.sameAsk;
  if (!fold) return '';
  if (fold.answered) return `Answered in ${name(fold.title)}`;
  return `Same decision in ${fold.team ? '' : 'its subtask '}${name(fold.title)}`;
}

/** The whole sentence of what a waiting row waits on, for its hover text. */
export function waitingSentence(status: UserStatus): string {
  const on = (status.waitingOn ?? '').trim();
  // A queued or refused start says it whole (src/core/user-status.ts).
  if (/^(Queued|Did not start)\b/.test(on)) return on;
  return on ? `Waiting on ${on.charAt(0).toLowerCase()}${on.slice(1)}` : '';
}

export function waitingLine(status: UserStatus, formatUntil: (iso: string) => string): string {
  const limited = limitedLine(status);
  if (limited) return limited;
  const on = (status.waitingOn ?? '').trim();
  const short = sameAskLine(status);
  if (short) return short;
  if (status.kind === 'stuck') return on ? `Nothing will wake it. ${on}` : 'Nothing will wake it.';
  if (status.kind === 'not-started') return on || 'Not started yet';
  if (status.kind === 'time' && status.until) return `Waiting until ${formatUntil(status.until)}`;
  // A start an older Walnut queued: it says it whole (src/core/user-status.ts queuedWaitingOn).
  if (on.startsWith('Queued')) return on;
  const lower = on ? on.charAt(0).toLowerCase() + on.slice(1) : 'something';
  return `Waiting on ${lower}`;
}

/** The brief above the table: what needs the user, then one line of counts. */
export interface StatusBrief {
  /** Every Needs you row, its `line` saying what to do with it (needsLineText). */
  needs: { id: string; title: string; ask: string; line: string; category?: NeedsCategory; unverified?: boolean }[];
  counts: ShownCounts;
  stuck: number;
  notStarted: number;
  doneWindowDays: number;
}

export function statusBrief(board: StatusBoard): StatusBrief {
  return {
    needs: board.groups.needs.map((r) => {
      const line = needsRowLine(r.status);
      return {
        id: r.task.id, title: r.task.title, ask: r.status.ask ?? '', line: line ? needsLineText(line) : r.status.ask ?? '',
        ...(line ? { category: line.category } : {}), ...(r.status.unverified ? { unverified: true } : {}),
      };
    }),
    counts: board.counts,
    stuck: board.groups.waiting.filter((r) => r.status.kind === 'stuck').length,
    notStarted: board.groups.waiting.filter((r) => isNotStartedStatus(r.status)).length,
    doneWindowDays: board.doneWindowDays,
  };
}

/** "10 Working, 11 Waiting / snoozed (1 with nothing to wake it), 5 Not started, 12 Completed in the last 7 days." */
export function briefCountsLine(b: StatusBrief): string {
  const extra = b.stuck ? ` (${b.stuck} with nothing to wake it)` : '';
  const waiting = `${stateCountLabel('waiting', b.counts.waiting - b.notStarted)}${extra}`;
  const notStarted = b.notStarted ? `, ${b.notStarted} ${NOT_STARTED_LABEL}` : '';
  return `${stateCountLabel('working', b.counts.working)}, ${waiting}${notStarted}, ${stateCountLabel('done', b.counts.done)} in the last ${b.doneWindowDays} days.`;
}

export type StatusFilter = 'open' | StatusChip;
/** A kept filter (usePageViewOf): one of the filters, or the To read chip an older build kept,
 *  which is Needs you now (statusFilterShown). */
export type KeptStatusFilter = StatusFilter | 'read';
export const isStatusFilter = (v: unknown): v is KeptStatusFilter => v === 'open' || v === 'read' || (STATUS_CHIPS as readonly unknown[]).includes(v);
export const statusFilterShown = (v: KeptStatusFilter): StatusFilter => (v === 'read' ? 'needs' : v);

/** The rows a filter shows, in the table's order: Needs you, Working, Waiting and Not started
 *  (open; not started sort last among the waits), or one group. */
export function filteredRows(board: StatusBoard, filter: StatusFilter): StatusRow[] {
  if (filter === 'open') return [...board.groups.needs, ...board.groups.working, ...board.groups.waiting];
  if (filter === 'waiting') return board.groups.waiting.filter((r) => !isNotStartedStatus(r.status));
  if (filter === 'notstarted') return board.groups.waiting.filter((r) => isNotStartedStatus(r.status));
  return board.groups[filter];
}
