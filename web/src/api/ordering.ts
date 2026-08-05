import { apiGet, apiPut } from './client';

/** Project display order — flat, since Project is the single grouping layer. */
export interface Ordering {
  projects: string[];
}

export async function fetchOrdering(): Promise<Ordering> {
  return apiGet<Ordering>('/api/ordering');
}

export async function saveProjectOrder(order: string[]): Promise<void> {
  await apiPut('/api/ordering/projects', { order });
}
