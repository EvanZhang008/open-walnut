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
import type { Task } from '@open-walnut/core';
import { directorsOf, orgDisplayTitle, projectKey, type OrgDirector, type OrgTaskNode } from '@open-walnut/org-tree';
import { stateTab, type OrgStateTab } from './org-task-tabs';
import type { VpProject } from './org-chart-model';

export interface LeaderNode {
  id: string;
  title: string;
  state: OrgStateTab;
  /** How many open tasks report to it directly. */
  leads: number;
  /** On the user's Watching list (Task.watched_at): it wears the eye, wherever else it shows. */
  watched: boolean;
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
function leaderOf(d: OrgDirector, byId: ReadonlyMap<string, Task>): LeaderNode {
  const task = byId.get(d.id);
  return {
    id: d.id,
    title: task ? orgDisplayTitle(task) : d.title,
    // The tree is built from these same tasks; one missing reads as waiting.
    state: task ? stateTab(task) : 'waiting',
    leads: d.leads,
    watched: !!task?.watched_at,
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

export const leadersLabel = (n: number): string => `${n} leader${n === 1 ? '' : 's'}`;

function* allLeaders(nodes: readonly LeaderNode[]): Generator<LeaderNode> {
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
