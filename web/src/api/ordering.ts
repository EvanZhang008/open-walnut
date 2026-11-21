import { apiGet, apiPut } from './client';
import type { TierSeparator } from '@/components/tasks/tier-separators';
import { projectGroupKey } from '@/utils/project-display';

/** Project display order — flat, since Project is the single grouping layer.
 *  `separators` are the hand-placed divider lines inside the pinned tiers. */
export interface Ordering {
  projects: string[];
  separators?: TierSeparator[];
}

/** A separator's anchors under the board's own keys ('' for the Inbox, projectGroupKey). */
function separatorOnBoardKeys(sep: TierSeparator): TierSeparator {
  if (sep.mode !== 'project') return sep;
  return {
    ...sep,
    ...(sep.afterProject !== undefined ? { afterProject: projectGroupKey(sep.afterProject) } : {}),
    ...(sep.beforeProject !== undefined ? { beforeProject: projectGroupKey(sep.beforeProject) } : {}),
    ...(sep.project !== undefined ? { project: projectGroupKey(sep.project) } : {}),
  };
}

/** The order as the board reads it: the server names the Inbox's slot `Inbox` (every task has a
 *  project), the board keys its group '' (projectGroupKey), so both are read under the board's key
 *  here, once, and a line next to the Inbox stays where it was drawn. */
export async function fetchOrdering(): Promise<Ordering> {
  const data = await apiGet<Ordering>('/api/ordering');
  return {
    ...data,
    projects: (data.projects ?? []).map(projectGroupKey),
    ...(data.separators ? { separators: data.separators.map(separatorOnBoardKeys) } : {}),
  };
}

export async function saveProjectOrder(order: string[]): Promise<void> {
  await apiPut('/api/ordering/projects', { order });
}

/** Whole-list replace (same shape as the project order): the list is tiny and a
 *  drag changes one row's anchors, so per-entry PATCH semantics would buy
 *  nothing but a merge problem. */
export async function saveSeparators(separators: TierSeparator[]): Promise<void> {
  await apiPut('/api/ordering/separators', { separators });
}
