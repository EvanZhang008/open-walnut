/**
 * Directors: the layer between a VP and the work (2026-11-20, the user: "leader default is
 * director ... we can also de-promote or promote any task to director"). A leader is an open task
 * with an open worker; by default (no Task.director) it is a Director. The user, or an agent, may
 * say yes (a Director with no team yet) or no (a leader that is not one). The Org page, org_get and
 * the tree served to the clients all read this one rule.
 *
 * Pure and shared with the web through org-tree.ts (`@open-walnut/org-tree`): no node imports.
 */
import type { DirectorChoice } from '../types.js';
import type { OrgTaskNode } from './org-tree.js';

/** Is a task a Director: its choice, else (auto) whether it leads any open worker. */
export function isDirector(choice: DirectorChoice | undefined, openWorkers: number): boolean {
  if (choice === 'yes') return true;
  if (choice === 'no') return false;
  return openWorkers > 0;
}

/**
 * What making a task a Director, or taking it off, writes (Task.director): the least that gives the
 * asked result, so the default keeps working. Taken off: 'no' only for a leader (auto would keep it on);
 * a task with no open worker goes back to auto, so it becomes one by itself once it leads a team. Made
 * one: auto for a leader (it is one by default), 'yes' for a task with no open worker.
 */
export function directorWrite(make: boolean, openWorkers: number): 'yes' | 'no' | 'auto' {
  if (make) return openWorkers > 0 ? 'auto' : 'yes';
  return openWorkers > 0 ? 'no' : 'auto';
}

/** A Director, as org_get and the Org page list it. */
export interface OrgDirector {
  id: string;
  title: string;
  /** How many open tasks report to it directly. */
  leads: number;
  /** Always empty since 2026-11-24 (the user: only the first layer of leaders, not the second): only the
   * first Director on a path is listed. Kept so a client that reads it still gets an array. */
  subs: OrgDirector[];
}

/**
 * The Directors among `teams` (a project's teams, in the tree's order): the first Director on each
 * path down, one level only. A task that is no Director is transparent: the first Directors under it
 * are listed in its place. Everything under a Director is its own team, never listed (2026-11-24, the
 * user: only the first layer of leaders, not the second), and it is marked seen, so a team another
 * project also lists is not listed there. `seen` keeps one task from being listed twice across several
 * calls (a VP reading several projects).
 */
export function directorsOf(teams: readonly OrgTaskNode[], seen: Set<string> = new Set()): OrgDirector[] {
  const out: OrgDirector[] = [];
  for (const n of teams) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (n.director) {
      markSeen(n.workers, seen);
      out.push({ id: n.id, title: n.title, leads: n.workers.length, subs: [] });
    } else out.push(...directorsOf(n.workers, seen));
  }
  return out;
}

function markSeen(nodes: readonly OrgTaskNode[], seen: Set<string>): void {
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    markSeen(n.workers, seen);
  }
}
