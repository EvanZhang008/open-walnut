/**
 * Who may write a task's Board.
 *
 * Humans always (no caller sid: the web UI, the phone, the user's own CLI). A
 * session only when its task IS the board's task or one of its descendants
 * (`parent_task_id` chain): the leader and its workers share one board. Every
 * other caller is refused, including a session with no task and an unidentified
 * process (the `external` gateway label), which proves no team membership.
 *
 * And which board a team shares (resolveTeamBoardTask): a worker opening the
 * Board, or calling board_* without naming a task, lands on its leader's.
 */

import { BoardError, hasBoard } from './board-store.js';

/** Ancestors walked before giving up; subtasks nest at most a few levels. */
export const TEAM_WALK_CAP = 32;

export interface TeamBoardOwner {
  taskId: string;
  title: string;
  /** The owner is the task asked about. */
  self: boolean;
  hasBoard: boolean;
}

/**
 * A team shares ONE board: whose is it for `taskId`? The task itself when it
 * has a board; else the nearest ancestor (`parent_task_id` chain) that has one;
 * else the topmost ancestor, the root of its tree (the task itself when it has
 * no parent), which is where the team's board will be made. A corrupt chain (a
 * cycle, or deeper than the cap) with no board on it answers the task itself,
 * so a write never lands on an arbitrary task in the loop. Throws for an
 * unknown `taskId` (the caller resolved it already).
 */
export async function resolveTeamBoardTask(taskId: string): Promise<TeamBoardOwner> {
  const { getTask } = await import('../task-manager.js');
  const start = await getTask(taskId);
  const chain: Array<{ id: string; title: string }> = [start];
  const seen = new Set([start.id]);
  let broken = false;
  let parentId: string | undefined = start.parent_task_id || undefined;
  while (parentId) {
    if (seen.has(parentId) || chain.length > TEAM_WALK_CAP) { broken = true; break; }
    const parent = await getTask(parentId).catch(() => undefined);
    if (!parent) break;
    seen.add(parent.id);
    chain.push(parent);
    parentId = parent.parent_task_id || undefined;
  }
  for (const t of chain) {
    if (await hasBoard(t.id)) return { taskId: t.id, title: t.title, self: t.id === start.id, hasBoard: true };
  }
  const top = broken ? start : chain[chain.length - 1];
  return { taskId: top.id, title: top.title, self: top.id === start.id, hasBoard: false };
}

export type BoardCaller =
  | { kind: 'human' }
  | { kind: 'task'; taskId: string; sessionId: string };

/**
 * True when `taskId` is `boardTaskId` or below it. Walks `parent_task_id`
 * upward with a seen set and a cap, so a corrupt cyclic chain terminates.
 */
export async function isWithinTeam(boardTaskId: string, taskId: string): Promise<boolean> {
  const { getTask } = await import('../task-manager.js');
  const seen = new Set<string>();
  let current: string | undefined = taskId;
  for (let step = 0; current && step <= TEAM_WALK_CAP; step++) {
    if (current === boardTaskId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const parent: string | undefined = await getTask(current).then((t) => t.parent_task_id, () => undefined);
    current = parent || undefined;
  }
  return false;
}

/** Resolve the caller and refuse anyone outside the board task's team (403 `not_in_team`). */
export async function callerMayWriteBoard(boardTaskId: string, callerSid: string | undefined): Promise<BoardCaller> {
  const { resolveCallerPlacement } = await import('../sessions/caller-placement.js');
  const caller = await resolveCallerPlacement(callerSid);
  if (caller.kind === 'human') return { kind: 'human' };
  if (caller.kind === 'ask' || caller.kind === 'worker') {
    if (await isWithinTeam(boardTaskId, caller.task.id)) {
      return { kind: 'task', taskId: caller.task.id, sessionId: caller.session.id };
    }
    throw new BoardError('not_in_team', 403, { callerTaskId: caller.task.id });
  }
  throw new BoardError('not_in_team', 403, undefined, caller.kind === 'untracked'
    ? 'This session has no task, so it is in no board\'s team'
    : 'Unidentified callers may not write a board');
}
