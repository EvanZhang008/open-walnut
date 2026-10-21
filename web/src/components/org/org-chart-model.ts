/**
 * The org chart's drag rules, pure. A drop writes only the board's own fields,
 * never an org edge (the org is derived, see src/core/org/org-tree.ts):
 *   - onto a task  → the dragged task becomes its worker (parent link)
 *   - onto a project column → it becomes one of that project's teams
 *     (moved to the project, parent link cleared)
 * A drop that changes nothing, or that would put a task under itself, is refused.
 */

import type { OrgProjectNode, OrgTaskNode, OrgTree } from '@open-walnut/org-tree';
import { projectKey } from '@open-walnut/org-tree';

export type OrgDropTarget =
  | { kind: 'task'; id: string }
  | { kind: 'project'; project: string };

export type OrgDropAction =
  | { kind: 'reparent'; taskId: string; parentId: string }
  | { kind: 'team'; taskId: string; project: string; moveProject: boolean; clearParent: boolean };

export interface OrgPlace {
  node: OrgTaskNode;
  /** The org parent (a task), absent for a team. */
  parentId?: string;
  project: string;
}

/** Every task node of the tree by id, with where it sits. */
export function indexOrg(tree: OrgTree): Map<string, OrgPlace> {
  const out = new Map<string, OrgPlace>();
  const walk = (nodes: OrgTaskNode[], project: string, parentId?: string) => {
    for (const n of nodes) {
      out.set(n.id, { node: n, project, ...(parentId ? { parentId } : {}) });
      walk(n.workers, project, n.id);
    }
  };
  for (const p of tree.projects) walk(p.teams, p.project);
  return out;
}

function contains(node: OrgTaskNode, id: string): boolean {
  return node.workers.some((w) => w.id === id || contains(w, id));
}

/** What dropping `taskId` on `target` does, or null when it would do nothing or loop. */
export function dropAction(index: Map<string, OrgPlace>, taskId: string, target: OrgDropTarget): OrgDropAction | null {
  const dragged = index.get(taskId);
  if (!dragged) return null;
  if (target.kind === 'task') {
    if (target.id === taskId || contains(dragged.node, target.id)) return null;
    if (dragged.parentId === target.id) return null;
    if (!index.has(target.id)) return null;
    return { kind: 'reparent', taskId, parentId: target.id };
  }
  const moveProject = projectKey(dragged.node.project) !== projectKey(target.project);
  const clearParent = !!dragged.parentId;
  if (!moveProject && !clearParent) return null;
  return { kind: 'team', taskId, project: target.project, moveProject, clearParent };
}

/** The column header's line about who Main talks to here. */
export function contactLine(p: OrgProjectNode): string {
  if (p.lead) return `Lead: ${p.lead.title}`;
  if (p.needsLead) return 'No lead yet: Chat makes one';
  if (!p.project && p.teams.length > 1) return 'Main talks to each task';
  return 'Main talks to this task directly';
}

/** "31 open · 3 waiting on you · 2 running", only the parts that are not zero. */
export function countsLine(c: { open: number; needsYou: number; running: number; waiting: number }): string {
  const parts = [`${c.open} open`];
  if (c.needsYou) parts.push(`${c.needsYou} waiting on you`);
  if (c.running) parts.push(`${c.running} running`);
  if (c.waiting) parts.push(`${c.waiting} parked`);
  return parts.join(' · ');
}
