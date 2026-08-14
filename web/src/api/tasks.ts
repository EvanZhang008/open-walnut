import { ApiError, apiGet, apiPost, apiPatch, apiPut, apiDelete } from './client';
import type { Task, DashboardData, QuickTaskParse } from '@open-walnut/core';
import {
  seedTaskSessionStatuses,
  sessionStatusStore,
} from '@/stores/session-status-store';
import { hydrateSessionStatuses } from './sessions';

function taskSessionIds(tasks: Task[]): string[] {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.session_id) ids.add(task.session_id);
    if (task.plan_session_id) ids.add(task.plan_session_id);
    if (task.exec_session_id) ids.add(task.exec_session_id);
    const historicalIds = task.session_ids ?? [];
    const latestHistoricalId = historicalIds[historicalIds.length - 1];
    if (latestHistoricalId) ids.add(latestHistoricalId);
  }
  return [...ids];
}

async function seedTask<T extends Task>(task: T): Promise<T> {
  seedTaskSessionStatuses(task, 'rest:task');
  await hydrateSessionStatuses(taskSessionIds([task]));
  return task;
}

async function seedTasks<T extends Task>(tasks: T[]): Promise<T[]> {
  sessionStatusStore.seedTaskList(tasks, 'rest:task-list');
  await hydrateSessionStatuses(taskSessionIds(tasks));
  return tasks;
}

export interface TaskDependencyReference {
  id: string;
  title: string;
  phase: string;
}

export interface TaskFamilyReference {
  id: string;
  title: string;
  phase: Task['phase'];
  status: Task['status'];
  priority?: Task['priority'];
}

export interface TaskDetail extends Task {
  is_blocked?: boolean;
  resolved_dependencies?: TaskDependencyReference[];
  dependents?: TaskDependencyReference[];
  parent?: TaskFamilyReference;
  children?: TaskFamilyReference[];
}

/**
 * The canonical query contract, shared verbatim with REST and the agent tool
 * (`src/core/task-query.ts`). Replaces the old drifted client-side filter type,
 * whose three loose string fields matched neither the server's parser nor either
 * UI surface.
 *
 * Re-exported here only so UI modules keep importing their task types from one
 * place. `fetchTasks` deliberately takes NO query: it fetches the full minimal
 * list and every condition is evaluated in the browser, because `/` and `/tasks`
 * share one task cache and a server-filtered fetch would starve whichever
 * surface didn't ask for it. Server-side filtering has its own callers
 * (`GET /api/tasks?…`, the agent tool); it is not this function's job.
 */
export type { TaskQuery } from '@open-walnut/task-query';

export type { QuickTaskParse } from '@open-walnut/core';

export async function quickParseTask(text: string): Promise<QuickTaskParse> {
  // Browser timezone rides along so relative dates ("tomorrow 10am") resolve in the
  // user's zone even when the server runs elsewhere (e.g. a UTC cloud instance).
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return apiPost<QuickTaskParse>('/api/tasks/quick-parse', { text, timeZone });
}

export interface CreateTaskInput {
  title: string;
  priority?: string;
  /** Long-form body. POST /api/tasks passes it straight to addTask, which already
   *  accepts it — used by one-click capture, where the first typed line becomes the
   *  title and the rest becomes this. */
  description?: string;
  /** Target project. Omitted/'' = Inbox. A name with no registry row is created. */
  project?: string;
  due_date?: string;
  start_date?: string;
  end_date?: string;
  sprint?: string;
  /** Explicit platform/source for the new task (e.g. 'local', 'ms-todo'). Used by
   *  quick-add so a task lands on the user's configured Default Platform. NOTE: a
   *  project already claimed by a provider still wins — the registry row's source
   *  outranks this field (see task-manager addTask). */
  source?: string;
}

export interface UpdateTaskInput {
  title?: string;
  status?: string;
  phase?: string;
  priority?: string;
  /** Move to another project. '' = Inbox. */
  project?: string;
  due_date?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  /** Idempotent star set (unlike POST /:id/star which toggles). */
  starred?: boolean;
  /** Read/unread marker — true = agent output the human hasn't opened. */
  unread?: boolean;
  parent_task_id?: string;  // Set parent (task ID) or '' to remove parent
  sprint?: string;  // Set sprint name or '' to clear
  add_tags?: string[];
  remove_tags?: string[];
  set_tags?: string[];
  add_depends_on?: string[];
  remove_depends_on?: string[];
  set_depends_on?: string[];
}

export async function fetchTasks(opts?: { slim?: boolean; minimal?: boolean }): Promise<Task[]> {
  const params: Record<string, string> = {};
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
  if (!Array.isArray(res?.tasks)) {
    throw new ApiError(200, 'Task list response is malformed');
  }
  return seedTasks(res.tasks);
}

export async function fetchEnrichedTasks(): Promise<Task[]> {
  const res = await apiGet<{ tasks: Task[] }>('/api/tasks/enriched');
  return seedTasks(res.tasks);
}

export async function fetchTask(id: string): Promise<TaskDetail> {
  const res = await apiGet<{ task: TaskDetail }>(`/api/tasks/${id}`);
  return seedTask(res.task);
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const res = await apiPost<{ task: Task }>('/api/tasks', input);
  return seedTask(res.task);
}

export async function updateTask(id: string, updates: UpdateTaskInput): Promise<Task> {
  const res = await apiPatch<{ task: Task }>(`/api/tasks/${id}`, updates);
  return seedTask(res.task);
}

export async function completeTask(id: string): Promise<Task> {
  const res = await apiPost<{ task: Task }>(`/api/tasks/${id}/complete`);
  return seedTask(res.task);
}

export async function toggleCompleteTask(id: string): Promise<Task> {
  const res = await apiPost<{ task: Task }>(`/api/tasks/${id}/toggle-complete`);
  return seedTask(res.task);
}

export async function starTask(id: string): Promise<Task> {
  const res = await apiPost<{ task: Task; starred: boolean }>(`/api/tasks/${id}/star`);
  return seedTask(res.task);
}

export async function addNote(id: string, content: string): Promise<Task> {
  const res = await apiPost<{ task: Task }>(`/api/tasks/${id}/notes`, { content });
  return seedTask(res.task);
}

export async function updateNote(id: string, content: string): Promise<Task> {
  const res = await apiPut<{ task: Task }>(`/api/tasks/${id}/note`, { content });
  return seedTask(res.task);
}

export async function updateDescription(id: string, content: string): Promise<Task> {
  const res = await apiPut<{ task: Task }>(`/api/tasks/${id}/description`, { content });
  return seedTask(res.task);
}

export async function updateSummary(id: string, content: string): Promise<Task> {
  const res = await apiPut<{ task: Task }>(`/api/tasks/${id}/summary`, { content });
  return seedTask(res.task);
}

export async function addSubtask(id: string, title: string): Promise<Task> {
  const res = await apiPost<{ task: Task }>(`/api/tasks/${id}/subtasks`, { title });
  return seedTask(res.task);
}

export async function toggleSubtask(taskId: string, subtaskId: string): Promise<Task> {
  const res = await apiPost<{ task: Task }>(`/api/tasks/${taskId}/subtasks/${subtaskId}/toggle`);
  return seedTask(res.task);
}

export function deleteTask(taskId: string, opts?: { force?: boolean }): Promise<void> {
  const qs = opts?.force ? '?force=true' : '';
  return apiDelete(`/api/tasks/${taskId}${qs}`);
}

export function deleteSubtask(taskId: string, subtaskId: string): Promise<void> {
  return apiDelete(`/api/tasks/${taskId}/subtasks/${subtaskId}`);
}

// ── Batch (multi-select) operations ──
// Both are PARTIAL-SUCCESS: the response always carries the tasks that DID change
// plus a `failed` list (active children / active sessions / unknown id). Callers
// apply the successes and surface `failed` — never treat a non-empty `failed` as a
// total failure.

/** One task's outcome in a batch op — mirrors the server's BatchTaskOutcome. */
export interface BatchTaskOutcome {
  id: string;
  title?: string;
  ok: boolean;
  error?: string;
  /** Set by the client layer for a task that DID change locally but whose external
   *  plugin push failed — so a warning can say "not synced", not "did not apply". */
  syncOnly?: boolean;
}

/**
 * Set the phase of many tasks in one round-trip (multi-select Complete / Reopen).
 *
 * `failed` = not applied (blocked / unknown id) — roll those back.
 * `syncFailed` = applied locally but the external push failed — do NOT roll back;
 * the phase change is real, only the plugin sync didn't land.
 */
export function batchSetPhase(taskIds: string[], phase: string): Promise<{ changed: Task[]; failed: BatchTaskOutcome[]; syncFailed?: BatchTaskOutcome[] }> {
  return apiPost('/api/tasks/batch/phase', { task_ids: taskIds, phase });
}

/** Delete many tasks in one round-trip. `force` stops active sessions first. */
export function batchDeleteTasks(taskIds: string[], opts?: { force?: boolean }): Promise<{ deleted: Task[]; failed: BatchTaskOutcome[] }> {
  return apiPost('/api/tasks/batch/delete', { task_ids: taskIds, ...(opts?.force ? { force: true } : {}) });
}

/** Reorder tasks within ONE project group. `project: ''` = Inbox (valid, not "unset"). */
export async function reorderTasks(project: string, taskIds: string[]): Promise<void> {
  await apiPatch<{ ok: boolean }>('/api/tasks/reorder', { project, taskIds });
}

export async function fetchDashboard(): Promise<DashboardData> {
  const dashboard = await apiGet<DashboardData>('/api/dashboard');
  const tasks = [
    ...dashboard.urgent_tasks,
    ...dashboard.today_tasks,
    ...dashboard.recent_tasks,
  ];
  sessionStatusStore.seedTaskList(tasks, 'rest:dashboard');
  await hydrateSessionStatuses(taskSessionIds(tasks));
  return dashboard;
}

// Sprint helpers RETIRED (plugin taskFields, 2026-08-12): the console now
// renders plugin-declared fields generically — see PluginFieldPicker.tsx.
// Options come straight from /api/integrations/task-fields + the plugin's
// own options route; the GET /api/tasks/meta/sprints fallback had no callers.

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
  return seedTask(res.task);
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
