import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from './client';
import type { Task, DashboardData } from '@walnut/core';

export interface TaskFilter {
  status?: string;
  priority?: string;
  category?: string;
  project?: string;
}

export interface CreateTaskInput {
  title: string;
  priority?: string;
  category?: string;
  project?: string;
  due_date?: string;
  sprint?: string;
}

export interface UpdateTaskInput {
  title?: string;
  status?: string;
  phase?: string;
  priority?: string;
  category?: string;
  project?: string;
  due_date?: string | null;
  needs_attention?: boolean;
  parent_task_id?: string;  // Set parent (task ID) or '' to remove parent
  sprint?: string;  // Set sprint name or '' to clear
  add_tags?: string[];
  remove_tags?: string[];
  set_tags?: string[];
  add_depends_on?: string[];
  remove_depends_on?: string[];
  set_depends_on?: string[];
}

export async function fetchTasks(filter?: TaskFilter, opts?: { slim?: boolean }): Promise<Task[]> {
  const params: Record<string, string> = {};
  if (filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (v) params[k] = v;
    }
  }
  // Default to slim mode (omits note/conversation_log, ~400KB savings)
  if (opts?.slim !== false) {
    params.slim = '1';
  }
  const res = await apiGet<{ tasks: Task[] }>('/api/tasks', Object.keys(params).length ? params : undefined);
  return res.tasks;
}

export async function fetchEnrichedTasks(): Promise<Task[]> {
  const res = await apiGet<{ tasks: Task[] }>('/api/tasks/enriched');
  return res.tasks;
}

export async function fetchTask(id: string): Promise<Task> {
  const res = await apiGet<{ task: Task }>(`/api/tasks/${id}`);
  return res.task;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const res = await apiPost<{ task: Task }>('/api/tasks', input);
  return res.task;
}

export async function updateTask(id: string, updates: UpdateTaskInput): Promise<Task> {
  const res = await apiPatch<{ task: Task }>(`/api/tasks/${id}`, updates);
  return res.task;
}

export async function completeTask(id: string): Promise<Task> {
  const res = await apiPost<{ task: Task }>(`/api/tasks/${id}/complete`);
  return res.task;
}

export async function toggleCompleteTask(id: string): Promise<Task> {
  const res = await apiPost<{ task: Task }>(`/api/tasks/${id}/toggle-complete`);
  return res.task;
}

export async function starTask(id: string): Promise<Task> {
  const res = await apiPost<{ task: Task; starred: boolean }>(`/api/tasks/${id}/star`);
  return res.task;
}

export async function addNote(id: string, content: string): Promise<Task> {
  const res = await apiPost<{ task: Task }>(`/api/tasks/${id}/notes`, { content });
  return res.task;
}

export async function updateNote(id: string, content: string): Promise<Task> {
  const res = await apiPut<{ task: Task }>(`/api/tasks/${id}/note`, { content });
  return res.task;
}

export async function updateDescription(id: string, content: string): Promise<Task> {
  const res = await apiPut<{ task: Task }>(`/api/tasks/${id}/description`, { content });
  return res.task;
}

export async function updateSummary(id: string, content: string): Promise<Task> {
  const res = await apiPut<{ task: Task }>(`/api/tasks/${id}/summary`, { content });
  return res.task;
}

export async function addSubtask(id: string, title: string): Promise<Task> {
  const res = await apiPost<{ task: Task }>(`/api/tasks/${id}/subtasks`, { title });
  return res.task;
}

export async function toggleSubtask(taskId: string, subtaskId: string): Promise<Task> {
  const res = await apiPost<{ task: Task }>(`/api/tasks/${taskId}/subtasks/${subtaskId}/toggle`);
  return res.task;
}

export function deleteTask(taskId: string): Promise<void> {
  return apiDelete(`/api/tasks/${taskId}`);
}

export function deleteSubtask(taskId: string, subtaskId: string): Promise<void> {
  return apiDelete(`/api/tasks/${taskId}/subtasks/${subtaskId}`);
}

export async function reorderTasks(category: string, project: string, taskIds: string[]): Promise<void> {
  await apiPatch<{ ok: boolean }>('/api/tasks/reorder', { category, project, taskIds });
}

export async function fetchDashboard(): Promise<DashboardData> {
  return apiGet<DashboardData>('/api/dashboard');
}

// ── Sprint helpers ──

export interface SprintOption {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
}

/**
 * Fetch available sprints for the sprint picker dropdown.
 * Two-layer strategy:
 *  1. Plugin cache (has dates + current sprint detection)
 *  2. Fallback to local task meta (just names + counts, always works)
 */
export async function fetchAvailableSprints(): Promise<{ sprints: SprintOption[]; current: string | null }> {
  // Layer 1: try plugin endpoint (has startDate/endDate + current sprint)
  try {
    const result = await apiGet<{ sprints: SprintOption[]; current: string | null }>('/api/plugins/taskei/sprints');
    if (result.sprints.length > 0) return result;
  } catch {
    // Plugin not loaded — fall through to local data
  }

  // Layer 2: local task meta — always works, but only has names + counts
  try {
    const meta = await apiGet<{ sprints: { name: string; count: number }[] }>('/api/tasks/meta/sprints');
    const sprints: SprintOption[] = meta.sprints.map((s, i) => ({
      id: `local-${i}`,
      name: s.name,
      startDate: '',
      endDate: '',
    }));
    return { sprints, current: null };
  } catch {
    return { sprints: [], current: null };
  }
}

/** Fetch sprint metadata (unique sprint names with task counts) */
export async function fetchSprintMeta(): Promise<{ name: string; count: number }[]> {
  const res = await apiGet<{ sprints: { name: string; count: number }[] }>('/api/tasks/meta/sprints');
  return res.sprints;
}

// ── Tag helpers ──

export async function fetchTags(): Promise<{ tag: string; count: number }[]> {
  const res = await apiGet<{ tags: { tag: string; count: number }[] }>('/api/tasks/meta/tags');
  return res.tags;
}

export async function addTag(taskId: string, tag: string): Promise<Task> {
  return updateTask(taskId, { add_tags: [tag] });
}

export async function removeTag(taskId: string, tag: string): Promise<Task> {
  return updateTask(taskId, { remove_tags: [tag] });
}

// ── Dependency helpers ──

export async function setDependsOn(taskId: string, dependsOn: string[]): Promise<Task> {
  const res = await apiPut<{ task: Task }>(`/api/tasks/${taskId}/depends-on`, { depends_on: dependsOn });
  return res.task;
}

export async function addDependency(taskId: string, depId: string): Promise<Task> {
  return updateTask(taskId, { add_depends_on: [depId] } as UpdateTaskInput);
}

export async function removeDependency(taskId: string, depId: string): Promise<Task> {
  return updateTask(taskId, { remove_depends_on: [depId] } as UpdateTaskInput);
}
