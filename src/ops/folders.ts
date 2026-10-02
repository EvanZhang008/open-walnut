/**
 * Folder ops: list a project's folders, create one (nested or top-level), move
 * one folder under another folder or to another project (its subfolders and
 * every task in them), and file tasks into a folder. One task moves with
 * task_update's `project`, but a folder never follows a single task into another
 * project, so moving a body of work was a task-by-task job that left the folder
 * behind. Until 2026-10-02 the only way a session got a subfolder was the one
 * task_create makes on its own; a leader asked to group its workers could not.
 */

import { z } from 'zod';
import { defineOp, type WalnutOp } from './registry.js';
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

const FOLDER_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
type OpCall = Parameters<NonNullable<WalnutOp['handler']>>[1];

/** The calling session's task project, or the Inbox for any other caller (GET /me). */
async function callerProject(call: OpCall): Promise<string> {
  const me = await call('GET', '/me').catch(() => undefined) as
    { kind?: string; task?: { project?: string } } | undefined;
  return me?.kind === 'worker' && typeof me.task?.project === 'string' ? me.task.project : '';
}

defineOp({
  name: 'folder_create',
  title: 'Create a task folder',
  description:
    'Create an empty folder, top-level or nested under another folder of the same project (parent_id). ' +
    'Omit project to create it in your own task\'s project (the Inbox from outside a task); "" = Inbox. ' +
    'Folders nest up to 5 deep. Then file tasks into it with folder_add_tasks, or name it as group_id ' +
    'in task_create. The result\'s id is the folder id (g_...).',
  input: {
    label: z.string().trim().min(1).max(200).describe('Folder name'),
    project: z.string().optional().describe('Project name; "" = Inbox. Omit for your own task\'s project (a parent folder decides it when given)'),
    parent_id: FOLDER_ID.optional().describe('Folder id (g_...) to nest under; same project. Omit for a top-level folder'),
  },
  handler: async ({ label, project, parent_id }, call) => {
    let target = typeof project === 'string' ? project : undefined;
    if (target === undefined && typeof parent_id === 'string') {
      // The parent decides: a subfolder lives in its parent's project.
      const body = await call('GET', '/api/tasks/groups') as { groups?: FolderRow[] } | undefined;
      const parent = (body?.groups ?? []).find((g) => g.group_id === parent_id);
      if (!parent) throw new Error(`folder_create: no folder with id ${String(parent_id)} (folder_list shows them).`);
      target = parent.project ?? '';
    }
    if (target === undefined) target = await callerProject(call);
    const created = await call('POST', '/api/tasks/folders', {
      label: String(label), project: target, ...(parent_id ? { parent_id } : {}),
    }) as { group_id?: string; label?: string; project?: string; parent_id?: string } | undefined;
    const id = created?.group_id ?? '';
    const where = created?.parent_id ? `under folder ${created.parent_id}` : 'at the top level';
    return withOutcome(
      { id, ...(created ?? {}) },
      `Folder "${created?.label ?? String(label)}" (${id}) created ${where} in ${created?.project || 'the Inbox'}. It is empty.`,
      `File tasks into it: walnut tools call folder_add_tasks '{"id":"${id}","task_ids":["..."]}'; or pass group_id "${id}" to task_create.`,
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'folder_move',
  title: 'Move a folder under another folder, or to another project',
  description:
    'Move one folder: parent_id nests it under another folder of the same project ("" = make it ' +
    'top-level); project moves it, with its subfolders and every task in them, to another project ' +
    '("" = Inbox; a new name creates the project; tasks a sync plugin owns move on that service too). ' +
    'Pass exactly one of the two. To move a single task, use task_update with project.',
  input: {
    id: FOLDER_ID.describe('Folder id (g_...), from folder_list'),
    project: z.string().optional().describe('Destination project name; "" = Inbox'),
    parent_id: z.string().optional().describe('Folder id (g_...) to nest under, same project; "" = top level'),
  },
  handler: async ({ id, project, parent_id }, call) => {
    if ((project === undefined) === (parent_id === undefined)) {
      throw new Error('folder_move: pass exactly one of project (another project) or parent_id (another folder, "" = top level).');
    }
    if (parent_id !== undefined) {
      const parent = String(parent_id).trim();
      if (parent && !FOLDER_ID.safeParse(parent).success) throw new Error('folder_move: parent_id must be a folder id (g_...) or "".');
      const nested = await call('PATCH', `/api/tasks/folders/${encodeURIComponent(String(id))}`, {
        parent_id: parent || null,
      }) as { group_id?: string; parent_id?: string } | undefined;
      return withOutcome(
        { ...(nested ?? {}) },
        nested?.parent_id ? `Folder ${String(id)} now sits under folder ${nested.parent_id}.` : `Folder ${String(id)} is now a top-level folder.`,
        'Nothing else is required.',
      );
    }
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
    'A task in another project is refused unless move=true, which moves it into the folder\'s project ' +
    'too (or move its whole folder with folder_move).',
  input: {
    id: FOLDER_ID.describe('Folder id (g_...), from folder_list'),
    task_ids: z.array(z.string().min(1)).min(1).describe('Task ids or unique id prefixes'),
    move: z.boolean().optional().describe('true: a task in another project moves into the folder\'s project as well'),
  },
  handler: async ({ id, task_ids, move }, call) => {
    const body = await call('POST', `/api/tasks/groups/${encodeURIComponent(String(id))}/add`, {
      task_ids, ...(move ? { move: true } : {}),
    }) as { group_id?: string; label?: string; member_ids?: string[] } | undefined;
    return withOutcome(
      { ...(body ?? {}) },
      `${(task_ids as string[]).length} task(s) filed into "${body?.label ?? id}", which now holds ${body?.member_ids?.length ?? 0}.`,
      'Nothing else is required.',
    );
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
