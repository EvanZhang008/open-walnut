/**
 * /tasks table sorting + grouping helpers — pure logic, no React.
 * Kept separate from TasksPageTable.tsx so vitest can exercise the ranking
 * rules without mounting the component.
 */
import type { Task } from '@open-walnut/core';

export type TpSortKey = 'title' | 'priority' | 'due' | 'session' | 'project';
export type TpSortDir = 'asc' | 'desc';
export interface TpSort { key: TpSortKey; dir: TpSortDir }

/** Missing values always sink to the bottom regardless of direction. */
const PRIORITY_RANK: Record<string, number> = { immediate: 0, important: 1, backlog: 2 };

function priorityRank(t: Task): number {
  return PRIORITY_RANK[t.priority] ?? 3;
}

/** running < idle < error < stopped < no session — "what needs me" first. */
function sessionRank(t: Task): number {
  const status = t.session_status?.process_status
    ?? t.exec_session_status?.process_status
    ?? t.plan_session_status?.process_status;
  switch (status) {
    case 'running': return 0;
    case 'idle': return 1;
    case 'error': return 2;
    case 'stopped': return 3;
    default: return 4;
  }
}

export function compareTasks(a: Task, b: Task, sort: TpSort): number {
  const sign = sort.dir === 'asc' ? 1 : -1;
  switch (sort.key) {
    case 'title':
      return sign * a.title.localeCompare(b.title);
    case 'priority': {
      const d = priorityRank(a) - priorityRank(b);
      // "none" (rank 3) stays last in BOTH directions — flipping the sign would
      // surface the priority-less pile above real priorities on desc.
      if (priorityRank(a) === 3 || priorityRank(b) === 3) return d;
      return sign * d;
    }
    case 'due': {
      const av = a.due_date || '';
      const bv = b.due_date || '';
      if (!av && !bv) return 0;
      if (!av) return 1; // dateless last, both directions
      if (!bv) return -1;
      return sign * av.localeCompare(bv);
    }
    case 'session': {
      const d = sessionRank(a) - sessionRank(b);
      if (sessionRank(a) === 4 || sessionRank(b) === 4) return d;
      return sign * d;
    }
    case 'project':
      return sign * (a.project || '').localeCompare(b.project || '');
  }
}

export function sortTasks(tasks: Task[], sort: TpSort | null): Task[] {
  if (!sort) return tasks;
  return [...tasks].sort((a, b) => compareTasks(a, b, sort));
}

/**
 * Group tasks by project for the All-Tasks grouped view.
 * Order: `projectOrder` first (case-insensitive), then alphabetical for
 * projects not in the order list. Inbox ('') is pinned last — same convention
 * as the home panel's grouped memo (it never enters `ordering.projects`).
 */
export function groupTasksByProject(
  tasks: Task[],
  projectOrder: string[],
): { project: string; tasks: Task[] }[] {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.project || '';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  const orderIndex = new Map(projectOrder.map((name, i) => [name.toLowerCase(), i]));
  const named = Array.from(map.keys()).filter((p) => p !== '');
  named.sort((a, b) => {
    const ai = orderIndex.get(a.toLowerCase());
    const bi = orderIndex.get(b.toLowerCase());
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.localeCompare(b);
  });
  const order = map.has('') ? [...named, ''] : named;
  return order.map((project) => ({ project, tasks: map.get(project)! }));
}

/**
 * New global project order after dragging `active` onto `target`.
 * `currentOrder` may be missing either name (ordering.projects only holds
 * explicitly ordered projects) — `visibleProjects` supplies the on-screen
 * order used to place unlisted names. Returns null for no-op/invalid drops.
 */
export function reorderProjectsByDrag(
  currentOrder: string[],
  visibleProjects: string[],
  active: string,
  target: string,
): string[] | null {
  if (!active || !target || active === target) return null;
  // Merge: explicit order first, then visible-but-unlisted projects in view order.
  const lower = new Set(currentOrder.map((n) => n.toLowerCase()));
  const merged = [...currentOrder];
  for (const p of visibleProjects) {
    if (p !== '' && !lower.has(p.toLowerCase())) { merged.push(p); lower.add(p.toLowerCase()); }
  }
  const from = merged.findIndex((n) => n.toLowerCase() === active.toLowerCase());
  const to = merged.findIndex((n) => n.toLowerCase() === target.toLowerCase());
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...merged];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
