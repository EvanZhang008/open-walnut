/**
 * The Board's Status view (BoardStatusView.tsx): every task of the team in ONE list, by the
 * one status the user sees (src/core/user-status.ts), the same four states and the same
 * counts as the Org page, the task list and the phone. Pure: no React, no DOM. Unit-pinned
 * in tests/web/board-status-model.test.ts.
 *
 * Order, top down: Needs you (newest first), Working (latest activity first), Waiting (stuck
 * first, then by what it waits on, not started last), Done (the recent window, newest first).
 * A worker under another worker is listed flat and says whom it is under.
 */
import type { Task } from '@open-walnut/core';
import {
  USER_STATES, countUserStates, dueAtMs, fallbackUserState, stateCountLabel,
  type UserState, type UserStatus, type UserStatusCounts, type WaitKind,
} from '@open-walnut/user-status';
import { teamChildren, walkTeam } from './board-overview-model';

export interface StatusRow {
  task: Task;
  status: UserStatus;
  /** 0 = the board's owner (the lead), 1 = a direct subtask of it. */
  depth: number;
  /** A deeper worker: the title of the task it is under. */
  under?: string;
}

export interface StatusBoard {
  counts: UserStatusCounts;
  groups: Record<UserState, StatusRow[]>;
  /** Finished tasks older than the window are left out of Done (and its count). */
  doneWindowDays: number;
}

/** The stored status, else what the phase alone says (a task the server has not derived yet). */
export function userStatusOf(task: Task): UserStatus {
  if (task.phase === 'COMPLETE' || task.status === 'done') return { state: 'done' };
  if (task.user_status) return task.user_status;
  const state = fallbackUserState(task.phase, task.status);
  // Not derived yet (an older server): a hand back reads as an older Walnut meant it.
  return state === 'needs' ? { state, ask: 'Open it: its session handed the task back.' } : { state };
}

const WAIT_ORDER: Record<WaitKind, number> = {
  stuck: 0, you: 1, task: 2, lead: 3, outside: 4, machine: 4, time: 5, other: 6, 'not-started': 9,
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
  const groups: Record<UserState, StatusRow[]> = { needs: [], working: [], waiting: [], done: [] };
  for (const m of members) {
    const status = userStatusOf(m.task);
    if (status.state === 'done' && ms(m.task.completed_at ?? m.task.updated_at) < cutoff) continue;
    groups[status.state].push({
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
  const counts = countUserStates(USER_STATES.flatMap((s) => groups[s].map((r) => r.status)));
  return { counts, groups, doneWindowDays: input.doneWindowDays };
}

/** A waiting row's one line: "Waiting on another task: …", "Nothing will wake it. …", "Not started yet". */
export function waitingLine(status: UserStatus, formatUntil: (iso: string) => string): string {
  const on = (status.waitingOn ?? '').trim();
  if (status.kind === 'stuck') return on ? `Nothing will wake it. ${on}` : 'Nothing will wake it.';
  if (status.kind === 'not-started') return on || 'Not started yet';
  if (status.kind === 'time' && status.until) return `Waiting until ${formatUntil(status.until)}`;
  const lower = on ? on.charAt(0).toLowerCase() + on.slice(1) : 'something';
  return `Waiting on ${lower}`;
}

/** The brief above the table: what needs the user, then one line of counts. */
export interface StatusBrief {
  needs: { id: string; title: string; ask: string; unverified?: boolean }[];
  counts: UserStatusCounts;
  stuck: number;
  notStarted: number;
  doneWindowDays: number;
}

export function statusBrief(board: StatusBoard): StatusBrief {
  return {
    needs: board.groups.needs.map((r) => ({ id: r.task.id, title: r.task.title, ask: r.status.ask ?? '', ...(r.status.unverified ? { unverified: true } : {}) })),
    counts: board.counts,
    stuck: board.groups.waiting.filter((r) => r.status.kind === 'stuck').length,
    notStarted: board.groups.waiting.filter((r) => r.status.kind === 'not-started').length,
    doneWindowDays: board.doneWindowDays,
  };
}

/** "10 Working, 16 Waiting / snoozed (1 with nothing to wake it, 5 not started), 12 Completed in the last 7 days." */
export function briefCountsLine(b: StatusBrief): string {
  const extra = [b.stuck ? `${b.stuck} with nothing to wake it` : '', b.notStarted ? `${b.notStarted} not started` : ''].filter(Boolean).join(', ');
  const waiting = `${stateCountLabel('waiting', b.counts.waiting)}${extra ? ` (${extra})` : ''}`;
  return `${stateCountLabel('working', b.counts.working)}, ${waiting}, ${stateCountLabel('done', b.counts.done)} in the last ${b.doneWindowDays} days.`;
}

export type StatusFilter = 'open' | UserState;

/** The rows a filter shows, in the table's order: Needs you, Working, Waiting (open), or one state. */
export function filteredRows(board: StatusBoard, filter: StatusFilter): StatusRow[] {
  if (filter === 'open') return [...board.groups.needs, ...board.groups.working, ...board.groups.waiting];
  return board.groups[filter];
}
