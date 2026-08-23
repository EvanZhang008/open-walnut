import { apiGet, apiPut } from './client';
import type { TierSeparator } from '@/components/tasks/tier-separators';

/** Project display order — flat, since Project is the single grouping layer.
 *  `separators` are the hand-placed divider lines inside the pinned tiers. */
export interface Ordering {
  projects: string[];
  separators?: TierSeparator[];
}

export async function fetchOrdering(): Promise<Ordering> {
  return apiGet<Ordering>('/api/ordering');
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
