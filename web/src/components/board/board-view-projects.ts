/**
 * Each team task's board project, as the Projects view places it (the first
 * project naming it, a worker's own subtasks with their parent; see
 * board-overview-model.ts buildSections), so a kanban card can say which area
 * of work it belongs to and the board can show one area's cards. Pure; pinned
 * in tests/web/board-view-pref.test.ts.
 */
import type { BoardProjectStatus } from './board-model';
import type { OverviewSection } from './board-overview-model';

export interface CardProject {
  id: string;
  title: string;
  status: BoardProjectStatus | null;
}

export type ProjectOf = ReadonlyMap<string, CardProject>;

export const NO_PROJECTS: ProjectOf = new Map();

export function projectsOfTeam(sections: readonly OverviewSection[] | null | undefined): ProjectOf {
  if (!sections) return NO_PROJECTS;
  const out = new Map<string, CardProject>();
  for (const s of sections) {
    if (s.kind !== 'project') continue;
    const project: CardProject = { id: s.id, title: s.title, status: s.status };
    for (const r of s.rows) if (!out.has(r.id)) out.set(r.id, project);
  }
  return out.size ? out : NO_PROJECTS;
}

/** `prev` when `next` places every card the same way: a status push rebuilds the sections, and a new map re-renders every card. */
export function keepIfSame(prev: ProjectOf, next: ProjectOf): ProjectOf {
  if (prev === next) return prev;
  if (prev.size !== next.size) return next;
  for (const [id, p] of next) {
    const q = prev.get(id);
    if (!q || q.id !== p.id || q.title !== p.title || q.status !== p.status) return next;
  }
  return prev;
}
