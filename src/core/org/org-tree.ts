/**
 * The org above the work: who the user's main agent talks to.
 *
 *   Main (the main agent, one Ask Walnut task)
 *     └ a project            the main agent talks to its lead, or to its one team
 *         ├ lead             a hidden task Walnut makes once a project has 2+ teams
 *         └ team             an open top-level task of the project
 *             └ worker       its subtasks (parent_task_id), as everywhere else
 *
 * Nothing new is stored for the shape: it is DERIVED from what the board already
 * has (projects, parent links, phases), so a task moved on the board is moved in
 * the org too, and a new task falls under its project's lead by itself. The only
 * stored fact is `org_role` on the two kinds of org node, the main agent and a
 * project lead. Dragging in the org chart writes the ordinary fields (a parent
 * link, a project), never an org edge.
 *
 * Pure and shared: the server builds `GET /api/v1/org` and the main agent's
 * update notes from it, the browser draws the org chart from the same function
 * (`@open-walnut/org-tree`), so the two can never disagree about who reports to
 * whom.
 */

import type { OrgRole, TaskPhase } from '../types.js';

/** The fields the org reads off a task. */
export interface OrgTaskLike {
  id: string;
  title: string;
  project?: string;
  phase: TaskPhase;
  parent_task_id?: string;
  org_role?: OrgRole;
  walnut_agent?: boolean;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
  session_id?: string;
  exec_session_id?: string;
}

export interface OrgCounts {
  /** Open tasks, the node itself included. */
  open: number;
  /** IN_PROGRESS. */
  running: number;
  /** NEED_ACTION: the work handed back to the user. */
  needsYou: number;
  /** WAITING (parked). */
  waiting: number;
}

export interface OrgTaskNode {
  kind: 'task';
  id: string;
  title: string;
  project: string;
  phase: TaskPhase;
  hasSession: boolean;
  workers: OrgTaskNode[];
  /** Over this task and every worker below it. */
  counts: OrgCounts;
}

export interface OrgNodeRef {
  id: string;
  title: string;
  phase: TaskPhase;
  hasSession: boolean;
}

export interface OrgProjectNode {
  kind: 'project';
  /** '' = the Inbox. */
  project: string;
  /** The project's lead, once Walnut has made one. */
  lead?: OrgNodeRef;
  /** More than one team: the main agent should talk to a lead, made on first contact. */
  needsLead: boolean;
  /** Who the main agent talks to now: the lead, else the one team. Absent = a lead is still to be made. */
  contactId?: string;
  teams: OrgTaskNode[];
  counts: OrgCounts;
}

export interface OrgTree {
  main?: OrgNodeRef;
  projects: OrgProjectNode[];
  counts: OrgCounts;
}

const ZERO: OrgCounts = { open: 0, running: 0, needsYou: 0, waiting: 0 };

/** The main agent or a project lead: the org's own nodes, never work. */
export function isOrgNode(task: { org_role?: string }): boolean {
  return task.org_role === 'main' || task.org_role === 'lead';
}

/** Hidden from the task lists (the board, the dashboard): the chat slot and the org chart show them. */
export function isHiddenOrgNode(task: { org_role?: string }): boolean {
  return isOrgNode(task);
}

/** Same rule as caller-placement's isAskTask (pinned equal by a test): a conversation, not work. */
function isAskLike(task: { walnut_agent?: boolean; project?: string }): boolean {
  return task.walnut_agent === true || /^ask /i.test((task.project ?? '').trim());
}

/** A task the org counts: open work, not a conversation, not an org node, not a legacy sentinel. */
export function isOrgMember(task: OrgTaskLike): boolean {
  return task.phase !== 'COMPLETE'
    && !isOrgNode(task)
    && !isAskLike(task)
    && !task.title.startsWith('.metadata');
}

export function projectKey(project: string | undefined): string {
  return (project ?? '').trim().toLowerCase();
}

function hasSession(task: OrgTaskLike): boolean {
  return !!(task.session_id || task.exec_session_id);
}

function refOf(task: OrgTaskLike): OrgNodeRef {
  return { id: task.id, title: task.title, phase: task.phase, hasSession: hasSession(task) };
}

const PHASE_RANK: Record<TaskPhase, number> = { NEED_ACTION: 0, IN_PROGRESS: 1, WAITING: 2, TODO: 3, COMPLETE: 4 };

function compareWork(a: OrgTaskNode, b: OrgTaskNode, at: Map<string, string>): number {
  const rank = PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
  if (rank) return rank;
  const ta = at.get(a.id) ?? '';
  const tb = at.get(b.id) ?? '';
  if (ta !== tb) return ta < tb ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

function add(into: OrgCounts, from: OrgCounts): void {
  into.open += from.open;
  into.running += from.running;
  into.needsYou += from.needsYou;
  into.waiting += from.waiting;
}

function ownCounts(phase: TaskPhase): OrgCounts {
  return {
    open: 1,
    running: phase === 'IN_PROGRESS' ? 1 : 0,
    needsYou: phase === 'NEED_ACTION' ? 1 : 0,
    waiting: phase === 'WAITING' ? 1 : 0,
  };
}

/** The one main agent: an open one first, then the newest. */
export function pickMain<T extends OrgTaskLike>(tasks: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const t of tasks) {
    if (t.org_role !== 'main') continue;
    if (!best || better(t, best)) best = t;
  }
  return best;
}

/** A project's lead: an open one first, then the oldest (stable across reads). */
export function pickLead<T extends OrgTaskLike>(tasks: readonly T[], project: string): T | undefined {
  const key = projectKey(project);
  let best: T | undefined;
  for (const t of tasks) {
    if (t.org_role !== 'lead' || projectKey(t.project) !== key) continue;
    if (!best) { best = t; continue; }
    const open = (x: T) => (x.phase === 'COMPLETE' ? 1 : 0);
    if (open(t) !== open(best)) { if (open(t) < open(best)) best = t; continue; }
    if ((t.created_at ?? '') < (best.created_at ?? '')) best = t;
  }
  return best;
}

function better(a: OrgTaskLike, b: OrgTaskLike): boolean {
  const done = (x: OrgTaskLike) => (x.phase === 'COMPLETE' ? 1 : 0);
  if (done(a) !== done(b)) return done(a) < done(b);
  return (a.created_at ?? '') > (b.created_at ?? '');
}

/** Build the whole org from the task list. */
export function buildOrgTree(tasks: readonly OrgTaskLike[]): OrgTree {
  const members = tasks.filter(isOrgMember);
  const byId = new Map(members.map((t) => [t.id, t]));
  const at = new Map(members.map((t) => [t.id, t.updated_at ?? t.created_at ?? '']));
  const children = new Map<string, OrgTaskLike[]>();
  const roots: OrgTaskLike[] = [];
  for (const t of members) {
    const parent = t.parent_task_id ? byId.get(t.parent_task_id) : undefined;
    if (parent && parent.id !== t.id) {
      const list = children.get(parent.id);
      if (list) list.push(t);
      else children.set(parent.id, [t]);
    } else {
      roots.push(t);
    }
  }

  const placed = new Set<string>();
  const nodeOf = (t: OrgTaskLike): OrgTaskNode => {
    placed.add(t.id);
    const counts = ownCounts(t.phase);
    const workers: OrgTaskNode[] = [];
    for (const c of children.get(t.id) ?? []) {
      if (placed.has(c.id)) continue;
      const child = nodeOf(c);
      add(counts, child.counts);
      workers.push(child);
    }
    workers.sort((a, b) => compareWork(a, b, at));
    return {
      kind: 'task', id: t.id, title: t.title, project: (t.project ?? '').trim(), phase: t.phase,
      hasSession: hasSession(t), workers, counts,
    };
  };

  const teamsByProject = new Map<string, { project: string; teams: OrgTaskNode[] }>();
  const placeRoot = (t: OrgTaskLike) => {
    const node = nodeOf(t);
    const key = projectKey(t.project);
    const bucket = teamsByProject.get(key) ?? { project: (t.project ?? '').trim(), teams: [] };
    bucket.teams.push(node);
    teamsByProject.set(key, bucket);
  };
  for (const t of roots) placeRoot(t);
  // A corrupted parent loop has no root; break it at its first member.
  for (const t of members) if (!placed.has(t.id)) placeRoot(t);

  const projects: OrgProjectNode[] = [];
  const total: OrgCounts = { ...ZERO };
  for (const { project, teams } of teamsByProject.values()) {
    teams.sort((a, b) => compareWork(a, b, at));
    const counts: OrgCounts = { ...ZERO };
    for (const team of teams) add(counts, team.counts);
    add(total, counts);
    const picked = project ? pickLead(tasks, project) : undefined;
    // A completed lead talks to no one; the next contact reopens it.
    const lead = picked && picked.phase !== 'COMPLETE' ? picked : undefined;
    // The Inbox is not a project: no lead, its tasks are talked to one by one.
    const needsLead = !!project && teams.length > 1;
    const contactId = lead ? lead.id : teams.length === 1 ? teams[0]?.id : undefined;
    projects.push({
      kind: 'project', project, needsLead, teams, counts,
      ...(lead ? { lead: refOf(lead) } : {}),
      ...(contactId ? { contactId } : {}),
    });
  }
  // A lead whose project has no open work right now still leads it.
  for (const t of tasks) {
    if (t.org_role !== 'lead' || t.phase === 'COMPLETE' || !(t.project ?? '').trim()) continue;
    const key = projectKey(t.project);
    if (teamsByProject.has(key) || projects.some((p) => projectKey(p.project) === key)) continue;
    const lead = pickLead(tasks, t.project!);
    if (!lead || lead.phase === 'COMPLETE') continue;
    projects.push({ kind: 'project', project: (lead.project ?? '').trim(), needsLead: false, teams: [], counts: { ...ZERO }, lead: refOf(lead), contactId: lead.id });
  }
  projects.sort((a, b) => {
    if (!a.project !== !b.project) return a.project ? -1 : 1; // the Inbox last
    return b.counts.needsYou - a.counts.needsYou
      || b.counts.running - a.counts.running
      || b.counts.open - a.counts.open
      || a.project.localeCompare(b.project);
  });

  const main = pickMain(tasks);
  return { ...(main ? { main: refOf(main) } : {}), projects, counts: total };
}

/** The project a name points at, case-insensitively; '' or "inbox" is the Inbox. */
export function findProjectNode(tree: OrgTree, name: string): OrgProjectNode | undefined {
  const key = projectKey(name);
  if (key === 'inbox') return tree.projects.find((p) => !p.project) ?? tree.projects.find((p) => projectKey(p.project) === key);
  return tree.projects.find((p) => projectKey(p.project) === key);
}

// ── The main agent's update note ──

/** What the main agent was last told, per project key. */
export interface OrgDigestState {
  at: string;
  needsYou: Record<string, number>;
}

export interface OrgDigestLine {
  project: string;
  done: number;
  added: number;
  needsYou: number;
  /** needsYou changed since the last note. */
  needsYouChanged: boolean;
}

/** Projects whose work moved since `prev.at`, busiest first. The state to store next comes with it. */
export function orgDigest(
  tasks: readonly OrgTaskLike[],
  prev: OrgDigestState | undefined,
  now: string,
): { lines: OrgDigestLine[]; next: OrgDigestState } {
  const tree = buildOrgTree(tasks);
  const needsYou: Record<string, number> = {};
  const names = new Map<string, string>();
  for (const p of tree.projects) {
    needsYou[projectKey(p.project)] = p.counts.needsYou;
    names.set(projectKey(p.project), p.project);
  }
  const next: OrgDigestState = { at: now, needsYou };
  if (!prev) return { lines: [], next };

  const done = new Map<string, number>();
  const added = new Map<string, number>();
  for (const t of tasks) {
    if (isOrgNode(t) || isAskLike(t) || t.title.startsWith('.metadata')) continue;
    const key = projectKey(t.project);
    if (!names.has(key)) names.set(key, (t.project ?? '').trim());
    if (t.phase === 'COMPLETE' && t.completed_at && t.completed_at > prev.at) done.set(key, (done.get(key) ?? 0) + 1);
    if (t.created_at && t.created_at > prev.at && t.phase !== 'COMPLETE') added.set(key, (added.get(key) ?? 0) + 1);
  }
  const keys = new Set([...done.keys(), ...added.keys(), ...Object.keys(needsYou), ...Object.keys(prev.needsYou)]);
  const lines: OrgDigestLine[] = [];
  for (const key of keys) {
    const now_ = needsYou[key] ?? 0;
    const before = prev.needsYou[key] ?? 0;
    const line: OrgDigestLine = {
      project: names.get(key) ?? key,
      done: done.get(key) ?? 0,
      added: added.get(key) ?? 0,
      needsYou: now_,
      needsYouChanged: now_ !== before,
    };
    if (line.done || line.added || line.needsYouChanged) lines.push(line);
  }
  lines.sort((a, b) => (b.needsYou - a.needsYou) || ((b.done + b.added) - (a.done + a.added)) || a.project.localeCompare(b.project));
  return { lines, next };
}

/** Most project lines one note carries; the rest are counted. */
export const DIGEST_MAX_LINES = 6;

/** One short line per moved project. */
export function formatDigestLine(line: OrgDigestLine): string {
  const parts: string[] = [];
  if (line.done) parts.push(`${line.done} done`);
  if (line.added) parts.push(`${line.added} new`);
  if (line.needsYou) parts.push(`${line.needsYou} waiting on the user`);
  else if (line.needsYouChanged) parts.push('nothing waiting on the user now');
  return `${line.project || 'Inbox'}: ${parts.join(', ')}`;
}
