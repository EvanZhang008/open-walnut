/**
 * Which tasks a sync plugin never reads (2026-11-01: "no provider can see it"). A plugin that
 * syncs to an outside service reads tasks through its API (`walnut.tasks.get/list/query/children`,
 * `events.on('task:…')`) and its pull context (`ctx.getTasks`); a task kept local in a project
 * that syncs is left out of all of them, and its pull context cannot write it.
 *
 * Kept from providers: any task with a `sync_hold`, and any local task whose project syncs to a
 * service (a local task there is local on purpose). A local task in a local project, or in the
 * Inbox, is ordinary and stays visible.
 */
import type { ProjectRecord, Task } from '../types.js';

type ProjectSources = Record<string, Pick<ProjectRecord, 'source'>>;

export function keptFromProviders(
  task: Pick<Task, 'source' | 'project'> & { sync_hold?: unknown },
  projects: ProjectSources,
): boolean {
  if (task.sync_hold) return true;
  if (task.source && task.source !== 'local') return false;
  const name = (task.project ?? '').trim().toLowerCase();
  if (!name) return false;
  const key = Object.keys(projects).find((k) => k.toLowerCase() === name);
  const source = key ? projects[key].source : undefined;
  return !!source && source !== 'local';
}

/** The filter for one read: a function of the registry as it is now. */
export async function providerTaskFilter(): Promise<(task: Pick<Task, 'source' | 'project'> & { sync_hold?: unknown }) => boolean> {
  const { getStoreProjects } = await import('../task-manager.js');
  const projects = await getStoreProjects();
  return (task) => !keptFromProviders(task, projects);
}

/** True for a plugin that syncs (the reads above are filtered for it). */
export async function pluginSyncs(pluginId: string): Promise<boolean> {
  const { registry } = await import('../integration-registry.js');
  return pluginId !== 'local' && registry.isTaskSource(pluginId);
}

/** What a sync plugin gets back for a task it may not read: the id and that it is local, none of
 *  its text. */
export function redactedForProvider<T extends Pick<Task, 'id'>>(task: T): T {
  const t = task as unknown as Task;
  return {
    id: t.id, source: 'local', title: '', description: '', note: '', summary: '',
    status: t.status, phase: t.phase, priority: t.priority, project: t.project,
    created_at: t.created_at, updated_at: t.updated_at, session_ids: [],
  } as unknown as T;
}
