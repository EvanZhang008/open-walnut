import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from './client';
import type { Task, DashboardData } from '@open-walnut/core';

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
  /** Explicit platform/source for the new task (e.g. 'local', 'ms-todo'). When set,
   *  overrides the backend's category-based source inference — used by quick-add so a
   *  task lands on the user's configured Default Platform instead of inheriting an
   *  external source from the active category. */
  source?: string;
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

export async function fetchTasks(filter?: TaskFilter, opts?: { slim?: boolean; minimal?: boolean }): Promise<Task[]> {
  const params: Record<string, string> = {};
  if (filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (v) params[k] = v;
    }
  }
  if (opts?.minimal) {
    // List payload: drops note/conversation_log AND summary/description/ext
    // (~2.6MB on top of the slim ~400KB). The detail pane lazy-loads the full
    // task on focus via fetchTask(id). Use for the home task list.
    params.fields = 'list';
  } else if (opts?.slim !== false) {
    // Default to slim mode (omits note/conversation_log, ~400KB savings)
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

export function deleteTask(taskId: string, opts?: { force?: boolean }): Promise<void> {
  const qs = opts?.force ? '?force=true' : '';
  return apiDelete(`/api/tasks/${taskId}${qs}`);
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
 *  1. Discover plugins dynamically, try each for /sprints (has dates + current sprint)
 *  2. Fallback to local task meta (just names + counts, always works)
 */
export async function fetchAvailableSprints(): Promise<{ sprints: SprintOption[]; current: string | null }> {
  // Layer 1: discover plugins and try each for enriched sprint data
  try {
    const plugins = await apiGet<Array<{ id: string }>>('/api/integrations');
    for (const plugin of plugins) {
      try {
        const result = await apiGet<{ sprints: SprintOption[]; current: string | null }>(`/api/plugins/${plugin.id}/sprints`);
        if (result.sprints.length > 0) return result;
      } catch { /* this plugin doesn't serve sprints — try next */ }
    }
  } catch {
    // Integrations endpoint unavailable — fall through to local data
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

// ── Virtual task groups ──

export interface TaskGroup {
  group_id: string;
  label: string;
  /** When true, the group is collapsed/hidden from the Focus (pinned) area. */
  hidden?: boolean;
  member_ids: string[];
}

export async function fetchTaskGroups(): Promise<TaskGroup[]> {
  const res = await apiGet<{ groups: TaskGroup[] }>('/api/tasks/groups');
  return res.groups;
}

/** Create a group from ≥2 tasks. Label optional (AI-generated if omitted). */
export async function createTaskGroup(taskIds: string[], label?: string): Promise<TaskGroup> {
  return apiPost<TaskGroup>('/api/tasks/groups', { task_ids: taskIds, ...(label ? { label } : {}) });
}

export async function addTasksToGroup(groupId: string, taskIds: string[]): Promise<TaskGroup> {
  return apiPost<TaskGroup>(`/api/tasks/groups/${groupId}/add`, { task_ids: taskIds });
}

export async function removeTasksFromGroup(taskIds: string[]): Promise<{ removed_ids: string[]; dissolved_group_ids: string[] }> {
  return apiPost('/api/tasks/groups/remove', { task_ids: taskIds });
}

export async function renameTaskGroup(groupId: string, label: string): Promise<{ group_id: string; label: string }> {
  return apiPatch(`/api/tasks/groups/${groupId}`, { label });
}

/** Show/hide a group in the Focus (pinned) area (membership untouched). */
export async function setTaskGroupHidden(groupId: string, hidden: boolean): Promise<{ group_id: string; hidden: boolean }> {
  return apiPatch(`/api/tasks/groups/${groupId}/hidden`, { hidden });
}
