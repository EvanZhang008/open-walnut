import { apiGet, apiPut } from './client';

export interface Ordering {
  categories: string[];
  projects: Record<string, string[]>;
}

export async function fetchOrdering(): Promise<Ordering> {
  return apiGet<Ordering>('/api/ordering');
}

export async function saveCategoryOrder(order: string[]): Promise<void> {
  await apiPut('/api/ordering/categories', { order });
}

export async function saveProjectOrder(category: string, order: string[]): Promise<void> {
  await apiPut(`/api/ordering/projects/${encodeURIComponent(category)}`, { order });
}
