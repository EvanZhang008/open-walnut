/**
 * The leaders under a VP, pure (2026-11-20, the user: "show the leaders under VP, also leader below
 * them ... also in org chart, but by default it should be collapsed"). A leader is an open task with
 * at least one open task under it (its team). They are listed by the project they belong to, the
 * VP's projects in the chart's order (2026-11-20, the user: "那个 project 下面有 leader 就放在那个
 * project 下面"): VP -> project -> leader -> the leaders under it. A project with no leader is left
 * out, and a VP with one project still names it. The Org list and the Org chart draw the same groups
 * (OrgLeaders.tsx), behind the `org_leaders` experiment.
 *
 * Who is listed is the shared Director rule (src/core/org/org-directors.ts directorsOf): a leader is a
 * Director by default, the user may make any task one (Task.director 'yes') or take a leader off
 * ('no'), and a task that is no Director passes the Directors under it up.
 */
import { projectOrInbox, type Task } from '@open-walnut/core';
import { directorsOf, orgDisplayTitle, projectKey, type OrgDirector, type OrgTaskNode } from '@open-walnut/org-tree';
import { resolveTaskSessionId } from '@/utils/session-status';
import { stateWord, type UserState } from '@open-walnut/user-status';
import { stateTab, type OrgStateTab } from './org-task-tabs';
import type { VpCard, VpProject } from './org-chart-model';
import { shownName, type ChannelRow } from './org-channels-model';

export interface LeaderNode {
  id: string;
  title: string;
  state: OrgStateTab;
  /** Its state in one word for a row that names it ("Not started", "Waiting", "Working"...). */
  stateText: string;
  /** How many open tasks report to it directly. */
  leads: number;
  /** On the user's Watching list (Task.watched_at): it wears the eye, wherever else it shows. */
  watched: boolean;
  /** Its session (its chat), when it has one: "Open chat" opens it. */
  sessionId?: string;
  /** The leaders among the tasks under it, at any depth below (a task that is none adds none). */
  subs: LeaderNode[];
}

export interface LeaderGroup {
  /** The project's row key (VpProject.key). */
  key: string;
  project: string;
  name: string;
  leaders: LeaderNode[];
}

/** One project of a VP, as the groups need it. */
export type LeaderSource = Pick<VpProject, 'key' | 'project' | 'name'> & { teams: readonly OrgTaskNode[] };

export const sourcesOf = (projects: readonly VpProject[]): LeaderSource[] =>
  projects.map((p) => ({ key: p.key, project: p.project, name: p.name, teams: p.row.node?.teams ?? [] }));

/** A Director as the Org page draws it: its title as the UI shows it, its state and its eye. */
/** One word for a Director's state where its row names it: "Not started" for a task never started,
 *  else the state's own word ("Waiting" or "Snoozed", never the tab's "Waiting / snoozed"). */
function stateTextOf(task: Task | undefined): string {
  if (!task) return stateWord('waiting');
  if (task.phase === 'TODO' && !resolveTaskSessionId(task)) return 'Not started';
  return stateWord(stateTab(task) as UserState, !!task.user_status?.snoozed);
}

function leaderOf(d: OrgDirector, byId: ReadonlyMap<string, Task>): LeaderNode {
  const task = byId.get(d.id);
  return {
    id: d.id,
    title: task ? orgDisplayTitle(task) : d.title,
    // The tree is built from these same tasks; one missing reads as waiting.
    state: task ? stateTab(task) : 'waiting',
    stateText: stateTextOf(task),
    leads: d.leads,
    watched: !!task?.watched_at,
    ...(task && resolveTaskSessionId(task) ? { sessionId: resolveTaskSessionId(task)! } : {}),
    subs: d.subs.map((s) => leaderOf(s, byId)),
  };
}

/** The leaders among `nodes` (the tree's own order: what needs the user first, then the newest). */
function leadersIn(nodes: readonly OrgTaskNode[], byId: ReadonlyMap<string, Task>, seen: Set<string>): LeaderNode[] {
  return directorsOf(nodes, seen).map((d) => leaderOf(d, byId));
}

/** The VP's leaders, by project, in the order of its projects. Only a project's own teams count
 *  (a VP row folds the teams of the projects it leads into its own). */
export function leaderGroups(projects: readonly LeaderSource[], byId: ReadonlyMap<string, Task>): LeaderGroup[] {
  const seen = new Set<string>();
  const groups: LeaderGroup[] = [];
  for (const p of projects) {
    const own = p.teams.filter((t) => projectKey(t.project) === projectKey(p.project));
    const leaders = leadersIn(own, byId, seen);
    if (leaders.length) groups.push({ key: p.key, project: p.project, name: p.name, leaders });
  }
  return groups;
}

/** How many leaders the toggle counts: the ones right under the VP's projects. */
export const leaderTotal = (groups: readonly LeaderGroup[]): number => groups.reduce((n, g) => n + g.leaders.length, 0);

/** The fold's words (2026-11-20, the user: "the tab leader should change to directors"). */
export const directorsLabel = (n: number): string => `${n} director${n === 1 ? '' : 's'}`;

/** The groups the fold draws: by project (the default), or, with the project names off (Settings →
 *  Org), one group with no name holding every Director in the same order. */
export function foldGroups(groups: readonly LeaderGroup[], showProjects: boolean): readonly LeaderGroup[] {
  if (showProjects || groups.length === 0) return groups;
  return [{ key: '*', project: '', name: '', leaders: groups.flatMap((g) => g.leaders) }];
}

/**
 * The first `first` Directors of an opened fold, whole groups cut where the count runs out, and how
 * many it leaves for "N more". Hiding a single one saves nothing (its "1 more" line is as tall as
 * the row), so up to `first + 1` all show.
 */
export function firstLeaders(groups: readonly LeaderGroup[], first: number): { groups: readonly LeaderGroup[]; hidden: number } {
  const total = leaderTotal(groups);
  if (total <= first + 1) return { groups, hidden: 0 };
  const out: LeaderGroup[] = [];
  let left = first;
  for (const g of groups) {
    if (left <= 0) break;
    const leaders = g.leaders.slice(0, left);
    left -= leaders.length;
    out.push(leaders.length === g.leaders.length ? g : { ...g, leaders });
  }
  return { groups: out, hidden: total - first };
}

/** Every Director, a Director's own Directors right after it: the DIRECTORS section's rows (one level). */
export const flatDirectors = (groups: readonly LeaderGroup[]): LeaderNode[] => groups.flatMap((g) => [...allLeaders(g.leaders)]);

export function* allLeaders(nodes: readonly LeaderNode[]): Generator<LeaderNode> {
  for (const n of nodes) { yield n; yield* allLeaders(n.subs); }
}

const wordsOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const hits = (l: LeaderNode, words: readonly string[]) => words.every((w) => l.title.toLowerCase().includes(w));

/** A search for `q` finds one of these leaders (every word in its title), at any depth. */
export function leadersMatch(groups: readonly LeaderGroup[], q: string): boolean {
  const words = wordsOf(q);
  return !!words.length && groups.some((g) => [...allLeaders(g.leaders)].some((l) => hits(l, words)));
}

/** A search for `q` finds a leader somewhere under this one: its fold shows open while it does. */
export function subsMatch(leader: LeaderNode, q: string): boolean {
  const words = wordsOf(q);
  return !!words.length && [...allLeaders(leader.subs)].some((l) => hits(l, words));
}

/** One row of the DIRECTORS section (OrgDirectorSection): a Director and the VP it is under. */
export interface DirectorRow { director: LeaderNode; vp: ChannelRow }

/** The section's rows: by VP in the list's order, then the tree's order, one level. A search shows the
 *  Directors it finds, and every Director of a VP whose name it finds. */
export function directorRows(vps: readonly ChannelRow[], groupsOf: (row: ChannelRow) => readonly LeaderGroup[], query = ''): DirectorRow[] {
  const words = wordsOf(query);
  return vps.flatMap((vp) => {
    const all = flatDirectors(groupsOf(vp));
    const vpHit = words.length > 0 && words.every((w) => shownName(vp).toLowerCase().includes(w));
    return (words.length && !vpHit ? all.filter((d) => hits(d, words)) : all).map((director) => ({ director, vp }));
  });
}

/** The projects a New Director may go to, per VP card: the projects that VP leads, the Inbox by its
 *  name (a row says '' for it; the Inbox has its VP like any project since 2026-11-21). */
export function directorProjectsByVp(cards: readonly Pick<VpCard, 'key' | 'projects'>[]): Map<string, { project: string; name: string }[]> {
  return new Map(cards.map((c) => [c.key, c.projects.map((p) => ({ project: projectOrInbox(p.project), name: p.name }))] as const));
}
