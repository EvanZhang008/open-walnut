import { apiGet, apiPost, apiDelete } from './client';

export interface FocusBarData {
  pinned_tasks: string[];
}

export async function fetchPinnedTasks(): Promise<FocusBarData> {
  return apiGet<FocusBarData>('/api/focus/tasks');
}

export async function pinTask(taskId: string): Promise<FocusBarData> {
  return apiPost<FocusBarData>(`/api/focus/tasks/${encodeURIComponent(taskId)}`);
}

export async function unpinTask(taskId: string): Promise<FocusBarData> {
  return apiDelete(`/api/focus/tasks/${encodeURIComponent(taskId)}`) as unknown as FocusBarData;
}
