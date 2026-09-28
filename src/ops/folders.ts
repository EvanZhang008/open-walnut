/**
 * Folder ops: list a project's folders, move one folder (its subfolders and
 * every task in them) to another project, and file tasks into a folder. One task
 * moves with task_update's `project`, but a folder never follows a single task
 * into another project, so moving a body of work was a task-by-task job that
 * left the folder behind.
 */

import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

/** A row of GET /api/tasks/groups (task-manager's FolderListing). */
interface FolderRow {
  group_id: string;
  label: string;
  hidden?: boolean;
  member_ids?: string[];
  project?: string;
  parent_id?: string;
}

/** PATCH /api/tasks/folders/:id with a project (task-manager's FolderMoveResult). */
interface FolderMoveBody {
  group_id?: string;
  project?: string;
  moved_task_ids?: string[];
  moved_folder_ids?: string[];
  failed?: Array<{ id: string; error: string }>;
}

defineOp({
  name: 'folder_list',
  title: 'List task folders',
  description:
    'List task folders with their project, parent folder and task count. Pass project to see one ' +
    'project\'s folders ("" = Inbox). The tasks of one folder: task_list with group_id.',
  input: {
    project: z.string().optional().describe('Project name (case-insensitive); "" for the Inbox'),
  },
  handler: async ({ project }, call) => {
    const body = await call('GET', '/api/tasks/groups') as { groups?: FolderRow[] } | undefined;
    const wanted = typeof project === 'string' ? project.trim().toLowerCase() : undefined;
    const folders = (body?.groups ?? [])
      .filter((g) => wanted === undefined || (g.project ?? '').toLowerCase() === wanted)
      .map((g) => ({
        id: g.group_id,
        label: g.label,
        project: g.project ?? '',
        ...(g.parent_id ? { parent_id: g.parent_id } : {}),
        ...(g.hidden ? { hidden: true } : {}),
        task_count: g.member_ids?.length ?? 0,
      }));
    return { count: folders.length, folders };
  },
  tags: { readonly: true, remote: 'allow' },
});

defineOp({
  name: 'folder_move',
  title: 'Move a folder to another project',
  description:
    'Move one folder, with its subfolders and every task in them, to another project ("" = Inbox). ' +
    'A new project name creates the project. Tasks a sync plugin owns move on that service too. ' +
    'To move a single task, use task_update with project.',
  input: {
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('Folder id (g_...), from folder_list'),
    project: z.string().describe('Destination project name; "" = Inbox'),
  },
  handler: async ({ id, project }, call) => {
    const moved = await call('PATCH', `/api/tasks/folders/${encodeURIComponent(String(id))}`, {
      project: String(project),
    }) as FolderMoveBody | undefined;
    const tasks = moved?.moved_task_ids?.length ?? 0;
    const folders = moved?.moved_folder_ids?.length ?? 0;
    const failed = moved?.failed ?? [];
    const where = moved?.project || 'the Inbox';
    const outcome = tasks === 0 && folders === 0 && failed.length === 0
      ? `The folder was already in ${where}. Nothing moved.`
      : `Moved ${folders} folder(s) and ${tasks} task(s) to ${where}.`
        + (failed.length ? ` ${failed.length} task(s) did not move.` : '');
    const next = failed.length
      ? `Run the same call again to retry the tasks that did not move: ${failed.map((f) => f.id).join(', ')}.`
      : 'Nothing else is required.';
    return withOutcome({ ...(moved ?? {}) }, outcome, next);
  },
  resultError: (result) => {
    const failed = (result as FolderMoveBody | undefined)?.failed ?? [];
    return failed.length
      ? `folder_move: ${failed.length} task(s) did not move (${failed.map((f) => `${f.id}: ${f.error}`).join('; ')})`
      : undefined;
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'folder_add_tasks',
  title: 'Put tasks into a folder',
  description:
    'File tasks into a folder of the same project (a task in another folder leaves that one). ' +
    'A task in another project is refused: move it first with task_update project, or move its whole ' +
    'folder with folder_move.',
  input: {
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('Folder id (g_...), from folder_list'),
    task_ids: z.array(z.string().min(1)).min(1).describe('Task ids or unique id prefixes'),
  },
  handler: async ({ id, task_ids }, call) => {
    const body = await call('POST', `/api/tasks/groups/${encodeURIComponent(String(id))}/add`, {
      task_ids,
    }) as { group_id?: string; label?: string; member_ids?: string[] } | undefined;
    return withOutcome(
      { ...(body ?? {}) },
      `${(task_ids as string[]).length} task(s) filed into "${body?.label ?? id}", which now holds ${body?.member_ids?.length ?? 0}.`,
      'Nothing else is required.',
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
