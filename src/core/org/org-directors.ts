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

/** A Director and the Directors below it. */
export interface OrgDirector {
  id: string;
  title: string;
  /** How many open tasks report to it directly. */
  leads: number;
  /** The nearest Directors below it, at any depth (a task that is no Director in between is skipped). */
  subs: OrgDirector[];
}

/**
 * The Directors among `teams` (a project's teams, in the tree's order), each with the Directors
 * below it. A task that is no Director is transparent: the Directors under it are listed in its
 * place, under the nearest Director above (or at the top). `seen` keeps one task from being listed
 * twice across several calls (a VP reading several projects).
 */
export function directorsOf(teams: readonly OrgTaskNode[], seen: Set<string> = new Set()): OrgDirector[] {
  const out: OrgDirector[] = [];
  for (const n of teams) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    const below = directorsOf(n.workers, seen);
    if (n.director) out.push({ id: n.id, title: n.title, leads: n.workers.length, subs: below });
    else out.push(...below);
  }
  return out;
}
