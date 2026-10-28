/**
 * Who writes a task's Board, and which board a team shares.
 *
 * Anyone may write any board (2026-10-27, the user: "all human action can be done
 * by agent also"): the user (no caller sid: the web UI, the phone), a session's
 * task (`task:<id>`), and an agent Walnut cannot place ('agent': a session with no
 * task, an env-less `walnut`). The writer is recorded, never refused; the Board
 * shows who wrote what, and the user can change it back.
 *
 * Which board a team shares (resolveTeamBoardTask): a worker opening the Board, or
 * calling board_* without naming a task, lands on its leader's. That is only the
 * default target; naming another task's board writes that one.
 */

import type { Task } from '../types.js';
import { hasBoard, type BoardFile, type BoardWriter, type BoardWriterStamp } from './board-store.js';
import { effectiveLanes, type BoardTeamEntry } from './board-lanes.js';

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
  | { kind: 'task'; taskId: string; sessionId: string }
  /**
   * A session with no task (`untracked`), or a sid Walnut cannot place
   * (`external`: an env-less `walnut`, or an unknown sid).
   */
  | { kind: 'agent'; sessionId: string; untracked?: true };

/** Who is writing (from `x-walnut-caller-sid`). Never refuses: every caller may write every board. */
export async function resolveBoardCaller(callerSid: string | undefined): Promise<BoardCaller> {
  const { resolveCallerPlacement } = await import('../sessions/caller-placement.js');
  const caller = await resolveCallerPlacement(callerSid);
  if (caller.kind === 'human') return { kind: 'human' };
  if (caller.kind === 'ask' || caller.kind === 'worker') {
    return { kind: 'task', taskId: caller.task.id, sessionId: caller.session.id };
  }
  if (caller.kind === 'untracked') return { kind: 'agent', sessionId: caller.session.id, untracked: true };
  return { kind: 'agent', sessionId: (callerSid ?? '').trim() };
}

/**
 * Whether the brakes a session's task_create meets (subtask depth, short title)
 * apply to this caller's board writes that make a task. The same rule as
 * create-rules.ts (`'session' in caller`): every session, a worker's, a Personal
 * AI ask's and one with no task alike; never the user or a process that is no
 * session at all.
 */
export function boardCallerBraked(caller: BoardCaller): boolean {
  return caller.kind === 'task' || (caller.kind === 'agent' && caller.untracked === true);
}

/** The caller as a board record names it. */
export function boardWriter(caller: BoardCaller): BoardWriter {
  return caller.kind === 'human' ? 'human' : caller.kind === 'task' ? `task:${caller.taskId}` : 'agent';
}

const NAME_TITLE_MAX = 60;

/**
 * The caller as the user reads it beside what it did: "the CEO" (Main), "the
 * Growth VP" (a lead), `the task "..."` (its title on one line, at most 60
 * characters), or "an agent" (no task Walnut can find); undefined for the user,
 * whose writes carry no name.
 */
export async function boardWriterName(caller: BoardCaller): Promise<string | undefined> {
  if (caller.kind === 'human') return undefined;
  if (caller.kind === 'agent') return 'an agent';
  const { getTask } = await import('../task-manager.js');
  const task = await getTask(caller.taskId).catch(() => undefined);
  if (!task) return 'an agent';
  if (task.org_role === 'main' || task.org_role === 'lead') {
    const { orgDisplayTitle } = await import('../org/org-tree.js');
    const role = oneLine(orgDisplayTitle(task));
    if (role) return `the ${role}`;
  }
  const title = oneLine(task.title ?? '');
  return title ? `the task "${title}"` : 'a task';
}

/** A title as one short line: every run of whitespace (newlines, tabs) one space, at most NAME_TITLE_MAX characters. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > NAME_TITLE_MAX ? `${flat.slice(0, NAME_TITLE_MAX - 1).trimEnd()}\u2026` : flat;
}

/** `by` and, for an agent, `by_name`: what a write the user could also make records. */
export async function boardWriterStamp(caller: BoardCaller): Promise<BoardWriterStamp> {
  const name = await boardWriterName(caller);
  return { by: boardWriter(caller), ...(name ? { by_name: name } : {}) };
}

// ── The team as the kanban sees it ──

/** Direct subtasks GET reports as the team (open first, then completions newest first). */
export const TEAM_LIST_CAP = 500;

export interface TeamSnapshot {
  ownerId: string;
  owner?: Task;
  /** The owner's direct subtasks, open first, then completions newest first; capped. */
  children: Task[];
  /** Every task below the owner (a card may be any of them; never the owner). */
  members: Set<string>;
  byId: Map<string, Task>;
}

/** One read of the store: who is on the owner's team (cycle safe, depth capped). */
export async function teamSnapshot(ownerId: string): Promise<TeamSnapshot> {
  const { listTasks } = await import('../task-manager.js');
  const tasks = await listTasks();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const below = new Map<string, boolean>();
  const isBelow = (id: string): boolean => {
    const path: string[] = [];
    let cur: string | undefined = id;
    let result = false;
    while (cur && path.length <= TEAM_WALK_CAP) {
      const known = below.get(cur);
      if (known !== undefined) { result = known; break; }
      if (path.includes(cur)) break;
      path.push(cur);
      const parent: string | undefined = byId.get(cur)?.parent_task_id || undefined;
      if (parent === ownerId) { result = true; break; }
      cur = parent;
    }
    for (const p of path) below.set(p, result);
    return result;
  };
  const members = new Set(tasks.filter((t) => t.id !== ownerId && isBelow(t.id)).map((t) => t.id));
  const direct = tasks.filter((t) => t.parent_task_id === ownerId && t.id !== ownerId);
  const open = direct.filter((t) => t.phase !== 'COMPLETE');
  const done = direct.filter((t) => t.phase === 'COMPLETE')
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
  return { ownerId, owner: byId.get(ownerId), children: [...open, ...done].slice(0, TEAM_LIST_CAP), members, byId };
}

/** The tags the lane template is picked from: the owner's and its direct subtasks'. */
export function teamTags(snap: TeamSnapshot): string[] {
  return [...(snap.owner?.tags ?? []), ...snap.children.flatMap((t) => t.tags ?? [])];
}

/** The kanban part of GET /tasks/:id/board (also when there is no board file). */
export function kanbanFields(board: BoardFile | null, snap: TeamSnapshot) {
  const eff = effectiveLanes(board?.lanes, teamTags(snap), board?.lanes_template);
  const team: BoardTeamEntry[] = snap.children.map((t) => ({
    id: t.id, phase: t.phase, ...(t.completed_at ? { completed_at: t.completed_at } : {}),
  }));
  return {
    lanes: board?.lanes ?? null,
    lanes_effective: eff.lanes,
    lanes_template: board?.lanes_template ?? eff.template,
    cards: board?.cards ?? {},
    team,
    kanban_seen: board?.kanban_seen ?? null,
    ...(board?.kanban_seen_agent ? { kanban_seen_agent: board.kanban_seen_agent } : {}),
  };
}
